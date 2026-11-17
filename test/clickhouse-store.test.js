import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { ClickHouseAnalyticsStore } from '../src/clickhouse-store.js';
import { validateBatch } from '../src/events.js';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/storage.js';
import { createApp } from '../src/app.js';

const enabled = process.env.STORAGE_BACKEND === 'clickhouse' && Boolean(process.env.DATABASE_URL);
const options = { skip: !enabled };
const event = (patch = {}) => ({ eventId: randomUUID(), sessionId: randomUUID(), occurredAt: new Date().toISOString(),
  name: 'button_click', screen: 'collection', platform: 'android', appVersion: '1.2', properties: { button: 'open_filters' }, ...patch });
const batch = records => validateBatch({ schemaVersion: 1, events: records });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ulsa-clickhouse-'));
  const config = await loadConfig({ ...process.env, DEMO_MODE: '0', DATA_DIR: directory, PROJECT_ID: 'test_' + randomUUID().replaceAll('-', '') });
  const store = await openStore(config);
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { config, store, project: config.projectId };
}

test('ClickHouse creates an empty project, acknowledges parallel retries and reopens', options, async t => {
  const f = await fixture(t);
  assert.equal((await f.store.stats(f.project, 7)).totals.events, 0);
  const records = batch([event(), event()]);
  const results = await Promise.all(Array.from({ length: 12 }, () => f.store.ingest(f.project, records)));
  assert.equal(results.reduce((n, reply) => n + reply.accepted, 0), 2);
  assert.deepEqual(results[0].acknowledgedEventIds, records.map(row => row.eventId));
  await f.store.close();
  const reopened = await ClickHouseAnalyticsStore.open(f.config.clickhouse);
  try {
    assert.equal((await reopened.stats(f.project, 7)).totals.events, 2);
    assert.equal((await reopened.ingest(f.project, records)).duplicates, 2);
  } finally { await reopened.close(); }
});

test('ClickHouse rejects an entire conflicting packet before inserting new IDs', options, async t => {
  const f = await fixture(t);
  const original = event();
  await f.store.ingest(f.project, batch([original]));
  await assert.rejects(f.store.ingest(f.project, batch([event(), { ...original, name: 'screen_view' }])), { code: 'event_id_conflict' });
  assert.equal((await f.store.stats(f.project, 7)).totals.events, 1);
});

test('ClickHouse recovers a lost insert response without a second logical event', options, async t => {
  const f = await fixture(t);
  const records = batch([event()]);
  const insert = f.store.client.insert.bind(f.store.client);
  f.store.client.insert = async args => { await insert(args); throw new Error('simulated lost response'); };
  await assert.rejects(f.store.ingest(f.project, records), /simulated lost response/);
  f.store.client.insert = insert;
  assert.deepEqual(await f.store.ingest(f.project, records), {
    accepted: 0, duplicates: 1, acknowledgedEventIds: [records[0].eventId],
  });
  assert.equal((await f.store.stats(f.project, 7)).totals.events, 1);
});

test('ClickHouse write failure sends no ACK and leaves a retry possible', options, async t => {
  const f = await fixture(t);
  const records = batch([event()]);
  const insert = f.store.client.insert.bind(f.store.client);
  f.store.client.insert = async () => { throw new Error('simulated unavailable database'); };
  await assert.rejects(f.store.ingest(f.project, records), /unavailable database/);
  assert.equal((await f.store.stats(f.project, 7)).totals.events, 0);
  f.store.client.insert = insert;
  assert.equal((await f.store.ingest(f.project, records)).accepted, 1);
});

