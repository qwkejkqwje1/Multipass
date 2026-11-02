// Хранилище: кэш в памяти + chrome.storage.local. Все записи идут только через service worker.
import { uid, browserLabel } from '../shared/util.js';

export const DEFAULT_BYPASS = ['localhost', '127.0.0.1', '::1', '<local>', '*.local', '10.*', '192.168.*', '169.254.*',
  '172.16.*', '172.17.*', '172.18.*', '172.19.*', '172.20.*', '172.21.*', '172.22.*', '172.23.*', '172.24.*', '172.25.*',
  '172.26.*', '172.27.*', '172.28.*', '172.29.*', '172.30.*', '172.31.*'];

export const DEFAULTS = {
  sites: {},        // id → { id, name, domains[], startUrl, opts{}, createdAt, updatedAt }
  accounts: {},     // id → { id, siteId, name, color, note, tags[], proxy, startUrl, fav, createdAt, updatedAt }
  sessIndex: {},    // id → краткая сводка сохранённой сессии (локально)
  proxies: {},      // id → { id, name, type, host, port, username, password, group, note, createdAt, updatedAt }
  proxyStatus: {},  // id → результат последней проверки (локально)
  rules: {},        // id → { id, pattern, target, enabled, order, note, createdAt, updatedAt }
  tombstones: {},   // 'acct:<id>' → deletedAt (для синхронизации удалений)
  devices: {},      // deviceId → { name, lastSeen, active{siteId: accountId} } — другие браузеры
  settings: {
    autosaveOnSwitch: true,
    pinSessionCookies: true,       // временные куки сайтов с активным аккаунтом делать постоянными
    pinDays: 30,                   // срок закрепления (продлевается, пока аккаунт активен)
    restoreSessionOnStartup: true, // при запуске браузера вернуть пропавшие временные куки из сохранённой сессии
    captureStorage: true,
    deepClean: true,
    discardOtherTabs: true,
    closePopupAfterSwitch: true,
    confirmDelete: true,
    badge: true,
    notifications: true,
    checkUrl: 'http://ip-api.com/json/?fields=status,message,country,countryCode,regionName,city,isp,org,timezone,query',
    checkTimeoutMs: 10000,
    checkConcurrency: 12,
    monitorIntervalMin: 2,
    recheckAllMin: 60,
    autoLockMin: 30,
    theme: 'auto',
  },
  proxyState: {
    mode: 'rules',       // 'off' | 'rules' | 'global'
    target: null,        // для 'global': 'proxy:<id>' | 'group:<name>'
    killSwitch: true,    // мёртвый прокси = нет соединения, а не «прямой» трафик
    failover: true,      // для глобального режима и правил — авто-резерв из той же группы
    accountFailover: false, // для аккаунтов — по умолчанию нет (IP аккаунта не должен прыгать)
    webrtc: true,        // защита от утечки IP через WebRTC при активном прокси
    bypass: DEFAULT_BYPASS,
  },
  syncConfig: { provider: null, auto: true, intervalMin: 5, lastSyncAt: 0, lastError: null, lastErrorCode: null, lastResult: null }, // keyMode: 'pass' | 'file' (ключ лежит в папке)
  vaultMeta: { enabled: false },
  local: { deviceId: null, deviceName: '', activeMap: {}, lastUsed: {}, installedAt: 0 },
  log: [],
};

let cache = null;
let loading = null;
const listeners = new Set();

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function initDb() {
  if (cache) return Promise.resolve(cache);
  if (!loading) loading = (async () => {
    const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
    const c = {};
    for (const [k, def] of Object.entries(DEFAULTS)) {
      const v = stored[k];
      if (v === undefined) c[k] = structuredClone(def);
      else if (isObj(def) && isObj(v)) c[k] = { ...structuredClone(def), ...v };
      else c[k] = v;
    }
    if (!c.local.deviceId) {
      c.local.deviceId = uid('dev_');
      c.local.deviceName = browserLabel();
      c.local.installedAt = Date.now();
      await chrome.storage.local.set({ local: c.local });
    }
    cache = c;
    return c;
  })();
  return loading;
}

export function onSaved(fn) { listeners.add(fn); }

export async function save(...keys) {
  const c = await initDb();
  const o = {};
  for (const k of keys) o[k] = c[k];
  await chrome.storage.local.set(o);
  for (const fn of listeners) { try { fn(keys); } catch (e) { console.warn(e); } }
}

export async function readRaw(key) {
  const r = await chrome.storage.local.get(key);
  return r[key] ?? null;
}
export async function writeRaw(key, val) { await chrome.storage.local.set({ [key]: val }); }
export async function removeRaw(keys) { await chrome.storage.local.remove(keys); }

export async function tombstone(key) {
  const c = await initDb();
  c.tombstones[key] = Date.now();
}

export async function wipeAll() {
  await chrome.storage.local.clear();
  await chrome.storage.session.clear();
  cache = null; loading = null;
  return initDb();
}
