const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../lib/config');
const { db } = require('../lib/db');
const { logActivity } = require('./activityService');

const IMPERSONATION_TTL_MS = 30 * 60 * 1000; // 30 minutes

function hashToken(t) {
  return crypto.createHash('sha256').update(t).digest('hex');
}

// Admin signs an impersonation token that is bound to a session row in DB.
function createImpersonation(adminUser, target, reason = '') {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  db.prepare(
    'INSERT INTO impersonations (admin_id, target_id, token_hash, reason, created_at, expires_at) VALUES (?,?,?,?,?,?)'
  ).run(adminUser.id, target.id, hashToken(token), String(reason).slice(0, 500), now.toISOString(),
    new Date(now.getTime() + IMPERSONATION_TTL_MS).toISOString());

  // JWT carrying impersonation context; sub = the target user.
  const jtw = jwt.sign(
    {
      sub: String(target.id),
      username: target.username,
      role: target.role || 'user',
      imp: true,
      impAdmin: adminUser.id,
      impToken: token,
    },
    config.jwtSecret,
    { expiresIn: IMPERSONATION_TTL_MS / 1000 }
  );

  logActivity({
    user_id: adminUser.id,
    event: 'admin:impersonation_start',
    details: { target_id: target.id, target_username: target.username, reason },
  });
  logActivity({
    user_id: target.id,
    event: 'user:impersonation_by_admin',
    details: { admin_id: adminUser.id },
  });

  return { token: jtw, expiresAt: new Date(now.getTime() + IMPERSONATION_TTL_MS) };
}

// Resolves which admin is behind an impersonation token (returns {admin, target} or null).
function resolveImpersonation(reqUser, decodedPayload) {
  if (!reqUser || !decodedPayload || !decodedPayload.imp) return null;
  const impToken = decodedPayload.impToken;
  const signedAt = decodedPayload.iat ? decodedPayload.iat * 1000 : Date.now();
  const row = db.prepare(
    'SELECT * FROM impersonations WHERE token_hash = ? AND admin_id = ? AND target_id = ?'
  ).get(hashToken(impToken), decodedPayload.impAdmin, reqUser.id);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  if (new Date(row.created_at).getTime() > signedAt + 5000) return null;
  const admin = db.prepare('SELECT id, username, role, root_admin FROM users WHERE id = ?').get(row.admin_id);
  if (!admin || (admin.role !== 'admin' && !admin.root_admin)) return null;
  return { admin, target: reqUser, row };
}

function endImpersonation(impContext, adminUser) {
  // impContext: the resolved { admin, target, row } from resolveImpersonation
  if (!impContext || !impContext.row) return false;
  db.prepare('DELETE FROM impersonations WHERE id = ?').run(impContext.row.id);
  logActivity({
    user_id: (adminUser && adminUser.id) || (impContext.admin && impContext.admin.id),
    event: 'admin:impersonation_end',
    details: { target_id: impContext.target ? impContext.target.id : null },
  });
  return true;
}

module.exports = { createImpersonation, resolveImpersonation, endImpersonation, IMPERSONATION_TTL_MS, hashToken };