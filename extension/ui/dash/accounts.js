// Раздел «Аккаунты»: сайты, аккаунты, сессии, массовые действия
import {
  api, h, fill, icon, btn, toast, menu, modal, confirmDialog, field, note, favicon, avatar, targetSelect,
  editAccountDialog, download, plural, bytes, ago, expiryInfo,
} from '../common.js';
import { S, rerender, go } from './state.js';

const total = (D) => D.sites.reduce((n, s) => n + s.accounts.length, 0);

export default {
  id: 'accounts', title: 'Аккаунты', icon: 'users',
  live: ['sites', 'accounts', 'sessIndex', 'local', 'devices', 'proxies', 'proxyStatus', 'settings', 'vaultMeta', 'session'],
  desc: (D) => `${total(D)} ${plural(total(D), 'аккаунт', 'аккаунта', 'аккаунтов')} на ${D.sites.length} ${plural(D.sites.length, 'сайте', 'сайтах', 'сайтах')}`,
  actions: () => [btn('Добавить сайт', { icon: 'plus', onClick: () => siteDialog(null) }), btn('Импорт', { icon: 'download', onClick: () => go('transfer') })],
  render,
};

function render(D) {
  const all = new Set(D.sites.flatMap((s) => s.accounts.map((a) => a.id)));
  for (const id of [...S.ui.acctSel]) if (!all.has(id)) S.ui.acctSel.delete(id);
  if (!D.sites.length) return emptyState();
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Поиск: имя, тег, заметка, сайт…', value: S.ui.acctQuery, spellcheck: false });
  const list = h('div', { class: 'sec site-list' });
  const draw = () => fill(list, sites(D));
  search.addEventListener('input', () => { S.ui.acctQuery = search.value; draw(); });
  draw();
  const setAll = (open) => { for (const s of D.sites) setOpen(s.id, open); draw(); };
  return h('div', { class: 'sec' },
    D.vault.locked ? note('warn', 'lock', 'Хранилище заблокировано: список виден, но для переключения и экспорта понадобится мастер-пароль.') : null,
    h('div', { class: 'toolbar' }, h('div', { class: 'search' }, icon('search'), search), h('span', { class: 'sp' }),
      D.sites.length > 1 ? h('div', { class: 'row', style: { gap: '4px' } },
        btn('Развернуть все', { size: 'sm', kind: 'ghost', icon: 'down', onClick: () => setAll(true) }),
        btn('Свернуть все', { size: 'sm', kind: 'ghost', icon: 'up', onClick: () => setAll(false) })) : null),
    S.ui.acctSel.size ? bulkBar(D) : null,
    list);
}

// Свёрнут/развёрнут ли сайт (запоминается в этом браузере). По умолчанию: если сайтов немного — развёрнуты.
const OPEN_KEY = 'mp.dashSitesOpen';
let openMap = (() => { try { return JSON.parse(localStorage.getItem(OPEN_KEY) || '{}') || {}; } catch { return {}; } })();
function setOpen(id, open) { openMap[id] = !!open; try { localStorage.setItem(OPEN_KEY, JSON.stringify(openMap)); } catch {} }
const isOpen = (D, s) => (s.id in openMap ? openMap[s.id] : D.sites.length <= 3);

function sites(D) {
  const q = S.ui.acctQuery.trim().toLowerCase();
  const out = [];
  for (const s of D.sites) {
    const siteHit = !q || [s.name, ...s.domains].join(' ').toLowerCase().includes(q);
    const accts = s.accounts.filter((a) => siteHit || [a.name, a.note, ...(a.tags || [])].join(' ').toLowerCase().includes(q));
    if (!siteHit && !accts.length) continue;
    out.push(siteCard(D, s, accts, { open: !!q || isOpen(D, s), forced: !!q }));
  }
  return out.length ? out : [h('div', { class: 'empty' }, h('p', null, 'Ничего не найдено'))];
}

