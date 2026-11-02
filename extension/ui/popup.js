// Окно расширения: сайты → их аккаунты (текущий сайт сверху), прокси, редактор куки
import {
  rpc, api, h, add, fill, icon, btn, seg, toast, showError, busy, menu, modal, confirmDialog, field, note, unlockDialog,
  copyText, download, initTheme, onStoreChange, favicon, avatar, sessionLine, expiryLine, targetSelect, targetLabel, proxyName,
  statusDot, ccPill, latencyText, countryName, tzMismatch, editAccountDialog, plural, ago, describeError,
} from './common.js';

const qs = new URLSearchParams(location.search);
const FORCED_TAB = qs.get('tab') ? +qs.get('tab') : null;
const IS_POPUP = !FORCED_TAB;
let tabId = FORCED_TAB;
let ctx = null;
let current = ['accounts', 'proxy', 'cookies'].includes(qs.get('view')) ? qs.get('view') : (localStorage.getItem('mp.view') || 'accounts');
let panel = null;
const main = document.getElementById('main');
const bar = document.getElementById('bar');

const openDashboard = (hash = '') => {
  chrome.tabs.create({ url: chrome.runtime.getURL('ui/dashboard.html' + (hash ? '#' + hash : '')) });
  if (IS_POPUP) window.close();
};

async function init() {
  if (!IS_POPUP) document.body.classList.add('page');
  await initTheme();
  if (!tabId) { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); tabId = t?.id ?? null; }
  await reload();
  if (ctx?.sync?.provider) rpc('sync.poke').catch(() => {}); // подтянуть изменения из других браузеров
  onStoreChange(() => reload().catch(() => {}));
  chrome.tabs.onUpdated.addListener((id, info) => { if (id === tabId && (info.url || info.status === 'complete')) reload().catch(() => {}); });
  let ckTimer = null;
  chrome.cookies.onChanged.addListener(() => { clearTimeout(ckTimer); ckTimer = setTimeout(() => { if (panel?.name === 'cookies') panel.update(); }, 300); });
}

async function reload() {
  try { ctx = await rpc('ctx', { tabId }); }
  catch (e) { fill(main, h('div', { class: 'empty' }, h('div', { class: 'big' }, icon('alert')), h('h4', null, 'Не удалось связаться с фоном'), h('p', { class: 'small' }, e.message))); return; }
  renderHeader(); renderTabs(); renderFooter();
  if (!panel || panel.name !== current) mountPanel(); else panel.update();
}

function mountPanel() {
  panel = { accounts: AccountsPanel, proxy: ProxyPanel, cookies: CookiesPanel }[current]();
  fill(main, panel.el);
  main.scrollTop = 0;
  panel.update();
}

// ---------- Шапка, вкладки, подвал ----------
function renderHeader() {
  const hdr = document.getElementById('hdr');
  const site = ctx.site;
  const lockBtn = ctx.vault.enabled
    ? btn('', { icon: ctx.vault.locked ? 'unlock' : 'lock', kind: 'ghost', title: ctx.vault.locked ? 'Разблокировать хранилище' : 'Заблокировать хранилище',
      onClick: async () => { if (ctx.vault.locked) await unlockDialog(); else { await rpc('vault.lock'); toast('Хранилище заблокировано', 'info'); } } })
    : null;
  fill(hdr,
    ctx.supported ? favicon(ctx.tab.url, 'fav lg') : h('img', { class: 'logo', src: '../icons/48.png', alt: '' }),
    h('div', { class: 'grow col', style: { gap: '0' } },
      h('div', { class: 'title' }, h('span', { class: 'ellipsis' }, ctx.supported ? ctx.host : 'Multipass'), ctx.tab?.incognito ? h('span', { class: 'pill' }, 'инкогнито') : null),
      h('div', { class: 'sub ellipsis' }, ctx.supported
        ? `${site?.name || ''} · ${ctx.accounts.length} ${plural(ctx.accounts.length, 'аккаунт', 'аккаунта', 'аккаунтов')}`
        : `${ctx.totalAccounts} ${plural(ctx.totalAccounts, 'аккаунт', 'аккаунта', 'аккаунтов')} · ${ctx.proxy.counts.total} прокси`)),
    lockBtn,
    btn('', { icon: 'sliders', kind: 'ghost', title: 'Панель управления', onClick: () => openDashboard(current === 'proxy' ? 'proxies' : current === 'accounts' ? 'accounts' : '') }),
  );
}

function renderTabs() {
  const nav = document.getElementById('tabs');
  const r = ctx.route;
  const pxDot = ctx.proxy.state.mode === 'off' ? null
    : h('span', { class: 'dot ' + (r?.status?.state === 'dead' || ['block', 'empty-group', 'missing'].includes(r?.kind) ? 'bad' : r?.proxy ? 'ok' : '') });
  const tabs = [
    { id: 'accounts', label: 'Аккаунты', extra: ctx.accounts.length ? h('span', { class: 'count' }, ctx.accounts.length) : null, ic: 'users' },
    { id: 'proxy', label: 'Прокси', extra: pxDot, ic: 'globe' },
    { id: 'cookies', label: 'Куки', ic: 'cookie' },
  ];
  fill(nav, ...tabs.map((t) => {
    const b = h('button', { type: 'button', class: t.id === current ? 'on' : '' }, icon(t.ic, 'sm'), t.label, t.extra);
    b.addEventListener('click', () => { if (current === t.id) return; current = t.id; localStorage.setItem('mp.view', current); renderTabs(); mountPanel(); });
    return b;
  }));
}

