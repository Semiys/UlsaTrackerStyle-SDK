import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DuckDBInstance } from '@duckdb/node-api';
import { AnalyticsStore } from '/app/src/store.js';
import { validateBatch } from '/app/src/events.js';
import { ServerQueryConnection } from './server-query.mjs';

const mode = process.argv[2] ?? 'write';
assert.ok(['write', 'read'].includes(mode), 'Mode must be write or read');
const uri = process.env.DATABASE_URI;
const token = process.env.DATABASE_TOKEN;
assert.match(uri ?? '', /^quack:[a-zA-Z0-9.-]+:\d{1,5}$/);
assert.ok(token && token.length >= 4, 'DATABASE_TOKEN is required');
const literal = value => "'" + value.replaceAll("'", "''") + "'";
const instance = await DuckDBInstance.create(':memory:', { threads: '2', memory_limit: '128MB' });
const connection = await instance.connect();
let store;
try {
  await connection.run('INSTALL quack; LOAD quack;');
  let attached = false;
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      await connection.run(`ATTACH ${literal(uri)} AS remote (TYPE quack, TOKEN ${literal(token)}, DISABLE_SSL true)`);
      attached = true;
      break;
    } catch (error) {
      if (/Binder Error|Catalog Error|Authentication failed/i.test(error.message)) throw error;
      if (attempt === 30) throw error;
      await delay(1_000);
    }
  }
  assert.ok(attached);
  const remote = new ServerQueryConnection(connection);
  await remote.run("SET TimeZone = 'UTC'");
  console.log('PASS: Node.js attached to the separate database service');

  if (mode === 'write') await remote.run(await readFile('/app/src/schema.sql', 'utf8'));
  const count = async () => Number((await remote.runAndReadAll('SELECT count(*) AS n FROM events')).getRows()[0][0]);
  store = new AnalyticsStore(instance, remote);
  const project = 'quack-probe';
  const eventId = 'de47c4ed-2747-4dc1-a57f-e001c19c33ea';

  if (mode === 'write') {
    assert.equal(await count(), 0, 'Write mode needs a fresh prototype volume');
    console.log('PASS: automatic schema initialization produced an empty database');
    const source = {
      eventId, sessionId: randomUUID(), occurredAt: new Date().toISOString(),
      name: 'button_click', screen: 'collection', platform: 'android', appVersion: 'quack-probe-0.1.0',
      properties: { button: "collector's_filters", enabled: true, count: 2 },
    };
    const packet = validateBatch({ schemaVersion: 1, events: [source] });
    const first = await store.ingest(project, packet);
    assert.equal(first.accepted, 1);
    assert.equal(first.duplicates, 0);
    assert.deepEqual(first.acknowledgedEventIds, [eventId]);
    assert.equal(await count(), 1);
    console.log('PASS: existing AnalyticsStore accepted and acknowledged a remote event');

    const retries = await Promise.all(Array.from({ length: 5 }, () => store.ingest(project, packet)));
    assert.ok(retries.every(result => result.accepted === 0 && result.duplicates === 1));
    assert.equal(await count(), 1);
    console.log('PASS: five parallel retries kept one event');

    const conflict = validateBatch({ schemaVersion: 1, events: [{ ...source, name: 'screen_view' }] });
    await assert.rejects(store.ingest(project, conflict), { code: 'event_id_conflict' });
    assert.equal(await count(), 1);
    console.log('PASS: a conflicting event ID was rejected');

    await remote.run('BEGIN TRANSACTION');
    try {
      await remote.run('DELETE FROM events WHERE event_id = $id::UUID', { id: eventId });
    } finally {
      await remote.run('ROLLBACK');
    }
    assert.equal(await count(), 1);
    console.log('PASS: remote rollback preserved the event');
  } else {
    assert.equal(await count(), 1, 'The event must survive container recreation');
    console.log('PASS: recreated containers read the event from dbdata');
  }

  const recent = await store.recent(project);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].eventId, eventId);
  assert.equal(recent[0].name, 'button_click');
  assert.equal(recent[0].platform, 'android');
  assert.deepEqual(recent[0].properties, { button: "collector's_filters", count: 2, enabled: true });
  const stats = await store.stats(project, 90);
  assert.equal(stats.totals.events, 1);
  assert.equal(stats.totals.buttonClicks, 1);
  assert.equal(stats.byButton[0].button, "collector's_filters");
  console.log('PASS: existing recent-events and statistics queries work remotely');

  const denied = await instance.connect();
  try {
    await assert.rejects(denied.run(`ATTACH ${literal(uri)} AS unauthorized (TYPE quack, TOKEN 'invalid-token', DISABLE_SSL true)`));
    console.log('PASS: an invalid database token was rejected');
  } finally { denied.closeSync(); }
  console.log('RESULT: ' + mode + ' checks passed');
} finally {
  if (store) await store.close();
  else { connection.closeSync(); instance.closeSync(); }
}
