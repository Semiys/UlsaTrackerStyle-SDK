import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/storage.js';
import { createApp } from '../src/app.js';

async function fixture(t, demo = true) {
  const directory = await mkdtemp(join(tmpdir(), 'ulsa-pages-'));
  const config = await loadConfig({ DATA_DIR: directory, DEMO_MODE: demo ? '1' : '0' });
  const store = await openStore(config);
  const server = createApp({ config, store }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const form = async (example = '') => {
    const html = await (await fetch(`${url}/events/new${example}`)).text();
    const values = {};
    for (const name of ['eventId', 'sessionId', 'occurredAt', 'csrfToken', 'ingestKey']) values[name] = html.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1] ?? config.ingestKey;
    return { name: 'button_click', screen: 'collection', detail: 'open_filters', ...values };
  };
  const post = (values, headers = {}) => fetch(url + '/events', { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(values) });
  return { url, config, store, form, post };
}

test('all four template pages open directly with product name and complete navigation', async t => {
  const f = await fixture(t);
  for (const path of ['/', '/events/new', '/dashboard', '/error']) {
    const response = await fetch(f.url + path); assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /UlsaTrackerStyle SDK/); assert.doesNotMatch(html, /<%/);
    for (const href of ['/', '/events/new', '/dashboard', '/error']) assert.ok(html.includes(`href="${href}"`));
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await fetch(f.url + '/missing')).status, 404);
  assert.equal((await fetch(f.url + '/data/events.json')).status, 404);
  assert.equal((await f.store.stats(f.config.projectId, 7)).totals.events, 0);
});

test('form uses a real write and redirect; same form is deduplicated and dashboard shows escaped data', async t => {
  const f = await fixture(t);
  const values = await f.form(); values.detail = '<img src=x onerror=alert(1)>';
  for (let i = 0; i < 2; i++) {
    const response = await f.post(values); assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), `/dashboard?saved=${values.eventId}`);
  }
  const html = await (await fetch(`${f.url}/dashboard?saved=${values.eventId}`)).text();
  assert.match(html, /Событие сохранено/); assert.match(html, /button_click/);
  assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img src=x/);
  assert.equal((await f.store.stats(f.config.projectId, 7)).totals.events, 1);
  assert.equal(JSON.parse(await readFile(f.config.jsonPath, 'utf8')).events.length, 1);
});

test('empty name, invalid key, oversized form and missing form token visibly fail without a write', async t => {
  const f = await fixture(t);
  const values = await f.form();
  for (const [patch, headers, status] of [[{ name: '' }, {}, 400], [{ ingestKey: 'invalid' }, {}, 401], [{ csrfToken: '' }, { Origin: 'https://another.example' }, 403], [{ eventId: randomUUID() }, {}, 403], [{ detail: 'x'.repeat(10_000) }, {}, 413]]) {
    const response = await f.post({ ...values, ...patch }, headers);
    assert.equal(response.status, status);
    const html = await response.text(); assert.match(html, /Действие не выполнено/); assert.match(html, /Причина отказа/);
    if (status === 413) assert.match(html, /Форма превышает 8 КиБ/);
    assert.ok(html.includes('href="/events/new"'));
  }
  assert.equal((await f.store.stats(f.config.projectId, 7)).totals.events, 0);
});

test('normal mode never exposes credentials or private records through template pages', async t => {
  const f = await fixture(t, false);
  const html = await (await fetch(f.url + '/dashboard')).text();
  for (const key of [f.config.ingestKey, f.config.readKey]) assert.equal(html.includes(key), false);
  for (const key of ['', f.config.ingestKey]) assert.equal((await fetch(f.url + '/api/v1/events/recent', { headers: { Authorization: `Bearer ${key}` } })).status, 401);
  const reply = await fetch(f.url + '/api/v1/events/recent', { headers: { Authorization: `Bearer ${f.config.readKey}` } });
  assert.deepEqual(await reply.json(), { events: [], limit: 50 });
});

test('mobile contract works unchanged with JSON including ACK retry, key separation and readback', async t => {
  const f = await fixture(t);
  const packet = { schemaVersion: 1, events: [{ eventId: randomUUID(), sessionId: randomUUID(), occurredAt: new Date().toISOString(),
    name: 'screen_view', screen: 'collection', platform: 'android', appVersion: '1.2', properties: {} }] };
  const post = key => fetch(f.url + '/api/v1/events', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(packet) });
  assert.equal((await post(f.config.readKey)).status, 401);
  const first = await post(f.config.ingestKey); assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { schemaVersion: 1, accepted: 1, duplicates: 0, acknowledgedEventIds: [packet.events[0].eventId] });
  assert.equal((await (await post(f.config.ingestKey)).json()).duplicates, 1);
  const recent = await (await fetch(f.url + '/api/v1/events/recent', { headers: { Authorization: `Bearer ${f.config.readKey}` } })).json();
  assert.equal(recent.events[0].platform, 'android');
  assert.equal(recent.events[0].eventId, packet.events[0].eventId);
});
