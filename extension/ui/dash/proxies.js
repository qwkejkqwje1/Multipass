// Раздел «Прокси»: импорт списком, проверка, таблица, группы
import {
  api, rpc, h, fill, icon, btn, seg, toast, menu, modal, confirmDialog, promptDialog, field, note, statusDot, ccPill, countryName,
  latencyText, proxyName, describeError, copyText, download, pickFile, plural, ago, TYPE_LABEL,
} from '../common.js';
import { S, rerender } from './state.js';

export default {
  id: 'proxies', title: 'Прокси', icon: 'globe',
  live: ['proxies', 'proxyStatus', 'proxyState', 'accounts', 'rules'],
  desc: (D) => { const c = D.proxy.counts; return c.total ? `${c.total} прокси · живых ${c.alive} · мёртвых ${c.dead}${D.proxy.checking ? ` · проверяется ${D.proxy.checking}…` : ''}` : 'Добавьте прокси списком — формат распознается сам'; },
  actions: (D) => D.proxy.counts.total ? [
    btn('Проверить все', { icon: 'zap', kind: 'primary', onClick: async () => { const r = await api('proxy.check', {}); toast(`Живых: ${r.alive} из ${r.total}`); } }),
    D.proxy.counts.dead ? btn(`Удалить мёртвые (${D.proxy.counts.dead})`, { icon: 'trash', kind: 'danger', onClick: async () => {
      if (!(await confirmDialog({ title: 'Удалить мёртвые прокси?', text: `Будут удалены ${D.proxy.counts.dead} прокси, которые не ответили при последней проверке.` }))) return;
      const r = await api('proxy.deleteDead'); toast(`Удалено: ${r.deleted}`);
    } }) : null,
    btn('Экспорт', { icon: 'upload', onClick: (e, b) => exportMenu(b, null) }),
    btn('Добавить вручную', { icon: 'plus', onClick: () => proxyDialog(D, null) }),
  ] : [btn('Добавить вручную', { icon: 'plus', onClick: () => proxyDialog(D, null) })],
  render,
};

function usage(D) {
  const m = {};
  const mark = (t, what) => { if (t?.startsWith('proxy:')) (m[t.slice(6)] ||= []).push(what); };
  for (const s of D.sites) for (const a of s.accounts) mark(a.proxy, `аккаунт «${a.name}» (${s.name})`);
  for (const r of D.rules) if (r.enabled !== false) mark(r.target, `правило ${r.pattern}`);
  if (D.proxyState.mode === 'global') mark(D.proxyState.target, 'весь браузер');
  return m;
}

function render(D) {
  const parts = [];
  if (D.control === 'controlled_by_other_extensions') parts.push(note('bad', 'alert', 'Настройками прокси сейчас управляет другое расширение — отключите его, иначе маршруты Multipass не работают.'));
  if (D.control === 'not_controllable') parts.push(note('bad', 'alert', 'Прокси заблокированы политикой браузера/системы — расширение не может их менять.'));
  parts.push(importCard(D));
  if (D.proxy.list.length) parts.push(tableCard(D));
  return h('div', { class: 'sec' }, parts);
}

