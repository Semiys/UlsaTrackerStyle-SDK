import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { browserClient } from './helpers/browser-client.mjs';
import { createTracker } from '../sdk/js/index.mjs';

const base = process.env.APP_TEST_URL;
const integration = { skip: !base || !process.env.GRAFANA_TEST_URL };
const packet = id => ({ schemaVersion: 1, events: [{ eventId: id ?? randomUUID(), sessionId: randomUUID(),
  occurredAt: new Date().toISOString(), name: 'button_click', screen: 'home', platform: 'web', appVersion: 'console-test', properties: { button: 'save' } }] });

test('two owners receive isolated Grafana organizations and database readers; spoofing headers cannot cross ownership', integration, async () => {
  const a = browserClient(base), b = browserClient(base), suffix = randomUUID();
  const csrfA = await a.register(`owner-a-${suffix}@example.test`), csrfB = await b.register(`owner-b-${suffix}@example.test`);
  async function application(client, csrf, name) {
    const project = await client.post('/console/projects', { csrfToken: csrf, name });
    assert.equal(project.status, 303, await project.text());
    const path = project.headers.get('location');
    const created = await client.post(path + '/apps', { csrfToken: csrf, name, platform: 'web', identifier: 'http://localhost:18085' });
    assert.equal(created.status, 200); const html = await created.text();
    return { id: html.match(/\/console\/apps\/(a_[a-f0-9]{32})/)[1], key: html.match(/ulsa_[a-f0-9]{64}/)[0], path };
  }
  const appA = await application(a, csrfA, 'Website A'), appB = await application(b, csrfB, 'Website B');
  const ingest = (app, body = packet()) => fetch(base + '/api/v1/events', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + app.key }, body: JSON.stringify(body) });
  assert.equal((await ingest(appA)).status, 200); assert.equal((await ingest(appB)).status, 200);
  for (const [client, app] of [[a, appA], [b, appB]]) {
    const response = await client.request('/grafana/api/dashboards/uid/' + app.id);
    const body = await response.text(); assert.equal(response.status, 200, body);
    const data = JSON.parse(body); assert.equal(data.dashboard.uid, app.id); assert.equal(data.meta.canSave, false);
    assert.equal((await client.request(`/console/apps/${app.id}/data`)).status, 200);
  }
  assert.equal((await a.request(`/console/apps/${appB.id}/stats`)).status, 404);
  assert.equal((await a.request('/grafana/api/dashboards/uid/' + appB.id)).status, 404);
  assert.equal((await a.request('/grafana/api/prometheus/grafana/api/v1/rules')).status, 200);
  const target = appId => ({ from: String(Date.now() - 86400000), to: String(Date.now() + 60000), queries: [{ refId: 'A',
    datasource: { type: 'grafana-clickhouse-datasource', uid: 'owner-events' }, queryType: 'sql', format: 1,
    rawSql: `SELECT count() AS value FROM app.events FINAL WHERE project_id = '${appId}'`, intervalMs: 1000, maxDataPoints: 100 }] });
  const readCount = async (appId, headers = {}) => {
    const response = await a.request('/grafana/api/ds/query?orgId=99999', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(target(appId)) });
    const body = await response.text(); assert.equal(response.status, 200, body);
    const result = JSON.parse(body).results.A; assert.equal(result.error, undefined, JSON.stringify(result));
    return Number(result.frames[0].data.values[0][0]);
  };
  assert.equal(await readCount(appA.id), 1);
  assert.equal(await readCount(appB.id, { 'X-Grafana-Org-Id': '99999', Authorization: 'Basic ' + Buffer.from('app:app').toString('base64') }), 0);
  assert.equal((await fetch(base + '/grafana/api/datasources/uid/owner-events')).status, 404);
  assert.equal((await a.request('/grafana/api/admin/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  const rotated = await a.post(`/console/apps/${appA.id}/keys/rotate`, { csrfToken: csrfA });
  const newKey = (await rotated.text()).match(/ulsa_[a-f0-9]{64}/)[0];
  assert.equal((await ingest(appA)).status, 401);
  assert.equal((await ingest({ ...appA, key: newKey })).status, 200);
  assert.equal((await a.post(appA.path + '/settings', { csrfToken: csrfA, name: 'Website A', archived: '1' })).status, 303);
  assert.equal((await ingest({ ...appA, key: newKey })).status, 401);
  assert.equal((await a.request(`/console/apps/${appA.id}/data`)).status, 200);
});

test('a new Android application key accepts the unchanged mobile packet and rejects a wrong platform', integration, async () => {
  const client = browserClient(base), csrf = await client.register(`android-${randomUUID()}@example.test`);
  const project = await client.post('/console/projects', { csrfToken: csrf, name: 'Android integration' });
  const created = await client.post(project.headers.get('location') + '/apps', { csrfToken: csrf, name: 'Android SDK', platform: 'android', identifier: 'com.example.collector' });
  const html = await created.text(), key = html.match(/ulsa_[a-f0-9]{64}/)[0], id = html.match(/\/console\/apps\/(a_[a-f0-9]{32})/)[1];
  const body = packet(); body.events[0].platform = 'android';
  const send = () => fetch(base + '/api/v1/events', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const accepted = await send(); assert.equal(accepted.status, 200); assert.equal((await accepted.json()).accepted, 1);
  assert.equal((await (await send()).json()).duplicates, 1);
  body.events[0].eventId = randomUUID(); body.events[0].platform = 'web';
  assert.equal((await send()).status, 400);
  const stats = await (await client.request(`/console/apps/${id}/data`)).json(); assert.equal(stats.totals.events, 1);
});

test('real JavaScript SDK delivers to an application key with ACK deduplication and CORS', integration, async () => {
  const client = browserClient(base), csrf = await client.register(`js-${randomUUID()}@example.test`);
  const project = await client.post('/console/projects', { name: 'JS integration', csrfToken: csrf });
  const created = await client.post(project.headers.get('location') + '/apps', { csrfToken: csrf, name: 'JS SDK', platform: 'web', identifier: 'https://site.example.test' });
  const html = await created.text(), key = html.match(/ulsa_[a-f0-9]{64}/)[0], id = html.match(/\/console\/apps\/(a_[a-f0-9]{32})/)[1];
  const preflight = await fetch(base + '/api/v1/events', { method: 'OPTIONS', headers: { Origin: 'https://site.example.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://site.example.test');
  let recorded, lose = true;
  const tracker = createTracker({ endpoint: base, allowHttp: true, ingestKey: key, appVersion: 'integration',
    fetch: async (url, init) => {
      recorded = JSON.parse(init.body);
      const response = await fetch(url, { ...init, headers: { ...init.headers, Origin: 'https://site.example.test' } });
      assert.equal(response.status, 200);
      if (lose) { lose = false; throw new Error('Lost ACK'); }
      return response;
    } });
  try {
    tracker.click('save', 'home'); await tracker.flush();
    assert.equal(tracker.getStatus().queued, 1);
    const retry = await fetch(base + '/api/v1/events', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Origin: 'https://site.example.test' }, body: JSON.stringify(recorded) });
    assert.equal((await retry.json()).duplicates, 1);
    const data = await (await client.request(`/console/apps/${id}/data`)).json(); assert.equal(data.totals.events, 1);
  } finally { tracker.close(); }
});
