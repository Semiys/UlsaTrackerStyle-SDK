import test from 'node:test';
import assert from 'node:assert/strict';
import { exportJson, createDataExporter, CSV_ROW_LIMIT } from '../src/analytics-export.js';

const options = { kind: 'events', from: Date.parse('2026-10-30T00:00:00Z'), to: Date.parse('2026-10-30T01:00:00Z'), timezone: 'Europe/Astrakhan' };
const event = { eventId: 'event-id', sessionId: 'session-id', eventType: 'button_click', screen: 'home', platform: 'android', appVersion: '=2+2',
  occurredMs: options.from, receivedMs: options.from + 123,
  properties: JSON.stringify({ button: 'save', note: 'Кавычки: "текст"\nновая строка', count: 2, success: true, missing: null }) };
const response = () => ({ headers: {}, statusCode: 200, set(key, value) { this.headers[key] = value; return this; },
  status(code) { this.statusCode = code; return this; }, send(body) { this.body = body; }, json(body) { this.body = body; } });
const request = { query: { period: 'all', to: String(Date.now()) }, accountSession: { user: { id: 'owner-a' } } };

test('JSON events preserve scalar types, exact text, local/UTC instants and period metadata without a BOM', () => {
  const text = exportJson([event], options), data = JSON.parse(text);
  assert.equal(text[0], '{'); assert.equal(data.format_version, 1); assert.equal(data.export_type, 'events');
  assert.deepEqual(data.period, { mode: 'range', start_utc: new Date(options.from).toISOString(), end_utc: new Date(options.to).toISOString(), time_zone: 'Europe/Astrakhan' });
  assert.equal(data.row_count, 1); assert.equal(data.rows[0].occurred_at_local, '2026-10-30 04:00:00.000 +04:00');
  assert.equal(data.rows[0].received_at_utc, '2026-10-30T00:00:00.123Z');
  assert.equal(data.rows[0].app_version, '=2+2'); assert.deepEqual(data.rows[0].properties, JSON.parse(event.properties));
});

test('JSON summary uses numeric group counts, omits event identities and represents empty/all-time exports explicitly', () => {
  const row = { eventType: 'button_click', screen: 'home', button: 'save', action: '', platform: 'android', appVersion: '1', eventCount: 9, sessionCount: 2 };
  const summary = JSON.parse(exportJson([row], { ...options, kind: 'summary', from: null }));
  assert.equal(summary.rows[0].event_count, 9); assert.equal(summary.rows[0].sessions_in_group, 2);
  assert.equal(summary.period.mode, 'all'); assert.equal(summary.period.start_utc, null);
  assert.ok(!('event_id' in summary.rows[0])); assert.ok(!('properties' in summary.rows[0]));
  const empty = JSON.parse(exportJson([], options)); assert.equal(empty.row_count, 0); assert.deepEqual(empty.rows, []);
});

test('JSON limits count UTF-8 bytes including metadata and reject too many rows without truncation', () => {
  const text = exportJson([event], options), bytes = Buffer.byteLength(text);
  assert.ok(bytes > text.length);
  assert.equal(exportJson([event], options, bytes), text);
  assert.throws(() => exportJson([event], options, bytes - 1), error => error.code === 'export_too_large');
  assert.throws(() => exportJson([], options, 1), error => error.code === 'export_too_large');
  assert.throws(() => exportJson(Array(CSV_ROW_LIMIT + 1).fill(event), options), error => error.code === 'export_too_many_rows');
});

test('CSV and JSON share the owner quota and set correct private attachment headers', async () => {
  const send = createDataExporter({ exportRows: async () => [] });
  for (let index = 0; index < 6; index++) {
    const format = index % 2 ? 'json' : 'csv', res = response();
    await send(request, res, 'app-a', format);
    assert.equal(res.statusCode, 200); assert.equal(res.headers['Cache-Control'], 'private, no-store');
    assert.ok(res.headers['Content-Disposition'].endsWith(`.${format}"`));
    assert.ok(res.headers['Content-Type'].startsWith(format === 'json' ? 'application/json' : 'text/csv'));
    assert.equal(res.headers['X-Export-Rows'], '0');
  }
  const refused = response(); await send(request, refused, 'app-a', 'json');
  assert.equal(refused.statusCode, 429); assert.ok(refused.headers['Retry-After']); assert.equal(refused.headers['Content-Disposition'], undefined);
  const another = response(); await send({ ...request, accountSession: { user: { id: 'owner-b' } } }, another, 'app-b', 'json');
  assert.equal(another.statusCode, 200);
});

test('failed JSON serialization and invalid formats never produce a partial downloadable attachment', async () => {
  const send = createDataExporter({ exportRows: async () => [{ ...event, properties: '{invalid' }] });
  const failed = response(); await send({ ...request, query: { ...request.query, kind: 'events' } }, failed, 'app-a', 'json');
  assert.equal(failed.statusCode, 503); assert.equal(failed.headers['Content-Disposition'], undefined);
  assert.equal(failed.body.error.code, 'export_unavailable');
  const invalid = response(); await send(request, invalid, 'app-a', 'yaml');
  assert.equal(invalid.statusCode, 400); assert.equal(invalid.headers['Content-Disposition'], undefined);
});