function importCard(D) {
  const ta = h('textarea', { class: 'input', rows: 7, spellcheck: false, value: S.ui.pxImport,
    placeholder: 'Вставьте прокси — по одному в строке, форматы можно смешивать:\n1.2.3.4:8080\n1.2.3.4:8080:логин:пароль\nлогин:пароль@1.2.3.4:8080\nsocks5://логин:пароль@host:1080   # подпись после решётки станет названием\nhttps://host:443' });
  ta.addEventListener('input', () => { S.ui.pxImport = ta.value; });
  const type = h('select', { class: 'input' }, Object.entries({ auto: 'Тип: определить автоматически', http: 'HTTP', https: 'HTTPS', socks5: 'SOCKS5', socks4: 'SOCKS4' }).map(([v, t]) => h('option', { value: v }, t)));
  type.value = S.ui.pxImportType;
  type.addEventListener('change', () => { S.ui.pxImportType = type.value; });
  const grp = h('input', { class: 'input', placeholder: 'Группа (для ротации и авто-резерва)', list: 'px-groups', value: S.ui.pxImportGroup });
  grp.addEventListener('input', () => { S.ui.pxImportGroup = grp.value; });
  const chk = h('input', { type: 'checkbox', checked: S.ui.pxImportCheck });
  chk.addEventListener('change', () => { S.ui.pxImportCheck = chk.checked; });
  const res = S.ui.pxImportResult;
  const open = !D.proxy.list.length || S.ui.pxImport || res;
  const det = h('details', { class: 'card' },
    h('summary', { class: 'row', style: { cursor: 'pointer', fontWeight: '650' } }, icon('plus'), 'Добавить прокси списком', h('span', { class: 'sp' }), h('span', { class: 'small muted', style: { fontWeight: '400' } }, 'host:port · host:port:user:pass · user:pass@host:port · схемы http/https/socks4/socks5')),
    h('div', { class: 'col', style: { marginTop: '12px', gap: '10px' } },
      ta,
      h('datalist', { id: 'px-groups' }, D.proxy.groups.map((g) => h('option', { value: g }))),
      h('div', { class: 'row wrap' },
        h('div', { style: { width: '260px' } }, type), h('div', { style: { width: '280px' } }, grp),
        h('label', { class: 'check small' }, chk, 'Сразу проверить'), h('span', { class: 'sp' }),
        btn('Из файла…', { icon: 'file', onClick: async () => { const f = await pickFile('.txt,.csv,.list,text/plain'); if (f) { S.ui.pxImport = (S.ui.pxImport ? S.ui.pxImport + '\n' : '') + f.text; rerender(); } } }),
        btn('По ссылке…', { icon: 'link', onClick: async () => {
          const url = await promptDialog({ title: 'Загрузить список по ссылке', label: 'Адрес текстового списка', placeholder: 'https://…/proxies.txt', ok: 'Загрузить', hint: 'Например, ссылка на список у вашего провайдера прокси (API выдачи в формате txt).' });
          if (!url) return;
          const text = await api('proxy.fetchList', { url: url.trim() });
          S.ui.pxImport = (S.ui.pxImport ? S.ui.pxImport + '\n' : '') + text; rerender();
          toast(`Загружено строк: ${text.split(/\r?\n/).filter((l) => l.trim()).length}`);
        } }),
        btn('Добавить', { icon: 'plus', kind: 'primary', onClick: async () => {
          if (!S.ui.pxImport.trim()) throw new Error('Вставьте хотя бы один прокси');
          const r = await api('proxy.import', { text: S.ui.pxImport, defaultType: S.ui.pxImportType, group: S.ui.pxImportGroup, autoCheck: S.ui.pxImportCheck });
          S.ui.pxImportResult = r;
          if (r.added) S.ui.pxImport = r.errors.length ? r.errors.map((e) => e.raw).join('\n') : '';
          toast(`Добавлено: ${r.added}${r.duplicates ? ` · дубликатов: ${r.duplicates}` : ''}${r.errors.length ? ` · не распознано: ${r.errors.length}` : ''}`, r.errors.length ? 'warn' : 'ok');
          rerender();
        } })),
      res ? note(res.errors.length ? 'warn' : 'ok', res.errors.length ? 'alert' : 'check',
        h('div', { class: 'b' }, `Добавлено ${res.added}${res.duplicates ? `, уже были в списке: ${res.duplicates}` : ''}${res.errors.length ? `, не распознано: ${res.errors.length} (оставлены в поле для исправления)` : ''}`),
        res.errors.slice(0, 8).map((e) => h('div', { class: 'small mono' }, `строка ${e.line}: ${e.reason} — ${e.raw.slice(0, 80)}`)),
        h('a', { href: '#', class: 'small', onClick: (e) => { e.preventDefault(); S.ui.pxImportResult = null; rerender(); } }, 'Скрыть')) : null,
      h('div', { class: 'hint' }, 'Проверка идёт через сам прокси: определяется тип (HTTP/SOCKS), внешний IP, страна, задержка. Мёртвые помечаются красным; используемые прокси перепроверяются в фоне, при падении — авто-резерв из той же группы.')));
  det.open = !!open;
  return det;
}

