// Дескриптор выбранной папки синхронизации (FileSystemDirectoryHandle) живёт в IndexedDB:
// chrome.storage такие объекты хранить не умеет. Доступно и странице, и service worker (один origin).
const DB = 'multipass-fs';
const STORE = 'handles';
const KEY = 'syncFolder';

function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function run(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const q = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(q ? q.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally { db.close(); }
}

export const saveFolderHandle = (handle) => run('readwrite', (s) => s.put(handle, KEY));
export const loadFolderHandle = () => run('readonly', (s) => s.get(KEY)).then((v) => v || null).catch(() => null);
export const clearFolderHandle = () => run('readwrite', (s) => s.delete(KEY)).catch(() => {});
