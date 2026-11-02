// Перенос между браузерами вручную: зашифрованный файл или «код переноса», импорт куки из других инструментов
import { initDb, save } from './db.js';
import * as vault from './vault.js';
import * as log from './log.js';
import * as proxy from './proxy.js';
import { summarize } from './sessions.js';
import { ensureSite, storeImportedSession, dedupeSites } from './accounts.js';
import { emit } from './bus.js';
import { uid, err, pickColor, browserLabel } from '../shared/util.js';
import { registrableDomain } from '../shared/domains.js';
import { sealWithPassword, openWithPassword, packPlain, unpackPlain, b64urlE, b64urlD } from '../shared/crypto.js';
import { parseCookieText, toCookieEditorJSON, toNetscape } from '../shared/cookieFormats.js';
import { proxyKey } from '../shared/proxyParse.js';

export async function buildBundle({ accountIds = null, includeProxies = true, includeRules = true } = {}) {
  const c = await initDb();
  const accounts = (accountIds && accountIds.length ? accountIds.map((id) => c.accounts[id]) : Object.values(c.accounts)).filter(Boolean);
  const siteIds = new Set(accounts.map((a) => a.siteId));
  const sessions = {};
  for (const a of accounts) { const s = await vault.loadSession(a.id); if (s) sessions[a.id] = s; }
  const usedProxyIds = new Set(accounts.map((a) => a.proxy).filter((t) => t?.startsWith('proxy:')).map((t) => t.slice(6)));
  const proxies = includeProxies ? Object.values(c.proxies) : Object.values(c.proxies).filter((p) => usedProxyIds.has(p.id));
  return {
    format: 'multipass-bundle', v: 1, createdAt: Date.now(), from: c.local.deviceName || browserLabel(),
    sites: [...siteIds].map((id) => c.sites[id]).filter(Boolean), accounts, sessions, proxies,
    rules: includeRules ? Object.values(c.rules) : [],
  };
}

export async function exportBundle({ accountIds, includeProxies, includeRules, password, as = 'file' }) {
  const bundle = await buildBundle({ accountIds, includeProxies, includeRules });
  const n = bundle.accounts.length;
  let text;
  if (as === 'code') {
    text = password ? 'MPX1.' + b64urlE(new TextEncoder().encode(JSON.stringify(await sealWithPassword(bundle, password)))) : 'MPX0.' + (await packPlain(bundle));
  } else {
    text = JSON.stringify(password ? { format: 'multipass-bundle-enc', v: 1, createdAt: Date.now(), ...(await sealWithPassword(bundle, password)) } : bundle, null, password ? 0 : 1);
  }
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  log.info(`Экспорт: ${n} акк., ${bundle.proxies.length} прокси${password ? ' (зашифровано)' : ''}`);
  return { text, filename: `multipass-${stamp}${password ? '.mpvault' : ''}.json`, accounts: n, proxies: bundle.proxies.length };
}

export async function decodeBundle(text, password) {
  const t = String(text || '').trim();
  if (t.startsWith('MPX0.')) return unpackPlain(t.slice(5));
  if (t.startsWith('MPX1.')) {
    if (!password) throw err('Код зашифрован — введите пароль', 'NEED_PASSWORD');
    return openWithPassword(JSON.parse(new TextDecoder().decode(b64urlD(t.slice(5)))), password);
  }
  let j;
  try { j = JSON.parse(t); } catch { throw err('Не похоже на файл Multipass'); }
  if (j.format === 'multipass-bundle-enc') {
    if (!password) throw err('Файл зашифрован — введите пароль', 'NEED_PASSWORD');
    return openWithPassword(j, password);
  }
  if (j.format === 'multipass-bundle') return j;
  throw err('Не похоже на файл Multipass');
}