const RANK = { alive: 0, unknown: 1, dead: 2 };
function tableCard(D) {
  const use = usage(D);
  const q = S.ui.pxQuery.trim().toLowerCase();
  let list = D.proxy.list.filter((p) => {
    const st = p.status?.state || 'unknown';
    if (S.ui.pxStatus !== 'all' && st !== S.ui.pxStatus) return false;
    if (S.ui.pxGroup !== '*' && (p.group || '') !== S.ui.pxGroup) return false;
    if (!q) return true;
    return [p.name, p.host, String(p.port), p.group, p.status?.ip, p.status?.cc, countryName(p.status?.cc), p.status?.city, p.status?.isp].join(' ').toLowerCase().includes(q);
  });
  const { key, dir } = S.ui.pxSort;
  const val = (p) => key === 'name' ? proxyName(p).toLowerCase() : key === 'group' ? (p.group || '') : key === 'cc' ? (p.status?.cc || 'zz')
    : key === 'latency' ? (p.status?.state === 'alive' ? p.status.latency : 1e9) : RANK[p.status?.state || 'unknown'] * 1e7 + (p.status?.latency || 0);
  list.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
  const ids = new Set(D.proxy.list.map((p) => p.id));
  for (const id of [...S.ui.pxSel]) if (!ids.has(id)) S.ui.pxSel.delete(id);

  const search = h('input', { class: 'input', type: 'search', placeholder: 'Поиск: имя, IP, страна, город, группа…', value: S.ui.pxQuery, spellcheck: false });
  const tbodyWrap = h('tbody');
  const grpSel = h('select', { class: 'input', style: { width: '190px' } }, h('option', { value: '*' }, 'Все группы'), h('option', { value: '' }, 'Без группы'), D.proxy.groups.map((g) => h('option', { value: g }, g)));
  grpSel.value = S.ui.pxGroup;
  grpSel.addEventListener('change', () => { S.ui.pxGroup = grpSel.value; rerender(); });
  const drawRows = () => {
    const qq = S.ui.pxQuery.trim().toLowerCase();
    const shown = (qq === q ? list : list.filter((p) => [p.name, p.host, String(p.port), p.group, p.status?.ip, p.status?.cc, countryName(p.status?.cc), p.status?.city, p.status?.isp].join(' ').toLowerCase().includes(qq)));
    fill(tbodyWrap, shown.slice(0, S.ui.pxLimit).map((p) => row(D, p, use[p.id])),
      shown.length > S.ui.pxLimit ? h('tr', null, h('td', { colspan: 10, style: { textAlign: 'center' } }, btn(`Показать ещё (${shown.length - S.ui.pxLimit})`, { size: 'sm', onClick: () => { S.ui.pxLimit += 500; rerender(); } }))) : null,
      !shown.length ? h('tr', null, h('td', { colspan: 10 }, h('div', { class: 'empty' }, 'Ничего не найдено'))) : null);
  };
  search.addEventListener('input', () => { S.ui.pxQuery = search.value; drawRows(); });
  drawRows();
  const th = (label, k, cls = '') => {
    const e = h('th', { class: cls, style: k ? { cursor: 'pointer' } : null }, label, k && key === k ? (dir > 0 ? ' ↑' : ' ↓') : '');
    if (k) e.addEventListener('click', () => { S.ui.pxSort = { key: k, dir: key === k ? -dir : 1 }; rerender(); });
    return e;
  };
  const allCb = h('input', { type: 'checkbox', checked: list.length > 0 && list.every((p) => S.ui.pxSel.has(p.id)) });
  allCb.addEventListener('change', () => { for (const p of list) allCb.checked ? S.ui.pxSel.add(p.id) : S.ui.pxSel.delete(p.id); rerender(); });
  const sel = [...S.ui.pxSel];
  return h('div', { class: 'sec', style: { gap: '10px' } },
    h('div', { class: 'toolbar' },
      h('div', { class: 'search' }, icon('search'), search), grpSel,
      seg([{ value: 'all', label: 'Все' }, { value: 'alive', label: 'Живые' }, { value: 'dead', label: 'Мёртвые' }, { value: 'unknown', label: 'Не проверены' }], S.ui.pxStatus, (v) => { S.ui.pxStatus = v; rerender(); }),
      h('span', { class: 'sp' }), h('span', { class: 'small muted' }, `Показано: ${list.length}`)),
    sel.length ? h('div', { class: 'bulk' }, h('b', null, `Выбрано: ${sel.length}`), h('span', { class: 'sp' }),
      btn('Проверить', { size: 'sm', icon: 'zap', onClick: async () => { const r = await api('proxy.check', { ids: sel }); toast(`Живых: ${r.alive} из ${r.total}`); } }),
      btn('В группу…', { size: 'sm', icon: 'layers', onClick: async () => {
        const g = await promptDialog({ title: 'Переместить в группу', label: 'Название группы (пусто — без группы)', value: '', ok: 'Применить', hint: 'Группа — пул для ротации и авто-резерва. Её можно назначить аккаунту или правилу: возьмётся лучший живой прокси.' });
        if (g == null) return;
        for (const id of sel) await api('proxy.update', { id, patch: { group: g.trim() } });
        toast('Готово');
      } }),
      btn('Экспорт', { size: 'sm', icon: 'upload', onClick: (e, b) => exportMenu(b, sel) }),
      btn('Удалить', { size: 'sm', icon: 'trash', kind: 'danger', onClick: async () => {
        if (!(await confirmDialog({ title: `Удалить ${sel.length} прокси?`, text: 'Аккаунты и правила, которые на них ссылаются, останутся без прокси (при включённом kill switch их трафик будет заблокирован).' }))) return;
        await api('proxy.delete', { ids: sel }); S.ui.pxSel.clear(); toast('Удалено');
      } }),
      btn('', { size: 'sm', icon: 'x', kind: 'ghost', title: 'Снять выделение', onClick: () => { S.ui.pxSel.clear(); rerender(); } })) : null,
    h('div', { class: 'table-wrap', style: { maxHeight: 'calc(100vh - 170px)' } }, h('table', { class: 'table ptable' },
      h('thead', null, h('tr', null, h('th', { style: { width: '28px' } }, allCb), th('', 'status'), th('Название', 'name'), th('Тип'), th('Адрес'), th('Группа', 'group'), th('IP · страна', 'cc'), th('Задержка', 'latency', 'num'), th('Проверен'), h('th'))),
      tbodyWrap)));
}

