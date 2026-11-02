// Раздел «Синхронизация»: папка на компьютере / GitHub Gist / WebDAV / свой сервер, статус, устройства
import { api, rpc, h, icon, btn, toggle, toast, field, note, confirmDialog, copyText, ago, plural } from '../common.js';
import { S, rerender } from './state.js';
import { saveFolderHandle, loadFolderHandle } from '../../src/shared/handleStore.js';
import { readDocs, describeDocs, permission, supported, readKeyFile } from '../../src/shared/folderFs.js';

const PROV = {
  folder: { title: 'Папка на компьютере', icon: 'folder', sub: 'Браузеры на одном ПК. Без интернета и серверов', rec: 'для одного ПК' },
  gist: { title: 'GitHub Gist', icon: 'cloud', sub: 'Бесплатно, нужен только токен GitHub' },
  webdav: { title: 'WebDAV', icon: 'server', sub: 'Яндекс Диск, Nextcloud, ownCloud, NAS' },
  server: { title: 'Свой сервер', icon: 'monitor', sub: 'Мини-сервер из комплекта (Node.js)' },
};

export default {
  id: 'sync', title: 'Синхронизация', icon: 'cloud',
  live: ['syncConfig', 'devices', 'local'],
  desc: () => 'Одни и те же аккаунты, прокси и правила во всех ваших браузерах. Шифрование на устройстве — хранилище видит только шифротекст.',
  render: (D) => h('div', { class: 'sec' }, D.sync.provider ? connected(D) : setup(D), deviceCard(D)),
};

// ---------- папка: выбор, доступ, смена ----------

export async function pickFolder() {
  if (typeof window.showDirectoryPicker !== 'function' || !supported()) throw new Error('Этот браузер не умеет выбирать папки. Нужен свежий Chrome, Edge, Яндекс Браузер или Opera. В Brave включите brave://flags/#file-system-access-api и перезапустите браузер.');
  let dir;
  try { dir = await window.showDirectoryPicker({ id: 'multipass-sync', mode: 'readwrite', startIn: 'documents' }); }
  catch (e) {
    if (e && e.name === 'AbortError') return null;
    throw new Error(e && e.name === 'SecurityError' ? 'Браузер не разрешает выбрать эту папку — создайте отдельную, например «Документы → Multipass».' : (e && e.message) || String(e));
  }
  if ((await permission(dir, { request: true })) !== 'granted') throw new Error('Нужно разрешить доступ к папке на чтение и запись.');
  await saveFolderHandle(dir);
  const key = await readKeyFile(dir).catch(() => null);
  const docs = describeDocs(await readDocs(dir));
  const hasKey = !!key && !key.bad;
  // данные «простого режима» есть, а ключа нет — фраза не поможет, нужен браузер, который ещё подключён
  const keyLost = !key && docs.some((d) => d.ok) && docs.filter((d) => d.ok).every((d) => !d.it);
  return { name: dir.name, docs, hasKey, badKey: !!key?.bad, keyLost };
}

export async function grantFolderAccess() {
  const dir = await loadFolderHandle();
  if (!dir) return changeFolder();
  let st;
  try { st = await permission(dir, { request: true }); } catch (e) { throw new Error('Не удалось запросить доступ: ' + e.message); }
  if (st === 'denied') { toast('Доступ к папке запрещён. Нажмите «Сменить папку» и выберите её заново.', 'warn', 6000); return; }
  if (st !== 'granted') { toast('Доступ не выдан — без него синхронизация через папку не работает.', 'warn', 5000); return; }
  const r = await api('sync.now');
  toast(r.pulled ? `Доступ есть · получено изменений: ${r.pulled}` : 'Доступ восстановлен — всё синхронизировано');
}

export async function changeFolder() {
  const prev = await loadFolderHandle();
  const picked = await pickFolder();
  if (!picked) return;
  try {
    const r = await api('sync.folderChanged', { folderName: picked.name });
    toast(`Папка «${picked.name}» подключена${r.pulled ? ` · получено изменений: ${r.pulled}` : ''}`);
  } catch (e) {
    // в папке чужое хранилище — возвращаем прежнюю, чтобы не писать не туда
    if (prev && e.code === 'FOLDER_FOREIGN') await saveFolderHandle(prev);
    throw e;
  }
}

