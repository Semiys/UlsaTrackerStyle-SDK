import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createClient } from '@clickhouse/client';

const integration = { skip: !process.env.GRAFANA_TEST_URL || !process.env.DATABASE_URL };
const definition = JSON.parse(await readFile(new URL('../grafana/provisioning/dashboards/ulsatracker.json', import.meta.url), 'utf8'));
const ms = text => Date.parse(text);
const hour = 3600000;

test('local buckets retain all events around midnight, fractional offsets and clock changes', integration, async t => {
  const admin = createClient({ url: process.env.DATABASE_URL, username: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD, database: process.env.DATABASE_NAME });
  t.after(() => admin.close());
  const cases = [
    { name: 'Astrakhan days start at local midnight, four hours before UTC', zone: 'Europe/Astrakhan',
      from: ms('2025-12-31T20:00:00Z'), to: ms('2026-01-03T19:59:59.999Z'),
      buckets: ['2025-12-31T20:00:00Z', '2026-01-01T20:00:00Z', '2026-01-02T20:00:00Z'].map(ms),
      at: ['2025-12-31T20:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T19:59:59.999Z', '2026-01-01T20:00:00Z', '2026-01-02T20:00:00Z', '2026-01-03T19:59:59.999Z'].map(ms), counts: [3, 1, 2] },
    { name: 'spring day lasts 23 hours and an empty local day remains visible', zone: 'America/New_York',
      from: ms('2026-03-07T05:00:00Z'), to: ms('2026-03-10T03:59:59.999Z'),
      buckets: ['2026-03-07T05:00:00Z', '2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z'].map(ms),
      at: ['2026-03-07T05:00:00Z', '2026-03-08T04:59:59.999Z', '2026-03-09T04:00:00Z', '2026-03-10T03:59:59.999Z'].map(ms), counts: [2, 0, 2] },
    { name: 'autumn day lasts 25 hours and both repeated hours count', zone: 'America/New_York',
      from: ms('2026-10-31T04:00:00Z'), to: ms('2026-11-03T04:59:59.999Z'),
      buckets: ['2026-10-31T04:00:00Z', '2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z'].map(ms),
      at: ['2026-10-31T04:00:00Z', '2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z', '2026-11-03T04:59:59.999Z'].map(ms), counts: [1, 2, 1] },
    { name: 'Kathmandu hourly intervals account for the 45-minute offset', zone: 'Asia/Kathmandu',
      from: ms('2026-01-01T05:22:00Z'), to: ms('2026-01-01T08:22:00Z'),
      buckets: ['2026-01-01T05:22:00Z', '2026-01-01T06:15:00Z', '2026-01-01T07:15:00Z', '2026-01-01T08:15:00Z'].map(ms),
      at: ['2026-01-01T05:22:00Z', '2026-01-01T06:14:59.999Z', '2026-01-01T06:15:00Z', '2026-01-01T08:22:00Z'].map(ms), counts: [2, 1, 0, 1] },
    { name: 'hourly view keeps separate instants for repeated autumn wall-clock hours', zone: 'America/New_York',
      from: ms('2026-11-01T04:20:00Z'), to: ms('2026-11-01T08:20:00Z'),
      buckets: ['2026-11-01T04:20:00Z', '2026-11-01T05:00:00Z', '2026-11-01T06:00:00Z', '2026-11-01T07:00:00Z', '2026-11-01T08:00:00Z'].map(ms),
      at: ['2026-11-01T04:20:00Z', '2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z', '2026-11-01T08:20:00Z'].map(ms), counts: [1, 1, 1, 0, 1] },
    { name: 'half-hour DST shift retains events in real-duration hourly intervals', zone: 'Australia/Lord_Howe',
      from: ms('2026-10-03T14:30:00Z'), to: ms('2026-10-03T18:30:00Z'),
      buckets: [0, 1, 2, 3, 4].map(i => ms('2026-10-03T14:30:00Z') + i * hour),
      at: ['2026-10-03T14:30:00Z', '2026-10-03T15:45:00Z', '2026-10-03T16:05:00Z', '2026-10-03T18:30:00Z'].map(ms), counts: [1, 2, 0, 0, 1] },
  ];
  for (const sample of cases) await t.test(sample.name, async () => {
    const row = (at, project = 'lab3-demo') => ({ project_id: project, event_id: randomUUID(), session_id: randomUUID(),
      occurred_at: new Date(at).toISOString(), name: 'screen_view', screen: 'timezone_fixture',
      platform: 'web', app_version: 'test', properties: '{}', payload_hash: '0'.repeat(64) });
    const values = [...sample.at, sample.from - 1, sample.to + 1].map(at => row(at));
    const foreign = row(sample.from, 'foreign_' + randomUUID().replaceAll('-', ''));
    const rows = [...values, values[0], foreign];
    await admin.insert({ table: 'events', format: 'JSONEachRow', values: rows,
      clickhouse_settings: { date_time_input_format: 'best_effort' } });
    const scope = rows.map(value => `'${value.event_id}'`).join(',');
    const column = (frame, name) => {
      const index = frame.schema.fields.findIndex(field => field.name === name);
      assert.ok(index >= 0, name); return frame.data.values[index].map(Number);
    };
    for (const id of [1, 6, 13]) {
      const target = definition.panels.find(panel => panel.id === id).targets[0];
      // Grafana expands its built-in variable in the browser before POST /api/ds/query.
      const rawSql = target.rawSql.replaceAll('$__timezone', sample.zone)
        .replace("project_id = 'lab3-demo'", `project_id = 'lab3-demo' AND event_id IN (${scope})`);
      const response = await fetch(process.env.GRAFANA_TEST_URL + '/api/ds/query', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: String(sample.from), to: String(sample.to),
          queries: [{ ...target, rawSql, refId: 'A', intervalMs: 1000, maxDataPoints: 1000 }] }),
        signal: AbortSignal.timeout(30_000),
      });
      const data = await response.json();
      assert.equal(response.status, 200, JSON.stringify(data));
      assert.equal(data.results?.A?.error, undefined, JSON.stringify(data));
      const frame = data.results.A.frames[0];
      if (id === 1) { assert.equal(Number(frame.data.values[0][0]), sample.at.length); continue; }
      assert.deepEqual(column(frame, 'time'), sample.buckets);
      assert.deepEqual(column(frame, id === 6 ? 'Все события' : 'Выбранный период'), sample.counts);
      if (id === 13) assert.equal(column(frame, 'Предыдущий период').reduce((a, b) => a + b, 0), 1);
    }
  });
});
