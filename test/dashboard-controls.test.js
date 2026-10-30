import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import { PRESETS, readSelection, rangeQuery, saveSelection, dayStart, browserTimeZone, timeZoneLabel } from '../public/date-range.js';

const source = (await readFile(new URL('../public/dashboard.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
const first = Date.UTC(2010, 0, 1, 12, 1, 2, 123);
const tick = () => new Promise(resolve => setImmediate(resolve));
function page(search = '', request = async () => ({ ok: true, json: async () => ({ firstEventAt: first }) })) {
  const handlers = {}, writes = [];
  let src;
  const frame = { dataset: { dashboardUrl: 'http://localhost:3000/grafana/d/ulsatracker/events', rangeUrl: '/dashboard/range' }, addEventListener(_, handler) { handlers.load = handler; },
    get src() { return src; }, set src(value) { src = value; writes.push(value); } };
  const link = { setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; } }, status = {};
  const note = { textContent: 'Comparison note' };
  const location = { href: 'http://localhost:8080/dashboard' + search, origin: 'http://localhost:8080' };
  let apply;
  new Script(source).runInNewContext({ URL, Date, AbortSignal, fetch: request, readSelection, rangeQuery, saveSelection, dayStart, browserTimeZone, timeZoneLabel,
    mountCsvExport() {}, mountDateRangePicker(options) { apply = options.onApply; },
    window: { location, history: { replaceState(_, __, url) { location.href = url.href; } }, matchMedia: () => ({ matches: false, addEventListener() {} }),
      setInterval(handler) { handlers.timer = handler; return 1; }, clearInterval() {}, addEventListener(name, handler) { handlers[name] = handler; } },
    document: { visibilityState: 'visible', documentElement: { dataset: { theme: 'light' } }, addEventListener(name, handler) { handlers[name] = handler; },
      querySelectorAll() { return []; }, getElementById(id) { return { 'grafana-frame': frame, 'open-grafana': link, 'grafana-status': status, 'comparison-period-note': note,
        'refresh-grafana': { addEventListener(_, handler) { handlers.refresh = handler; } } }[id]; } },
  });
  return { frame, link, status, note, writes, location, handlers, apply };
}

test('all quick ranges survive refresh, theme change, full-screen link and page reload', async () => {
  const p = page();
  assert.equal(new URL(p.frame.src).searchParams.get('from'), 'now/d');
  for (const item of PRESETS) {
    const selection = { kind: 'relative', id: item.id };
    await p.apply(selection);
    for (const action of [async () => {}, p.handlers.refresh, p.handlers['ulsa-theme-change']]) {
      await action(); const url = new URL(p.frame.src);
      assert.equal(url.searchParams.get('from'), rangeQuery(selection, first).from);
      assert.equal(url.searchParams.get('to'), 'now');
      assert.equal(url.searchParams.get('timezone'), browserTimeZone());
      assert.equal(url.searchParams.get('refresh'), '30s');
      assert.equal(new URL(p.link.href).searchParams.has('kiosk'), false);
    }
    const reloaded = page(new URL(p.location.href).search); await tick();
    assert.equal(new URL(reloaded.frame.src).searchParams.get('from'), rangeQuery(selection, first).from);
  }
});

test('calendar dates retain exact fixed endpoints when reloaded or refreshed', async () => {
  const p = page('?days=30');
  const selection = { kind: 'absolute', from: Date.UTC(2026, 8, 30, 16, 3, 6, 123), to: Date.UTC(2026, 9, 1, 16, 3, 6, 987) };
  await p.apply(selection); await p.handlers.refresh(); await p.handlers['ulsa-theme-change']();
  for (const value of [p, page(new URL(p.location.href).search)]) {
    assert.equal(new URL(value.frame.src).searchParams.get('from'), String(selection.from));
    assert.equal(new URL(value.frame.src).searchParams.get('to'), String(selection.to));
  }
  assert.equal(new URL(p.location.href).searchParams.has('period'), false);
});

test('all-time lookup errors remain visible instead of silently showing seven days', async () => {
  const p = page('?period=all', async () => ({ ok: false })); await tick();
  assert.equal(p.frame.hidden, true); assert.equal(p.status.hidden, false);
  assert.match(p.status.textContent, /Не удалось загрузить весь период/);
  assert.equal(p.link.href, undefined);
});

test('empty history uses a small live window, and old responses cannot overwrite a new choice', async () => {
  const empty = page('?period=all', async () => ({ ok: true, json: async () => ({ firstEventAt: null }) })); await tick();
  assert.equal(new URL(empty.frame.src).searchParams.get('from'), String(dayStart(Date.now())));
  let resolve;
  const late = page('?period=all', () => new Promise(r => { resolve = r; }));
  await late.apply({ kind: 'relative', id: '5m' });
  resolve({ ok: true, json: async () => ({ firstEventAt: first }) }); await tick();
  assert.equal(new URL(late.frame.src).searchParams.get('from'), 'now-5m');
  assert.equal(late.note.textContent, 'Comparison note');
});

test('background checks preserve the frame unless older events extend the history', async () => {
  let boundary = first;
  const p = page('?period=all', async () => ({ ok: true, json: async () => ({ firstEventAt: boundary }) })); await tick();
  const writes = p.writes.length;
  p.handlers.timer(); await tick();
  assert.equal(p.writes.length, writes, 'Unchanged history must not reset the Grafana frame');
  boundary -= 86400000;
  p.handlers.timer(); await tick();
  assert.equal(new URL(p.frame.src).searchParams.get('from'), String(boundary));
  assert.equal(p.writes.length, writes + 1);
});
