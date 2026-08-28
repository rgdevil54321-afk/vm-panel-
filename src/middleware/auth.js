const authService = require('../services/authService');
const { settings } = require('../lib/db');

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
    try {
      const payload = authService.verifyToken(token);
      if (!payload || !payload.sub) continue;
      const user = authService.findById(Number(payload.sub));
      if (user && !user.suspended) return user;
    } catch (_) {}
  }
  return null;
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
    return res.redirect('/login');
  }
  if (user.role !== 'admin' && !user.root_admin) {
    if (req.xhr || req.path.startsWith('/api') || req.headers.accept?.includes('application/json')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    return res.status(403).render('error/403', { code: 403, title: 'Forbidden', message: 'You do not have permission to access this page.', settings: settings.all(), user });
  }
  req.user = user;
  next();
}

function apiAuth(req, res, next) {
  const user = getUserFromReq(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.user = user;
  next();
}

function apiAdmin(req, res, next) {
  const user = getUserFromReq(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  if (user.role !== 'admin' && !user.root_admin) return res.status(403).json({ error: 'Forbidden' });
  req.user = user;
  next();
}

module.exports = { requireAuth, optionalAuth, requireAdmin, apiAuth, apiAdmin, getUserFromReq };
