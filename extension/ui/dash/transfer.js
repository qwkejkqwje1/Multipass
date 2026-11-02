// Раздел «Перенос»: экспорт/импорт файлом или кодом (с паролем), импорт куки из других расширений
import { api, h, fill, icon, btn, seg, toast, field, note, confirmDialog, copyText, download, pickFile, plural, bytes } from '../common.js';
import { S, rerender, go } from './state.js';

export default {
  id: 'transfer', title: 'Перенос', icon: 'transfer',
  live: ['sites', 'accounts'],
  desc: () => 'Перенести аккаунты в другой браузер без облака — файлом или текстовым кодом. Или забрать куки из Cookie-Editor и подобных.',
  render: (D) => h('div', { class: 'sec' }, exportCard(D), importCard(D), cookiesCard(D)),
};

function exportCard(D) {
  const total = D.sites.reduce((n, s) => n + s.accounts.length, 0);
  if (!S.ui.exportSel) S.ui.exportSel = new Set();
  if (S.ui.exportProxies == null) S.ui.exportProxies = true;
  if (S.ui.exportRules == null) S.ui.exportRules = true;
  const pick = S.ui.exportMode === 'pick';
  const pass = h('input', { class: 'input', type: 'password', placeholder: 'рекомендуется', value: S.ui.exportPass || '', autocomplete: 'new-password' });
  pass.addEventListener('input', () => { S.ui.exportPass = pass.value; });
  const cb = (k, label) => { const e = h('input', { type: 'checkbox', checked: S.ui[k] }); e.addEventListener('change', () => { S.ui[k] = e.checked; }); return h('label', { class: 'check' }, e, label); };
  const list = pick ? h('div', { class: 'checklist' }, D.sites.map((s) => {
    const all = s.accounts.length && s.accounts.every((a) => S.ui.exportSel.has(a.id));
    const sc = h('input', { type: 'checkbox', checked: all });
    sc.addEventListener('change', () => { s.accounts.forEach((a) => (sc.checked ? S.ui.exportSel.add(a.id) : S.ui.exportSel.delete(a.id))); rerender(); });
    return h('div', null, h('label', { class: 'check grp' }, sc, s.name),
      s.accounts.map((a) => { const c = h('input', { type: 'checkbox', checked: S.ui.exportSel.has(a.id) }); c.addEventListener('change', () => { c.checked ? S.ui.exportSel.add(a.id) : S.ui.exportSel.delete(a.id); rerender(); }); return h('label', { class: 'check small' }, c, a.name, a.session ? '' : h('span', { class: 'faint' }, ' (без сессии)')); }));
  })) : null;
  const run = async (as) => {
    const ids = pick ? [...S.ui.exportSel] : null;
    if (pick && !ids.length) throw new Error('Выберите аккаунты');
    if (!S.ui.exportPass && !(await confirmDialog({ title: 'Экспорт без пароля?', text: 'Куки будут в открытом виде: любой, кто получит файл или код, войдёт в ваши аккаунты.', ok: 'Всё равно без пароля' }))) return;
    const r = await api('bundle.export', { accountIds: ids, includeProxies: S.ui.exportProxies, includeRules: S.ui.exportRules, password: S.ui.exportPass || '', as });
    if (as === 'file') { download(r.text, r.filename); toast(`Файл сохранён: ${r.accounts} акк., ${r.proxies} прокси`); }
    else { S.ui.exportCode = r; rerender(); }
  };
  const code = S.ui.exportCode;
  return h('div', { class: 'card' }, h('h3', null, icon('upload'), 'Экспорт'),
    h('div', { class: 'col', style: { gap: '12px', maxWidth: '720px' } },
      seg([{ value: 'all', label: `Все аккаунты (${total})` }, { value: 'pick', label: pick ? `Выбранные (${S.ui.exportSel.size})` : 'Выбрать…' }], S.ui.exportMode, (v) => { S.ui.exportMode = v; rerender(); }),
      list,
      h('div', { class: 'row wrap', style: { gap: '18px' } }, cb('exportProxies', `Прокси (${D.proxy.counts.total})`), cb('exportRules', `Правила (${D.rules.length})`)),
      field('Пароль на файл/код', pass, 'Шифрование AES-256-GCM. Пароль понадобится при импорте — передайте его отдельно от файла.'),
      h('div', { class: 'row' }, btn('Скачать файл', { icon: 'download', kind: 'primary', onClick: () => run('file') }), btn('Получить код', { icon: 'copy', onClick: () => run('code') }),
        h('span', { class: 'small muted' }, 'Код — одна строка текста: удобно вставить в мессенджер «себе» и открыть в другом браузере.')),
      code ? h('div', { class: 'col' },
        h('div', { class: 'row' }, h('b', { class: 'grow small' }, `Код: ${code.accounts} акк., ${code.proxies} прокси · ${bytes(code.text.length)}${code.text.startsWith('MPX1.') ? ' · зашифрован' : ' · БЕЗ пароля'}`),
          btn('Копировать', { size: 'sm', icon: 'copy', kind: 'primary', onClick: async () => { await copyText(code.text); toast('Код скопирован'); } }),
          btn('', { size: 'sm', icon: 'x', kind: 'ghost', title: 'Скрыть', onClick: () => { S.ui.exportCode = null; rerender(); } })),
        code.text.length > 300000 ? note('warn', 'alert', 'Код очень большой — некоторые мессенджеры его обрежут. Надёжнее перенести файлом.') : null,
        h('div', { class: 'codebox' }, code.text.length > 4000 ? code.text.slice(0, 4000) + '…' : code.text)) : null));
}