function renderFooter() {
  const f = document.getElementById('foot');
  const s = ctx.sync;
  if (!s.provider) {
    fill(f, icon('cloud', 'sm'), h('span', { class: 'grow' }, 'Синхронизация выключена'), h('a', { href: '#', onClick: (e) => { e.preventDefault(); openDashboard('sync'); } }, 'Настроить'));
    return;
  }
  if (s.needsPermission || s.folderMissing) {
    fill(f, icon('folder', 'sm warnc'),
      h('span', { class: 'grow ellipsis warnc', title: s.lastError || '' }, s.needsPermission ? 'Нужен доступ к папке синхронизации' : 'Папка синхронизации не найдена'),
      h('a', { href: '#', onClick: (e) => { e.preventDefault(); openDashboard('sync'); } }, s.needsPermission ? 'Разрешить' : 'Выбрать'));
    return;
  }
  const errTxt = s.lastError;
  fill(f,
    s.running ? h('span', { class: 'spinner' }) : icon(s.provider === 'folder' ? 'folder' : 'cloud', 'sm' + (errTxt ? ' badc' : '')),
    h('span', { class: 'grow ellipsis', title: errTxt || (s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString('ru-RU') : '') },
      errTxt ? h('span', { class: 'badc' }, 'Ошибка: ' + errTxt) : `${s.label} · ${s.lastSyncAt ? ago(s.lastSyncAt) : 'ещё не было'}${s.devices.length ? ` · ${s.devices.length + 1} ${plural(s.devices.length + 1, 'браузер', 'браузера', 'браузеров')}` : ''}`),
    btn('', { icon: 'sync', kind: 'ghost', size: 'sm', title: 'Синхронизировать сейчас', onClick: async () => { const r = await api('sync.now'); toast(r.pulled ? `Получено изменений: ${r.pulled}` : 'Синхронизировано'); } }),
  );
}

// ---------- Аккаунты ----------
// Временные (сеансовые) куки в сохранённой сессии — подсказка, что Multipass их закрепляет
function tempPill(a, site = null) {
  const n = a.session?.temp || 0;
  if (!n) return null;
  const on = site?.opts?.pinSession ?? (ctx.settings.pinSessionCookies !== false);
  return h('span', { class: 'pill' + (on ? '' : ' warn'), title: `Временных куки в сессии: ${n}. Браузер стирает их при закрытии. ` + (on ? 'Multipass закрепляет их, пока аккаунт активен, — вход переживёт перезапуск.' : 'Закрепление выключено (в настройках или для этого сайта) — после перезапуска браузера вход может слететь.') }, icon('clock', 'sm'), n);
}

function proxyPill(target) {
  if (!target) return null;
  if (target === 'direct') return h('span', { class: 'pill', title: 'Этот аккаунт всегда без прокси' }, icon('globe', 'sm'), 'напрямую');
  if (target.startsWith('group:')) return h('span', { class: 'pill accent', title: 'Группа прокси: берётся лучший живой' }, icon('layers', 'sm'), target.slice(6));
  const p = ctx.proxy.list.find((x) => x.id === target.slice(6));
  const st = p?.status?.state;
  return h('span', { class: 'pill ' + (st === 'alive' ? 'ok' : st === 'dead' ? 'bad' : ''), title: p ? `Прокси: ${proxyName(p)} — ${latencyText(p.status)}` : 'Прокси удалён' },
    icon('globe', 'sm'), p ? (p.status?.cc ? p.status.cc + ' · ' : '') + proxyName(p) : 'удалён');
}

// Какие сайты в окне развёрнуты (текущий сайт развёрнут всегда)
const OPEN_KEY = 'mp.openSites';
const openSites = new Set((() => { try { return JSON.parse(localStorage.getItem(OPEN_KEY) || '[]'); } catch { return []; } })());
function setSiteOpen(id, open) {
  if (open) openSites.add(id); else openSites.delete(id);
  localStorage.setItem(OPEN_KEY, JSON.stringify([...openSites].slice(-200)));
}
const siteUrl = (s) => s.startUrl || `https://${s.domains[0]}/`;

