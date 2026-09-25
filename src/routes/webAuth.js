const express = require('express');
const crypto = require('crypto');
const authService = require('../services/authService');
const mailService = require('../services/mailService');
const discordService = require('../services/discordService');
const googleService = require('../services/googleService');
const config = require('../lib/config');
const { db, settings } = require('../lib/db');
const activity = require('../services/activityService');
const router = express.Router();

  function render(res, view, vars = {}) {
  const req = res.req;
  const proto = (req.secure || String(req.get('x-forwarded-proto') || '').split(',')[0].trim() === 'https') ? 'https' : 'http';
  res.render(`auth/${view}`, {
  page: view,
  user: null,
  settings: settings.all(),
  siteUrl: proto + '://' + req.get('host'),
  discordLogin: discordService.oauthConfigured(),
  googleLogin: googleService.oauthConfigured(),
  ...vars,
  });
}

const discordErrs = {
  discord_denied: 'Discord authorization was cancelled.',
  discord_badstate: 'Discord authorization expired or was tampered with. Please try again.',
  discord_oauth_failed: 'Discord sign-in failed. Please try again.',
  discord_not_configured: 'Discord sign-in is not configured yet.',
  discord_register_disabled: 'Registration is disabled — sign in with an existing account instead.',
  discord_tfa: 'This account has 2FA enabled — sign in with your password.',
  suspended: 'This account is suspended.',
};

const googleErrs = {
  google_denied: 'Google authorization was cancelled.',
  google_badstate: 'Google authorization expired or was tampered with. Please try again.',
  google_oauth_failed: 'Google sign-in failed. Please try again.',
  google_not_configured: 'Google sign-in is not configured yet.',
  google_no_email: 'Google did not return an email address — use another sign-in method.',
  google_register_disabled: 'Registration is disabled — sign in with an existing account instead.',
  google_tfa: 'This account has 2FA enabled — sign in with your password.',
};

const authErrs = { ...discordErrs, ...googleErrs };

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  render(res, 'login', { error: authErrs[req.query.err] || null });
});

// ---- Discord OAuth2 login / auto-register ----
function oauthRedirectUri(req, path) {
  const proto = req.headers['x-forwarded-proto'] === 'https' || req.secure ? 'https' : 'http';
  return proto + '://' + req.get('host') + path;
}
function dcbRedirectUri(req) {
  return oauthRedirectUri(req, '/auth/discord/callback');
}
function dcbState() {
  const nonce = crypto.randomBytes(16).toString('hex');
  const mac = crypto.createHmac('sha256', config.jwtSecret).update(nonce).digest('hex');
  return nonce + '.' + mac;
}
function dcbStateOk(state, cookieVal) {
  const a = Buffer.from(String(state || ''));
  const b = Buffer.from(String(cookieVal || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.get('/auth/discord', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  if (!discordService.oauthConfigured()) return res.redirect('/login?err=discord_not_configured');
  const st = dcbState();
  res.cookie('dcstate', st, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000, path: '/auth/discord' });
  res.redirect(discordService.authorizeUrl(dcbRedirectUri(req), st));
});

router.get('/auth/discord/callback', async (req, res) => {
  const clearState = () => res.clearCookie('dcstate', { path: '/auth/discord' });
  const { code, state, error } = req.query;
  if (error) { clearState(); return res.redirect('/login?err=discord_denied'); }
  if (!dcbStateOk(state, req.cookies.dcstate)) { clearState(); return res.redirect('/login?err=discord_badstate'); }
  clearState();
  const tok = await discordService.exchangeCode(String(code || ''), dcbRedirectUri(req));
  if (!tok.ok || !tok.data || !tok.data.access_token) return res.redirect('/login?err=discord_oauth_failed');
  const me = await discordService.getOAuthUser(tok.data.access_token);
  if (!me.ok || !me.data || !me.data.id) return res.redirect('/login?err=discord_oauth_failed');
  const did = String(me.data.id);
  const ip = req.ip || req.socket.remoteAddress;
  const user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(did);
  if (user) {
    if (user.suspended) return res.redirect('/login?err=suspended');
    if (user.tfa_enabled) return res.redirect('/login?err=discord_tfa');
    const { token } = authService.finishLogin(user, ip);
    res.cookie('token', token, { httpOnly: false, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 });
    return res.redirect('/dashboard');
  }
  if (settings.get('security.allow_register') === '0') return res.redirect('/login?err=discord_register_disabled');
  const raw = String(me.data.username || 'user');
  let uname = raw.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 24);
  if (uname.length < 3) uname = ('u_' + uname + did.slice(-6)).replace(/[^a-zA-Z0-9_]/g, '');
  uname = uname.slice(0, 32);
  let candidate = uname;
  for (let i = 1; db.prepare('SELECT 1 FROM users WHERE username = ?').get(candidate); i++) {
    candidate = (uname + '_' + i).slice(0, 32);
  }
  let email = `${did}@discord.local`;
  for (let i = 1; db.prepare('SELECT 1 FROM users WHERE email = ?').get(email); i++) {
    email = `${did}.${i}@discord.local`;
  }
  let newUser;
  try {
    newUser = authService.createUser({
      username: candidate,
      email,
      password: crypto.randomBytes(24).toString('hex'),
      name: String(me.data.global_name || me.data.username || candidate).slice(0, 64),
      role: 'user',
      verified: true,
    });
  } catch (e) {
    return res.redirect('/login?err=' + encodeURIComponent(e.message));
  }
  db.prepare('UPDATE users SET discord_id = ?, discord_name = ?, discord_avatar = ?, discord_linked_at = ?, updated_at = ? WHERE id = ?')
    .run(did, String(me.data.username || '').slice(0, 64), discordService.cdnAvatar(me.data), new Date().toISOString(), new Date().toISOString(), newUser.id);
  activity.logActivity({ user_id: newUser.id, event: 'auth:register', details: { via: 'discord', discord_id: did }, ip });
  const { token } = authService.finishLogin(newUser, ip);
  res.cookie('token', token, { httpOnly: false, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 });
  return res.redirect('/dashboard');
});

