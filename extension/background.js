// Multipass — service worker
import { initDb } from './src/bg/db.js';
import * as router from './src/bg/router.js';
import * as proxy from './src/bg/proxy.js';
import * as accounts from './src/bg/accounts.js';
import * as vault from './src/bg/vault.js';
import * as sync from './src/bg/sync.js';
import * as ui from './src/bg/ui.js';
import * as keepalive from './src/bg/keepalive.js';

// Все слушатели регистрируются синхронно — требование MV3
router.register();
proxy.register();
accounts.register();
vault.register();
sync.register();
ui.register();
keepalive.register();

async function boot(reason) {
  await initDb();
  await proxy.apply();
  await ui.setupMenus();
  await proxy.ensureAlarms();
  await sync.ensureAlarm();
  // временные куки: вернуть пропавшие после перезапуска, закрепить и продлить действующие
  await keepalive.onBoot(reason).catch((e) => console.warn('keepalive', e));
  if (reason !== 'install') setTimeout(() => sync.syncNow({ reason: 'startup' }).catch(() => {}), 4000);
}

chrome.runtime.onInstalled.addListener((d) => {
  boot(d.reason).catch((e) => console.error(e));
  if (d.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('ui/dashboard.html#welcome') });
});
chrome.runtime.onStartup.addListener(() => boot('startup').catch((e) => console.error(e)));
initDb();
