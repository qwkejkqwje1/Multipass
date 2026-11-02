// API для страниц расширения (popup / панель). Принимаем сообщения только от своих страниц.
import { initDb, save, wipeAll, DEFAULTS } from './db.js';
import * as accounts from './accounts.js';
import * as proxy from './proxy.js';
import * as sync from './sync.js';
import * as vault from './vault.js';
import * as transfer from './transfer.js';
import * as S from './sessions.js';
import * as log from './log.js';
import * as K from './keepalive.js';
import { emit } from './bus.js';
import { err, safeUrl } from '../shared/util.js';
import { parseCookieText, toCookieEditorJSON, toNetscape } from '../shared/cookieFormats.js';
import { findSiteForHost, suggestSite } from '../shared/domains.js';

async function tabSite(tabId) {
  const tab = await chrome.tabs.get(+tabId);
  const u = safeUrl(tab.url);
  if (!u || !/^https?:$/.test(u.protocol)) throw err('Откройте обычный сайт');
  const c = await initDb();
  const site = findSiteForHost(c.sites, u.hostname) || suggestSite(u.hostname);
  return { tab, url: u, site, storeId: await S.storeIdForTab(tab) };
}

// Сайты с вложенными аккаунтами (по алфавиту; у каждого — активный аккаунт и время последнего использования)
function sitesTree(c) {
  return Object.values(c.sites).map((s) => {
    const list = accounts.accountsOfSite(c, s.id);
    return { id: s.id, name: s.name, domains: s.domains, startUrl: s.startUrl || '', opts: s.opts || {}, activeId: c.local.activeMap[s.id] || null,
      lastUsedAt: list.reduce((m, a) => Math.max(m, a.lastUsedAt || 0), 0), accounts: list };
  }).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

const H = {
  // ---- контекст и данные ----
  async ctx({ tabId }) {
    const ctx = await accounts.getContext(tabId);
    const c = await initDb();
    ctx.route = ctx.host ? proxy.describeRoute(c, ctx.host) : null;
    const doms = ctx.site?.domains || [];
    ctx.siteRuleTarget = Object.values(c.rules).find((r) => r.enabled !== false && doms.includes(r.pattern))?.target || null;
    ctx.proxy = proxy.summary(c);
    ctx.vault = await vault.status();
    ctx.sync = sync.status(c);
    ctx.settings = c.settings;
    ctx.device = { id: c.local.deviceId, name: c.local.deviceName };
    ctx.control = await proxy.controlState();
    ctx.totalAccounts = Object.keys(c.accounts).length;
    ctx.sites = sitesTree(c); // для окна: сначала сайты, внутри — их аккаунты
    return ctx;
  },
  async data() {
    const c = await initDb();
    const sites = Object.values(c.sites).map((s) => ({ ...s, accounts: accounts.accountsOfSite(c, s.id), activeId: c.local.activeMap[s.id] || null }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      sites, proxies: Object.values(c.proxies), proxyStatus: c.proxyStatus, rules: Object.values(c.rules).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
      settings: c.settings, proxyState: c.proxyState, proxy: proxy.summary(c), device: { id: c.local.deviceId, name: c.local.deviceName },
      sync: sync.status(c), vault: await vault.status(), control: await proxy.controlState(),
    };
  },
  async search({ q }) {
    const c = await initDb();
    const needle = String(q || '').toLowerCase().trim();
    const out = [];
    for (const a of Object.values(c.accounts)) {
      const s = c.sites[a.siteId];
      if (!s) continue;
      const hay = [a.name, a.note, ...(a.tags || []), s.name, ...s.domains].join(' ').toLowerCase();
      if (!needle || hay.includes(needle)) out.push({ ...accounts.decorate(c, a, c.local.activeMap[s.id]), siteName: s.name, domain: s.domains[0] });
    }
    return out.sort((x, y) => (y.lastUsedAt || 0) - (x.lastUsedAt || 0)).slice(0, 50);
  },
  log: async () => (await initDb()).log,
  async 'log.clear'() { const c = await initDb(); c.log = []; await save('log'); },

  // ---- аккаунты ----
  'acct.saveNew': ({ tabId, ...opts }) => accounts.saveAsNew(tabId, opts),
  'acct.saveActive': ({ tabId }) => accounts.saveActive(tabId),
  'acct.capture': ({ id, tabId }) => accounts.captureFromTab(id, tabId),
  'acct.switch': ({ id, tabId, newTab, url }) => accounts.switchTo(id, { tabId, newTab, url }),
  'acct.cleanLogin': ({ tabId, name, proxy: p, draft }) => accounts.cleanLogin(tabId, { name, proxy: p, draft }),
  'acct.next': ({ tabId, dir }) => accounts.nextAccount(tabId, dir || 1),
  'acct.update': ({ id, patch }) => accounts.updateAccount(id, patch),
  'acct.delete': ({ ids }) => accounts.deleteAccounts(ids),
  'acct.restorePrev': ({ id }) => accounts.restorePrevious(id),
  'acct.details': ({ id }) => accounts.sessionDetails(id),
  'acct.identity': ({ tabId }) => accounts.guessIdentity(tabId),
  'acct.forgetActive': ({ siteId }) => accounts.forgetActive(siteId),
  'acct.exportCookies': ({ id, format }) => transfer.exportAccountCookies(id, format),
  'site.create': (p) => accounts.createSite(p),
  'site.update': ({ id, patch }) => accounts.updateSite(id, patch),
  'site.delete': ({ id }) => accounts.deleteSite(id),

  // ---- прокси ----
  'proxy.import': ({ text, defaultType, group, autoCheck }) => proxy.importList(text, { defaultType, group, autoCheck }),
  'proxy.fetchList': ({ url }) => proxy.fetchList(url),
  'proxy.add': (p) => proxy.addProxy(p),
  'proxy.update': ({ id, patch }) => proxy.updateProxy(id, patch),
  'proxy.delete': ({ ids }) => proxy.deleteProxies(ids),
  'proxy.deleteDead': () => proxy.deleteDead(),
  'proxy.check': ({ ids, detect }) => proxy.check(ids, { detect: detect !== false }),
  'proxy.state': (patch) => proxy.setState(patch),
  'proxy.toggle': () => proxy.toggle(),
  'proxy.rotate': ({ host }) => proxy.rotate({ host }),
  'proxy.ip': ({ host }) => proxy.ipForHost(host),
  async 'proxy.route'({ host }) { return proxy.describeRoute(await initDb(), String(host || '').trim().toLowerCase()); },
  'proxy.siteRoute': ({ host, target }) => proxy.setSiteRoute({ host, target }),
  async 'proxy.export'({ ids, style }) { return proxy.exportList(await initDb(), ids, style); },
  'rule.add': (r) => proxy.addRule(r),
  'rule.update': ({ id, patch }) => proxy.updateRule(id, patch),
  'rule.delete': ({ ids }) => proxy.deleteRules(ids),
  'rule.reorder': ({ ids }) => proxy.reorderRules(ids),

  // ---- редактор куки текущей вкладки ----
  async 'cookies.list'({ tabId }) {
    const { site, storeId, url } = await tabSite(tabId);
    const list = await S.getCookies(site.domains, storeId);
    return { host: url.hostname, domains: site.domains, cookies: list.map(S.pack).sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name)) };
  },
  async 'cookies.set'({ tabId, cookie, original }) {
    const { storeId } = await tabSite(tabId);
    if (original && (original.name !== cookie.name || original.domain !== cookie.domain || original.path !== cookie.path)) await S.removeCookie(original, storeId);
    await S.setCookie(cookie, storeId);
    return true;
  },
  async 'cookies.remove'({ tabId, cookie }) { const { storeId } = await tabSite(tabId); await S.removeCookie(cookie, storeId); return true; },
  async 'cookies.clear'({ tabId }) { const { site, storeId } = await tabSite(tabId); return S.clearCookies(site.domains, storeId); },
  async 'cookies.import'({ tabId, text, replace }) {
    const { site, storeId } = await tabSite(tabId);
    const { cookies } = parseCookieText(text);
    if (replace) await S.clearCookies(site.domains, storeId);
    const failed = await S.setCookies(cookies, storeId);
    return { imported: cookies.length - failed.length, failed };
  },
  async 'cookies.export'({ tabId, format }) {
    const { site, storeId } = await tabSite(tabId);
    // закреплённые Multipass куки экспортируем как были — временными
    const list = (await S.getCookies(site.domains, storeId)).map(S.packForSnapshot);
    return format === 'netscape' ? toNetscape(list) : toCookieEditorJSON(list);
  },

  // ---- перенос ----
  'bundle.export': (p) => transfer.exportBundle(p),
  'bundle.import': ({ text, password }) => transfer.importBundle(text, password),
  'bundle.importCookies': (p) => transfer.importCookies(p),

  // ---- синхронизация ----
  'sync.configure': (p) => sync.configure(p),
  'sync.now': () => sync.syncNow({ reason: 'manual' }),
  'sync.poke': () => sync.poke(),
  'sync.folderChanged': (p) => sync.folderChanged(p),
  'sync.options': (p) => sync.updateOptions(p),
  'sync.disconnect': () => sync.disconnect(),

  // ---- хранилище ----
  'vault.status': () => vault.status(),
  'vault.enable': ({ password }) => vault.enable(password),
  'vault.disable': ({ password }) => vault.disable(password),
  'vault.change': ({ oldPassword, newPassword }) => vault.change(oldPassword, newPassword),
  'vault.unlock': ({ password }) => vault.unlock(password),
  'vault.lock': () => vault.lock(),

  // ---- настройки ----
  async 'settings.update'({ patch }) {
    const c = await initDb();
    for (const k of Object.keys(DEFAULTS.settings)) if (k in patch) c.settings[k] = patch[k];
    if ('pinDays' in patch) c.settings.pinDays = Math.min(S.MAX_PIN_DAYS, Math.max(1, Math.round(+patch.pinDays || 30)));
    await save('settings');
    await proxy.ensureAlarms();
    emit('data-changed', { sync: false });
    if ('pinSessionCookies' in patch || 'pinDays' in patch) K.applyPolicy({ refresh: 'pinDays' in patch ? 'all' : false }).catch(() => {});
    return c.settings;
  },
  async 'device.rename'({ name }) {
    const c = await initDb();
    c.local.deviceName = String(name || '').trim().slice(0, 60) || c.local.deviceName;
    c.local.presenceAt = Date.now();
    await save('local');
    sync.scheduleSoon();
    return c.local.deviceName;
  },
  async 'data.wipe'() { await wipeAll(); await proxy.apply(); log.info('Все данные удалены'); return true; },
};

export function register() {
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (!msg || typeof msg.type !== 'string' || !H[msg.type]) return false;
    if (sender.id !== chrome.runtime.id || !String(sender.url || '').startsWith(chrome.runtime.getURL(''))) return false;
    Promise.resolve()
      .then(() => H[msg.type](msg.payload || {}, sender))
      .then((res) => respond({ ok: true, res }), (e) => respond({ ok: false, error: e?.message || String(e), code: e?.code || null }));
    return true;
  });
}