// Плашка для любого раздела панели: доступ к папке сброшен / папка пропала
export function folderBanner(D) {
  const s = D.sync;
  if (s.provider !== 'folder') return null;
  if (s.needsPermission) {
    return h('div', { class: 'banner' }, note('warn', 'folder',
      h('div', { class: 'row wrap', style: { gap: '10px' } },
        h('div', { class: 'grow' }, h('div', { class: 'b' }, `Нужен доступ к папке синхронизации «${s.folderName}»`),
          h('div', { class: 'small' }, 'Браузер сбросил разрешение (так бывает после перезапуска). Если он предложит варианты — выберите «Разрешать при каждом посещении», чтобы больше не спрашивал.')),
        btn('Разрешить доступ', { icon: 'unlock', kind: 'primary', onClick: grantFolderAccess }))));
  }
  if (s.folderMissing) {
    return h('div', { class: 'banner' }, note('bad', 'folder',
      h('div', { class: 'row wrap', style: { gap: '10px' } },
        h('div', { class: 'grow' }, h('div', { class: 'b' }, `Папка синхронизации «${s.folderName}» не найдена`),
          h('div', { class: 'small' }, 'Её переименовали, переместили или удалили. Выберите её заново — парольная фраза не понадобится.')),
        btn('Выбрать папку…', { icon: 'folder', kind: 'primary', onClick: changeFolder }))));
  }
  return null;
}

// ---------- подключено ----------

