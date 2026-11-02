// Прокси: PAC-маршрутизация (глобально / по правилам / по аккаунтам), авторизация, проверка, мониторинг, авто-резерв
import { initDb, save, tombstone } from './db.js';
import { describeError } from '../shared/netErrors.js';
import * as log from './log.js';
import { emit } from './bus.js';
import { uid, err, token12, pool, safeUrl, sleep } from '../shared/util.js';
import { matchPattern, normalizePattern, normalizeHost, suggestSite, findSiteForHost } from '../shared/domains.js';
import { parseProxyList, proxyKey, formatProxy, PROXY_TYPES } from '../shared/proxyParse.js';

export { describeError };
export const CHECK_PARAM = '__mpchk';
const BLOCK = 'PROXY 127.0.0.1:9';
const FATAL_NET = new Set(['net::ERR_PROXY_CONNECTION_FAILED', 'net::ERR_NAME_NOT_RESOLVED', 'net::ERR_ADDRESS_UNREACHABLE', 'net::ERR_CONNECTION_TIMED_OUT', 'net::ERR_TIMED_OUT']);
const PROXY_NET_ERRORS = new Set(['net::ERR_PROXY_CONNECTION_FAILED', 'net::ERR_TUNNEL_CONNECTION_FAILED', 'net::ERR_SOCKS_CONNECTION_FAILED',
  'net::ERR_SOCKS_CONNECTION_HOST_UNREACHABLE', 'net::ERR_PROXY_AUTH_UNSUPPORTED', 'net::ERR_PROXY_CERTIFICATE_INVALID', 'net::ERR_NO_SUPPORTED_PROXIES', 'net::ERR_PROXY_AUTH_REQUESTED']);


const checkMap = new Map();   // token → { proxyId, result }
const netErrors = new Map();  // token → net::ERR_*
const inFlight = new Set();
const authAttempts = new Map();
let lastPac = undefined;
let lastPassive = 0;
let passiveTimer = null;

// ---------- Слушатели (регистрируются синхронно при старте SW) ----------
export function register() {
  chrome.webRequest.onAuthRequired.addListener((details, callback) => {
    if (!details.isProxy) { callback({}); return; }
    const n = (authAttempts.get(details.requestId) || 0) + 1;
    authAttempts.set(details.requestId, n);
    if (authAttempts.size > 1000) authAttempts.clear();
    if (n > 2) { callback({ cancel: true }); return; }
    findCredentials(details).then((cred) => callback(cred ? { authCredentials: cred } : {})).catch(() => callback({}));
  }, { urls: ['<all_urls>'] }, ['asyncBlocking']);

  chrome.webRequest.onErrorOccurred.addListener((d) => {
    const i = d.url.indexOf(CHECK_PARAM + '=');
    if (i !== -1) { netErrors.set(d.url.substr(i + CHECK_PARAM.length + 1, 12), d.error); return; }
    if (PROXY_NET_ERRORS.has(d.error)) schedulePassive();
  }, { urls: ['<all_urls>'] });

  try { chrome.proxy.onProxyError.addListener(() => schedulePassive()); } catch {}

  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === 'proxy-monitor') monitor().catch((e) => console.warn(e));
    if (a.name === 'proxy-recheck-all') check(null, { detect: false, quiet: true }).catch(() => {});
  });
}

export async function ensureAlarms() {
  const c = await initDb();
  const m = Math.max(0.5, +c.settings.monitorIntervalMin || 2);
  chrome.alarms.create('proxy-monitor', { periodInMinutes: m, delayInMinutes: m });
  if (+c.settings.recheckAllMin > 0) chrome.alarms.create('proxy-recheck-all', { periodInMinutes: +c.settings.recheckAllMin });
  else chrome.alarms.clear('proxy-recheck-all');
}

