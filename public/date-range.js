export const DAY = 86400000;
export const DEFAULT_PERIOD = 'today';
export const PRESETS = [
  ['all', 'За весь период', null],
  ['5m', 'Последние 5 минут', 300000], ['15m', 'Последние 15 минут', 900000],
  ['30m', 'Последние 30 минут', 1800000], ['1h', 'Последний час', 3600000],
  ['3h', 'Последние 3 часа', 10800000], ['6h', 'Последние 6 часов', 21600000],
  ['12h', 'Последние 12 часов', 43200000], ['24h', 'Последние 24 часа', DAY],
  ['today', 'Текущий день', 0], ['2d', 'Последние 2 дня', 2 * DAY],
  ['7d', 'Последние 7 дней', 7 * DAY], ['30d', 'Последние 30 дней', 30 * DAY],
  ['90d', 'Последние 90 дней', 90 * DAY],
].map(([id, label, duration]) => ({ id, label, duration }));
const preset = id => PRESETS.find(item => item.id === id);
const pad = (n, size = 2) => String(n).padStart(size, '0');
export function dayStart(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
export function addDays(ms, offset) { const d = new Date(ms); d.setDate(d.getDate() + offset); return d.getTime(); }
export function resolveRange(selection, now = Date.now(), firstEventAt = null) {
  if (selection.kind === 'absolute') return { from: selection.from, to: selection.to };
  const item = preset(selection.id) ?? preset(DEFAULT_PERIOD);
  return { from: item.id === 'all' ? (firstEventAt ?? dayStart(now)) : item.id === 'today' ? dayStart(now) : now - item.duration, to: now };
}
export function validateRange(from, to, now = Date.now()) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0) return 'Введите корректные местные дату и время. При повторяющемся часе укажите смещение, например -05:00.';
  if (from >= to) return 'Начало периода должно быть раньше окончания.';
  if (to > now) return 'Окончание периода не может быть в будущем.';
  if (to - from > 366 * DAY) return 'Выберите период не длиннее 366 дней.';
  return '';
}
export function readSelection(params, now = Date.now()) {
  const from = params.get('from'), to = params.get('to');
  if (/^\d{1,16}$/.test(from ?? '') && /^\d{1,16}$/.test(to ?? '') && !validateRange(Number(from), Number(to), now)) {
    return { kind: 'absolute', from: Number(from), to: Number(to) };
  }
  const id = params.get('period') ?? `${params.get('days')}d`;
  return { kind: 'relative', id: preset(id) ? id : DEFAULT_PERIOD };
}
/** @param {object} selection @param {number | null} [firstEventAt] */
export function rangeQuery(selection, firstEventAt = null) {
  if (selection.kind === 'absolute') return { from: String(selection.from), to: String(selection.to) };
  if (selection.id === 'all') {
    if (!Number.isSafeInteger(firstEventAt) || firstEventAt < 0) throw new Error('The first event boundary is required for the all-time range');
    return { from: String(firstEventAt), to: 'now' };
  }
  const id = preset(selection.id)?.id ?? DEFAULT_PERIOD;
  return { from: id === 'today' ? 'now/d' : `now-${id}`, to: 'now' };
}
export function saveSelection(url, selection) {
  for (const name of ['days', 'period', 'from', 'to']) url.searchParams.delete(name);
  if (selection.kind === 'absolute') {
    url.searchParams.set('from', String(selection.from)); url.searchParams.set('to', String(selection.to));
  } else url.searchParams.set('period', selection.id);
  return url;
}
export function browserTimeZone() {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
export function utcOffset(ms = Date.now()) {
  const minutes = -new Date(ms).getTimezoneOffset();
  return `${minutes >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')}:${String(Math.abs(minutes) % 60).padStart(2, '0')}`;
}
export function timeZoneLabel(ms = Date.now()) {
  return `${browserTimeZone()} · UTC${utcOffset(ms)}`;
}
const localParts = d => [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()];
function localCandidates(parts) {
  const guessed = new Date(...parts).getTime();
  if (!Number.isFinite(guessed)) return [];
  const offsets = new Set([-36, 0, 36].map(hours => new Date(guessed + hours * 3600000).getTimezoneOffset()));
  const naive = Date.UTC(...parts);
  return [...offsets].map(offset => naive + offset * 60000)
    .filter(value => localParts(new Date(value)).every((part, i) => part === parts[i])).sort((a, b) => a - b);
}
export function formatLocal(ms) {
  const d = new Date(ms), parts = localParts(d);
  const [year, month, date, hour, minute, second, milli] = parts;
  const text = `${pad(date)}.${pad(month + 1)}.${year} ${pad(hour)}:${pad(minute)}:${pad(second)}${milli ? '.' + pad(milli, 3) : ''}`;
  // A repeated autumn hour needs an offset so editing the other field cannot change its instant.
  return localCandidates(parts).length > 1 ? `${text} ${utcOffset(ms)}` : text;
}
export function parseLocal(text) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:\s+([+-])(\d{2}):(\d{2}))?$/.exec(text.trim());
  if (!m || Number(m[3]) < 1970 || Number(m[10] ?? 0) > 59) return NaN;
  const parts = [Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0), Number((m[7] ?? '').padEnd(3, '0'))];
  const candidates = localCandidates(parts);
  if (!m[8]) return candidates.length === 1 ? candidates[0] : NaN;
  const offset = (Number(m[9]) * 60 + Number(m[10])) * (m[8] === '+' ? 1 : -1);
  return candidates.find(value => -new Date(value).getTimezoneOffset() === offset) ?? NaN;
}
export function monthStart(ms) { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); }
export function addMonth(ms, offset) { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth() + offset, 1).getTime(); }
export function monthCells(ms) {
  const d = new Date(monthStart(ms)), year = d.getFullYear(), month = d.getMonth();
  const offset = (d.getDay() + 6) % 7;
  const length = new Date(year, month + 1, 0).getDate();
  return Array.from({ length: 42 }, (_, i) => {
    const date = i - offset + 1;
    if (date < 1 || date > length) return null;
    const value = new Date(year, month, date);
    return value.getDate() === date ? value.getTime() : null;
  });
}

export function rangeLabel(selection) {
  return selection.kind === 'absolute'
    ? `${formatLocal(selection.from).replace(/\.\d{3}(?= |$)/, '')} — ${formatLocal(selection.to).replace(/\.\d{3}(?= |$)/, '')}`
    : (preset(selection.id)?.label ?? preset(DEFAULT_PERIOD).label);
}
