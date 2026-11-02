// Общие помощники интерфейса: RPC к service worker, DOM-конструктор (без innerHTML), модальные окна, форматирование
import { ago, until, plural, bytes, initials, PALETTE } from '../src/shared/util.js';
import { describeError } from '../src/shared/netErrors.js';
export { ago, until, plural, bytes, initials, PALETTE, describeError };

// ---------- RPC ----------
export async function rpc(type, payload = {}) {
  let r;
  try { r = await chrome.runtime.sendMessage({ type, payload }); }
  catch (e) { throw Object.assign(new Error('Фоновый процесс недоступен: ' + e.message), { code: 'NOBG' }); }
  if (!r) throw new Error('Нет ответа от фонового процесса — перезагрузите расширение');
  if (!r.ok) throw Object.assign(new Error(r.error || 'Ошибка'), { code: r.code });
  return r.res;
}
// То же, но при заблокированном хранилище спрашиваем мастер-пароль и повторяем
export async function api(type, payload = {}) {
  try { return await rpc(type, payload); }
  catch (e) {
    if (e.code !== 'LOCKED') throw e;
    if (!(await unlockDialog())) throw Object.assign(new Error('Хранилище заблокировано'), { code: 'LOCKED', silent: true });
    return rpc(type, payload);
  }
}

// ---------- DOM ----------
const SVGNS = 'http://www.w3.org/2000/svg';
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  let value;
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') value = v;
    else if (['checked', 'selected', 'disabled', 'readOnly', 'multiple', 'indeterminate', 'spellcheck'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  add(el, kids);
  if (value !== undefined) el.value = value;
  return el;
}
export function add(el, kids) {
  for (const k of [kids].flat(Infinity)) { if (k == null || k === false || k === true) continue; el.append(k instanceof Node ? k : String(k)); }
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);
// replaceChildren, но null/false/массивы допустимы (replaceChildren(null) вставил бы текст «null»)
export function fill(el, ...kids) { el.replaceChildren(); return add(el, kids); }

const ICONS = {
  plus: 'M12 5v14M5 12h14', x: 'M18 6 6 18M6 6l12 12', check: 'M20 6 9 17l-5-5',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  refresh: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5', sync: 'M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.2L3 16M3 21v-5h5',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6', edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  more: 'M5 12h.01M12 12h.01M19 12h.01', copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  download: 'M12 3v12M7 10l5 5 5-5M5 21h14', upload: 'M12 15V3M7 8l5-5 5 5M5 21h14',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4', unlock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 7.5-2',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', user: 'M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
  users: 'M17 21a6 6 0 0 0-12 0M11 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21a5 5 0 0 0-4-5M16 3.5a4 4 0 0 1 0 7.5',
  userplus: 'M16 21a6 6 0 0 0-12 0M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM19 8v6M22 11h-6',
  swap: 'M8 3 4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4', key: 'M2 18v3h3l7.4-7.4A5.5 5.5 0 1 0 9.4 10.6L2 18zM16.5 7.5h.01',
  cookie: 'M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5zM8.5 8.5h.01M16 15.5h.01M12 12h.01M11 17h.01M7 14h.01',
  zap: 'M13 2 3 14h9l-1 8 10-12h-9z', alert: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01', cloud: 'M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 1 1 0 9z',
  external: 'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6', server: 'M3 4h18v6H3zM3 14h18v6H3zM7 7h.01M7 17h.01',
  star: 'M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z', clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  layers: 'M12 2 2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5', route: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
  help: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01', list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  up: 'M12 19V5M5 12l7-7 7 7', down: 'M12 5v14M19 12l-7 7-7-7', eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  save: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8', power: 'M12 2v10M18.4 6.6a9 9 0 1 1-12.8 0',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2', link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  monitor: 'M3 4h18v12H3zM8 20h8M12 16v4', folder: 'M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z', file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  transfer: 'M7 17 3 13l4-4M3 13h13a5 5 0 0 0 0-10h-1M17 7l4 4-4 4', ban: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM4.9 4.9l14.2 14.2',
  wifioff: 'M2 2l20 20M8.5 16.5a5 5 0 0 1 7 0M2 8.8a15 15 0 0 1 4.2-2.7M10.7 5.1A15 15 0 0 1 22 8.8M5 12.9a10 10 0 0 1 5.2-2.8M19 12.9a10 10 0 0 0-2.4-1.7M12 20h.01',
  login: 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3', home: 'M3 10 12 3l9 7v11H3zM9 21v-6h6v6',
  chev: 'M9 6l6 6-6 6', dot: 'M12 12h.01', play: 'M6 4l14 8-14 8z', pin: 'M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
};
export function icon(name, cls = '') {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', ('i ' + cls).trim());
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVGNS, 'path');
  p.setAttribute('d', ICONS[name] || ICONS.dot);
  svg.append(p);
  return svg;
}
export function btn(label, { icon: ic, kind = '', title, onClick, size = '', disabled, type = 'button', id } = {}) {
  const cls = ['btn', kind, size, !label && ic ? 'icon' : ''].filter(Boolean).join(' ');
  const b = h('button', { class: cls, type, title: title || (label ? null : null), 'aria-label': title || null, disabled, id }, ic ? icon(ic, size === 'sm' ? 'sm' : '') : null, label || null);
  if (onClick) b.addEventListener('click', (e) => { e.stopPropagation(); busy(b, () => onClick(e, b)); });
  return b;
}
export function toggle(checked, onChange, { disabled } = {}) {
  const input = h('input', { type: 'checkbox', checked: !!checked, disabled });
  input.addEventListener('change', () => onChange(input.checked, input));
  return h('label', { class: 'switch' }, input, h('span'));
}
export function seg(options, value, onChange, { block = false } = {}) {
  const wrap = h('div', { class: 'seg' + (block ? ' block' : ''), role: 'tablist' });
  for (const o of options) {
    const b = h('button', { type: 'button', class: o.value === value ? 'on' : '', title: o.title || null, role: 'tab' }, o.icon ? icon(o.icon, 'sm') : null, o.label);
    b.addEventListener('click', () => { if (o.value !== value) busy(b, () => onChange(o.value)); });
    wrap.append(b);
  }
  return wrap;
}

