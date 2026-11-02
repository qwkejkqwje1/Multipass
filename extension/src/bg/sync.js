// E2E-синхронизация между браузерами: папка на диске / GitHub Gist / WebDAV (Nextcloud, Яндекс Диск…) / свой сервер.
// Сервер видит только зашифрованный блоб (AES-256-GCM, ключ из парольной фразы через PBKDF2).
import { initDb, save, removeRaw, DEFAULTS } from './db.js';
import * as vault from './vault.js';
import * as log from './log.js';
import * as proxy from './proxy.js';
import { summarize } from './sessions.js';
import { dedupeSites } from './accounts.js';
import { on, emit } from './bus.js';
import { err } from '../shared/util.js';
import { deriveBits, importAesKey, encryptJSON, decryptJSON, b64e, b64d, randomBytes, KDF_ITERATIONS } from '../shared/crypto.js';
import { loadFolderHandle, clearFolderHandle } from '../shared/handleStore.js';
import * as F from '../shared/folderFs.js';

const FILE = 'multipass-vault.json';
// Надгробия (удаления) живут год: файл давно не открывавшегося браузера в папке не «воскресит» удалённое,
// а такие файлы (старше STALE_DOC_MS) вообще не учитываются, если есть свежие.
const TOMBSTONE_TTL = 365 * 86400e3;
const STALE_DOC_MS = 300 * 86400e3;
let running = null;
let soonTimer = null;

export const PROVIDERS = { folder: 'Папка', gist: 'GitHub Gist', webdav: 'WebDAV', server: 'Свой сервер' };

function httpErr(r, who) {
  const e = new Error(`${who}: HTTP ${r.status}${r.status === 401 || r.status === 403 ? ' — проверьте токен/логин' : ''}`);
  e.code = r.status === 412 ? 'CONFLICT' : 'HTTP';
  return e;
}

const gh = (cfg) => ({ Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });
const dav = (cfg) => ({ Authorization: 'Basic ' + btoa(unescape(encodeURIComponent(`${cfg.username || ''}:${cfg.password || ''}`))) });
const srv = (cfg) => ({ Authorization: `Bearer ${cfg.token}` });
const srvUrl = (cfg) => cfg.url.replace(/\/+$/, '') + '/v1/vault';

