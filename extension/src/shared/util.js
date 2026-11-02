// Общие утилиты (работают и в service worker, и на страницах расширения)
export const now = () => Date.now();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function uid(prefix = '') {
  const a = crypto.getRandomValues(new Uint8Array(10));
  return prefix + Array.from(a, (b) => (b % 36).toString(36)).join('');
}

export function token12() {
  const a = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(a, (b) => (b % 36).toString(36)).join('');
}

export function err(message, code) {
  const e = new Error(message);
  if (code) e.code = code;
  return e;
}

export async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let i = 0;
  const run = async () => {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = await worker(items[idx], idx); } catch (e) { results[idx] = { error: e }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

export const PALETTE = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#8b5cf6', '#ef4444', '#84cc16', '#f97316', '#14b8a6', '#3b82f6', '#a855f7'];

export function pickColor(used = []) {
  const free = PALETTE.filter((c) => !used.includes(c));
  const src = free.length ? free : PALETTE;
  return src[Math.floor(Math.random() * src.length)];
}

export function initials(name = '') {
  const clean = String(name).replace(/@.*/, '').replace(/[^\p{L}\p{N}\s._-]/gu, ' ').trim();
  if (!clean) return '?';
  const parts = clean.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return clean.slice(0, 2).toUpperCase();
}

export function plural(n, one, few, many) {
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return few;
  return many;
}

export function ago(ts) {
  if (!ts) return 'никогда';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 0) return 'только что';
  if (s < 45) return 'только что';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} ${plural(m, 'минуту', 'минуты', 'минут')} назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ${plural(h, 'час', 'часа', 'часов')} назад`;
  const d = Math.round(h / 24);
  if (d < 45) return `${d} ${plural(d, 'день', 'дня', 'дней')} назад`;
  return new Date(ts).toLocaleDateString('ru-RU');
}

export function until(ts) {
  if (!ts) return '';
  const s = Math.round((ts - Date.now()) / 1000);
  if (s <= 0) return 'истекла';
  const d = Math.floor(s / 86400);
  if (d >= 1) return `${d} ${plural(d, 'день', 'дня', 'дней')}`;
  const h = Math.floor(s / 3600);
  if (h >= 1) return `${h} ${plural(h, 'час', 'часа', 'часов')}`;
  const m = Math.max(1, Math.floor(s / 60));
  return `${m} мин`;
}

export function bytes(n) {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
  return `${(n / 1024 / 1024).toFixed(1)} МБ`;
}

export function browserLabel(ua = (typeof navigator !== 'undefined' ? navigator.userAgent : '')) {
  let name = 'Chromium';
  let m;
  if ((m = ua.match(/Edg\/(\d+)/))) name = `Edge ${m[1]}`;
  else if ((m = ua.match(/OPR\/(\d+)/))) name = `Opera ${m[1]}`;
  else if ((m = ua.match(/YaBrowser\/(\d+)/))) name = `Яндекс ${m[1]}`;
  else if ((m = ua.match(/Vivaldi\/(\d+)/))) name = `Vivaldi ${m[1]}`;
  else if ((m = ua.match(/Chrome\/(\d+)/))) name = `Chrome ${m[1]}`;
  let os = '';
  if (/Windows/.test(ua)) os = 'Windows';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  return os ? `${name} · ${os}` : name;
}

export function isHttpUrl(u) { return typeof u === 'string' && /^https?:\/\//i.test(u); }

export function safeUrl(u) { try { return new URL(u); } catch { return null; } }

export function shortHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
