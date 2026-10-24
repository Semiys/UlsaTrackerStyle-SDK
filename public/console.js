for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const source = document.getElementById(button.dataset.copy);
    if (!source) return;
    try { await navigator.clipboard.writeText(source.textContent); button.textContent = 'Скопировано'; }
    catch { button.textContent = 'Выделите и скопируйте текст вручную'; }
  });
}
