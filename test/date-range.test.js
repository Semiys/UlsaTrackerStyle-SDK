import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY, PRESETS, resolveRange, validateRange, readSelection, rangeQuery, saveSelection, parseLocal, formatLocal, rangeLabel, monthCells, monthStart, addMonth } from '../public/date-range.js';

test('all relative presets resolve exact durations and today starts at local midnight', () => {
  const now = Date.UTC(2026, 9, 30, 13, 14, 15, 123);
  for (const item of PRESETS.filter(item => item.id !== 'all')) {
    const selection = { kind: 'relative', id: item.id }, range = resolveRange(selection, now);
    assert.equal(range.to, now);
    assert.equal(range.from, item.id === 'today' ? new Date(2026, 9, 30).getTime() : now - item.duration);
    assert.equal(rangeQuery(selection).to, 'now');
    assert.equal(rangeQuery(selection).from, item.id === 'today' ? 'now/d' : `now-${item.id}`);
  }
});

test('manual local input rejects impossible dates and retains millisecond endpoints', () => {
  for (const ms of [Date.UTC(2024, 1, 29, 23, 59, 59, 999), Date.UTC(2026, 9, 30, 0, 0, 0), Date.UTC(2026, 0, 1, 13, 4, 5, 10)]) {
    assert.equal(parseLocal(formatLocal(ms)), ms);
  }
  assert.equal(parseLocal('30.10.2026 08:30'), new Date(2026, 9, 30, 8, 30).getTime());
  for (const value of ['31.02.2026 12:00', '29.02.2025 12:00', '30.10.2026 24:00', '30.10.2026 12:60', 'bad', '01.01.1969 00:00']) assert.ok(Number.isNaN(parseLocal(value)), value);
});

test('range validation bounds size, ordering and future time without silently altering input', () => {
  const now = Date.UTC(2026, 9, 30);
  assert.equal(validateRange(now - 366 * DAY, now, now), '');
  assert.ok(validateRange(now - 367 * DAY, now, now));
  assert.ok(validateRange(now, now, now));
  assert.ok(validateRange(now - DAY, now + 1, now));
  assert.ok(validateRange(NaN, now, now));
});

test('absolute ranges and relative choices survive URL serialisation and old bookmarks', () => {
  assert.deepEqual(readSelection(new URLSearchParams()), { kind: 'relative', id: 'today' });
  assert.equal(rangeQuery({ kind: 'relative', id: 'invalid' }).from, 'now/d');
  const selections = [{ kind: 'relative', id: '7d' }, { kind: 'relative', id: '15m' }, { kind: 'absolute', from: Date.UTC(2026, 8, 30, 16, 3, 6, 123), to: Date.UTC(2026, 9, 30, 16, 3, 6, 987) }];
  for (const selection of selections) {
    const url = saveSelection(new URL('http://localhost/dashboard?days=30&period=7d&from=1&to=2'), selection);
    assert.deepEqual(readSelection(url.searchParams, Date.UTC(2026, 10, 1)), selection);
    assert.equal(url.searchParams.has('days'), false);
  }
  assert.deepEqual(readSelection(new URLSearchParams('days=30')), { kind: 'relative', id: '30d' });
  assert.deepEqual(readSelection(new URLSearchParams('from=NaN&to=Infinity&period=invalid')), { kind: 'relative', id: 'today' });
});

test('two-month calendar uses Monday-first local dates across leap years and year boundaries', () => {
  const february = new Date(2024, 1, 1).getTime(), cells = monthCells(february);
  assert.equal(cells.length, 42); assert.deepEqual(cells.slice(0, 3), [null, null, null]);
  assert.equal(cells.filter(value => value !== null).length, 29);
  assert.equal(addMonth(new Date(2026, 11, 1).getTime(), 1), new Date(2027, 0, 1).getTime());
  assert.equal(monthStart(new Date(2026, 9, 30, 23, 59).getTime()), new Date(2026, 9, 1).getTime());
});


test('all-time selection keeps old history, a live end and its identity across reloads', () => {
  const selection = { kind: 'relative', id: 'all' }, first = Date.UTC(2010, 0, 1, 12, 1, 2, 123);
  const now = Date.UTC(2026, 9, 30, 12);
  assert.equal(rangeLabel(selection), 'За весь период');
  assert.deepEqual(resolveRange(selection, now, first), { from: first, to: now });
  assert.deepEqual(rangeQuery(selection, first), { from: String(first), to: 'now' });
  const saved = saveSelection(new URL('https://example.test/dashboard?from=1&to=2'), selection);
  assert.deepEqual(readSelection(saved.searchParams, now), selection);
  assert.throws(() => rangeQuery(selection), /boundary is required/);
});
