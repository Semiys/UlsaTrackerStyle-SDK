import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { ServiceMetrics, metricRoute } from '../src/metrics.js';
import { createApp } from '../src/app.js';

test('monitoring uses bounded route templates and never URLs, identifiers or query values', () => {
  assert.equal(metricRoute({ originalUrl: '/grafana/api/ds/query?key=secret', path: '/api/ds/query' }), '/grafana/*');
  assert.equal(metricRoute({ path: '/API/V1/EVENTS' }), '/api/v1/events');
  for (let i = 0; i < 200; i++) {
    assert.equal(metricRoute({ path: `/console/apps/secret-${i}/export.csv` }), '/console/apps/:appId/export.csv');
    assert.equal(metricRoute({ path: `/console/apps/secret-${i}/export.json` }), '/console/apps/:appId/export.json');
    assert.equal(metricRoute({ path: `/grafana/d/private-${i}/events` }), '/grafana/*');
    assert.equal(metricRoute({ path: `/unknown-${i}` }), 'other');
  }
});
test('metrics count stored events, duplicates and HTTP refusals without recording collection content', async t => {
  const metrics = new ServiceMetrics({ pending: 2 }); t.after(() => metrics.close());
  const config = { demoMode: false, storageBackend: 'json', projectId: 'private', ingestKey: 'i'.repeat(40), readKey: 'r'.repeat(40) };
  const app = createApp({ config, store: { async ingest(_, events) { assert.equal(events.length, 3); return { accepted: 2, duplicates: 1 }; } }, metrics });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/api/v1/events', { method: 'POST', headers: { Authorization: 'Bearer secret-should-not-be-in-metrics' } })).status, 401);
  assert.equal((await fetch(base + '/metrics')).status, 404);
  const packet = { schemaVersion: 1, events: Array.from({ length: 3 }, () => ({ eventId: randomUUID(), sessionId: randomUUID(), occurredAt: new Date().toISOString(), name: 'screen_view', screen: 'test', platform: 'android', appVersion: 'audit', properties: {} })) };
  assert.equal((await fetch(base + '/api/v1/events', { method: 'POST', headers: { Authorization: 'Bearer ' + config.ingestKey, 'Content-Type': 'application/json' }, body: JSON.stringify(packet) })).status, 200);
  const output = await metrics.registry.metrics();
  assert.match(output, /ulsa_ingest_events_total\{result="accepted"\} 2/);
  assert.match(output, /ulsa_ingest_events_total\{result="duplicate"\} 1/);
  assert.match(output, /ulsa_http_requests_total\{method="POST",route="\/api\/v1\/events",status_code="401"\} 1/);
  assert.match(output, /ulsa_storage_pending_operations 2/);
  assert.doesNotMatch(output, /secret-should-not-be-in-metrics/);
});
test('dedicated metrics listener rejects other paths and methods and reports unavailable storage', async t => {
  const metrics = new ServiceMetrics({ closed: true }); t.after(() => metrics.close());
  const server = createServer(metrics.handler).listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/')).status, 404);
  assert.equal((await fetch(base + '/metrics', { method: 'POST' })).status, 405);
  const response = await fetch(base + '/metrics'); assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/plain/);
  assert.match(await response.text(), /ulsa_storage_available 0/);
});
