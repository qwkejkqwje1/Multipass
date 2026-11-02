// Сайты, аккаунты и движок переключения сессий
import { initDb, save, readRaw, writeRaw, removeRaw } from './db.js';
import * as vault from './vault.js';
import * as S from './sessions.js';
import * as log from './log.js';
import * as proxy from './proxy.js';
import * as K from './keepalive.js';
import { emit } from './bus.js';
import { uid, err, pickColor, isHttpUrl, safeUrl, browserLabel } from '../shared/util.js';
import { normalizeHost, suggestSite, findSiteForHost, hostMatches } from '../shared/domains.js';

const PENDING_KEY = 'pendingDom';
let switching = false;

export function register() {
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.status === 'complete' && isHttpUrl(tab.url)) applyPending(tab).catch(() => {});
  });
}

export function siteOpts(c, site) {
  const o = site?.opts || {};
  return { captureStorage: o.captureStorage ?? c.settings.captureStorage, deepClean: o.deepClean ?? c.settings.deepClean };
}

export function siteMatchesUrl(site, url) {
  const u = safeUrl(url);
  return !!u && /^https?:$/.test(u.protocol) && site.domains.some((d) => hostMatches(u.hostname, d));
}

function isReusableTab(tab) {
  return !!tab && (!tab.url || /^(chrome|edge|brave|vivaldi|opera|browser):\/\/(newtab|new-tab-page|startpage)/.test(tab.url) || tab.url === 'about:blank' || tab.url.startsWith('chrome-search://'));
}

function sortAccounts(list) {
  return list.sort((a, b) => (b.fav ? 1 : 0) - (a.fav ? 1 : 0) || (a.order ?? 0) - (b.order ?? 0) || (a.createdAt || 0) - (b.createdAt || 0));
}

export function decorate(c, a, activeId) {
  const elsewhere = [];
  for (const [devId, d] of Object.entries(c.devices || {})) {
    if (devId === c.local.deviceId || !d || Date.now() - (d.lastSeen || 0) > 3 * 86400e3) continue;
    if (d.active && d.active[a.siteId] === a.id) elsewhere.push(d.name || devId);
  }
  return { ...a, session: c.sessIndex[a.id] || null, active: a.id === activeId, lastUsedAt: c.local.lastUsed[a.id] || 0, elsewhere };
}

export function accountsOfSite(c, siteId) {
  const activeId = c.local.activeMap[siteId] || null;
  return sortAccounts(Object.values(c.accounts).filter((a) => a.siteId === siteId)).map((a) => decorate(c, a, activeId));
}

export async function getContext(tabId) {
  const c = await initDb();
  let tab = null;
  if (tabId != null) tab = await chrome.tabs.get(+tabId).catch(() => null);
  if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const url = tab?.url || tab?.pendingUrl || '';
  const u = safeUrl(url);
  const supported = !!u && /^https?:$/.test(u.protocol);
  const host = supported ? u.hostname : '';
  const site = supported ? findSiteForHost(c.sites, host) : null;
  const shown = site || (supported ? { id: null, ...suggestSite(host) } : null);
  return {
    tab: tab ? { id: tab.id, url, title: tab.title || '', favIconUrl: tab.favIconUrl || '', incognito: !!tab.incognito, windowId: tab.windowId } : null,
    supported, host, site: shown, siteExists: !!site,
    activeId: site ? c.local.activeMap[site.id] || null : null,
    accounts: site ? accountsOfSite(c, site.id) : [],
  };
}

export async function ensureSite(host) {
  const c = await initDb();
  let site = findSiteForHost(c.sites, host);
  if (site) return site;
  const sug = suggestSite(host);
  const t = Date.now();
  site = { id: uid('site_'), name: sug.name, domains: sug.domains, startUrl: '', opts: {}, createdAt: t, updatedAt: t };
  c.sites[site.id] = site;
  await save('sites');
  emit('data-changed', { sync: true });
  return site;
}

async function getTab(tabId) {
  if (tabId != null) { const t = await chrome.tabs.get(+tabId).catch(() => null); if (t) return t; }
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t || null;
}