function connected(D) {
  const s = D.sync;
  const r = s.lastResult;
  const folder = s.provider === 'folder';
  const interval = h('select', { class: 'input sm', style: { width: '130px' } }, [1, 2, 5, 10, 15, 30, 60].map((m) => h('option', { value: m }, `каждые ${m} мин`)));
  interval.value = String(s.intervalMin || 5);
  interval.addEventListener('change', () => api('sync.options', { intervalMin: +interval.value }).then(() => toast('Сохранено')).catch((e) => toast(e.message, 'bad')));
  const keyFile = folder && s.keyMode === 'file';
  const how = {
    folder: keyFile
      ? ['Установите Multipass в другом браузере на этом компьютере (Edge, Chrome, Яндекс, Opera…; в Brave сначала включите brave://flags/#file-system-access-api).', `Синхронизация → «Выбрать папку…» → та же папка «${s.folderName}». Всё — парольная фраза не нужна, аккаунты, прокси и правила появятся сразу.`]
      : ['Установите Multipass в другом браузере на этом компьютере (Edge, Chrome, Яндекс, Opera…; в Brave сначала включите brave://flags/#file-system-access-api).', `Синхронизация → «Выбрать папку…» → та же папка «${s.folderName}».`, 'Введите ту же парольную фразу — аккаунты, прокси и правила появятся сразу.', 'Другой компьютер: держите папку внутри Яндекс Диска / OneDrive / Dropbox — облачный клиент сам перенесёт файлы.'],
    gist: ['Установите Multipass в другом браузере (Chrome, Edge, Яндекс, Opera, Brave…).', 'Синхронизация → GitHub Gist → тот же токен и та же парольная фраза.', 'Хранилище найдётся само — ID вводить не нужно.'],
    webdav: ['Установите Multipass в другом браузере.', 'Синхронизация → WebDAV → тот же адрес файла, логин, пароль и парольная фраза.'],
    server: ['Установите Multipass в другом браузере.', 'Синхронизация → Свой сервер → тот же адрес, токен и парольная фраза.'],
  }[s.provider] || [];
  const folderState = s.needsPermission ? h('span', { class: 'warnc' }, 'нужно подтвердить') : s.folderMissing ? h('span', { class: 'badc' }, 'папка не найдена') : h('span', { class: 'okc' }, 'есть');
  const genericErr = s.lastError && !(folder && (s.needsPermission || s.folderMissing));
  return h('div', { class: 'sec' },
    h('div', { class: 'card' },
      h('h3', null, icon(PROV[s.provider]?.icon || 'cloud'), `Подключено: ${s.label}`, h('span', { class: 'sp' }), s.running ? h('span', { class: 'spinner' }) : null),
      folder ? folderBanner(D) : null,
      genericErr ? note('bad', 'alert', h('div', { class: 'b' }, 'Последняя синхронизация не удалась'), h('div', { class: 'small' }, s.lastError)) : null,
      h('div', { class: 'kv', style: { margin: '10px 0 14px' } },
        folder ? [h('span', null, 'Папка'), h('span', { class: 'row', style: { gap: '8px' } }, h('span', { class: 'folder-chip' }, icon('folder', 'sm'), s.folderName || '—'),
          btn('Сменить папку…', { size: 'sm', kind: 'ghost', onClick: changeFolder }))] : null,
        folder ? [h('span', null, 'Доступ к папке'), folderState] : null,
        folder ? [h('span', null, 'Защита'), keyFile
          ? h('span', { title: 'Файлы зашифрованы ключом из файла multipass.key в этой же папке' }, 'без парольной фразы — ключ лежит в папке (multipass.key)')
          : h('span', null, 'парольная фраза')] : null,
        h('span', null, 'Последняя'), h('span', null, s.lastSyncAt ? `${ago(s.lastSyncAt)} · ${new Date(s.lastSyncAt).toLocaleString('ru-RU')}` : 'ещё не было'),
        r ? [h('span', null, 'Результат'), h('span', null, `получено изменений: ${r.pulled} · ${r.pushed ? 'отправлено' : 'без изменений'} · записей: ${r.items}`)] : null,
        folder && r && r.files != null ? [h('span', null, 'Браузеров в папке'), h('span', null, String(r.files),
          r.foreign ? h('span', { class: 'warnc' }, ` · с другой парольной фразой: ${r.foreign} (пропущены)`) : null,
          r.bad ? h('span', { class: 'warnc' }, ` · повреждённых файлов: ${r.bad}`) : null)] : null,
        s.provider === 'gist' && s.gistId ? [h('span', null, 'Gist'), h('span', { class: 'row', style: { gap: '6px' } }, h('a', { href: `https://gist.github.com/${s.gistId}`, target: '_blank', class: 'mono' }, s.gistId), btn('', { size: 'sm', icon: 'copy', kind: 'ghost', title: 'Копировать ID', onClick: async () => { await copyText(s.gistId); toast('ID скопирован'); } }))] : null,
        s.url ? [h('span', null, 'Адрес'), h('span', { class: 'mono' }, s.url)] : null,
        s.username ? [h('span', null, 'Логин'), h('span', null, s.username)] : null),
      h('div', { class: 'toggle-row' }, h('div', { class: 'grow' }, h('div', null, 'Автоматически'), h('div', { class: 'hint' }, folder ? 'Через пару секунд после изменений, при открытии окна Multipass, при запуске браузера и по расписанию.' : 'После каждого изменения (через несколько секунд), при запуске браузера и по расписанию.')),
        interval, toggle(s.auto, (v) => api('sync.options', { auto: v }))),
      h('div', { class: 'row', style: { marginTop: '12px' } },
        btn('Синхронизировать сейчас', { icon: 'sync', kind: 'primary', onClick: async () => { const x = await api('sync.now'); toast(x.pulled ? `Получено изменений: ${x.pulled}` : 'Всё синхронизировано'); } }),
        h('span', { class: 'sp' }),
        btn('Отключить', { icon: 'power', kind: 'danger', onClick: async () => {
          const text = keyFile
            ? 'Файл этого браузера будет убран из папки, данные в этом и других браузерах останутся. Подключиться снова — просто выбрать эту папку.'
            : folder
              ? 'Файл этого браузера будет убран из папки, сама папка и данные в этом и других браузерах останутся. Для повторного подключения понадобится парольная фраза.'
              : 'Данные в этом браузере и в хранилище останутся. Ключ шифрования будет забыт — для повторного подключения понадобится парольная фраза.';
          if (!(await confirmDialog({ title: 'Отключить синхронизацию?', text, ok: 'Отключить' }))) return;
          await api('sync.disconnect'); toast('Синхронизация отключена', 'info');
        } }))),
    h('div', { class: 'card' }, h('h3', null, icon('monitor'), 'Как подключить другой браузер'), h('ol', { class: 'small', style: { margin: '0', paddingLeft: '18px', lineHeight: '1.8' } }, how.map((x) => h('li', null, x))),
      h('div', { class: 'hint', style: { marginTop: '6px' } }, 'Синхронизируются сайты, аккаунты с сессиями, прокси и правила. Не синхронизируются: настройки, мастер-пароль, журнал, результаты проверок прокси. Конфликты решаются по последнему изменению каждой записи.')));
}

