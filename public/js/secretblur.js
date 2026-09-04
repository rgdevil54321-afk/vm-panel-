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
    // Sync any toggle rendered by the settings page (no floating button)
    document.querySelectorAll('[data-sb-toggle]').forEach((el) => {
      if (el.type === 'checkbox') el.checked = enabled;
      else el.classList.toggle('active', enabled);
    });
  }

  function persist() {
    try {
      fetch('/api/customization/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (typeof vpToken === 'function' ? vpToken() : ''),
        },
        body: JSON.stringify({ 'panel.secret_blur': enabled ? '1' : '0' }),
      }).catch(() => {});
    } catch (_) {}
  }

  function toggle(next) {
    enabled = typeof next === 'boolean' ? next : !enabled;
    applyState();
    persist();
    if (window.SFX) window.SFX.play('toggle');
    if (window.VP && VP.toast) {
      VP.toast(enabled ? 'Secret blur enabled' : 'Secret blur disabled', 'success');
      S.secret_blur = enabled;
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

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.SecretBlur = {
    isEnabled: () => enabled,
    set: (v) => { enabled = v; applyState(); },
    toggle,
  };
})();