const providers = {
  // Папка на диске: каждый браузер пишет свой файл и читает чужие (multi = несколько документов)
  folder: {
    multi: true,
    async read(cfg, pctx) {
      const dir = await F.ensureAccess(await loadFolderHandle());
      const own = F.deviceFile(pctx.deviceId);
      // ключ простого режима случайно удалили — возвращаем при каждой синхронизации (иначе новый браузер не подключится)
      if (cfg.keyMode === 'file' && cfg.keyB64) await F.ensureKeyFile(dir, { id: cfg.saltB64, key: cfg.keyB64, by: pctx.deviceName || '' }).catch(() => {});
      return { docs: (await F.readDocs(dir)).map((d) => ({ ...d, own: d.name === own })) };
    },
    async write(cfg, text, etag, pctx) {
      const dir = await F.ensureAccess(await loadFolderHandle());
      await F.writeDoc(dir, F.deviceFile(pctx.deviceId), text);
      F.ensureReadme(dir).catch(() => {});
      return {};
    },
  },
  gist: {
    async read(cfg) {
      if (!cfg.token) throw err('Нужен токен GitHub (scope: gist)');
      if (!cfg.gistId) {
        // второй браузер: находим уже созданное хранилище по имени файла — ID вводить не нужно
        const lr = await fetch('https://api.github.com/gists?per_page=100', { headers: gh(cfg), cache: 'no-store' });
        if (!lr.ok) throw httpErr(lr, 'GitHub');
        const found = (await lr.json()).find?.((g) => g.files && g.files[FILE]);
        if (!found) return { text: null };
        cfg.gistId = found.id;
      }
      const r = await fetch(`https://api.github.com/gists/${cfg.gistId}`, { headers: gh(cfg), cache: 'no-store' });
      if (r.status === 404) throw err('Gist не найден — проверьте ID или оставьте поле пустым, чтобы создать новый');
      if (!r.ok) throw httpErr(r, 'GitHub');
      const j = await r.json();
      const f = j.files && j.files[FILE];
      if (!f) return { text: null };
      if (f.truncated) { const rr = await fetch(f.raw_url, { cache: 'no-store' }); return { text: await rr.text() }; }
      return { text: f.content };
    },
    async write(cfg, text) {
      if (!cfg.gistId) {
        const r = await fetch('https://api.github.com/gists', { method: 'POST', headers: gh(cfg), body: JSON.stringify({ description: 'Multipass — зашифрованное хранилище синхронизации', public: false, files: { [FILE]: { content: text } } }) });
        if (!r.ok) throw httpErr(r, 'GitHub');
        return { gistId: (await r.json()).id };
      }
      const r = await fetch(`https://api.github.com/gists/${cfg.gistId}`, { method: 'PATCH', headers: gh(cfg), body: JSON.stringify({ files: { [FILE]: { content: text } } }) });
      if (!r.ok) throw httpErr(r, 'GitHub');
      return {};
    },
  },
  webdav: {
    async read(cfg) {
      if (!cfg.url) throw err('Укажите URL файла WebDAV');
      const r = await fetch(cfg.url, { headers: dav(cfg), cache: 'no-store' });
      if (r.status === 404) return { text: null, etag: null };
      if (!r.ok) throw httpErr(r, 'WebDAV');
      return { text: await r.text(), etag: r.headers.get('ETag') };
    },
    async write(cfg, text, etag) {
      const h = { ...dav(cfg), 'Content-Type': 'application/json' };
      if (etag) h['If-Match'] = etag;
      let r = await fetch(cfg.url, { method: 'PUT', headers: h, body: text });
      if (r.status === 409 || r.status === 404) {
        const parent = cfg.url.replace(/\/[^/]*$/, '/');
        await fetch(parent, { method: 'MKCOL', headers: dav(cfg) }).catch(() => {});
        r = await fetch(cfg.url, { method: 'PUT', headers: h, body: text });
      }
      if (!r.ok) throw httpErr(r, 'WebDAV');
      return {};
    },
  },
  server: {
    async read(cfg) {
      if (!cfg.url || !cfg.token) throw err('Укажите адрес сервера и токен');
      const r = await fetch(srvUrl(cfg), { headers: srv(cfg), cache: 'no-store' });
      if (r.status === 404) return { text: null, etag: null };
      if (!r.ok) throw httpErr(r, 'Сервер');
      return { text: await r.text(), etag: r.headers.get('ETag') };
    },
    async write(cfg, text, etag) {
      const h = { ...srv(cfg), 'Content-Type': 'application/json' };
      if (etag) h['If-Match'] = etag; else h['If-None-Match'] = '*';
      const r = await fetch(srvUrl(cfg), { method: 'PUT', headers: h, body: text });
      if (!r.ok) throw httpErr(r, 'Сервер');
      return {};
    },
  },
};

export function register() {
  on('data-changed', (d) => { if (d?.sync) scheduleSoon(); });
  chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'sync-periodic') syncNow({ reason: 'periodic' }).catch(() => {}); });
}

export async function ensureAlarm() {
  const c = await initDb();
  if (c.syncConfig.provider && c.syncConfig.auto) chrome.alarms.create('sync-periodic', { periodInMinutes: Math.max(1, +c.syncConfig.intervalMin || 5) });
  else chrome.alarms.clear('sync-periodic');
}

export function scheduleSoon(ms) {
  initDb().then((c) => {
    if (!c.syncConfig.provider || !c.syncConfig.auto) return;
    clearTimeout(soonTimer);
    soonTimer = setTimeout(() => syncNow({ reason: 'auto' }).catch(() => {}), ms ?? (c.syncConfig.provider === 'folder' ? 2500 : 5000));
  });
}

// Открыли окно расширения — быстро подтянуть изменения из других браузеров (без ожидания результата)
export async function poke() {
  const c = await initDb();
  const s = c.syncConfig;
  if (!s.provider || running) return { started: false };
  const fresh = s.provider === 'folder' ? 8000 : 60000;
  if (Date.now() - (s.lastSyncAt || 0) < fresh && !s.lastError) return { started: false };
  syncNow({ reason: 'popup' }).catch(() => {});
  return { started: true };
}

