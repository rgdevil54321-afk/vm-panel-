(function () {
  if (window.__vpPaletteLoaded) return;
  window.__vpPaletteLoaded = true;

  let visible = false;
  let commands = [];
  let activeIdx = 0;

  function buildShell() {
    let shell = document.getElementById('cmdPalette');
    if (shell) return shell;
    shell = document.createElement('div');
    shell.id = 'cmdPalette';
    shell.className = 'cmd-palette-overlay';
    shell.style.display = 'none';
    shell.setAttribute('role', 'dialog');
    shell.innerHTML =
      '<div class="cmd-palette">' +
        '<div class="cmd-input-row">' +
          '<span class="cmd-icon">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' +
          '</span>' +
          '<input id="cmdSearch" class="cmd-input" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Type a command or search... (Esc to close)" />' +
          '<kbd class="cmd-kbd">ESC</kbd>' +
        '</div>' +
        '<div id="cmdList" class="cmd-list"></div>' +
        '<div class="cmd-footer">' +
          '<span><b>&uarr;&darr;</b> navigate</span>' +
          '<span><b>Enter</b> select</span>' +
          '<span><b>Ctrl+K</b> toggle</span>' +
        '</div>' +
      '</div>';
    document.body.appendChild(shell);

    const input = shell.querySelector('#cmdSearch');
    const list = shell.querySelector('#cmdList');
    const later = (fn) => (e) => { e.preventDefault(); fn(); };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { later(() => move(1))(e); }
      else if (e.key === 'ArrowUp') { later(() => move(-1))(e); }
      else if (e.key === 'Enter') { later(select)(e); }
      else if (e.key === 'Escape') { later(close)(e); }
      else {
        clearTimeout(input._t);
        input._t = setTimeout(render, 90);
        return;
      }
      render();
    });
    input.addEventListener('input', () => { clearTimeout(input._t); input._t = setTimeout(render, 90); });
    shell.addEventListener('mousedown', (e) => { if (e.target === shell) close(); });
    return shell;
  }

  function collectCommands() {
    const cmds = [];
    const seen = {};
    document.querySelectorAll('.sidebar a.nav-link').forEach((a) => {
      const label = (a.textContent || '').trim().replace(/\s+/g, ' ');
      const href = a.getAttribute('href');
      if (!label || !href || label === 'Logout' || seen[href]) return;
      seen[href] = true;
      const sectionEl = (a.previousElementSibling && a.previousElementSibling.classList && a.previousElementSibling.classList.contains('nav-section-title'))
        ? a.previousElementSibling : null;
      cmds.push({ title: label, href, section: sectionEl ? sectionEl.textContent.trim() : 'Navigate', group: 'Navigate' });
    });

    const vmId = window.__vpVmId;
    if (vmId) {
      [
        ['Start Server', `/api/vms/${vmId}/start`, 'Start'],
        ['Stop Server', `/api/vms/${vmId}/stop`, 'Start'],
        ['Restart Server', `/api/vms/${vmId}/restart`, 'Start'],
        ['Create Snapshot', `/api/servers/${vmId}/snapshots`, 'Start']
      ].forEach(([title, url, group]) => {
        cmds.push({ title, href: url, api: true, method: 'POST', confirm: true, group: 'Quick Actions' });
      });
    }

    const t = document.documentElement.getAttribute('data-theme') || 'dark';
    cmds.push({
      title: 'Cycle Theme',
      detail: 'Current: ' + t,
      group: 'Quick Actions',
      run: cycleTheme
    });

    if (!seen['/profile']) cmds.push({ title: 'Profile', href: '/profile', group: 'Navigate' });
    if (!seen['/settings']) cmds.push({ title: 'Settings', href: '/settings', group: 'Navigate' });

    return cmds;
  }

  function cycleTheme() {
    const order = ['dark', 'midnight', 'nord', 'aurora', 'daylight'];
    const cur = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = order[(order.indexOf(cur) + 1) % order.length];
    document.documentElement.setAttribute('data-theme', next);
    document.cookie = 'theme=' + next + ';path=/;max-age=31536000;SameSite=Lax';
    if (window.VP) VP.toast('Theme: ' + next, 'info');
    refresh();
  }

  function move(dir) {
    const len = commands.length;
    if (!len) return;
    activeIdx = (activeIdx + dir + len) % len;
  }

  function select() {
    const c = commands[activeIdx];
    if (!c) return;
    close();
    if (c.run) { c.run(); return; }
    if (c.api) {
      const doIt = () => {
        fetch(c.href, { method: c.method || 'POST', headers: { 'X-CSRF': vpToken() ? '1' : '', 'Authorization': 'Bearer ' + vpToken() } })
          .then((r) => r.json().catch(() => null))
          .then((d) => {
            const msg = (d && d.message) || c.title + ' done';
            if (window.VP) VP.toast(msg, d && d.ok ? 'success' : 'error');
            setTimeout(() => location.reload(), 800);
          })
          .catch((e) => { if (window.VP) VP.toast('Failed: ' + e.message, 'error'); });
      };
      if (c.confirm) {
        if (window.confirm('Run "' + c.title + '"?')) doIt();
      } else doIt();
      return;
    }
    location.href = c.href;
  }

  function render() {
    const input = document.getElementById('cmdSearch');
    const list = document.getElementById('cmdList');
    if (!input || !list) return;
    const q = input.value.trim().toLowerCase();
    const filtered = q
      ? commands.filter((c) => (c.title + ' ' + (c.detail || '') + ' ' + (c.section || '')).toLowerCase().includes(q))
      : commands;
    if (activeIdx >= filtered.length) activeIdx = 0;
    if (!filtered.length) {
      list.innerHTML = '<div class="cmd-empty">No matching commands</div>';
      return;
    }
    let html = '';
    let lastGroup = '';
    filtered.forEach((c, i) => {
      if (c.group !== lastGroup) {
        html += '<div class="cmd-group">' + c.group + '</div>';
        lastGroup = c.group;
      }
      html += '<button type="button" class="cmd-item' + (i === activeIdx ? ' active' : '') + '" data-idx="' + i + '">' +
        '<span class="cmd-title">' + escapeHtml(c.title) + (c.detail ? '<span class="cmd-detail">' + escapeHtml(c.detail) + '</span>' : '') + '</span>' +
        (c.href ? '<span class="cmd-arrow">&rarr;</span>' : '') +
      '</button>';
    });
    list.innerHTML = html;
    list.querySelectorAll('.cmd-item').forEach((el) => {
      el.addEventListener('mousemove', () => {
        const idx = parseInt(el.getAttribute('data-idx'), 10);
        if (idx !== activeIdx) { activeIdx = idx; render(); }
      });
      el.addEventListener('click', select);
    });
    const active = list.querySelector('.cmd-item.active');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function refresh() {
    commands = collectCommands();
    if (activeIdx >= commands.length) activeIdx = 0;
    if (visible) render();
  }

  function open() {
    const shell = buildShell();
    visible = true;
    shell.style.display = 'flex';
    refresh();
    const input = document.getElementById('cmdSearch');
    input.value = '';
    activeIdx = 0;
    setTimeout(() => { input.focus(); render(); }, 30);
  }

  function close() {
    const shell = document.getElementById('cmdPalette');
    if (!shell) return;
    visible = false;
    shell.style.display = 'none';
  }

  function toggle() { visible ? close() : open(); }

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      toggle();
    }
  });

  function exposeVmId() {
    const m = location.pathname.match(/^\/servers\/(\d+)\//);
    if (m) window.__vpVmId = m[1];
  }
  exposeVmId();
  window.addEventListener('popstate', () => { exposeVmId(); refresh(); });

  window.VP_PALETTE = { open, close, toggle, refresh };
})();