export async function importBundle(text, password) {
  const b = await decodeBundle(text, password);
  const c = await initDb();
  if (c.vaultMeta.enabled) await vault.requireKey();
  const res = { sites: 0, accounts: 0, sessions: 0, proxies: 0, rules: 0, skipped: 0 };
  // прокси: дедупликация по host:port:логин:пароль
  const proxyMap = {};
  const byKey = new Map(Object.values(c.proxies).map((p) => [proxyKey(p), p.id]));
  for (const p of b.proxies || []) {
    const k = proxyKey(p);
    if (c.proxies[p.id]) proxyMap[p.id] = p.id;
    else if (byKey.has(k)) proxyMap[p.id] = byKey.get(k);
    else { c.proxies[p.id] = { ...p, updatedAt: p.updatedAt || Date.now() }; proxyMap[p.id] = p.id; byKey.set(k, p.id); res.proxies++; }
  }
  const remapTarget = (t) => (t && t.startsWith('proxy:') && proxyMap[t.slice(6)] ? 'proxy:' + proxyMap[t.slice(6)] : t);
  for (const s of b.sites || []) {
    const cur = c.sites[s.id];
    if (!cur || (s.updatedAt || 0) > (cur.updatedAt || 0)) { c.sites[s.id] = s; res.sites++; }
  }
  for (const a of b.accounts || []) {
    const cur = c.accounts[a.id];
    const next = { ...a, proxy: remapTarget(a.proxy) };
    if (!cur || (a.updatedAt || 0) > (cur.updatedAt || 0)) { c.accounts[a.id] = next; res.accounts++; } else res.skipped++;
    const sess = b.sessions?.[a.id];
    if (sess && (!c.sessIndex[a.id] || (sess.savedAt || 0) > (c.sessIndex[a.id].at || 0))) {
      await vault.storeSession(a.id, sess, { keepPrev: true });
      c.sessIndex[a.id] = summarize(sess);
      res.sessions++;
    }
  }
  for (const r of b.rules || []) {
    const dup = Object.values(c.rules).some((x) => x.id === r.id || (x.pattern === r.pattern && x.target === remapTarget(r.target)));
    if (!dup) { c.rules[r.id] = { ...r, target: remapTarget(r.target) }; res.rules++; }
  }
  await save('proxies', 'sites', 'accounts', 'sessIndex', 'rules');
  await dedupeSites();
  await proxy.apply();
  emit('data-changed', { sync: true });
  if (res.proxies) proxy.check(Object.keys(proxyMap).filter((id) => !c.proxyStatus[id])).catch(() => {});
  log.info(`Импорт: ${res.accounts} акк., ${res.sessions} сессий, ${res.proxies} прокси, ${res.rules} правил`);
  return { ...res, from: b.from || '' };
}

// Импорт куки из Cookie-Editor / EditThisCookie / Netscape / Playwright storageState
export async function importCookies({ text, name = '', host = '' }) {
  const parsed = parseCookieText(text);
  if (!parsed.cookies.length) throw err('Куки не найдены');
  const c = await initDb();
  if (c.vaultMeta.enabled) await vault.requireKey();
  let h = host;
  if (!h) {
    const counts = new Map();
    for (const ck of parsed.cookies) { const r = registrableDomain(ck.domain); counts.set(r, (counts.get(r) || 0) + 1); }
    h = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }
  const site = await ensureSite(h);
  const siblings = Object.values(c.accounts).filter((a) => a.siteId === site.id);
  const t = Date.now();
  const a = { id: uid('acc_'), siteId: site.id, name: name.trim() || `Импорт ${siblings.length + 1}`, color: pickColor(siblings.map((x) => x.color)), note: `Импорт (${parsed.kind})`, tags: ['импорт'], proxy: null, startUrl: '', fav: false, order: siblings.length, createdAt: t, updatedAt: t };
  c.accounts[a.id] = a;
  await save('accounts');
  await storeImportedSession(a.id, { v: 1, savedAt: t, cookies: parsed.cookies, storage: parsed.storage || {}, ua: '', browser: 'импорт', device: '' });
  emit('data-changed', { sync: true });
  log.info(`Импортирован аккаунт «${a.name}» для ${site.name}: ${parsed.cookies.length} куки`);
  return { account: a, site, cookies: parsed.cookies.length };
}

export async function exportAccountCookies(id, format = 'json') {
  const c = await initDb();
  const a = c.accounts[id];
  if (!a) throw err('Аккаунт не найден');
  const s = await vault.loadSession(id);
  if (!s) throw err('У аккаунта нет сохранённой сессии');
  const base = a.name.replace(/[^\p{L}\p{N}._-]+/gu, '_');
  if (format === 'netscape') return { text: toNetscape(s.cookies), filename: `${base}.cookies.txt` };
  if (format === 'playwright') {
    const st = { cookies: s.cookies.map((k) => ({ name: k.name, value: k.value, domain: k.domain, path: k.path, expires: k.expirationDate || -1, httpOnly: k.httpOnly, secure: k.secure, sameSite: k.sameSite === 'strict' ? 'Strict' : k.sameSite === 'lax' ? 'Lax' : 'None' })),
      origins: Object.entries(s.storage || {}).map(([origin, v]) => ({ origin, localStorage: Object.entries(v.local || {}).map(([name, value]) => ({ name, value })) })) };
    return { text: JSON.stringify(st, null, 2), filename: `${base}.storageState.json` };
  }
  return { text: toCookieEditorJSON(s.cookies), filename: `${base}.cookies.json` };
}
