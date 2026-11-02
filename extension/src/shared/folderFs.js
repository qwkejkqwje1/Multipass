// Синхронизация через папку на диске (File System Access API).
// Каждый браузер пишет только свой файл multipass-<deviceId>.json и читает файлы остальных —
// конфликтов записи нет, а облачные клиенты (Яндекс Диск, OneDrive, Dropbox) не плодят «копии с конфликтом».
// Простой режим (по умолчанию): ключ шифрования лежит в самой папке (multipass.key) — другой браузер
// подключается, просто выбрав ту же папку. Режим с парольной фразой: ключа в папке нет, фразу вводят в каждом браузере.
// Модуль работает и в service worker (дескриптор из IndexedDB), и на страницах расширения.
import { err } from './util.js';

export const DOC_RE = /^multipass-[A-Za-z0-9_-]{4,64}\.json$/;
export const README = 'README-Multipass.txt';
export const KEY_FILE = 'multipass.key';
export const deviceFile = (id) => `multipass-${String(id || 'device').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)}.json`;
const MAX_DOC = 64 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function supported() {
  return typeof FileSystemFileHandle === 'function' && 'createWritable' in FileSystemFileHandle.prototype;
}

export function fsError(e) {
  if (e && e.code && /^FOLDER_/.test(e.code)) return e;
  const n = e && e.name;
  if (n === 'NotFoundError') return err('Папка синхронизации не найдена — возможно, её переименовали, переместили или удалили. Выберите папку заново.', 'FOLDER_MISSING');
  if (n === 'NotAllowedError' || n === 'SecurityError') return err('Нет доступа к папке синхронизации — нажмите «Разрешить доступ» в панели Multipass.', 'FOLDER_PERMISSION');
  if (n === 'QuotaExceededError') return err('На диске не хватает места для файла синхронизации.', 'FOLDER_IO');
  return err('Ошибка работы с папкой: ' + ((e && e.message) || e), 'FOLDER_IO');
}

export async function permission(dir, { request = false } = {}) {
  const opts = { mode: 'readwrite' };
  try {
    let st = await dir.queryPermission(opts);
    if (st !== 'granted' && request) st = await dir.requestPermission(opts);
    return st;
  } catch (e) {
    if (request) throw e;
    return 'prompt';
  }
}

export async function ensureAccess(dir) {
  if (!supported()) throw err('Этот браузер не умеет работать с папками (нужен Chrome / Edge 116+; в Brave включите brave://flags/#file-system-access-api). Или выберите другой способ синхронизации.', 'FOLDER_UNSUPPORTED');
  if (!dir) throw err('Папка синхронизации не выбрана — выберите её заново.', 'FOLDER_MISSING');
  if ((await permission(dir)) !== 'granted') throw err('Нет доступа к папке синхронизации — откройте панель Multipass и нажмите «Разрешить доступ».', 'FOLDER_PERMISSION');
  return dir;
}

export async function readDocs(dir) {
  const files = [];
  try {
    for await (const [name, handle] of dir.entries()) if (handle.kind === 'file' && DOC_RE.test(name)) files.push([name, handle]);
  } catch (e) { throw fsError(e); }
  const out = [];
  for (const [name, handle] of files) {
    for (let i = 0; i < 3; i++) {
      try {
        const f = await handle.getFile();
        if (f.size <= MAX_DOC) out.push({ name, text: await f.text(), lastModified: f.lastModified, size: f.size });
        break;
      } catch (e) {
        if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) throw fsError(e);
        // файл как раз перезаписывает другой браузер — повторим, а если не вышло, прочитаем в следующий раз
        if (i < 2) await sleep(150);
      }
    }
  }
  return out;
}

export async function writeDoc(dir, name, text) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      try { await w.write(text); await w.close(); } catch (e) { try { await w.abort(); } catch {} throw e; }
      return;
    } catch (e) {
      last = e;
      if (e && ['NotAllowedError', 'SecurityError', 'NotFoundError', 'QuotaExceededError'].includes(e.name)) break;
      await sleep(250 * (i + 1)); // Windows: файл мог быть открыт на чтение другим браузером
    }
  }
  throw fsError(last);
}

