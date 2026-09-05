const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const { v4: uuidv4 } = require('uuid');
const config = require('../lib/config');
const { db, settings } = require('../lib/db');
const logger = require('../lib/logger');
const { logActivity, logLogin } = require('./activityService');

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    name: u.name,
    role: u.role,
    root_admin: !!u.root_admin,
    language: u.language,
    avatar: u.avatar,
    verified: !!u.verified,
    suspended: !!u.suspended,
    tfa_enabled: !!u.tfa_enabled,
    music_enabled: u.music_enabled === 1 || u.music_enabled === '1' || u.music_enabled === true,
    sfx_enabled: u.sfx_enabled === undefined ? true : (u.sfx_enabled === 1 || u.sfx_enabled === '1' || u.sfx_enabled === true),
    last_login_at: u.last_login_at,
    last_login_ip: u.last_login_ip,
    created_at: u.created_at,
  };
}

function signToken(user) {
  return jwt.sign(
    { sub: String(user.id), username: user.username, role: user.role },
    config.jwtSecret,
    { expiresIn: config.jwtExpires }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch (_) {
    return null;
  }
}

function findByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(username, username);
}

function findById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function createUser({ username, email, password, name, role = 'user', verified = true }) {
  const usernameOk = /^[a-zA-Z0-9_]{3,32}$/.test(username);
  if (!usernameOk) throw new Error('Username must be 3-32 chars (letters, numbers, underscore)');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Invalid email address');
  if (!password || password.length < 6) throw new Error('Password must be at least 6 characters');
  const hash = bcrypt.hashSync(password, 10);
  const now = new Date().toISOString();
  let signupCredits = 0;
  try {
    if (String(settings.get('billing.enabled') || '0') === '1') {
      signupCredits = parseFloat(settings.get('billing.signup_credits') || '0') || 0;
    }
  } catch (_) {}
  try {
    const info = db.prepare(
      'INSERT INTO users (username, email, password, name, role, verified, credits, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(username, email, hash, name || username, role, verified ? 1 : 0, signupCredits, now, now);
    return findById(Number(info.lastInsertRowid));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new Error('Username or email already exists');
    throw e;
  }
}

function updateUser(id, data) {
  const user = findById(id);
  if (!user) throw new Error('User not found');
  const allowed = ['name', 'email', 'username', 'language', 'avatar', 'role'];
  const set = [];
  const vals = {};
  for (const f of allowed) {
    if (data[f] !== undefined) {
      set.push(`${f} = @${f}`);
      vals[f] = data[f];
    }
  }
  if (data.password) {
    if (data.password.length < 6) throw new Error('Password too short');
    set.push('password = @password');
    vals.password = bcrypt.hashSync(data.password, 10);
  }
  if (data.suspended !== undefined) { set.push('suspended = @suspended'); vals.suspended = data.suspended ? 1 : 0; }
  if (data.verified !== undefined) { set.push('verified = @verified'); vals.verified = data.verified ? 1 : 0; }
  if (data.root_admin !== undefined) { set.push('root_admin = @root_admin'); vals.root_admin = data.root_admin ? 1 : 0; }
  if (data.credits !== undefined) { set.push('credits = @credits'); vals.credits = Number(data.credits) || 0; }
  if (data.max_vms !== undefined) { set.push('max_vms = @max_vms'); vals.max_vms = parseInt(data.max_vms, 10); }
  if (data.max_cpu !== undefined) { set.push('max_cpu = @max_cpu'); vals.max_cpu = parseInt(data.max_cpu, 10); }
  if (data.max_mem_mb !== undefined) { set.push('max_mem_mb = @max_mem_mb'); vals.max_mem_mb = parseInt(data.max_mem_mb, 10); }
  if (data.max_disk_gb !== undefined) { set.push('max_disk_gb = @max_disk_gb'); vals.max_disk_gb = parseInt(data.max_disk_gb, 10); }
  if (data.tfa_disabled) { set.push('tfa_enabled = 0, tfa_secret = NULL'); }
  if (set.length) {
    set.push('updated_at = @updated_at');
    vals.updated_at = new Date().toISOString();
    try {
      db.prepare(`UPDATE users SET ${set.join(', ')} WHERE id = @id`).run({ ...vals, id });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new Error('Username or email already in use');
      throw e;
    }
  }
  return findById(id);
}

function deleteUser(id) {
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return true;
}

function countAdmins() {
  return db.prepare('SELECT COUNT(*) c FROM users WHERE role = ? OR root_admin = 1').get('admin').c;
}

function attemptLogin(username, password, ip) {
  const user = findByUsername(username);
  if (!user) {
    logLogin({ ip, username, status: 'failed_user' });
    return { ok: false, error: 'Invalid username or password' };
  }
  if (!bcrypt.compareSync(password, user.password)) {
    logLogin({ user_id: user.id, ip, username, status: 'failed_password' });
    logActivity({ user_id: user.id, event: 'auth:login_failed', ip });
    return { ok: false, error: 'Invalid username or password' };
  }
  if (user.suspended) {
    logLogin({ user_id: user.id, ip, username, status: 'suspended' });
    return { ok: false, error: 'This account is suspended' };
  }
  return { ok: true, user, tfaRequired: !!user.tfa_enabled };
}

function finishLogin(user, ip) {
  const now = new Date().toISOString();
  db.prepare('UPDATE users SET last_login_at = ?, last_login_ip = ? WHERE id = ?').run(now, ip, user.id);
  logLogin({ user_id: user.id, ip, username: user.username, status: 'success' });
  logActivity({ user_id: user.id, event: 'auth:login', ip });
  const token = signToken(user);
  return { token, user: publicUser({ ...user, last_login_at: now, last_login_ip: ip }) };
}

function genVerifyToken() {
  return uuidv4().replace(/-/g, '');
}

function createVerifyToken(user) {
  const token = genVerifyToken();
  db.prepare('UPDATE users SET verify_token = ? WHERE id = ?').run(token, user.id);
  return token;
}

function verifyEmail(token) {
  const user = db.prepare('SELECT * FROM users WHERE verify_token = ?').get(token);
  if (!user) return { ok: false, error: 'Invalid or expired verification token' };
  db.prepare('UPDATE users SET verified = 1, verify_token = NULL WHERE id = ?').run(user.id);
  logActivity({ user_id: user.id, event: 'auth:email_verified' });
  return { ok: true };
}

function createResetToken(user) {
  const token = genVerifyToken();
  db.prepare(
    'INSERT INTO reset_tokens (user_id, token, expires_at, created_at) VALUES (?,?,?,?)'
  ).run(user.id, token, new Date(Date.now() + 3600000).toISOString(), new Date().toISOString());
  return token;
}

function resetPassword(token, newPassword) {
  if (!newPassword || newPassword.length < 6) return { ok: false, error: 'Password must be at least 6 characters' };
  const row = db.prepare('SELECT * FROM reset_tokens WHERE token = ? AND used = 0').get(token);
  if (!row) return { ok: false, error: 'Invalid or expired token' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, error: 'Token expired' };
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, row.user_id);
  db.prepare('UPDATE reset_tokens SET used = 1 WHERE id = ?').run(row.id);
  logActivity({ user_id: row.user_id, event: 'auth:password_reset' });
  return { ok: true };
}

