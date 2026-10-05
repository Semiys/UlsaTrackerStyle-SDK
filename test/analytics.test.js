import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';
import { loadConfig } from '../src/config.js';
import { validateBatch } from '../src/events.js';
import { AnalyticsStore } from '../src/store.js';
import { createApp } from '../src/app.js';

const event = (overrides = {}) => ({
  eventId: randomUUID(), sessionId: randomUUID(), occurredAt: new Date().toISOString(),
  name: 'button_click', screen: 'collection', platform: 'android', appVersion: '1.0.0',
  properties: { button: 'add_model' }, ...overrides,
});
const packet = events => ({ schemaVersion: 1, events });

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ulsa-test-'));
  const config = await loadConfig({ DATA_DIR: directory, STORAGE_BACKEND: 'duckdb' });
  const store = await AnalyticsStore.open(config.databasePath);
  const server = createApp({ config, store }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const post = (body, key = config.ingestKey) => fetch(url + '/api/v1/events', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const getStats = async (days = 7) => {
    const response = await fetch(`${url}/api/v1/stats?days=${days}`, { headers: { Authorization: `Bearer ${config.readKey}` } });
    assert.equal(response.status, 200);
    return response.json();
  };
  return { config, directory, store, server, url, post, getStats };
}

test('access keys are distinct, private and survive restart', async t => {
  const f = await fixture(t);
  assert.notEqual(f.config.ingestKey, f.config.readKey);
  assert.equal((await stat(join(f.directory, 'access.json'))).mode & 0o777, 0o600);
  const reloaded = await loadConfig({ DATA_DIR: f.directory });
  assert.equal(reloaded.ingestKey, f.config.ingestKey);
  assert.equal(reloaded.readKey, f.config.readKey);
});

test('ingestion and stats enforce different keys; data files are not served', async t => {
  const f = await fixture(t);
  for (const key of ['', 'wrong-key', f.config.readKey]) assert.equal((await f.post(packet([event()]), key)).status, 401);
  for (const key of ['', 'wrong-key', f.config.ingestKey]) {
    const response = await fetch(f.url + '/api/v1/stats', { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await fetch(f.url + '/data/access.json')).status, 404);
});

test('batch acknowledgement and duplicates count real stored events', async t => {
  const f = await fixture(t);
  const sessionId = randomUUID();
  const events = [event({ sessionId }), event({ sessionId, name: 'model_saved' })];
  const first = await f.post(packet(events));
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { schemaVersion: 1, accepted: 2, duplicates: 0, acknowledgedEventIds: events.map(e => e.eventId) });
  const retry = await f.post(packet(events));
  assert.equal((await retry.json()).duplicates, 2);
  const duplicated = event({ sessionId });
  const withinBatch = await f.post(packet([duplicated, duplicated]));
  assert.equal((await withinBatch.json()).accepted, 1);
  const stats = await f.getStats();
  assert.deepEqual(stats.totals, { events: 3, sessions: 1, screenViews: 0, buttonClicks: 2, successfulActions: 0 });
  assert.equal(stats.daily.reduce((sum, day) => sum + day.count, 0), 3);
  assert.deepEqual(stats.byName, [{ name: 'button_click', count: 2 }, { name: 'model_saved', count: 1 }]);
});

test('invalid row rejects the entire batch before any write', async t => {
  const f = await fixture(t);
  const response = await f.post(packet([event(), event({ eventId: 'bad' })]));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.field, 'events[1].eventId');
  assert.equal((await f.getStats()).totals.events, 0);
});

test('conflicting ID rejects new rows in the same batch atomically', async t => {
  const f = await fixture(t);
  const saved = event();
  assert.equal((await f.post(packet([saved]))).status, 200);
  const response = await f.post(packet([event(), { ...saved, name: 'model_saved' }]));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'event_id_conflict');
  assert.equal((await f.getStats()).totals.events, 1);
  assert.equal((await f.post(packet([saved, { ...saved, name: 'other' }]))).status, 409);
});

test('parallel retries do not interleave transactions or double count', async t => {
  const f = await fixture(t);
  const body = packet(Array.from({ length: 10 }, () => event()));
  const replies = await Promise.all(Array.from({ length: 12 }, () => f.post(body)));
  const results = await Promise.all(replies.map(async r => { assert.equal(r.status, 200); return r.json(); }));
  assert.equal(results.reduce((sum, r) => sum + r.accepted, 0), 10);
  assert.equal((await f.getStats()).totals.events, 10);
});