export function status(c) {
  const s = c.syncConfig;
  const devices = Object.entries(c.devices || {}).filter(([id]) => id !== c.local.deviceId)
    .map(([id, d]) => ({ id, name: d.name, lastSeen: d.lastSeen, active: Object.keys(d.active || {}).length }))
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  const folder = s.provider === 'folder';
  return { provider: s.provider, label: folder ? `Папка «${s.folderName || 'Multipass'}»` : PROVIDERS[s.provider] || null, auto: s.auto, intervalMin: s.intervalMin, lastSyncAt: s.lastSyncAt, lastError: s.lastError,
    keyMode: s.provider ? (s.keyMode || 'pass') : null,
    lastErrorCode: s.lastErrorCode || null, needsPermission: folder && s.lastErrorCode === 'FOLDER_PERMISSION', folderMissing: folder && s.lastErrorCode === 'FOLDER_MISSING',
    lastResult: s.lastResult, running: !!running, devices, url: s.url || '', gistId: s.gistId || '', username: s.username || '', hasToken: !!s.token, folderName: s.folderName || '' };
}

function normRemote(r) {
  if (Array.isArray(r.docs)) return r;
  return { ...r, docs: r.text ? [{ name: null, text: r.text, own: true }] : [] };
}

function parseEnvs(docs) {
  return docs.map((d) => {
    let env = null;
    try { env = JSON.parse(d.text); } catch {}
    return { d, env: env && env.format === 'multipass-sync-enc' ? env : null };
  });
}

// Собрать записи из всех документов хранилища (у папки — по файлу на браузер): по каждой записи побеждает самая свежая
async function remoteItems(key, cfg, docs, strict) {
  const items = {};
  const stats = { used: 0, foreign: 0, bad: 0, stale: 0, ownOk: false };
  const ok = [];
  for (const { d, env } of parseEnvs(docs)) {
    if (!env) { if (strict) throw err('Файл синхронизации повреждён или не от Multipass'); stats.bad++; continue; }
    if (env.salt !== cfg.saltB64) { if (strict) throw err('Хранилище пересоздано с другой парольной фразой — переподключите синхронизацию'); stats.foreign++; continue; }
    ok.push({ d, env });
  }
  const fresh = ok.filter(({ d, env }) => d.own || Date.now() - (env.updatedAt || 0) < STALE_DOC_MS);
  const use = fresh.length ? fresh : ok;
  stats.stale = ok.length - use.length;
  for (const { d, env } of use) {
    let doc;
    try { doc = await decryptJSON(key, env.data); }
    catch { if (strict) throw err('Не удалось расшифровать хранилище — переподключите синхронизацию'); stats.bad++; continue; }
    stats.used++;
    if (d.own) stats.ownOk = true;
    for (const [k, it] of Object.entries(doc.items || {})) { const cur = items[k]; if (!cur || it.t > cur.t) items[k] = it; }
  }
  return { items, stats };
}

export async function configure(input) {
  const c = await initDb();
  const { provider } = input;
  const passphrase = input.passphrase || '';
  const P = providers[provider];
  if (!P) throw err('Выберите способ синхронизации');
  const cfg = { provider, url: (input.url || '').trim(), token: (input.token || '').trim(), username: (input.username || '').trim(), password: input.password || '', gistId: (input.gistId || '').trim(),
    folderName: String(input.folderName || '').slice(0, 200) };
  if (provider === 'folder') {
    // Простой режим: в папке уже есть ключ — подключаемся без фразы; папка пустая и фраза не задана — создаём ключ
    const dir = await F.ensureAccess(await loadFolderHandle());
    const kf = await F.readKeyFile(dir);
    if (kf?.bad) throw err('Файл ключа multipass.key в папке повреждён. Выберите другую (пустую) папку или удалите из этой папки файлы Multipass и подключитесь заново.', 'FOLDER_KEY_BAD');
    if (kf || !passphrase) return connectFolderWithKey(c, cfg, input, dir, kf);
  }
  if (!passphrase || passphrase.length < 8) throw err('Парольная фраза — минимум 8 символов. Она одна и та же на всех браузерах.');
  const remote = normRemote(await P.read(cfg, { deviceId: c.local.deviceId }));
  const envs = parseEnvs(remote.docs);
  if (!P.multi && envs.length && !envs[0].env) throw err('По этому адресу лежит не файл Multipass');
  let valid = envs.filter((x) => x.env).sort((a, b) => (b.env.updatedAt || 0) - (a.env.updatedAt || 0));
  if (provider === 'folder') {
    // файлы «простого режима» (ключ в multipass.key, it = 0) фразой не открыть
    if (valid.length && valid.every((x) => !x.env.it)) throw keyMissing();
    valid = valid.filter((x) => x.env.it);
  }
  let salt, it = KDF_ITERATIONS, raw;
  if (valid.length) {
    const env = valid[0].env;
    salt = env.salt; it = env.it || it;
    raw = await deriveBits(passphrase, b64d(salt), it);
    await decryptJSON(await importAesKey(raw), env.data).catch(() => {
      throw err(P.multi ? 'Неверная парольная фраза: в папке уже есть данные с другой фразой. Введите ту же, что в других браузерах.' : 'Неверная парольная фраза для существующего хранилища', 'BAD_PASSPHRASE');
    });
  } else {
    salt = b64e(randomBytes(16));
    raw = await deriveBits(passphrase, b64d(salt), it);
  }
  c.syncConfig = { ...structuredClone(DEFAULTS.syncConfig), ...cfg, keyMode: 'pass', auto: input.auto !== false, intervalMin: +input.intervalMin || (provider === 'folder' ? 1 : 5), keyB64: b64e(raw), saltB64: salt, it, connectedAt: Date.now() };
  await save('syncConfig');
  await ensureAlarm();
  log.info(`Синхронизация подключена: ${provider === 'folder' ? `папка «${cfg.folderName}» (с парольной фразой)` : PROVIDERS[provider]}`);
  return { ...(await syncNow({ reason: 'setup' })), keyMode: 'pass' };
}

