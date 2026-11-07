import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createClient } from '@clickhouse/client';

const integration = { skip: !process.env.GRAFANA_TEST_URL || !process.env.DATABASE_URL };
const definition = JSON.parse(await readFile(new URL('../grafana/provisioning/dashboards/ulsatracker.json', import.meta.url), 'utf8'));

test('short-range charts keep all points visible and compare the preceding interval without boundary duplicates', integration, async t => {
  const admin = createClient({ url: process.env.DATABASE_URL, username: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD, database: process.env.DATABASE_NAME });
  t.after(() => admin.close());
  const start = Date.parse('2021-01-12T10:02:30Z');
  const dates = [-300001, -300000, -152000, -1, 0, 42000, 300000, 300001].map(offset => start + offset);
  const rows = dates.map((at, i) => ({ project_id: 'lab3-demo', event_id: randomUUID(), session_id: randomUUID(),
    occurred_at: new Date(at).toISOString(), name: i % 2 ? 'screen_view' : 'button_click', screen: 'short_range_fixture',
    platform: 'web', app_version: 'test', properties: '{}', payload_hash: '0'.repeat(64) }));
  await admin.insert({ table: 'events', format: 'JSONEachRow', values: [...rows, rows[4]],
    clickhouse_settings: { date_time_input_format: 'best_effort' } });
  const scope = rows.map(row => `'${row.event_id}'`).join(',');
  async function query(id, from, to) {
    const target = definition.panels.find(panel => panel.id === id).targets[0];
    const response = await fetch(process.env.GRAFANA_TEST_URL + '/api/ds/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: String(from), to: String(to), queries: [{ ...target, refId: 'A', intervalMs: 1000, maxDataPoints: 1000,
        rawSql: target.rawSql.replaceAll('$__timezone', 'UTC').replace("project_id = 'lab3-demo'", `project_id = 'lab3-demo' AND event_id IN (${scope})`) }] }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    assert.equal(data.results?.A?.error, undefined, JSON.stringify(data));
    assert.ok(data.results.A.frames.length > 0);
    return data.results.A.frames[0];
  }
  function column(frame, name) {
    const i = frame.schema.fields.findIndex(field => field.name === name);
    assert.ok(i >= 0, name);
    return frame.data.values[i].map(Number);
  }
  const sum = values => values.reduce((a, b) => a + b, 0);
  for (const seconds of [30, 300, 3600, 86400]) {
    await t.test(`${seconds}s includes partial boundary buckets inside the viewport`, async () => {
      const to = start + seconds * 1000;
      const current = dates.filter(at => at >= start && at <= to);
      const previous = dates.filter(at => at >= start - seconds * 1000 && at < start);
      for (const id of [6, 13]) {
        const frame = await query(id, start, to);
        const times = column(frame, 'time');
        assert.ok(times.length >= 2);
        assert.equal(times[0], start);
        assert.ok(times.every(at => at >= start && at <= to), JSON.stringify(times));
        assert.equal(sum(column(frame, id === 6 ? 'Все события' : 'Выбранный период')), current.length);
        if (id === 13) assert.equal(sum(column(frame, 'Предыдущий период')), previous.length);
      }
    });
  }
  await t.test('calendar endpoints retain millisecond precision in counters and both lines', async () => {
    const from = start + 123, to = start + 300678, shift = to - from;
    const current = dates.filter(at => at >= from && at <= to);
    const previous = dates.filter(at => at >= from - shift && at < from);
    assert.equal(current.length, 3);
    for (const id of [1, 6, 13]) {
      const frame = await query(id, from, to);
      if (id === 1) { assert.equal(Number(frame.data.values[0][0]), current.length); continue; }
      assert.equal(sum(column(frame, id === 6 ? 'Все события' : 'Выбранный период')), current.length);
      assert.equal(column(frame, 'time')[0], from);
      assert.ok(column(frame, 'time').every(at => at >= from && at <= to));
      if (id === 13) assert.equal(sum(column(frame, 'Предыдущий период')), previous.length);
    }
  });
  await t.test('five-minute comparison uses the immediately preceding five minutes, not yesterday', async () => {
    const frame = await query(13, start, start + 300000);
    assert.equal(sum(column(frame, 'Выбранный период')), 3);
    assert.equal(sum(column(frame, 'Предыдущий период')), 3);
    assert.equal(column(frame, 'time').length, 6);
  });
  await t.test('an empty five-minute interval has visible zeros instead of an out-of-range midnight point', async () => {
    const from = Date.parse('2011-01-01T12:02:30Z');
    for (const id of [6, 13]) {
      const frame = await query(id, from, from + 300000);
      assert.equal(column(frame, 'time').length, 6);
      assert.equal(column(frame, 'time')[0], from);
      for (const values of frame.data.values.slice(1)) assert.ok(values.every(value => Number(value) === 0));
    }
  });
});
