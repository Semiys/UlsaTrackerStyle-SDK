import { loadConfig } from './config.js';
import { AnalyticsStore } from './store.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer from 1 to 65535');
}

const config = await loadConfig();
const store = await AnalyticsStore.open(config.databasePath);
const app = createApp({ config, store });

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`UlsaTrackerStyle SDK 0.3.0: container port ${port}; dashboard /dashboard`);
  console.log('Access keys are in DATA_DIR/access.json. Use node src/show-access.js inside the container.');
});

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
  server.close(async () => {
    try { await store.close(); clearTimeout(deadline); process.exit(0); }
    catch { process.exit(1); }
  });
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