function AccountsPanel() {
  const el = h('div', { class: 'panel' });
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Поиск: сайт или аккаунт…', spellcheck: false });
  const body = h('div');
  let q = '';
  search.addEventListener('input', () => { q = search.value.trim(); update(); });
  el.append(h('div', { class: 'searchbar search' }, icon('search'), search), body);

  // Сначала сайты, внутри каждого — его аккаунты. Текущий сайт — первым и развёрнутым.
  function update() {
    const parts = [];
    if (ctx.vault.locked) parts.push(h('div', { style: { padding: '0 2px 8px' } }, note('warn', 'lock', h('div', { class: 'row between' }, h('span', null, 'Хранилище заблокировано'), btn('Разблокировать', { size: 'sm', kind: 'primary', onClick: () => unlockDialog() })))));
    const needle = q.toLowerCase();
    const accHit = (a) => !needle || [a.name, a.note, ...(a.tags || [])].join(' ').toLowerCase().includes(needle);
    const siteHit = (s) => !needle || [s.name, ...(s.domains || [])].join(' ').toLowerCase().includes(needle);
    const shown = (s) => (siteHit(s) ? s.accounts : s.accounts.filter(accHit));
    const curId = ctx.siteExists ? ctx.site.id : null;
    let found = 0;

    if (ctx.supported) {
      if (ctx.siteExists) {
        const cur = { ...ctx.site, accounts: ctx.accounts, activeId: ctx.activeId };
        const list = shown(cur);
        if (!needle || list.length) { parts.push(siteGroup(cur, list, { current: true, open: true })); found += list.length; }
      } else if (!needle) parts.push(emptySite());
    }

    const rest = (ctx.sites || []).filter((s) => s.id !== curId).map((s) => ({ s, list: shown(s) })).filter(({ s, list }) => !needle || siteHit(s) || list.length);
    if (rest.length) {
      parts.push(h('div', { class: 'sect-title' }, ctx.supported ? 'Другие сайты' : 'Сайты', h('span', { class: 'cnt' }, rest.length)));
      parts.push(h('div', { class: 'tree' }, rest.map(({ s, list }) => siteGroup(s, list, { open: !!needle || openSites.has(s.id) }))));
      found += rest.length;
    }
    if (!ctx.supported && !needle && !rest.length) {
      parts.push(h('div', { class: 'empty', style: { paddingBottom: '8px' } }, h('div', { class: 'big' }, icon('globe')), h('h4', null, 'Откройте сайт'),
        h('p', { class: 'small' }, 'Здесь служебная страница. На любом сайте Multipass покажет его аккаунты и сохранит вход одним кликом.')));
    }
    if (needle && !found) parts.push(h('div', { class: 'empty' }, h('p', { class: 'small' }, 'Ничего не найдено')));
    fill(body, ...parts);
    renderBar();
  }

  function siteGroup(s, list, { current = false, open = false } = {}) {
    const active = s.accounts.find((a) => a.id === s.activeId);
    const n = s.accounts.length;
    const wrap = h('div', { class: 'sgroup' + (open ? ' open' : '') + (current ? ' current' : '') });
    const head = h('div', current ? { class: 'sg-head', title: s.domains.join(', ') } : { class: 'sg-head', tabindex: 0, role: 'button', 'aria-expanded': String(open), title: s.domains.join(', ') },
      icon('chev', 'sm chev'),
      favicon(siteUrl(s)),
      h('div', { class: 'grow col', style: { gap: '0', minWidth: '0' } },
        h('div', { class: 'name' }, h('span', { class: 'ellipsis' }, s.name), current ? h('span', { class: 'pill accent' }, 'этот сайт') : null),
        h('div', { class: 'meta' }, h('span', { class: 'nowrap' }, `${n} ${plural(n, 'аккаунт', 'аккаунта', 'аккаунтов')}`),
          active ? [h('span', { class: 'faint' }, '·'), h('span', { class: 'ellipsis', title: 'Сейчас на сайте этот аккаунт' }, 'вошли как ' + active.name)] : null)),
      current ? null : btn('', { icon: 'external', kind: 'ghost', size: 'sm', title: `Открыть ${s.name}` + (active ? ` (как «${active.name}»)` : ''),
        onClick: () => { chrome.tabs.create({ url: siteUrl(s) }); if (IS_POPUP) window.close(); } }));
    const kids = h('div', { class: 'kids list' }, list.length
      ? list.map((a) => accountRow(a, { other: !current, site: s }))
      : h('div', { class: 'faint small', style: { padding: '6px 10px' } }, n ? 'Ничего не найдено' : 'Аккаунтов пока нет'));
    const toggle = () => {
      const o = !wrap.classList.contains('open');
      wrap.classList.toggle('open', o);
      head.setAttribute('aria-expanded', String(o));
      if (!current && !q) setSiteOpen(s.id, o);
    };
    if (!current) { // текущий сайт всегда развёрнут
      head.addEventListener('click', toggle);
      head.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === head) { e.preventDefault(); toggle(); } });
    }
    wrap.append(head, kids);
    return wrap;
  }

  function emptySite() {
    return h('div', { class: 'empty' }, h('div', { class: 'big' }, icon('userplus')), h('h4', null, `Аккаунтов для ${ctx.site.name} пока нет`),
      h('p', { class: 'small' }, 'Войдите на сайте и нажмите «Сохранить вход». Для следующего аккаунта — «Новый вход»: текущий сохранится, а сайт откроется с чистого листа.'));
  }

  function renderBar() {
    if (!ctx.supported) { fill(bar, btn('Импорт аккаунтов', { icon: 'download', onClick: () => openDashboard('transfer') }), btn('Все аккаунты', { icon: 'users', onClick: () => openDashboard('accounts') })); return; }
    const active = ctx.accounts.find((a) => a.active);
    const save = active && !active.session
      ? btn(`Сохранить «${active.name}»`, { icon: 'save', kind: 'primary', title: 'Сохранить текущий вход в этот аккаунт', onClick: () => captureInto(active) })
      : active
        ? btn('Обновить', { icon: 'refresh', title: `Записать текущее состояние входа в «${active.name}»`, onClick: async () => { const s = await api('acct.saveActive', { tabId }); toast(`Сессия «${active.name}» обновлена · ${s?.cookies ?? 0} куки`); } })
        : btn('Сохранить вход', { icon: 'save', kind: 'primary', onClick: saveNewDialog });
    fill(bar, save, btn('Новый вход', { icon: 'userplus', title: 'Сохранить текущий вход и открыть сайт без входа — для следующего аккаунта', onClick: cleanLoginDialog }),
      active ? btn('', { icon: 'plus', title: 'Сохранить текущий вход как отдельный новый аккаунт', onClick: saveNewDialog }) : null);
  }

  function accountRow(a, { other = false, site = null } = {}) {
    const draft = !a.session;
    const acts = h('div', { class: 'acts' + (draft ? ' show' : '') },
      draft && !other ? btn('Сохранить', { kind: 'primary', size: 'sm', title: 'Сохранить текущий вход в этот аккаунт', onClick: () => captureInto(a) }) : null,
      btn('', { icon: 'more', kind: 'ghost', size: 'sm', title: 'Действия', onClick: (e, b) => accountMenu(a, b, other) }));
    const extras = [proxyPill(a.proxy),
      a.elsewhere?.length ? h('span', { class: 'pill info', title: 'Сейчас активен также в: ' + a.elsewhere.join(', ') }, icon('monitor', 'sm'), a.elsewhere[0].split(' · ')[0] + (a.elsewhere.length > 1 ? ` +${a.elsewhere.length - 1}` : '')) : null,
      ...(a.tags || []).slice(0, 3).map((t) => h('span', { class: 'pill' }, t))].filter(Boolean);
    const flat = other && !site; // плоский список (без группы сайта) — показываем, чей это аккаунт
    const row = h('div', { class: 'item' + (a.active && !other ? ' active' : ''), tabindex: 0, role: 'button', title: a.note || null },
      flat ? h('div', { style: { position: 'relative' } }, avatar(a), h('img', { class: 'fav', src: favicon('https://' + a.domain).src, style: { position: 'absolute', right: '-4px', bottom: '-4px', width: '14px', height: '14px', borderRadius: '3px', background: 'var(--card)' } })) : avatar(a, { online: a.active }),
      h('div', { class: 'grow col', style: { gap: '1px' } },
        h('div', { class: 'name' }, a.fav ? icon('star', 'sm fav-star') : null, h('span', { class: 'ellipsis' }, a.name),
          a.active ? h('span', { class: 'pill accent', title: other ? 'Сейчас на этом сайте вы вошли под этим аккаунтом' : null }, 'активен') : null,
          tempPill(a, site)),
        h('div', { class: 'meta' }, flat ? [h('span', { class: 'b' }, a.siteName), h('span', { class: 'faint' }, '·')] : null, sessionLine(a, { expiry: false })),
        expiryLine(a),
        extras.length ? h('div', { class: 'meta', style: { marginTop: '3px' } }, extras) : null),
      acts);
    const go = () => (other ? switchElsewhere(a, row, site) : doSwitch(a, row));
    row.addEventListener('click', go);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === row) go(); });
    return row;
  }

  async function doSwitch(a, row) {
    if (a.active) return toast('Этот аккаунт уже активен', 'info');
    if (!a.session) return toast('У аккаунта ещё нет сохранённой сессии', 'warn');
    row.classList.add('busy');
    const sp = h('span', { class: 'spinner' });
    row.append(sp);
    try {
      const r = await api('acct.switch', { id: a.id, tabId });
      toast(`Вы вошли как «${a.name}» · ${r.ms} мс${r.failedCookies ? ` · не применилось куки: ${r.failedCookies}` : ''}`, r.failedCookies ? 'warn' : 'ok');
      if (IS_POPUP && ctx.settings.closePopupAfterSwitch) setTimeout(() => window.close(), 400);
    } catch (e) { showError(e); }
    finally { row.classList.remove('busy'); sp.remove(); }
  }
  async function switchElsewhere(a, row, site = null) {
    // аккаунт и так активен на своём сайте — просто открываем сайт, не перезаписывая свежие куки старым снимком
    if (a.active && site) { chrome.tabs.create({ url: a.startUrl || siteUrl(site) }); if (IS_POPUP) window.close(); return; }
    if (!a.session) return toast('У аккаунта ещё нет сохранённой сессии', 'warn');
    row.classList.add('busy');
    try {
      await api('acct.switch', { id: a.id, newTab: true });
      if (IS_POPUP) window.close();
    } catch (e) { showError(e); } finally { row.classList.remove('busy'); }
  }
  async function captureInto(a) {
    const s = await api('acct.capture', { id: a.id, tabId });
    toast(`Сохранено в «${a.name}» · ${s?.cookies ?? 0} куки`);
  }

  function accountMenu(a, anchor, other) {
    const onThisSite = ctx.supported && ctx.siteExists && a.siteId === ctx.site.id;
    menu(anchor, [
      !a.active && a.session ? { label: other ? 'Открыть с этим аккаунтом' : 'Переключиться', icon: 'swap', onClick: () => (other ? switchElsewhere(a, anchor.closest('.item'), ctx.sites?.find((x) => x.id === a.siteId)) : doSwitch(a, anchor.closest('.item'))) } : null,
      onThisSite && a.session ? { label: 'Открыть в новой вкладке', icon: 'external', onClick: async () => { await api('acct.switch', { id: a.id, newTab: true }); if (IS_POPUP) window.close(); } } : null,
      onThisSite ? { label: a.active ? 'Обновить сессию из вкладки' : 'Записать сюда текущий вход…', icon: 'refresh', onClick: async () => {
        if (!a.active && a.session && !(await confirmDialog({ title: 'Перезаписать сессию?', text: `Текущие куки сайта будут сохранены в «${a.name}» вместо его сессии. Прошлую версию можно будет вернуть.`, ok: 'Перезаписать', danger: false }))) return;
        await captureInto(a);
      } } : null,
      { label: 'Изменить…', icon: 'edit', onClick: () => editAccountDialog(a, { proxies: ctx.proxy.list, groups: ctx.proxy.groups }).then((r) => r && toast('Сохранено')) },
      a.session ? { label: 'Копировать куки (JSON)', icon: 'copy', onClick: async () => { const r = await api('acct.exportCookies', { id: a.id, format: 'json' }); await copyText(r.text); toast('Куки скопированы — формат Cookie-Editor'); } } : null,
      a.session ? { label: 'Вернуть прошлую версию сессии', icon: 'clock', onClick: async () => {
        if (!(await confirmDialog({ title: 'Откатить сессию?', text: 'Сессия аккаунта будет заменена предыдущей сохранённой версией (текущая станет «прошлой»).', ok: 'Откатить', danger: false }))) return;
        await api('acct.restorePrev', { id: a.id }); toast('Прошлая версия восстановлена');
      } } : null,
      'sep',
      { label: 'Удалить', icon: 'trash', danger: true, onClick: async () => {
        if (ctx.settings.confirmDelete && !(await confirmDialog({ title: `Удалить «${a.name}»?`, text: 'Сохранённая сессия этого аккаунта будет удалена (на всех синхронизированных браузерах). Вход на сайте в этом браузере не изменится.' }))) return;
        await api('acct.delete', { ids: [a.id] }); toast('Аккаунт удалён');
      } },
    ]);
  }

  async function saveNewDialog() {
    const ident = await rpc('acct.identity', { tabId }).catch(() => ({}));
    const name = h('input', { class: 'input', value: ident.email || '', placeholder: `Аккаунт ${ctx.accounts.length + 1}`, maxlength: 80, autofocus: true });
    const px = targetSelect({ proxies: ctx.proxy.list, groups: ctx.proxy.groups, none: 'Без прокси', direct: true });
    modal({ title: 'Сохранить текущий вход', icon: 'save',
      body: [h('p', { class: 'muted small' }, `Сохраним куки и localStorage сайта ${ctx.site.name}. Вернуться в этот аккаунт — один клик.`),
        field('Название', name, ident.email ? 'Подставили адрес со страницы — можно изменить' : 'Например, e-mail или «Рабочий»'),
        field('Прокси для аккаунта (необязательно)', px, 'Сайт будет открываться через этот прокси, пока аккаунт активен')],
      actions: [{ label: 'Отмена', onClick: () => null }, { label: 'Сохранить', kind: 'primary', icon: 'save', onClick: async () => {
        const a = await api('acct.saveNew', { tabId, name: name.value, proxy: px.value || null });
        toast(`Сохранено: «${a.name}» · ${a.session?.cookies ?? 0} куки`);
      } }] });
  }

  function cleanLoginDialog() {
    const active = ctx.accounts.find((a) => a.active);
    const name = h('input', { class: 'input', placeholder: `Аккаунт ${ctx.accounts.length + 1}`, maxlength: 80, autofocus: true });
    const px = targetSelect({ proxies: ctx.proxy.list, groups: ctx.proxy.groups, none: 'Без прокси', direct: true });
    let warn;
    if (active && active.session && ctx.settings.autosaveOnSwitch) warn = note('ok', 'check', `Текущий вход «${active.name}» сохранится автоматически.`);
    else if (active && active.session) warn = note('warn', 'alert', `Автосохранение выключено — изменения в «${active.name}» с момента последнего сохранения не попадут в аккаунт.`);
    else warn = note('warn', 'alert', 'Если вы сейчас вошли в аккаунт и он не сохранён — этот вход будет потерян. ', h('a', { href: '#', onClick: (e) => { e.preventDefault(); m.close(); saveNewDialog(); } }, 'Сначала сохранить'));
    const m = modal({ title: `Новый вход: ${ctx.site.name}`, icon: 'userplus',
      body: [warn, h('p', { class: 'muted small' }, 'Куки и хранилище сайта очистятся, откроется страница без входа. Войдите в другой аккаунт и нажмите «Сохранить».'),
        field('Название нового аккаунта', name), field('Прокси для нового аккаунта', px, 'Выберите сразу — тогда вход и регистрация пройдут уже с IP этого прокси')],
      actions: [{ label: 'Отмена', onClick: () => null }, { label: 'Очистить и войти', kind: 'primary', icon: 'userplus', onClick: async () => {
        await api('acct.cleanLogin', { tabId, name: name.value, proxy: px.value || null, draft: true });
        toast('Сайт очищен — войдите в новый аккаунт и нажмите «Сохранить»', 'info', 6000);
      } }] });
  }

  return { name: 'accounts', el, update };
}

