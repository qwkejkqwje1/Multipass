// Раздел «Маршрутизация»: режим, правила сайтов, привязки аккаунтов, kill switch, исключения, проверка маршрута
import { api, h, fill, icon, btn, seg, toggle, toast, field, note, targetSelect, targetLabel, proxyName, statusDot, ccPill, avatar, countryName, describeError, tzMismatch } from '../common.js';
import { S, rerender, go } from './state.js';

const DEFAULT_BYPASS = ['localhost', '127.0.0.1', '::1', '<local>', '*.local', '10.*', '192.168.*', '169.254.*', ...Array.from({ length: 16 }, (_, i) => `172.${16 + i}.*`)];

export default {
  id: 'routing', title: 'Маршрутизация', icon: 'route',
  live: ['proxies', 'proxyStatus', 'proxyState', 'rules', 'accounts', 'local', 'sites'],
  desc: () => 'Какой трафик через какой прокси идёт — и что делать, если прокси упал',
  render,
};

function render(D) {
  return h('div', { class: 'sec' }, modeCard(D), rulesCard(D), bindingsCard(D), h('div', { class: 'grid2', style: { gap: '16px', alignItems: 'start' } }, protectCard(D), bypassCard(D)), testerCard(D));
}

function modeCard(D) {
  const st = D.proxyState, P = D.proxy;
  const gr = P.globalRoute;
  return h('div', { class: 'card' }, h('h3', null, icon('power'), 'Режим'),
    seg([{ value: 'off', label: 'Выключено' }, { value: 'rules', label: 'По правилам и аккаунтам' }, { value: 'global', label: 'Весь браузер через прокси' }], st.mode, (v) => api('proxy.state', { mode: v }), { block: true }),
    h('div', { class: 'hint', style: { marginTop: '8px' } }, {
      off: 'Multipass не трогает настройки прокси: всё идёт напрямую, привязки и правила не действуют.',
      rules: 'Через прокси идут только сайты с правилом и сайты, где активен аккаунт с привязанным прокси. Остальное — напрямую.',
      global: 'Весь браузер через выбранный прокси или группу. Правила и привязки аккаунтов приоритетнее (например, банк — напрямую).',
    }[st.mode]),
    st.mode === 'global' ? h('div', { class: 'row', style: { marginTop: '12px' } }, h('span', { class: 'small muted nowrap' }, 'Через:'),
      P.list.length ? targetSelect({ value: st.target, proxies: P.list, groups: P.groups, none: null, onChange: (v) => api('proxy.state', { target: v }) }) : btn('Добавить прокси', { icon: 'plus', onClick: () => go('proxies') }),
      gr?.proxy ? h('span', { class: 'row small nowrap', style: { gap: '6px' } }, statusDot(gr.proxy.status), ccPill(gr.proxy.status), gr.kind === 'failover' ? h('span', { class: 'warnc' }, `резерв: ${proxyName(gr.proxy)}`) : null) : null,
      gr?.kind === 'empty-group' ? h('span', { class: 'badc small' }, 'в группе нет живых прокси') : null) : null,
    h('div', { class: 'hint', style: { marginTop: '10px' } }, 'Приоритет: исключения → прокси активного аккаунта сайта → правила (сверху вниз) → «весь браузер» → напрямую.'));
}

