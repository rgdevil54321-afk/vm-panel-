const crypto = require('crypto');
const { db } = require('../lib/db');

function generateKey() {
  return 'vp_live_' + crypto.randomBytes(24).toString('base64url');
}

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function createApiKey(userId, name, scopes = 'r_servers') {
  if (!name || !String(name).trim()) throw new Error('Key name is required');
  const key = generateKey();
  const prefix = key.slice(0, 12);
  db.prepare(
    'INSERT INTO api_keys (user_id, name, key_hash, key_prefix, scopes, created_at) VALUES (?,?,?,?,?,?)'
  ).run(Number(userId), String(name).trim(), hashKey(key), prefix, String(scopes), new Date().toISOString());
  return { key, prefix }; // full key shown once at creation
}

function listApiKeys(userId) {
  return db.prepare(
    'SELECT id, name, key_prefix, scopes, last_used_at, created_at FROM api_keys WHERE user_id = ? ORDER BY id DESC'
  ).all(Number(userId));
}

function deleteApiKey(userId, id) {
  const info = db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?').run(Number(id), Number(userId));
  return info.changes > 0;
}

function findUserByKey(key) {
  if (!key || typeof key !== 'string' || !key.startsWith('vp_live_')) return null;
  const row = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(hashKey(key));
  if (!row) return null;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  if (!user || user.suspended) return null;
  db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
  return { user, key: row };
}

function destroyKeysForUser(userId) {
  db.prepare('DELETE FROM api_keys WHERE user_id = ?').run(Number(userId));
  return true;
}

module.exports = { createApiKey, listApiKeys, deleteApiKey, findUserByKey, destroyKeysForUser, hashKey };