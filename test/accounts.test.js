import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { AccountStore, WindowLimiter } from '../src/accounts.js';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/storage.js';
import { createApp } from '../src/app.js';

const password = 'separate-test-password-2026';
async function accountFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ulsa-accounts-'));
  const path = join(directory, 'accounts.sqlite');
  let accounts = new AccountStore(path);
  t.after(async () => { accounts.close(); await rm(directory, { recursive: true, force: true }); });
  return { get accounts() { return accounts; }, path,
    reopen() { accounts.close(); accounts = new AccountStore(path); return accounts; },
  };
}
test('accounts, hashed credentials and sessions survive reopening; logout revokes the session', async t => {
  const f = await accountFixture(t);
  const user = await f.accounts.register({ name: 'First owner', email: 'FIRST@example.test', password });
  assert.equal(user.email, 'first@example.test');
  assert.equal((await f.accounts.login('first@example.test', password)).id, user.id);
  await assert.rejects(f.accounts.login('first@example.test', 'bad-password'), e => e.status === 401);
  await assert.rejects(f.accounts.login('missing@example.test', 'bad-password'), e => e.status === 401);
  const session = f.accounts.createSession(user.id), secret = f.accounts.secret;
  f.reopen();
  assert.equal(f.accounts.secret, secret);
  assert.equal(f.accounts.session(session.raw).user.id, user.id);
  assert.equal(f.accounts.session(session.raw).csrf, session.csrf);
  f.accounts.logout(session.raw); assert.equal(f.accounts.session(session.raw), null);
  assert.equal(f.accounts.session('bad-token'), null);
  await assert.rejects(f.accounts.register({ name: 'Another', email: 'first@example.test', password }), e => e.status === 409);
  f.accounts.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  assert.equal((await readFile(f.path)).includes(Buffer.from(password)), false);
});
test('projects and applications enforce ownership; key rotation, revocation and archiving block ingestion', async t => {
  const f = await accountFixture(t);
  const first = await f.accounts.register({ name: 'One', email: 'one@example.test', password });
  const second = await f.accounts.register({ name: 'Two', email: 'two@example.test', password });
  const project = f.accounts.createProject(first.id, 'Collection');
  const { application: app, key } = f.accounts.createApplication(first.id, project.id, { name: 'Web', platform: 'web', identifier: 'http://localhost:8080' });
  assert.equal(f.accounts.resolveKey(key).id, app.id);
  assert.equal(f.accounts.hasWebOrigin('http://localhost:8080'), true);
  for (const read of [() => f.accounts.project(second.id, project.id), () => f.accounts.application(second.id, app.id),
    () => f.accounts.rotateKey(second.id, app.id), () => f.accounts.revokeKey(second.id, app.id, f.accounts.keys(first.id, app.id)[0].id)]) assert.throws(read, e => e.status === 404);
  assert.equal(f.accounts.projects(second.id).length, 0);
  const next = f.accounts.rotateKey(first.id, app.id);
  assert.equal(f.accounts.resolveKey(key), null); assert.equal(f.accounts.resolveKey(next).id, app.id);
  f.accounts.updateProject(first.id, project.id, 'Renamed', true);
  assert.equal(f.accounts.resolveKey(next), null); assert.equal(f.accounts.hasWebOrigin('http://localhost:8080'), false);
  f.accounts.updateProject(first.id, project.id, 'Renamed', false);
  const active = f.accounts.keys(first.id, app.id).find(x => !x.revoked_at);
  f.accounts.revokeKey(first.id, app.id, active.id); assert.equal(f.accounts.resolveKey(next), null);
  f.accounts.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  assert.equal((await readFile(f.path)).includes(Buffer.from(next)), false);
});
test('web origin, registration inputs and bounded rate limiter reject invalid values', async t => {
  const f = await accountFixture(t);
  await assert.rejects(f.accounts.register({ name: 'One', email: 'bad', password }), e => e.status === 400);
  await assert.rejects(f.accounts.register({ name: 'One', email: 'ok@example.test', password: 'short' }), e => e.status === 400);
  const owner = await f.accounts.register({ name: 'One', email: 'ok@example.test', password });
  const project = f.accounts.createProject(owner.id, 'Project');
  for (const identifier of ['javascript:alert(1)', 'https://example.test/path', 'https://name:password@example.test', 'https://example.test/?key=x']) {
    assert.throws(() => f.accounts.createApplication(owner.id, project.id, { name: 'Web', platform: 'web', identifier }), e => e.status === 400);
  }
  const rate = new WindowLimiter(2, 1000, 2);
  assert.equal(rate.take('a', 0), 0); assert.equal(rate.take('a', 0), 0); assert.equal(rate.take('a', 0), 1);
  assert.equal(rate.take('b', 0), 0); assert.equal(rate.take('c', 0), 60); assert.equal(rate.take('c', 1001), 0);
});