function rulesCard(D) {
  const P = D.proxy, dr = S.ui.ruleDraft;
  const pat = h('input', { class: 'input mono', placeholder: 'example.com или *.example.com', value: dr.pattern, spellcheck: false });
  pat.addEventListener('input', () => { dr.pattern = pat.value; });
  const tgt = targetSelect({ value: dr.target, proxies: P.list, groups: P.groups, none: null, direct: true, block: true });
  tgt.addEventListener('change', () => { dr.target = tgt.value; });
  const nt = h('input', { class: 'input', placeholder: 'Заметка', value: dr.note });
  nt.addEventListener('input', () => { dr.note = nt.value; });
  const add = btn('Добавить', { icon: 'plus', kind: 'primary', onClick: async () => {
    if (!dr.pattern.trim()) throw new Error('Укажите домен или шаблон');
    await api('rule.add', { pattern: dr.pattern, target: tgt.value, note: dr.note });
    if (D.proxyState.mode === 'off') await api('proxy.state', { mode: 'rules' });
    S.ui.ruleDraft = { pattern: '', target: tgt.value, note: '' };
    toast('Правило добавлено');
  } });
  pat.addEventListener('keydown', (e) => { if (e.key === 'Enter') add.click(); });
  const ids = D.rules.map((r) => r.id);
  const move = async (i, d) => { const a = [...ids]; [a[i], a[i + d]] = [a[i + d], a[i]]; await api('rule.reorder', { ids: a }); };
  const rows = D.rules.map((r, i) => h('tr', { style: r.enabled === false ? { opacity: '.55' } : null },
    h('td', { class: 'nowrap' }, btn('', { size: 'sm', icon: 'up', kind: 'ghost', title: 'Выше', disabled: i === 0, onClick: () => move(i, -1) }), btn('', { size: 'sm', icon: 'down', kind: 'ghost', title: 'Ниже', disabled: i === D.rules.length - 1, onClick: () => move(i, 1) })),
    h('td', null, toggle(r.enabled !== false, (v) => api('rule.update', { id: r.id, patch: { enabled: v } }))),
    h('td', { class: 'mono b' }, r.pattern),
    h('td', { style: { width: '34%' } }, targetSelect({ value: r.target, proxies: P.list, groups: P.groups, none: null, direct: true, block: true, cls: 'input sm', onChange: (v) => api('rule.update', { id: r.id, patch: { target: v } }) })),
    h('td', { class: 'small muted' }, r.note || ''),
    h('td', null, btn('', { size: 'sm', icon: 'trash', kind: 'ghost', title: 'Удалить правило', onClick: () => api('rule.delete', { ids: [r.id] }) }))));
  return h('div', { class: 'card' }, h('h3', null, icon('list'), 'Правила для сайтов', h('span', { class: 'sp' }), h('span', { class: 'small muted', style: { fontWeight: '400' } }, 'Работают в режимах «По правилам» и «Весь браузер»')),
    h('div', { class: 'row', style: { marginBottom: '10px' } }, h('div', { style: { flex: '1.2' } }, pat), h('div', { style: { flex: '1.2' } }, tgt), h('div', { style: { flex: '1' } }, nt), add),
    D.rules.length ? h('div', { class: 'table-wrap rules' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, h('th', { style: { width: '70px' } }, 'Порядок'), h('th', { style: { width: '50px' } }, 'Вкл'), h('th', null, 'Шаблон'), h('th', null, 'Куда'), h('th', null, 'Заметка'), h('th'))), h('tbody', null, rows)))
      : h('div', { class: 'small faint' }, 'Правил пока нет. Примеры: «*.google.com» → группа «US»; «bank.ru» → Напрямую; «tracker.com» → Блокировать. Быстрее всего — из окна Multipass на нужном сайте: вкладка «Прокси» → «Для сайта».'),
    h('div', { class: 'hint', style: { marginTop: '8px' } }, '«example.com» — домен со всеми поддоменами · «*.example.com» — только поддомены · «*» и «?» — маски · «<local>» — адреса без точки.'));
}

function bindingsCard(D) {
  const list = [];
  for (const s of D.sites) for (const a of s.accounts) if (a.proxy) list.push({ a, s });
  if (!list.length) return h('div', { class: 'card' }, h('h3', null, icon('users'), 'Прокси аккаунтов'), h('div', { class: 'small faint' }, 'Ни к одному аккаунту прокси не привязан. Привязка задаётся в карточке аккаунта: пока он активен, его сайт открывается через свой IP — удобно, когда у каждого аккаунта должен быть «свой» адрес.'));
  return h('div', { class: 'card' }, h('h3', null, icon('users'), 'Прокси аккаунтов', h('span', { class: 'sp' }), h('span', { class: 'small muted', style: { fontWeight: '400' } }, 'Действует, пока аккаунт активен на своём сайте')),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('tbody', null, list.map(({ a, s }) => {
      const p = a.proxy.startsWith('proxy:') ? D.proxy.list.find((x) => x.id === a.proxy.slice(6)) : null;
      return h('tr', null, h('td', { style: { width: '36px' } }, avatar(a, { sm: true })), h('td', null, h('div', { class: 'b' }, a.name), h('div', { class: 'tiny faint' }, s.name)),
        h('td', null, h('div', { class: 'row', style: { gap: '6px' } }, p ? statusDot(p.status) : null, h('span', null, targetLabel(a.proxy, D.proxy.list)), p ? ccPill(p.status) : null)),
        h('td', { class: 'small' }, a.active ? h('span', { class: 'pill ok' }, 'действует сейчас') : h('span', { class: 'faint' }, 'включится при переключении')));
    })))));
}

function protectCard(D) {
  const st = D.proxyState;
  const t = (k, title, desc) => h('div', { class: 'toggle-row' }, h('div', { class: 'grow' }, h('div', null, title), h('div', { class: 'hint' }, desc)), toggle(st[k] !== false, (v) => api('proxy.state', { [k]: v })));
  return h('div', { class: 'card' }, h('h3', null, icon('shield'), 'Защита от утечек и падений'),
    t('killSwitch', 'Kill switch', 'Если прокси не отвечает, трафик сайта блокируется, а не уходит напрямую с вашего настоящего IP.'),
    t('failover', 'Авто-резерв для правил и «весь браузер»', 'Упавший прокси подменяется лучшим живым из той же группы.'),
    h('div', { class: 'toggle-row' }, h('div', { class: 'grow' }, h('div', null, 'Авто-резерв для аккаунтов'), h('div', { class: 'hint' }, 'По умолчанию выключен: смена IP у аккаунта может насторожить сайт. Включите, если важнее доступность.')), toggle(st.accountFailover === true, (v) => api('proxy.state', { accountFailover: v }))),
    t('webrtc', 'Защита WebRTC', 'Пока активен прокси, WebRTC не раскрывает реальный IP (запрет UDP в обход прокси).'));
}

