#!/usr/bin/env node
// Multipass Sync Server — крошечный сервер синхронизации без зависимостей (Node.js 18+).
// Хранит только зашифрованные блобы: ключ шифрования есть лишь у ваших браузеров.
//
//   node server.mjs --token ВАШ_ДЛИННЫЙ_ТОКЕН [--port 8787] [--host 0.0.0.0] [--data ./data]
//   или: MULTIPASS_TOKENS=token1,token2 node server.mjs
//
// API: GET /v1/vault, PUT /v1/vault (If-Match / If-None-Match), GET /health
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; };
const tokens = new Set([...(process.env.MULTIPASS_TOKENS || '').split(','), ...argv.flatMap((a, i) => (a === '--token' ? [argv[i + 1]] : []))].map((s) => (s || '').trim()).filter(Boolean));
const PORT = +opt('port', process.env.PORT || 8787);
const HOST = opt('host', process.env.HOST || '0.0.0.0');
const DATA = path.resolve(opt('data', process.env.MULTIPASS_DATA || './data'));
const MAX = 64 * 1024 * 1024;
const KEEP_BACKUPS = 5;

if (!tokens.size) { console.error('Укажите хотя бы один токен: --token <secret> или MULTIPASS_TOKENS'); process.exit(1); }
for (const t of tokens) if (t.length < 16) { console.error('Токен должен быть не короче 16 символов'); process.exit(1); }
fs.mkdirSync(DATA, { recursive: true });

const fileFor = (token) => path.join(DATA, crypto.createHash('sha256').update(token).digest('hex').slice(0, 32) + '.json');
const etagOf = (buf) => '"' + crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32) + '"';
const locks = new Map();
const withLock = (key, fn) => { const prev = locks.get(key) || Promise.resolve(); const p = prev.then(fn, fn); locks.set(key, p.catch(() => {})); return p; };

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'ETag', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function auth(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const t = m[1].trim();
  for (const k of tokens) { if (k.length === t.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(t))) return k; }
  return null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return send(res, 204, '', { 'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS', 'Access-Control-Allow-Headers': 'Authorization,Content-Type,If-Match,If-None-Match' });
  if (url.pathname === '/health') return send(res, 200, 'ok');
  if (url.pathname !== '/v1/vault') return send(res, 404, 'not found');
  const token = auth(req);
  if (!token) return send(res, 401, 'unauthorized');
  const file = fileFor(token);
  if (req.method === 'GET') {
    return withLock(file, async () => {
      if (!fs.existsSync(file)) return send(res, 404, 'empty');
      const buf = fs.readFileSync(file);
      send(res, 200, buf, { 'Content-Type': 'application/json', ETag: etagOf(buf) });
    });
  }
  if (req.method === 'PUT') {
    const chunks = [];
    let size = 0;
    req.on('data', (d) => { size += d.length; if (size > MAX) { send(res, 413, 'too large'); req.destroy(); } else chunks.push(d); });
    req.on('end', () => withLock(file, async () => {
      if (size > MAX) return;
      const body = Buffer.concat(chunks);
      try { const j = JSON.parse(body.toString('utf8')); if (j.format !== 'multipass-sync-enc') throw 0; } catch { return send(res, 400, 'bad payload'); }
      const exists = fs.existsSync(file);
      const cur = exists ? etagOf(fs.readFileSync(file)) : null;
      const im = req.headers['if-match'], inm = req.headers['if-none-match'];
      if (im && im !== cur) return send(res, 412, 'conflict');
      if (inm === '*' && exists) return send(res, 412, 'conflict');
      if (exists) {
        for (let i = KEEP_BACKUPS - 1; i >= 1; i--) if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
        fs.copyFileSync(file, `${file}.1`);
      }
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, file);
      send(res, 200, JSON.stringify({ ok: true }), { 'Content-Type': 'application/json', ETag: etagOf(body) });
    }));
    return;
  }
  send(res, 405, 'method not allowed');
});

server.listen(PORT, HOST, () => console.log(`Multipass sync server: http://${HOST}:${PORT}  (данные: ${DATA}, токенов: ${tokens.size})`));