// ---------- Оверлей: тосты, меню, модальные окна ----------
function overlay() {
  let o = document.getElementById('mp-overlay');
  if (!o) { o = h('div', { id: 'mp-overlay' }); document.body.append(o); }
  return o;
}
let toastBox = null;
export function toast(msg, kind = 'ok', ms = 3400) {
  if (!toastBox || !toastBox.isConnected) { toastBox = h('div', { class: 'toasts' }); document.body.append(toastBox); }
  const ic = { ok: 'check', bad: 'alert', warn: 'alert', info: 'info' }[kind] || 'info';
  const t = h('div', { class: 'toast ' + kind, role: 'status' }, icon(ic), h('div', { class: 't-body' }, msg));
  toastBox.append(t);
  const kill = () => { t.style.transition = 'opacity .2s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 200); };
  setTimeout(kill, kind === 'bad' ? Math.max(ms, 6000) : ms);
  t.addEventListener('click', kill);
  return t;
}
export function showError(e) { if (!e?.silent) toast(e?.message || String(e), 'bad'); }

// Кнопка в состоянии «занято» на время асинхронного действия; ошибки — тостом
export async function busy(el, fn) {
  if (el?.classList.contains('busy')) return;
  el?.classList.add('busy');
  try { return await fn(); }
  catch (e) { showError(e); }
  finally { el?.classList.remove('busy'); }
}

let openMenu = null;
export function menu(anchor, items) {
  closeMenu();
  const m = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === 'sep') { m.append(h('hr')); continue; }
    if (it.header) { m.append(h('div', { class: 'mlabel' }, it.header)); continue; }
    const b = h('button', { type: 'button', class: it.danger ? 'danger' : '', role: 'menuitem', disabled: it.disabled }, it.icon ? icon(it.icon) : null, h('span', { class: 'grow ellipsis' }, it.label), it.hint ? h('span', { class: 'faint small' }, it.hint) : null);
    b.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); Promise.resolve().then(it.onClick).catch(showError); });
    m.append(b);
  }
  overlay().append(m);
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let left = Math.min(r.right - mw, window.innerWidth - mw - 6); if (left < 6) left = 6;
  let top = r.bottom + 4; if (top + mh > window.innerHeight - 6) top = Math.max(6, r.top - mh - 4);
  Object.assign(m.style, { left: left + 'px', top: top + 'px' });
  const away = (e) => { if (!m.contains(e.target)) closeMenu(); };
  const esc = (e) => { if (e.key === 'Escape') closeMenu(); };
  setTimeout(() => { document.addEventListener('mousedown', away, true); document.addEventListener('keydown', esc, true); });
  openMenu = { m, off: () => { document.removeEventListener('mousedown', away, true); document.removeEventListener('keydown', esc, true); } };
  return m;
}
export function closeMenu() { if (openMenu) { openMenu.off(); openMenu.m.remove(); openMenu = null; } }

