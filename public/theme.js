(() => {
  const preferenceKey = 'ulsatracker.theme';
  const allowed = new Set(['system', 'light', 'dark']);
  let preference = 'system';
  try {
    const saved = localStorage.getItem(preferenceKey);
    if (allowed.has(saved)) preference = saved;
  } catch { /* Theme selection also works without browser storage. */ }

  function apply(value) {
    if (value === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = value;
  }

  apply(preference);
  document.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('site-theme');
    if (!select) return;
    select.value = preference;
    select.addEventListener('change', () => {
      if (!allowed.has(select.value)) return;
      preference = select.value;
      apply(preference);
      try { localStorage.setItem(preferenceKey, preference); } catch { /* Optional persistence. */ }
    });
  });
})();