const keyMissing = () => err('В папке есть данные Multipass, но пропал файл ключа multipass.key. Откройте Multipass в браузере, который уже подключён к этой папке, — он восстановит ключ в течение минуты. Или выберите пустую папку.', 'FOLDER_KEY_MISSING');

// Папка без парольной фразы: ключ шифрования лежит в папке (multipass.key), второй браузер просто выбирает ту же папку
async function connectFolderWithKey(c, cfg, input, dir, kf) {
  const envs = parseEnvs(await F.readDocs(dir)).filter((x) => x.env);
  let id, raw;
  if (kf) {
    id = kf.id;
    raw = b64d(kf.key);
    const own = envs.find((x) => x.env.salt === id);
    if (own) {
      await decryptJSON(await importAesKey(raw), own.env.data).catch(() => {
        throw err('Ключ multipass.key не подходит к файлам в папке — похоже, его заменили. Выберите другую папку.', 'FOLDER_KEY_BAD');
      });
    }
  } else {
    if (envs.length && envs.every((x) => !x.env.it)) throw keyMissing();
    if (envs.length) {
      throw err('В папке уже есть данные Multipass, защищённые парольной фразой. Введите ту же фразу, что в других браузерах, или выберите пустую папку.', 'NEED_PASSPHRASE');
    }
    id = b64e(randomBytes(16));
    raw = randomBytes(32);
    await F.writeKeyFile(dir, { id, key: b64e(raw), by: c.local.deviceName });
  }
  c.syncConfig = { ...structuredClone(DEFAULTS.syncConfig), ...cfg, keyMode: 'file', auto: input.auto !== false, intervalMin: +input.intervalMin || 1,
    keyB64: b64e(raw), saltB64: id, it: 0, connectedAt: Date.now() };
  await save('syncConfig');
  await ensureAlarm();
  log.info(`Синхронизация подключена: папка «${cfg.folderName}» (${kf ? 'присоединились к хранилищу в папке' : 'новое хранилище'}, без парольной фразы)`);
  return { ...(await syncNow({ reason: 'setup' })), keyMode: 'file', joined: !!kf };
}

// Папку переименовали/переместили или выбрали другую: дескриптор уже сохранила страница, ключ остаётся прежним
export async function folderChanged({ folderName } = {}) {
  const c = await initDb();
  const cfg = c.syncConfig;
  if (cfg.provider !== 'folder') throw err('Синхронизация через папку не подключена');
  const dir = await F.ensureAccess(await loadFolderHandle());
  const own = F.deviceFile(c.local.deviceId);
  const docs = F.describeDocs(await F.readDocs(dir)).filter((d) => d.ok && d.name !== own);
  const kf = await F.readKeyFile(dir);
  if (cfg.keyMode === 'file') {
    if ((kf && !kf.bad && kf.id !== cfg.saltB64) || (!kf && docs.length && !docs.some((d) => d.salt === cfg.saltB64))) {
      throw err('В этой папке другое хранилище Multipass. Выберите прежнюю папку или отключите синхронизацию и подключите эту папку заново.', 'FOLDER_FOREIGN');
    }
    if (!kf || kf.bad) await F.writeKeyFile(dir, { id: cfg.saltB64, key: cfg.keyB64, by: c.local.deviceName });
  } else if ((docs.length && !docs.some((d) => d.salt === cfg.saltB64)) || (kf && !kf.bad)) {
    throw err('В этой папке хранилище с другой парольной фразой (или без неё). Выберите прежнюю папку или отключите синхронизацию и подключитесь заново.', 'FOLDER_FOREIGN');
  }
  cfg.folderName = String(folderName || dir.name || '').slice(0, 200);
  cfg.lastError = null; cfg.lastErrorCode = null;
  await save('syncConfig');
  log.info(`Синхронизация: выбрана папка «${cfg.folderName}»`);
  return syncNow({ reason: 'manual' });
}

