import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/storage.js';
import { AccountStore } from '../src/accounts.js';
import { metricRoute } from '../src/metrics.js';

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ulsa-json-api-'));
  const config = await loadConfig({ DATA_DIR: directory, CONSOLE_ENABLED: '1', STORAGE_BACKEND: 'json', DEMO_MODE: '1', ...overrides });
  const store = await openStore(config), accounts = new AccountStore(':memory:');
  const server = createApp({ config, store, accounts }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); accounts.close(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port;
  function client() {
    const cookies = new Map(); let csrf = '';
    const call = async (path, body, init = {}) => {
      const response = await fetch(base + path, { redirect: 'manual', ...init,
        method: body === undefined ? (init.method ?? 'GET') : 'POST', headers: {
          Cookie: [...cookies].map(([k,v]) => k + '=' + v).join('; '), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...init.headers,
        }, ...(body === undefined ? {} : { body: JSON.stringify({ ...body, csrfToken: csrf }) }),
      });
      for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0], at = pair.indexOf('='); cookies.set(pair.slice(0, at), pair.slice(at + 1)); }
      return response;
    };
    const api = (path, body, init) => call('/api/console' + path, body, init);
    const session = async () => { const response = await api('/session'); const data = await response.json(); csrf = data.csrfToken; return data; };
    const register = async () => {
      await session();
      const response = await api('/register', { name: 'Owner', email: randomUUID() + '@example.test', password: 'isolated-test-password-2026' });
      assert.equal(response.status, 200); const data = await response.json(); csrf = data.csrfToken; return data;
    };
    return { api, call, session, register, cookies, token: () => csrf };
  }
  return { client, accounts, store };
}
async function makeApplication(client, platform = 'android') {
  const response = await client.api('/projects', { name: '<project>' }); assert.equal(response.status, 201);
  const { project } = await response.json();
  const created = await client.api('/projects/' + project.id + '/apps', { name: '<application>', platform, identifier: platform === 'web' ? 'https://example.test' : 'com.example.test' });
  assert.equal(created.status, 201); const data = await created.json();
  return { project, ...data };
}

test('JSON session uses HttpOnly cookies, rotating CSRF, private responses and revocable login', async t => {
  const f = await fixture(t), c = f.client();
  const before = await c.session(); assert.equal(before.user, null);
  assert.equal((await c.api('/projects')).status, 401);
  const response = await c.api('/register', { name: 'Owner', email: randomUUID() + '@example.test', password: 'isolated-test-password-2026' });
  assert.equal(response.status, 200);
  const after = await response.json(); assert.notEqual(after.csrfToken, before.csrfToken);
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  assert.match(response.headers.get('set-cookie'), /SameSite=Lax/i);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(JSON.stringify(after).includes('password'), false);
  await c.session();
  const cookie = c.cookies.get('ulsa_session');
  assert.equal((await c.api('/logout', {})).status, 200);
  assert.equal((await c.session()).user, null);
  c.cookies.set('ulsa_session', cookie);
  assert.equal((await c.api('/projects')).status, 401);
});