// ---------- подключение ----------

function setup(D) {
  const pv = PROV[S.ui.syncProvider] && S.ui.syncProvider !== 'folder' ? S.ui.syncProvider : 'gist';
  const f = S.ui.syncForm;
  const inp = (k, attrs = {}) => { const e = h('input', { class: 'input', value: f[k] || '', spellcheck: false, ...attrs }); e.addEventListener('input', () => { f[k] = e.value; }); return e; };
  const other = h('details', { class: 'card more-sync', open: S.ui.syncOtherOpen || null },
    h('summary', null, icon('cloud'), 'Другие способы — между разными компьютерами', h('span', { class: 'small muted', style: { fontWeight: '400' } }, 'GitHub Gist, WebDAV (Яндекс Диск, Nextcloud), свой сервер'), icon('chev', 'chev')),
    h('div', { class: 'prov', style: { gridTemplateColumns: 'repeat(3, 1fr)', marginTop: '12px' } }, Object.entries(PROV).filter(([k]) => k !== 'folder').map(([k, p]) => {
      const b = h('button', { type: 'button', class: k === pv ? 'on' : '' }, h('b', null, icon(p.icon), p.title), h('span', null, p.sub));
      b.addEventListener('click', () => { S.ui.syncProvider = k; S.ui.syncOtherOpen = true; rerender(); });
      return b;
    })),
    h('div', { class: 'col', style: { marginTop: '14px', gap: '12px', maxWidth: '640px' } }, remoteSetup(pv, f, inp)));
  other.addEventListener('toggle', () => { S.ui.syncOtherOpen = other.open; });
  return h('div', { class: 'sec' },
    h('div', { class: 'card' },
      h('h3', null, icon('folder'), 'Папка на компьютере', h('span', { class: 'pill ok' }, 'проще всего')),
      h('div', { class: 'desc' }, 'Все браузеры на этом компьютере (Chrome, Edge, Яндекс, Opera…) работают с одной папкой. Без интернета, серверов и регистрации.'),
      h('div', { class: 'col', style: { marginTop: '12px', gap: '12px', maxWidth: '640px' } }, folderSetup(D, f, inp))),
    other);
}

function cryptoNote() {
  return note('info', 'key', 'Парольная фраза шифрует данные на устройстве (AES-256-GCM, PBKDF2 310 000 итераций). Её не знает ни облако, ни сервер, ни мы. Потеряете — копию в хранилище не расшифровать, но локальные данные в браузерах останутся.');
}