async function findCredentials(details) {
  const c = await initDb();
  const host = String(details.challenger?.host || '').toLowerCase();
  const port = +details.challenger?.port;
  const cands = Object.values(c.proxies).filter((p) => p.username && p.host.toLowerCase() === host && +p.port === port);
  if (!cands.length) return null;
  const creds = (p) => ({ username: p.username, password: p.password || '' });
  if (cands.length === 1) return creds(cands[0]);
  const i = details.url.indexOf(CHECK_PARAM + '=');
  if (i !== -1) {
    const job = checkMap.get(details.url.substr(i + CHECK_PARAM.length + 1, 12));
    const p = job && c.proxies[job.proxyId];
    if (p) return creds(p);
  }
  const u = safeUrl(details.url);
  if (u) {
    const r = routeForHost(c, u.hostname);
    if (r?.proxy && cands.some((x) => x.id === r.proxy.id)) return creds(r.proxy);
  }
  return creds(cands[0]);
}

// ---------- Маршруты ----------
export function effectiveType(c, p) {
  if (p.type && p.type !== 'auto') return p.type;
  return c.proxyStatus[p.id]?.detected || 'http';
}

export function pacEntry(c, p, type) {
  const t = type || effectiveType(c, p);
  const hp = `${p.host.includes(':') ? `[${p.host}]` : p.host}:${p.port}`;
  if (t === 'https') return `HTTPS ${hp}`;
  if (t === 'socks5') return `SOCKS5 ${hp}`;
  if (t === 'socks4') return `SOCKS ${hp}`;
  return `PROXY ${hp}`;
}

const stateOf = (c, id) => c.proxyStatus[id]?.state || 'unknown';

export function bestInGroup(c, group, excludeId) {
  const list = Object.values(c.proxies).filter((p) => (p.group || '') === group && p.id !== excludeId);
  const alive = list.filter((p) => stateOf(c, p.id) === 'alive')
    .sort((a, b) => (c.proxyStatus[a.id].latency || 1e9) - (c.proxyStatus[b.id].latency || 1e9));
  if (alive.length) return alive[0];
  return list.find((p) => stateOf(c, p.id) === 'unknown') || null;
}

export function resolveTarget(c, target, allowFailover) {
  if (!target) return null;
  const ks = c.proxyState.killSwitch !== false;
  if (target === 'direct') return { result: 'DIRECT', kind: 'direct' };
  if (target === 'block') return { result: BLOCK, kind: 'block' };
  if (target.startsWith('group:')) {
    const g = target.slice(6);
    const p = bestInGroup(c, g);
    if (p) return { result: pacEntry(c, p) + (ks ? '' : '; DIRECT'), kind: 'group', group: g, proxy: p };
    return { result: ks ? BLOCK : 'DIRECT', kind: 'empty-group', group: g };
  }
  if (target.startsWith('proxy:')) {
    const p = c.proxies[target.slice(6)];
    if (!p) return { result: ks ? BLOCK : 'DIRECT', kind: 'missing' };
    if (stateOf(c, p.id) === 'dead' && allowFailover && p.group) {
      const alt = bestInGroup(c, p.group, p.id);
      if (alt && stateOf(c, alt.id) === 'alive') return { result: pacEntry(c, alt) + (ks ? '' : '; DIRECT'), kind: 'failover', proxy: alt, original: p };
    }
    return { result: pacEntry(c, p) + (ks ? '' : '; DIRECT'), kind: 'proxy', proxy: p };
  }
  return null;
}

export function computeRoutes(c) {
  const ps = c.proxyState;
  if (ps.mode === 'off') return null;
  const bindings = [];
  for (const [siteId, acctId] of Object.entries(c.local.activeMap || {})) {
    const a = c.accounts[acctId], s = c.sites[siteId];
    if (!a || !s || !a.proxy) continue;
    const r = resolveTarget(c, a.proxy, ps.accountFailover);
    if (!r) continue;
    for (const d of s.domains) bindings.push({ pattern: d.toLowerCase(), ...r, source: { type: 'account', accountId: a.id, siteId, name: a.name } });
  }
  const rules = Object.values(c.rules).filter((r) => r.enabled !== false)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((r) => { const t = resolveTarget(c, r.target, ps.failover); return t && { pattern: r.pattern.toLowerCase(), ...t, source: { type: 'rule', ruleId: r.id } }; })
    .filter(Boolean);
  let def = { result: 'DIRECT', kind: 'direct', source: { type: 'default' } };
  if (ps.mode === 'global' && ps.target) {
    const t = resolveTarget(c, ps.target, ps.failover);
    if (t) def = { ...t, source: { type: 'global' } };
  }
  return { bypass: (ps.bypass || []).map((x) => String(x).toLowerCase()), bindings, rules, def };
}