// modal({ title, body, actions:[{label, kind, onClick(close) → false = не закрывать}], wide })
export function modal({ title, body, actions = [], wide = false, onClose, icon: ic } = {}) {
  closeMenu();
  const bd = h('div', { class: 'backdrop' });
  const box = h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' });
  let closed = false;
  const close = (v) => {
    if (closed) return; closed = true;
    bd.remove(); document.removeEventListener('keydown', onKey, true);
    onClose?.(v);
  };
  const footer = h('footer');
  let primary = null;
  for (const a of actions) {
    const b = h('button', { type: 'button', class: 'btn ' + (a.kind || '') }, a.icon ? icon(a.icon) : null, a.label);
    b.addEventListener('click', () => busy(b, async () => { const r = await a.onClick?.(close); if (r !== false) close(r); }));
    if (a.kind?.includes('primary') || a.kind?.includes('dangerfill')) primary = b;
    footer.append(b);
  }
  box.append(h('header', null, ic ? icon(ic, 'lg') : null, h('h3', null, title || ''), h('button', { class: 'btn ghost icon sm', type: 'button', 'aria-label': 'Закрыть', onClick: () => close(null) }, icon('x', 'sm'))));
  box.append(add(h('div', { class: 'body' }), body));
  if (actions.length) box.append(footer);
  bd.append(box);
  bd.addEventListener('mousedown', (e) => { if (e.target === bd) bd.dataset.down = '1'; });
  bd.addEventListener('mouseup', (e) => { if (e.target === bd && bd.dataset.down) close(null); delete bd.dataset.down; });
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(null); }
    if (e.key === 'Enter' && primary && e.target.tagName === 'INPUT' && box.contains(e.target)) { e.preventDefault(); primary.click(); }
  };
  document.addEventListener('keydown', onKey, true);
  overlay().append(bd);
  setTimeout(() => (box.querySelector('[autofocus]') || box.querySelector('.body input:not([type=checkbox]), .body textarea, .body select'))?.focus(), 30);
  return { close, el: box };
}
export function confirmDialog({ title, text, ok = 'Удалить', danger = true } = {}) {
  return new Promise((resolve) => {
    modal({ title, body: h('p', { class: 'muted' }, text || ''), onClose: (v) => resolve(v === true),
      actions: [{ label: 'Отмена', onClick: () => null }, { label: ok, kind: danger ? 'dangerfill' : 'primary', onClick: () => true }] });
  });
}
export function promptDialog({ title, label, value = '', placeholder = '', type = 'text', hint = '', ok = 'Сохранить', multiline = false } = {}) {
  return new Promise((resolve) => {
    const input = multiline ? h('textarea', { class: 'input', placeholder, value, rows: 6 }) : h('input', { class: 'input', type, placeholder, value, autofocus: true });
    modal({ title, body: field(label, input, hint), onClose: (v) => resolve(typeof v === 'string' ? v : null),
      actions: [{ label: 'Отмена', onClick: () => null }, { label: ok, kind: 'primary', onClick: () => input.value }] });
  });
}
export function field(label, control, hintText) {
  return h('div', { class: 'field' }, label ? h('label', null, label) : null, control, hintText ? h('div', { class: 'hint' }, hintText) : null);
}
export function note(kind, ic, ...content) { return h('div', { class: 'note ' + kind }, icon(ic), h('div', { class: 'grow' }, ...content)); }