// Один клик: «Выбрать папку…» → подключено. Второй браузер выбирает ту же папку — и всё.
// Парольная фраза — по желанию (если папка в облаке или к ПК есть доступ у других).
function folderSetup(D, f, inp) {
  const fp = S.ui.folderPick;          // выбранная папка, которой нужна парольная фраза
  const protect = !!S.ui.folderProtect;
  const pass = inp('passphrase', { type: 'password', placeholder: 'минимум 8 символов', autocomplete: fp ? 'current-password' : 'new-password' });
  const pass2 = inp('passphrase2', { type: 'password', placeholder: 'повторите', autocomplete: 'new-password' });

  const done = (r, name, extra = '') => {
    S.ui.syncForm = {}; S.ui.folderPick = null; S.ui.folderProtect = false;
    const what = r.keyMode === 'file' ? (r.joined ? 'присоединились к данным в папке' : 'данные записаны в папку') : 'с парольной фразой';
    toast(`Папка «${name}» подключена — ${what}${r.pulled ? ` · получено записей: ${r.pulled}` : ''}${extra}`, 'ok', 6000);
  };
  const connect = async (name, passphrase, extra) => {
    try { done(await api('sync.configure', { provider: 'folder', folderName: name, passphrase, auto: true, intervalMin: 1 }), name, extra); }
    catch (e) {
      if (e.code !== 'NEED_PASSPHRASE') throw e;
      S.ui.folderPick = { name }; f.passphrase = ''; rerender();
      toast('Папка защищена парольной фразой — введите ту же, что в других браузерах', 'info', 5000);
    }
  };

  if (fp) {
    return [
      note('info', 'key', h('div', { class: 'b' }, `В папке «${fp.name}» данные защищены парольной фразой`),
        h('div', { class: 'small' }, 'Введите ту же фразу, что в других браузерах, — данные сразу появятся здесь.')),
      field('Парольная фраза', pass),
      h('div', { class: 'row' },
        btn('Подключить', { icon: 'link', kind: 'primary', onClick: async () => {
          if ((f.passphrase || '').length < 8) throw new Error('Парольная фраза — минимум 8 символов');
          await connect(fp.name, f.passphrase);
        } }),
        btn('Выбрать другую папку…', { icon: 'folder', onClick: () => { S.ui.folderPick = null; rerender(); } })),
    ];
  }

  const pickBtn = btn('Выбрать папку…', { icon: 'folder', kind: 'primary', onClick: async () => {
    if (protect) {
      if ((f.passphrase || '').length < 8) throw new Error('Парольная фраза — минимум 8 символов (или снимите галочку «Защитить парольной фразой»)');
      if (f.passphrase !== f.passphrase2) throw new Error('Парольные фразы не совпадают');
    }
    const r = await pickFolder();
    if (!r) return;
    if (r.badKey) throw new Error(`В папке «${r.name}» повреждён файл multipass.key. Выберите другую (пустую) папку.`);
    if (r.keyLost) throw new Error(`В папке «${r.name}» есть данные Multipass, но пропал файл ключа multipass.key. Откройте Multipass в браузере, который уже подключён к этой папке (он восстановит ключ в течение минуты), и выберите папку снова — или выберите пустую папку.`);
    // в папке уже есть ключ — фраза не нужна; есть данные с фразой — спросим её; пусто — создаём хранилище
    const needPass = !r.hasKey && r.docs.some((d) => d.ok && d.it);
    if (needPass && !protect) { S.ui.folderPick = { name: r.name }; f.passphrase = ''; rerender(); return; }
    await connect(r.name, r.hasKey ? '' : (protect ? f.passphrase : ''), r.hasKey && protect ? ' (папка уже подключена без фразы — фраза не понадобилась)' : '');
  } });
  const protectCb = h('input', { type: 'checkbox', checked: protect });
  protectCb.addEventListener('change', () => { S.ui.folderProtect = protectCb.checked; rerender(); });
  return [
    h('div', { class: 'folder-pick' }, pickBtn,
      h('span', { class: 'hint' }, 'Создайте пустую папку, например «Документы → Multipass», и выберите её. В других браузерах выберите ту же папку — больше ничего вводить не нужно.')),
    D.vault.enabled && !protect ? note('warn', 'lock', 'У вас включён мастер-пароль. Без парольной фразы копии сессий в папке защищены только ключом, который лежит рядом, — лучше отметьте «Защитить парольной фразой».') : null,
    h('label', { class: 'check', style: { alignItems: 'flex-start' } }, protectCb, h('span', null, 'Защитить парольной фразой', h('span', { class: 'hint', style: { display: 'block' } }, 'Нужно, если папка лежит в Яндекс Диске / OneDrive / Dropbox или компьютером пользуются другие. Фразу придётся вводить в каждом браузере.'))),
    protect ? h('div', { class: 'grid2' }, field('Придумайте парольную фразу', pass), field('Ещё раз', pass2)) : null,
    protect ? cryptoNote() : null,
    note('info', 'info', h('div', null, 'Браузер спросит разрешение на папку — разрешите. Если позже спросит снова, выберите «Разрешать при каждом посещении».'),
      h('div', { class: 'small', style: { marginTop: '4px' } }, 'Без парольной фразы ключ шифрования хранится в самой папке (файл multipass.key) — поэтому другим браузерам достаточно выбрать папку. Не пересылайте эту папку: папка вместе с ключом = доступ к аккаунтам.')),
  ];
}