export async function removeDoc(dir, name) {
  try { await dir.removeEntry(name); } catch (e) { if (!e || e.name !== 'NotFoundError') throw fsError(e); }
}

// Открытые метаданные файлов (без расшифровки): кто и когда писал, каким хранилищем (соль)
export function describeDocs(docs) {
  return docs.map((d) => {
    let env = null;
    try { env = JSON.parse(d.text); } catch {}
    const ok = !!env && env.format === 'multipass-sync-enc';
    return { name: d.name, ok, by: ok ? String(env.by || '') : '', updatedAt: (ok && env.updatedAt) || d.lastModified || 0, salt: ok ? env.salt : null, it: ok ? (env.it ?? null) : null, size: d.size || 0 };
  });
}

// ---------- Ключ простого режима ----------
// null — файла нет; { bad: true } — файл есть, но испорчен
export async function readKeyFile(dir) {
  let fh;
  try { fh = await dir.getFileHandle(KEY_FILE); }
  catch (e) { if (e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) return null; throw fsError(e); }
  for (let i = 0; i < 3; i++) {
    try {
      const j = JSON.parse(await (await fh.getFile()).text());
      if (j && j.format === 'multipass-folder-key' && typeof j.id === 'string' && typeof j.key === 'string') return j;
      return { bad: true };
    } catch (e) {
      if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) throw fsError(e);
      if (e instanceof SyntaxError) return { bad: true };
      if (i < 2) await sleep(150);
    }
  }
  return { bad: true };
}

export async function writeKeyFile(dir, { id, key, by = '' }) {
  const body = { format: 'multipass-folder-key', v: 1, id, key, by, createdAt: Date.now(),
    note: 'Ключ синхронизации Multipass. Не удаляйте и никому не пересылайте: у кого есть эта папка вместе с ключом, тот может войти во все аккаунты.' };
  await writeDoc(dir, KEY_FILE, JSON.stringify(body, null, 2));
}

// Ключ случайно удалили — возвращаем (иначе новый браузер не сможет подключиться)
export async function ensureKeyFile(dir, data) {
  const kf = await readKeyFile(dir);
  if (kf && !kf.bad) return false;
  await writeKeyFile(dir, data);
  return true;
}

export async function removeKeyFile(dir) {
  try { await dir.removeEntry(KEY_FILE); } catch (e) { if (!e || e.name !== 'NotFoundError') throw fsError(e); }
}

let readmeDone = false;
export async function ensureReadme(dir) {
  if (readmeDone) return;
  try { await dir.getFileHandle(README); readmeDone = true; return; } catch (e) { if (!e || e.name !== 'NotFoundError') return; }
  try { await writeDoc(dir, README, README_TEXT); readmeDone = true; } catch {}
}

const README_TEXT = [
  'Папка синхронизации Multipass',
  '=============================',
  '',
  'Здесь лежат зашифрованные копии ваших аккаунтов, прокси и правил: по одному файлу multipass-....json',
  'на каждый подключённый браузер.',
  '',
  '- Подключить ещё один браузер: Multipass -> Панель управления -> Синхронизация -> «Выбрать папку…» -> ЭТА папка.',
  '  Если рядом лежит файл multipass.key — больше ничего не нужно. Если его нет — введите ту же парольную фразу.',
  '- multipass.key — ключ шифрования. Не удаляйте его и не пересылайте: папка вместе с ключом = доступ ко всем аккаунтам.',
  '- Не редактируйте и не переименовывайте файлы multipass-....json.',
  '- Папку можно держать внутри Яндекс Диска, OneDrive или Dropbox — тогда синхронизируются и разные компьютеры',
  '  (для этого лучше подключать папку с парольной фразой: тогда ключа в облаке нет).',
  '- Если браузер больше не используется, его файл можно удалить (или нажать «Отключить» в самом браузере).',
  '',
].join('\r\n');
