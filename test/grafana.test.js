import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient } from '@clickhouse/client';
import { loadConfig } from '../src/config.js';

const appUrl = process.env.APP_TEST_URL;
const grafanaUrl = process.env.GRAFANA_TEST_URL;
const integration = { skip: !appUrl || !grafanaUrl };
const readKey = 'ulsa_lab2_demo_read_2026_local_project_only';
const definition = JSON.parse(await readFile(new URL('../grafana/provisioning/dashboards/ulsatracker.json', import.meta.url), 'utf8'));

async function json(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  return data;
}
async function query(target, range = {}) {
  const data = await json(grafanaUrl + '/api/ds/query', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: String(range.from ?? Date.now() - 7 * 86_400_000), to: String(range.to ?? Date.now() + 60_000),
      queries: [{ ...target, refId: 'A', intervalMs: 10_000, maxDataPoints: 1000 }] }),
  });
  assert.ok(data.results?.A, JSON.stringify(data));
  assert.equal(data.results.A.error, undefined, JSON.stringify(data.results.A));
  return data.results.A.frames ?? [];
}
async function stats() {
  return json(appUrl + '/api/v1/stats?days=7', { headers: { Authorization: 'Bearer ' + readKey } });
}

test('anonymous Grafana is limited to the local demo and rejects unsafe embed addresses', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ulsa-grafana-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environment = { DATA_DIR: directory, STORAGE_BACKEND: 'clickhouse', DATABASE_URL: 'http://db:8123',
    DATABASE_USER: 'app', DATABASE_PASSWORD: 'app', DATABASE_NAME: 'app', DASHBOARD_PROVIDER: 'grafana', DEMO_MODE: '1' };
  await assert.rejects(loadConfig({ ...environment, DEMO_MODE: '0' }), /only for the local/);
  for (const url of ['javascript:alert(1)', 'https://user:password@example.com', 'http://localhost:3000/path', 'http://localhost:3000/?x=1']) {
    await assert.rejects(loadConfig({ ...environment, DASHBOARD_PUBLIC_URL: url }), /Invalid DASHBOARD_PUBLIC_URL/);
  }
});

test('Grafana opens a provisioned dashboard anonymously, with the fixed ClickHouse source', integration, async () => {
  const health = await json(grafanaUrl + '/api/health');
  assert.equal(health.database, 'ok');
  const data = await json(grafanaUrl + '/api/dashboards/uid/ulsatracker');
  assert.equal(data.dashboard.title, 'UlsaTrackerStyle SDK 0.0.4');
  assert.equal(data.meta.canSave, false);
  assert.equal(data.dashboard.panels.length, definition.panels.length);
  const source = await json(grafanaUrl + '/api/datasources/uid/ulsatracker-clickhouse');
  assert.equal(source.type, 'grafana-clickhouse-datasource');
  assert.equal(source.jsonData.host, 'db');
  assert.equal(source.jsonData.port, 8123);
  assert.equal(source.jsonData.username, 'grafana_reader');
  assert.equal(source.secureJsonData?.password, undefined);
  assert.equal(source.secureJsonFields.password, true);
  const response = await fetch(appUrl + '/dashboard');
  const html = await response.text();
  assert.match(html, /grafana-frame/);
  assert.match(html, /0\.0\.4/);
  assert.doesNotMatch(html, /<svg|daily-chart/);
  assert.match(response.headers.get('content-security-policy'), /frame-src http:\/\/localhost:13000/);
  const embedded = await fetch(grafanaUrl + '/d/ulsatracker/events');
  assert.equal(embedded.status, 200);
  assert.equal(embedded.headers.get('content-security-policy'), "frame-ancestors 'self' http://localhost:18085");
});

test('every provisioned panel executes against ClickHouse; counters agree with the API', integration, async () => {
  const current = await stats();
  const expected = ['events', 'sessions', 'screenViews', 'buttonClicks', 'successfulActions'];
  for (const [index, panel] of definition.panels.entries()) {
    const frames = await query(panel.targets[0]);
    if (index < 5) assert.equal(Number(frames[0].data.values[0][0]), current.totals[expected[index]], panel.title);
  }
});

