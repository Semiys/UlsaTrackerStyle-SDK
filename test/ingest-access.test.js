import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestAccess } from '../src/ingest-access.js';
import { loadConfig } from '../src/config.js';
const key = 'a'.repeat(64);
function request(gate, raw = key) {
  const headers = {};
  const response = { set(name, value) { headers[name] = value; return this; }, vary() {} };
  let error;
  gate({ get(name) { return name === 'Authorization' ? 'Bearer ' + raw : undefined; } }, response, value => { error = value; });
  return { error, headers };
}
test('default ingestion budget admits the declared 600 requests per minute while remaining bounded', () => {
  const gate = ingestAccess({ config: { ingestKey: key } });
  for (let i = 0; i < 1200; i++) assert.equal(request(gate).error, undefined);
  const denied = request(gate);
  assert.equal(denied.error.status, 429);
  assert.ok(Number(denied.headers['Retry-After']) >= 1);
});
test('configured windows reset and invalid keys do not consume the valid budget', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const gate = ingestAccess({ config: { ingestKey: key, ingestRateLimitRequests: 2 } });
  assert.equal(request(gate, 'invalid').error.status, 401);
  assert.equal(request(gate).error, undefined); assert.equal(request(gate).error, undefined);
  assert.equal(request(gate).error.status, 429);
  t.mock.timers.tick(60000); assert.equal(request(gate).error, undefined);
});
test('independent applications have independent bounded ingestion budgets', () => {
  const other = 'b'.repeat(64);
  const gate = ingestAccess({ config: { ingestKey: key, ingestRateLimitRequests: 1 },
    accounts: { resolveKey(raw) { return raw === other ? { id: 'app_b', platform: 'android' } : null; } } });
  assert.equal(request(gate).error, undefined); assert.equal(request(gate).error.status, 429);
  assert.equal(request(gate, other).error, undefined); assert.equal(request(gate, other).error.status, 429);
});
test('configuration rejects disabled non-integer and excessive ingestion budgets', async t => {
  for (const value of ['0', '-1', '1.5', 'NaN', '60001', '1200requests'])
    await assert.rejects(loadConfig({ INGEST_RATE_LIMIT_REQUESTS: value }), /INGEST_RATE_LIMIT_REQUESTS/);
  const directory = await mkdtemp(join(tmpdir(), 'ulsa-rate-')); t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal((await loadConfig({ DATA_DIR: directory })).ingestRateLimitRequests, 1200);
  assert.equal((await loadConfig({ DATA_DIR: directory, INGEST_RATE_LIMIT_REQUESTS: '600' })).ingestRateLimitRequests, 600);
});
