import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { loadConfig } from '../src/config.js';
import { GrafanaCabinet } from '../src/grafana-cabinet.js';
import { createApp } from '../src/app.js';
import { AccountStore } from '../src/accounts.js';
import { browserClient } from './helpers/browser-client.mjs';

test('disabling demo refuses persisted public demo credentials instead of treating them as private', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'ulsa-config-security-')); t.after(() => rm(folder, { recursive: true, force: true }));
  await loadConfig({ DATA_DIR: folder, DEMO_MODE: '1' });
  await assert.rejects(loadConfig({ DATA_DIR: folder, DEMO_MODE: '0' }), /Public demo keys/);
});
test('proxy preserves upstream CSP and strips cookies, caller credentials and off-site redirects', async t => {
  let received;
  const upstream = createServer((req, res) => {
    received = req.headers;
    if (req.url.includes('redirect')) { res.writeHead(302, { Location: 'https://example.invalid/attack' }); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Security-Policy': "script-src 'self' 'nonce-test'; connect-src 'self'; frame-ancestors 'none'", 'Set-Cookie': 'do-not-forward=secret' }); res.end('ok');
  }).listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const config = { demoMode: true, publicUrl: 'http://localhost:8080', grafanaInternalUrl: `http://127.0.0.1:${upstream.address().port}` };
  const cabinet = new GrafanaCabinet({ config, accounts: {}, store: {} });
  const express = (await import('express')).default;
  const app = express(); app.use('/grafana', express.raw({ type: () => true }), cabinet.proxy());
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); for (const agent of Object.values(cabinet.queryAgents)) agent.destroy(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(base + '/grafana/public/probe.js', { headers: { Authorization: 'Basic attacker', Cookie: 'private=secret', 'X-Grafana-Org-Id': '99' } });
  assert.equal(response.status, 200); assert.equal(await response.text(), 'ok');
  assert.match(response.headers.get('content-security-policy'), /script-src 'self' 'nonce-test'/);
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'self' http:\/\/localhost:8080/);
  assert.equal(response.headers.get('set-cookie'), null);
  for (const name of ['authorization','cookie','x-grafana-org-id']) assert.equal(received[name], undefined);
  assert.equal((await fetch(base + '/grafana/public/redirect.js', { redirect: 'manual' })).status, 502);
  assert.equal((await fetch(base + '/grafana/api/admin/users', { method: 'POST' })).status, 403);
  assert.equal((await fetch(base + '/grafana/apis/dashboard.grafana.app/')).status, 200);
  assert.equal((await fetch(base + '/grafana/apis/dashboard.grafana.app/v2beta1/namespaces/org-1/dashboards/ulsatracker/dto')).status, 200);
  assert.equal((await fetch(base + '/grafana/apis/dashboard.grafana.app/v2beta1/namespaces/org-2/dashboards/ulsatracker/dto')).status, 404);
  assert.equal((await fetch(base + '/grafana/apis/dashboard.grafana.app/v2beta1/namespaces/org-1/dashboards/ulsatracker', { method: 'PUT' })).status, 403);
  assert.equal((await fetch(base + '/grafana/ofrep/v1/evaluate/flags', { method: 'POST' })).status, 200);

});
test('session forgery, missing CSRF and stored HTML payloads do not bypass the cabinet', async t => {
  const accounts = new AccountStore(':memory:'); t.after(() => accounts.close());
  const config = { publicUrl: 'http://localhost:8080', consoleEnabled: true, demoMode: false, secureCookies: false, projectId: 'private', readKey: 'r'.repeat(40), ingestKey: 'i'.repeat(40) };
  const server = createApp({ config, accounts, store: {} }).listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/console', { redirect: 'manual', headers: { Cookie: 'ulsa_session=' + 'a'.repeat(43) } })).status, 303);
  assert.equal((await fetch(base + '/login', { method: 'POST', body: 'email=x&password=y', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 403);
  const client = browserClient(base), csrf = await client.register('security@example.test');
  assert.equal((await client.post('/console/projects', { name: '<img src=x onerror=alert(1)>', csrfToken: csrf })).status, 303);
  const response = await client.request('/console'), html = await response.text();
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.ok(html.includes('&lt;img')); assert.ok(!html.includes('<img src=x'));
  assert.equal((await client.post('/console/projects', { name: 'Forgery', csrfToken: 'x'.repeat(43) })).status, 403);
  await client.post('/logout', { csrfToken: csrf });
  assert.equal((await client.request('/console')).status, 303);
});