function row(D, p, used) {
  const st = p.status;
  const cb = h('input', { type: 'checkbox', checked: S.ui.pxSel.has(p.id) });
  cb.addEventListener('change', () => { cb.checked ? S.ui.pxSel.add(p.id) : S.ui.pxSel.delete(p.id); rerender(); });
  const typeTxt = p.type === 'auto' ? (st?.detected ? TYPE_LABEL[st.detected] : 'авто') : TYPE_LABEL[p.type] || p.type;
  return h('tr', { class: S.ui.pxSel.has(p.id) ? 'sel' : '' },
    h('td', null, cb),
    h('td', null, statusDot(st)),
    h('td', { style: { maxWidth: '260px' } },
      h('div', { class: 'row', style: { gap: '6px' } }, h('span', { class: 'b ellipsis', title: proxyName(p) }, proxyName(p)), p.hasAuth ? h('span', { title: 'С логином и паролем' }, icon('key', 'sm faint')) : null),
      used ? h('div', { class: 'tiny accent', style: { color: 'var(--accent-text)' }, title: used.join('\n') }, `используется: ${used.length > 1 ? used.length + ' места' : used[0]}`) : null),
    h('td', { class: 'small nowrap' }, typeTxt),
    h('td', { class: 'addr nowrap' }, `${p.host.includes(':') ? `[${p.host}]` : p.host}:${p.port}`),
    h('td', { class: 'small' }, p.group ? h('span', { class: 'pill' }, p.group) : h('span', { class: 'faint' }, '—')),
    h('td', { class: 'small' }, st?.ip ? h('div', { class: 'row', style: { gap: '6px' } }, ccPill(st), h('span', { class: 'mono' }, st.ip)) : h('span', { class: 'faint' }, '—'),
      st?.city || st?.isp ? h('div', { class: 'tiny faint ellipsis', style: { maxWidth: '220px' }, title: [countryName(st.cc), st.city, st.isp].filter(Boolean).join(' · ') }, [st.city, st.isp].filter(Boolean).join(' · ')) : null),
    h('td', { class: 'num small nowrap' }, st?.state === 'dead' ? h('span', { class: 'err', title: st.error }, describeError(st.error) || 'не отвечает') : latencyText(st)),
    h('td', { class: 'small faint nowrap' }, st?.at ? ago(st.at) : '—'),
    h('td', null, btn('', { size: 'sm', icon: 'more', kind: 'ghost', title: 'Действия', onClick: (e, b) => menu(b, [
      { label: 'Проверить', icon: 'zap', onClick: async () => { const r = await api('proxy.check', { ids: [p.id] }); toast(r.alive ? `«${proxyName(p)}» работает` : `«${proxyName(p)}» не отвечает`, r.alive ? 'ok' : 'bad'); } },
      { label: 'Изменить…', icon: 'edit', onClick: () => proxyDialog(D, p) },
      { label: 'Весь браузер через него', icon: 'globe', onClick: async () => { await api('proxy.state', { mode: 'global', target: 'proxy:' + p.id }); toast(`Весь браузер → ${proxyName(p)}`); } },
      { label: 'Копировать как URL', icon: 'copy', onClick: async () => { await copyText(await rpc('proxy.export', { ids: [p.id], style: 'url' })); toast('Скопировано'); } },
      { label: 'Копировать host:port:user:pass', icon: 'copy', onClick: async () => { await copyText((await rpc('proxy.export', { ids: [p.id], style: 'colon' })).replace(/\s+#.*$/, '')); toast('Скопировано'); } },
      'sep',
      { label: 'Удалить', icon: 'trash', danger: true, onClick: async () => { await api('proxy.delete', { ids: [p.id] }); toast('Удалено'); } },
    ]) })));
}

function exportMenu(anchor, ids) {
  const get = (style) => rpc('proxy.export', { ids, style });
  menu(anchor, [
    { label: 'Копировать (scheme://user:pass@host:port)', icon: 'copy', onClick: async () => { await copyText(await get('url')); toast('Список скопирован'); } },
    { label: 'Копировать (host:port:user:pass)', icon: 'copy', onClick: async () => { await copyText(await get('colon')); toast('Список скопирован'); } },
    { label: 'Скачать .txt', icon: 'download', onClick: async () => download(await get('url'), 'proxies.txt', 'text/plain') },
  ]);
}

function proxyDialog(D, p) {
  const isNew = !p;
  const raw = (p && D.proxies.find((x) => x.id === p.id)) || {};
  const f = {
    name: h('input', { class: 'input', value: p?.name || '', placeholder: 'Например, DE-1 (необязательно)' }),
    type: h('select', { class: 'input' }, Object.entries({ auto: 'Определить автоматически', http: 'HTTP', https: 'HTTPS (TLS до прокси)', socks5: 'SOCKS5', socks4: 'SOCKS4' }).map(([v, t]) => h('option', { value: v }, t))),
    host: h('input', { class: 'input mono', value: p?.host || '', placeholder: '1.2.3.4 или proxy.example.com', autofocus: true, spellcheck: false }),
    port: h('input', { class: 'input mono', type: 'number', min: 1, max: 65535, value: p?.port || '' }),
    user: h('input', { class: 'input', value: raw.username || '', placeholder: 'необязательно', autocomplete: 'off', spellcheck: false }),
    pass: h('input', { class: 'input', type: 'password', value: raw.password || '', placeholder: 'необязательно', autocomplete: 'new-password' }),
    group: h('input', { class: 'input', value: p?.group || '', list: 'px-groups-dlg' }),
  };
  f.type.value = p?.type || 'auto';
  const show = h('input', { type: 'checkbox' });
  show.addEventListener('change', () => { f.pass.type = show.checked ? 'text' : 'password'; });
  modal({ title: isNew ? 'Новый прокси' : `Прокси «${proxyName(p)}»`, icon: 'globe',
    body: [h('div', { class: 'grid2' }, field('Хост', f.host), field('Порт', f.port)), field('Тип', f.type),
      h('div', { class: 'grid2' }, field('Логин', f.user), field('Пароль', f.pass)),
      h('label', { class: 'check small' }, show, 'Показать пароль'),
      h('div', { class: 'grid2' }, field('Название', f.name), field('Группа', f.group)),
      h('datalist', { id: 'px-groups-dlg' }, D.proxy.groups.map((g) => h('option', { value: g }))),
      h('div', { class: 'hint' }, 'SOCKS5 с логином и паролем Chrome не поддерживает — используйте HTTP-доступ того же провайдера или авторизацию по IP.')],
    actions: [
      { label: 'Отмена', onClick: () => null },
      { label: isNew ? 'Добавить' : 'Сохранить', kind: 'primary', onClick: async () => {
        const next = { name: f.name.value.trim(), type: f.type.value, host: f.host.value.trim().toLowerCase(), port: +f.port.value, group: f.group.value.trim(), username: f.user.value.trim(), password: f.pass.value };
        if (!next.host || !(next.port > 0 && next.port < 65536)) throw new Error('Укажите хост и порт');
        if (isNew) { if (!next.name) delete next.name; await api('proxy.add', next); toast('Прокси добавлен — проверяем…'); return; }
        if (!next.name || next.name === `${raw.host}:${raw.port}`) next.name = `${next.host}:${next.port}`;
        const patch = {};
        for (const [k, v] of Object.entries(next)) if (String(raw[k] ?? '') !== String(v)) patch[k] = v;
        if (!Object.keys(patch).length) return;
        await api('proxy.update', { id: p.id, patch });
        if (['type', 'host', 'port', 'username', 'password'].some((k) => k in patch)) api('proxy.check', { ids: [p.id] }).catch(() => {});
        toast('Сохранено');
      } },
    ] });
}
