// AES-256-GCM + PBKDF2-SHA256 + gzip. Всё на WebCrypto, без зависимостей.
export const KDF_ITERATIONS = 310000;
const te = new TextEncoder(), td = new TextDecoder();

export function randomBytes(n) { return crypto.getRandomValues(new Uint8Array(n)); }

export function b64e(u8) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}
export function b64d(str) {
  const s = atob(str);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}
export const b64urlE = (u8) => b64e(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const b64urlD = (s) => b64d(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));

async function pipe(u8, stream) {
  const out = new Blob([u8]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}
export const gzip = (u8) => pipe(u8, new CompressionStream('gzip'));
export const gunzip = (u8) => pipe(u8, new DecompressionStream('gzip'));

export async function deriveBits(password, salt, iterations = KDF_ITERATIONS) {
  const base = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256));
}

export function importAesKey(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptJSON(key, obj) {
  const iv = randomBytes(12);
  const data = await gzip(te.encode(JSON.stringify(obj)));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  return { iv: b64e(iv), ct: b64e(ct), z: 1 };
}

export async function decryptJSON(key, env) {
  let pt;
  try {
    pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(env.iv) }, key, b64d(env.ct)));
  } catch {
    const e = new Error('Неверный пароль или повреждённые данные');
    e.code = 'DECRYPT';
    throw e;
  }
  const raw = env.z ? await gunzip(pt) : pt;
  return JSON.parse(td.decode(raw));
}

export async function sealWithPassword(obj, password, iterations = KDF_ITERATIONS) {
  const salt = randomBytes(16);
  const key = await importAesKey(await deriveBits(password, salt, iterations));
  return { kdf: { alg: 'PBKDF2-SHA256', it: iterations, salt: b64e(salt) }, ...(await encryptJSON(key, obj)) };
}

export async function openWithPassword(env, password) {
  const key = await importAesKey(await deriveBits(password, b64d(env.kdf.salt), env.kdf.it));
  return decryptJSON(key, env);
}

export async function sha256hex(text) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(text)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Компактная упаковка без шифрования (для «кода переноса» без пароля)
export async function packPlain(obj) { return b64urlE(await gzip(te.encode(JSON.stringify(obj)))); }
export async function unpackPlain(s) { return JSON.parse(td.decode(await gunzip(b64urlD(s)))); }