export function routeForHost(c, host, routes = computeRoutes(c)) {
  if (!routes) return { kind: 'off', result: null, source: { type: 'off' } };
  host = String(host || '').toLowerCase();
  for (const p of routes.bypass) if (matchPattern(host, p)) return { kind: 'direct', result: 'DIRECT', source: { type: 'bypass', pattern: p } };
  for (const b of routes.bindings) if (matchPattern(host, b.pattern)) return b;
  for (const r of routes.rules) if (matchPattern(host, r.pattern)) return r;
  return routes.def;
}

export function buildPac(routes, checks) {
  const C = {};
  for (const [t, v] of checks) C[t] = v.result;
  const B = routes ? routes.bypass : [];
  const BIND = routes ? routes.bindings.map((b) => [b.pattern, b.result]) : [];
  const R = routes ? routes.rules.map((r) => [r.pattern, r.result]) : [];
  const DEF = routes ? routes.def.result : 'DIRECT';
  const P = CHECK_PARAM + '=';
  return `// Multipass PAC
var C=${JSON.stringify(C)};var B=${JSON.stringify(B)};var BIND=${JSON.stringify(BIND)};var R=${JSON.stringify(R)};var DEF=${JSON.stringify(DEF)};
function m(h,p){if(p==="<local>")return h.indexOf(".")===-1;if(p.indexOf("*")!==-1||p.indexOf("?")!==-1)return shExpMatch(h,p);return h===p||(h.length>p.length&&h.substring(h.length-p.length-1)==="."+p);}
function FindProxyForURL(url,host){var i=url.indexOf(${JSON.stringify(P)});if(i!==-1){var t=url.substr(i+${P.length},12);if(C.hasOwnProperty(t))return C[t];}
host=host.toLowerCase();for(i=0;i<B.length;i++){if(m(host,B[i]))return "DIRECT";}for(i=0;i<BIND.length;i++){if(m(host,BIND[i][0]))return BIND[i][1];}for(i=0;i<R.length;i++){if(m(host,R[i][0]))return R[i][1];}return DEF;}`;
}

let applyChain = Promise.resolve();
export function apply() {
  applyChain = applyChain.then(doApply, doApply);
  return applyChain;
}

async function doApply() {
  const c = await initDb();
  const routes = computeRoutes(c);
  const active = !!routes && (routes.bindings.length > 0 || routes.rules.length > 0 || routes.def.result !== 'DIRECT');
  try {
    if (!active && checkMap.size === 0) {
      if (lastPac !== null) { await chrome.proxy.settings.clear({ scope: 'regular' }); lastPac = null; }
    } else {
      const pac = buildPac(active ? routes : null, checkMap);
      if (pac !== lastPac) {
        await chrome.proxy.settings.set({ value: { mode: 'pac_script', pacScript: { data: pac, mandatory: true } }, scope: 'regular' });
        lastPac = pac;
      }
    }
  } catch (e) { log.error('Не удалось применить настройки прокси: ' + e.message); }
  try {
    if (active && c.proxyState.webrtc) await chrome.privacy.network.webRTCIPHandlingPolicy.set({ value: 'disable_non_proxied_udp' });
    else await chrome.privacy.network.webRTCIPHandlingPolicy.clear({});
  } catch {}
  emit('routes-changed');
}

export async function controlState() {
  try { const s = await chrome.proxy.settings.get({}); return s.levelOfControl; } catch { return 'unknown'; }
}

