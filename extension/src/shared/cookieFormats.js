// Импорт/экспорт куки в форматах Cookie-Editor / EditThisCookie (JSON), Puppeteer/Playwright и Netscape cookies.txt
const SAME_SITE_IN = { no_restriction: 'no_restriction', none: 'no_restriction', lax: 'lax', strict: 'strict', unspecified: 'unspecified' };

export function normalizeCookie(c) {
  if (!c || typeof c !== 'object' || !c.name && c.name !== '') return null;
  const domain = String(c.domain || c.host || '').trim();
  if (!domain) return null;
  let exp = c.expirationDate ?? c.expires ?? c.expiry ?? null;
  if (typeof exp === 'string') exp = Date.parse(exp) / 1000;
  if (typeof exp === 'number' && exp > 1e11) exp = exp / 1000; // миллисекунды
  const session = c.session === true || exp == null || exp <= 0;
  const ss = SAME_SITE_IN[String(c.sameSite ?? '').toLowerCase()] || 'unspecified';
  const hostOnly = c.hostOnly != null ? !!c.hostOnly : !domain.startsWith('.');
  const o = {
    name: String(c.name), value: String(c.value ?? ''), domain: domain,
    path: c.path || '/', secure: !!c.secure, httpOnly: !!(c.httpOnly ?? c.httponly), sameSite: ss, hostOnly,
  };
  if (!session) o.expirationDate = exp;
  if (c.partitionKey && typeof c.partitionKey === 'object') o.partitionKey = c.partitionKey;
  return o;
}

export function parseNetscape(text) {
  const out = [];
  for (let line of String(text).split(/\r?\n/)) {
    let httpOnly = false;
    if (line.startsWith('#HttpOnly_')) { httpOnly = true; line = line.slice(10); }
    if (!line.trim() || line.startsWith('#')) continue;
    const p = line.split('\t');
    if (p.length < 7) continue;
    const [domain, flag, path, secure, expiry, name, ...rest] = p;
    const exp = +expiry;
    out.push(normalizeCookie({
      domain, hostOnly: flag.toUpperCase() !== 'TRUE', path, secure: secure.toUpperCase() === 'TRUE',
      expirationDate: exp > 0 ? exp : null, name, value: rest.join('\t'), httpOnly,
    }));
  }
  return out.filter(Boolean);
}

// Возвращает { cookies, storage?, kind }
export function parseCookieText(text) {
  const t = String(text || '').trim();
  if (!t) throw new Error('Пусто');
  if (t.startsWith('[') || t.startsWith('{')) {
    let j;
    try { j = JSON.parse(t); } catch { throw new Error('Некорректный JSON'); }
    let arr = null, storage = null;
    if (Array.isArray(j)) arr = j;
    else if (Array.isArray(j.cookies)) { arr = j.cookies; storage = j.storage || null;
      // Playwright storageState: origins: [{origin, localStorage: [{name, value}]}]
      if (!storage && Array.isArray(j.origins)) {
        storage = {};
        for (const o of j.origins) storage[o.origin] = { local: Object.fromEntries((o.localStorage || []).map((x) => [x.name, x.value])), session: {} };
      }
    }
    if (!arr) throw new Error('Не найден массив куки');
    return { cookies: arr.map(normalizeCookie).filter(Boolean), storage, kind: 'json' };
  }
  const cookies = parseNetscape(t);
  if (!cookies.length) throw new Error('Формат не распознан (ожидается JSON или Netscape cookies.txt)');
  return { cookies, storage: null, kind: 'netscape' };
}

export function toCookieEditorJSON(cookies) {
  return JSON.stringify(cookies.map((c, i) => ({
    domain: c.domain, expirationDate: c.expirationDate, hostOnly: !!c.hostOnly, httpOnly: !!c.httpOnly,
    name: c.name, path: c.path, sameSite: c.sameSite || 'unspecified', secure: !!c.secure,
    session: !c.expirationDate, storeId: '0', value: c.value, id: i + 1,
  })), null, 2);
}

export function toNetscape(cookies) {
  const lines = ['# Netscape HTTP Cookie File', '# Экспорт Multipass', ''];
  for (const c of cookies) {
    const domain = c.hostOnly ? c.domain.replace(/^\./, '') : (c.domain.startsWith('.') ? c.domain : '.' + c.domain);
    lines.push([(c.httpOnly ? '#HttpOnly_' : '') + domain, c.hostOnly ? 'FALSE' : 'TRUE', c.path || '/', c.secure ? 'TRUE' : 'FALSE',
      Math.round(c.expirationDate || 0), c.name, c.value].join('\t'));
  }
  return lines.join('\n');
}

export function cookieDomainsSummary(cookies) {
  const m = new Map();
  for (const c of cookies) { const d = c.domain.replace(/^\./, ''); m.set(d, (m.get(d) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
