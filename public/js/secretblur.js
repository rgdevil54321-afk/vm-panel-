(function () {
  const S = (window.APP_SETTINGS = window.APP_SETTINGS || {});
  let enabled = S.secret_blur === true;

  function targets() {
    const selectors = [
      '[data-secret]',
      'input[type="password"]',
      'input[type="token"]',
      '.secret-value',
      '[data-sensitive]',
    ];
    return document.querySelectorAll(selectors.join(','));
  }

  function applyState() {
    targets().forEach((el) => {
      el.classList.toggle('secret-blur', enabled);
    });
    document.querySelectorAll('[data-sb-toggle]').forEach((el) => {
      if (el.type === 'checkbox') el.checked = enabled;
      else el.classList.toggle('active', enabled);
    });
  }

  function persist() {
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
    // Re-apply to dynamically injected secrets (tmate commands, tokens, etc.)
    const mo = new MutationObserver(() => applyState());
    mo.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.SecretBlur = {
    isEnabled: () => enabled,
    set: (v) => { enabled = v; applyState(); },
    toggle,
  };
})();