// Описание маршрута для UI
export function describeRoute(c, host) {
  const r = routeForHost(c, host);
  const out = { kind: r.kind, source: r.source, group: r.group || null, proxy: null, original: null, status: null };
  if (r.proxy) { out.proxy = publicProxy(c, r.proxy); out.status = c.proxyStatus[r.proxy.id] || null; }
  if (r.original) out.original = publicProxy(c, r.original);
  return out;
}

export function publicProxy(c, p) {
  return { id: p.id, name: p.name, type: p.type, effType: effectiveType(c, p), host: p.host, port: p.port, group: p.group || '', hasAuth: !!p.username, status: c.proxyStatus[p.id] || null };
}

export function summary(c) {
  const list = Object.values(c.proxies).sort((a, b) => (a.group || '').localeCompare(b.group || '') || a.name.localeCompare(b.name)).map((p) => publicProxy(c, p));
  const groups = [...new Set(list.map((p) => p.group).filter(Boolean))].sort();
  const counts = { total: list.length, alive: list.filter((p) => p.status?.state === 'alive').length, dead: list.filter((p) => p.status?.state === 'dead').length };
  let globalRoute = null;
  if (c.proxyState.target) {
    const t = resolveTarget(c, c.proxyState.target, c.proxyState.failover);
    if (t) globalRoute = { kind: t.kind, group: t.group || null, proxy: t.proxy ? publicProxy(c, t.proxy) : null, original: t.original ? publicProxy(c, t.original) : null };
  }
  return { state: c.proxyState, list, groups, counts, globalRoute, checking: inFlight.size };
}

// ---------- Проверка ----------
function typesToTry(p, detect) {
  if (p.type && p.type !== 'auto') return [p.type];
  if (!detect) return ['http'];
  const socksPorts = [1080, 1081, 1082, 1085, 1088, 1089, 4145, 9050, 9150, 10808, 7891];
  return socksPorts.includes(+p.port) ? ['socks5', 'http', 'socks4'] : ['http', 'socks5', 'socks4'];
}

function parseGeo(j) {
  if (!j || typeof j !== 'object') return {};
  const cc = j.countryCode || j.country_code || (typeof j.country === 'string' && j.country.length === 2 ? j.country : '') || '';
  return {
    ip: j.query || j.ip || j.origin || '',
    cc: String(cc).toUpperCase(),
    country: j.country && j.country.length > 2 ? j.country : (j.country_name || ''),
    city: j.city || '', region: j.regionName || j.region || '',
    isp: j.isp || j.org || j.asn_org || '',
    tz: (typeof j.timezone === 'string' ? j.timezone : j.timezone?.id) || j.time_zone || j.location?.time_zone || '',
  };
}

function checkUrlFor(settings, token) {
  const base = settings.checkUrl || 'http://ip-api.com/json/';
  return base + (base.includes('?') ? '&' : '?') + CHECK_PARAM + '=' + token;
}

async function attempt(token, settings) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), settings.checkTimeoutMs || 10000);
  const t0 = performance.now();
  try {
    const res = await fetch(checkUrlFor(settings, token), { cache: 'no-store', credentials: 'omit', signal: ctrl.signal, redirect: 'manual' });
    const latency = Math.round(performance.now() - t0);
    if (res.status === 407) return { ok: false, error: 'AUTH', latency };
    let geo = {};
    if (res.ok) { try { geo = parseGeo(JSON.parse(await res.text())); } catch {} }
    return { ok: true, latency, http: res.status, ...geo };
  } catch (e) {
    await sleep(30);
    const net = netErrors.get(token);
    netErrors.delete(token);
    if (ctrl.signal.aborted) return { ok: false, error: 'TIMEOUT', fatal: true };
    return { ok: false, error: net || 'NETWORK', fatal: FATAL_NET.has(net) };
  } finally { clearTimeout(timer); }
}