// ---------- Снимок сессии ----------
export async function captureInto(accountId, { tab = null, storeId = null, reason = 'manual' } = {}) {
  const c = await initDb();
  const a = c.accounts[accountId];
  if (!a) throw err('Аккаунт не найден');
  const site = c.sites[a.siteId];
  if (!site) throw err('Сайт аккаунта не найден');
  if (c.vaultMeta.enabled) await vault.requireKey();
  if (storeId == null) storeId = await S.storeIdForTab(tab);
  const cookies = (await S.getCookies(site.domains, storeId)).map(S.packForSnapshot);
  if (!cookies.length) {
    if (reason === 'autosave') { log.warn(`Автосохранение «${a.name}» пропущено: на сайте нет куки`); return null; }
    throw err('На сайте нет куки — похоже, вход не выполнен');
  }
  const prev = await vault.loadSession(accountId).catch(() => null);
  if (reason === 'autosave') {
    // временные куки могли пропасть (перезапуск браузера) — тогда не затираем рабочую сессию «разлогиненной»
    const lost = S.lostLogin(prev, cookies);
    if (lost) {
      log.warn(`Автосохранение «${a.name}» пропущено: пропали куки входа (${lost.slice(0, 4).map((x) => x.name).join(', ')}${lost.length > 4 ? '…' : ''}) — похоже, вход слетел. Сохранённая сессия не тронута.`);
      return null;
    }
  }
  let storage = {};
  if (siteOpts(c, site).captureStorage) {
    const tabs = await S.findSiteTabs(site.domains, storeId);
    if (tab) tabs.sort((x, y) => (y.id === tab.id ? 1 : 0) - (x.id === tab.id ? 1 : 0));
    storage = await S.readDomFromTabs(tabs);
    if (prev?.storage) {
      for (const [o, v] of Object.entries(prev.storage)) {
        const h = safeUrl(o)?.hostname;
        if (!storage[o] && h && site.domains.some((d) => hostMatches(h, d))) storage[o] = v;
      }
    }
  }
  const payload = { v: 1, savedAt: Date.now(), cookies, storage, ua: navigator.userAgent, browser: browserLabel(), device: c.local.deviceName };
  await vault.storeSession(accountId, payload);
  c.sessIndex[accountId] = S.summarize(payload);
  await save('sessIndex');
  emit('data-changed', { sync: true });
  if (reason !== 'autosave') {
    const temp = c.sessIndex[accountId].temp;
    log.info(`Сессия «${a.name}» сохранена (${cookies.length} куки${temp ? `, из них временных ${temp}` : ''})`);
    // вход только что сохранили — его временные куки закрепляем сразу, не дожидаясь их обновления сайтом
    K.pinSite(site, storeId).catch(() => {});
    K.clearLogout(site.id).catch(() => {});
  }
  return c.sessIndex[accountId];
}

// ---------- Переключение ----------
export async function switchTo(accountId, { tabId = null, newTab = false, url = null } = {}) {
  const c = await initDb();
  const a = c.accounts[accountId];
  if (!a) throw err('Аккаунт не найден');
  const site = c.sites[a.siteId];
  if (!site) throw err('Сайт аккаунта не найден');
  return exclusive(() => runSwitch({ site, accountId, tabId, newTab, url }));
}

export async function cleanLogin(tabId, { name = '', proxy: proxyTarget = null, draft = true } = {}) {
  const tab = await getTab(tabId);
  if (!tab || !isHttpUrl(tab.url)) throw err('Откройте сайт, на котором нужен новый аккаунт');
  const site = await ensureSite(new URL(tab.url).hostname);
  let accountId = null;
  if (draft) {
    const acc = await createAccount(site, { name, proxy: proxyTarget });
    accountId = acc.id;
  }
  return exclusive(() => runSwitch({ site, accountId, tabId: tab.id, newTab: false }));
}

async function exclusive(fn) {
  if (switching) throw err('Переключение уже выполняется', 'BUSY');
  switching = true;
  K.pause();
  try { return await fn(); } finally { switching = false; K.resume(); }
}

