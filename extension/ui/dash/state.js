// Общее состояние панели: данные из service worker + состояние интерфейса, переживающее перерисовки
export const S = {
  D: null,
  ui: {
    acctQuery: '', acctSel: new Set(),
    pxQuery: '', pxGroup: '*', pxStatus: 'all', pxSel: new Set(), pxSort: { key: 'status', dir: 1 }, pxImport: '', pxImportGroup: '', pxImportType: 'auto', pxImportCheck: true, pxImportResult: null, pxLimit: 300,
    routeHost: '', routeResult: null, ruleDraft: { pattern: '', target: 'direct', note: '' },
    syncProvider: 'folder', syncForm: {}, folderPick: null,
    exportSel: null, exportMode: 'all', exportCode: null,
    importText: '', importResult: null, ckText: '', ckName: '', ckHost: '',
  },
};
let renderFn = () => {};
let reloadFn = async () => {};
export function setHooks({ render, reload }) { renderFn = render; reloadFn = reload; }
export const rerender = () => renderFn();
export const reload = () => reloadFn();
export function go(hash) { if (location.hash.slice(1) === hash) renderFn(); else location.hash = hash; }
