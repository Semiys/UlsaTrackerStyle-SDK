import { resolveRange, browserTimeZone, rangeLabel, timeZoneLabel } from './date-range.js';

export function csvExportQuery(selection, now = Date.now(), timezone = browserTimeZone()) {
  const range = resolveRange(selection, now);
  const params = new URLSearchParams({ to: String(range.to), timezone });
  if (selection.kind === 'relative' && selection.id === 'all') params.set('period', 'all');
  else params.set('from', String(range.from));
  return params;
}

export function mountCsvExport({ getSelection }) {
  const triggers = ['export-csv', 'export-json'].map(id => document.getElementById(id)).filter(Boolean);
  const dialog = document.getElementById('csv-dialog');
  if (!triggers.length || !dialog) return;
  let trigger = triggers[0], format = 'csv';
  const status = document.getElementById('csv-status');
  const buttons = [...dialog.querySelectorAll('[data-export-kind]')];
  let request;
  const close = () => { request?.abort(); dialog.close(); trigger.focus(); };
  for (const item of triggers) item.addEventListener('click', () => {
    trigger = item; format = item.dataset.exportFormat === 'json' ? 'json' : 'csv';
    document.getElementById('csv-title').textContent = `Скачать ${format.toUpperCase()}`;
    document.getElementById('csv-format-note').textContent = format === 'json'
      ? 'JSON сохраняет структуру данных и подходит для программ и нейросетей.' : 'CSV открывается в Excel.';
    status.textContent = '';
    document.getElementById('csv-period').textContent = `${rangeLabel(getSelection())} · ${timeZoneLabel()}`;
    dialog.showModal();
  });
  document.getElementById('csv-close').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
  });
  for (const button of buttons) button.addEventListener('click', async () => {
    request = new AbortController();
    const current = request;
    for (const item of buttons) item.disabled = true;
    status.textContent = `Готовим ${format.toUpperCase()}…`;
    try {
      const url = new URL(trigger.dataset.exportUrl, window.location.origin);
      url.search = csvExportQuery(getSelection()).toString(); url.searchParams.set('kind', button.dataset.exportKind);
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: current.signal });
      if (response.redirected) throw new Error('Сеанс завершён. Войдите в кабинет и повторите скачивание.');
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error?.message ?? 'Не удалось скачать файл. Повторите позже.');
      }
      const contentType = format === 'json' ? 'application/json' : 'text/csv';
      if (!response.headers.get('content-type')?.startsWith(contentType)) throw new Error('Не удалось скачать файл. Обновите страницу и повторите.');
      const blob = await response.blob();
      if (current.signal.aborted) return;
      const download = document.createElement('a'), objectUrl = URL.createObjectURL(blob);
      download.href = objectUrl;
      download.download = response.headers.get('content-disposition')?.match(/filename="([a-z0-9.-]+)"/i)?.[1] ?? `ulsa-export.${format}`;
      document.body.append(download); download.click(); download.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      status.textContent = `${format.toUpperCase()} подготовлен. Записей данных: ${response.headers.get('x-export-rows') ?? '—'}. Файл сохранится в загрузках браузера.`;
    } catch (error) {
      if (error.name !== 'AbortError') status.textContent = error.message;
    } finally {
      if (request === current) { request = null; for (const item of buttons) item.disabled = false; }
    }
  });
}