function bypassCard(D) {
  if (S.ui.bypassDraft == null) S.ui.bypassDraft = (D.proxyState.bypass || []).join('\n');
  const ta = h('textarea', { class: 'input', rows: 9, value: S.ui.bypassDraft, spellcheck: false });
  ta.addEventListener('input', () => { S.ui.bypassDraft = ta.value; });
  return h('div', { class: 'card' }, h('h3', null, icon('ban'), 'Исключения — всегда напрямую'),
    h('div', { class: 'desc' }, 'Локальная сеть, роутер, корпоративные адреса. По одному шаблону в строке.'), ta,
    h('div', { class: 'row', style: { marginTop: '10px' } },
      btn('Сохранить', { kind: 'primary', size: 'sm', onClick: async () => { await api('proxy.state', { bypass: S.ui.bypassDraft.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) }); S.ui.bypassDraft = null; toast('Исключения сохранены'); } }),
      btn('По умолчанию', { size: 'sm', onClick: () => { S.ui.bypassDraft = DEFAULT_BYPASS.join('\n'); rerender(); } })));
}

function routeText(r, D) {
  if (!r || r.kind === 'off') return ['Прокси выключены — напрямую', ''];
  const s = r.source?.type;
  if (r.kind === 'direct') return [s === 'bypass' ? `Напрямую — исключение «${r.source.pattern}»` : s === 'rule' ? 'Напрямую — по правилу' : s === 'account' ? 'Напрямую — так настроен активный аккаунт' : 'Напрямую — нет подходящих правил', ''];
  if (r.kind === 'block') return ['Заблокировано правилом', 'bad'];
  if (r.kind === 'empty-group') return [`Заблокировано: в группе «${r.group}» нет живых прокси`, 'bad'];
  if (r.kind === 'missing') return ['Заблокировано: прокси удалён', 'bad'];
  const src = s === 'account' ? `аккаунт «${r.source.name}»` : s === 'rule' ? 'правило' : s === 'global' ? 'режим «весь браузер»' : '';
  if (r.kind === 'failover') return [`Через резервный «${proxyName(r.proxy)}» (основной «${proxyName(r.original)}» не отвечает) · ${src}`, 'warn'];
  const dead = r.status?.state === 'dead';
  return [`Через «${proxyName(r.proxy)}»${r.group ? ` из группы «${r.group}»` : ''} · ${src}${dead ? ' · прокси не отвечает' + (D.proxyState.killSwitch !== false ? ' — трафик заблокирован' : ' — пойдёт напрямую') : ''}`, dead ? 'bad' : 'ok'];
}

function testerCard(D) {
  const inp = h('input', { class: 'input mono', placeholder: 'например, mail.google.com', value: S.ui.routeHost, spellcheck: false });
  inp.addEventListener('input', () => { S.ui.routeHost = inp.value; });
  const out = h('div', { style: { marginTop: '10px' } });
  const host = () => S.ui.routeHost.trim().replace(/^[a-z]+:\/\//i, '').replace(/[/:?#].*$/, '').toLowerCase();
  const show = () => {
    const r = S.ui.routeResult;
    if (!r) return fill(out);
    const [text, kind] = routeText(r.route, D);
    const ip = r.ip;
    const mm = ip?.ok ? tzMismatch(ip.tz) : null;
    fill(out, note(kind === 'bad' ? 'bad' : kind === 'warn' ? 'warn' : kind === 'ok' ? 'ok' : 'info', 'route', h('div', { class: 'b' }, r.host), h('div', null, text),
      ip ? (ip.ok ? h('div', { class: 'small', style: { marginTop: '4px' } }, `Сайт увидит IP `, h('b', { class: 'mono' }, ip.ip || '—'), ` · ${[countryName(ip.cc), ip.city].filter(Boolean).join(', ')} · ${ip.latency} мс`) : h('div', { class: 'small badc' }, 'Проверка не прошла: ' + (ip.errorText || describeError(ip.error)))) : null,
      mm ? h('div', { class: 'small warnc', style: { marginTop: '4px' } }, `Часовой пояс браузера ${mm.mine} ≠ пояс IP ${mm.ip}`) : null));
  };
  const check = btn('Проверить маршрут', { icon: 'route', onClick: async () => { const hs = host(); if (!hs) throw new Error('Введите адрес'); S.ui.routeResult = { host: hs, route: await api('proxy.route', { host: hs }) }; show(); } });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') check.click(); });
  show();
  return h('div', { class: 'card' }, h('h3', null, icon('search'), 'Проверить, как пойдёт трафик'),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, inp), check,
      btn('И какой IP увидит сайт', { icon: 'eye', onClick: async () => { const hs = host(); if (!hs) throw new Error('Введите адрес'); const route = await api('proxy.route', { host: hs }); S.ui.routeResult = { host: hs, route, ip: await api('proxy.ip', { host: hs }) }; show(); } })),
    h('div', { class: 'hint', style: { marginTop: '6px' } }, 'IP проверяется запросом к сервису проверки (Настройки → «Адрес проверки») через тот же маршрут, что и у сайта.'),
    out);
}
