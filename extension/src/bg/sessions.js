// Низкоуровневая работа с куки и DOM-хранилищем вкладок
import { hostMatches } from '../shared/domains.js';
import { safeUrl, browserLabel } from '../shared/util.js';

export const AUTH_COOKIE_RE = /(sess|sid|auth|token|login|logged|jwt|remember|ds_user|c_user|^xs$|ct0|twid|sapisid|^ssid$|^hsid$|apisid|__secure-|__host-|user_?id|^uid$)/i;
const MAX_VALUE = 1_500_000;

export async function storeIdForTab(tab) {
  if (!tab) return '0';
  try {
    const stores = await chrome.cookies.getAllCookieStores();
    const s = stores.find((st) => st.tabIds.includes(tab.id));
    if (s) return s.id;
  } catch {}
  return tab.incognito ? '1' : '0';
}

export function cookieUrl(c, forceHttps = false) {
  const host = String(c.domain || '').replace(/^\./, '');
  return `${c.secure || forceHttps ? 'https' : 'http'}://${host}${c.path || '/'}`;
}

const ckey = (c) => `${c.domain}|${c.path}|${c.name}|${c.partitionKey ? JSON.stringify(c.partitionKey) : ''}`;

export async function getCookies(domains, storeId = '0') {
  const out = [];
  const seen = new Set();
  for (const d of domains) {
    let list = [];
    try { list = await chrome.cookies.getAll({ domain: d, storeId }); } catch {}
    for (const c of list) { const k = ckey(c); if (!seen.has(k)) { seen.add(k); out.push(c); } }
  }
  return out;
}

// ---------- Временные (сеансовые) куки ----------
// Браузер стирает их при закрытии — и активный аккаунт «вылетает». Multipass «закрепляет» такие куки:
// делает их постоянными с подписью в дробной части срока (…,4242 с). По подписи закреплённая куки
// отличается от настоящей постоянной: в снимок аккаунта она попадает снова как временная,
// а при выключении закрепления её можно вернуть как было.
export const PIN_FRAC = 0.4242;
export const MAX_PIN_DAYS = 399; // Chrome не хранит куки дольше 400 дней
export function isPinned(c) {
  if (!c || c.session || !c.expirationDate) return false;
  return Math.abs((c.expirationDate % 1) - PIN_FRAC) < 5e-6;
}
export function pinExpiry(days) {
  const d = Math.min(MAX_PIN_DAYS, Math.max(1, Math.round(+days || 30)));
  return Math.floor(Date.now() / 1000) + d * 86400 + PIN_FRAC;
}
export const isTemp = (c) => !c.expirationDate;
const nkey = (c) => `${c.domain}|${c.path || '/'}|${c.name}`;

export function pack(c) {
  const o = { name: c.name, value: c.value, domain: c.domain, path: c.path, secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: c.sameSite || 'unspecified', hostOnly: !!c.hostOnly };
  if (!c.session && c.expirationDate) o.expirationDate = c.expirationDate;
  if (c.partitionKey) o.partitionKey = c.partitionKey;
  if (isPinned(c)) o.pinned = true;
  return o;
}

// Для снимка аккаунта: закреплённые нами куки сохраняем в их настоящем виде — временными
export function packForSnapshot(c) {
  const o = pack(c);
  if (o.pinned) { delete o.pinned; delete o.expirationDate; }
  return o;
}

// Автосохранение не должно затирать рабочую сессию «разлогиненной»: если из прошлого снимка пропала
// половина и больше важных куки (временные + похожие на авторизационные), считаем, что вход слетел.
export function lostLogin(prev, cookies) {
  const nowS = Date.now() / 1000;
  const important = (prev?.cookies || []).filter((c) => (isTemp(c) || AUTH_COOKIE_RE.test(c.name)) && (!c.expirationDate || c.expirationDate > nowS));
  if (!important.length) return null;
  const have = new Set((cookies || []).map(nkey));
  const missing = important.filter((c) => !have.has(nkey(c)));
  return missing.length && missing.length * 2 >= important.length ? missing : null;
}