let statusSaveTimer = null;
function saveStatusSoon() {
  clearTimeout(statusSaveTimer);
  statusSaveTimer = setTimeout(() => save('proxyStatus').catch(() => {}), 250);
}

export async function check(ids, { detect = true, quiet = false } = {}) {
  const c = await initDb();
  let list = (ids && ids.length ? ids : Object.keys(c.proxies)).map((id) => c.proxies[id]).filter(Boolean);
  list = list.filter((p) => !inFlight.has(p.id));
  if (!list.length) return { total: 0, alive: 0, dead: 0 };
  list.forEach((p) => { inFlight.add(p.id); c.proxyStatus[p.id] = { ...(c.proxyStatus[p.id] || { state: 'unknown' }), checking: true }; });
  await save('proxyStatus');
  const plan = list.map((p) => ({ p, tries: typesToTry(p, detect).map((type) => ({ type, token: token12() })) }));
  for (const it of plan) for (const a of it.tries) checkMap.set(a.token, { proxyId: it.p.id, result: pacEntry(c, it.p, a.type) });
  let typesChanged = false;
  try {
    await apply();
    await pool(plan, Math.max(1, +c.settings.checkConcurrency || 12), async (it) => {
      let r = null;
      for (const a of it.tries) {
        r = await attempt(a.token, c.settings);
        r.type = a.type;
        if (r.ok || r.fatal || r.error === 'AUTH') break;
      }
      const prev = c.proxyStatus[it.p.id] || {};
      if (r.ok) {
        c.proxyStatus[it.p.id] = { state: 'alive', latency: r.latency, ip: r.ip || prev.ip || '', cc: r.cc || prev.cc || '', country: r.country || prev.country || '', city: r.city || prev.city || '',
          region: r.region || '', isp: r.isp || prev.isp || '', tz: r.tz || prev.tz || '', at: Date.now(), error: null, fails: 0, detected: r.type, checking: false };
        if (it.p.type === 'auto' && c.proxies[it.p.id]) { c.proxies[it.p.id].type = r.type; c.proxies[it.p.id].updatedAt = Date.now(); typesChanged = true; }
      } else {
        let error = r.error;
        if (it.p.username && effectiveType(c, it.p).startsWith('socks')) error = 'SOCKS_AUTH';
        c.proxyStatus[it.p.id] = { ...prev, state: 'dead', latency: null, at: Date.now(), error, fails: (prev.fails || 0) + 1, checking: false };
      }
      saveStatusSoon();
      return r;
    });
  } finally {
    for (const it of plan) for (const a of it.tries) checkMap.delete(a.token);
    list.forEach((p) => inFlight.delete(p.id));
    await save('proxyStatus');
    if (typesChanged) { await save('proxies'); emit('data-changed', { sync: true }); }
    await apply();
  }
  const alive = list.filter((p) => c.proxyStatus[p.id]?.state === 'alive').length;
  if (!quiet) log.info(`Проверка прокси: ${alive} из ${list.length} живы`);
  return { total: list.length, alive, dead: list.length - alive };
}

export function inUseIds(c) {
  const routes = computeRoutes(c);
  const ids = new Set();
  if (!routes) return [];
  for (const r of [...routes.bindings, ...routes.rules, routes.def]) {
    if (r.proxy) ids.add(r.proxy.id);
    if (r.original) ids.add(r.original.id);
  }
  // для группового глобального режима проверяем всю группу, чтобы резерв был готов
  if (c.proxyState.mode === 'global' && c.proxyState.target?.startsWith('group:')) {
    const g = c.proxyState.target.slice(6);
    Object.values(c.proxies).filter((p) => (p.group || '') === g).slice(0, 30).forEach((p) => ids.add(p.id));
  }
  return [...ids];
}