function importCard(D) {
  const ta = h('textarea', { class: 'input', rows: 5, spellcheck: false, value: S.ui.importText, placeholder: 'Вставьте код MPX1./MPX0. или содержимое файла Multipass (.json)' });
  ta.addEventListener('input', () => { S.ui.importText = ta.value; });
  const pass = h('input', { class: 'input', type: 'password', placeholder: 'если файл/код зашифрован', autocomplete: 'off', value: S.ui.importPass || '' });
  pass.addEventListener('input', () => { S.ui.importPass = pass.value; });
  const r = S.ui.importResult;
  return h('div', { class: 'card' }, h('h3', null, icon('download'), 'Импорт'),
    h('div', { class: 'col', style: { gap: '12px', maxWidth: '720px' } },
      ta,
      h('div', { class: 'row' }, h('div', { style: { width: '300px' } }, pass),
        btn('Выбрать файл…', { icon: 'file', onClick: async () => { const f = await pickFile('.json,.mpvault,application/json'); if (f) { S.ui.importText = f.text; rerender(); toast(`Загружен файл ${f.name}`, 'info'); } } }),
        btn('Импортировать', { icon: 'download', kind: 'primary', onClick: async () => {
          if (!S.ui.importText.trim()) throw new Error('Вставьте код или выберите файл');
          try { S.ui.importResult = await api('bundle.import', { text: S.ui.importText, password: S.ui.importPass || '' }); }
          catch (e) { if (e.code === 'NEED_PASSWORD') { pass.focus(); throw new Error('Файл зашифрован — введите пароль'); } throw e; }
          S.ui.importText = ''; S.ui.importPass = '';
          toast('Импорт завершён'); rerender();
        } })),
      r ? note('ok', 'check', h('div', { class: 'b' }, `Импортировано${r.from ? ` из «${r.from}»` : ''}:`),
        h('div', { class: 'small' }, `аккаунтов ${r.accounts} (сессий ${r.sessions}), сайтов ${r.sites}, прокси ${r.proxies}, правил ${r.rules}${r.skipped ? ` · пропущено более старых: ${r.skipped}` : ''}`),
        h('a', { href: '#accounts', class: 'small' }, 'Открыть аккаунты →')) : null,
      h('div', { class: 'hint' }, 'Повторный импорт безопасен: записи сливаются по последнему изменению, дубли прокси не создаются.')));
}

function cookiesCard(D) {
  const ta = h('textarea', { class: 'input', rows: 5, spellcheck: false, value: S.ui.ckText, placeholder: 'JSON из Cookie-Editor / EditThisCookie / J2TEAM, Playwright storageState или cookies.txt (Netscape)' });
  ta.addEventListener('input', () => { S.ui.ckText = ta.value; });
  const name = h('input', { class: 'input', placeholder: 'Название аккаунта', value: S.ui.ckName });
  name.addEventListener('input', () => { S.ui.ckName = name.value; });
  const host = h('input', { class: 'input mono', placeholder: 'домен (определится сам)', value: S.ui.ckHost, spellcheck: false });
  host.addEventListener('input', () => { S.ui.ckHost = host.value; });
  return h('div', { class: 'card' }, h('h3', null, icon('cookie'), 'Импорт куки как нового аккаунта'),
    h('div', { class: 'desc' }, 'Например, аккаунты, купленные/выгруженные в виде куки, или сессии из Playwright/Puppeteer. Можно потом переключаться на них, как на обычные.'),
    h('div', { class: 'col', style: { gap: '12px', maxWidth: '720px' } }, ta,
      h('div', { class: 'row' }, h('div', { class: 'grow' }, name), h('div', { class: 'grow' }, host),
        btn('Файл…', { icon: 'file', onClick: async () => { const f = await pickFile('.json,.txt'); if (f) { S.ui.ckText = f.text; rerender(); } } }),
        btn('Импортировать', { icon: 'download', kind: 'primary', onClick: async () => {
          if (!S.ui.ckText.trim()) throw new Error('Вставьте куки');
          const r = await api('bundle.importCookies', { text: S.ui.ckText, name: S.ui.ckName, host: S.ui.ckHost.trim() });
          S.ui.ckText = ''; S.ui.ckName = ''; S.ui.ckHost = '';
          toast(`Аккаунт «${r.account.name}» для ${r.site.name}: ${r.cookies} куки`, 'ok', 5000); rerender();
        } }))));
}