test('ClickHouse separates projects, UTC dates, event kinds and non-string properties', options, async t => {
  const f = await fixture(t);
  const now = new Date(); const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const sessionId = randomUUID();
  await f.store.ingest(f.project, batch([
    event({ sessionId, occurredAt: new Date(midnight).toISOString(), name: 'screen_view', properties: {} }),
    event({ sessionId, occurredAt: new Date(midnight).toISOString(), properties: { button: "collector's_filters" } }),
    event({ sessionId, occurredAt: new Date(midnight).toISOString(), name: 'action_success', screen: null, properties: { action: 7 } }),
    event({ occurredAt: new Date(midnight - 1).toISOString() }),
  ]));
  await f.store.ingest('another_' + f.project, batch([event()]));
  const stats = await f.store.stats(f.project, 1, now);
  assert.deepEqual(stats.totals, { events: 3, sessions: 1, screenViews: 1, buttonClicks: 1, successfulActions: 1 });
  assert.deepEqual(stats.byButton, [{ button: "collector's_filters", screen: 'collection', count: 1 }]);
  assert.deepEqual(stats.byAction, [{ action: null, screen: null, count: 1 }]);
  assert.equal(stats.daily[0].count, 3);
  const recent = await f.store.recent(f.project, 2);
  assert.equal(recent.length, 2);
  for (const row of recent) {
    assert.equal(Object.hasOwn(row, 'projectId'), false); assert.equal(Object.hasOwn(row, 'payloadHash'), false);
    assert.match(row.occurredAt, /Z$/); assert.match(row.receivedAt, /Z$/);
  }
});

test('ClickHouse limits breakdown rows while retaining full totals', options, async t => {
  const f = await fixture(t);
  const rows = Array.from({ length: 101 }, (_, i) => event({ properties: { button: 'button_' + i } }));
  await f.store.ingest(f.project, batch(rows.slice(0, 100)));
  await f.store.ingest(f.project, batch(rows.slice(100)));
  const stats = await f.store.stats(f.project, 7);
  assert.equal(stats.byButton.length, 100); assert.equal(stats.truncated.byButton, true);
  assert.equal(stats.totals.events, 101); assert.equal(stats.daily.reduce((n, day) => n + day.count, 0), 101);
});

test('ClickHouse FINAL removes physical duplicates before background merges', options, async t => {
  const f = await fixture(t);
  const [source] = batch([event()]);
  const raw = { project_id: f.project, event_id: source.eventId, session_id: source.sessionId,
    occurred_at: source.occurredAt, name: source.name, screen: source.screen, platform: source.platform,
    app_version: source.appVersion, properties: JSON.stringify(source.properties), payload_hash: source.payloadHash };
  await f.store.client.command({ query: 'SYSTEM STOP MERGES events' });
  try {
    await f.store.client.insert({ table: 'events', format: 'JSONEachRow', values: [raw] });
    await f.store.client.insert({ table: 'events', format: 'JSONEachRow',
      values: [{ ...raw, received_at: new Date(Date.now() + 1).toISOString() }],
      clickhouse_settings: { insert_deduplicate: 0 } });
    const [physical] = await f.store.rows('SELECT count() AS n FROM events WHERE project_id = {project:String}', { project: f.project });
    assert.equal(Number(physical.n), 2);
    assert.equal((await f.store.stats(f.project, 7)).totals.events, 1);
    assert.equal((await f.store.recent(f.project)).length, 1);
  } finally { await f.store.client.command({ query: 'SYSTEM START MERGES events' }); }
});

test('ClickHouse serializes conflicting concurrent IDs in one application process', options, async t => {
  const f = await fixture(t); const source = event();
  const replies = await Promise.allSettled([
    f.store.ingest(f.project, batch([source])), f.store.ingest(f.project, batch([{ ...source, name: 'screen_view' }])),
  ]);
  assert.equal(replies[0].status, 'fulfilled');
  assert.equal(replies[1].status, 'rejected'); assert.equal(replies[1].reason.code, 'event_id_conflict');
  assert.equal((await f.store.stats(f.project, 7)).totals.events, 1);
});

