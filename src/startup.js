import { setTimeout as delay } from 'node:timers/promises';
import { openStore } from './storage.js';

const transient = error => {
  const codes = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN']);
  for (let cause = error, depth = 0; cause && depth < 5; cause = cause.cause, depth++) {
    if (codes.has(cause.code)) return true;
  }
  return false;
};

// ClickHouse's first initialization can briefly close its listener after a local
// health probe succeeds. Wait only for transient connection failures, with a cap.
export async function openStoreAtStartup(config, { open = openStore, sleep = delay, attempts = 20 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await open(config); }
    catch (error) {
      if (config.storageBackend !== 'clickhouse' || !transient(error) || attempt >= attempts) throw error;
      await sleep(Math.min(500 * attempt, 2000));
    }
  }
}
