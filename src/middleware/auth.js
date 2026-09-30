const authService = require('../services/authService');
const { settings } = require('../lib/db');
const crypto = require('crypto');

function ensurePanelKey() {
  const current = String(settings.get('api.panel_key') || '');
  if (current) return current;
  const key = 'vp_panel_' + crypto.randomBytes(24).toString('base64url');
  settings.set('api.panel_key', key);
  return key;
}

function getUserFromReq(req) {
  const candidates = [];
  if (req.headers && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    const t = req.headers.authorization.slice(7).trim();
    if (t && t !== 'undefined' && t !== 'null' && t !== '[object Object]') candidates.push(t);
  }
  if (req.cookies && req.cookies.token) {
    const t = String(req.cookies.token).trim();
    if (t && t !== 'undefined' && t !== 'null') candidates.push(t);
  }
  if (req.query && req.query.token) {
    const t = String(req.query.token).trim();
    if (t && t !== 'undefined' && t !== 'null') candidates.push(t);
  }

  for (const token of candidates) {
    if (token.startsWith('vp_panel_')) {
      if (token === ensurePanelKey()) {
        req.apiPanelKey = true;
        return { id: 0, username: 'panel-api', email: 'api@panel.local', name: 'Panel API', role: 'admin', root_admin: 1, suspended: false, verified: true, credits: 0, discord_id: null };
      }
      continue;
    }
    if (token.startsWith('vp_live_')) {
      const apiKey = require('../services/apiKeyService');
      const found = apiKey.findUserByKey(token);
      if (found) {
        req.apiKey = found.key;
        return found.user;
      }
      continue;
    }
    try {
      const payload = authService.verifyToken(token);
      if (!payload || !payload.sub) continue;
      const user = authService.findById(Number(payload.sub));
      if (user && !user.suspended) {
        if (payload.imp) {
          const imp = require('../services/impersonationService').resolveImpersonation(user, payload);
          if (imp) {
            req.impersonation = imp;
            return user;
          }
          continue;
        }
        return user;
      }
    } catch (_) {}
  }
  return null;
}

// An API key's `scopes` column was stored and displayed but never read, so a key
// created with a narrow scope was indistinguishable from an admin token. There
// was no vocabulary to key off, so this derives one from the column's own
// existing default ("r_servers"):
//
//   * , all      full access, including /admin routes
//   r_*          read-only (any safe method)
//   w_*          required for POST / PUT / PATCH / DELETE
//   <anything else is inert; it neither grants nor denies
//
// Session tokens and the vp_panel_ key are unaffected - this only narrows what
// a vp_live_ key can do, and never widens it.
function apiKeyScopes(key) {
  return String((key && key.scopes) || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function enforceApiKeyScopes(req, res) {
  if (!req.apiKey) return true;
  const scopes = apiKeyScopes(req.apiKey);
  if (scopes.includes('*') || scopes.includes('all')) return true;
  const method = String(req.method || 'GET').toUpperCase();
  // The api router is mounted at both '/' and '/api', and originalUrl carries
  // whichever prefix matched, so normalise before testing.
  const full = String(req.originalUrl || req.url || '').split('?')[0];
  const path = full.replace(/^\/api(?=\/)/, '');
  const isAdminPath = path.startsWith('/admin');
  if (isAdminPath) {
    res.status(403).json({ error: 'This API key is not allowed on admin endpoints. Use the panel key or a key scoped "*".' });
    return false;
  }
  if (method !== 'GET' && method !== 'HEAD' && !scopes.some((s) => s.startsWith('w_'))) {
    res.status(403).json({
      error: `API key scope "${req.apiKey.scopes}" is read-only. Add a w_ scope (or "*") to call ${method}.`,
    });
    return false;
  }
  return true;
}

function requireAuth(req, res, next) {
  const user = getUserFromReq(req);
  if (!user) {
    if (req.xhr || req.path.startsWith('/api') || req.headers.accept?.includes('application/json')) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    return res.redirect('/login');
  }
  req.user = user;
  if (!enforceApiKeyScopes(req, res)) return;
  next();
}

function optionalAuth(req, res, next) {
  req.user = getUserFromReq(req);
  next();
}

function requireAdmin(req, res, next) {
  const user = req.user || getUserFromReq(req);
  if (!user) {
    if (req.xhr || req.path.startsWith('/api') || req.headers.accept?.includes('application/json')) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    return res.redirect('/admin/login');
  }
  if (user.role !== 'admin' && !user.root_admin) {
    if (req.xhr || req.path.startsWith('/api') || req.headers.accept?.includes('application/json')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    return res.status(403).render('error/403', { code: 403, title: 'Forbidden', message: 'You do not have permission to access this page.', settings: settings.all(), user });
  }
  req.user = user;
  if (!enforceApiKeyScopes(req, res)) return;
  next();
}

function apiAuth(req, res, next) {
  const user = getUserFromReq(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.user = user;
  if (!enforceApiKeyScopes(req, res)) return;
  next();
}

function apiAdmin(req, res, next) {
  const user = getUserFromReq(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  if (user.role !== 'admin' && !user.root_admin) return res.status(403).json({ error: 'Forbidden' });
  req.user = user;
  if (!enforceApiKeyScopes(req, res)) return;
  next();
}

module.exports = { requireAuth, optionalAuth, requireAdmin, apiAuth, apiAdmin, getUserFromReq, ensurePanelKey };