async function runSwitch({ site, accountId, tabId, newTab, url }) {
  const c = await initDb();
  const t0 = Date.now();
  const acct = accountId ? c.accounts[accountId] : null;
  if (c.vaultMeta.enabled) await vault.requireKey();
  const target = acct ? await vault.loadSession(acct.id) : null;
  let tab = tabId != null ? await chrome.tabs.get(+tabId).catch(() => null) : null;
  const onSite = !!tab && siteMatchesUrl(site, tab.url);
  const storeId = await S.storeIdForTab(tab);
  const opts = siteOpts(c, site);
  const prevId = c.local.activeMap[site.id] || null;

  // 1. Автосохранение текущего аккаунта (его свежие куки/токены)
  if (prevId && prevId !== accountId && c.accounts[prevId] && c.settings.autosaveOnSwitch) {
    try { await captureInto(prevId, { tab: onSite ? tab : null, storeId, reason: 'autosave' }); }
    catch (e) { if (e.code === 'LOCKED') throw e; log.warn(`Автосохранение не удалось: ${e.message}`); }
  }
  const prevSess = prevId ? await vault.loadSession(prevId).catch(() => null) : null;

  // 2. Новый активный аккаунт + маршрут прокси ДО любых сетевых запросов
  const prevActive = c.local.activeMap[site.id];
  if (accountId) { c.local.activeMap[site.id] = accountId; c.local.lastUsed[accountId] = Date.now(); }
  else delete c.local.activeMap[site.id];
  if (c.local.loggedOut) delete c.local.loggedOut[site.id];
  c.local.presenceAt = Date.now();
  await save('local');
  await proxy.apply();

  let cookiesTouched = false;
  try {
    // 3. Остальные вкладки сайта «замораживаем», чтобы они не перезаписали куки старым аккаунтом
    const siteTabs = await S.findSiteTabs(site.domains, storeId);
    const reloadLater = [];
    for (const t of siteTabs) {
      if (tab && t.id === tab.id) continue;
      if (c.settings.discardOtherTabs && !t.active && !t.discarded) {
        try { await chrome.tabs.discard(t.id); continue; } catch {}
      }
      if (!t.discarded) reloadLater.push(t.id);
    }

    const origins = new Set();
    for (const d of site.domains) for (const pre of ['https://', 'https://www.', 'http://', 'http://www.']) origins.add(pre + d);
    for (const t of siteTabs) { const u = safeUrl(t.url); if (u) origins.add(u.origin); }
    for (const s of [prevSess, target]) if (s?.storage) Object.keys(s.storage).forEach((o) => origins.add(o));
    const originList = [...origins];

    // 4. Service Worker и Cache Storage сайта убираем заранее (иначе промежуточная страница может отдать «оболочку» приложения)
    if (opts.deepClean) await chrome.browsingData.remove({ origins: originList }, { serviceWorkers: true, cacheStorage: true }).catch(() => {});

    // 5. Промежуточная страница того же origin (robots.txt): код сайта не работает и не пишет в хранилище
    let dest = url || acct?.startUrl || (onSite ? tab.url : '') || site.startUrl || '';
    if (!dest) {
      const firstOrigin = target?.storage && Object.keys(target.storage).find((o) => Object.keys(target.storage[o].local || {}).length);
      dest = (firstOrigin || `https://${site.domains[0]}`) + '/';
    }
    let workTab = onSite && !newTab ? tab : (!newTab && isReusableTab(tab) ? tab : null);
    const hasStorage = !!target?.storage && Object.keys(target.storage).length > 0;
    let staged = false, stageOrigin = null;
    if (opts.captureStorage && (onSite || hasStorage)) {
      stageOrigin = onSite && workTab === tab ? new URL(tab.url).origin : new URL(dest).origin;
      if (!workTab) workTab = await chrome.tabs.create({ url: 'about:blank', active: true, ...(tab ? { windowId: tab.windowId, index: tab.index + 1 } : {}) });
      const loaded = await S.navigate(workTab.id, stageOrigin + '/robots.txt', { timeoutMs: 15000, replace: workTab === tab && onSite });
      if (!loaded) throw err('Страница не отпустила переход (возможно, сайт спросил «Покинуть страницу?»). Повторите.', 'STAGE_TIMEOUT');
      if (siteMatchesUrl(site, loaded.url)) { staged = true; stageOrigin = new URL(loaded.url).origin; }
    }

    // 6. Очистка: куки + localStorage (+ IndexedDB/кэш при глубокой очистке)
    cookiesTouched = true;
    await S.clearCookies(site.domains, storeId);
    const kinds = { localStorage: true };
    if (opts.deepClean) Object.assign(kinds, { indexedDB: true, cacheStorage: true, serviceWorkers: true, fileSystems: true });
    await chrome.browsingData.remove({ origins: originList }, kinds).catch((e) => log.warn('Очистка данных сайта: ' + e.message));

    // 7. Восстановление куки (временные — сразу закреплёнными, чтобы вход пережил перезапуск браузера)
    const pinDays = storeId === '0' ? K.pinDaysFor(c, site) : 0;
    const failed = target ? await S.setCookies(target.cookies || [], storeId, { pinDays }) : [];
    if (failed.length) log.warn(`Не удалось восстановить ${failed.length} куки: ${failed.slice(0, 3).join('; ')}`);

    // 8. DOM-хранилище: сразу в промежуточной странице, для остальных origin — при первом заходе
    if (staged) await S.writeDom(workTab.id, target?.storage?.[stageOrigin] || { local: {}, session: {} }, { clear: true, session: true }).catch(() => {});
    await setPending(site, storeId, accountId, target, staged ? stageOrigin : null);

    // 9. Финальная навигация
    if (workTab) await S.navigate(workTab.id, dest, { replace: staged, wait: false });
    else await chrome.tabs.create({ url: dest, active: true, ...(tab ? { windowId: tab.windowId, index: tab.index + 1 } : {}) });
    for (const id of reloadLater) chrome.tabs.reload(id).catch(() => {});

    const ms = Date.now() - t0;
    log.info(acct ? `Переключено на «${acct.name}» (${site.name}) за ${ms} мс` : `Чистый вход на ${site.name}`);
    emit('data-changed', { sync: false });
    return { ok: true, ms, failedCookies: failed.length, staged, accountId };
  } catch (e) {
    if (!cookiesTouched) {
      if (prevActive) c.local.activeMap[site.id] = prevActive; else delete c.local.activeMap[site.id];
      await save('local');
      await proxy.apply();
    }
    throw e;
  }
}