// ---------- Прокси ----------
function routeInfo(r) {
  const killSwitch = ctx.proxy.state.killSwitch !== false;
  if (!r || r.kind === 'off') return { text: 'Прокси выключены — сайт открывается напрямую', kind: '' };
  const s = r.source?.type;
  if (r.kind === 'direct') return { text: s === 'bypass' ? `Напрямую — адрес в исключениях (${r.source.pattern})` : s === 'rule' ? 'Напрямую — по правилу для сайта' : s === 'account' ? 'Напрямую — так настроен аккаунт' : 'Напрямую', kind: '' };
  if (r.kind === 'block') return { text: 'Заблокировано правилом', kind: 'bad' };
  if (r.kind === 'empty-group') return { text: `Заблокировано: в группе «${r.group}» нет живых прокси (kill switch)`, kind: 'bad' };
  if (r.kind === 'missing') return { text: 'Заблокировано: выбранный прокси удалён (kill switch)', kind: 'bad' };
  const src = s === 'account' ? `аккаунт «${r.source.name}»` : s === 'rule' ? 'правило сайта' : s === 'global' ? 'весь браузер' : '';
  if (r.kind === 'failover') return { text: `Через резервный «${proxyName(r.proxy)}» — основной «${proxyName(r.original)}» не отвечает · ${src}`, kind: 'warn' };
  const dead = r.status?.state === 'dead';
  return { text: `Через «${proxyName(r.proxy)}»${r.kind === 'group' ? ` (группа «${r.group}»)` : ''} · ${src}${dead ? (killSwitch ? ' · прокси не отвечает — сайт не откроется (kill switch)' : ' · прокси не отвечает — трафик пойдёт напрямую') : ''}`, kind: dead ? 'bad' : 'ok' };
}

