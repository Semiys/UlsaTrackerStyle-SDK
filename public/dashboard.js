(() => {
  const frame = document.getElementById('grafana-frame');
  if (!frame) return;
  const fullscreen = document.getElementById('open-grafana');
  const status = document.getElementById('grafana-status');
  const periods = [...document.querySelectorAll('[data-analytics-days]')];
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let days = 7;
  const selected = new URL(window.location.href).searchParams.get('days');
  if (['7', '30', '90'].includes(selected)) days = Number(selected);
  function open() {
    const theme = document.documentElement.dataset.theme ?? (media.matches ? 'dark' : 'light');
    const url = new URL(frame.dataset.dashboardUrl, window.location.origin);
    url.searchParams.set('theme', theme);
    url.searchParams.set('refresh', '30s');
    url.searchParams.set('from', `now-${days - 1}d/d`);
    url.searchParams.set('to', 'now');
    periods.forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.analyticsDays) === days)));
    const comparisonNote = document.getElementById('comparison-period-note');
    if (comparisonNote) comparisonNote.textContent = `Сравнение с предыдущими ${days} календарными днями; последний день — до того же времени UTC. Карта активности суммирует события за выбранный период.`;
    fullscreen.href = url.href;
    url.searchParams.set('kiosk', '1');
    status.hidden = false;
    frame.src = url.href;
  }
  periods.forEach(button => button.addEventListener('click', () => {
    days = Number(button.dataset.analyticsDays);
    const page = new URL(window.location.href);
    page.searchParams.set('days', String(days));
    window.history.replaceState(null, '', page);
    open();
  }));
  frame.addEventListener('load', () => { status.hidden = true; });
  document.getElementById('refresh-grafana').addEventListener('click', open);
  document.addEventListener('ulsa-theme-change', open);
  media.addEventListener('change', () => { if (!document.documentElement.dataset.theme) open(); });
  open();
})();
