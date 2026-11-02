// Панель управления Multipass: навигация, загрузка данных, живое обновление
import { rpc, h, fill, icon, btn, toast, showError, initTheme, applyTheme, onStoreChange, unlockDialog, plural } from './common.js';
import { S, setHooks } from './dash/state.js';
import accounts from './dash/accounts.js';
import proxies from './dash/proxies.js';
import routing from './dash/routing.js';
import sync, { folderBanner } from './dash/sync.js';
import transfer from './dash/transfer.js';
import security from './dash/security.js';
import settings from './dash/settings.js';
import logView from './dash/log.js';
import help from './dash/help.js';

const SECTIONS = [accounts, proxies, routing, sync, transfer, security, settings, logView, help];
const ALIAS = { welcome: 'help' };
const nav = document.getElementById('nav');
const view = document.getElementById('view');
const main = document.getElementById('main');
const bannerBox = document.getElementById('banner');
let pending = false;
let lastId = null;

const currentId = () => { const id = location.hash.slice(1).split('?')[0] || 'accounts'; return SECTIONS.some((s) => s.id === (ALIAS[id] || id)) ? (ALIAS[id] || id) : 'accounts'; };
const section = () => SECTIONS.find((s) => s.id === currentId());

function renderBanner() {
  // вне #view: обновляется при любом изменении данных, не перерисовывая раздел
  fill(bannerBox, currentId() !== 'sync' ? folderBanner(S.D) : null);
}

function renderNav() {
  renderBanner();
  const D = S.D, id = currentId();
  const accN = D.sites.reduce((n, s) => n + s.accounts.length, 0);
  const counts = { accounts: accN || '', proxies: D.proxy.counts.total || '', routing: D.rules.length || '', log: '' };
  const links = SECTIONS.map((s) => {
    const dead = s.id === 'proxies' && D.proxy.counts.dead;
    return h('a', { class: 'nv' + (s.id === id ? ' on' : ''), href: '#' + s.id }, icon(s.icon), s.title,
      s.id === 'sync' && D.sync.provider ? h('span', { class: 'cnt' + (D.sync.lastError ? ' bad' : '') }, D.sync.needsPermission ? 'нет доступа' : D.sync.folderMissing ? 'нет папки' : D.sync.lastError ? 'ошибка' : 'вкл')
        : s.id === 'security' && D.vault.enabled ? h('span', { class: 'cnt' }, D.vault.locked ? '🔒' : 'вкл')
          : counts[s.id] ? h('span', { class: 'cnt row', style: { gap: '5px' }, title: dead ? `Не отвечают: ${dead}` : null }, dead ? h('span', { class: 'dot bad' }) : null, counts[s.id]) : null);
  });
  fill(nav,
    h('div', { class: 'brand' }, h('img', { class: 'logo', src: '../icons/128.png', alt: '' }), h('div', null, h('b', null, 'Multipass'), h('span', { class: 'tiny faint' }, 'v' + chrome.runtime.getManifest().version))),
    links,
    h('div', { class: 'nfoot' },
      h('div', { class: 'row' }, icon('monitor', 'sm'), h('span', { class: 'ellipsis', title: 'Имя этого браузера для синхронизации' }, D.device.name)),
      D.proxy.state.mode !== 'off' ? h('div', { class: 'row' }, icon('globe', 'sm'), h('span', null, D.proxy.state.mode === 'global' ? 'Прокси: весь браузер' : 'Прокси: по правилам')) : h('div', { class: 'row faint' }, icon('globe', 'sm'), 'Прокси выключены'),
      D.vault.enabled ? btn(D.vault.locked ? 'Разблокировать' : 'Заблокировать', { size: 'sm', icon: D.vault.locked ? 'unlock' : 'lock', onClick: async () => { if (D.vault.locked) await unlockDialog(); else { await rpc('vault.lock'); toast('Хранилище заблокировано', 'info'); } } }) : null));
}

function isEditing() {
  const a = document.activeElement;
  return !!a && view.contains(a) && (a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || (a.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes(a.type)));
}

function render() {
  if (!S.D) return;
  pending = false;
  renderNav();
  const sec = section();
  const same = lastId === sec.id;
  const scroll = same ? main.scrollTop : 0;
  lastId = sec.id;
  let body;
  try { body = sec.render(S.D); } catch (e) { console.error(e); body = h('div', { class: 'note bad' }, 'Ошибка отрисовки: ' + e.message); }
  fill(view,
    h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', null, sec.title), sec.desc ? h('p', null, sec.desc(S.D)) : null), sec.actions ? h('div', { class: 'row wrap' }, sec.actions(S.D)) : null),
    body);
  main.scrollTop = scroll;
  document.title = `${sec.title} — Multipass`;
}

async function reload({ section: withSection = true } = {}) {
  try { S.D = await rpc('data'); }
  catch (e) { fill(view, h('div', { class: 'empty' }, h('div', { class: 'big' }, icon('alert')), h('h4', null, 'Не удалось загрузить данные'), h('p', null, e.message))); return; }
  applyTheme(S.D.settings.theme);
  if (!withSection) { renderNav(); return; }
  if (isEditing()) { pending = true; renderNav(); return; }
  render();
}

setHooks({ render, reload });
view.addEventListener('focusout', () => setTimeout(() => { if (pending && !isEditing()) render(); }, 120));
window.addEventListener('hashchange', () => { render(); });

(async () => {
  await initTheme();
  await reload();
  onStoreChange((keys) => {
    const sec = section();
    const ks = [...keys];
    if (ks.every((k) => k === 'log') && sec.id !== 'log') return;
    const need = !sec.live || ks.some((k) => sec.live.includes(k));
    reload({ section: need }).catch(showError);
  }, { log: true });
})().catch(showError);
