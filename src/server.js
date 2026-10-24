import { loadConfig } from './config.js';
import { openStoreAtStartup } from './startup.js';
import { createApp } from './app.js';
import { SERVER_VERSION } from './version.js';
import { AccountStore } from './accounts.js';
import { GrafanaCabinet } from './grafana-cabinet.js';
import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer from 1 to 65535');
}

const config = await loadConfig();
const store = await openStoreAtStartup(config);
const accounts = config.consoleEnabled ? new AccountStore(config.accountsPath) : null;
const grafana = accounts && config.dashboardProvider === 'grafana' ? new GrafanaCabinet({ config, accounts, store }) : null;
const app = createApp({ config, store, accounts, grafana });

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`UlsaTrackerStyle SDK ${SERVER_VERSION}: ${config.storageBackend}; container port ${port}; dashboard /dashboard`);
  console.log('Access keys are in DATA_DIR/access.json. Use node src/show-access.js inside the container.');
});
const panelServer = grafana ? createServer((req, res) => {
  if (req.url === '/') { res.writeHead(302, { Location: '/grafana/d/ulsatracker/events' }); return res.end(); }
  app(req, res);
}).listen(3000, '0.0.0.0') : null;
panelServer?.on('error', error => { console.error('Panel gateway could not listen:', error.code); shutdown(); });

server.on('error', async error => {
  console.error('Server could not listen:', error.code);
  await store.close();
  process.exit(1);
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 15_000).unref();
  const close = listener => new Promise(resolve => listener ? listener.close(resolve) : resolve());
  Promise.all([close(server), close(panelServer)]).then(async () => {
    try { await store.close(); accounts?.close(); clearTimeout(deadline); process.exit(0); }
    catch { process.exit(1); }
  });
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