function remoteSetup(pv, f, inp) {
  const fields = {
    gist: [
      field('Токен GitHub', inp('token', { type: 'password', placeholder: 'ghp_… или github_pat_…', autocomplete: 'off' }),
        h('span', null, 'Создайте classic-токен только с правом «gist»: ', h('a', { href: 'https://github.com/settings/tokens/new?scopes=gist&description=Multipass%20sync', target: '_blank' }, 'github.com/settings/tokens'), '. Gist создаётся секретным, а его содержимое всё равно зашифровано.')),
      field('ID Gist (необязательно)', inp('gistId', { placeholder: 'оставьте пустым — найдём существующее хранилище или создадим новое' })),
    ],
    webdav: [
      field('Адрес файла', inp('url', { placeholder: 'https://webdav.yandex.ru/multipass/vault.json' }), 'Папка создастся сама. Nextcloud: https://ваш-сервер/remote.php/dav/files/ЛОГИН/multipass/vault.json'),
      h('div', { class: 'grid2' }, field('Логин', inp('username', { autocomplete: 'off' })), field('Пароль', inp('password', { type: 'password', autocomplete: 'new-password' }), 'Для Яндекс Диска — пароль приложения (id.yandex.ru → Безопасность → Пароли приложений)')),
    ],
    server: [
      field('Адрес сервера', inp('url', { placeholder: 'http://192.168.1.10:8787' }), 'Сервер в папке sync-server: node server.mjs --token ВАШ_ТОКЕН. Для доступа из интернета — за HTTPS (Caddy/nginx).'),
      field('Токен', inp('token', { type: 'password', placeholder: 'минимум 16 символов', autocomplete: 'off' })),
    ],
  }[pv];
  const pass = inp('passphrase', { type: 'password', placeholder: 'минимум 8 символов', autocomplete: 'new-password' });
  const pass2 = inp('passphrase2', { type: 'password', placeholder: 'повторите', autocomplete: 'new-password' });
  return [
    fields,
    h('div', { class: 'grid2' }, field('Парольная фраза шифрования', pass), field('Ещё раз', pass2)),
    cryptoNote(),
    h('div', { class: 'row' }, btn('Подключить', { icon: 'link', kind: 'primary', onClick: async () => {
      if ((f.passphrase || '').length < 8) throw new Error('Парольная фраза — минимум 8 символов');
      if (f.passphrase !== f.passphrase2) throw new Error('Парольные фразы не совпадают');
      const r = await api('sync.configure', { provider: pv, url: f.url, token: f.token, username: f.username, password: f.password, gistId: f.gistId, passphrase: f.passphrase, auto: true, intervalMin: 5 });
      S.ui.syncForm = {};
      toast(r.pulled ? `Подключено · получено записей: ${r.pulled}` : 'Подключено — данные отправлены в хранилище', 'ok', 5000);
    } })),
  ];
}

function deviceCard(D) {
  const name = h('input', { class: 'input', value: D.device.name, maxlength: 60 });
  const others = D.sync.devices || [];
  return h('div', { class: 'card' }, h('h3', null, icon('monitor'), 'Браузеры'),
    h('div', { class: 'row', style: { marginBottom: '10px' } }, h('span', { class: 'small muted nowrap' }, 'Этот браузер:'), h('div', { class: 'grow', style: { maxWidth: '360px' } }, name),
      btn('Переименовать', { size: 'sm', onClick: async () => { await rpc('device.rename', { name: name.value }); toast('Сохранено'); } })),
    others.length ? others.map((d) => h('div', { class: 'dev' }, icon('monitor'), h('div', { class: 'grow' }, h('div', { class: 'b' }, d.name || d.id), h('div', { class: 'tiny faint' }, `был в сети ${ago(d.lastSeen)}`)),
      h('span', { class: 'small muted' }, d.active ? `${plural(d.active, 'активен', 'активны', 'активны')} ${d.active} ${plural(d.active, 'аккаунт', 'аккаунта', 'аккаунтов')}` : 'нет активных аккаунтов')))
      : h('div', { class: 'small faint' }, D.sync.provider ? 'Другие браузеры появятся здесь после их первой синхронизации.' : 'После подключения синхронизации здесь будут видны другие ваши браузеры и какие аккаунты в них активны.'));
}