export function browserClient(base) {
  const cookies = new Map();
  const request = async (path, options = {}) => {
    const response = await fetch(base + path, { ...options, redirect: 'manual', headers: {
      Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...options.headers,
    } });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';'), equal = pair.indexOf('='); cookies.set(pair.slice(0, equal), pair.slice(equal + 1));
    }
    return response;
  };
  const csrf = async (path = '/console') => {
    const response = await request(path), html = await response.text();
    assert.equal(response.status, 200, html.slice(0, 200));
    return html.match(/name="csrfToken" value="([^"]+)"/)?.[1];
  };
  const post = (path, values) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values) });
  const register = async (email, name = 'Owner') => {
    const response = await post('/register', { name, email, password, csrfToken: await csrf('/register') });
    assert.equal(response.status, 303, await response.text());
    return csrf();
  };
  return { request, csrf, post, register, cookies };
}
test('HTTP account flow isolates events, rejects CSRF and wrong origins, and invalidates logout', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ulsa-console-http-'));
  const config = await loadConfig({ DATA_DIR: directory, DEMO_MODE: '1', CONSOLE_ENABLED: '1' });
  const store = await openStore(config), accounts = new AccountStore(config.accountsPath);
  const server = createApp({ config, store, accounts }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); accounts.close(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`, a = browserClient(url), b = browserClient(url);
  assert.equal((await a.request('/console')).status, 303);
  assert.equal((await a.post('/register', { name: 'bad', email: 'bad@example.test', password, csrfToken: 'x' })).status, 403);
  const csrf = await a.register('one-http@example.test', '<img src=x onerror=alert(1)>');
  await b.register('two-http@example.test');
  const created = await a.post('/console/projects', { name: '<script>alert(1)</script>', csrfToken: csrf });
  assert.equal(created.status, 303);
  const path = created.headers.get('location');
  assert.equal((await b.request(path)).status, 404);
  const projectHtml = await (await a.request(path)).text();
  assert.match(projectHtml, /&lt;script&gt;/); assert.doesNotMatch(projectHtml, /<script>alert/);
  const appResponse = await a.post(path + '/apps', { name: 'Website', platform: 'web', identifier: 'http://site.example.test', csrfToken: csrf });
  assert.equal(appResponse.status, 200);
  const html = await appResponse.text(), key = html.match(/ulsa_[a-f0-9]{64}/)?.[0], appId = html.match(/\/console\/apps\/(a_[a-f0-9]{32})/)?.[1];
  assert.ok(key && appId);
  assert.equal((await b.request(`/console/apps/${appId}/data`)).status, 404);
  const source = { schemaVersion: 1, events: [{ eventId: randomUUID(), sessionId: randomUUID(), occurredAt: new Date().toISOString(), name: 'screen_view', screen: 'home', platform: 'web', appVersion: 'test' }] };
  const ingest = (origin, sendingKey = key) => fetch(url + '/api/v1/events', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sendingKey, ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(source) });
  assert.equal((await ingest('http://wrong.example.test')).status, 403);
  const good = await ingest('http://site.example.test'); assert.equal(good.status, 200); assert.equal(good.headers.get('access-control-allow-origin'), 'http://site.example.test');
  assert.equal((await (await ingest('http://site.example.test')).json()).duplicates, 1);
  assert.equal((await (await a.request(`/console/apps/${appId}/data`)).json()).totals.events, 1);
  assert.equal((await fetch(url + '/api/v1/stats', { headers: { Authorization: 'Bearer ' + key } })).status, 401);
  assert.equal((await a.post('/console/projects', { name: 'Forged', csrfToken: 'я'.repeat(csrf.length) })).status, 403);
  const oldCookie = a.cookies.get('ulsa_session');
  assert.equal((await a.post('/logout', { csrfToken: csrf })).status, 303);
  assert.equal((await fetch(url + '/console', { headers: { Cookie: 'ulsa_session=' + oldCookie }, redirect: 'manual' })).status, 303);
});
