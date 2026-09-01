(function () {
  const S = (window.APP_SETTINGS = window.APP_SETTINGS || {});
  let enabled = S.secret_blur === true;

  function applyState() {
    const selectors = [
      '[data-secret]',
      'input[type="password"]',
      'input[type="token"]',
      '.secret-value',
      '[data-sensitive]',
    ];
    const els = document.querySelectorAll(selectors.join(','));
    els.forEach((el) => {
      el.classList.toggle('secret-blur', enabled);
    });
    const btn = document.getElementById('sbBtn');
    if (btn) {
      btn.classList.toggle('active', enabled);
      btn.title = enabled ? 'Secret blur ON - click to reveal' : 'Secret blur OFF - click to hide sensitive info';
    }
  }

  // Build floating toggle
  function init() {
    if (document.getElementById('sbBtn')) return;
    const btn = document.createElement('button');
    btn.id = 'sbBtn';
    btn.className = 'sb-toggle btn btn-sm';
    btn.innerHTML = '👁️ ' + (enabled ? 'Blur' : 'Reveal');
    btn.title = 'Toggle secret blur';
    btn.addEventListener('click', () => {
      enabled = !enabled;
      applyState();
      try {
        fetch('/api/customization/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (typeof vpToken === 'function' ? vpToken() : '') },
          body: JSON.stringify({ 'panel.secret_blur': enabled ? '1' : '0' }),
        }).catch(() => {});
      } catch (_) {}
      if (window.SFX) window.SFX.play('toggle');
    });
    document.body.appendChild(btn);
    applyState();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.SecretBlur = {
    isEnabled: () => enabled,
    set(v) { enabled = v; applyState(); },
  };
})();
