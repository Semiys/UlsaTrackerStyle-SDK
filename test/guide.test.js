import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/storage.js';
import { createApp } from '../src/app.js';
import { AccountStore } from '../src/accounts.js';
import { guideExamples } from '../src/guide-examples.js';
import { createTracker } from '../sdk/js/index.mjs';
import { validateBatch } from '../src/events.js';
import { browserClient } from './helpers/browser-client.mjs';

async function fixture(t, consoleEnabled = false) {
  const directory = await mkdtemp(join(tmpdir(), 'ulsa-guide-'));
  const config = await loadConfig({ DATA_DIR: directory, DEMO_MODE: '0', CONSOLE_ENABLED: consoleEnabled ? '1' : '0' });
  const store = await openStore(config);
  const accounts = consoleEnabled ? new AccountStore(config.accountsPath) : null;
  const server = createApp({ config, store, accounts }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await store.close(); accounts?.close(); await rm(directory, { recursive: true, force: true }); });
  return { config, store, url: `http://127.0.0.1:${server.address().port}` };
}

test('public guide has working section links, escaped examples and no credentials or writes', async t => {
  const f = await fixture(t);
  const reply = await fetch(f.url + '/guide?ingestKey=' + f.config.ingestKey);
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get('cache-control'), 'no-store');
  const html = await reply.text();
  assert.match(html, /Инструкция по подключению/);
  assert.match(html, /href="\/guide" aria-current="page"/);
  for (const id of ['project', 'key', 'address', 'android', 'javascript', 'verify', 'event-types', 'troubleshooting']) {
    assert.ok(html.includes(`id="${id}"`)); assert.ok(html.includes(`href="#${id}"`));
  }
  assert.match(html, /&lt;script src=/);
  assert.match(html, /data-copy="guide-application"/);
  assert.ok(html.includes('src="/console.js"')); // Copy works even without the account console.
  for (const key of [f.config.ingestKey, f.config.readKey]) assert.equal(html.includes(key), false);
  assert.equal(html.includes('href="/register"'), false);
  assert.doesNotMatch(html, /ЛР\d|лабораторн|учебн|Дом Коллекционера|[→←]/i);
  assert.equal((await f.store.stats(f.config.projectId, 7)).totals.events, 0);
  const copiedIds = [...html.matchAll(/data-copy="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(copiedIds).size, copiedIds.length);
  for (const id of copiedIds) assert.ok(html.includes(`<pre id="${id}"`));
  assert.equal((await fetch(f.url + '/guide.css')).status, 200);
});

test('guide keeps account navigation and is linked from a newly created Android or Web application', async t => {
  const f = await fixture(t, true);
  const guest = await (await fetch(f.url + '/guide')).text();
  assert.ok(guest.includes('href="/register"'));
  const client = browserClient(f.url);
  const csrf = await client.register('guide@example.test', 'Guide tester');
  const ownerGuide = await (await client.request('/guide')).text();
  assert.ok(ownerGuide.includes('Открыть мои проекты'));
  const projectsHtml = await (await client.request('/console')).text();
  assert.ok(projectsHtml.includes('href="/guide#project"'));
  const project = await client.post('/console/projects', { csrfToken: csrf, name: 'Guide examples' });
  assert.equal(project.status, 303);
  const projectPath = project.headers.get('location');
  for (const [platform, identifier, anchor] of [['android', 'com.example.app', 'android'], ['web', 'https://example.test', 'javascript']]) {
    const created = await client.post(projectPath + '/apps', { csrfToken: csrf, platform, identifier, name: 'Guide ' + platform });
    assert.equal(created.status, 200);
    const html = await created.text();
    assert.ok(html.includes(`href="/guide#${anchor}"`));
    assert.match(html, /Пошаговая инструкция/);
  }
});

test('copyable JavaScript guide produces contract-valid screen, click and success with the real SDK', async t => {
  const examples = guideExamples('http://localhost:8080');
  const key = 'ulsa_' + 'b'.repeat(64);
  let tracker, buttonHandler, delivered;
  const sdk = { create(options) {
    tracker = createTracker({ ...options, fetch: async (_, init) => {
      delivered = JSON.parse(init.body); validateBatch(delivered);
      return new Response(JSON.stringify({ schemaVersion: 1, accepted: delivered.events.length, duplicates: 0,
        acknowledgedEventIds: delivered.events.map(event => event.eventId) }), { status: 200 });
    } });
    return tracker;
  } };
  t.after(() => tracker?.close());
  const source = examples.javascript.replaceAll('ВАШ_КЛЮЧ_ОТПРАВКИ', key);
  new Script(source).runInNewContext({ UlsaTracker: sdk, document: { getElementById(id) {
    assert.equal(id, 'add-item'); return { addEventListener(type, handler) { assert.equal(type, 'click'); buttonHandler = handler; } };
  } } });
  assert.equal(typeof buttonHandler, 'function');
  buttonHandler();
  new Script(examples.successWeb).runInNewContext({ tracker });
  await tracker.flush();
  assert.deepEqual(delivered.events.map(event => [event.name, event.screen]), [['screen_view', 'home'], ['button_click', 'home'], ['action_success', 'add_item']]);
  assert.equal(delivered.events[1].properties.button, 'add_item');
  assert.equal(delivered.events[2].properties.action, 'item_saved');
  assert.equal(tracker.getStatus().queued, 0);
});

test('HTTPS guide avoids local-only HTTP opt-ins and Android initialisation happens once', () => {
  const examples = guideExamples('https://analytics.example.test');
  assert.doesNotMatch(examples.javascript + examples.application + examples.module, /allowHttp/);
  assert.equal((examples.application.match(/createAndroidTracker\(/g) ?? []).length, 1);
  assert.match(examples.application, /class AnalyticsApplication : Application/);
  assert.match(examples.compose, /LaunchedEffect\(tracker\)/);
  assert.match(examples.settings, /includeBuild/);
  assert.match(examples.dependency, /tracker:0\.2\.0/);
});

test('USB instructions use the public service port instead of a hardcoded 8080', () => {
  assert.equal(guideExamples('http://localhost:18086').reverse, 'adb reverse tcp:18086 tcp:18086');
  assert.equal(guideExamples('http://localhost:8080').reverse, 'adb reverse tcp:8080 tcp:8080');
  assert.equal(guideExamples('https://analytics.example.test:8443').reverse, 'adb reverse tcp:8443 tcp:8443');
});