async function monitor() {
  const c = await initDb();
  const ids = inUseIds(c);
  if (!ids.length) return;
  const before = Object.fromEntries(ids.map((id) => [id, stateOf(c, id)]));
  await check(ids, { detect: false, quiet: true });
  const suspicious = ids.filter((id) => before[id] !== 'dead' && stateOf(c, id) === 'dead');
  if (suspicious.length) { await sleep(2500); await check(suspicious, { detect: false, quiet: true }); }
  for (const id of ids) {
    const p = c.proxies[id];
    if (!p) continue;
    const now = stateOf(c, id);
    if (before[id] !== 'dead' && now === 'dead') {
      const routes = computeRoutes(c);
      const fo = routes && [...routes.bindings, ...routes.rules, routes.def].find((r) => r.original?.id === id);
      const msg = fo ? `Трафик переключён на резерв: ${fo.proxy.name}` : (c.proxyState.killSwitch ? 'Kill switch: трафик через него заблокирован, утечки IP нет' : 'Трафик пойдёт напрямую');
      log.warn(`Прокси «${p.name}» перестал отвечать. ${msg}`);
      emit('notify', { id: 'px-dead-' + id, title: `Прокси «${p.name}» не отвечает`, message: msg });
    } else if (before[id] === 'dead' && now === 'alive') {
      log.info(`Прокси «${p.name}» снова работает`);
      emit('notify', { id: 'px-alive-' + id, title: `Прокси «${p.name}» снова работает`, message: `Задержка ${c.proxyStatus[id].latency} мс` });
    }
  }
}

function schedulePassive() {
  if (Date.now() - lastPassive < 30000) return;
  clearTimeout(passiveTimer);
  passiveTimer = setTimeout(() => { lastPassive = Date.now(); monitor().catch(() => {}); }, 3000);
}

// IP, который увидит сайт
export async function ipForHost(host) {
  const c = await initDb();
  const r = host ? routeForHost(c, host) : { result: 'DIRECT' };
  const token = token12();
  checkMap.set(token, { proxyId: r.proxy?.id || null, result: r.result || 'DIRECT' });
  try {
    await apply();
    const res = await attempt(token, c.settings);
    return { ...res, via: r.proxy ? publicProxy(c, r.proxy) : null, kind: r.kind, errorText: describeError(res.error) };
  } finally { checkMap.delete(token); await apply(); }
}

// ---------- CRUD ----------
export async function importList(text, { defaultType = 'auto', group = '', autoCheck = true } = {}) {
  const c = await initDb();
  const { items, errors } = parseProxyList(text, { defaultType });
  const existing = new Set(Object.values(c.proxies).map(proxyKey));
  const added = [];
  let duplicates = 0;
  const t = Date.now();
  for (const it of items) {
    if (existing.has(proxyKey(it))) { duplicates++; continue; }
    existing.add(proxyKey(it));
    const p = { id: uid('px_'), name: it.label || `${it.host}:${it.port}`, type: PROXY_TYPES.includes(it.type) ? it.type : 'auto', host: it.host, port: it.port,
      username: it.username || '', password: it.password || '', group: String(group || '').trim(), note: '', createdAt: t, updatedAt: t };
    c.proxies[p.id] = p;
    added.push(p.id);
  }
  if (added.length) { await save('proxies'); emit('data-changed', { sync: true }); log.info(`Импортировано прокси: ${added.length}`); }
  if (autoCheck && added.length) check(added).catch((e) => log.error('Проверка: ' + e.message));
  return { added: added.length, ids: added, duplicates, errors };
}

export async function addProxy(input) {
  const c = await initDb();
  const t = Date.now();
  const p = { id: uid('px_'), name: input.name || `${input.host}:${input.port}`, type: input.type || 'auto', host: normalizeHost(input.host), port: +input.port,
    username: input.username || '', password: input.password || '', group: (input.group || '').trim(), note: input.note || '', createdAt: t, updatedAt: t };
  if (!p.host || !(p.port > 0 && p.port < 65536)) throw err('Укажите хост и порт');
  c.proxies[p.id] = p;
  await save('proxies');
  emit('data-changed', { sync: true });
  check([p.id]).catch(() => {});
  return p;
}

