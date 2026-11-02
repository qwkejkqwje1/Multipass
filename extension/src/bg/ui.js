// Значок на иконке, контекстные меню, горячие клавиши, уведомления
import { initDb } from './db.js';
import * as accounts from './accounts.js';
import * as proxy from './proxy.js';
import * as sync from './sync.js';
import * as vault from './vault.js';
import * as log from './log.js';
import { on } from './bus.js';
import { initials, safeUrl } from '../shared/util.js';
import { findSiteForHost } from '../shared/domains.js';

let badgeTimer = null;

export function register() {
  chrome.tabs.onActivated.addListener(({ tabId }) => refreshTab(tabId));
  chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.url || info.status === 'complete') refreshTab(tabId); });
  chrome.contextMenus.onClicked.addListener((info, tab) => onMenu(info, tab).catch((e) => notify({ title: 'Multipass', message: e.message })));
  chrome.commands.onCommand.addListener((cmd, tab) => onCommand(cmd, tab).catch((e) => notify({ title: 'Multipass', message: e.message })));
  chrome.notifications.onClicked.addListener((id) => { chrome.notifications.clear(id); openDashboard(id === 'mp-sync-err' ? 'sync' : '').catch(() => chrome.runtime.openOptionsPage()); });
  on('notify', notify);
  for (const evt of ['data-changed', 'routes-changed', 'vault-changed']) on(evt, refreshSoon);
}

function refreshSoon() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(async () => {
    const tabs = await chrome.tabs.query({ active: true });
    for (const t of tabs) refreshTab(t.id);
  }, 150);
}

export async function refreshTab(tabId) {
  try {
    const c = await initDb();
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    const u = safeUrl(tab.url);
    let text = '', color = '#64748b';
    const title = ['Multipass'];
    if (u && /^https?:$/.test(u.protocol) && c.settings.badge) {
      const site = findSiteForHost(c.sites, u.hostname);
      const aid = site && c.local.activeMap[site.id];
      const a = aid && c.accounts[aid];
      if (a) { text = initials(a.name); color = a.color || color; title.push(`${site.name}: ${a.name}`); }
      const r = proxy.describeRoute(c, u.hostname);
      if (r.proxy) {
        title.push(`Прокси: ${r.proxy.name}${r.status?.state === 'dead' ? ' — НЕ ОТВЕЧАЕТ' : ''}${r.kind === 'failover' ? ' (резерв)' : ''}`);
        if (r.status?.state === 'dead') { text = '!'; color = '#ef4444'; }
      } else if (r.kind === 'block' || r.kind === 'empty-group' || r.kind === 'missing') { text = '⛔'; color = '#ef4444'; title.push('Трафик сайта заблокирован (kill switch)'); }
    }
    if ((await vault.status()).locked) title.push('🔒 Хранилище заблокировано');
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
    if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' });
    await chrome.action.setTitle({ tabId, title: title.join('\n') });
  } catch {}
}

export async function setupMenus() {
  await chrome.contextMenus.removeAll();
  const pages = ['http://*/*', 'https://*/*'];
  const add = (o) => chrome.contextMenus.create(o, () => void chrome.runtime.lastError);
  add({ id: 'mp-root', title: 'Multipass', contexts: ['page', 'frame'], documentUrlPatterns: pages });
  add({ id: 'mp-save', parentId: 'mp-root', title: 'Сохранить сессию как новый аккаунт', contexts: ['page', 'frame'], documentUrlPatterns: pages });
  add({ id: 'mp-update', parentId: 'mp-root', title: 'Обновить сессию активного аккаунта', contexts: ['page', 'frame'], documentUrlPatterns: pages });
  add({ id: 'mp-next', parentId: 'mp-root', title: 'Следующий аккаунт  (Alt+Shift+S)', contexts: ['page', 'frame'], documentUrlPatterns: pages });
  add({ id: 'mp-clean', parentId: 'mp-root', title: 'Чистый вход — новый аккаунт', contexts: ['page', 'frame'], documentUrlPatterns: pages });
  add({ id: 'mp-sep', parentId: 'mp-root', type: 'separator', contexts: ['page', 'frame'], documentUrlPatterns: pages });
  add({ id: 'mp-dash', parentId: 'mp-root', title: 'Панель управления', contexts: ['page', 'frame'], documentUrlPatterns: pages });
  add({ id: 'mp-a-dash', title: 'Панель управления', contexts: ['action'] });
  add({ id: 'mp-a-toggle', title: 'Прокси: включить / выключить', contexts: ['action'] });
  add({ id: 'mp-a-check', title: 'Проверить все прокси', contexts: ['action'] });
  add({ id: 'mp-a-sync', title: 'Синхронизировать сейчас', contexts: ['action'] });
  add({ id: 'mp-a-lock', title: 'Заблокировать хранилище', contexts: ['action'] });
}

