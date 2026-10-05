const $ = id => document.getElementById(id);
const number = value => new Intl.NumberFormat('ru-RU').format(value);
let readKey = '';
let request;
let generation = 0;
let loading = false;
const labels = {
  events: new Map([['screen_view', 'Открытие экрана'], ['button_click', 'Нажатие кнопки'], ['action_success', 'Успешное действие']]),
  screens: new Map([['collection', 'Коллекция'], ['stats', 'Статистика'], ['profile', 'Профиль'], ['add_model', 'Добавление модели'], ['edit_model', 'Редактирование модели']]),
  buttons: new Map([['add_model', 'Добавить модель'], ['open_filters', 'Открыть фильтры'], ['save_model', 'Сохранить модель']]),
  actions: new Map([['model_saved', 'Модель добавлена'], ['model_updated', 'Модель изменена']]),
};

function message(text, error = false) {
  $('message').textContent = text;
  $('message').classList.toggle('error', error);
}

function table(id, rows, columns) {
  const body = $(id);
  body.replaceChildren();
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = columns.length;
    td.textContent = 'Событий пока нет';
    tr.append(td); body.append(tr);
  }
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const { key, names } of columns) {
      const td = document.createElement('td');
      const value = row[key];
      if (key === 'count') td.textContent = number(value);
      else if (value === null) td.textContent = 'Не указано';
      else {
        td.textContent = names?.get(value) ?? value;
        if (names?.has(value)) {
          const code = document.createElement('code');
          code.className = 'identifier'; code.textContent = value; td.append(code);
        }
      }
      tr.append(td);
    }
    body.append(tr);
  }
}

function limitNote(id, truncated, limit) {
  $(id).hidden = !truncated;
  $(id).textContent = truncated ? `Показаны первые ${limit} строк по количеству. Общие счётчики и график учитывают все события.` : '';
}

function chart(days) {
  const svg = $('daily-chart');
  svg.replaceChildren();
  const max = Math.max(1, ...days.map(day => day.count));
  const width = 840 / days.length;
  const element = (name, attributes, text) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  };
  days.forEach((day, index) => {
    const height = day.count ? 160 * day.count / max : 1;
    const x = 30 + width * index;
    const rect = element('rect', { x: x + 4, y: 185 - height, width: Math.max(2, width - 8), height, rx: 3, class: day.count ? 'chart-bar' : 'chart-zero' });
    rect.append(element('title', {}, `${day.date}: ${number(day.count)} событий`));
    svg.append(rect);
    if (days.length <= 7 || index % 5 === 0 || index === days.length - 1) {
      svg.append(element('text', { x: x + width / 2, y: 212, 'text-anchor': 'middle', class: 'chart-label' }, day.date.slice(5).split('-').reverse().join('.')));
    }
  });
  svg.setAttribute('aria-label', days.map(day => `${day.date}: ${day.count}`).join('; '));
}

function busy(value) {
  loading = value;
  for (const id of ['open-button', 'refresh-button', 'days']) $(id).disabled = value;
}

function logout() {
  generation++;
  request?.abort();
  readKey = ''; $('read-key').value = '';
  $('stats-panel').hidden = true;
  $('access-panel').hidden = false;
  busy(false);
}

async function load() {
  if (loading || !readKey) return;
  const current = ++generation;
  request = new AbortController();
  busy(true); message('Обновляем статистику…');
  try {
    const response = await fetch(`/api/v1/stats?days=${$('days').value}`, { headers: { Authorization: `Bearer ${readKey}` }, signal: request.signal, cache: 'no-store' });
    const data = await response.json();
    if (current !== generation) return;
    if (!response.ok) {
      if (response.status === 401) logout();
      throw new Error(data.error?.message ?? 'Не удалось получить статистику.');
    }
    $('project-title').textContent = data.project.name;
    $('range-label').textContent = `Последние ${data.days} дней · UTC`;
    $('events-count').textContent = number(data.totals.events);
    $('sessions-count').textContent = number(data.totals.sessions);
    $('views-count').textContent = number(data.totals.screenViews);
    $('clicks-count').textContent = number(data.totals.buttonClicks);
    $('successes-count').textContent = number(data.totals.successfulActions);
    $('empty-state').hidden = data.totals.events !== 0;
    chart(data.daily);
    table('events-table', data.byName, [{ key: 'name', names: labels.events }, { key: 'count' }]);
    table('screens-table', data.byScreenViews, [{ key: 'screen', names: labels.screens }, { key: 'count' }]);
    table('buttons-table', data.byButton, [{ key: 'button', names: labels.buttons }, { key: 'screen', names: labels.screens }, { key: 'count' }]);
    table('actions-table', data.byAction, [{ key: 'action', names: labels.actions }, { key: 'screen', names: labels.screens }, { key: 'count' }]);
    for (const [id, key] of [['events-limit', 'byName'], ['screens-limit', 'byScreenViews'], ['buttons-limit', 'byButton'], ['actions-limit', 'byAction']]) {
      limitNote(id, data.truncated[key], data.breakdownLimit);
    }
    $('read-key').value = '';
    $('access-panel').hidden = true;
    $('stats-panel').hidden = false;
    message(`Обновлено: ${new Date().toLocaleTimeString('ru-RU')}`);
  } catch (error) {
    if (error.name !== 'AbortError' && (current === generation || !readKey)) message(error.message, true);
  } finally { if (current === generation || !readKey) busy(false); }
}

$('access-form').addEventListener('submit', e => { e.preventDefault(); readKey = $('read-key').value.trim(); load(); });
$('refresh-button').addEventListener('click', load);
$('days').addEventListener('change', load);
$('logout-button').addEventListener('click', () => { logout(); message('Доступ закрыт.'); });
