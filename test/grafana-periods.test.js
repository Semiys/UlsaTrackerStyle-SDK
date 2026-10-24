import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createClient } from '@clickhouse/client';

const grafanaUrl = process.env.GRAFANA_TEST_URL;
const integration = { skip: !grafanaUrl || !process.env.DATABASE_URL };
const dashboard = JSON.parse(await readFile(new URL('../grafana/provisioning/dashboards/ulsatracker.json', import.meta.url), 'utf8'));
const day = 86_400_000;

test('period comparison and weekday heatmap agree with bounded, deduplicated UTC events', integration, async t => {
  const admin = createClient({ url: process.env.DATABASE_URL, username: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD, database: process.env.DATABASE_NAME });
  t.after(() => admin.close());
  const sessionId = randomUUID();
  const fixtures = [
    '2020-01-06T00:00:00Z', '2020-01-06T03:00:00Z', '2020-01-06T03:20:00Z',
    '2020-01-07T23:59:59Z', '2020-01-12T12:34:56Z',
    '2019-12-30T00:00:00Z', '2019-12-31T23:59:59Z', '2020-01-05T12:34:56Z',
    '2020-01-05T12:34:57Z', '2020-01-12T12:34:57Z',
  ].map(occurredAt => ({ occurredAt, eventId: randomUUID(), projectId: 'lab3-demo' }));
  const foreign = { occurredAt: '2020-01-06T03:10:00Z', eventId: randomUUID(), projectId: 'foreign_' + randomUUID().replaceAll('-', '') };
  const rows = [...fixtures, foreign].map(event => ({ project_id: event.projectId, event_id: event.eventId,
    session_id: sessionId, occurred_at: event.occurredAt, name: 'screen_view', screen: 'period_fixture',
    platform: 'web', app_version: 'test', properties: '{}', payload_hash: '0'.repeat(64) }));
  await admin.insert({ table: 'events', format: 'JSONEachRow', values: [...rows, rows[0]],
    clickhouse_settings: { date_time_input_format: 'best_effort' } });
  const scope = rows.map(row => `'${row.event_id}'`).join(',');
  async function query(panelId, range) {
    const target = dashboard.panels.find(panel => panel.id === panelId).targets[0];
    const rawSql = target.rawSql.replace("project_id = 'lab3-demo'", `project_id = 'lab3-demo' AND event_id IN (${scope})`);
    const reply = await fetch(grafanaUrl + '/api/ds/query', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: String(range.from), to: String(range.to),
        queries: [{ ...target, rawSql, refId: 'A', intervalMs: 10_000, maxDataPoints: 1000 }] }),
      signal: AbortSignal.timeout(30_000) });
    const result = await reply.json();
    assert.equal(reply.status, 200, JSON.stringify(result));
    assert.equal(result.results?.A?.error, undefined, JSON.stringify(result.results?.A));
    assert.ok(result.results?.A?.frames?.length, JSON.stringify(result));
    return result.results.A.frames[0];
  }
  function column(frame, name) {
    const index = frame.schema.fields.findIndex(field => field.name === name);
    assert.ok(index >= 0, name);
    return frame.data.values[index];
  }
  const total = values => values.reduce((sum, value) => sum + Number(value), 0);
  const to = Date.parse('2020-01-12T12:34:56Z');
  const midnight = Date.parse('2020-01-12T00:00:00Z');
  for (const days of [7, 30, 90]) {
    await t.test(`${days} days: previous window aligns and uses the same partial-day cutoff`, async () => {
      const from = midnight - (days - 1) * day;
      const frame = await query(13, { from, to });
      const current = fixtures.filter(event => Date.parse(event.occurredAt) >= from && Date.parse(event.occurredAt) <= to);
      const previous = fixtures.filter(event => Date.parse(event.occurredAt) >= from - days * day && Date.parse(event.occurredAt) <= to - days * day);
      const times = column(frame, 'time').map(Number);
      assert.deepEqual(times, Array.from({ length: days }, (_, i) => from + i * day));
      const currentValues = column(frame, 'Выбранный период').map(Number);
      const previousValues = column(frame, 'Предыдущий период').map(Number);
      for (const [events, values, offset] of [[current, currentValues, 0], [previous, previousValues, days * day]]) {
        const expected = times.map(time => events.filter(event => Math.floor((Date.parse(event.occurredAt) + offset) / day) * day === time).length);
        assert.deepEqual(values, expected);
      }
      assert.equal(total(currentValues), current.length);
      assert.equal(total(previousValues), previous.length);
      if (days === 7) { assert.equal(current.length, 5); assert.equal(previous.length, 3); }
    });
  }
  await t.test('heatmap has Monday–Sunday and all 24 hours, with exact event counts', async () => {
    const from = midnight - 6 * day;
    const frame = await query(14, { from, to });
    assert.deepEqual(column(frame, 'День / час UTC'), ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']);
    let sum = 0;
    for (let hour = 0; hour < 24; hour++) {
      const values = column(frame, String(hour).padStart(2, '0')).map(Number);
      const expected = Array.from({ length: 7 }, (_, weekday) => fixtures.filter(event => {
        const when = new Date(event.occurredAt);
        return when.getTime() >= from && when.getTime() <= to && (when.getUTCDay() + 6) % 7 === weekday && when.getUTCHours() === hour;
      }).length);
      assert.deepEqual(values, expected);
      sum += total(values);
    }
    assert.equal(sum, 5);
    assert.equal(Number(column(frame, '03')[0]), 2);
    assert.equal(Number(column(frame, '23')[1]), 1);
    assert.equal(Number(column(frame, '12')[6]), 1);
  });
  await t.test('empty comparison and heatmap retain their zero buckets', async () => {
    const from = Date.UTC(2010, 0, 1);
    const range = { from, to: from + 7 * day - 1000 };
    const comparison = await query(13, range);
    assert.deepEqual(column(comparison, 'Выбранный период').map(Number), Array(7).fill(0));
    assert.deepEqual(column(comparison, 'Предыдущий период').map(Number), Array(7).fill(0));
    const heatmap = await query(14, range);
    assert.equal(heatmap.data.values[0].length, 7);
    for (const values of heatmap.data.values.slice(1)) assert.deepEqual(values.map(Number), Array(7).fill(0));
  });
});
