document.addEventListener('DOMContentLoaded', () => {
  let opened = null;

  document.querySelectorAll('select:not([multiple])').forEach(select => {
    if (select.size > 1) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'select-control';
    select.before(wrapper);
    wrapper.append(select);

    const button = document.createElement('button');
    button.type = 'button';
    button.id = `${select.id}-button`;
    button.className = 'select-trigger';
    button.setAttribute('role', 'combobox');
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    const value = document.createElement('span');
    value.className = 'select-value';
    const chevron = document.createElement('span');
    chevron.className = 'select-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    button.append(value, chevron);

    const menu = document.createElement('div');
    menu.id = `${select.id}-options`;
    menu.className = 'select-menu';
    menu.setAttribute('role', 'listbox');
    menu.hidden = true;
    button.setAttribute('aria-controls', menu.id);

    const labels = Array.from(select.labels);
    for (const [index, label] of labels.entries()) {
      label.id ||= `${select.id}-label-${index}`;
      label.htmlFor = button.id;
    }
    if (labels.length) {
      const ids = labels.map(label => label.id).join(' ');
      button.setAttribute('aria-labelledby', ids);
      menu.setAttribute('aria-labelledby', ids);
    } else {
      const label = select.getAttribute('aria-label') ?? select.name ?? select.id;
      button.setAttribute('aria-label', label);
      menu.setAttribute('aria-label', label);
    }

    let highlighted = select.selectedIndex;
    const items = Array.from(select.options, (option, index) => {
      const item = document.createElement('div');
      item.id = `${select.id}-option-${index}`;
      item.className = 'select-option';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-disabled', String(option.disabled));
      const text = document.createElement('span');
      text.textContent = option.label;
      const check = document.createElement('span');
      check.className = 'select-check';
      check.textContent = '✓';
      check.setAttribute('aria-hidden', 'true');
      item.append(text, check);
      item.addEventListener('pointermove', () => { if (!option.disabled) highlight(index); });
      item.addEventListener('pointerdown', event => event.preventDefault());
      item.addEventListener('click', () => { if (!option.disabled) choose(index); });
      menu.append(item);
      return item;
    });

    function highlight(index) {
      highlighted = index;
      items.forEach((item, position) => { item.dataset.highlighted = String(position === index); });
      if (items[index]) button.setAttribute('aria-activedescendant', items[index].id);
    }

    function close() {
      menu.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      button.removeAttribute('aria-activedescendant');
      if (opened?.button === button) opened = null;
    }

    function sync() {
      value.textContent = select.selectedOptions[0]?.label ?? 'Выберите';
      button.disabled = select.disabled;
      items.forEach((item, index) => item.setAttribute('aria-selected', String(index === select.selectedIndex)));
      if (select.disabled) close();
    }

    function choose(index) {
      const changed = select.selectedIndex !== index;
      select.selectedIndex = index;
      close();
      sync();
      button.focus();
      if (changed) {
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    function open() {
      if (select.disabled || !items.length) return;
      opened?.close();
      sync();
      const rect = button.getBoundingClientRect();
      const width = Math.min(Math.max(rect.width, 180), window.innerWidth - 32);
      const below = window.innerHeight - rect.bottom - 16;
      const above = rect.top - 16;
      const upwards = below < Math.min(240, items.length * 44 + 12) && above > below;
      menu.style.width = `${width}px`;
      menu.style.left = `${Math.max(16, Math.min(rect.left, window.innerWidth - width - 16))}px`;
      menu.style.maxHeight = `${Math.max(44, Math.min(260, upwards ? above - 8 : below - 8))}px`;
      menu.style.top = upwards ? 'auto' : `${rect.bottom + 8}px`;
      menu.style.bottom = upwards ? `${window.innerHeight - rect.top + 8}px` : 'auto';
      menu.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      opened = { button, menu, close };
      highlight(select.selectedIndex >= 0 ? select.selectedIndex : 0);
      items[highlighted]?.scrollIntoView({ block: 'nearest' });
    }

    button.addEventListener('click', () => { if (menu.hidden) open(); else close(); });
    button.addEventListener('keydown', event => {
      const direction = { ArrowDown: 1, ArrowUp: -1 }[event.key];
      if (direction || event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        if (menu.hidden) { open(); if (direction) return; }
        const enabled = items.map((_, index) => index).filter(index => !select.options[index].disabled);
        if (!enabled.length) return;
        const position = enabled.indexOf(highlighted);
        const index = event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled.at(-1)
          : enabled[Math.max(0, Math.min(enabled.length - 1, position + direction))];
        highlight(index);
        items[index].scrollIntoView({ block: 'nearest' });
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (menu.hidden) open(); else choose(highlighted);
      } else if (event.key === 'Escape' && !menu.hidden) {
        event.preventDefault();
        close();
      } else if (event.key === 'Tab' && !menu.hidden) {
        choose(highlighted);
      }
    });
    button.addEventListener('blur', close);
    select.addEventListener('change', sync);
    select.form?.addEventListener('reset', () => queueMicrotask(sync));
    new MutationObserver(sync).observe(select, { attributes: true, attributeFilter: ['disabled'] });
    wrapper.append(button, menu);
    select.classList.add('select-native');
    select.setAttribute('aria-hidden', 'true');
    select.tabIndex = -1;
    sync();
  });

  document.addEventListener('pointerdown', event => {
    if (opened && !opened.button.contains(event.target) && !opened.menu.contains(event.target)) opened.close();
  });
  window.addEventListener('resize', () => opened?.close());
  document.addEventListener('scroll', event => {
    if (opened && !opened.menu.contains(event.target)) opened.close();
  }, true);
});
