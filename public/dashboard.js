const $ = id => document.getElementById(id);
const number = value => new Intl.NumberFormat('ru-RU').format(value);
let readKey = '';
let request;
let generation = 0;
let loading = false;

function message(text, error = false) {
  $('message').textContent = text;
  $('message').classList.toggle('error', error);
}

function table(id, rows, label) {
  const body = $(id);
  body.replaceChildren();
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 2;
    td.textContent = 'Событий пока нет';
    tr.append(td); body.append(tr);
  }
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const text of [row[label], number(row.count)]) {
      const td = document.createElement('td'); td.textContent = text; tr.append(td);
    }
    body.append(tr);
  }
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
    $('empty-state').hidden = data.totals.events !== 0;
    chart(data.daily); table('events-table', data.byName, 'name'); table('screens-table', data.byScreen, 'screen');
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
