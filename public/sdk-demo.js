(() => {
  let tracker = null, ticker = null;
  const form = document.getElementById('sdk-demo-form');
  const click = document.getElementById('sdk-demo-click');
  const stop = document.getElementById('sdk-demo-stop');
  const message = document.getElementById('sdk-demo-status');
  const show = () => {
    if (!tracker) return;
    const s = tracker.getStatus();
    message.textContent = `Сбор: ${s.enabled ? 'включён' : 'выключен'}. В очереди: ${s.queued}. Подтверждено сервером: ${s.accepted}. Отклонено: ${s.rejected}. Статус: ${s.paused || s.lastStatus || 'готов к отправке'}.`;
  };
  form.addEventListener('submit', async event => {
    event.preventDefault(); tracker?.close(); clearInterval(ticker);
    try {
      const data = new FormData(form);
      tracker = UlsaTracker.create({ endpoint: data.get('endpoint'), ingestKey: String(data.get('ingestKey')).trim(),
        appVersion: 'sdk-demo', allowHttp: location.hostname === 'localhost' || location.hostname === '127.0.0.1' });
      tracker.setCollectionEnabled(true); tracker.screen('sdk_demo');
      click.disabled = false; stop.disabled = false; ticker = setInterval(show, 1000);
      await tracker.flush(); show();
    } catch { message.textContent = 'Проверьте адрес сервиса, ключ и HTTPS. Для localhost разрешён HTTP.'; }
  });
  click.addEventListener('click', async () => { tracker?.click('demo_button', 'sdk_demo'); await tracker?.flush(); show(); });
  stop.addEventListener('click', () => { tracker?.setCollectionEnabled(false); click.disabled = true; show(); });
})();
