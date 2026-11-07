import { PRESETS, resolveRange, rangeLabel, formatLocal, parseLocal, validateRange, dayStart, addDays, monthStart, addMonth, monthCells } from './date-range.js';

export function mountDateRangePicker({ initial, onApply }) {
  const dialog = document.getElementById('range-dialog');
  const trigger = document.getElementById('range-trigger');
  if (!dialog || !trigger) return;
  const form = document.getElementById('range-form');
  const fromInput = document.getElementById('range-from'), toInput = document.getElementById('range-to');
  const calendars = document.getElementById('range-calendars'), presets = document.getElementById('range-presets');
  const hint = document.getElementById('range-selection-hint'), error = document.getElementById('range-error');
  const previous = document.getElementById('range-previous'), next = document.getElementById('range-next');
  const monthName = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' });
  const dayName = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long' });
  const mobile = window.matchMedia('(max-width: 720px)');
  let selection = initial, draft = initial, dirty = false, anchor = null, viewMonth, focusDay;
  const allTime = () => !dirty && draft.kind === 'relative' && draft.id === 'all';
  const label = () => { document.getElementById('range-label').textContent = rangeLabel(selection); };
  function showError(message = '') {
    error.textContent = message; error.hidden = !message;
    for (const input of [fromInput, toInput]) input.setAttribute('aria-invalid', message ? 'true' : 'false');
  }
  function preferredMonth(range = resolveRange(draft)) {
    return mobile.matches || monthStart(range.from) !== monthStart(range.to) ? monthStart(range.from) : addMonth(monthStart(range.to), -1);
  }
  function fillInputs() {
    const range = resolveRange(draft);
    fromInput.disabled = toInput.disabled = allTime();
    fromInput.value = allTime() ? 'С первого события' : formatLocal(range.from);
    toInput.value = allTime() ? 'Текущий момент' : formatLocal(range.to);
  }
  function render() {
    const range = dirty ? { from: parseLocal(fromInput.value), to: parseLocal(toInput.value) } : resolveRange(draft);
    const start = allTime() ? NaN : dayStart(range.from), end = allTime() ? NaN : dayStart(range.to), today = dayStart(Date.now());
    calendars.replaceChildren();
    for (let month = 0; month < 2; month++) {
      const at = addMonth(viewMonth, month), section = document.createElement('section');
      section.className = 'range-month';
      const title = document.createElement('h3'); title.textContent = monthName.format(at).replace(/\s*г\.$/, ''); section.append(title);
      const weekdays = document.createElement('div'); weekdays.className = 'range-weekdays'; weekdays.setAttribute('aria-hidden', 'true');
      for (const name of ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']) { const span = document.createElement('span'); span.textContent = name; weekdays.append(span); }
      section.append(weekdays);
      const grid = document.createElement('div'); grid.className = 'range-grid'; grid.setAttribute('role', 'group'); grid.setAttribute('aria-label', monthName.format(at));
      const stop = monthStart(focusDay ?? start) === at ? (focusDay ?? start) : at;
      for (const value of monthCells(at)) {
        if (value === null) { const empty = document.createElement('span'); empty.setAttribute('aria-hidden', 'true'); grid.append(empty); continue; }
        const button = document.createElement('button'); button.type = 'button'; button.className = 'range-day';
        button.dataset.day = String(value); button.textContent = String(new Date(value).getDate());
        button.disabled = value < 0 || value > today; button.tabIndex = value === stop && !button.disabled ? 0 : -1;
        const isStart = value === start, isEnd = value === end;
        button.classList.toggle('in-range', value >= start && value <= end);
        button.classList.toggle('range-start', isStart); button.classList.toggle('range-end', isEnd); button.classList.toggle('today', value === today);
        button.setAttribute('aria-label', dayName.format(value) + (isStart ? ', начало периода' : isEnd ? ', окончание периода' : ''));
        button.setAttribute('aria-pressed', String(isStart || isEnd));
        grid.append(button);
      }
      section.append(grid); calendars.append(section);
    }
    previous.disabled = viewMonth <= 0; next.disabled = viewMonth >= monthStart(Date.now());
    hint.textContent = allTime() ? 'Все сохранённые события приложения' : anchor === null ? 'Выберите начало и конец периода' : 'Теперь выберите окончание периода';
    document.getElementById('range-limit-hint').textContent = allTime() ? 'Вся доступная история, без ограничения в 366 дней.' : 'Можно ввести даты вручную. Максимум — 366 дней.';
    for (const button of presets.querySelectorAll('button')) button.setAttribute('aria-pressed', String(!dirty && draft.kind === 'relative' && draft.id === button.dataset.period));
  }
  function close() { dialog.close(); trigger.setAttribute('aria-expanded', 'false'); trigger.focus(); }
  for (const item of PRESETS) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'range-preset'; button.textContent = item.label; button.dataset.period = item.id;
    button.addEventListener('click', () => { draft = { kind: 'relative', id: item.id }; dirty = false; anchor = null; focusDay = null; viewMonth = preferredMonth(); showError(); fillInputs(); render(); });
    presets.append(button);
  }
  trigger.addEventListener('click', () => {
    draft = { ...selection }; dirty = false; anchor = null; focusDay = null; viewMonth = preferredMonth();
    showError(); fillInputs(); render(); dialog.showModal(); trigger.setAttribute('aria-expanded', 'true'); fromInput.focus();
  });
  for (const input of [fromInput, toInput]) input.addEventListener('input', () => {
    dirty = true; anchor = null; showError();
    const range = { from: parseLocal(fromInput.value), to: parseLocal(toInput.value) };
    if (Number.isFinite(range.from) && Number.isFinite(range.to)) { viewMonth = preferredMonth(range); focusDay = null; }
    render();
  });
  calendars.addEventListener('click', event => {
    const button = event.target.closest('[data-day]'); if (!button || button.disabled) return;
    const value = Number(button.dataset.day); focusDay = value;
    if (anchor === null) { anchor = value; draft = { kind: 'absolute', from: value, to: Math.min(addDays(value, 1) - 1, Date.now()) }; }
    else { draft = { kind: 'absolute', from: Math.min(anchor, value), to: Math.min(addDays(Math.max(anchor, value), 1) - 1, Date.now()) }; anchor = null; }
    dirty = false; showError(); fillInputs(); render();
    calendars.querySelector(`[data-day="${value}"]`)?.focus();
  });
  calendars.addEventListener('keydown', event => {
    const button = event.target.closest('[data-day]'); if (!button) return;
    const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (!Object.hasOwn(offsets, event.key)) return;
    const value = addDays(Number(button.dataset.day), offsets[event.key]);
    if (value < 0 || value > dayStart(Date.now())) return;
    event.preventDefault(); focusDay = value;
    if (value < viewMonth || value >= addMonth(viewMonth, mobile.matches ? 1 : 2)) viewMonth = monthStart(value);
    render(); calendars.querySelector(`[data-day="${value}"]`)?.focus();
  });
  for (const [button, offset] of [[previous, -1], [next, 1]]) button.addEventListener('click', () => { viewMonth = addMonth(viewMonth, offset); focusDay = null; render(); });
  document.getElementById('range-cancel').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const candidate = dirty ? { kind: 'absolute', from: parseLocal(fromInput.value), to: parseLocal(toInput.value) } : draft;
    const range = resolveRange(candidate), message = candidate.kind === 'relative' && candidate.id === 'all' ? '' : validateRange(range.from, range.to);
    if (message) { showError(message); return; }
    selection = { ...candidate }; label(); onApply(selection); close();
  });
  mobile.addEventListener('change', () => { if (dialog.open) { viewMonth = preferredMonth(); focusDay = null; render(); } });
  label();
}