async function onMenu(info, tab) {
  switch (info.menuItemId) {
    case 'mp-save': { const a = await accounts.saveAsNew(tab.id, {}); notify({ title: 'Сессия сохранена', message: `Аккаунт «${a.name}». Переименовать можно в окне Multipass.` }); break; }
    case 'mp-update': await accounts.saveActive(tab.id); notify({ title: 'Сессия обновлена', message: 'Текущие куки сохранены в активный аккаунт' }); break;
    case 'mp-next': { const r = await accounts.nextAccount(tab.id); notify({ title: 'Аккаунт переключён', message: r.name }); break; }
    case 'mp-clean': await accounts.cleanLogin(tab.id, {}); break;
    case 'mp-dash': case 'mp-a-dash': chrome.runtime.openOptionsPage(); break;
    case 'mp-a-toggle': { const s = await proxy.toggle(); notify({ title: 'Прокси', message: s.mode === 'off' ? 'Выключен' : 'Включён' }); break; }
    case 'mp-a-check': { const r = await proxy.check(null); notify({ title: 'Проверка прокси', message: `Живых: ${r.alive} из ${r.total}` }); break; }
    case 'mp-a-sync': { await sync.syncNow({ reason: 'manual' }); notify({ title: 'Синхронизация', message: 'Готово' }); break; }
    case 'mp-a-lock': await vault.lock(); break;
  }
}

async function onCommand(cmd, tab) {
  if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const host = safeUrl(tab?.url)?.hostname || '';
  if (cmd === 'next-account') { const r = await accounts.nextAccount(tab.id); notify({ title: 'Аккаунт', message: r.name, quiet: true }); }
  if (cmd === 'rotate-proxy') { const p = await proxy.rotate({ host }); notify({ title: 'Прокси сменён', message: `${p.name}${p.status?.ip ? ' · ' + p.status.ip : ''}` }); }
  if (cmd === 'toggle-proxy') { const s = await proxy.toggle(); notify({ title: 'Прокси', message: s.mode === 'off' ? 'Выключен' : 'Включён' }); }
  if (cmd === 'clean-login') await accounts.cleanLogin(tab.id, {});
}

// Открыть панель управления на нужном разделе, переиспользуя уже открытую вкладку
export async function openDashboard(section = '') {
  const base = chrome.runtime.getURL('ui/dashboard.html');
  const url = base + (section ? '#' + section : '');
  const tab = (await chrome.tabs.query({})).find((t) => (t.url || t.pendingUrl || '').startsWith(base));
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true, ...(section ? { url } : {}) });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  } else await chrome.tabs.create({ url });
}

export async function notify({ id = '', title, message }) {
  const c = await initDb();
  if (!c.settings.notifications) return;
  try {
    await chrome.notifications.create(id ? 'mp-' + id : '', { type: 'basic', iconUrl: chrome.runtime.getURL('icons/128.png'), title: String(title), message: String(message || ''), priority: 0 });
  } catch (e) { log.warn('Уведомление: ' + e.message); }
}
