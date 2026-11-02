import { initDb, save } from './db.js';

let timer = null;
export async function log(level, msg) {
  const c = await initDb();
  c.log.unshift({ t: Date.now(), level, msg: String(msg).slice(0, 500) });
  if (c.log.length > 300) c.log.length = 300;
  clearTimeout(timer);
  timer = setTimeout(() => save('log').catch(() => {}), 400);
}
export const info = (m) => log('info', m);
export const warn = (m) => log('warn', m);
export const error = (m) => log('error', m);