// Каких временных куки из снимка сейчас нет в браузере
export function missingTemp(snapshotCookies, current) {
  const have = new Set((current || []).map(nkey));
  return (snapshotCookies || []).filter((c) => isTemp(c) && !c.partitionKey && !have.has(nkey(c)));
}

export async function removeCookie(c, storeId) {
  const d = { url: cookieUrl(c, true), name: c.name, storeId };
  if (c.partitionKey) d.partitionKey = c.partitionKey;
  try { await chrome.cookies.remove(d); } catch {}
  if (!c.secure) { try { await chrome.cookies.remove({ ...d, url: cookieUrl(c, false) }); } catch {} }
}

export async function clearCookies(domains, storeId = '0') {
  let removed = 0;
  for (let pass = 0; pass < 3; pass++) {
    const list = await getCookies(domains, storeId);
    if (!list.length) break;
    removed += list.length;
    await Promise.all(list.map((c) => removeCookie(c, storeId)));
  }
  return removed;
}

export async function setCookie(c, storeId = '0') {
  const d = { url: cookieUrl(c), name: c.name, value: c.value ?? '', path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly, storeId };
  if (!c.hostOnly && !c.name.startsWith('__Host-')) d.domain = c.domain;
  if (c.sameSite && c.sameSite !== 'unspecified') d.sameSite = c.sameSite;
  if (d.sameSite === 'no_restriction' && !d.secure) delete d.sameSite;
  if (c.name.startsWith('__Host-') || c.name.startsWith('__Secure-')) { d.secure = true; d.url = cookieUrl({ ...c, secure: true }); }
  if (c.expirationDate) d.expirationDate = c.expirationDate;
  if (c.partitionKey) d.partitionKey = c.partitionKey;
  const r = await chrome.cookies.set(d);
  if (!r) throw new Error('браузер отклонил куки');
  return r;
}

// pinDays > 0 — временные куки ставятся сразу закреплёнными (переживут перезапуск браузера)
export async function setCookies(cookies, storeId = '0', { pinDays = 0 } = {}) {
  const nowS = Date.now() / 1000;
  const pinAt = pinDays > 0 ? pinExpiry(pinDays) : 0;
  const failed = [];
  await Promise.all((cookies || []).map(async (c) => {
    if (c.expirationDate && c.expirationDate < nowS) return;
    const x = pinAt && !c.expirationDate && !c.partitionKey ? { ...c, expirationDate: pinAt } : c;
    try { await setCookie(x, storeId); } catch (e) { failed.push(`${c.name}@${c.domain}: ${e.message}`); }
  }));
  return failed;
}

// --- Функции, выполняемые внутри страницы (должны быть самодостаточными) ---
export function pageRead(maxLen) {
  const dump = (s) => { const o = {}; try { for (let i = 0; i < s.length; i++) { const k = s.key(i); const v = s.getItem(k); if (v != null && v.length <= maxLen) o[k] = v; } } catch (e) {} return o; };
  let L = {}, S = {};
  try { L = dump(window.localStorage); } catch (e) {}
  try { S = dump(window.sessionStorage); } catch (e) {}
  return { origin: location.origin, local: L, session: S };
}

export function pageWrite(data, clear, withSession) {
  const res = { origin: location.origin, ok: true, error: null, n: 0 };
  try {
    if (clear) { try { localStorage.clear(); } catch (e) {} if (withSession) { try { sessionStorage.clear(); } catch (e) {} } }
    const L = (data && data.local) || {}, S = (data && data.session) || {};
    for (const k in L) { localStorage.setItem(k, L[k]); res.n++; }
    if (withSession) for (const k in S) { sessionStorage.setItem(k, S[k]); res.n++; }
  } catch (e) { res.ok = false; res.error = String((e && e.message) || e); }
  return res;
}

