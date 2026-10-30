import { ApiError } from './errors.js';
import { WindowLimiter } from './accounts.js';

export const CSV_ROW_LIMIT = 10000;
export const CSV_BYTE_LIMIT = 8 * 1024 * 1024;

export function exportOptions(query, now = Date.now()) {
  const kind = query.kind ?? 'summary';
  const timezone = query.timezone ?? 'UTC';
  if (!['summary', 'events'].includes(kind)) throw new ApiError(400, 'invalid_export', 'Выберите сводку или события.');
  if (typeof timezone !== 'string' || timezone.length > 80) throw new ApiError(400, 'invalid_timezone', 'Некорректный часовой пояс.');
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(0); }
  catch { throw new ApiError(400, 'invalid_timezone', 'Некорректный часовой пояс.'); }
  const epoch = value => typeof value === 'string' && /^\d{1,16}$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : NaN;
  const to = epoch(query.to), from = query.period === 'all' ? null : epoch(query.from);
  if (!Number.isFinite(to) || to > now + 60000 || (from !== null && (!Number.isFinite(from) || from > to || to - from > 366 * 86400000))) {
    throw new ApiError(400, 'invalid_export_range', 'Проверьте выбранный период. Ручной диапазон — до 366 дней.');
  }
  return { kind, timezone, from, to };
}

function cell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  // Quoting alone does not stop spreadsheet formulas when the file is opened in Excel.
  if (typeof value === 'string' && (/^[\s\u0000-\u001f]*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text))) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
export function csvText(headers, rows, byteLimit = CSV_BYTE_LIMIT) {
  const parts = ['\ufeff' + headers.map(cell).join(',') + '\r\n'];
  let bytes = Buffer.byteLength(parts[0]);
  for (const row of rows) {
    const line = row.map(cell).join(',') + '\r\n';
    bytes += Buffer.byteLength(line);
    if (bytes > byteLimit) throw new ApiError(413, 'export_too_large', 'CSV больше 8 МиБ. Выберите более короткий период. Файл не обрезан.');
    parts.push(line);
  }
  return parts.join('');
}

function localFormatter(timezone) {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hourCycle: 'h23', timeZoneName: 'longOffset' });
  return ms => {
    const p = Object.fromEntries(formatter.formatToParts(new Date(Number(ms))).map(part => [part.type, part.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}.${p.fractionalSecond} ${p.timeZoneName === 'GMT' ? '+00:00' : p.timeZoneName.replace('GMT', '')}`;
  };
}
export function exportCsv(rows, options) {
  const { kind, from, to, timezone } = options;
  const metadata = [from === null ? 'all' : 'range', from === null ? '' : new Date(from).toISOString(), new Date(to).toISOString(), timezone];
  const metaHeaders = ['period_mode', 'period_start_utc', 'period_end_utc', 'time_zone'];
  if (kind === 'summary') return csvText([
    'event_type', 'screen', 'button', 'action', 'platform', 'app_version', 'event_count', 'sessions_in_group', ...metaHeaders,
  ], rows.map(row => [row.eventType, row.screen, row.button, row.action, row.platform, row.appVersion, row.eventCount, row.sessionCount, ...metadata]));
  const local = localFormatter(timezone);
  return csvText(['event_id', 'session_id', 'event_type', 'screen', 'platform', 'app_version',
    'occurred_at_utc', 'occurred_at_local', 'received_at_utc', 'received_at_local', 'properties_json', ...metaHeaders],
  rows.map(row => [row.eventId, row.sessionId, row.eventType, row.screen, row.platform, row.appVersion,
    new Date(Number(row.occurredMs)).toISOString(), local(row.occurredMs), new Date(Number(row.receivedMs)).toISOString(), local(row.receivedMs), row.properties, ...metadata]));
}

export function createCsvExporter(store) {
  const requests = new WindowLimiter(6, 60000);
  return async (req, res, projectId) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const options = exportOptions(req.query);
      if (!store.exportRows) throw new ApiError(503, 'export_unavailable', 'Экспорт доступен на стенде с ClickHouse.');
      const wait = requests.take(req.accountSession?.user.id ?? req.socket.remoteAddress ?? 'guest');
      if (wait) { res.set('Retry-After', String(wait)); throw new ApiError(429, 'export_rate_limit', 'Слишком много выгрузок. Повторите через минуту.'); }
      const rows = await store.exportRows(projectId, options);
      const body = Buffer.from(exportCsv(rows, options), 'utf8');
      res.set('Content-Disposition', `attachment; filename="ulsa-${options.kind}-${new Date(options.to).toISOString().slice(0, 10)}.csv"`);
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('X-Export-Rows', String(rows.length));
      res.send(body);
    } catch (error) {
      if (!(error instanceof ApiError)) console.warn('CSV export failed:', error.name);
      res.status(error instanceof ApiError ? error.status : 503).json({ error: {
        code: error instanceof ApiError ? error.code : 'export_unavailable',
        message: error instanceof ApiError ? error.message : 'Не удалось подготовить CSV. Сократите период или повторите позже.',
      } });
    }
  };
}
