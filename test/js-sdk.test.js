import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTracker } from '../sdk/js/index.mjs';
import { validateBatch } from '../src/events.js';

const key = 'ulsa_' + 'b'.repeat(64);
const options = { endpoint: 'http://localhost:8080', ingestKey: key, allowHttp: true, appVersion: '1.0.0' };
const ack = events => new Response(JSON.stringify({ schemaVersion: 1, accepted: events.length, duplicates: 0, acknowledgedEventIds: events.map(e => e.eventId) }), { status: 200 });
const memoryStorage = () => { const data = new Map(); return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }; };
test('browser and module deliveries are identical, with no separate drifting implementation', async () => {
  assert.equal(await readFile(new URL('../sdk/js/ulsa-tracker.js', import.meta.url), 'utf8'), await readFile(new URL('../public/sdk/ulsa-tracker.js', import.meta.url), 'utf8'));
});
test('web SDK produces valid contract events and removes them only after complete ACK', async t => {
  let calls = 0, batch;
  const tracker = createTracker({ ...options, fetch: async (_, init) => { calls++; batch = JSON.parse(init.body); validateBatch(batch); return ack(batch.events); } });
  t.after(() => tracker.close());
  assert.equal(tracker.screen('home'), true); assert.equal(tracker.click('save', 'home'), true);
  assert.equal(tracker.track('bad name'), false); assert.equal(tracker.track('purchase', { properties: { price: Infinity } }), false);
  await Promise.all([tracker.flush(), tracker.flush()]);
  assert.equal(calls, 1); assert.equal(batch.events.length, 2); assert.equal(batch.events[0].platform, 'web');
  assert.equal(tracker.getStatus().accepted, 2); assert.equal(tracker.getStatus().queued, 0);
});
test('rate limits and invalid ACK retain IDs and prevent repeated flush from bypassing cooldown', async t => {
  let calls = 0, eventId;
  const tracker = createTracker({ ...options, fetch: async (_, init) => {
    calls++; eventId = JSON.parse(init.body).events[0].eventId;
    return new Response('{}', { status: 429, headers: { 'Retry-After': '60' } });
  } });
  t.after(() => tracker.close()); tracker.screen('home'); await tracker.flush();
  for (let i = 0; i < 5; i++) await tracker.flush();
  assert.equal(calls, 1); assert.equal(tracker.getStatus().queued, 1); assert.ok(eventId); assert.ok(tracker.getStatus().nextRetryAt > Date.now() + 55000);
  const invalid = createTracker({ ...options, fetch: async () => new Response('{"schemaVersion":1,"accepted":1,"duplicates":0,"acknowledgedEventIds":[]}', { status: 200 }) });
  t.after(() => invalid.close()); invalid.screen('home'); await invalid.flush();
  assert.equal(invalid.getStatus().queued, 1); assert.equal(invalid.getStatus().lastStatus, 'invalid_ack');
});
test('persistent queue survives recreation, opt out clears it and remains off after reload', async t => {
  const storage = memoryStorage(); let original;
  const first = createTracker({ ...options, storage, persist: true, fetch: async (_, init) => {
    original = JSON.parse(init.body).events[0].eventId; throw new Error('lost response');
  } });
  first.screen('home'); await first.flush(); first.close();
  const next = createTracker({ ...options, storage, persist: true, fetch: async (_, init) => {
    const events = JSON.parse(init.body).events; assert.equal(events[0].eventId, original); return ack(events);
  } });
  t.after(() => next.close()); assert.equal(next.getStatus().queued, 1);
  next.setCollectionEnabled(false); assert.equal(next.getStatus().queued, 0); assert.equal(next.screen('home'), false); next.close();
  const reloaded = createTracker({ ...options, storage, persist: true });
  t.after(() => reloaded.close()); assert.equal(reloaded.getStatus().enabled, false); assert.equal(reloaded.getStatus().queued, 0);
});
test('revoked key pauses delivery, bounded queue drops oldest and insecure endpoints require explicit opt in', async t => {
  assert.throws(() => createTracker({ ...options, allowHttp: false }), /endpoint/);
  const tracker = createTracker({ ...options, maxQueue: 2, fetch: async () => new Response('{}', { status: 401 }) });
  t.after(() => tracker.close()); tracker.screen('one'); tracker.screen('two'); tracker.screen('three');
  assert.equal(tracker.getStatus().queued, 2); assert.equal(tracker.getStatus().dropped, 1);
  await tracker.flush(); assert.equal(tracker.getStatus().paused, 'unauthorized');
});