function ProxyPanel() {
  const el = h('div', { class: 'panel stack', style: { gap: '10px', padding: '2px' } });
  const dyn = h('div', { class: 'stack', style: { gap: '10px' } });
  const ta = h('textarea', { class: 'input', rows: 4, spellcheck: false, placeholder: 'Вставьте список, по одному в строке:\nhost:port\nhost:port:логин:пароль\nsocks5://логин:пароль@host:port' });
  const grp = h('input', { class: 'input sm grow', placeholder: 'Группа (необязательно)', list: 'mp-groups' });
  const quick = h('details', { class: 'card' }, h('summary', null, icon('plus', 'sm'), 'Добавить прокси списком'),
    h('div', { class: 'col' }, ta, h('div', { class: 'row' }, grp, btn('Добавить и проверить', { kind: 'primary', size: 'sm', icon: 'zap', onClick: doImport }))));
  const dl = h('datalist', { id: 'mp-groups' });
  el.append(dyn, quick, dl);
  let ip = null;

  async function doImport() {
    if (!ta.value.trim()) throw new Error('Вставьте хотя бы один прокси');
    const r = await api('proxy.import', { text: ta.value, group: grp.value, autoCheck: true });
    const msg = [`Добавлено: ${r.added}`];
    if (r.duplicates) msg.push(`дубликатов: ${r.duplicates}`);
    if (r.errors.length) msg.push(`не распознано: ${r.errors.length}`);
    toast(msg.join(' · ') + (r.added ? ' — проверяем…' : ''), r.errors.length ? 'warn' : 'ok', 5000);
    if (r.added) { ta.value = ''; quick.open = false; }
  }

  function update() {
    const P = ctx.proxy, st = P.state;
    fill(dl, ...P.groups.map((g) => h('option', { value: g })));
    const parts = [];
    if (ctx.control === 'controlled_by_other_extensions') parts.push(note('bad', 'alert', 'Прокси сейчас управляет другое расширение — отключите его, иначе настройки Multipass не применятся.'));
    if (ctx.control === 'not_controllable') parts.push(note('bad', 'alert', 'Настройки прокси заблокированы политикой браузера или системы.'));
    const hint = { off: 'Весь трафик идёт напрямую. Привязки аккаунтов и правила не действуют.', rules: 'Прокси только там, где задано: у аккаунта или правилом для сайта. Остальное — напрямую.', global: 'Весь браузер через выбранный прокси (кроме исключений). Правила и аккаунты имеют приоритет.' }[st.mode];
    const mode = h('div', { class: 'card' },
      h('div', { class: 'row between', style: { marginBottom: '8px' } }, h('div', { class: 'b' }, 'Режим'),
        seg([{ value: 'off', label: 'Выкл' }, { value: 'rules', label: 'По правилам' }, { value: 'global', label: 'Весь браузер' }], st.mode, async (v) => { await api('proxy.state', { mode: v }); })),
      h('div', { class: 'hint' }, hint),
      st.mode === 'global' ? h('div', { style: { marginTop: '9px' } }, P.list.length
        ? targetSelect({ value: st.target, proxies: P.list, groups: P.groups, none: null, onChange: (v) => api('proxy.state', { target: v }) })
        : note('warn', 'alert', 'Сначала добавьте прокси')) : null);
    parts.push(mode);

    if (ctx.supported) {
      const ri = routeInfo(ctx.route);
      const siteSel = targetSelect({ value: ctx.siteRuleTarget, proxies: P.list, groups: P.groups, none: 'Как обычно (по режиму)', direct: true, block: true, cls: 'input sm',
        onChange: async (v) => { await api('proxy.siteRoute', { host: ctx.host, target: v }); if (v && st.mode === 'off') await api('proxy.state', { mode: 'rules' }); ip = null; toast(v ? `Правило для ${ctx.site.name}: ${targetLabel(v, P.list)}` : 'Правило для сайта удалено'); } });
      const ipBox = h('div');
      if (ip) ipBox.append(ipView(ip));
      parts.push(h('div', { class: 'card' },
        h('div', { class: 'row', style: { marginBottom: '6px' } }, favicon(ctx.tab.url), h('div', { class: 'b grow ellipsis' }, ctx.host), ctx.route?.status ? ccPill(ctx.route.status) : null, ctx.route?.proxy ? statusDot(ctx.route.status) : null),
        h('div', { class: 'small ' + (ri.kind === 'bad' ? 'badc' : ri.kind === 'warn' ? 'warnc' : 'muted') }, ri.text),
        h('div', { class: 'row', style: { marginTop: '9px' } }, h('span', { class: 'small muted nowrap' }, 'Для сайта:'), siteSel),
        h('div', { class: 'row', style: { marginTop: '8px' } },
          btn('Какой IP видит сайт', { size: 'sm', icon: 'eye', onClick: async () => { ip = await api('proxy.ip', { host: ctx.host }); fill(ipBox, ipView(ip)); } }),
          P.counts.alive > 1 ? btn('Сменить IP', { size: 'sm', icon: 'refresh', title: 'Следующий живой прокси (Alt+Shift+P)', onClick: async () => { const p = await api('proxy.rotate', { host: ctx.host }); ip = null; toast(`Теперь через «${proxyName(p)}»${p.status?.ip ? ' · ' + p.status.ip : ''}`); } }) : null),
        ipBox));
    }

    if (!P.list.length) {
      parts.push(h('div', { class: 'empty', style: { padding: '14px' } }, h('div', { class: 'big' }, icon('globe')), h('h4', null, 'Прокси ещё нет'),
        h('p', { class: 'small' }, 'Вставьте список ниже — Multipass распознает формат, проверит каждый и отметит мёртвые.')));
      quick.open = true;
    } else {
      const sorted = [...P.list].sort((a, b) => rank(a) - rank(b) || (a.status?.latency || 1e9) - (b.status?.latency || 1e9));
      parts.push(h('div', { class: 'card', style: { padding: '8px 6px' } },
        h('div', { class: 'row', style: { padding: '0 6px 6px' } },
          h('div', { class: 'grow small' }, h('span', { class: 'b' }, `${P.counts.total} прокси`), h('span', { class: 'muted' }, ` · живых ${P.counts.alive}`), P.counts.dead ? h('span', { class: 'badc' }, ` · мёртвых ${P.counts.dead}`) : null),
          btn('Проверить', { size: 'sm', icon: 'zap', title: 'Проверить все прокси', onClick: async () => { const r = await api('proxy.check', {}); toast(`Живых: ${r.alive} из ${r.total}`); } }),
          btn('', { size: 'sm', icon: 'sliders', kind: 'ghost', title: 'Менеджер прокси', onClick: () => openDashboard('proxies') })),
        h('div', { class: 'list' }, sorted.slice(0, 7).map(proxyRow)),
        sorted.length > 7 ? h('div', { style: { padding: '4px 6px 0' } }, h('a', { href: '#', class: 'small', onClick: (e) => { e.preventDefault(); openDashboard('proxies'); } }, `Ещё ${sorted.length - 7} — в менеджере прокси`)) : null));
    }
    fill(dyn, ...parts);
    fill(bar);
  }

  const rank = (p) => (p.status?.state === 'alive' ? 0 : p.status?.state === 'dead' ? 2 : 1);
  function proxyRow(p) {
    const r = h('div', { class: 'item', style: { padding: '6px 8px' } }, statusDot(p.status),
      h('div', { class: 'grow col', style: { gap: '0' } }, h('div', { class: 'ellipsis small b' }, proxyName(p)),
        h('div', { class: 'meta' }, h('span', { class: 'mono' }, `${p.effType.toUpperCase()} ${p.host}:${p.port}`), p.group ? h('span', { class: 'pill' }, p.group) : null)),
      ccPill(p.status), h('span', { class: 'small nowrap ' + (p.status?.state === 'dead' ? 'badc' : 'muted') }, p.status?.state === 'alive' ? `${p.status.latency} мс` : p.status?.state === 'dead' ? 'мёртв' : p.status?.checking ? '…' : ''));
    r.addEventListener('click', () => menu(r.lastChild, [
      { header: proxyName(p) },
      ctx.supported ? { label: `Использовать для ${ctx.site.name}`, icon: 'pin', onClick: async () => { await api('proxy.siteRoute', { host: ctx.host, target: 'proxy:' + p.id }); if (ctx.proxy.state.mode === 'off') await api('proxy.state', { mode: 'rules' }); toast(`${ctx.site.name} → ${proxyName(p)}`); } } : null,
      { label: 'Весь браузер через него', icon: 'globe', onClick: async () => { await api('proxy.state', { mode: 'global', target: 'proxy:' + p.id }); toast(`Весь браузер → ${proxyName(p)}`); } },
      { label: 'Проверить', icon: 'zap', onClick: async () => { const x = await api('proxy.check', { ids: [p.id] }); toast(x.alive ? 'Работает' : 'Не отвечает', x.alive ? 'ok' : 'bad'); } },
      { label: 'Копировать', icon: 'copy', onClick: async () => { await copyText(await rpc('proxy.export', { ids: [p.id], style: 'url' })); toast('Скопировано'); } },
    ]));
    return r;
  }

  function ipView(r) {
    if (!r.ok) return note('bad', 'wifioff', h('div', null, h('div', { class: 'b' }, 'Сайт сейчас недоступен'), h('div', { class: 'small' }, r.errorText || describeError(r.error))));
    const mm = tzMismatch(r.tz);
    return h('div', null,
      h('div', { class: 'ipbox' },
        h('span', { class: 'k' }, 'IP'), h('span', { class: 'mono b' }, r.ip || '—'),
        h('span', { class: 'k' }, 'Страна'), h('span', null, [countryName(r.cc), r.city].filter(Boolean).join(', ') || '—'),
        r.isp ? [h('span', { class: 'k' }, 'Провайдер'), h('span', { class: 'ellipsis' }, r.isp)] : null,
        h('span', { class: 'k' }, 'Задержка'), h('span', null, `${r.latency} мс`, r.via ? h('span', { class: 'muted' }, ` · через «${proxyName(r.via)}»`) : h('span', { class: 'muted' }, ' · напрямую'))),
      mm ? h('div', { style: { marginTop: '8px' } }, note('warn', 'clock', `Часовой пояс браузера (${mm.mine}) не совпадает с IP (${mm.ip}). Сайты с антифродом могут это заметить — поменяйте пояс системы или прокси.`)) : null);
  }

  return { name: 'proxy', el, update };
}