export async function updateOptions({ auto, intervalMin }) {
  const c = await initDb();
  if (auto != null) c.syncConfig.auto = !!auto;
  if (intervalMin != null) c.syncConfig.intervalMin = Math.max(1, +intervalMin || 5);
  await save('syncConfig');
  await ensureAlarm();
  return status(c);
}

export async function disconnect() {
  const c = await initDb();
  if (c.syncConfig.provider === 'folder') {
    // убираем файл этого браузера из папки (данные остаются у других браузеров) и забываем папку
    try {
      const dir = await loadFolderHandle();
      if (dir && (await F.permission(dir)) === 'granted') {
        const own = F.deviceFile(c.local.deviceId);
        await F.removeDoc(dir, own);
        // последний браузер ушёл из папки — ключ больше не нужен
        if (c.syncConfig.keyMode === 'file' && !(await F.readDocs(dir)).some((d) => d.name !== own)) await F.removeKeyFile(dir);
      }
    } catch {}
    await clearFolderHandle();
  }
  c.syncConfig = structuredClone(DEFAULTS.syncConfig);
  await save('syncConfig');
  await ensureAlarm();
  log.info('Синхронизация отключена');
  return status(c);
}

export function syncNow(opts = {}) {
  if (running) return running;
  running = doSync(opts).catch(async (e) => {
    const c = await initDb();
    const msg = e.message || String(e);
    if (c.syncConfig.lastError !== msg && opts.reason !== 'manual' && opts.reason !== 'popup') {
      emit('notify', e.code === 'FOLDER_PERMISSION'
        ? { id: 'sync-err', title: 'Multipass: нужен доступ к папке', message: 'Браузер сбросил доступ к папке синхронизации. Нажмите, чтобы разрешить снова.' }
        : { id: 'sync-err', title: 'Синхронизация не удалась', message: msg });
    }
    c.syncConfig.lastError = msg;
    c.syncConfig.lastErrorCode = e.code || null;
    await save('syncConfig');
    log.warn('Синхронизация: ' + msg);
    throw e;
  }).finally(() => { running = null; });
  return running;
}

function collectLocal(c) {
  const items = {};
  for (const s of Object.values(c.sites)) items['site:' + s.id] = { t: s.updatedAt || 0, v: s };
  for (const a of Object.values(c.accounts)) items['acct:' + a.id] = { t: a.updatedAt || 0, v: a };
  for (const [id, si] of Object.entries(c.sessIndex)) if (c.accounts[id]) items['sess:' + id] = { t: si.at || 0, lazy: true };
  for (const p of Object.values(c.proxies)) items['proxy:' + p.id] = { t: p.updatedAt || 0, v: p };
  for (const r of Object.values(c.rules)) items['rule:' + r.id] = { t: r.updatedAt || 0, v: r };
  if (!c.local.presenceAt || Date.now() - c.local.presenceAt > 6 * 3600e3) c.local.presenceAt = Date.now();
  items['dev:' + c.local.deviceId] = { t: c.local.presenceAt, v: { name: c.local.deviceName, lastSeen: c.local.presenceAt, active: c.local.activeMap } };
  for (const [k, t] of Object.entries(c.tombstones)) if (!items[k] || items[k].t < t) items[k] = { t, del: 1 };
  return items;
}

