// Мини-шина событий внутри service worker (чтобы модули не импортировали друг друга по кругу)
const handlers = new Map();
export function on(evt, fn) { if (!handlers.has(evt)) handlers.set(evt, new Set()); handlers.get(evt).add(fn); }
export function emit(evt, data) {
  for (const fn of handlers.get(evt) || []) { try { const r = fn(data); if (r && r.catch) r.catch((e) => console.warn(evt, e)); } catch (e) { console.warn(evt, e); } }
}