export async function updateProxy(id, patch) {
  const c = await initDb();
  const p = c.proxies[id];
  if (!p) throw err('Прокси не найден');
  const allowed = ['name', 'type', 'host', 'port', 'username', 'password', 'group', 'note'];
  for (const k of allowed) if (k in patch) p[k] = k === 'port' ? +patch[k] : (typeof patch[k] === 'string' ? patch[k].trim() : patch[k]);
  if ('host' in patch) p.host = normalizeHost(p.host);
  p.updatedAt = Date.now();
  if (['type', 'host', 'port', 'username', 'password'].some((k) => k in patch)) { delete c.proxyStatus[id]; await save('proxyStatus'); }
  await save('proxies');
  emit('data-changed', { sync: true });
  await apply();
  return p;
}

export async function deleteProxies(ids) {
  const c = await initDb();
  for (const id of ids) {
    if (!c.proxies[id]) continue;
    delete c.proxies[id];
    delete c.proxyStatus[id];
    c.tombstones['proxy:' + id] = Date.now();
  }
  await save('proxies', 'proxyStatus', 'tombstones');
  emit('data-changed', { sync: true });
  await apply();
  return { deleted: ids.length };
}

export async function deleteDead() {
  const c = await initDb();
  const ids = Object.keys(c.proxies).filter((id) => stateOf(c, id) === 'dead');
  return deleteProxies(ids);
}

export async function setState(patch) {
  const c = await initDb();
  const allowed = ['mode', 'target', 'killSwitch', 'failover', 'accountFailover', 'webrtc', 'bypass'];
  for (const k of allowed) if (k in patch) c.proxyState[k] = patch[k];
  if (patch.mode && patch.mode !== 'off') c.proxyState.lastMode = patch.mode;
  if (c.proxyState.mode === 'global' && !c.proxyState.target) {
    const first = Object.values(c.proxies).find((p) => stateOf(c, p.id) === 'alive') || Object.values(c.proxies)[0];
    if (first) c.proxyState.target = 'proxy:' + first.id;
  }
  if (Array.isArray(c.proxyState.bypass)) c.proxyState.bypass = c.proxyState.bypass.map((s) => String(s).trim()).filter(Boolean);
  await save('proxyState');
  await apply();
  return c.proxyState;
}

export async function toggle() {
  const c = await initDb();
  if (c.proxyState.mode !== 'off') return setState({ mode: 'off' });
  return setState({ mode: c.proxyState.lastMode && c.proxyState.lastMode !== 'off' ? c.proxyState.lastMode : (c.proxyState.target ? 'global' : 'rules') });
}

function nextAlive(c, currentId) {
  const cur = c.proxies[currentId];
  const pool_ = Object.values(c.proxies).filter((p) => (cur?.group ? (p.group || '') === cur.group : true) && stateOf(c, p.id) === 'alive')
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  if (!pool_.length) return null;
  const idx = pool_.findIndex((p) => p.id === currentId);
  return pool_[(idx + 1) % pool_.length];
}

// «Сменить IP»: следующий живой прокси для источника маршрута текущего сайта (или глобального)
export async function rotate({ host } = {}) {
  const c = await initDb();
  const r = host ? routeForHost(c, host) : null;
  const src = r?.source?.type;
  const current = r?.proxy?.id || (c.proxyState.target?.startsWith('proxy:') ? c.proxyState.target.slice(6) : null);
  const next = nextAlive(c, current);
  if (!next) throw err('Нет живых прокси для смены. Проверьте список.');
  if (src === 'account') {
    const a = c.accounts[r.source.accountId];
    if (a.proxy?.startsWith('group:')) throw err('Аккаунт привязан к группе — она выбирает лучший прокси автоматически');
    a.proxy = 'proxy:' + next.id; a.updatedAt = Date.now();
    await save('accounts'); emit('data-changed', { sync: true });
  } else if (src === 'rule') {
    const rule = c.rules[r.source.ruleId];
    if (rule.target?.startsWith('group:')) throw err('Правило указывает на группу — она выбирает лучший прокси автоматически');
    rule.target = 'proxy:' + next.id; rule.updatedAt = Date.now();
    await save('rules'); emit('data-changed', { sync: true });
  } else {
    c.proxyState.target = 'proxy:' + next.id;
    if (c.proxyState.mode !== 'global') c.proxyState.mode = 'global';
    await save('proxyState');
  }
  await apply();
  log.info(`Смена прокси → ${next.name}`);
  return publicProxy(c, next);
}