test('form write, retry and invalid form are reflected in Grafana without double counting', integration, async () => {
  const before = await stats();
  const html = await (await fetch(appUrl + '/events/new')).text();
  const values = { name: 'button_click', screen: 'collection', detail: 'grafana_check' };
  for (const name of ['eventId', 'sessionId', 'occurredAt', 'csrfToken', 'ingestKey']) {
    values[name] = html.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1];
    assert.ok(values[name], 'Missing form field: ' + name);
  }
  for (let i = 0; i < 2; i++) {
    const reply = await fetch(appUrl + '/events', { method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values) });
    assert.equal(reply.status, 303);
  }
  const after = await stats();
  assert.equal(after.totals.events, before.totals.events + 1);
  const frames = await query(definition.panels[0].targets[0]);
  assert.equal(Number(frames[0].data.values[0][0]), after.totals.events);
  const recent = await query(definition.panels.at(-1).targets[0]);
  assert.ok(recent[0].data.values.flat().includes(values.eventId));
  const invalidHtml = await (await fetch(appUrl + '/events/new?example=invalid')).text();
  const invalid = { ...values, name: '' };
  for (const name of ['eventId', 'sessionId', 'occurredAt', 'csrfToken', 'ingestKey']) {
    invalid[name] = invalidHtml.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1];
  }
  const refusal = await fetch(appUrl + '/events', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(invalid) });
  assert.equal(refusal.status, 400);
  assert.match(await refusal.text(), /Причина отказа/);
  assert.equal((await stats()).totals.events, after.totals.events);
});

test('the dashboard database user cannot write or view another project', integration, async t => {
  const admin = createClient({ url: process.env.DATABASE_URL, username: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD, database: process.env.DATABASE_NAME });
  const reader = createClient({ url: process.env.DATABASE_URL, username: 'grafana_reader', password: 'app', database: 'app' });
  t.after(async () => { await admin.close(); await reader.close(); });
  const eventId = randomUUID();
  await admin.insert({ table: 'events', format: 'JSONEachRow', values: [{ project_id: 'private_' + randomUUID().replaceAll('-', ''),
    event_id: eventId, session_id: randomUUID(), occurred_at: new Date().toISOString().replace('T', ' ').replace('Z', ''),
    name: 'screen_view', screen: 'private', platform: 'web', app_version: 'test', properties: '{}', payload_hash: '0'.repeat(64) }] });
  const rows = await (await reader.query({ query: 'SELECT count() AS n FROM app.events WHERE event_id = {id:UUID}',
    query_params: { id: eventId }, format: 'JSONEachRow' })).json();
  assert.equal(Number(rows[0].n), 0);
  await assert.rejects(reader.command({ query: 'INSERT INTO app.events SELECT * FROM app.events WHERE 0' }), /readonly|read.only|privilege|permission|not enough/i);
});


test('daily graph fills the selected UTC days and its four totals match the counters', integration, async () => {
  const today = new Date();
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const range = { from: midnight - 6 * 86_400_000, to: Date.now() };
  const [frame] = await query(definition.panels.find(p => p.id === 6).targets[0], range);
  const values = frame.data.values;
  assert.equal(values[0].length, 7);
  assert.deepEqual(values[0].map(Number), Array.from({ length: 7 }, (_, i) => range.from + i * 86_400_000));
  for (const [name, counterId] of [['Все события', 1], ['Открытия экранов', 3], ['Нажатия кнопок', 4], ['Успешные действия', 5]]) {
    const index = frame.schema.fields.findIndex(field => field.name === name);
    assert.ok(index > 0, name);
    assert.ok(values[index].every(value => Number.isInteger(Number(value)) && Number(value) >= 0), name);
    const [counter] = await query(definition.panels.find(p => p.id === counterId).targets[0], range);
    assert.equal(values[index].reduce((sum, value) => sum + Number(value), 0), Number(counter.data.values[0][0]), name);
  }
});

test('an empty historical period contains seven zero days, not an invented event or a missing series', integration, async () => {
  const from = Date.UTC(2010, 0, 1);
  const [frame] = await query(definition.panels.find(p => p.id === 6).targets[0], { from, to: from + 7 * 86_400_000 - 1 });
  assert.equal(frame.data.values[0].length, 7);
  for (const values of frame.data.values.slice(1)) assert.deepEqual(values.map(Number), Array(7).fill(0));
});


test('two simultaneous dashboard refreshes finish without ClickHouse memory errors', integration, async () => {
  const panels = [...definition.panels, ...definition.panels];
  const results = await Promise.all(panels.map(panel => query(panel.targets[0])));
  assert.equal(results.length, 28);
  assert.ok(results.every(frames => Array.isArray(frames)));
});