export function pageReplace(url) { location.replace(url); return true; }

export function pageIdentity() {
  const out = { title: document.title || '', email: '' };
  try {
    const text = (document.body && document.body.innerText || '').slice(0, 200000);
    const m = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (m) out.email = m[0];
    if (!out.email) {
      const meta = document.querySelector('meta[name="user-login"], meta[name="octolytics-actor-login"], meta[property="profile:username"]');
      if (meta && meta.content) out.email = meta.content;
    }
  } catch (e) {}
  return out;
}

export async function exec(tabId, func, args = []) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return r ? r.result : undefined;
}

export async function readDomFromTabs(tabs) {
  const out = {};
  for (const t of tabs) {
    if (t.discarded) continue;
    const u = safeUrl(t.url);
    if (!u || !/^https?:$/.test(u.protocol) || out[u.origin]) continue;
    try {
      const r = await exec(t.id, pageRead, [MAX_VALUE]);
      if (r && r.origin && !out[r.origin]) out[r.origin] = { local: r.local || {}, session: r.session || {} };
    } catch {}
  }
  return out;
}

export async function writeDom(tabId, data, { clear = true, session = true } = {}) {
  return exec(tabId, pageWrite, [data || {}, clear, session]);
}

export async function findSiteTabs(domains, storeId = '0') {
  const [tabs, stores] = await Promise.all([chrome.tabs.query({}), chrome.cookies.getAllCookieStores().catch(() => [])]);
  const map = new Map();
  for (const s of stores) for (const id of s.tabIds) map.set(id, s.id);
  return tabs.filter((t) => {
    const u = safeUrl(t.url || t.pendingUrl);
    if (!u || !/^https?:$/.test(u.protocol)) return false;
    if (!domains.some((d) => hostMatches(u.hostname, d))) return false;
    return (map.get(t.id) || (t.incognito ? '1' : '0')) === storeId;
  });
}

export function summarize(p) {
  const cookies = p.cookies || [];
  let expiresAt = null, authExpiresAt = null, temp = 0, tempAuth = 0;
  for (const c of cookies) {
    if (!c.expirationDate) { temp++; if (AUTH_COOKIE_RE.test(c.name)) tempAuth++; continue; }
    const ms = c.expirationDate * 1000;
    if (expiresAt == null || ms > expiresAt) expiresAt = ms;
    if (AUTH_COOKIE_RE.test(c.name) && (authExpiresAt == null || ms < authExpiresAt)) authExpiresAt = ms;
  }
  const origins = Object.keys(p.storage || {});
  let lsKeys = 0;
  for (const o of origins) lsKeys += Object.keys(p.storage[o].local || {}).length + Object.keys(p.storage[o].session || {}).length;
  let size = 0;
  try { size = JSON.stringify(p).length; } catch {}
  return { at: p.savedAt || 0, cookies: cookies.length, temp, tempAuth, origins: origins.length, lsKeys, expiresAt, authExpiresAt, browser: p.browser || browserLabel(p.ua || ''), device: p.device || '', size };
}

export function waitForLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let seenLoading = false, done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); chrome.tabs.onUpdated.removeListener(l); resolve(v); };
    const l = (id, info, t) => {
      if (id !== tabId) return;
      if (info.status === 'loading') seenLoading = true;
      if (info.status === 'complete' && seenLoading) finish(t);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    chrome.tabs.onUpdated.addListener(l);
  });
}

// Навигация с заменой записи в истории (если можно) и ожиданием загрузки
export async function navigate(tabId, url, { timeoutMs = 15000, replace = true, wait = true } = {}) {
  const p = wait ? waitForLoad(tabId, timeoutMs) : null;
  let done = false;
  if (replace) { try { await exec(tabId, pageReplace, [url]); done = true; } catch {} }
  if (!done) await chrome.tabs.update(tabId, { url });
  return p || true;
}
