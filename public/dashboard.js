(() => {
  const frame = document.getElementById('grafana-frame');
  if (!frame) return;
  const fullscreen = document.getElementById('open-grafana');
  const status = document.getElementById('grafana-status');
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  function open() {
    const theme = document.documentElement.dataset.theme ?? (media.matches ? 'dark' : 'light');
    const url = new URL(frame.dataset.dashboardUrl, window.location.origin);
    url.searchParams.set('theme', theme);
    url.searchParams.set('refresh', '10s');
    url.searchParams.set('from', 'now-6d/d');
    url.searchParams.set('to', 'now');
    fullscreen.href = url.href;
    url.searchParams.set('kiosk', 'tv');
    status.hidden = false;
    frame.src = url.href;
  }
  frame.addEventListener('load', () => { status.hidden = true; });
  document.getElementById('refresh-grafana').addEventListener('click', open);
  document.addEventListener('ulsa-theme-change', open);
  media.addEventListener('change', () => { if (!document.documentElement.dataset.theme) open(); });
  open();
})();