let unlocking = null;
export function unlockDialog() {
  if (unlocking) return unlocking;
  unlocking = new Promise((resolve) => {
    const input = h('input', { class: 'input', type: 'password', placeholder: 'Мастер-пароль', autocomplete: 'current-password', autofocus: true });
    modal({ title: 'Хранилище заблокировано', icon: 'lock',
      body: [h('p', { class: 'muted small' }, 'Сохранённые сессии зашифрованы. Введите мастер-пароль, чтобы продолжить.'), input],
      onClose: (v) => { unlocking = null; resolve(v === true); },
      actions: [{ label: 'Отмена', onClick: () => null }, { label: 'Разблокировать', kind: 'primary', icon: 'unlock', onClick: async () => { await rpc('vault.unlock', { password: input.value }); return true; } }] });
  });
  return unlocking;
}

// ---------- Файлы и буфер обмена ----------
export function download(text, filename, mime = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type: mime + ';charset=utf-8' }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' }, value: text });
    document.body.append(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove();
    if (!ok) throw new Error('Не удалось скопировать');
    return true;
  }
}
export function pickFile(accept = '') {
  return new Promise((resolve, reject) => {
    const inp = h('input', { type: 'file', accept, style: { display: 'none' } });
    inp.addEventListener('change', () => {
      const f = inp.files?.[0]; inp.remove();
      if (!f) return resolve(null);
      if (f.size > 20 * 1024 * 1024) return reject(new Error('Файл слишком большой'));
      f.text().then((t) => resolve({ name: f.name, text: t }), reject);
    });
    document.body.append(inp); inp.click();
  });
}

// ---------- Тема и живое обновление ----------
export function applyTheme(theme) {
  const dark = theme === 'dark' || (theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
export async function initTheme() {
  const { settings } = await chrome.storage.local.get('settings');
  applyTheme(settings?.theme || 'auto');
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', async () => { const r = await chrome.storage.local.get('settings'); applyTheme(r.settings?.theme || 'auto'); });
}
const WATCH = new Set(['sites', 'accounts', 'sessIndex', 'proxies', 'proxyStatus', 'rules', 'devices', 'settings', 'proxyState', 'syncConfig', 'vaultMeta', 'local']);
export function onStoreChange(cb, { log = false, delay = 160 } = {}) {
  let t = null, keys = new Set();
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'session') { keys.add('session'); }
    else if (area !== 'local') return;
    for (const k of Object.keys(ch)) if (WATCH.has(k) || (log && k === 'log')) keys.add(k);
    if (!keys.size) return;
    clearTimeout(t);
    t = setTimeout(() => { const k = keys; keys = new Set(); cb(k); }, delay);
  });
}

