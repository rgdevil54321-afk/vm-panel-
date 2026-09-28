// Merge rather than replace: vp-modal.js may have already attached
// window.VP.modal. Reassigning here would silently drop it.
window.VP = Object.assign(window.VP || {}, (() => {
  const state = { socket: null };

  function toast(msg, type = 'info') {
    let wrap = document.getElementById('toasts');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'toasts';
      document.body.appendChild(wrap);
    }
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    wrap.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, 3200);
  }

  async function api(url, opts = {}) {
    const o = { ...opts, headers: { ...(opts.headers || {}) } };
    if (o.body && typeof o.body !== 'string') {
      o.headers['Content-Type'] = 'application/json';
      o.body = JSON.stringify(o.body);
    }
    const r = await fetch(url, o);
    let data = null;
    try { data = await r.json(); } catch (_) { data = null; }
    if (!r.ok) {
      const err = new Error((data && data.error) || `Request failed (${r.status})`);
      err.data = data;
      throw err;
    }
    return data;
  }

  function qs(sel, ctx) { return (ctx || document).querySelector(sel); }
  function qsa(sel, ctx) { return Array.from((ctx || document).querySelectorAll(sel)); }

  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (k === 'class') e.className = v;
      else e.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }

  function fmtBytes(n) {
    if (n === 0) return '0 B';
    if (!n && n !== 0) return '—';
    let num = typeof n === 'string' ? parseFloat(n) : n;
    if (isNaN(num)) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (num >= 1024 && i < units.length - 1) { num /= 1024; i++; }
    return `${num.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function fmtDate(s) {
    if (!s) return '-';
    return new Date(s).toLocaleString();
  }

  /**
   * Confirmation dialog. Resolves true when confirmed, false when cancelled or
   * dismissed (Cancel button, Escape, or backdrop click).
   *
   * Contract note: resolves exactly once and never rejects. Callers use
   * `if (await VP.confirmDialog(...))`, so a rejection here would silently
   * abort destructive actions across a 44-call-site surface.
   */
  function confirmDialog(message, { danger = true, title = 'Are you sure?', html = false, okText = 'Confirm', cancelText = 'Cancel', width = null } = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const overlay = el('div', { class: 'vp-modal' });

      const panel = el('div', { class: 'vp-modal__panel', 'data-vp-panel': '' });
      if (width) panel.style.maxWidth = width;

      panel.appendChild(el('div', { class: 'vp-modal__head' },
        el('h3', { class: 'vp-modal__title' }, title),
        el('button', {
          class: 'vp-modal__x',
          type: 'button',
          'data-vp-dismiss': '',
          'aria-label': 'Close dialog',
          html: '&times;'
        })
      ));

      const body = el('div', { class: 'vp-modal__body' });
      if (html) {
        const wrap = document.createElement('div');
        wrap.innerHTML = message;
        body.appendChild(wrap);
      } else {
        body.appendChild(el('p', { style: 'margin:0' }, message));
      }
      panel.appendChild(body);

      const cancel = el('button', { class: 'btn', type: 'button', 'data-vp-dismiss': '' }, cancelText);
      const ok = el('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'button', 'data-vp-dismiss': 'confirm', 'data-vp-autofocus': '' }, okText);

      panel.appendChild(el('div', { class: 'vp-modal__foot' }, cancel, ok));

      // The controller dispatches vp:close with a reason, so a single handler
      // covers the buttons, Escape and backdrop dismissal.
      overlay.addEventListener('vp:close', (e) => {
        // The overlay is created per call, so it must be torn out of the DOM.
        // Without this, every confirmation leaks a detached-looking node.
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        done(e && e.detail && e.detail.reason === 'confirm');
      });

      overlay.appendChild(panel);
      document.body.appendChild(overlay);
      VP.modal.open(overlay);
    });
  }

  function hide(sel) { qsa(sel).forEach((x) => { x.style.display = 'none'; }); }
  function show(sel) { qsa(sel).forEach((x) => { x.style.display = ''; }); }

  document.addEventListener('DOMContentLoaded', () => {
    qsa('[data-confirm]').forEach((b) => {
      b.addEventListener('click', async (e) => {
        e.preventDefault();
        const ok2 = await confirmDialog(b.dataset.confirmMsg || 'This action cannot be undone.');
        if (ok2) {
          if (b.dataset.form) {
            document.getElementById(b.dataset.form).submit();
          } else {
            window.location = b.href;
          }
        }
      });
    });

    // ---- mobile sidebar drawer (backdrop + Esc + close on nav) ----
    const sidebar = qs('.sidebar');
    const burger = qs('#hamburger');
    if (sidebar && burger) {
      let backdrop = qs('.sidebar-backdrop');
      if (!backdrop) {
        backdrop = el('div', { class: 'sidebar-backdrop' });
        document.body.appendChild(backdrop);
      }
      const closeDrawer = () => { sidebar.classList.remove('open'); backdrop.classList.remove('show'); burger.setAttribute('aria-expanded', 'false'); };
      burger.addEventListener('click', () => {
        const open = sidebar.classList.toggle('open');
        backdrop.classList.toggle('show', open);
        burger.setAttribute('aria-expanded', String(open));
      });
      backdrop.addEventListener('click', closeDrawer);
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
      sidebar.addEventListener('click', (e) => { if (e.target.closest('a')) closeDrawer(); });
    }

    // ---- topbar user dropdown ----
    const menu = qs('#userMenu');
    if (menu) {
      const btn = qs('#userMenuBtn', menu);
      const close = () => { menu.classList.remove('open'); if (btn) btn.setAttribute('aria-expanded', 'false'); };
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = menu.classList.toggle('open');
        btn.setAttribute('aria-expanded', String(open));
      });
      document.addEventListener('click', (e) => { if (!menu.contains(e.target)) close(); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    }
  });

  return { toast, api, qs, qsa, el, fmtBytes, fmtDate, confirmDialog, hide, show, state };
})());

(function () {
  const html = document.documentElement;
  if (!html.hasAttribute('data-theme')) {
    const m = /(?:^|;\s*)theme=([^;]+)/.exec(document.cookie);
    if (m) html.setAttribute('data-theme', m[1]);
  }
})();
