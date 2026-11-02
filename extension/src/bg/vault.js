// Мастер-пароль: шифрование сохранённых сессий «на диске». Ключ живёт только в памяти (storage.session).
import { initDb, save, readRaw, writeRaw } from './db.js';
import { deriveBits, importAesKey, encryptJSON, decryptJSON, b64e, b64d, randomBytes, KDF_ITERATIONS } from '../shared/crypto.js';
import { err } from '../shared/util.js';
import * as log from './log.js';
import { emit } from './bus.js';

let keyCache = null;
let lastTouch = 0;

export function register() {
  chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'vault-autolock') lock().catch(() => {}); });
}

async function getKeyOrNull() {
  const c = await initDb();
  if (!c.vaultMeta.enabled) return null;
  if (keyCache) return keyCache;
  const r = await chrome.storage.session.get('vaultKey');
  if (!r.vaultKey) return null;
  keyCache = await importAesKey(b64d(r.vaultKey));
  return keyCache;
}

export async function status() {
  const c = await initDb();
  const enabled = !!c.vaultMeta.enabled;
  return { enabled, locked: enabled && !(await getKeyOrNull()), autoLockMin: c.settings.autoLockMin };
}

function touch() {
  if (Date.now() - lastTouch < 30000) return;
  lastTouch = Date.now();
  initDb().then((c) => {
    if (c.vaultMeta.enabled && c.settings.autoLockMin > 0) chrome.alarms.create('vault-autolock', { delayInMinutes: c.settings.autoLockMin });
  });
}

export async function requireKey() {
  const k = await getKeyOrNull();
  if (!k) throw err('Хранилище заблокировано — введите мастер-пароль', 'LOCKED');
  touch();
  return k;
}

export async function seal(obj) {
  const c = await initDb();
  if (!c.vaultMeta.enabled) return obj;
  return { __enc: await encryptJSON(await requireKey(), obj) };
}

export async function open(stored) {
  if (!stored) return null;
  if (!stored.__enc) return stored;
  return decryptJSON(await requireKey(), stored.__enc);
}

async function keyFromPassword(password, meta) {
  const raw = await deriveBits(password, b64d(meta.salt), meta.it);
  const key = await importAesKey(raw);
  await decryptJSON(key, meta.check).catch(() => { throw err('Неверный мастер-пароль', 'BADPASS'); });
  return { raw, key };
}

async function allSessionKeys() {
  const all = await chrome.storage.local.get(null);
  return Object.keys(all).filter((k) => k.startsWith('sess:') || k.startsWith('prev:')).map((k) => [k, all[k]]);
}

export async function unlock(password) {
  const c = await initDb();
  if (!c.vaultMeta.enabled) return status();
  const { raw, key } = await keyFromPassword(password, c.vaultMeta);
  keyCache = key;
  await chrome.storage.session.set({ vaultKey: b64e(raw) });
  lastTouch = 0; touch();
  log.info('Хранилище разблокировано');
  emit('vault-changed');
  return status();
}

export async function lock() {
  keyCache = null;
  await chrome.storage.session.remove('vaultKey');
  chrome.alarms.clear('vault-autolock');
  emit('vault-changed');
  return status();
}

export async function enable(password) {
  if (!password || password.length < 6) throw err('Пароль должен быть не короче 6 символов');
  const c = await initDb();
  if (c.vaultMeta.enabled) throw err('Мастер-пароль уже включён');
  const salt = randomBytes(16);
  const raw = await deriveBits(password, salt, KDF_ITERATIONS);
  const key = await importAesKey(raw);
  const check = await encryptJSON(key, { ok: 'multipass' });
  // шифруем существующие сессии
  for (const [k, v] of await allSessionKeys()) {
    if (v && !v.__enc) await writeRaw(k, { __enc: await encryptJSON(key, v) });
  }
  c.vaultMeta = { enabled: true, salt: b64e(salt), it: KDF_ITERATIONS, check };
  await save('vaultMeta');
  keyCache = key;
  await chrome.storage.session.set({ vaultKey: b64e(raw) });
  log.info('Включено шифрование хранилища мастер-паролем');
  emit('vault-changed');
  return status();
}

export async function disable(password) {
  const c = await initDb();
  if (!c.vaultMeta.enabled) return status();
  const { key } = await keyFromPassword(password, c.vaultMeta);
  for (const [k, v] of await allSessionKeys()) {
    if (v && v.__enc) await writeRaw(k, await decryptJSON(key, v.__enc));
  }
  c.vaultMeta = { enabled: false };
  await save('vaultMeta');
  keyCache = null;
  await chrome.storage.session.remove('vaultKey');
  log.info('Шифрование хранилища отключено');
  emit('vault-changed');
  return status();
}

export async function change(oldPass, newPass) {
  if (!newPass || newPass.length < 6) throw err('Новый пароль должен быть не короче 6 символов');
  const c = await initDb();
  const { key: oldKey } = await keyFromPassword(oldPass, c.vaultMeta);
  const salt = randomBytes(16);
  const raw = await deriveBits(newPass, salt, KDF_ITERATIONS);
  const key = await importAesKey(raw);
  for (const [k, v] of await allSessionKeys()) {
    const plain = v && v.__enc ? await decryptJSON(oldKey, v.__enc) : v;
    if (plain) await writeRaw(k, { __enc: await encryptJSON(key, plain) });
  }
  c.vaultMeta = { enabled: true, salt: b64e(salt), it: KDF_ITERATIONS, check: await encryptJSON(key, { ok: 'multipass' }) };
  await save('vaultMeta');
  keyCache = key;
  await chrome.storage.session.set({ vaultKey: b64e(raw) });
  log.info('Мастер-пароль изменён');
  return status();
}

// Сессии аккаунтов
export async function loadSession(id) { return open(await readRaw('sess:' + id)); }
export async function loadPrevSession(id) { return open(await readRaw('prev:' + id)); }
export async function storeSession(id, payload, { keepPrev = true } = {}) {
  if (keepPrev) {
    const cur = await readRaw('sess:' + id);
    if (cur) await writeRaw('prev:' + id, cur);
  }
  await writeRaw('sess:' + id, await seal(payload));
}
