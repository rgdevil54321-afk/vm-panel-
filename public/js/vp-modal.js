/**
 * vp-modal.js — shared modal controller for the Venlix panel.
 *
 * Replaces per-template hand-rolled `el.style.display = 'block' | 'grid'` modals
 * with one consistent implementation that every modal in the panel shares.
 *
 * Provides, for every modal in the panel:
 *   - Escape closes the topmost modal
 *   - backdrop click closes
 *   - body scroll lock (nesting-safe, scrollbar-width compensated)
 *   - focus moved into the dialog on open and restored to the trigger on close
 *   - Tab focus trap inside the dialog
 *   - role="dialog" / aria-modal / aria-labelledby wiring
 *   - a deterministic z-index ladder instead of hand-assigned 200/210/300
 *
 * No build step, no dependencies. Plain browser JS.
 */
(function (global) {
  'use strict';

  var FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
    '[contenteditable="true"]'
  ].join(',');

  var BASE_Z = 1000;
  var Z_STEP = 10;
  var CLOSEABLE = '[data-vp-dismiss]';

  // Open modals, oldest first. The last entry is the topmost.
  var stack = [];

  var lockCount = 0;
  var savedOverflow = '';
  var savedPaddingRight = '';

  function isOpen(overlay) {
    return !!overlay && stack.indexOf(overlay) !== -1;
  }

  function openCount() {
    return stack.length;
  }

  // ---- scroll lock --------------------------------------------------------
  // Count-based so nested modals (confirm-on-top-of-modal) do not unlock early.
  function lockScroll() {
    lockCount++;
    if (lockCount > 1) return;
    savedOverflow = document.body.style.overflow;
    savedPaddingRight = document.body.style.paddingRight;
    // Compensate for the vanishing scrollbar so the page does not jump.
    var gap = global.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (gap > 0) document.body.style.paddingRight = gap + 'px';
  }

  function unlockScroll() {
    if (lockCount === 0) return;
    lockCount--;
    if (lockCount > 0) return;
    document.body.style.overflow = savedOverflow;
    document.body.style.paddingRight = savedPaddingRight;
  }

  // ---- focus --------------------------------------------------------------
  function focusablesIn(root) {
    var nodes = root.querySelectorAll(FOCUSABLE);
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      // getClientRects() is more reliable than offsetParent, which is null for
      // anything inside a position:fixed subtree in some engines.
      if (nodes[i].getClientRects().length > 0) out.push(nodes[i]);
    }
    return out;
  }

  function focusInitial(overlay) {
    var panel = overlay.querySelector('[data-vp-panel]') || overlay;
    var preferred = overlay.querySelector('[data-vp-autofocus]');
    if (preferred) {
      preferred.focus();
      return;
    }
    var items = focusablesIn(panel);
    if (items.length) items[0].focus();
  }

  function trapTab(overlay, e) {
    var panel = overlay.querySelector('[data-vp-panel]') || overlay;
    var items = focusablesIn(panel);
    if (!items.length) {
      e.preventDefault();
      return;
    }
    var first = items[0];
    var last = items[items.length - 1];
    var active = document.activeElement;
    if (e.shiftKey && (active === first || !panel.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // ---- open / close -------------------------------------------------------
  function applyA11y(overlay) {
    if (!overlay.getAttribute('role')) overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.removeAttribute('aria-hidden');

    var panel = overlay.querySelector('[data-vp-panel]');
    if (panel && !panel.hasAttribute('aria-labelledby')) {
      var heading = panel.querySelector('h1, h2, h3, h4, [data-vp-title]');
      if (heading) {
        if (!heading.id) heading.id = 'vp-mt-' + Math.random().toString(36).slice(2, 9);
        panel.setAttribute('aria-labelledby', heading.id);
      }
    }
  }

  function open(overlay, opts) {
    opts = opts || {};
    if (!overlay || isOpen(overlay)) return;

    overlay._vpReturnFocus = document.activeElement;

    stack.push(overlay);
    overlay.style.zIndex = String(BASE_Z + (stack.length - 1) * Z_STEP);
    overlay.style.display = opts.display || 'flex';
    applyA11y(overlay);

    // Force a reflow so the entry animation always runs, even if the overlay
    // was toggled rapidly.
    void overlay.offsetWidth;
    overlay.classList.add('is-open');

    lockScroll();

    if (!overlay.hasAttribute('data-vp-wired')) {
      overlay.setAttribute('data-vp-wired', '1');

      // Backdrop click. Only fires when the click target is the overlay itself,
      // so clicks inside the panel never close it.
      overlay.addEventListener('mousedown', function (e) {
        if (e.target === overlay && overlay.getAttribute('data-vp-dismissable') !== 'false') close(overlay);
      });

      // Any element marked data-vp-dismiss closes its own modal.
      overlay.addEventListener('click', function (e) {
        var trigger = e.target.closest ? e.target.closest(CLOSEABLE) : null;
        if (trigger && overlay.contains(trigger)) {
          var reason = trigger.getAttribute('data-vp-dismiss');
          close(overlay, reason === 'confirm' ? 'confirm' : 'dismiss');
        }
      });
    }

    // Focus after layout so the panel is measurable.
    requestAnimationFrame(function () {
      if (isOpen(overlay)) focusInitial(overlay);
    });

    overlay.dispatchEvent(new CustomEvent('vp:open', { bubbles: false }));
  }

  function close(overlay, reason) {
    if (!overlay || !isOpen(overlay)) return;

    var i = stack.indexOf(overlay);
    if (i !== -1) stack.splice(i, 1);

    overlay.classList.remove('is-open');
    overlay.style.display = 'none';
    overlay.setAttribute('aria-hidden', 'true');

    // Renumber the remaining stack so the ladder stays monotonic.
    for (var k = 0; k < stack.length; k++) {
      stack[k].style.zIndex = String(BASE_Z + k * Z_STEP);
    }

    unlockScroll();

    var back = overlay._vpReturnFocus;
    overlay._vpReturnFocus = null;
    if (back && typeof back.focus === 'function' && document.contains(back)) {
      back.focus();
    }

    overlay.dispatchEvent(new CustomEvent('vp:close', { detail: { reason: reason || 'dismiss' } }));
  }

  function closeTop(reason) {
    if (!stack.length) return;
    close(stack[stack.length - 1], reason);
  }

  function toggle(overlay) {
    if (isOpen(overlay)) close(overlay);
    else open(overlay);
  }

  // ---- global key handling (bound once) ----------------------------------
  function onKeydown(e) {
    if (!stack.length) return;
    var top = stack[stack.length - 1];

    if (e.key === 'Escape' || e.key === 'Esc') {
      if (top.getAttribute('data-vp-escape') === 'false') return;
      e.preventDefault();
      closeTop('escape');
      return;
    }

    if (e.key === 'Tab') trapTab(top, e);
  }

  if (document.addEventListener) {
    document.addEventListener('keydown', onKeydown);
  }

  var api = {
    open: open,
    close: close,
    toggle: toggle,
    closeTop: closeTop,
    isOpen: isOpen,
    count: openCount,
    get stack() { return stack.slice(); }
  };

  global.VP = global.VP || {};
  global.VP.modal = api;
})(window);
