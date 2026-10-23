import test from 'node:test';
import assert from 'node:assert/strict';
import { openStoreAtStartup } from '../src/startup.js';

test('cold ClickHouse startup waits for transient connection failures and returns the opened store', async () => {
  let calls = 0;
  const waits = [], store = {};
  const result = await openStoreAtStartup({ storageBackend: 'clickhouse' }, {
    open: async () => { if (++calls < 3) throw Object.assign(new Error('initializing'), { code: 'ECONNREFUSED' }); return store; },
    sleep: async ms => waits.push(ms),
  });
  assert.equal(result, store);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [500, 1000]);
});

test('startup fails on permanent errors and bounds retries without retrying another storage backend', async () => {
  for (const [config, code, expected] of [
    [{ storageBackend: 'clickhouse' }, 'AUTHENTICATION_FAILED', 1],
    [{ storageBackend: 'clickhouse' }, 'ECONNREFUSED', 3],
    [{ storageBackend: 'json' }, 'ECONNREFUSED', 1],
  ]) {
    let calls = 0;
    const failure = Object.assign(new Error('unavailable'), { code });
    await assert.rejects(openStoreAtStartup(config, { attempts: 3, sleep: async () => {},
      open: async () => { calls++; throw failure; } }), error => error === failure);
    assert.equal(calls, expected);
  }
});
