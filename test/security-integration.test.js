import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { browserClient } from './helpers/browser-client.mjs';
const base = process.env.APP_TEST_URL;
const enabled = { skip: !base || !process.env.GRAFANA_TEST_URL };

test('database row policies survive unrestricted SQL, owner spoofing, external table functions and DDL', enabled, async () => {
  const a = browserClient(base), b = browserClient(base), suffix = randomUUID();
  async function setup(client, label) {
    const csrf = await client.register(`audit-${label}-${suffix}@example.test`);
    const created = await client.post('/console/projects', { name: 'Security ' + label, csrfToken: csrf });
    const response = await client.post(created.headers.get('location') + '/apps', { name: label, platform: 'web', identifier: 'http://localhost:18085', csrfToken: csrf });
    const html = await response.text(), id = html.match(/\/console\/apps\/(a_[a-f0-9]{32})/)[1], key = html.match(/ulsa_[a-f0-9]{64}/)[0];
    const packet = { schemaVersion: 1, events: [{ eventId: randomUUID(), sessionId: randomUUID(), occurredAt: new Date().toISOString(), name: 'button_click', screen: 'audit', platform: 'web', appVersion: 'security-test', properties: { button: label } }] };
    assert.equal((await fetch(base + '/api/v1/events', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify(packet) })).status, 200);
    return id;
  }
  const idA = await setup(a, 'owner_a'), idB = await setup(b, 'owner_b');
  assert.equal((await a.request('/grafana/api/dashboards/uid/' + idA)).status, 200);
  if (process.env.REQUIRE_GRAFANA_CSP === '1') {
    const orgA = await (await a.request('/grafana/api/org')).json();
    assert.equal((await a.request(`/grafana/apis/dashboard.grafana.app/v2beta1/namespaces/org-${orgA.id}/dashboards/${idA}/dto`)).status, 200);
    assert.equal((await a.request(`/grafana/apis/dashboard.grafana.app/v2beta1/namespaces/org-${orgA.id}/dashboards/${idB}/dto`)).status, 404);
    assert.equal((await a.request(`/grafana/apis/dashboard.grafana.app/v2beta1/namespaces/org-99999/dashboards/${idA}/dto`)).status, 404);
    assert.equal((await a.request(`/grafana/apis/dashboard.grafana.app/v2beta1/namespaces/org-${orgA.id}/dashboards/${idA}`, { method: 'DELETE' })).status, 403);
  }
  async function query(rawSql) {
    const response = await a.request('/grafana/api/ds/query?orgId=99999', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Grafana-Org-Id': '99999', Authorization: 'Basic ' + Buffer.from('app:app').toString('base64') }, body: JSON.stringify({ from: String(Date.now()-3600000), to: String(Date.now()), queries: [{ refId: 'A', datasource: { uid: 'owner-events', type: 'grafana-clickhouse-datasource' }, rawSql, queryType: 'sql', format: 1 }] }) });
    const body = await response.json(); return body.results?.A ?? body;
  }
  for (const table of ['events', 'ingestion_receipts']) {
    const rows = await query('SELECT project_id FROM app.' + table + ' FINAL');
    assert.equal(rows.error, undefined, JSON.stringify(rows));
    assert.deepEqual(rows.frames[0].data.values[0], [idA]);
  }
  for (const sql of [
    'DROP TABLE app.events',
    "SELECT * FROM url('http://app:8080/health', 'JSONEachRow', 'status String')",
    "SELECT * FROM remote('db:9000', app.events, 'app', 'app')",
    'SELECT * FROM app.schema_version',
  ]) {
    const result = await query(sql); assert.ok(result.error, 'Restricted reader must reject: ' + sql);
    assert.match(result.error, /READONLY|read.?only|ACCESS_DENIED|not enough privileges|necessary to have|not allowed|not granted|QUERY_IS_PROHIBITED/i);
  }
  assert.equal((await a.request('/console/apps/' + idB + '/stats')).status, 404);
  assert.equal((await a.request('/console/apps/' + idB + '/export.csv')).status, 404);
  assert.equal((await a.request('/console/apps/' + idB + '/export.json')).status, 404);
  assert.equal((await a.request('/grafana/api/dashboards/uid/' + idB)).status, 404);
  assert.equal((await a.request('/grafana/api/datasources/uid/ulsa-monitoring')).status, 404);
  assert.equal((await a.request('/metrics')).status, 404);
});