// ---- Google OAuth2 login / auto-register (mirrors the Discord flow) ----
function gaClientState() {
  const nonce = crypto.randomBytes(16).toString('hex');
  const mac = crypto.createHmac('sha256', config.jwtSecret).update(nonce).digest('hex');
  return nonce + '.' + mac;
}
function gaStateOk(state, cookieVal) {
  const a = Buffer.from(String(state || ''));
  const b = Buffer.from(String(cookieVal || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.get('/auth/google', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  if (!googleService.oauthConfigured()) return res.redirect('/login?err=google_not_configured');
  const st = gaClientState();
  res.cookie('gcstate', st, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000, path: '/auth/google' });
  res.redirect(googleService.authorizeUrl(oauthRedirectUri(req, '/auth/google/callback'), st));
});

router.get('/auth/google/callback', async (req, res) => {
  const clearState = () => res.clearCookie('gcstate', { path: '/auth/google' });
  const { code, state, error } = req.query;
  if (error) { clearState(); return res.redirect('/login?err=google_denied'); }
  if (!gaStateOk(state, req.cookies.gcstate)) { clearState(); return res.redirect('/login?err=google_badstate'); }
  clearState();
  const tok = await googleService.exchangeCode(String(code || ''), oauthRedirectUri(req, '/auth/google/callback'));
  if (!tok.ok || !tok.data || !tok.data.access_token) return res.redirect('/login?err=google_oauth_failed');
  const me = await googleService.getOAuthUser(tok.data.access_token);
  if (!me.ok || !me.data || !me.data.sub) return res.redirect('/login?err=google_oauth_failed');
  const gid = String(me.data.sub);
  const ip = req.ip || req.socket.remoteAddress;
  const user = db.prepare('SELECT * FROM users WHERE google_id = ?').get(gid);
  if (user) {
    if (user.suspended) return res.redirect('/login?err=suspended');
    if (user.tfa_enabled) return res.redirect('/login?err=google_tfa');
    const { token } = authService.finishLogin(user, ip);
    res.cookie('token', token, { httpOnly: false, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 });
    return res.redirect('/dashboard');
  }
  if (settings.get('security.allow_register') === '0') return res.redirect('/login?err=google_register_disabled');
  const email = String(me.data.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.redirect('/login?err=google_no_email');
  const local = email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '').slice(0, 24) || 'user';
  let uname = local;
  if (uname.length < 3) uname = ('u_' + uname + gid.slice(-6)).replace(/[^a-zA-Z0-9_]/g, '').slice(0, 32);
  uname = uname.slice(0, 32);
  let candidate = uname;
  for (let i = 1; db.prepare('SELECT 1 FROM users WHERE username = ?').get(candidate); i++) {
    candidate = (uname + '_' + i).slice(0, 32);
  }
  let finalEmail = email;
  for (let i = 1; db.prepare('SELECT 1 FROM users WHERE email = ?').get(finalEmail); i++) {
    const at = email.indexOf('@');
    finalEmail = email.slice(0, at) + '.' + i + email.slice(at);
  }
  let newUser;
  try {
    newUser = authService.createUser({
      username: candidate,
      email: finalEmail,
      password: crypto.randomBytes(24).toString('hex'),
      name: String(me.data.name || me.data.email || candidate).slice(0, 64),
      role: 'user',
      verified: !!me.data.email_verified,
    });
  } catch (e) {
    return res.redirect('/login?err=' + encodeURIComponent(e.message));
  }
  db.prepare('UPDATE users SET google_id = ?, google_name = ?, google_avatar = ?, google_linked_at = ?, updated_at = ? WHERE id = ?')
    .run(gid, String(me.data.name || '').slice(0, 64), String(me.data.picture || '').slice(0, 500), new Date().toISOString(), new Date().toISOString(), newUser.id);
  activity.logActivity({ user_id: newUser.id, event: 'auth:register', details: { via: 'google', google_id: gid }, ip });
  const { token } = authService.finishLogin(newUser, ip);
  res.cookie('token', token, { httpOnly: false, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 });
  return res.redirect('/dashboard');
});

// ---- Dedicated Admin Portal entry ----
router.get('/admin/login', (req, res) => {
  if (req.user) {
    if (req.user.role === 'admin' || req.user.root_admin) return res.redirect('/admin');
    return res.redirect('/dashboard');
  }
  render(res, 'adminLogin');
});

router.post('/admin/login', express.urlencoded({ extended: true }), (req, res) => {
  const { username, password, code } = req.body;
  const ip = req.ip || req.socket.remoteAddress;
  const result = authService.attemptLogin(String(username || '').trim(), String(password || ''), ip);
  if (!result.ok) {
    return render(res, 'adminLogin', { error: result.error, username });
  }
  const { user } = result;
  if (result.tfaRequired) {
    if (!code) {
      return render(res, 'adminLogin', { tfa: true, tfaUser: user.username });
    }
    const check = authService.confirmTfa(user, code);
    if (!check.ok) return render(res, 'adminLogin', { tfa: true, tfaUser: user.username, error: check.error });
  }
  if (user.role !== 'admin' && !user.root_admin) {
    return render(res, 'adminLogin', { error: 'This account is not an administrator.', username });
  }
  const { token } = authService.finishLogin(user, ip);
  res.cookie('token', token, { httpOnly: false, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 });
  res.redirect('/admin');
});

router.post('/login', express.urlencoded({ extended: true }), (req, res) => {
  const { username, password, code } = req.body;
  const ip = req.ip || req.socket.remoteAddress;
  const result = authService.attemptLogin(String(username || '').trim(), String(password || ''), ip);
  if (!result.ok) {
    return render(res, 'login', { error: result.error, username });
  }
  const { user } = result;
  if (result.tfaRequired) {
    if (!code) {
      return render(res, 'login', { tfa: true, tfaUser: user.username, error: null });
    }
    const check = authService.confirmTfa(user, code);
    if (!check.ok) return render(res, 'login', { tfa: true, tfaUser: user.username, error: check.error });
  }
  const { token } = authService.finishLogin(user, ip);
  res.cookie('token', token, { httpOnly: false, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 });
  res.redirect('/dashboard');
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  const allowed = settings.get('security.allow_register') !== '0';
  render(res, 'register', { allowed });
});

router.post('/register', express.urlencoded({ extended: true }), (req, res) => {
  if (settings.get('security.allow_register') === '0') {
    return render(res, 'register', { error: 'Registration is disabled by the administrator', allowed: false });
  }
  const { username, email, password, name, password2 } = req.body;
  if (password !== password2) return render(res, 'register', { error: 'Passwords do not match', username, email, name });
  const requireVerify = settings.get('security.require_verify') === '1';
  try {
    const user = authService.createUser({
      username: String(username || '').trim(),
      email: String(email || '').trim().toLowerCase(),
      password: String(password || ''),
      name: String(name || '').trim() || username,
      role: 'user',
      verified: !requireVerify,
    });
    if (requireVerify) {
      const token = authService.createVerifyToken(user);
      awaitable(mailService.sendVerifyEmail(user, token));
    }
    activity.logActivity({ user_id: user.id, event: 'auth:register', ip: req.ip });
    return render(res, 'register', { success: 'Account created! You can now login.' });
  } catch (e) {
    return render(res, 'register', { error: e.message, username, email, name });
  }
});

function awaitable(p) { return Promise.resolve(p).catch(() => {}); }

router.get('/forgot', (req, res) => render(res, 'forgot'));
router.post('/forgot', express.urlencoded({ extended: true }), (req, res) => {
  const target = authService.findByUsername(String(req.body.email || '').trim().toLowerCase());
  if (target) {
    const token = authService.createResetToken(target);
    awaitable(mailService.sendResetEmail(target, token));
  }
  return render(res, 'forgot', { success: 'If that email exists, a reset link has been sent.' });
});

router.get('/reset', (req, res) => render(res, 'reset', { token: req.query.token || '' }));
router.post('/reset', express.urlencoded({ extended: true }), (req, res) => {
  const { token, password, password2 } = req.body;
  if (password !== password2) return render(res, 'reset', { token, error: 'Passwords do not match' });
  const result = authService.resetPassword(token, password);
  if (!result.ok) return render(res, 'reset', { token, error: result.error });
  return render(res, 'reset', { token: '', success: 'Password reset! You can now login.' });
});

router.get('/verify', (req, res) => {
  const result = authService.verifyEmail(req.query.token || '');
  return render(res, 'verify', { ok: result.ok, error: result.error });
});

router.get('/logout', (req, res) => {
  const user = req.user;
  if (user) activity.logActivity({ user_id: user.id, event: 'auth:logout', ip: req.ip });
  res.clearCookie('token');
  res.redirect('/login');
});

module.exports = router;