test('malformed JSON, wrong type, oversized payload and batches are rejected', async t => {
  const f = await fixture(t);
  const headers = { Authorization: `Bearer ${f.config.ingestKey}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(f.url + '/api/v1/events', { method: 'POST', headers, body: '{bad' })).status, 400);
  assert.equal((await fetch(f.url + '/api/v1/events', { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await fetch(f.url + '/api/v1/events', { method: 'POST', headers, body: JSON.stringify({ text: 'x'.repeat(70_000) }) })).status, 413);
  for (const body of [packet([]), packet(Array.from({ length: 101 }, () => event())), { schemaVersion: 2, events: [event()] }, { ...packet([event()]), projectId: 'another-project' }]) assert.equal((await f.post(body)).status, 400);
  assert.equal((await f.getStats()).totals.events, 0);
});

test('field validation rejects malformed calendar dates and nested data', () => {
  const now = Date.parse('2026-10-04T12:00:00.000Z');
  const base = event({ occurredAt: '2026-10-04T11:00:00.000Z' });
  for (const patch of [
    { occurredAt: '2026-02-30T00:00:00.000Z' }, { occurredAt: '2026-10-04T13:00:00.000Z' },
    { occurredAt: '2024-01-01T00:00:00Z' }, { name: '<script>' }, { properties: { nested: {} } },
    { properties: { note: 'x'.repeat(257) } }, { properties: JSON.parse('{"__proto__":"x"}') },
  ]) assert.throws(() => validateBatch(packet([{ ...base, ...patch }]), now));
  assert.equal(validateBatch(packet([{ ...base, screen: null }]), now)[0].screen, null);
});

test('UTC range filters by event time and includes zero days', async t => {
  const f = await fixture(t);
  const earlier = new Date(Date.now() - 2 * 86_400_000).toISOString();
  assert.equal((await f.post(packet([event(), event({ occurredAt: earlier })]))).status, 200);
  assert.equal((await f.getStats(1)).totals.events, 1);
  const stats = await f.getStats(7);
  assert.equal(stats.totals.events, 2);
  assert.equal(stats.daily.length, 7);
  assert.equal(stats.timezone, 'UTC');
  assert.equal(stats.daily.filter(day => day.count === 0).length, 5);
  for (const query of ['0', '91', '-1', '1.5', '7&days=30']) {
    assert.equal((await fetch(`${f.url}/api/v1/stats?days=${query}`, { headers: { Authorization: `Bearer ${f.config.readKey}` } })).status, 400);
  }
});

test('details separate screen views, button clicks and successful operations without counting retries', async t => {
  const f = await fixture(t);
  const sessionId = randomUUID();
  const events = [
    event({ sessionId, name: 'screen_view', properties: {} }),
    event({ sessionId, name: 'screen_view', properties: {} }),
    event({ sessionId, name: 'screen_view', screen: 'profile', properties: {} }),
    event({ sessionId, properties: { button: 'open_filters' } }),
    event({ sessionId, properties: { button: 'open_filters' } }),
    event({ sessionId, screen: 'add_model', properties: { button: 'save_model' } }),
    event({ sessionId, screen: 'edit_model', properties: { button: 'save_model' } }),
    event({ sessionId, name: 'action_success', screen: 'add_model', properties: { action: 'model_saved' } }),
    event({ sessionId, name: 'action_success', screen: 'edit_model', properties: { action: 'model_updated' } }),
    event({ sessionId, name: 'custom_event', properties: { button: 'open_filters', action: 'model_saved' } }),
  ];
  assert.equal((await f.post(packet(events))).status, 200);
  const stats = await f.getStats();
  assert.deepEqual(stats.totals, { events: 10, sessions: 1, screenViews: 3, buttonClicks: 4, successfulActions: 2 });
  assert.deepEqual(stats.byScreenViews, [{ screen: 'collection', count: 2 }, { screen: 'profile', count: 1 }]);
  assert.deepEqual(stats.byButton, [
    { button: 'open_filters', screen: 'collection', count: 2 },
    { button: 'save_model', screen: 'add_model', count: 1 },
    { button: 'save_model', screen: 'edit_model', count: 1 },
  ]);
  assert.deepEqual(stats.byAction, [
    { action: 'model_saved', screen: 'add_model', count: 1 },
    { action: 'model_updated', screen: 'edit_model', count: 1 },
  ]);
  assert.equal(stats.byScreen.find(row => row.screen === 'collection').count, 5);
  assert.equal((await (await f.post(packet(events))).json()).duplicates, 10);
  assert.deepEqual(await f.getStats(), stats);
});

test('empty stats and missing or wrongly typed details do not invent button or action names', async t => {
  const f = await fixture(t);
  const empty = await f.getStats();
  assert.deepEqual(empty.totals, { events: 0, sessions: 0, screenViews: 0, buttonClicks: 0, successfulActions: 0 });
  for (const key of ['byName', 'byScreen', 'byScreenViews', 'byButton', 'byAction']) {
    assert.deepEqual(empty[key], []);
    assert.equal(empty.truncated[key], false);
  }
  const missingValues = [undefined, null, '', '   ', 7, false];
  const events = missingValues.flatMap(value => [
    event({ screen: null, properties: value === undefined ? {} : { button: value } }),
    event({ name: 'action_success', screen: null, properties: value === undefined ? {} : { action: value } }),
  ]);
  events.push(event({ name: 'screen_view', screen: null, properties: {} }));
  assert.equal((await f.post(packet(events))).status, 200);
  const stats = await f.getStats();
  assert.deepEqual(stats.byButton, [{ button: null, screen: null, count: 6 }]);
  assert.deepEqual(stats.byAction, [{ action: null, screen: null, count: 6 }]);
  assert.deepEqual(stats.byScreenViews, [{ screen: null, count: 1 }]);
  assert.equal(stats.totals.events, 13);
});

test('new breakdowns respect UTC event dates and project scope, including unknown identifiers', async t => {
  const f = await fixture(t);
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const records = [
    event({ occurredAt: new Date(today).toISOString(), properties: { button: "custom ' button" } }),
    event({ occurredAt: new Date(today).toISOString(), name: 'action_success', properties: { action: '<script>test</script>' } }),
    event({ occurredAt: new Date(today - 1).toISOString(), properties: { button: 'yesterday' } }),
    event({ occurredAt: new Date(today - 1).toISOString(), name: 'action_success', properties: { action: 'yesterday' } }),
    event({ occurredAt: new Date(today - 1).toISOString(), name: 'screen_view', properties: {} }),
    event({ occurredAt: new Date(today + 86_400_000).toISOString(), properties: { button: 'tomorrow' } }),
  ];
  await f.store.ingest(f.config.projectId, records.map(e => ({ ...e, payloadHash: e.eventId })));
  await f.store.ingest('another-project', [event({ properties: { button: 'other_project' }, payloadHash: 'other-project' })]);
  const stats = await f.store.stats(f.config.projectId, 1, now);
  assert.equal(stats.totals.events, 2);
  assert.deepEqual(stats.byButton, [{ button: "custom ' button", screen: 'collection', count: 1 }]);
  assert.deepEqual(stats.byAction, [{ action: '<script>test</script>', screen: 'collection', count: 1 }]);
  assert.deepEqual(stats.byScreenViews, []);
  const week = await f.store.stats(f.config.projectId, 7, now);
  assert.equal(week.totals.events, 5);
  assert.equal(week.byScreenViews[0].count, 1);
});

test('top 100 groups report truncation while totals still include all groups', async t => {
  const f = await fixture(t);
  const sessionId = randomUUID();
  const records = Array.from({ length: 100 }, (_, i) => [
    event({ sessionId, properties: { button: `button_${i}` } }),
    event({ sessionId, name: 'action_success', properties: { action: `action_${i}` } }),
    event({ sessionId, name: 'screen_view', screen: `screen_${i}`, properties: {} }),
  ]).flat();
  for (let i = 0; i < records.length; i += 100) assert.equal((await f.post(packet(records.slice(i, i + 100)))).status, 200);
  const full = await f.getStats();
  assert.equal(full.breakdownLimit, 100);
  for (const key of ['byButton', 'byAction', 'byScreenViews']) {
    assert.equal(full[key].length, 100);
    assert.equal(full.truncated[key], false);
  }
  assert.equal((await f.post(packet([
    event({ sessionId, properties: { button: 'extra_button' } }),
    event({ sessionId, name: 'action_success', properties: { action: 'extra_action' } }),
    event({ sessionId, name: 'screen_view', screen: 'extra_screen', properties: {} }),
  ]))).status, 200);
  const limited = await f.getStats();
  assert.deepEqual(limited.totals, { events: 303, sessions: 1, screenViews: 101, buttonClicks: 101, successfulActions: 101 });
  for (const key of ['byButton', 'byAction', 'byScreenViews']) {
    assert.equal(limited[key].length, 100);
    assert.equal(limited.truncated[key], true);
  }
  assert.equal(limited.truncated.byName, false);
  assert.equal(limited.daily.reduce((sum, day) => sum + day.count, 0), 303);
});

test('committed data and deduplication survive closing and reopening the database', async t => {
  const f = await fixture(t);
  const saved = event();
  assert.equal((await f.post(packet([saved]))).status, 200);
  await f.store.close();
  const reopened = await AnalyticsStore.open(f.config.databasePath);
  try {
    assert.equal((await reopened.stats(f.config.projectId, 7)).totals.events, 1);
    assert.equal((await reopened.ingest(f.config.projectId, validateBatch(packet([saved])))).duplicates, 1);
  } finally { await reopened.close(); }
});

test('project scope and parameterized SQL preserve isolation', async t => {
  const f = await fixture(t);
  const sameId = randomUUID();
  const one = validateBatch(packet([event({ eventId: sameId, properties: { note: "'); DROP TABLE events; --" } })]));
  const two = validateBatch(packet([event({ eventId: sameId, name: 'other_project_event' })]));
  await f.store.ingest(f.config.projectId, one);
  await f.store.ingest('other-project', two);
  const own = await f.getStats();
  assert.equal(own.totals.events, 1);
  assert.equal(own.byName[0].name, 'button_click');
  assert.equal((await f.store.stats('other-project', 7)).byName[0].name, 'other_project_event');
});

test('bounded database queue reports retry delay without dropping acknowledged events', async t => {
  const f = await fixture(t);
  let release;
  const tasks = [f.store.execute(() => new Promise(resolve => { release = resolve; }))];
  await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 31; i++) tasks.push(f.store.execute(() => Promise.resolve()));
  try {
    const response = await f.post(packet([event()]));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '1');
  } finally { release(); await Promise.all(tasks); }
  assert.equal((await f.getStats()).totals.events, 0);
});

test('unsupported database version is rejected without changing its schema', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ulsa-schema-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'future.duckdb');
  const instance = await DuckDBInstance.create(path);
  const connection = await instance.connect();
  await connection.run('CREATE TABLE schema_version(version INTEGER PRIMARY KEY); INSERT INTO schema_version VALUES (2)');
  connection.closeSync(); instance.closeSync();
  await assert.rejects(AnalyticsStore.open(path), /Unsupported analytics database schema/);
  const reopened = await DuckDBInstance.create(path);
  const check = await reopened.connect();
  try {
    assert.deepEqual((await check.runAndReadAll('SELECT version FROM schema_version')).getRows(), [[2]]);
    assert.equal((await check.runAndReadAll("SELECT count(*) FROM information_schema.tables WHERE table_name = 'events'")).getRows()[0][0], 0n);
  } finally { check.closeSync(); reopened.closeSync(); }
});

test('manual diagnostic command sends a real event and retries the same packet', async t => {
  const f = await fixture(t);
  const run = promisify(execFile);
  const path = fileURLToPath(new URL('../src/send-test-event.js', import.meta.url));
  const options = { env: { ...process.env, DATA_DIR: f.directory, PORT: String(f.server.address().port) } };
  const first = JSON.parse((await run(process.execPath, [path, '--new'], options)).stdout);
  const retry = JSON.parse((await run(process.execPath, [path, '--repeat'], options)).stdout);
  assert.equal(first.status, 200);
  assert.equal(first.accepted, 1);
  assert.equal(retry.duplicates, 1);
  assert.deepEqual(first.acknowledgedEventIds, retry.acknowledgedEventIds);
  assert.equal((await f.getStats()).totals.events, 1);
});

test('preserved DuckDB backend supplies recent events to the shared dashboard API', async t => {
  const f = await fixture(t);
  const source = event({ properties: { button: 'save_model' } });
  assert.equal((await f.post(packet([source]))).status, 200);
  const response = await fetch(f.url + '/api/v1/events/recent', { headers: { Authorization: `Bearer ${f.config.readKey}` } });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].eventId, source.eventId);
  assert.equal(result.events[0].occurredAt, source.occurredAt);
  assert.deepEqual(result.events[0].properties, source.properties);
  assert.ok(Number.isFinite(Date.parse(result.events[0].receivedAt)));
  assert.equal(Object.hasOwn(result.events[0], 'payloadHash'), false);
});
