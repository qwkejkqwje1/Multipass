// Разбор списков прокси в любых популярных форматах
const SCHEMES = { http: 'http', https: 'https', socks: 'socks5', socks5: 'socks5', socks5h: 'socks5', socks4: 'socks4', socks4a: 'socks4' };
export const PROXY_TYPES = ['http', 'https', 'socks5', 'socks4'];

const isPort = (s) => /^\d{1,5}$/.test(s) && +s > 0 && +s < 65536;
const isHostLike = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || /^\[[0-9a-f:.]+\]$/i.test(s) || /^(?=.{1,253}$)([a-z0-9-_]+\.)+[a-z0-9-]{2,}$/i.test(s) || s === 'localhost';

function splitHostPort(s) {
  // поддержка [ipv6]:port
  const m6 = s.match(/^\[([0-9a-f:.]+)\]:(\d+)$/i);
  if (m6) return { host: m6[1], port: m6[2] };
  const i = s.lastIndexOf(':');
  if (i < 0) return null;
  return { host: s.slice(0, i), port: s.slice(i + 1) };
}

function stripBrackets(h) { return h.replace(/^\[|\]$/g, ''); }

export function parseProxyLine(rawLine, defaultType = 'auto') {
  let line = rawLine.trim();
  if (!line || line.startsWith('#') || line.startsWith('//')) return null;
  let label = '';
  const hashIdx = line.search(/\s+#/);
  if (hashIdx > 0) { label = line.slice(hashIdx).replace(/^\s+#\s*/, '').trim(); line = line.slice(0, hashIdx).trim(); }
  // "host port" или "host:port label"
  const ws = line.split(/\s+/).filter(Boolean);
  if (ws.length >= 2 && !ws[0].includes(':') && isPort(ws[1])) { line = `${ws[0]}:${ws[1]}`; if (ws.length > 2 && !label) label = ws.slice(2).join(' '); }
  else if (ws.length >= 2) { line = ws[0]; if (!label) label = ws.slice(1).join(' '); }

  let type = defaultType;
  const sm = line.match(/^([a-z0-9]+):\/\//i);
  if (sm) {
    const t = SCHEMES[sm[1].toLowerCase()];
    if (!t) return { error: `Неизвестный протокол «${sm[1]}»`, raw: rawLine };
    type = t; line = line.slice(sm[0].length);
  }
  line = line.replace(/\/+$/, '');
  let host, port, username = '', password = '';
  const at = line.lastIndexOf('@');
  if (at > 0) {
    const left = line.slice(0, at), right = line.slice(at + 1);
    const hpR = splitHostPort(right), hpL = splitHostPort(left);
    if (hpR && isPort(hpR.port) && isHostLike(hpR.host)) {
      host = hpR.host; port = hpR.port;
      const ci = left.indexOf(':'); username = ci >= 0 ? left.slice(0, ci) : left; password = ci >= 0 ? left.slice(ci + 1) : '';
    } else if (hpL && isPort(hpL.port) && isHostLike(hpL.host)) {
      host = hpL.host; port = hpL.port;
      const ci = right.indexOf(':'); username = ci >= 0 ? right.slice(0, ci) : right; password = ci >= 0 ? right.slice(ci + 1) : '';
    } else return { error: 'Не удалось найти host:port', raw: rawLine };
  } else {
    let parts;
    const m6 = line.match(/^(\[[0-9a-f:.]+\]):(\d+)(?::(.*))?$/i);
    if (m6) parts = [m6[1], m6[2], ...(m6[3] ? m6[3].split(':') : [])];
    else parts = line.split(':');
    if (parts.length === 2) { [host, port] = parts; }
    else if (parts.length === 3) {
      [host, port] = parts;
      const t = SCHEMES[parts[2].toLowerCase()];
      if (t) type = t; else username = parts[2];
    } else if (parts.length >= 4) {
      if (isHostLike(parts[0]) && isPort(parts[1])) { host = parts[0]; port = parts[1]; username = parts[2]; password = parts.slice(3).join(':'); }
      else if (isPort(parts[parts.length - 1]) && isHostLike(parts[parts.length - 2])) { port = parts.pop(); host = parts.pop(); username = parts[0]; password = parts.slice(1).join(':'); }
      else return { error: 'Не удалось распознать формат', raw: rawLine };
    } else return { error: 'Нет порта', raw: rawLine };
  }
  host = stripBrackets(String(host).trim());
  if (!isHostLike(host) && !host.includes(':')) return { error: `Некорректный хост «${host}»`, raw: rawLine };
  if (!isPort(String(port).trim())) return { error: `Некорректный порт «${port}»`, raw: rawLine };
  try { username = decodeURIComponent(username); password = decodeURIComponent(password); } catch {}
  return { type, host: host.toLowerCase(), port: +port, username, password, label, raw: rawLine.trim() };
}

export function parseProxyList(text, { defaultType = 'auto' } = {}) {
  const items = [], errors = [];
  const seen = new Set();
  const lines = String(text || '').split(/\r?\n/);
  lines.forEach((l, i) => {
    const r = parseProxyLine(l, defaultType);
    if (!r) return;
    if (r.error) { errors.push({ line: i + 1, raw: r.raw, reason: r.error }); return; }
    const key = proxyKey(r);
    if (seen.has(key)) return;
    seen.add(key);
    items.push(r);
  });
  return { items, errors };
}

export function proxyKey(p) { return `${p.host}|${p.port}|${p.username || ''}|${p.password || ''}`; }

export function formatProxy(p, style = 'url') {
  const auth = p.username ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password || '')}@` : '';
  const host = p.host.includes(':') ? `[${p.host}]` : p.host;
  if (style === 'colon') return p.username ? `${host}:${p.port}:${p.username}:${p.password || ''}` : `${host}:${p.port}`;
  const t = p.type === 'auto' ? 'http' : p.type;
  return `${t}://${auth}${host}:${p.port}`;
}
