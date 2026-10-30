import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { csvText, exportCsv, exportOptions, createCsvExporter, CSV_ROW_LIMIT } from '../src/csv-export.js';
import { csvExportQuery } from '../public/csv-export.js';
import { ClickHouseAnalyticsStore } from '../src/clickhouse-store.js';
import { ApiError } from '../src/errors.js';
import { parseCsv } from './helpers/csv.mjs';

test('CSV preserves UTF-8, commas, quotes and multiline fields and neutralises spreadsheet formulas', () => {
  const values = ['Светлая тема', 'one,"two"\nthree', '=1+1', '  +CMD()', '-formula', '@SUM(1)', '\t=1', '\rtext'];
  const text = csvText(['text', 'count'], values.map(value => [value, 1]));
  assert.equal(text.charCodeAt(0), 0xfeff); assert.ok(text.endsWith('\r\n'));
  const parsed = parseCsv(text);
  assert.deepEqual(parsed.rows.map(row => row.text), values.map((value, i) => i >= 2 ? "'" + value : value));
  assert.ok(parsed.rows.every(row => row.count === '1'));
  assert.throws(() => csvText(['text'], [['x'.repeat(200)]], 50), error => error.code === 'export_too_large');
});

test('export validates periods and timezone, while all-time history bypasses the manual range cap', () => {
  const now = Date.UTC(2026, 9, 30, 12);
  const query = { from: String(now - 3600000), to: String(now), timezone: 'Europe/Astrakhan' };
  assert.equal(exportOptions(query, now).kind, 'summary');
  for (const patch of [{ from: '-1' }, { from: [query.from] }, { to: 'NaN' }, { from: String(now + 1) },
    { to: String(now + 120000) }, { from: '0' }, { timezone: 'fake/timezone' }, { kind: 'xls' }]) {
    assert.throws(() => exportOptions({ ...query, ...patch }, now), error => error.status === 400);
  }
  assert.equal(exportOptions({ period: 'all', to: String(now), kind: 'events' }, now).from, null);
});

test('detailed CSV includes matching local and UTC instants; summary is aggregate and empty CSV has only headers', () => {
  const options = { kind: 'events', from: 0, to: Date.UTC(2026, 9, 30), timezone: 'Europe/Astrakhan' };
  const row = { eventId: 'id', sessionId: 'session', eventType: 'button_click', screen: 'home', platform: 'android', appVersion: '1',
    occurredMs: Date.UTC(2026, 9, 29, 20), receivedMs: Date.UTC(2026, 9, 29, 21), properties: '{"button":"сохранить"}' };
  const result = parseCsv(exportCsv([row], options)).rows[0];
  assert.equal(result.occurred_at_utc, '2026-10-29T20:00:00.000Z');
  assert.equal(result.occurred_at_local, '2026-10-30 00:00:00.000 +04:00');
  assert.equal(JSON.parse(result.properties_json).button, 'сохранить');
  const summary = parseCsv(exportCsv([{ eventType: 'button_click', screen: 'home', button: 'save', platform: 'android', appVersion: '1', eventCount: 2, sessionCount: 1 }], { ...options, kind: 'summary' }));
  assert.equal(summary.rows[0].event_count, '2'); assert.equal(summary.rows[0].sessions_in_group, '1');
  assert.ok(!summary.headers.includes('session_id')); assert.ok(!summary.headers.includes('properties_json'));
  assert.equal(parseCsv(exportCsv([], options)).rows.length, 0);
});

test('row limits and failed exports never return a partial attachment; downloads are rate limited', async () => {
  const store = new ClickHouseAnalyticsStore({ query: async () => ({ json: async () => Array(CSV_ROW_LIMIT + 1).fill({}) }) });
  await assert.rejects(store.exportRows('demo', { kind: 'events', from: 0, to: 1 }), error => error.code === 'export_too_many_rows');
  const send = createCsvExporter({ exportRows: async () => [] });
  const response = () => ({ headers: {}, statusCode: 200, set(k, v) { this.headers[k] = v; return this; }, status(n) { this.statusCode = n; return this; }, send(value) { this.body = value; }, json(value) { this.body = value; } });
  const req = { query: { period: 'all', to: String(Date.now()) }, socket: { remoteAddress: 'test' } };
  for (let i = 0; i < 6; i++) { const res = response(); await send(req, res, 'demo'); assert.equal(res.statusCode, 200); }
  const limited = response(); await send(req, limited, 'demo'); assert.equal(limited.statusCode, 429); assert.ok(limited.headers['Retry-After']);
  const failed = response(); await createCsvExporter({ exportRows: async () => { throw new ApiError(413, 'export_too_large', 'Too large'); } })(req, failed, 'demo');
  assert.equal(failed.statusCode, 413); assert.equal(failed.headers['Content-Disposition'], undefined);
});

test('browser export preserves fixed instants and uses an explicit all-history mode', () => {
  const now = Date.UTC(2026, 9, 30, 12), selection = { kind: 'absolute', from: now - 123456, to: now - 1 };
  const params = csvExportQuery(selection, now, 'Europe/Astrakhan');
  assert.equal(params.get('from'), String(selection.from)); assert.equal(params.get('to'), String(selection.to));
  assert.equal(params.get('timezone'), 'Europe/Astrakhan');
  const all = csvExportQuery({ kind: 'relative', id: 'all' }, now);
  assert.equal(all.get('period'), 'all'); assert.equal(all.has('from'), false); assert.equal(all.get('to'), String(now));
});

test('release dashboard matches the tested dashboard except for its product version title', async () => {
  const base = JSON.parse(await readFile(new URL('../grafana/provisioning/dashboards/ulsatracker.json', import.meta.url), 'utf8'));
  const release = JSON.parse(await readFile(new URL('../grafana/release-dashboard.json', import.meta.url), 'utf8'));
  assert.equal(release.title, 'UlsaTrackerStyle SDK 0.9.0');
  assert.deepEqual({ ...release, title: base.title }, base);
});