async function doSync({ reason = 'manual' } = {}) {
  const c = await initDb();
  const cfg = c.syncConfig;
  if (!cfg.provider) throw err('Синхронизация не настроена');
  if ((await vault.status()).locked) throw err('Хранилище заблокировано — разблокируйте для синхронизации', 'LOCKED');
  const P = providers[cfg.provider];
  if (!P) throw err('Неизвестный способ синхронизации — подключите заново');
  const pctx = { deviceId: c.local.deviceId, deviceName: c.local.deviceName };
  const key = await importAesKey(b64d(cfg.keyB64));
  for (let attempt = 0; attempt < 3; attempt++) {
    const remote = normRemote(await P.read(cfg, pctx));
    const { items: ritems, stats } = await remoteItems(key, cfg, remote.docs, !P.multi);
    const local = collectLocal(c);
    const merged = {}, toApply = [];
    let needPush = !stats.ownOk;
    for (const k of new Set([...Object.keys(local), ...Object.keys(ritems)])) {
      const L = local[k], R = ritems[k];
      if (L && (!R || L.t > R.t)) { merged[k] = L; needPush = true; }
      else if (R && (!L || R.t > L.t)) { merged[k] = R; toApply.push([k, R]); }
      else merged[k] = R || L;
    }
    // старые надгробия выбрасываем
    for (const [k, it] of Object.entries(merged)) if (it.del && Date.now() - it.t > TOMBSTONE_TTL) { delete merged[k]; delete c.tombstones[k]; }
    const applied = await applyRemote(c, toApply);
    if (needPush) {
      for (const [k, it] of Object.entries(merged)) {
        if (!it.lazy) continue;
        const s = await vault.loadSession(k.slice(5));
        if (s) merged[k] = { t: it.t, v: s }; else delete merged[k];
      }
      const doc = { format: 'multipass-sync', v: 1, updatedAt: Date.now(), by: c.local.deviceName, items: merged };
      const env = { format: 'multipass-sync-enc', v: 1, salt: cfg.saltB64, it: cfg.it, updatedAt: doc.updatedAt, by: doc.by, data: await encryptJSON(key, doc) };
      try {
        const w = await P.write(cfg, JSON.stringify(env), remote.etag, pctx);
        if (w.gistId) cfg.gistId = w.gistId;
      } catch (e) { if (e.code === 'CONFLICT') continue; throw e; }
    }
    cfg.lastSyncAt = Date.now();
    cfg.lastError = null;
    cfg.lastErrorCode = null;
    cfg.lastResult = { pulled: applied, pushed: needPush, items: Object.keys(merged).length, at: Date.now(), reason,
      ...(P.multi ? { files: stats.used + (stats.ownOk ? 0 : 1), foreign: stats.foreign, bad: stats.bad, stale: stats.stale } : {}) };
    await save('syncConfig', 'local');
    if (applied || reason === 'manual' || reason === 'setup') log.info(`Синхронизация: получено ${applied}, ${needPush ? 'отправлено' : 'без изменений'}`);
    return cfg.lastResult;
  }
  throw err('Конфликт записи — данные одновременно меняли в другом браузере. Повторите.');
}

async function applyRemote(c, toApply) {
  if (!toApply.length) return 0;
  let n = 0, routes = false;
  for (const [k, it] of toApply) {
    const i = k.indexOf(':');
    const type = k.slice(0, i), id = k.slice(i + 1);
    if (type === 'dev') { if (id !== c.local.deviceId && it.v) c.devices[id] = it.v; continue; }
    n++;
    if (it.del) {
      c.tombstones[k] = it.t;
      if (type === 'site') delete c.sites[id];
      if (type === 'acct') { delete c.accounts[id]; delete c.sessIndex[id]; for (const [sid, aid] of Object.entries(c.local.activeMap)) if (aid === id) delete c.local.activeMap[sid]; await removeRaw(['sess:' + id, 'prev:' + id]); routes = true; }
      if (type === 'sess') { delete c.sessIndex[id]; await removeRaw(['sess:' + id]); }
      if (type === 'proxy') { delete c.proxies[id]; delete c.proxyStatus[id]; routes = true; }
      if (type === 'rule') { delete c.rules[id]; routes = true; }
      continue;
    }
    delete c.tombstones[k];
    if (type === 'site') { c.sites[id] = it.v; routes = true; }
    else if (type === 'acct') { c.accounts[id] = it.v; routes = true; }
    else if (type === 'sess') { await vault.storeSession(id, it.v, { keepPrev: true }); c.sessIndex[id] = summarize(it.v); }
    else if (type === 'proxy') { const old = c.proxies[id]; c.proxies[id] = it.v; if (old && (old.host !== it.v.host || old.port !== it.v.port || old.type !== it.v.type)) delete c.proxyStatus[id]; routes = true; }
    else if (type === 'rule') { c.rules[id] = it.v; routes = true; }
  }
  await save('sites', 'accounts', 'sessIndex', 'proxies', 'proxyStatus', 'rules', 'tombstones', 'devices', 'local');
  await dedupeSites();
  if (routes) await proxy.apply();
  emit('data-changed', { sync: false });
  return n;
}