function setupTfa(user) {
  const secret = speakeasy.generateSecret({ length: 20, name: `${settings.get('panel.name') || 'Venlix Nodes'} (${user.username})` });
  db.prepare('UPDATE users SET tfa_secret = ? WHERE id = ?').run(secret.base32, user.id);
  return { secret: secret.base32, otpauth_url: secret.otpauth_url };
}

function confirmTfa(user, code) {
  if (!user.tfa_secret) return { ok: false, error: '2FA is not configured' };
  const valid = speakeasy.totp.verify({
    secret: user.tfa_secret,
    encoding: 'base32',
    token: String(code).replace(/\s/g, ''),
    window: 1,
  });
  if (!valid) return { ok: false, error: 'Invalid 2FA code' };
  return { ok: true };
}

function enableTfa(user, code) {
  const check = confirmTfa(user, code);
  if (!check.ok) return check;
  db.prepare('UPDATE users SET tfa_enabled = 1 WHERE id = ?').run(user.id);
  logActivity({ user_id: user.id, event: 'auth:tfa_enabled' });
  return { ok: true };
}

function disableTfa(user, code) {
  const check = confirmTfa(user, code);
  if (!check.ok) return check;
  db.prepare('UPDATE users SET tfa_enabled = 0, tfa_secret = NULL WHERE id = ?').run(user.id);
  logActivity({ user_id: user.id, event: 'auth:tfa_disabled' });
  return { ok: true };
}

module.exports = {
  publicUser, signToken, verifyToken, findByUsername, findById, createUser, updateUser, deleteUser,
  countAdmins, attemptLogin, finishLogin, createVerifyToken, verifyEmail, createResetToken,
  resetPassword, setupTfa, confirmTfa, enableTfa, disableTfa,
};