// ---------- Правила ----------
export async function addRule({ pattern, target, note = '', enabled = true }) {
  const c = await initDb();
  const pat = normalizePattern(pattern);
  if (!pat) throw err('Укажите домен или шаблон');
  const t = Date.now();
  const order = Math.max(0, ...Object.values(c.rules).map((r) => r.order ?? 0)) + 1;
  const r = { id: uid('rule_'), pattern: pat, target: target || 'direct', enabled, note, order, createdAt: t, updatedAt: t };
  c.rules[r.id] = r;
  await save('rules');
  emit('data-changed', { sync: true });
  await apply();
  return r;
}

export async function updateRule(id, patch) {
  const c = await initDb();
  const r = c.rules[id];
  if (!r) throw err('Правило не найдено');
  for (const k of ['pattern', 'target', 'enabled', 'note', 'order']) if (k in patch) r[k] = k === 'pattern' ? normalizePattern(patch[k]) : patch[k];
  r.updatedAt = Date.now();
  await save('rules');
  emit('data-changed', { sync: true });
  await apply();
  return r;
}

export async function deleteRules(ids) {
  const c = await initDb();
  for (const id of ids) { if (c.rules[id]) { delete c.rules[id]; c.tombstones['rule:' + id] = Date.now(); } }
  await save('rules', 'tombstones');
  emit('data-changed', { sync: true });
  await apply();
  return { deleted: ids.length };
}

export async function reorderRules(ids) {
  const c = await initDb();
  ids.forEach((id, i) => { if (c.rules[id]) { c.rules[id].order = i + 1; c.rules[id].updatedAt = Date.now(); } });
  await save('rules');
  emit('data-changed', { sync: true });
  await apply();
}

// Быстрое правило для сайта текущей вкладки (все домены сайта)
export async function setSiteRoute({ host, target }) {
  const c = await initDb();
  const site = findSiteForHost(c.sites, host) || suggestSite(host);
  const domains = site.domains;
  const existing = Object.values(c.rules).filter((r) => domains.includes(r.pattern));
  if (!target) { await deleteRules(existing.map((r) => r.id)); return { domains, target: null }; }
  for (const d of domains) {
    const r = existing.find((x) => x.pattern === d);
    if (r) { r.target = target; r.enabled = true; r.updatedAt = Date.now(); }
    else {
      const t = Date.now();
      const order = Math.min(0, ...Object.values(c.rules).map((x) => x.order ?? 0)) - 1;
      const nr = { id: uid('rule_'), pattern: d, target, enabled: true, note: site.name || '', order, createdAt: t, updatedAt: t };
      c.rules[nr.id] = nr;
    }
  }
  await save('rules');
  emit('data-changed', { sync: true });
  await apply();
  return { domains, target };
}

export function exportList(c, ids, style = 'url') {
  const list = (ids && ids.length ? ids.map((id) => c.proxies[id]) : Object.values(c.proxies)).filter(Boolean);
  return list.map((p) => {
    const p2 = { ...p, type: effectiveType(c, p) };
    return formatProxy(p2, style) + (p.name && p.name !== `${p.host}:${p.port}` ? `  # ${p.name}` : '');
  }).join('\n');
}

export async function fetchList(url) {
  const u = safeUrl(url);
  if (!u || !/^https?:$/.test(u.protocol)) throw err('Нужна ссылка http(s)');
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw err(`Сервер ответил ${r.status}`);
  const text = await r.text();
  if (text.length > 3_000_000) throw err('Слишком большой файл');
  return text;
}