test('JSON mutations reject missing CSRF, wrong content type, malformed JSON and oversized payloads without creating records', async t => {
  const f = await fixture(t), c = f.client(); await c.register();
  const raw = (body, headers = {}) => c.call('/api/console/projects', undefined, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  assert.equal((await raw('{"name":"invalid"}')).status, 403);
  assert.equal((await raw('name=invalid', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await raw('{broken')).status, 400);
  assert.equal((await raw(JSON.stringify({ name: 'x'.repeat(14000) }))).status, 413);
  assert.equal((await c.api('/projects', undefined, { method: 'PUT' })).status, 405);
  assert.deepEqual((await (await c.api('/projects')).json()).projects, []);
});

test('JSON cabinet hides foreign resources and reveals sending keys only on creation or rotation', async t => {
  const f = await fixture(t), a = f.client(), b = f.client(); await a.register(); await b.register();
  const data = await makeApplication(a), id = data.application.id, projectId = data.project.id;
  assert.match(data.rawKey, /^ulsa_[a-f0-9]{64}$/);
  const read = await a.api('/apps/' + id), text = await read.text(); assert.equal(text.includes(data.rawKey), false); assert.equal(text.includes('"owner_id"'), false);
  const paths = ['/projects/' + projectId, '/apps/' + id, '/apps/' + id + '/statistics'];
  for (const path of paths) assert.equal((await b.api(path)).status, 404);
  for (const [path, body] of [
    ['/projects/' + projectId + '/settings', { name: 'Stolen', archived: false }],
    ['/apps/' + id + '/keys/rotate', {}],
    ['/apps/' + id + '/keys/' + data.keys[0].id + '/revoke', {}],
    ['/apps/' + id + '/test', { name: 'screen_view', screen: 'home' }],
  ]) assert.equal((await b.api(path, body)).status, 404);
  const rotated = await (await a.api('/apps/' + id + '/keys/rotate', {})).json();
  assert.notEqual(rotated.rawKey, data.rawKey); assert.equal(f.accounts.resolveKey(data.rawKey), null); assert.equal(f.accounts.resolveKey(rotated.rawKey).id, id);
  assert.equal((await a.api('/apps/' + id + '/keys/' + rotated.keys.find(k => !k.revoked_at).id + '/revoke', {})).status, 200);
  assert.equal(f.accounts.resolveKey(rotated.rawKey), null);
});

test('JSON project settings retain records, stop archived ingestion and validate archive values', async t => {
  const f = await fixture(t), c = f.client(); await c.register(); const data = await makeApplication(c);
  const path = '/projects/' + data.project.id + '/settings';
  assert.equal((await c.api(path, { name: 'No boolean', archived: 'false' })).status, 400);
  assert.equal((await c.api(path, { name: 'Renamed', archived: true })).status, 200);
  assert.equal(f.accounts.resolveKey(data.rawKey), null);
  assert.equal((await c.api('/apps/' + data.application.id + '/test', { name: 'button_click', screen: 'home' })).status, 409);
  assert.equal((await c.api('/projects/' + data.project.id)).status, 200);
  assert.equal((await c.api(path, { name: 'Renamed', archived: false })).status, 200);
  assert.equal((await c.api('/apps/' + data.application.id + '/test', { name: 'screen_view', screen: 'home' })).status, 200);
  assert.equal((await f.store.stats(data.application.id, 7)).totals.events, 1);
});

test('JSON and HTML authentication share the same attempt limit', async t => {
  const f = await fixture(t), c = f.client(); await c.session();
  const email = randomUUID() + '@example.test';
  for (let i = 0; i < 12; i++) {
    const response = i % 2 === 0 ? await c.api('/login', { email, password: 'wrong-password' })
      : await c.call('/login', undefined, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrfToken: c.token(), email, password: 'wrong-password' }) });
    assert.equal(response.status, 401);
  }
  assert.equal((await c.api('/login', { email, password: 'wrong-password' })).status, 429);
});

test('JSON and HTML mutations share the owner quota', async t => {
  const f = await fixture(t), c = f.client(); await c.register();
  for (let i = 0; i < 60; i++) {
    const response = i % 2 === 0 ? await c.api('/projects', { name: '' })
      : await c.call('/console/projects', undefined, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrfToken: c.token(), name: '' }) });
    assert.equal(response.status, 400);
  }
  assert.equal((await c.api('/projects', { name: 'Over quota' })).status, 429);
});

test('JSON API metrics contain only fixed route templates', () => {
  for (let i = 0; i < 100; i++) {
    assert.equal(metricRoute({ path: '/api/console/apps/secret-' + i + '/statistics' }), '/api/console/apps/:appId/statistics');
    assert.equal(metricRoute({ path: '/api/console/apps/secret-' + i + '/keys/key-' + i + '/revoke' }), '/api/console/apps/:appId/keys/:keyId/revoke');
    assert.equal(metricRoute({ path: '/api/console/projects/secret-' + i + '/apps' }), '/api/console/projects/:projectId/apps');
  }
});

test('rendered Grafana subpath exits stay on the browser host and enforce owner/session checks', async t => {
  const f = await fixture(t, { PUBLIC_URL: 'http://192.168.0.90:8080' }), a = f.client(), b = f.client(), guest = f.client();
  await a.register(); await b.register(); const data = await makeApplication(a);
  const cabinet = await a.call('/grafana/console'); assert.equal(cabinet.status, 303); assert.equal(cabinet.headers.get('location'), '/console');
  const setup = await a.call('/grafana/console/apps/' + data.application.id); assert.equal(setup.status, 303); assert.equal(setup.headers.get('location'), '/console/apps/' + data.application.id);
  assert.equal((await b.call('/grafana/console/apps/' + data.application.id)).status, 404);
  const anonymous = await guest.call('/grafana/console'); assert.equal(anonymous.status, 303); assert.equal(anonymous.headers.get('location'), '/login');
});
