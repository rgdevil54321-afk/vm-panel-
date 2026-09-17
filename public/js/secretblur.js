(function () {
  const S = (window.APP_SETTINGS = window.APP_SETTINGS || {});
  const STORAGE_KEY = 'vp_secret_blur';

  // Resolve initial state: server-sent value > localStorage > default false
  let enabled = S.secret_blur === true;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === '1' || stored === 'true') enabled = true;
    else if (stored === '0' || stored === 'false') enabled = false;
    // If server sent a value, trust it on first load and persist
    if (typeof S.secret_blur === 'boolean') {
      localStorage.setItem(STORAGE_KEY, S.secret_blur ? '1' : '0');
    }
  } catch (_) {}

  function targets() {
    return document.querySelectorAll(
      '[data-secret], input[type="password"], input[type="token"], .secret-value, [data-sensitive]'
    );
  }

  function applyState() {
    targets().forEach((el) => el.classList.toggle('secret-blur', enabled));
    document.querySelectorAll('[data-sb-toggle]').forEach((el) => {
      if (el.type === 'checkbox') el.checked = enabled;
      else el.classList.toggle('active', enabled);
    });
  }

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0'); } catch (_) {}
    try {
      fetch('/api/user/secret-blur', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': (typeof vpToken === 'function' && vpToken()) ? 'Bearer ' + vpToken() : undefined,
        },
        body: JSON.stringify({ enabled }),
      }).catch(() => {});
    } catch (_) {}
  }

  function toggle(next) {
    enabled = typeof next === 'boolean' ? next : !enabled;
    applyState();
    persist();
    S.secret_blur = enabled;
    if (window.SFX) window.SFX.play('toggle');
    if (window.VP && VP.toast) {
      VP.toast(enabled ? 'Secret blur enabled' : 'Secret blur disabled', 'success');
    }
  }

  function init() {
    document.querySelectorAll('[data-sb-toggle]').forEach((el) => {
      if (el.type === 'checkbox') {
        el.checked = enabled;
        el.addEventListener('change', () => toggle(el.checked));
      } else {
        el.classList.toggle('active', enabled);
        el.addEventListener('click', () => toggle());
      }
    });
    applyState();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  // Re-apply after load for dynamically injected elements
  window.addEventListener('load', () => {
    applyState();
    // Re-init toggles if they were injected after DOMContentLoaded
    document.querySelectorAll('[data-sb-toggle]').forEach((el) => {
      if (el.dataset._sbBound) return;
      el.dataset._sbBound = '1';
      if (el.type === 'checkbox') {
        el.checked = enabled;
        el.addEventListener('change', () => toggle(el.checked));
      } else {
        el.classList.toggle('active', enabled);
        el.addEventListener('click', () => toggle());
      }
    });
  });
  // MutationObserver as final fallback
  try {
    const mo = new MutationObserver(() => applyState());
    mo.observe(document.body, { childList: true, subtree: true });
  } catch (_) {}

  window.SecretBlur = {
    isEnabled: () => enabled,
    set: (v) => { enabled = v; applyState(); persist(); },
    toggle,
  };
})();