// ---------- Форматирование ----------
export const TYPE_LABEL = { auto: 'Авто', http: 'HTTP', https: 'HTTPS', socks5: 'SOCKS5', socks4: 'SOCKS4' };
let regionNames = null;
export function countryName(cc) {
  if (!cc) return '';
  try { regionNames ||= new Intl.DisplayNames(['ru'], { type: 'region' }); return regionNames.of(cc) || cc; } catch { return cc; }
}
export function ccPill(st) {
  if (!st?.cc) return null;
  return h('span', { class: 'pill cc', title: [countryName(st.cc), st.city, st.isp].filter(Boolean).join(' · ') }, st.cc);
}
export function statusDot(st) {
  const cls = st?.checking ? 'checking' : st?.state === 'alive' ? 'ok' : st?.state === 'dead' ? 'bad' : '';
  const t = st?.checking ? 'Проверяется…' : st?.state === 'alive' ? `Работает · ${st.latency} мс` : st?.state === 'dead' ? `Не отвечает: ${describeError(st.error)}` : 'Не проверен';
  return h('span', { class: 'dot ' + cls, title: t });
}
export function latencyText(st) {
  if (!st) return '—';
  if (st.checking) return 'проверка…';
  if (st.state === 'alive') return `${st.latency} мс`;
  if (st.state === 'dead') return describeError(st.error) || 'не отвечает';
  return 'не проверен';
}
export function proxyName(p) { return p ? (p.name || `${p.host}:${p.port}`) : 'удалённый прокси'; }
export function targetLabel(target, proxies = []) {
  if (!target) return 'Как обычно';
  if (target === 'direct') return 'Напрямую';
  if (target === 'block') return 'Блокировать';
  if (target.startsWith('group:')) return `Группа «${target.slice(6)}»`;
  if (target.startsWith('proxy:')) return proxyName(proxies.find((p) => p.id === target.slice(6)));
  return target;
}
// Селект цели маршрута: прокси/группы/напрямую/блок
export function targetSelect({ value = null, proxies = [], groups = [], none = 'Без прокси', direct = false, block = false, cls = 'input', onChange } = {}) {
  const sel = h('select', { class: cls });
  if (none != null) sel.append(h('option', { value: '' }, none));
  if (direct) sel.append(h('option', { value: 'direct' }, 'Напрямую (без прокси)'));
  if (block) sel.append(h('option', { value: 'block' }, 'Блокировать'));
  if (groups.length) {
    const og = h('optgroup', { label: 'Группы — лучший живой прокси, авто-резерв' });
    for (const g of groups) {
      const inG = proxies.filter((p) => p.group === g);
      og.append(h('option', { value: 'group:' + g }, `${g}  (${inG.filter((p) => p.status?.state === 'alive').length}/${inG.length} живы)`));
    }
    sel.append(og);
  }
  if (proxies.length) {
    const og = h('optgroup', { label: 'Прокси' });
    for (const p of proxies) {
      const st = p.status;
      const mark = st?.state === 'alive' ? '● ' : st?.state === 'dead' ? '✕ ' : '○ ';
      const extra = st?.state === 'alive' ? `  ${st.cc || ''} ${st.latency} мс` : st?.state === 'dead' ? '  — не отвечает' : '';
      og.append(h('option', { value: 'proxy:' + p.id }, mark + proxyName(p) + extra));
    }
    sel.append(og);
  }
  if (value && ![...sel.options].some((o) => o.value === value)) sel.append(h('option', { value }, targetLabel(value, proxies) + ' (нет в списке)'));
  sel.value = value || '';
  if (onChange) sel.addEventListener('change', () => busy(sel, () => onChange(sel.value || null)));
  return sel;
}
export function favicon(url, cls = 'fav') {
  const src = chrome.runtime.getURL('/_favicon/') + '?pageUrl=' + encodeURIComponent(url) + '&size=32';
  return h('img', { class: cls, src, alt: '', loading: 'lazy' });
}
export function avatar(a, { sm = false, online = false } = {}) {
  return h('div', { class: 'avatar' + (sm ? ' sm' : ''), style: { background: a.color || '#6366f1' }, title: a.name }, initials(a.name), online ? h('span', { class: 'on' }) : null);
}
export function expiryInfo(sess) {
  const t = sess?.authExpiresAt || null;
  if (!t) return null;
  const left = t - Date.now();
  if (left <= 0) return { kind: 'bad', text: 'вход истёк', title: 'Куки авторизации истекли — войдите заново и обновите сессию' };
  if (left < 3 * 86400e3) return { kind: 'warn', text: `истекает через ${until(t)}`, title: new Date(t).toLocaleString('ru-RU') };
  return { kind: '', text: `ещё ${until(t)}`, title: 'Куки авторизации действуют до ' + new Date(t).toLocaleString('ru-RU') };
}
export function sessionLine(a, { expiry = true } = {}) {
  const s = a.session;
  if (!s) return [h('span', { class: 'warnc' }, 'сессия не сохранена')];
  const parts = [h('span', { title: new Date(s.at).toLocaleString('ru-RU') + (s.browser ? ' · ' + s.browser : '') }, 'сохр. ' + ago(s.at))];
  parts.push(h('span', { class: 'faint' }, '·'), h('span', null, `${s.cookies} ${plural(s.cookies, 'куки', 'куки', 'куки')}`));
  const ex = expiry ? expiryInfo(s) : null;
  if (ex) parts.push(h('span', { class: 'faint' }, '·'), h('span', { class: ex.kind === 'bad' ? 'badc' : ex.kind === 'warn' ? 'warnc' : '', title: ex.title }, ex.text));
  return parts;
}
export function expiryLine(a) {
  const ex = a.session ? expiryInfo(a.session) : null;
  return ex ? h('div', { class: 'meta' }, h('span', { class: ex.kind === 'bad' ? 'badc' : ex.kind === 'warn' ? 'warnc' : 'faint', title: ex.title }, ex.text)) : null;
}
export function tzOffsetMin(tz) {
  try {
    const d = new Date();
    const a = new Date(d.toLocaleString('en-US', { timeZone: tz }));
    const b = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
    return Math.round((a - b) / 60000);
  } catch { return null; }
}
export const browserTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
export function tzMismatch(ipTz) {
  if (!ipTz) return null;
  const mine = browserTz();
  const a = tzOffsetMin(ipTz), b = tzOffsetMin(mine);
  if (a == null || b == null || a === b) return null;
  return { mine, ip: ipTz };
}

