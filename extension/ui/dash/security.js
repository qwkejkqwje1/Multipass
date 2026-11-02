// Раздел «Безопасность»: мастер-пароль, авто-блокировка
import { api, rpc, h, icon, btn, toast, field, note, unlockDialog, confirmDialog } from '../common.js';
import { S, rerender } from './state.js';

export default {
  id: 'security', title: 'Безопасность', icon: 'shield',
  live: ['vaultMeta', 'settings', 'session'],
  desc: () => 'Шифрование сохранённых сессий на диске мастер-паролем',
  render,
};

const pw = (ph, ac = 'new-password') => h('input', { class: 'input', type: 'password', placeholder: ph, autocomplete: ac });

function render(D) {
  const v = D.vault;
  const parts = [];
  if (!v.enabled) {
    const p1 = pw('Мастер-пароль (от 6 символов)'), p2 = pw('Повторите');
    parts.push(h('div', { class: 'card' }, h('h3', null, icon('lock'), 'Мастер-пароль выключен'),
      h('div', { class: 'desc' }, 'Сейчас сессии хранятся в профиле браузера без дополнительного шифрования — как у большинства менеджеров куки. С мастер-паролем куки и localStorage всех аккаунтов шифруются (AES-256-GCM), а ключ живёт только в памяти до закрытия браузера или авто-блокировки.'),
      h('div', { class: 'grid2', style: { maxWidth: '560px' } }, p1, p2),
      h('div', { class: 'row', style: { marginTop: '12px' } }, btn('Включить шифрование', { icon: 'lock', kind: 'primary', onClick: async () => {
        if (p1.value !== p2.value) throw new Error('Пароли не совпадают');
        await api('vault.enable', { password: p1.value });
        toast('Шифрование включено — все сессии перешифрованы');
      } })),
      h('div', { style: { marginTop: '12px' } }, note('warn', 'alert', 'Забытый мастер-пароль не восстановить: сохранённые сессии станут недоступны (в аккаунты можно будет просто войти заново).'))));
  } else {
    const al = h('select', { class: 'input', style: { width: '220px' } }, [[0, 'Никогда (до закрытия браузера)'], [5, 'Через 5 минут'], [15, 'Через 15 минут'], [30, 'Через 30 минут'], [60, 'Через 1 час'], [240, 'Через 4 часа']].map(([m, t]) => h('option', { value: m }, t)));
    al.value = String(D.settings.autoLockMin ?? 30);
    al.addEventListener('change', () => rpc('settings.update', { patch: { autoLockMin: +al.value } }).then(() => toast('Сохранено')));
    parts.push(h('div', { class: 'card' }, h('h3', null, icon(v.locked ? 'lock' : 'unlock'), v.locked ? 'Хранилище заблокировано' : 'Хранилище разблокировано', h('span', { class: 'sp' }),
      v.locked ? btn('Разблокировать', { icon: 'unlock', kind: 'primary', onClick: () => unlockDialog() }) : btn('Заблокировать сейчас', { icon: 'lock', onClick: async () => { await rpc('vault.lock'); toast('Заблокировано', 'info'); } })),
      h('div', { class: 'desc' }, 'Сессии зашифрованы мастер-паролем. Пока хранилище заблокировано, переключение, сохранение и синхронизация спросят пароль.'),
      h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Авто-блокировка при бездействии:'), al)));
    const o = pw('Текущий пароль', 'current-password'), n1 = pw('Новый пароль'), n2 = pw('Повторите новый');
    parts.push(h('div', { class: 'card' }, h('h3', null, icon('key'), 'Сменить мастер-пароль'),
      h('div', { class: 'grid3' }, o, n1, n2),
      h('div', { class: 'row', style: { marginTop: '12px' } }, btn('Сменить', { kind: 'primary', onClick: async () => {
        if (n1.value !== n2.value) throw new Error('Новые пароли не совпадают');
        await api('vault.change', { oldPassword: o.value, newPassword: n1.value });
        toast('Пароль изменён');
      } }))));
    const d = pw('Текущий пароль', 'current-password');
    parts.push(h('div', { class: 'card' }, h('h3', null, icon('unlock'), 'Отключить шифрование'),
      h('div', { class: 'desc' }, 'Сессии будут расшифрованы и сохранены в обычном виде.'),
      h('div', { class: 'row', style: { maxWidth: '520px' } }, h('div', { class: 'grow' }, d), btn('Отключить', { kind: 'danger', onClick: async () => {
        if (!(await confirmDialog({ title: 'Отключить мастер-пароль?', text: 'Сессии будут храниться без шифрования.', ok: 'Отключить' }))) return;
        await api('vault.disable', { password: d.value }); toast('Шифрование отключено', 'info');
      } }))));
  }
  parts.push(h('div', { class: 'card' }, h('h3', null, icon('shield'), 'Что ещё защищено'),
    h('ul', { class: 'small muted', style: { margin: 0, paddingLeft: '18px', lineHeight: '1.8' } },
      h('li', null, 'Синхронизация — сквозное шифрование парольной фразой: хранилище видит только шифротекст.'),
      h('li', null, 'Kill switch и защита WebRTC — реальный IP не утекает при падении прокси (Маршрутизация).'),
      h('li', null, 'Команды расширения принимаются только от его собственных страниц — сайты не могут читать ваши сессии.'),
      h('li', null, 'Файлы и коды переноса шифруются отдельным паролем.'),
      h('li', null, 'Никакой телеметрии и внешних серверов: сеть используется только для проверки прокси и выбранной вами синхронизации.'))));
  return h('div', { class: 'sec' }, parts);
}