async function setPending(site, storeId, accountId, target, doneOrigin) {
  const r = await chrome.storage.session.get(PENDING_KEY);
  const p = r[PENDING_KEY] || {};
  for (const k of Object.keys(p)) if (p[k].siteId === site.id && p[k].storeId === storeId) delete p[k];
  if (accountId && target?.storage) {
    for (const [o, st] of Object.entries(target.storage)) {
      if (o === doneOrigin) continue;
      if (!Object.keys(st.local || {}).length && !Object.keys(st.session || {}).length) continue;
      p[storeId + '|' + o] = { siteId: site.id, accountId, storeId, origin: o, at: Date.now() };
    }
  }
  await chrome.storage.session.set({ [PENDING_KEY]: p });
}

async function applyPending(tab) {
  const r = await chrome.storage.session.get(PENDING_KEY);
  const p = r[PENDING_KEY];
  if (!p || !Object.keys(p).length) return;
  const origin = new URL(tab.url).origin;
  const storeId = await S.storeIdForTab(tab);
  const key = storeId + '|' + origin;
  const job = p[key];
  if (!job) return;
  delete p[key];
  await chrome.storage.session.set({ [PENDING_KEY]: p });
  if (Date.now() - job.at > 3600e3) return;
  const c = await initDb();
  if (c.local.activeMap[job.siteId] !== job.accountId) return;
  const sess = await vault.loadSession(job.accountId).catch(() => null);
  const data = sess?.storage?.[origin];
  if (!data) return;
  await S.writeDom(tab.id, data, { clear: true, session: true });
  await chrome.tabs.reload(tab.id);
}

// ---------- Создание/сохранение ----------
async function createAccount(site, { name = '', color = '', note = '', tags = [], proxy: proxyTarget = null } = {}) {
  const c = await initDb();
  const siblings = Object.values(c.accounts).filter((a) => a.siteId === site.id);
  const t = Date.now();
  const a = {
    id: uid('acc_'), siteId: site.id, name: (name || '').trim() || `Аккаунт ${siblings.length + 1}`,
    color: color || pickColor(siblings.map((x) => x.color)), note, tags: tags || [], proxy: proxyTarget || null,
    startUrl: '', fav: false, order: siblings.length, createdAt: t, updatedAt: t,
  };
  c.accounts[a.id] = a;
  await save('accounts');
  emit('data-changed', { sync: true });
  return a;
}

export async function saveAsNew(tabId, opts = {}) {
  const tab = await getTab(tabId);
  if (!tab || !isHttpUrl(tab.url)) throw err('Откройте сайт, чью сессию нужно сохранить');
  const c = await initDb();
  if (c.vaultMeta.enabled) await vault.requireKey();
  const site = await ensureSite(new URL(tab.url).hostname);
  const a = await createAccount(site, opts);
  try {
    await captureInto(a.id, { tab, reason: 'new' });
  } catch (e) {
    delete c.accounts[a.id];
    await save('accounts');
    throw e;
  }
  c.local.activeMap[site.id] = a.id;
  c.local.lastUsed[a.id] = Date.now();
  c.local.presenceAt = Date.now();
  await save('local');
  if (a.proxy) await proxy.apply();
  emit('data-changed', { sync: true });
  return decorate(c, a, a.id);
}