function siteCard(D, s, accts, { open = true, forced = false } = {}) {
  const url = s.startUrl || `https://${s.domains[0]}/`;
  const allSel = accts.length && accts.every((a) => S.ui.acctSel.has(a.id));
  const cb = h('input', { type: 'checkbox', checked: allSel, title: 'Выбрать все аккаунты сайта' });
  cb.addEventListener('change', () => { for (const a of accts) cb.checked ? S.ui.acctSel.add(a.id) : S.ui.acctSel.delete(a.id); rerender(); });
  const active = s.accounts.find((a) => a.id === s.activeId);
  const selN = s.accounts.filter((a) => S.ui.acctSel.has(a.id)).length;
  const pinOpt = s.opts?.pinSession;
  const card = h('div', { class: 'card site-card' + (open ? ' open' : '') });
  const head = h('div', { class: 'shead', title: open ? 'Свернуть' : 'Показать аккаунты сайта' },
      icon('chev', 'chev'),
      accts.length ? h('label', { class: 'check' }, cb) : null,
      favicon(url, 'fav lg'),
      h('div', { class: 'grow col', style: { gap: '3px', minWidth: '0' } },
        h('div', { class: 'row', style: { flexWrap: 'wrap' } }, h('b', null, s.name), h('span', { class: 'small muted' }, `${s.accounts.length} ${plural(s.accounts.length, 'аккаунт', 'аккаунта', 'аккаунтов')}`),
          active ? h('span', { class: 'pill accent', title: 'Сейчас на сайте выполнен вход в этот аккаунт' }, icon('user', 'sm'), active.name) : null,
          !open && selN ? h('span', { class: 'pill info' }, `выбрано: ${selN}`) : null,
          s.opts?.captureStorage === false ? h('span', { class: 'pill', title: 'Для этого сайта localStorage не сохраняется' }, 'только куки') : null,
          pinOpt === false ? h('span', { class: 'pill warn', title: 'Временные куки этого сайта не закрепляются — вход может слетать после перезапуска браузера' }, icon('clock', 'sm'), 'без закрепления') : null),
        h('div', { class: 'doms' }, s.domains.slice(0, 8).map((d) => h('span', { class: 'pill mono' }, d)), s.domains.length > 8 ? h('span', { class: 'pill' }, '+' + (s.domains.length - 8)) : null)),
      btn('Открыть сайт', { size: 'sm', icon: 'external', onClick: () => chrome.tabs.create({ url }) }),
      btn('', { size: 'sm', icon: 'more', kind: 'ghost', title: 'Действия с сайтом', onClick: (e, b) => menu(b, [
        { label: 'Настройки сайта…', icon: 'sliders', onClick: () => siteDialog(s) },
        s.activeId ? { label: 'Сбросить активный аккаунт', icon: 'x', hint: 'не трогает куки', onClick: async () => { await api('acct.forgetActive', { siteId: s.id }); toast('Активный аккаунт сброшен'); } } : null,
        'sep',
        { label: 'Удалить сайт и его аккаунты', icon: 'trash', danger: true, onClick: async () => {
          if (!(await confirmDialog({ title: `Удалить «${s.name}»?`, text: `Будут удалены ${s.accounts.length} ${plural(s.accounts.length, 'аккаунт', 'аккаунта', 'аккаунтов')} и их сессии (на всех синхронизированных браузерах).` }))) return;
          await api('site.delete', { id: s.id }); toast('Сайт удалён');
        } },
      ]) }));
  const body = h('div', { class: 'sbody' },
    accts.length ? accts.map((a) => accRow(D, s, a)) : h('div', { class: 'small faint', style: { padding: '12px 14px' } }, 'Аккаунтов нет — откройте сайт и нажмите «Сохранить вход» в окне Multipass.'));
  head.addEventListener('click', (e) => {
    if (e.target.closest('button, input, label, select, a')) return; // клики по кнопкам/галочкам не сворачивают
    const o = !card.classList.contains('open');
    card.classList.toggle('open', o);
    head.title = o ? 'Свернуть' : 'Показать аккаунты сайта';
    if (!forced) setOpen(s.id, o);
  });
  card.append(head, body);
  return card;
}