test('ClickHouse serves the four existing pages, real form, refusal and mobile ACK contract', options, async t => {
  const f = await fixture(t);
  const server = createApp({ config: { ...f.config, demoMode: true }, store: f.store }).listen(0, '127.0.0.1');
  await once(server, 'listening'); const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const health = await (await fetch(base + '/health')).json();
    assert.equal(health.storage, 'clickhouse');
    for (const path of ['/', '/events/new', '/dashboard', '/error']) {
      const reply = await fetch(base + path); assert.equal(reply.status, 200);
      const html = await reply.text(); assert.match(html, /UlsaTrackerStyle SDK/);
      for (const href of ['/', '/events/new', '/dashboard', '/error']) assert.ok(html.includes(`href="${href}"`));
    }
    const html = await (await fetch(base + '/events/new')).text();
    const values = { name: 'button_click', screen: 'collection', detail: '<img src=x onerror=alert(1)>' };
    for (const key of ['eventId','sessionId','occurredAt','csrfToken','ingestKey']) values[key] = html.match(new RegExp(`name="${key}" value="([^"]*)"`))[1];
    const post = data => fetch(base + '/events', { method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) });
    assert.equal((await post(values)).status, 303); assert.equal((await post(values)).status, 303);
    const dashboard = await (await fetch(base + '/dashboard?saved=' + values.eventId)).text();
    assert.match(dashboard, /Событие сохранено/); assert.match(dashboard, /&lt;img/); assert.doesNotMatch(dashboard, /<img src=x/);
    const rejected = await post({ ...values, name: '' }); assert.equal(rejected.status, 400);
    assert.match(await rejected.text(), /Причина отказа/);
    const packet = { schemaVersion: 1, events: [event({ name: 'screen_view', properties: {} })] };
    const api = key => fetch(base + '/api/v1/events', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify(packet) });
    assert.equal((await api(f.config.readKey)).status, 401);
    const accepted = await api(f.config.ingestKey); assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { schemaVersion: 1, accepted: 1, duplicates: 0, acknowledgedEventIds: [packet.events[0].eventId] });
    assert.equal((await f.store.stats(f.project, 7)).totals.events, 2);
  } finally { await new Promise(resolve => server.close(resolve)); }
});


test('all-time boundary includes history older than a year and isolates empty and foreign projects', options, async t => {
  const f = await fixture(t);
  assert.equal(await f.store.firstEventAt(f.project), null);
  const first = Date.parse('2010-02-03T12:34:56.123Z');
  const row = (project_id, at) => ({ project_id, event_id: randomUUID(), session_id: randomUUID(),
    occurred_at: new Date(at).toISOString(), name: 'screen_view', screen: 'all_time', platform: 'web',
    app_version: 'test', properties: '{}', payload_hash: '0'.repeat(64) });
  const oldest = row(f.project, first);
  await f.store.client.insert({ table: 'events', format: 'JSONEachRow', values: [oldest, oldest,
    row(f.project, Date.now() - 1000), row(f.project + '_other', Date.parse('2000-01-01T00:00:00Z'))],
    clickhouse_settings: { date_time_input_format: 'best_effort' } });
  assert.equal(await f.store.firstEventAt(f.project), first);
  assert.equal(await f.store.firstEventAt(f.project + '_empty'), null);
});


test('application event deletion waits for prior writes, removes only its rows and is safe to retry', options, async t => {
  const f = await fixture(t), sibling = 'test_' + randomUUID().replaceAll('-', '');
  await f.store.ingest(sibling, batch([event()]));
  const accepted = f.store.ingest(f.project, batch([event(), event()]));
  const removed = f.store.deleteProjectEvents(f.project);
  assert.equal((await accepted).accepted, 2); await removed;
  assert.equal(Number((await f.store.rows('SELECT count() AS n FROM events WHERE project_id={project:String}', { project: f.project }))[0].n), 0);
  assert.equal((await f.store.stats(sibling, 7)).totals.events, 1);
  await f.store.deleteProjectEvents(f.project);
  assert.equal((await f.store.stats(sibling, 7)).totals.events, 1);
});