// ---------- Редактор аккаунта (общий для окна и панели) ----------
export function editAccountDialog(a, { proxies = [], groups = [], sites = [] } = {}) {
  return new Promise((resolve) => {
    let color = a.color || PALETTE[0];
    const name = h('input', { class: 'input', value: a.name || '', maxlength: 80, autofocus: true });
    const sw = h('div', { class: 'swatches' });
    const drawSw = () => sw.replaceChildren(...PALETTE.map((c) => {
      const s = h('div', { class: 'swatch' + (c === color ? ' on' : ''), style: { background: c }, title: c, role: 'radio', tabindex: 0 });
      s.addEventListener('click', () => { color = c; drawSw(); });
      return s;
    }));
    drawSw();
    const px = targetSelect({ value: a.proxy, proxies, groups, none: 'Без прокси (как в остальном браузере)', direct: true, block: false });
    const notes = h('textarea', { class: 'input', rows: 3, value: a.note || '', style: { fontFamily: 'var(--font)', fontSize: '13px', minHeight: '60px' }, placeholder: 'Логин, назначение, напоминания…' });
    const tags = h('input', { class: 'input', value: (a.tags || []).join(', '), placeholder: 'работа, реклама, фарм' });
    const start = h('input', { class: 'input', value: a.startUrl || '', placeholder: 'https://… (страница после переключения)' });
    const fav = h('input', { type: 'checkbox', checked: !!a.fav });
    let siteSel = null;
    if (sites.length > 1) {
      siteSel = h('select', { class: 'input' }, sites.map((s) => h('option', { value: s.id }, s.name)));
      siteSel.value = a.siteId;
    }
    modal({
      title: 'Аккаунт', icon: 'user',
      body: [
        field('Название', name),
        field('Цвет метки', sw),
        field('Прокси для этого аккаунта', px, 'Пока аккаунт активен, весь сайт открывается через выбранный прокси. Группа — автоматически берёт лучший живой прокси.'),
        h('div', { class: 'grid2' }, field('Теги', tags), field('Стартовая страница', start)),
        field('Заметка', notes),
        siteSel ? field('Сайт', siteSel) : null,
        h('label', { class: 'check' }, fav, 'Закрепить вверху списка'),
      ],
      onClose: (v) => resolve(v && typeof v === 'object' ? v : null),
      actions: [
        { label: 'Отмена', onClick: () => null },
        { label: 'Сохранить', kind: 'primary', onClick: async () => {
          const patch = { name: name.value, color, proxy: px.value || null, note: notes.value.trim(), tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean),
            startUrl: start.value.trim(), fav: fav.checked };
          if (siteSel) patch.siteId = siteSel.value;
          if (patch.startUrl && !/^https?:\/\//i.test(patch.startUrl)) throw new Error('Стартовая страница должна начинаться с http(s)://');
          return api('acct.update', { id: a.id, patch });
        } },
      ],
    });
  });
}