function accRow(D, s, a) {
  const sel = S.ui.acctSel.has(a.id);
  const cb = h('input', { type: 'checkbox', checked: sel });
  cb.addEventListener('change', () => { cb.checked ? S.ui.acctSel.add(a.id) : S.ui.acctSel.delete(a.id); rerender(); });
  const sess = a.session;
  const ex = sess ? expiryInfo(sess) : null;
  const dot = () => h('span', { class: 'faint' }, '·');
  const sessInfo = sess
    ? [h('div', { class: 'row wrap', style: { gap: '1px 6px' } }, h('span', { title: new Date(sess.at).toLocaleString('ru-RU') }, 'сохр. ' + ago(sess.at)), dot(), h('span', null, `${sess.cookies} куки`),
        sess.temp ? [dot(), tempInfo(D, s, sess)] : null,
        sess.lsKeys ? [dot(), h('span', { title: 'Ключей localStorage/sessionStorage' }, `${sess.lsKeys} LS`)] : null, dot(), h('span', null, bytes(sess.size || 0))),
      h('div', { class: 'row', style: { gap: '6px' } }, ex ? h('span', { class: ex.kind === 'bad' ? 'badc' : ex.kind === 'warn' ? 'warnc' : '', title: ex.title }, ex.text) : null,
        ex && sess.browser ? dot() : null, sess.browser ? h('span', { class: 'faint ellipsis', title: 'Где сохранена сессия' }, sess.browser) : null)]
    : [h('span', { class: 'warnc' }, 'сессия не сохранена — войдите на сайте и нажмите «Сохранить»')];
  return h('div', { class: 'acc-row' + (sel ? ' sel' : '') },
    h('label', { class: 'check' }, cb),
    avatar(a, { online: a.active }),
    h('div', { class: 'col', style: { gap: '2px', minWidth: '0' } },
      h('div', { class: 'nm' }, a.fav ? icon('star', 'sm fav-star') : null, h('span', { class: 'ellipsis', title: a.name }, a.name),
        a.active ? h('span', { class: 'pill accent', title: 'Сейчас этот аккаунт залогинен в этом браузере' }, 'активен') : null,
        a.elsewhere?.length ? h('span', { class: 'pill info', title: 'Активен также в: ' + a.elsewhere.join(', ') }, icon('monitor', 'sm'), a.elsewhere.length) : null),
      a.note || a.tags?.length ? h('div', { class: 'sub' }, (a.tags || []).map((t) => h('span', { class: 'pill' }, t)), a.note ? h('span', { class: 'ellipsis', title: a.note }, a.note) : null) : null),
    h('div', { class: 'sub c-sess col', style: { gap: '1px', alignItems: 'flex-start' } }, sessInfo),
    h('div', { class: 'c-proxy' }, targetSelect({ value: a.proxy, proxies: D.proxy.list, groups: D.proxy.groups, none: 'Без прокси', direct: true, cls: 'input sm',
      onChange: async (v) => { await api('acct.update', { id: a.id, patch: { proxy: v } }); toast(v ? `«${a.name}»: прокси назначен` : `«${a.name}»: без прокси`); } })),
    h('div', { class: 'row' },
      sess ? btn('Открыть', { size: 'sm', icon: 'login', title: 'Открыть сайт в новой вкладке с этим аккаунтом', onClick: async () => { await api('acct.switch', { id: a.id, newTab: true }); toast(`Открыто: «${a.name}»`); } }) : null,
      btn('', { size: 'sm', icon: 'more', kind: 'ghost', title: 'Действия', onClick: (e, b) => accMenu(D, s, a, b) })));
}

// Временные (сеансовые) куки: браузер стирает их при закрытии, Multipass закрепляет их, пока аккаунт активен
function tempInfo(D, s, sess) {
  const days = D.settings.pinDays || 30;
  const on = s.opts?.pinSession ?? (D.settings.pinSessionCookies !== false);
  return h('span', { class: on ? '' : 'warnc', title: `Временных (сеансовых) куки: ${sess.temp}${sess.tempAuth ? `, из них похожих на вход: ${sess.tempAuth}` : ''}. Браузер удаляет такие куки при закрытии. `
    + (on ? `Multipass закрепляет их на ${days} ${plural(days, 'день', 'дня', 'дней')}, пока аккаунт активен, и восстанавливает при старте браузера.` : 'Закрепление выключено — после перезапуска браузера вход может слететь.') },
    icon('clock', 'sm'), ` ${sess.temp} врем.`);
}

function accMenu(D, s, a, anchor) {
  const exp = (format, label) => ({ label, icon: 'download', onClick: async () => { const r = await api('acct.exportCookies', { id: a.id, format }); download(r.text, r.filename, format === 'netscape' ? 'text/plain' : 'application/json'); } });
  menu(anchor, [
    { label: 'Изменить…', icon: 'edit', onClick: () => editAccountDialog(a, { proxies: D.proxy.list, groups: D.proxy.groups, sites: D.sites }).then((r) => r && toast('Сохранено')) },
    a.session ? { label: 'Сессия подробно…', icon: 'eye', onClick: () => detailsDialog(a) } : null,
    a.session ? 'sep' : null,
    a.session ? { header: 'Экспорт куки' } : null,
    a.session ? exp('json', 'JSON (Cookie-Editor)') : null,
    a.session ? exp('netscape', 'cookies.txt (Netscape, curl/yt-dlp)') : null,
    a.session ? exp('playwright', 'Playwright storageState') : null,
    'sep',
    { label: 'Удалить', icon: 'trash', danger: true, onClick: () => deleteAccounts(D, [a.id]) },
  ]);
}