test('one statistics read retains null dimensions custom events and independent totals', options, async t => {
  const f = await fixture(t), sessionA = randomUUID(), sessionB = randomUUID();
  const today = new Date(); const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const at = new Date(midnight).toISOString();
  await f.store.ingest(f.project, batch([
    event({ sessionId: sessionA, occurredAt: at, name: 'screen_view', screen: null, properties: {} }),
    event({ sessionId: sessionA, occurredAt: at, name: 'screen_view', screen: 'profile', properties: {} }),
    event({ sessionId: sessionA, occurredAt: at, screen: 'profile', properties: { button: ' open ' } }),
    event({ sessionId: sessionB, occurredAt: at, screen: null, properties: { button: 11 } }),
    event({ sessionId: sessionB, occurredAt: at, name: 'action_success', screen: 'profile', properties: { action: ' save ' } }),
    event({ sessionId: sessionB, occurredAt: at, name: 'action_success', screen: null, properties: { action: false } }),
    event({ sessionId: sessionB, occurredAt: at, name: 'custom_event', screen: 'profile', properties: {} }),
    event({ sessionId: sessionA, occurredAt: new Date(midnight - 1).toISOString(), name: 'screen_view', screen: 'past', properties: {} }),
  ]));
  const data = await f.store.stats(f.project, 1, today);
  assert.deepEqual(data.totals, { events: 7, sessions: 2, screenViews: 2, buttonClicks: 2, successfulActions: 2 });
  assert.deepEqual(data.byScreen, [{ screen: 'profile', count: 4 }]);
  assert.deepEqual(data.byScreenViews, [{ screen: 'profile', count: 1 }, { screen: null, count: 1 }]);
  assert.deepEqual(data.byButton, [{ button: 'open', screen: 'profile', count: 1 }, { button: null, screen: null, count: 1 }]);
  assert.deepEqual(data.byAction, [{ action: 'save', screen: 'profile', count: 1 }, { action: null, screen: null, count: 1 }]);
  assert.equal(data.byName.reduce((n, row) => n + row.count, 0), 7);
  assert.equal(data.daily[0].count, 7);
  assert.equal((await f.store.stats(f.project, 2, today)).totals.events, 8);
});
test('statistics totals and their breakdowns stay coherent during ingestion and retries', options, async t => {
  const f = await fixture(t);
  const check = data => {
    assert.equal(data.byName.reduce((n, row) => n + row.count, 0), data.totals.events);
    assert.equal(data.daily.reduce((n, row) => n + row.count, 0), data.totals.events);
    assert.equal(data.byScreenViews.reduce((n, row) => n + row.count, 0), data.totals.screenViews);
    assert.equal(data.byButton.reduce((n, row) => n + row.count, 0), data.totals.buttonClicks);
    assert.equal(data.byAction.reduce((n, row) => n + row.count, 0), data.totals.successfulActions);
  };
  for (let i = 0; i < 8; i++) {
    const records = batch([event({ name: 'screen_view', properties: {} }), event(), event({ name: 'action_success', properties: { action: 'saved' } })]);
    await Promise.all([f.store.ingest(f.project, records), f.store.stats(f.project, 7).then(check), f.store.ingest(f.project, records)]);
  }
  const final = await f.store.stats(f.project, 7); check(final); assert.equal(final.totals.events, 24);
});

