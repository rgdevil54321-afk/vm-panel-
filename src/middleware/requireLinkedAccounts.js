// Forces every account to have BOTH a Discord and a Google identity linked
// before it can use the rest of the panel.
//
// Admin accounts are deliberately NOT exempt: one canonical identity per human
// is the whole point, and a half-exemption is how shared logins creep back in.
// If an admin ever locks themselves out, the gate is a single settings row, so
// recovery is one command over SSH:
//
//   cd /root/vm-panel- && node -e "require('./src/lib/db').settings.set('security.require_linked_accounts','0')"
//
// The panel's own service key is exempt (req.apiPanelKey) because that traffic
// is the panel talking to itself, not a person, and blocking it would break
// internal calls and scheduled jobs.
'use strict';
const { settings } = require('../lib/db');

// Everything a non-compliant account still needs in order to become compliant.
const ALLOWED = new Set([
  '/settings',
  '/settings/',
  '/settings/discord/link',
  '/settings/discord/callback',
  '/settings/google/link',
  '/settings/google/callback',
  '/logout',
  '/api/auth/logout',
]);

const STATIC_PREFIXES = ['/css/', '/js/', '/img/', '/uploads/', '/fonts/', '/favicon'];

function gateEnabled() {
  return String(settings.get('security.require_linked_accounts') || '0') === '1';
}

function isComplete(user) {
  return !!(user && user.discord_id && user.google_id);
}

function requireLinkedAccounts(req, res, next) {
  if (!gateEnabled()) return next();
  if (!req.user) return next();
  if (req.apiPanelKey) return next();
  if (isComplete(req.user)) return next();

  const p = req.path || '';
  if (ALLOWED.has(p)) return next();
  for (const pre of STATIC_PREFIXES) {
    if (p === pre || p.startsWith(pre)) return next();
  }

  const wantsJson =
    p.startsWith('/api') ||
    req.xhr ||
    String(req.headers.accept || '').includes('application/json');

  if (wantsJson) {
    return res.status(403).json({
      error: 'link_required',
      message: 'Link both a Discord and a Google account to continue.',
      discord_linked: !!req.user.discord_id,
      google_linked: !!req.user.google_id,
    });
  }
  return res.redirect('/settings?err=link_required');
}

module.exports = { requireLinkedAccounts, gateEnabled, isComplete };