async function deleteAccounts(D, ids) {
  if (D.settings.confirmDelete && !(await confirmDialog({ title: `Удалить ${ids.length} ${plural(ids.length, 'аккаунт', 'аккаунта', 'аккаунтов')}?`, text: 'Сохранённые сессии будут удалены на всех синхронизированных браузерах. Текущий вход на сайтах в этом браузере не изменится.' }))) return;
  await api('acct.delete', { ids });
  ids.forEach((id) => S.ui.acctSel.delete(id));
  toast('Удалено');
}

function bulkBar(D) {
  const ids = [...S.ui.acctSel];
  return h('div', { class: 'bulk' },
    h('b', null, `Выбрано: ${ids.length}`), h('span', { class: 'sp' }),
    h('span', { class: 'small muted' }, 'Прокси:'),
    targetSelect({ value: null, proxies: D.proxy.list, groups: D.proxy.groups, none: '— назначить —', direct: true, cls: 'input sm', onChange: async (v) => {
      if (!v) return;
      for (const id of ids) await api('acct.update', { id, patch: { proxy: v } });
      toast(`Прокси назначен ${ids.length} ${plural(ids.length, 'аккаунту', 'аккаунтам', 'аккаунтам')}`);
    } }),
    btn('Снять прокси', { size: 'sm', onClick: async () => { for (const id of ids) await api('acct.update', { id, patch: { proxy: null } }); toast('Прокси сняты'); } }),
    btn('Экспорт…', { size: 'sm', icon: 'upload', onClick: () => { S.ui.exportMode = 'pick'; S.ui.exportSel = new Set(ids); S.ui.exportCode = null; go('transfer'); } }),
    btn('Удалить', { size: 'sm', icon: 'trash', kind: 'danger', onClick: () => deleteAccounts(D, ids) }),
    btn('', { size: 'sm', icon: 'x', kind: 'ghost', title: 'Снять выделение', onClick: () => { S.ui.acctSel.clear(); rerender(); } }));
}

async function detailsDialog(a) {
  const d = await api('acct.details', { id: a.id });
  if (d.empty) return toast('Сессия не сохранена', 'warn');
  const s = d.summary;
  const rows = d.cookies.sort((x, y) => x.domain.localeCompare(y.domain) || x.name.localeCompare(y.name)).map((c) => h('tr', null,
    h('td', { class: 'mono b' }, c.name), h('td', { class: 'mono small' }, c.domain + (c.path !== '/' ? c.path : '')),
    h('td', { class: 'small nowrap' }, c.expirationDate ? new Date(c.expirationDate * 1000).toLocaleDateString('ru-RU') : h('span', { class: 'warnc', title: 'Временная (сеансовая) куки: браузер стирает её при закрытии. Multipass закрепляет её, пока аккаунт активен.' }, 'временная')),
    h('td', { class: 'small nowrap' }, [c.secure ? 'S' : '', c.httpOnly ? 'H' : '', c.sameSite && c.sameSite !== 'unspecified' ? c.sameSite[0].toUpperCase() : ''].filter(Boolean).join(' ')),
    h('td', { class: 'mono small faint', style: { maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: c.value.slice(0, 500) }, c.value)));
  const storage = Object.entries(d.storage);
  const exp = (format, label) => ({ label, icon: 'download', onClick: async () => { const r = await api('acct.exportCookies', { id: a.id, format }); download(r.text, r.filename, format === 'netscape' ? 'text/plain' : 'application/json'); return false; } });
  modal({ title: `Сессия «${a.name}»`, icon: 'eye', wide: true,
    body: [
      h('div', { class: 'kv' },
        h('span', null, 'Сохранена'), h('span', null, `${new Date(d.savedAt).toLocaleString('ru-RU')} (${ago(d.savedAt)})`),
        h('span', null, 'Где'), h('span', null, [d.browser, d.device].filter(Boolean).join(' · ') || '—'),
        h('span', null, 'Содержимое'), h('span', null, `${s.cookies} куки · ${s.lsKeys} ключей хранилища на ${s.origins} ${plural(s.origins, 'источнике', 'источниках', 'источниках')} · ${bytes(s.size || 0)}`),
        s.temp ? [h('span', null, 'Временные куки'), h('span', null, `${s.temp}${s.tempAuth ? ` (похожих на вход: ${s.tempAuth})` : ''} — закрепляются, пока аккаунт активен`)] : null,
        s.authExpiresAt ? [h('span', null, 'Вход действует до'), h('span', null, new Date(s.authExpiresAt).toLocaleString('ru-RU'))] : null),
      h('div', { class: 'table-wrap', style: { maxHeight: '340px' } }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, ['Имя', 'Домен', 'Истекает', 'Флаги', 'Значение'].map((t) => h('th', null, t)))), h('tbody', null, rows))),
      storage.length ? h('div', { class: 'small muted' }, 'Хранилище: ', storage.map(([o, v], i) => [i ? ', ' : '', h('span', { class: 'mono' }, o), ` (${v.local} LS, ${v.session} SS)`])) : null,
      h('div', { class: 'hint' }, 'S — Secure, H — HttpOnly, L/S/N — SameSite. Значения куки — это доступ к аккаунту, не пересылайте их.'),
    ],
    actions: [
      d.hasPrev ? { label: 'Вернуть прошлую версию', icon: 'clock', onClick: async () => { await api('acct.restorePrev', { id: a.id }); toast('Прошлая версия сессии восстановлена'); } } : null,
      exp('json', 'JSON'), exp('netscape', 'cookies.txt'),
      { label: 'Закрыть', kind: 'primary', onClick: () => null },
    ].filter(Boolean) });
}