test('a conflicting packet does not insert its other IDs or poison adjacent valid packets', options, async t => {
  const f = await fixture(t), first = event(), rejectedOnly = event(), last = event();
  const outcomes = await Promise.allSettled([
    f.store.ingest(f.project, batch([first])),
    f.store.ingest(f.project, batch([rejectedOnly, { ...first, name: 'screen_view' }])),
    f.store.ingest(f.project, batch([last])),
  ]);
  assert.equal(outcomes[0].status, 'fulfilled');
  assert.equal(outcomes[1].status, 'rejected'); assert.equal(outcomes[1].reason.code, 'event_id_conflict');
  assert.equal(outcomes[2].status, 'fulfilled');
  const stored = await f.store.recent(f.project);
  assert.deepEqual(new Set(stored.map(row => row.eventId)), new Set([first.eventId, last.eventId]));
});
test('grouped receipt failure rejects all replies and retries repair every source exactly once', options, async t => {
  const f = await fixture(t), packets = Array.from({ length: 4 }, () => batch([event()]));
  const insert = f.store.client.insert.bind(f.store.client);
  f.store.client.insert = async args => {
    if (args.table === 'ingestion_receipts') throw new Error('group receipt failure');
    return insert(args);
  };
  const failed = await Promise.allSettled(packets.map(rows => f.store.ingest(f.project, rows)));
  assert.ok(failed.every(result => result.status === 'rejected'));
  assert.equal((await f.store.stats(f.project, 7)).totals.events, 4);
  assert.equal((await f.store.operationalState(f.project)).total, 0);
  f.store.client.insert = insert;
  const replies = await Promise.all(packets.map(rows => f.store.ingest(f.project, rows)));
  assert.equal(replies.reduce((n, reply) => n + reply.accepted, 0), 0);
  assert.equal(replies.reduce((n, reply) => n + reply.duplicates, 0), 4);
  assert.equal((await f.store.operationalState(f.project)).total, 4);
  assert.equal((await f.store.stats(f.project, 7)).totals.events, 4);
});
test('deletion remains an ordering barrier between adjacent ingestion requests', options, async t => {
  const f = await fixture(t), old = batch([event()]), next = batch([event()]);
  const saved = f.store.ingest(f.project, old);
  const removed = f.store.deleteProjectEvents(f.project);
  const later = f.store.ingest(f.project, next);
  await Promise.all([saved, removed, later]);
  assert.deepEqual((await f.store.recent(f.project)).map(row => row.eventId), [next[0].eventId]);
  assert.equal((await f.store.operationalState(f.project)).total, 1);
});

test('bounded ingestion backlog rejects overflow without poisoning accepted requests', options, async t => {
  const f = await fixture(t), insert = f.store.client.insert.bind(f.store.client);
  let entered, release;
  const blocked = new Promise(resolve => { release = resolve; });
  const writing = new Promise(resolve => { entered = resolve; });
  f.store.client.insert = async args => { entered(); await blocked; return insert(args); };
  const records = Array.from({ length: 64 }, () => batch([event()]));
  const accepted = records.map(rows => f.store.ingest(f.project, rows));
  await writing;
  try {
    await assert.rejects(f.store.ingest(f.project, batch([event()])), { code: 'server_busy' });
  } finally { release(); }
  const replies = await Promise.all(accepted);
  assert.equal(replies.reduce((n, reply) => n + reply.accepted, 0), 64);
  assert.equal(f.store.pendingIngest, 0);
  assert.equal((await f.store.stats(f.project, 7)).totals.events, 64);
  assert.equal((await f.store.operationalState(f.project)).total, 64);
  assert.equal((await f.store.ingest(f.project, batch([event()]))).accepted, 1);
});
test('coalescing limits each real insert to one thousand events', options, async t => {
  const f = await fixture(t), insert = f.store.client.insert.bind(f.store.client), sizes = [];
  f.store.client.insert = async args => { if (args.table === 'events') sizes.push(args.values.length); return insert(args); };
  const packets = Array.from({ length: 15 }, () => batch(Array.from({ length: 100 }, () => event())));
  const replies = await Promise.all(packets.map(rows => f.store.ingest(f.project, rows)));
  assert.equal(replies.reduce((n, reply) => n + reply.accepted, 0), 1500);
  assert.ok(sizes.every(size => size <= 1000));
  assert.equal(sizes.reduce((n, size) => n + size, 0), 1500);
  assert.equal((await f.store.stats(f.project, 7)).totals.events, 1500);
  assert.equal((await f.store.operationalState(f.project)).total, 1500);
});

test('an operation queue refusal cannot leave a stale ingestion group after recovery', { ...options, timeout: 10000 }, async t => {
  const f = await fixture(t);
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const busy = Array.from({ length: 32 }, () => f.store.execute(() => blocked));
  try {
    await assert.rejects(f.store.ingest(f.project, batch([event()])), { code: 'server_busy' });
  } finally { release(); }
  await Promise.all(busy);
  const result = await f.store.ingest(f.project, batch([event()]));
  assert.equal(result.accepted, 1);
  assert.equal(f.store.pendingIngest, 0);
  assert.equal((await f.store.stats(f.project, 7)).totals.events, 1);
  assert.equal((await f.store.operationalState(f.project)).total, 1);
});
