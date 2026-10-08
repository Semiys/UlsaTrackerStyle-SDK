import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonAnalyticsStore } from '../src/json-store.js';
import { validateBatch } from '../src/events.js';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/storage.js';

const event = (overrides = {}) => ({ eventId: randomUUID(), sessionId: randomUUID(),
  occurredAt: new Date().toISOString(), name: 'button_click', screen: 'collection',
  platform: 'android', appVersion: '1.2', properties: { button: 'open_filters' }, ...overrides });
const validated = events => validateBatch({ schemaVersion: 1, events });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ulsa-json-'));
  const path = join(directory, 'events.json');
  const store = await JsonAnalyticsStore.open(path);
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, path, store };
}

test('JSON acknowledgement, parallel retries and reopening preserve exactly one copy', async t => {
  const f = await fixture(t);
  const packet = validated([event(), event()]);
  const results = await Promise.all(Array.from({ length: 12 }, () => f.store.ingest('demo', packet)));
  assert.equal(results.reduce((sum, row) => sum + row.accepted, 0), 2);
  assert.deepEqual(results[0].acknowledgedEventIds, packet.map(e => e.eventId));
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).events.length, 2);
  await f.store.close();
  const reopened = await JsonAnalyticsStore.open(f.path);
  try {
    assert.equal((await reopened.stats('demo', 7)).totals.events, 2);
    assert.equal((await reopened.ingest('demo', packet)).duplicates, 2);
  } finally { await reopened.close(); }
});

test('JSON rejects a conflicting batch before saving any of its new events', async t => {
  const f = await fixture(t);
  const original = event();
  await f.store.ingest('demo', validated([original]));
  const before = await readFile(f.path, 'utf8');
  await assert.rejects(f.store.ingest('demo', validated([event(), { ...original, name: 'screen_view' }])), { code: 'event_id_conflict' });
  assert.equal(await readFile(f.path, 'utf8'), before);
  assert.equal((await f.store.stats('demo', 7)).totals.events, 1);
});

test('JSON file errors do not acknowledge or change already saved data', async t => {
  const f = await fixture(t);
  await f.store.ingest('demo', validated([event()]));
  const before = await readFile(f.path, 'utf8');
  f.store.path = join(f.directory, 'missing-directory', 'events.json');
  await assert.rejects(f.store.ingest('demo', validated([event()])));
  assert.equal((await f.store.stats('demo', 7)).totals.events, 1);
  assert.equal(await readFile(f.path, 'utf8'), before);
});

test('corrupt or modified JSON is rejected without being overwritten', async t => {
  const f = await fixture(t);
  await writeFile(f.path, '{broken');
  await assert.rejects(JsonAnalyticsStore.open(f.path));
  assert.equal(await readFile(f.path, 'utf8'), '{broken');
  await f.store.ingest('demo', validated([event()]));
  const data = JSON.parse(await readFile(f.path, 'utf8'));
  data.events[0].name = 'changed';
  await writeFile(f.path, JSON.stringify(data));
  await assert.rejects(JsonAnalyticsStore.open(f.path), /checksum/);
});

test('JSON statistics separate types, UTC ranges and projects; recent events omit private fields', async t => {
  const f = await fixture(t);
  const now = new Date(); const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const sessionId = randomUUID();
  const records = validated([
    event({ sessionId, occurredAt: new Date(midnight).toISOString(), name: 'screen_view', properties: {} }),
    event({ sessionId, occurredAt: new Date(midnight).toISOString(), properties: { button: '<script>hello</script>' } }),
    event({ sessionId, occurredAt: new Date(midnight).toISOString(), name: 'action_success', screen: null, properties: { action: 7 } }),
    event({ occurredAt: new Date(midnight - 1).toISOString() }),
  ]);
  await f.store.ingest('demo', records);
  await f.store.ingest('another', validated([event()]));
  const stats = await f.store.stats('demo', 1, now);
  assert.deepEqual(stats.totals, { events: 3, sessions: 1, screenViews: 1, buttonClicks: 1, successfulActions: 1 });
  assert.deepEqual(stats.byButton, [{ button: '<script>hello</script>', screen: 'collection', count: 1 }]);
  assert.deepEqual(stats.byAction, [{ action: null, screen: null, count: 1 }]);
  assert.equal(stats.daily[0].count, 3);
  const recent = await f.store.recent('demo', 2);
  assert.equal(recent.length, 2);
  assert.equal(Object.hasOwn(recent[0], 'projectId'), false);
  assert.equal(Object.hasOwn(recent[0], 'payloadHash'), false);
});

test('JSON breakdowns limit 100 groups but preserve complete totals', async t => {
  const f = await fixture(t);
  const records = Array.from({ length: 101 }, (_, i) => event({ properties: { button: `button_${i}` } }));
  for (let i = 0; i < records.length; i += 100) await f.store.ingest('demo', validated(records.slice(i, i + 100)));
  const stats = await f.store.stats('demo', 7);
  assert.equal(stats.byButton.length, 100);
  assert.equal(stats.truncated.byButton, true);
  assert.equal(stats.totals.events, 101);
  assert.equal(stats.daily.reduce((sum, row) => sum + row.count, 0), 101);
});

test('lab mode uses JSON without DuckDB and refuses an existing private project volume', async t => {
  const f = await fixture(t);
  const config = await loadConfig({ DATA_DIR: f.directory, DEMO_MODE: '1' });
  const opened = await openStore(config);
  try { assert.equal(opened instanceof JsonAnalyticsStore, true); } finally { await opened.close(); }
  assert.equal(config.projectId, 'lab2-demo');
  await assert.rejects(loadConfig({ DATA_DIR: f.directory, DEMO_MODE: '1', STORAGE_BACKEND: 'duckdb' }), /requires JSON/);
  await assert.rejects(loadConfig({ DATA_DIR: f.directory, STORAGE_BACKEND: 'unknown' }), /must be json or duckdb/);
  const privateDirectory = join(f.directory, 'private');
  await loadConfig({ DATA_DIR: privateDirectory });
  await assert.rejects(loadConfig({ DATA_DIR: privateDirectory, DEMO_MODE: '1' }), /separate empty volume/);
});
