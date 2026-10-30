import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY, dayStart, addDays, formatLocal, parseLocal, resolveRange, readSelection, saveSelection, monthCells, browserTimeZone, timeZoneLabel } from '../public/date-range.js';

function inZone(zone, operation) {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try { operation(); } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
}

test('local day and manual input use device timezone, including fractional-hour offsets', () => {
  for (const [zone, midnight, text, label] of [
    ['Europe/Astrakhan', '2026-10-29T20:00:00Z', '30.10.2026 16:34:56.123', '+04:00'],
    ['Asia/Kathmandu', '2026-10-29T18:15:00Z', '30.10.2026 18:19:56.123', '+05:45'],
    ['America/New_York', '2026-10-30T04:00:00Z', '30.10.2026 08:34:56.123', '-04:00'],
  ]) inZone(zone, () => {
    const instant = Date.parse('2026-10-30T12:34:56.123Z');
    assert.equal(dayStart(instant), Date.parse(midnight), zone);
    assert.equal(resolveRange({ kind: 'relative', id: 'today' }, instant).from, Date.parse(midnight));
    assert.equal(formatLocal(instant), text);
    assert.equal(parseLocal(text), instant);
    assert.ok(timeZoneLabel(instant).includes(label));
    assert.ok(browserTimeZone().length > 0);
  });
});

test('calendar day arithmetic spans spring and autumn clock changes without adding a fixed 24 hours', () => {
  inZone('America/New_York', () => {
    for (const [month, date, hours] of [[2, 8, 23], [10, 1, 25]]) {
      const start = new Date(2026, month, date).getTime(), next = addDays(start, 1);
      assert.equal(next - start, hours * 3600000);
      assert.equal(new Date(next).getHours(), 0);
      assert.equal(new Date(next - 1).getHours(), 23);
      const values = monthCells(start).filter(value => value !== null);
      assert.equal(new Set(values).size, values.length);
      assert.ok(values.every(value => new Date(value).getHours() === 0));
    }
  });
});

test('nonexistent local times are rejected and both occurrences of an autumn hour round-trip exactly', () => {
  inZone('America/New_York', () => {
    assert.ok(Number.isNaN(parseLocal('08.03.2026 02:30:00')));
    assert.ok(Number.isNaN(parseLocal('01.11.2026 01:30:00')));
    for (const value of ['2026-11-01T05:30:00.123Z', '2026-11-01T06:30:00.123Z']) {
      const ms = Date.parse(value), text = formatLocal(ms);
      assert.match(text, / -0[45]:00$/);
      assert.equal(parseLocal(text), ms);
    }
    assert.ok(Number.isNaN(parseLocal('01.11.2026 01:30:00 -06:00')));
  });
});

test('fixed ranges retain their instants when a link is opened in another timezone', () => {
  const selection = { kind: 'absolute', from: Date.parse('2026-10-29T20:00:00Z'), to: Date.parse('2026-10-30T12:34:56Z') };
  const url = saveSelection(new URL('https://example.test/dashboard'), selection);
  const now = selection.to + DAY;
  for (const zone of ['UTC', 'Europe/Astrakhan', 'America/New_York']) inZone(zone, () => {
    assert.deepEqual(readSelection(url.searchParams, now), selection);
    assert.equal(parseLocal(formatLocal(selection.from)), selection.from);
  });
});