export async function saveActive(tabId) {
  const tab = await getTab(tabId);
  if (!tab || !isHttpUrl(tab.url)) throw err('Откройте сайт');
  const c = await initDb();
  const site = findSiteForHost(c.sites, new URL(tab.url).hostname);
  const id = site && c.local.activeMap[site.id];
  if (!id || !c.accounts[id]) throw err('Нет активного аккаунта — сохраните сессию как новый аккаунт', 'NO_ACTIVE');
  return captureInto(id, { tab, reason: 'manual' });
}

export async function captureFromTab(accountId, tabId) {
  const tab = await getTab(tabId);
  const c = await initDb();
  const a = c.accounts[accountId];
  if (!a) throw err('Аккаунт не найден');
  if (!tab || !siteMatchesUrl(c.sites[a.siteId], tab.url)) throw err('Откройте сайт этого аккаунта');
  const r = await captureInto(accountId, { tab, reason: 'manual' });
  c.local.activeMap[a.siteId] = accountId;
  c.local.presenceAt = Date.now();
  await save('local');
  await proxy.apply();
  return r;
}

export async function nextAccount(tabId, dir = 1) {
  const tab = await getTab(tabId);
  if (!tab || !isHttpUrl(tab.url)) throw err('Откройте сайт');
  const c = await initDb();
  const site = findSiteForHost(c.sites, new URL(tab.url).hostname);
  if (!site) throw err('Для этого сайта ещё нет аккаунтов');
  const list = accountsOfSite(c, site.id).filter((a) => a.session);
  if (!list.length) throw err('Нет сохранённых аккаунтов');
  const idx = list.findIndex((a) => a.active);
  const next = list[(idx + dir + list.length) % list.length];
  if (next.active) throw err('Это единственный аккаунт');
  const r = await switchTo(next.id, { tabId: tab.id });
  return { ...r, name: next.name };
}

export async function guessIdentity(tabId) {
  try { return await S.exec(+tabId, S.pageIdentity, []); } catch { return { title: '', email: '' }; }
}

// ---------- Редактирование ----------
export async function updateAccount(id, patch) {
  const c = await initDb();
  const a = c.accounts[id];
  if (!a) throw err('Аккаунт не найден');
  for (const k of ['name', 'color', 'note', 'tags', 'proxy', 'startUrl', 'fav', 'siteId', 'order']) if (k in patch) a[k] = patch[k];
  if (typeof a.name === 'string') a.name = a.name.trim() || 'Без имени';
  if (a.siteId && !c.sites[a.siteId]) throw err('Сайт не найден');
  a.updatedAt = Date.now();
  await save('accounts');
  emit('data-changed', { sync: true });
  if ('proxy' in patch || 'siteId' in patch) await proxy.apply();
  return decorate(c, a, c.local.activeMap[a.siteId]);
}

export async function deleteAccounts(ids) {
  const c = await initDb();
  const t = Date.now();
  for (const id of ids) {
    const a = c.accounts[id];
    if (!a) continue;
    delete c.accounts[id];
    delete c.sessIndex[id];
    delete c.local.lastUsed[id];
    if (c.local.activeMap[a.siteId] === id) delete c.local.activeMap[a.siteId];
    c.tombstones['acct:' + id] = t;
    c.tombstones['sess:' + id] = t;
    await removeRaw(['sess:' + id, 'prev:' + id]);
  }
  await save('accounts', 'sessIndex', 'local', 'tombstones');
  emit('data-changed', { sync: true });
  await proxy.apply();
  log.info(`Удалено аккаунтов: ${ids.length}`);
  return { deleted: ids.length };
}

export async function forgetActive(siteId) {
  const c = await initDb();
  delete c.local.activeMap[siteId];
  await save('local');
  await proxy.apply();
}

export async function createSite({ name, domains }) {
  const c = await initDb();
  const ds = [...new Set((domains || []).map(normalizeHost).filter(Boolean))];
  if (!ds.length) throw err('Укажите хотя бы один домен');
  const t = Date.now();
  const site = { id: uid('site_'), name: (name || ds[0]).trim(), domains: ds, startUrl: '', opts: {}, createdAt: t, updatedAt: t };
  c.sites[site.id] = site;
  await save('sites');
  emit('data-changed', { sync: true });
  return site;
}

