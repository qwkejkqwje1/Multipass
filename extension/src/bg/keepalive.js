// Защита от «временных» (сеансовых) куки. Такие куки не имеют срока, и браузер стирает их при закрытии —
// после перезапуска активный аккаунт оказывается разлогинен, а автосохранение могло бы затереть рабочую сессию.
// Контрмеры:
//  1. Закрепление: на сайтах с активным аккаунтом временные куки сразу превращаются в постоянные
//     (срок — в настройках). Работает и для куки, которые сайт выдаёт позже (новый вход, смена токена).
//  2. При переключении временные куки аккаунта ставятся сразу закреплёнными (см. accounts.runSwitch).
//  3. Подстраховка при запуске браузера: пропавшие временные куки активного аккаунта возвращаются
//     из сохранённой сессии, вкладки сайта перезагружаются.
//  4. Срок закреплённых куки продлевается при запуске и дважды в сутки — пока аккаунт активен, вход не истечёт.
//  5. Если сайт сам удалил временную куки входа (вы вышли из аккаунта), при следующем запуске её не «воскрешаем».
//     Сайты с выключенным закреплением (банки и т.п.) тоже не трогаем — их сеанс должен заканчиваться с браузером.
//  (Защита автосохранения от «разлогиненного» состояния — в accounts.captureInto.)
import { initDb, save } from './db.js';
import * as S from './sessions.js';
import * as vault from './vault.js';
import * as log from './log.js';
import { on } from './bus.js';
import { findSiteForHost } from '../shared/domains.js';

const DEFAULT_STORE = '0'; // обычный профиль; в инкогнито закреплять бессмысленно — оно стирается целиком
const PENDING = 'tempRestorePending';
const ALARM = 'temp-cookies-refresh';
const queue = new Map();
let timer = null;
let paused = 0;
let resumedAt = 0;

export function register() {
  chrome.cookies.onChanged.addListener(onCookieChanged);
  chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) applyPolicy({ refresh: true }).catch(() => {}); });
  on('vault-changed', () => { runPendingRestore().catch(() => {}); reindex().catch(() => {}); });
}

// На время переключения аккаунта не вмешиваемся: куки сайта как раз очищаются и ставятся заново
export function pause() { paused++; }
export function resume() { paused = Math.max(0, paused - 1); resumedAt = Date.now(); }

export function pinDaysFor(c, site) {
  if (!site) return 0;
  const enabled = site.opts?.pinSession ?? c.settings.pinSessionCookies;
  if (!enabled) return 0;
  return Math.min(S.MAX_PIN_DAYS, Math.max(1, Math.round(+c.settings.pinDays || 30)));
}

export async function ensureAlarm() {
  chrome.alarms.create(ALARM, { periodInMinutes: 12 * 60, delayInMinutes: 60 });
}

function onCookieChanged({ removed, cookie, cause }) {
  // быстрый фильтр: событие приходит на любые куки браузера
  if (!cookie || cookie.partitionKey || cookie.storeId !== DEFAULT_STORE) return;
  if (removed) {
    // сайт (или вы в редакторе куки) удалил временную куки входа — это выход, а не потеря
    if ((cause === 'expired_overwrite' || cause === 'explicit') && !paused && Date.now() - resumedAt > 3000
      && (cookie.session || S.isPinned(cookie)) && S.AUTH_COOKIE_RE.test(cookie.name)) noteLogout(cookie).catch(() => {});
    return;
  }
  if (!cookie.session) return;
  queue.set(`${cookie.domain}|${cookie.path}|${cookie.name}`, cookie);
  clearTimeout(timer);
  timer = setTimeout(() => flush().catch((e) => console.warn('pin', e)), 400);
}

async function flush() {
  timer = null;
  if (paused) { timer = setTimeout(() => flush().catch(() => {}), 1500); return; }
  if (!queue.size) return;
  const items = [...queue.values()];
  queue.clear();
  const c = await initDb();
  for (const ck of items) {
    const site = findSiteForHost(c.sites, ck.domain);
    if (!site || !c.local.activeMap[site.id]) continue;
    const days = pinDaysFor(c, site);
    if (days) await pinOne(ck, days);
  }
}

async function noteLogout(ck) {
  await new Promise((r) => setTimeout(r, 3000));
  if (await currentOf(ck, DEFAULT_STORE)) return; // куку тут же выдали заново — это обновление токена, а не выход
  const c = await initDb();
  const site = findSiteForHost(c.sites, ck.domain);
  if (!site || !c.local.activeMap[site.id]) return;
  c.local.loggedOut ||= {};
  if (c.local.loggedOut[site.id]) return;
  c.local.loggedOut[site.id] = Date.now();
  await save('local');
}

// Вход снова сохранён или аккаунт переключён — сайт опять можно восстанавливать при запуске
export async function clearLogout(siteId) {
  const c = await initDb();
  if (!c.local.loggedOut?.[siteId]) return;
  delete c.local.loggedOut[siteId];
  await save('local');
}

// Перечитываем куки перед записью: её могли удалить или уже закрепить
async function currentOf(ck, storeId) {
  const list = await chrome.cookies.getAll({ domain: ck.domain.replace(/^\./, ''), name: ck.name, storeId }).catch(() => []);
  return list.find((x) => x.domain === ck.domain && x.path === ck.path && !x.partitionKey) || null;
}

