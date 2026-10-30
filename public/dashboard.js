import { readSelection, rangeQuery, saveSelection, dayStart, browserTimeZone, timeZoneLabel } from './date-range.js';
import { mountDateRangePicker } from './date-range-picker.js';
import { mountCsvExport } from './csv-export.js';

(() => {
  const frame = document.getElementById('grafana-frame');
  if (!frame) return;
  const fullscreen = document.getElementById('open-grafana');
  const status = document.getElementById('grafana-status');
  const note = document.getElementById('comparison-period-note');
  const comparisonNote = note?.textContent;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let selection = readSelection(new URL(window.location.href).searchParams), revision = 0;
  mountCsvExport({ getSelection: () => selection });
  const allTime = () => selection.kind === 'relative' && selection.id === 'all';
  async function open({ background = false } = {}) {
    const current = ++revision;
    const entireHistory = allTime();
    let firstEventAt = null;
    if (!background) {
      status.hidden = false;
      status.textContent = 'Загружается панель статистики…';
    }
    if (note) note.textContent = entireHistory
      ? 'Показана вся сохранённая история приложения. Предыдущий отрезок до начала этой истории не содержит событий. Переходы считаются внутри одной сессии.'
      : comparisonNote;
    if (entireHistory) {
      if (!background) {
        frame.hidden = true;
        frame.src = 'about:blank';
        fullscreen.removeAttribute('href');
        fullscreen.setAttribute('aria-disabled', 'true');
      }
      try {
        const response = await fetch(frame.dataset.rangeUrl, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error('History boundary unavailable');
        const value = (await response.json()).firstEventAt;
        if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > Date.now())) throw new Error('Invalid history boundary');
        firstEventAt = value ?? dayStart(Date.now());
      } catch {
        if (current === revision) {
          status.hidden = false;
          status.textContent = 'Не удалось загрузить весь период. Нажмите «Обновить панель», чтобы повторить.';
        }
        return;
      }
    }
    if (current !== revision) return;
    for (const label of document.querySelectorAll('[data-device-timezone]')) label.textContent = timeZoneLabel();
    const theme = document.documentElement.dataset.theme ?? (media.matches ? 'dark' : 'light');
    const url = new URL(frame.dataset.dashboardUrl, window.location.origin);
    const range = rangeQuery(selection, firstEventAt);
    url.searchParams.set('theme', theme);
    url.searchParams.set('timezone', browserTimeZone());
    url.searchParams.set('refresh', '30s');
    url.searchParams.set('from', range.from); url.searchParams.set('to', range.to);
    fullscreen.href = url.href;
    fullscreen.removeAttribute('aria-disabled');
    url.searchParams.set('kiosk', '1');
    if (background && frame.src === url.href) { status.hidden = true; return; }
    frame.hidden = false; frame.src = url.href;
  }
  mountDateRangePicker({ initial: selection, onApply(value) {
    selection = value;
    window.history.replaceState(null, '', saveSelection(new URL(window.location.href), selection));
    return open();
  } });
  frame.addEventListener('load', () => { if (!frame.hidden) status.hidden = true; });
  document.getElementById('refresh-grafana').addEventListener('click', open);
  document.addEventListener('ulsa-theme-change', open);
  media.addEventListener('change', () => { if (!document.documentElement.dataset.theme) open(); });
  // Reframe only if an older event arrives; ordinary refreshes preserve Grafana scroll/interaction.
  const timer = window.setInterval(() => { if (allTime() && document.visibilityState !== 'hidden') open({ background: true }); }, 30_000);
  window.addEventListener('pagehide', () => window.clearInterval(timer), { once: true });
  document.addEventListener('visibilitychange', () => { if (allTime() && document.visibilityState === 'visible') open(); });
  open();
})();
