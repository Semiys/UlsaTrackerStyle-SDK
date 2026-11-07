try { const value = localStorage.getItem('ulsatracker.theme'); if (value === 'light' || value === 'dark') document.documentElement.dataset.theme = value; } catch { /* Optional preference. */ }