async function pinOne(ck, days, storeId = DEFAULT_STORE) {
  const cur = await currentOf(ck, storeId);
  if (!cur || !cur.session) return false;
  try { await S.setCookie({ ...S.pack(cur), expirationDate: S.pinExpiry(days) }, storeId); return true; }
  catch { return false; }
}

// Закрепить временные куки сайта. refresh: true — заодно продлить закреплённые, у которых прошла половина срока;
// 'all' — переписать срок всем закреплённым (изменили срок в настройках)
export async function pinSite(site, storeId = DEFAULT_STORE, { refresh = false } = {}) {
  if (storeId !== DEFAULT_STORE || !site) return 0;
  const c = await initDb();
  const days = pinDaysFor(c, site);
  if (!days) return 0;
  const halfLife = Date.now() / 1000 + (days * 86400) / 2;
  let n = 0;
  for (const ck of await S.getCookies(site.domains, storeId)) {
    if (ck.partitionKey) continue;
    const pinned = S.isPinned(ck);
    if (ck.session || (pinned && (refresh === 'all' || (refresh && ck.expirationDate < halfLife)))) {
      try { await S.setCookie({ ...S.pack(ck), expirationDate: S.pinExpiry(days) }, storeId); n++; } catch {}
    }
  }
  return n;
}

// Вернуть закреплённым куки прежний вид — временные (когда закрепление выключили)
export async function unpinSite(site, storeId = DEFAULT_STORE) {
  if (!site) return 0;
  let n = 0;
  for (const ck of await S.getCookies(site.domains, storeId)) {
    if (!S.isPinned(ck)) continue;
    const o = S.pack(ck);
    delete o.expirationDate; delete o.pinned;
    try { await S.setCookie(o, storeId); n++; } catch {}
  }
  return n;
}

// Привести куки в соответствие с настройками: где закрепление включено — закрепить, где выключено — открепить
export async function applyPolicy({ refresh = false, siteId = null } = {}) {
  const c = await initDb();
  let pinned = 0, unpinned = 0;
  for (const site of Object.values(c.sites)) {
    if (siteId && site.id !== siteId) continue;
    try {
      if (pinDaysFor(c, site)) { if (c.local.activeMap[site.id]) pinned += await pinSite(site, DEFAULT_STORE, { refresh }); }
      else unpinned += await unpinSite(site);
    } catch (e) { console.warn('pin policy', site.name, e); }
  }
  if (pinned) log.info(`Временные куки: закреплено/продлено ${pinned}`);
  if (unpinned) log.info(`Временные куки: снято закрепление с ${unpinned}`);
  return { pinned, unpinned };
}

// Подстраховка при запуске браузера: вернуть пропавшие временные куки активных аккаунтов
export async function restoreDropped() {
  const c = await initDb();
  if (!c.settings.restoreSessionOnStartup) return 0;
  if ((await vault.status()).locked) { await chrome.storage.session.set({ [PENDING]: true }); return 0; }
  await chrome.storage.session.remove(PENDING);
  let total = 0;
  for (const site of Object.values(c.sites)) {
    const aid = c.local.activeMap[site.id];
    const acct = aid && c.accounts[aid];
    if (!acct || site.opts?.pinSession === false || c.local.loggedOut?.[site.id]) continue;
    try {
      const sess = await vault.loadSession(aid).catch(() => null);
      if (!sess?.cookies?.length) continue;
      const missing = S.missingTemp(sess.cookies, await S.getCookies(site.domains, DEFAULT_STORE));
      if (!missing.length) continue;
      const failed = await S.setCookies(missing, DEFAULT_STORE, { pinDays: pinDaysFor(c, site) });
      const n = missing.length - failed.length;
      if (!n) continue;
      total += n;
      log.info(`«${acct.name}» (${site.name}): после перезапуска браузера возвращено временных куки — ${n}`);
      for (const t of await S.findSiteTabs(site.domains, DEFAULT_STORE)) if (!t.discarded) chrome.tabs.reload(t.id).catch(() => {});
    } catch (e) { console.warn('restore temp', site.name, e); }
  }
  return total;
}

// Сводки сессий, сохранённых прошлой версией, — без числа временных куки: досчитываем (нужен открытый vault)
async function reindex() {
  const c = await initDb();
  const ids = Object.keys(c.sessIndex).filter((id) => c.sessIndex[id] && c.sessIndex[id].temp == null);
  if (!ids.length || (await vault.status()).locked) return;
  for (const id of ids) {
    const sess = await vault.loadSession(id).catch(() => null);
    if (sess) c.sessIndex[id] = { ...c.sessIndex[id], ...S.summarize(sess) };
  }
  await save('sessIndex');
}

async function runPendingRestore() {
  const r = await chrome.storage.session.get(PENDING);
  if (!r[PENDING] || (await vault.status()).locked) return;
  await restoreDropped();
}

export async function onBoot(reason) {
  await ensureAlarm();
  // Запуск браузера. «install» при уже сохранённых аккаунтах — расширение подключено флагом --load-extension
  // (или браузер переустанавливает распакованные расширения при старте): это тоже новый запуск.
  // При обновлении/перезагрузке расширения браузер не перезапускался — куки на месте, ничего не возвращаем.
  const c = await initDb();
  if (reason === 'startup' || (reason === 'install' && Object.keys(c.accounts).length)) await restoreDropped().catch((e) => console.warn(e));
  await applyPolicy({ refresh: true });
  await reindex().catch(() => {});
}
