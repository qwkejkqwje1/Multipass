// Раздел «Настройки»
import { rpc, api, h, icon, btn, seg, toggle, toast, field, note, confirmDialog, promptDialog } from '../common.js';

export default {
  id: 'settings', title: 'Настройки', icon: 'sliders',
  live: ['settings', 'local'],
  desc: () => 'Переключение, временные куки, интерфейс, проверка прокси',
  render,
};

const set = (patch) => rpc('settings.update', { patch }).then(() => toast('Сохранено', 'ok', 1500));

function render(D) {
  const s = D.settings;
  const t = (k, title, desc) => h('div', { class: 'toggle-row' }, h('div', { class: 'grow' }, h('div', null, title), desc ? h('div', { class: 'hint' }, desc) : null), toggle(!!s[k], (v) => set({ [k]: v })));
  const num = (k, attrs) => { const e = h('input', { class: 'input', type: 'number', value: s[k], ...attrs }); e.addEventListener('change', () => set({ [k]: +e.value })); return e; };
  const url = h('input', { class: 'input mono', value: s.checkUrl, spellcheck: false });
  url.addEventListener('change', () => { if (!/^https?:\/\//.test(url.value.trim())) return toast('Нужен адрес http(s)://', 'bad'); set({ checkUrl: url.value.trim() }); });
  const dev = h('input', { class: 'input', value: D.device.name, maxlength: 60 });
  dev.addEventListener('change', () => rpc('device.rename', { name: dev.value }).then(() => toast('Сохранено', 'ok', 1500)));
  const cmds = h('div', { class: 'kv' });
  chrome.commands.getAll().then((list) => {
    const names = { _execute_action: 'Открыть окно Multipass', 'next-account': 'Следующий аккаунт на сайте', 'rotate-proxy': 'Сменить прокси (IP)', 'toggle-proxy': 'Прокси вкл/выкл', 'clean-login': 'Новый вход на сайте' };
    for (const c of list) cmds.append(h('span', null, names[c.name] || c.description || c.name), h('span', null, c.shortcut ? h('span', { class: 'kbd' }, c.shortcut) : h('span', { class: 'faint' }, 'не назначено')));
  });
  return h('div', { class: 'sec' },
    h('div', { class: 'card' }, h('h3', null, icon('swap'), 'Переключение аккаунтов'),
      t('autosaveOnSwitch', 'Автосохранение перед переключением', 'Текущая сессия записывается в активный аккаунт — новые куки (например, продлённый вход) не теряются. Если вход на сайте уже слетел (пропали куки входа), хорошая сохранённая сессия не перезаписывается.'),
      t('captureStorage', 'Сохранять localStorage и sessionStorage', 'Нужно многим современным сайтам (Discord, Telegram Web, панели рекламы). Можно отключить для отдельного сайта.'),
      t('deepClean', 'Глубокая очистка при переключении', 'Удаляет IndexedDB, кэш и Service Worker сайта, чтобы не осталось следов прошлого аккаунта. Чуть дольше загрузка после переключения.'),
      t('discardOtherTabs', 'Выгружать другие вкладки сайта', 'Чтобы в соседних вкладках не продолжал работать прошлый аккаунт и не перезаписал куки.'),
      t('closePopupAfterSwitch', 'Закрывать окно после переключения'),
      t('confirmDelete', 'Спрашивать подтверждение при удалении')),
    h('div', { class: 'card' }, h('h3', null, icon('clock'), 'Временные куки — чтобы вход не слетал'),
      h('div', { class: 'hint', style: { marginBottom: '6px' } }, 'Многие сайты ставят куки входа «до закрытия браузера» (сеансовые). Браузер стирает их при выходе — и после перезапуска аккаунт разлогинен, а переключение на него «не держится».'),
      t('pinSessionCookies', 'Закреплять временные куки активного аккаунта', 'Multipass превращает сеансовые куки сайтов с активным аккаунтом в постоянные и продлевает их каждые 12 часов. В сохранённые сессии они попадают как временные. Для отдельного сайта можно выключить в «Настройках сайта».'),
      h('div', { class: 'toggle-row' }, h('div', { class: 'grow' }, h('div', null, 'Срок закрепления, дней'), h('div', { class: 'hint' }, 'От 1 до 399 (больше Chrome не разрешает). Пока аккаунт активен, срок продлевается сам.')),
        h('div', { style: { width: '110px' } }, num('pinDays', { min: 1, max: 399, step: 1 }))),
      t('restoreSessionOnStartup', 'Возвращать вход при запуске браузера', 'Если временные куки всё-таки пропали (закрепление было выключено, браузер закрыли до закрепления), Multipass вернёт их из сохранённой сессии активного аккаунта и перезагрузит открытые вкладки сайта.')),
    h('div', { class: 'card' }, h('h3', null, icon('eye'), 'Интерфейс'),
      h('div', { class: 'toggle-row' }, h('div', { class: 'grow' }, h('div', null, 'Тема')), seg([{ value: 'auto', label: 'Как в системе' }, { value: 'dark', label: 'Тёмная' }, { value: 'light', label: 'Светлая' }], s.theme || 'auto', (v) => set({ theme: v }))),
      t('badge', 'Инициалы аккаунта на иконке', 'Сразу видно, под каким аккаунтом открыт сайт; красный «!» — прокси сайта не отвечает.'),
      t('notifications', 'Уведомления', 'Падение и восстановление прокси, ошибки синхронизации.'),
      h('div', { class: 'toggle-row' }, h('div', { class: 'grow' }, h('div', null, 'Имя этого браузера'), h('div', { class: 'hint' }, 'Видно в других браузерах при синхронизации.')), h('div', { style: { width: '300px' } }, dev))),
    h('div', { class: 'card' }, h('h3', null, icon('zap'), 'Проверка и мониторинг прокси'),
      h('div', { class: 'col', style: { gap: '12px' } },
        field('Адрес проверки', url, 'Должен вернуть JSON с IP и страной. По умолчанию ip-api.com (бесплатный, без ключа, http). Альтернативы: https://ipinfo.io/json, https://api.ip.sb/geoip'),
        h('div', { class: 'grid3' },
          field('Таймаут проверки, мс', num('checkTimeoutMs', { min: 2000, max: 60000, step: 1000 })),
          field('Параллельных проверок', num('checkConcurrency', { min: 1, max: 50 })),
          field('Мониторинг используемых, мин', num('monitorIntervalMin', { min: 0.5, max: 60, step: 0.5 }), 'Как часто перепроверять прокси, через которые идёт трафик'),
          field('Перепроверка всего списка, мин', num('recheckAllMin', { min: 0, max: 1440 }), '0 — не перепроверять')))),
    h('div', { class: 'card' }, h('h3', null, icon('zap'), 'Горячие клавиши'), cmds,
      h('div', { class: 'row', style: { marginTop: '10px' } }, btn('Изменить сочетания', { icon: 'external', onClick: () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }) }))),
    h('div', { class: 'card', style: { borderColor: 'rgba(239,68,68,.35)' } }, h('h3', null, icon('alert'), 'Опасная зона'),
      h('div', { class: 'row' }, h('div', { class: 'grow small muted' }, 'Удалить все аккаунты, сессии, прокси, правила и настройки в этом браузере. Хранилище синхронизации не затрагивается (но синхронизация будет отключена).'),
        btn('Удалить все данные', { kind: 'dangerfill', icon: 'trash', onClick: async () => {
          const v = await promptDialog({ title: 'Удалить все данные?', label: 'Введите УДАЛИТЬ для подтверждения', ok: 'Удалить навсегда' });
          if (v == null) return;
          if (v.trim().toUpperCase() !== 'УДАЛИТЬ') throw new Error('Не подтверждено');
          await api('data.wipe'); toast('Все данные удалены', 'info'); setTimeout(() => location.reload(), 600);
        } }))));
}