export async function updateSite(id, patch) {
  const c = await initDb();
  const s = c.sites[id];
  if (!s) throw err('Сайт не найден');
  if ('name' in patch) s.name = String(patch.name || '').trim() || s.name;
  if ('domains' in patch) {
    const ds = [...new Set((patch.domains || []).map(normalizeHost).filter(Boolean))];
    if (!ds.length) throw err('Нужен хотя бы один домен');
    s.domains = ds;
  }
  if ('startUrl' in patch) s.startUrl = patch.startUrl || '';
  if ('opts' in patch) s.opts = { ...(s.opts || {}), ...patch.opts };
  s.updatedAt = Date.now();
  await save('sites');
  emit('data-changed', { sync: true });
  await proxy.apply();
  if ('opts' in patch || 'domains' in patch) K.applyPolicy({ siteId: s.id }).catch(() => {});
  return s;
}

export async function deleteSite(id) {
  const c = await initDb();
  if (!c.sites[id]) return { deleted: 0 };
  const ids = Object.values(c.accounts).filter((a) => a.siteId === id).map((a) => a.id);
  await deleteAccounts(ids);
  delete c.sites[id];
  delete c.local.activeMap[id];
  c.tombstones['site:' + id] = Date.now();
  await save('sites', 'local', 'tombstones');
  emit('data-changed', { sync: true });
  return { deleted: ids.length };
}

export async function restorePrevious(id) {
  const c = await initDb();
  const prevRaw = await readRaw('prev:' + id);
  if (!prevRaw) throw err('Предыдущей версии сессии нет');
  const curRaw = await readRaw('sess:' + id);
  const prev = await vault.open(prevRaw);
  const restored = { ...prev, savedAt: Date.now() };
  await writeRaw('sess:' + id, await vault.seal(restored));
  if (curRaw) await writeRaw('prev:' + id, curRaw);
  c.sessIndex[id] = S.summarize(restored);
  await save('sessIndex');
  emit('data-changed', { sync: true });
  return c.sessIndex[id];
}

export async function sessionDetails(id) {
  const c = await initDb();
  const sess = await vault.loadSession(id);
  const hasPrev = !!(await readRaw('prev:' + id));
  if (!sess) return { empty: true, hasPrev };
  return {
    savedAt: sess.savedAt, browser: sess.browser, device: sess.device, ua: sess.ua, hasPrev,
    cookies: (sess.cookies || []).map((x) => ({ ...x })),
    storage: Object.fromEntries(Object.entries(sess.storage || {}).map(([o, v]) => [o, { local: Object.keys(v.local || {}).length, session: Object.keys(v.session || {}).length }])),
    summary: c.sessIndex[id] || S.summarize(sess),
  };
}

export async function storeImportedSession(accountId, payload) {
  const c = await initDb();
  await vault.storeSession(accountId, payload, { keepPrev: true });
  c.sessIndex[accountId] = S.summarize(payload);
  await save('sessIndex');
}

// Если два браузера независимо создали один и тот же сайт — объединяем детерминированно (меньший id остаётся)
export async function dedupeSites() {
  const c = await initDb();
  const list = Object.values(c.sites).sort((a, b) => a.id.localeCompare(b.id));
  let changed = false;
  for (let i = 0; i < list.length; i++) {
    const keep = list[i];
    if (!c.sites[keep.id]) continue;
    for (let j = i + 1; j < list.length; j++) {
      const dup = list[j];
      if (!c.sites[dup.id]) continue;
      if (!dup.domains.some((d) => keep.domains.includes(d))) continue;
      keep.domains = [...new Set([...keep.domains, ...dup.domains])];
      keep.updatedAt = Math.max(keep.updatedAt || 0, dup.updatedAt || 0) + 1;
      for (const a of Object.values(c.accounts)) if (a.siteId === dup.id) { a.siteId = keep.id; a.updatedAt = Date.now(); }
      if (c.local.activeMap[dup.id] && !c.local.activeMap[keep.id]) c.local.activeMap[keep.id] = c.local.activeMap[dup.id];
      delete c.local.activeMap[dup.id];
      delete c.sites[dup.id];
      c.tombstones['site:' + dup.id] = Date.now();
      changed = true;
    }
  }
  if (changed) await save('sites', 'accounts', 'local', 'tombstones');
  return changed;
}
