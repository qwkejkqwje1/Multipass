// Раздел «Журнал»
import { rpc, h, icon, btn, toast } from '../common.js';

export default {
  id: 'log', title: 'Журнал', icon: 'activity',
  live: ['log'],
  desc: () => 'Переключения, проверки прокси, синхронизация, ошибки — последние 300 событий',
  actions: () => [btn('Очистить', { icon: 'trash', onClick: async () => { await rpc('log.clear'); toast('Журнал очищен'); } })],
  render: () => {
    const wrap = h('div', { class: 'table-wrap' }, h('div', { class: 'empty' }, h('span', { class: 'spinner' })));
    rpc('log').then((list) => {
      wrap.replaceChildren(list.length ? h('table', { class: 'table' }, h('tbody', null, list.map((e) => h('tr', { class: 'logrow' },
        h('td', { class: 'small', style: { width: '150px' } }, new Date(e.t).toLocaleString('ru-RU')),
        h('td', { style: { width: '26px' } }, icon(e.level === 'error' ? 'alert' : e.level === 'warn' ? 'alert' : 'info', 'sm ' + (e.level === 'error' ? 'badc' : e.level === 'warn' ? 'warnc' : 'faint'))),
        h('td', { class: e.level === 'error' ? 'badc' : '' }, e.msg))))) : h('div', { class: 'empty' }, 'Пусто'));
    }).catch((e) => wrap.replaceChildren(h('div', { class: 'note bad' }, e.message)));
    return wrap;
  },
};
