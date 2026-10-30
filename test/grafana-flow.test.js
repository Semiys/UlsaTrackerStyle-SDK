import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createClient } from '@clickhouse/client';
const integration = { skip: !process.env.GRAFANA_TEST_URL || !process.env.DATABASE_URL };
const definition = JSON.parse(await readFile(new URL('../grafana/provisioning/dashboards/ulsatracker.json', import.meta.url), 'utf8'));

test('screen transitions respect session, time order, unknown screens and ambiguous timestamps', integration, async t => {
  const admin = createClient({ url: process.env.DATABASE_URL, username: process.env.DATABASE_USER, password: process.env.DATABASE_PASSWORD, database: process.env.DATABASE_NAME });
  t.after(() => admin.close());
  const from = Date.parse('2022-01-01T12:00:00Z'), to = from + 300000;
  const rows = [];
  function session(events, project = 'lab3-demo') {
    const sessionId = randomUUID();
    for (const [offset, screen, name = 'screen_view'] of events) rows.push({ project_id: project, event_id: randomUUID(), session_id: sessionId,
      occurred_at: new Date(from + offset).toISOString(), name, screen, platform: 'web', app_version: 'flow-test', properties: '{}', payload_hash: '0'.repeat(64) });
  }
  session([[1000, 'collection'], [2000, 'collection'], [2500, 'collection', 'button_click'], [3000, 'stats'], [4000, 'profile']]);
  session([[1000, 'collection'], [3000, 'stats']]);
  session([[2000, 'wishlist']]);
  session([[1000, 'collection'], [2000, null], [3000, 'profile']]);
  session([[1000, 'collection'], [2000, 'stats'], [2000, 'profile'], [3000, 'wishlist']]);
  session([[-1, 'collection'], [1000, 'profile']]);
  session([[to - from - 1, 'wishlist'], [to - from + 1, 'profile']]);
  session([[1000, 'private'], [2000, 'secret']], 'foreign_' + randomUUID().replaceAll('-', ''));
  await admin.insert({ table: 'events', format: 'JSONEachRow', values: [...rows, rows[3]], clickhouse_settings: { date_time_input_format: 'best_effort' } });
  const scope = rows.map(row => `'${row.event_id}'`).join(',');
  const target = definition.panels.find(panel => panel.id === 14).targets[0];
  async function query(start = from, end = to) {
    const response = await fetch(process.env.GRAFANA_TEST_URL + '/api/ds/query', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: String(start), to: String(end), queries: [{ ...target, refId: 'A', intervalMs: 1000, maxDataPoints: 100,
        rawSql: target.rawSql.replace("project_id = 'lab3-demo'", `project_id = 'lab3-demo' AND event_id IN (${scope})`) }] }) });
    const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data));
    assert.equal(data.results?.A?.error, undefined, JSON.stringify(data));
    return data.results.A.frames;
  }
  const frames = await query(), frame = frames[0];
  const column = name => frame.data.values[frame.schema.fields.findIndex(field => field.name === name)];
  assert.deepEqual(column('Исходный экран'), ['collection', 'stats']);
  assert.deepEqual(column('Следующий экран'), ['stats', 'profile']);
  assert.deepEqual(column('Переходы').map(Number), [2, 1]);
  assert.deepEqual(column('Доля, %').map(Number), [66.7, 33.3]);
  const empty = await query(Date.UTC(2010, 0, 1), Date.UTC(2010, 0, 1, 0, 5));
  assert.ok(empty.length === 0 || empty.every(item => item.data.values.every(values => values.length === 0)));
});