function siteDialog(s) {
  const isNew = !s;
  const name = h('input', { class: 'input', value: s?.name || '', placeholder: 'Например, Google', autofocus: true });
  const doms = h('textarea', { class: 'input', rows: 4, value: (s?.domains || []).join('\n'), placeholder: 'google.com\nyoutube.com', spellcheck: false });
  const start = h('input', { class: 'input', value: s?.startUrl || '', placeholder: 'https://… — куда открывать после переключения' });
  const tri = (v) => { const sel = h('select', { class: 'input' }, h('option', { value: '' }, 'Как в настройках'), h('option', { value: 'on' }, 'Включено'), h('option', { value: 'off' }, 'Выключено')); sel.value = v === true ? 'on' : v === false ? 'off' : ''; return sel; };
  const cap = tri(s?.opts?.captureStorage), deep = tri(s?.opts?.deepClean), pin = tri(s?.opts?.pinSession);
  const triVal = (sel) => (sel.value === 'on' ? true : sel.value === 'off' ? false : null);
  modal({ title: isNew ? 'Новый сайт' : `Сайт «${s.name}»`, icon: 'globe',
    body: [field('Название', name),
      field('Домены (по одному в строке)', doms, 'Все домены, между которыми сайт делит вход: например, для Google — google.com и youtube.com. Поддомены включаются автоматически.'),
      isNew ? null : field('Стартовая страница', start),
      isNew ? null : h('div', { class: 'grid2' }, field('Сохранять localStorage', cap), field('Глубокая очистка (IndexedDB, кэш)', deep)),
      isNew ? null : field('Закреплять временные куки', pin, 'Сеансовые куки браузер стирает при закрытии — из-за них вход «слетает». Multipass может превращать их в постоянные, пока аккаунт активен. Выключите для сайтов, где важно, чтобы сеанс заканчивался с закрытием браузера (например, банк).')],
    actions: [{ label: 'Отмена', onClick: () => null }, { label: isNew ? 'Создать' : 'Сохранить', kind: 'primary', onClick: async () => {
      const domains = doms.value.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
      if (isNew) { await api('site.create', { name: name.value, domains }); toast('Сайт добавлен'); return; }
      if (start.value.trim() && !/^https?:\/\//i.test(start.value.trim())) throw new Error('Стартовая страница должна начинаться с http(s)://');
      await api('site.update', { id: s.id, patch: { name: name.value, domains, startUrl: start.value.trim(), opts: { captureStorage: triVal(cap), deepClean: triVal(deep), pinSession: triVal(pin) } } });
      toast('Сохранено');
    } }] });
}

function emptyState() {
  return h('div', { class: 'card' }, h('div', { class: 'empty', style: { padding: '40px 20px' } },
    h('div', { class: 'big' }, icon('users')), h('h4', null, 'Пока нет ни одного аккаунта'),
    h('p', { style: { maxWidth: '520px' } }, 'Откройте сайт, войдите в аккаунт и нажмите на иконку Multipass → «Сохранить вход». Чтобы добавить второй аккаунт — «Новый вход»: текущий сохранится, а сайт откроется без входа.'),
    h('div', { class: 'row' }, btn('Импорт из файла или кода', { icon: 'download', onClick: () => go('transfer') }), btn('Подключить синхронизацию', { icon: 'cloud', onClick: () => go('sync') }))));
}