// ---------- Куки ----------
function CookiesPanel() {
  const el = h('div', { class: 'panel' });
  const filter = h('input', { class: 'input', type: 'search', placeholder: 'Фильтр по имени, домену, значению…', spellcheck: false });
  const body = h('div');
  let data = null, loading = false, again = false;
  filter.addEventListener('input', render);
  el.append(h('div', { class: 'searchbar search' }, icon('search'), filter), body);

  async function load() {
    if (!ctx.supported) { data = null; render(); return; }
    if (loading) { again = true; return; }
    loading = true;
    try { data = await rpc('cookies.list', { tabId }); } catch (e) { data = { error: e.message }; }
    finally { loading = false; }
    render();
    if (again) { again = false; load(); }
  }
  function render() {
    if (!ctx.supported) { fill(body, h('div', { class: 'empty' }, h('div', { class: 'big' }, icon('cookie')), h('h4', null, 'Откройте сайт'), h('p', { class: 'small' }, 'Редактор показывает куки сайта активной вкладки.'))); fill(bar); return; }
    if (!data) { fill(body, h('div', { class: 'empty' }, h('span', { class: 'spinner' }))); return; }
    if (data.error) { fill(body, note('bad', 'alert', data.error)); return; }
    const needle = filter.value.trim().toLowerCase();
    const list = data.cookies.filter((c) => !needle || `${c.name} ${c.domain} ${c.value}`.toLowerCase().includes(needle));
    fill(body,
      h('div', { class: 'row', style: { padding: '0 8px 6px' } }, h('span', { class: 'small muted grow ellipsis', title: data.domains.join(', ') }, `${data.cookies.length} ${plural(data.cookies.length, 'куки', 'куки', 'куки')} · ${data.domains.join(', ')}`)),
      list.length ? h('div', { class: 'list' }, list.map(cookieRow)) : h('div', { class: 'empty' }, h('p', { class: 'small' }, data.cookies.length ? 'Ничего не найдено' : 'У сайта нет куки')));
    fill(bar,
      btn('Добавить', { icon: 'plus', onClick: () => editCookie(null) }),
      btn('Экспорт', { icon: 'upload', onClick: (e, b) => menu(b, [
        { label: 'Копировать JSON (Cookie-Editor)', icon: 'copy', onClick: async () => { await copyText(await api('cookies.export', { tabId, format: 'json' })); toast('JSON скопирован'); } },
        { label: 'Скачать JSON', icon: 'download', onClick: async () => download(await api('cookies.export', { tabId, format: 'json' }), `${ctx.host}.cookies.json`) },
        { label: 'Скачать cookies.txt (Netscape)', icon: 'file', onClick: async () => download(await api('cookies.export', { tabId, format: 'netscape' }), `${ctx.host}.cookies.txt`, 'text/plain') },
      ]) }),
      btn('Импорт', { icon: 'download', onClick: importDialog }),
      btn('', { icon: 'trash', kind: 'danger', title: 'Удалить все куки сайта', onClick: async () => {
        if (!(await confirmDialog({ title: 'Удалить все куки сайта?', text: `Будут удалены ${data.cookies.length} куки для ${data.domains.join(', ')}. Скорее всего, сайт разлогинит.` }))) return;
        const n = await api('cookies.clear', { tabId }); toast(`Удалено: ${n}`); load();
      } }));
  }
  function cookieRow(c) {
    const exp = c.expirationDate ? new Date(c.expirationDate * 1000) : null;
    const r = h('div', { class: 'item ck' },
      h('div', { class: 'grow col', style: { gap: '1px' } },
        h('div', { class: 'row' }, h('span', { class: 'nm ellipsis grow' }, c.name || '(без имени)'),
          c.httpOnly ? h('span', { class: 'pill', title: 'Недоступна скриптам страницы' }, 'HttpOnly') : null,
          c.secure ? h('span', { class: 'pill ok', title: 'Только по HTTPS' }, 'Secure') : null,
          c.sameSite && c.sameSite !== 'unspecified' ? h('span', { class: 'pill' }, c.sameSite === 'no_restriction' ? 'None' : c.sameSite) : null),
        h('div', { class: 'meta' }, h('span', null, c.domain + (c.path !== '/' ? c.path : '')), h('span', { class: 'faint' }, '·'),
          c.pinned ? h('span', { class: 'okc', title: `Временная куки, закреплена Multipass до ${exp.toLocaleString('ru-RU')} — не пропадёт при закрытии браузера` }, 'временная · закреплена')
            : h('span', { title: exp ? exp.toLocaleString('ru-RU') : 'Браузер удалит её при закрытии' }, exp ? (exp < new Date() ? 'истекла' : 'до ' + exp.toLocaleDateString('ru-RU')) : 'временная')),
        h('div', { class: 'v ellipsis' }, c.value.slice(0, 160) || '—')));
    r.addEventListener('click', () => editCookie(c));
    return r;
  }
  function editCookie(c) {
    const isNew = !c;
    c = c || { name: '', value: '', domain: ctx.host, path: '/', secure: true, httpOnly: false, sameSite: 'lax', hostOnly: true, expirationDate: Math.round(Date.now() / 1000 + 365 * 86400) };
    const pad = (n) => String(n).padStart(2, '0');
    const toLocal = (s) => { const d = new Date(s * 1000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
    const f = {
      name: h('input', { class: 'input mono', value: c.name, spellcheck: false, autofocus: isNew }),
      value: h('textarea', { class: 'input', rows: 4, value: c.value, spellcheck: false }),
      domain: h('input', { class: 'input mono', value: c.domain, spellcheck: false }),
      path: h('input', { class: 'input mono', value: c.path, spellcheck: false }),
      exp: h('input', { class: 'input', type: 'datetime-local', value: c.expirationDate ? toLocal(c.expirationDate) : '' }),
      session: h('input', { type: 'checkbox', checked: !c.expirationDate || !!c.pinned }),
      secure: h('input', { type: 'checkbox', checked: c.secure }), httpOnly: h('input', { type: 'checkbox', checked: c.httpOnly }),
      hostOnly: h('input', { type: 'checkbox', checked: c.hostOnly }),
      sameSite: h('select', { class: 'input' }, [['unspecified', 'Не задано'], ['lax', 'Lax'], ['strict', 'Strict'], ['no_restriction', 'None']].map(([v, t]) => h('option', { value: v }, t))),
    };
    f.sameSite.value = c.sameSite || 'unspecified';
    const syncExp = () => { f.exp.disabled = f.session.checked; };
    f.session.addEventListener('change', syncExp); syncExp();
    const original = isNew ? null : { name: c.name, domain: c.domain, path: c.path, secure: c.secure, partitionKey: c.partitionKey };
    modal({ title: isNew ? 'Новая куки' : 'Куки', icon: 'cookie',
      body: [field('Имя', f.name), field('Значение', f.value), h('div', { class: 'grid2' }, field('Домен', f.domain), field('Путь', f.path)),
        h('div', { class: 'grid2' }, field('Истекает', f.exp), field('SameSite', f.sameSite)),
        c.pinned ? note('info', 'clock', 'Временная куки, Multipass закрепил её (чтобы вход не слетал после закрытия браузера). Оставьте «Временная» — закрепление сохранится.') : null,
        h('div', { class: 'row wrap', style: { gap: '14px' } }, h('label', { class: 'check', title: 'Без срока: браузер удаляет такую куки при закрытии (Multipass закрепляет её на сайтах с активным аккаунтом)' }, f.session, 'Временная'), h('label', { class: 'check' }, f.secure, 'Secure'),
          h('label', { class: 'check' }, f.httpOnly, 'HttpOnly'), h('label', { class: 'check', title: 'Без точки в начале домена: куки только для этого хоста, без поддоменов' }, f.hostOnly, 'Только этот хост'))],
      actions: [
        isNew ? null : { label: 'Удалить', kind: 'danger', icon: 'trash', onClick: async () => { await api('cookies.remove', { tabId, cookie: original }); toast('Куки удалена'); load(); } },
        { label: 'Отмена', onClick: () => null },
        { label: 'Сохранить', kind: 'primary', onClick: async () => {
          if (!f.name.value.trim() && !f.value.value) throw new Error('Укажите имя');
          let domain = f.domain.value.trim().toLowerCase();
          if (f.hostOnly.checked) domain = domain.replace(/^\./, '');
          else if (!domain.startsWith('.')) domain = '.' + domain;
          const cookie = { name: f.name.value.trim(), value: f.value.value, domain, path: f.path.value.trim() || '/', secure: f.secure.checked, httpOnly: f.httpOnly.checked, sameSite: f.sameSite.value, hostOnly: f.hostOnly.checked };
          if (!f.session.checked) { const t = Date.parse(f.exp.value); if (!t) throw new Error('Укажите дату истечения или отметьте «Временная»'); cookie.expirationDate = Math.round(t / 1000); }
          if (c.partitionKey) cookie.partitionKey = c.partitionKey;
          await api('cookies.set', { tabId, cookie, original });
          toast('Куки сохранена'); load();
        } },
      ].filter(Boolean) });
  }
  function importDialog() {
    const ta = h('textarea', { class: 'input', rows: 8, spellcheck: false, placeholder: 'JSON из Cookie-Editor / EditThisCookie, Playwright storageState или cookies.txt (Netscape)' });
    const replace = h('input', { type: 'checkbox', checked: true });
    modal({ title: 'Импорт куки на сайт', icon: 'download',
      body: [ta, h('label', { class: 'check' }, replace, 'Сначала удалить текущие куки сайта'), h('div', { class: 'hint' }, 'Чтобы сохранить импорт как отдельный аккаунт, используйте Панель → Перенос → «Импорт куки как аккаунт».')],
      actions: [{ label: 'Отмена', onClick: () => null }, { label: 'Импортировать', kind: 'primary', onClick: async () => {
        const r = await api('cookies.import', { tabId, text: ta.value, replace: replace.checked });
        toast(`Импортировано: ${r.imported}${r.failed.length ? ` · ошибок: ${r.failed.length}` : ''} — обновите страницу`, r.failed.length ? 'warn' : 'ok', 5000);
        load();
      } }] });
  }
  return { name: 'cookies', el, update: load };
}

init().catch((e) => { console.error(e); toast(e.message, 'bad'); });
