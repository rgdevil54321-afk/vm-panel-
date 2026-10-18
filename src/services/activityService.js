const { db } = require('../lib/db');

function logActivity({ user_id = null, vm_id = null, event, details = null, ip = null, user_agent = null }) {
  try {
    db.prepare(
      'INSERT INTO activity_logs (user_id, vm_id, event, details, ip, user_agent, created_at) VALUES (?,?,?,?,?,?,?)'
    ).run(user_id, vm_id, event, details ? JSON.stringify(details) : null, ip, user_agent, new Date().toISOString());
  } catch (e) { /* noop */ }
}

function logLogin({ user_id = null, ip, username, status }) {
  try {
    db.prepare(
      'INSERT INTO login_attempts (user_id, ip, username, status, created_at) VALUES (?,?,?,?,?)'
    ).run(user_id, ip, username, status, new Date().toISOString());
  } catch (e) { /* noop */ }
}

// ---------- human-readable detail rendering ----------
// The log views used to print JSON.stringify(details), so a transfer read
// `{"from":1,"to":13,"target_username":"Aakash"}` and every numeric users.id in
// the payload was meaningless to the person reading it. Details are rendered
// here, once, so all three views agree and no raw JSON reaches the page.

// Keys whose value is a users.id. A bare number is not a useful audit entry.
const USER_ID_KEYS = new Set([
  'from', 'to', 'user_id', 'owner_id', 'target_id', 'admin_id', 'actor_id', 'removed_user_id',
]);

const KEY_LABELS = {
  from: 'From', to: 'To',
  target_id: 'User', target_username: 'User',
  admin_id: 'Admin', user_id: 'User', owner_id: 'Owner',
  username: 'Username', reason: 'Reason', permissions: 'Permissions',
  plan: 'Plan', plan_name: 'Plan', key_prefix: 'Key', prefix: 'Key',
  memory: 'Memory', cpus: 'CPUs', disk_size: 'Disk size', hostname: 'Hostname',
  os_type: 'OS', node: 'Node', node_id: 'Node', size: 'Size', name: 'Name',
  amount: 'Amount', coupon: 'Coupon', method: 'Method', ip: 'IP',
};

function humanizeKey(k) {
  if (KEY_LABELS[k]) return KEY_LABELS[k];
  const s = String(k).replace(/_id$/, '').replace(/_/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : String(k);
}

function isBlank(v) {
  if (v === null || v === undefined || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

function formatValue(key, v, names) {
  if (USER_ID_KEYS.has(key) && /^\d+$/.test(String(v))) {
    return names.get(Number(v)) || `user #${v}`;
  }
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) {
    return v.map((x) => (x && typeof x === 'object' ? Object.keys(x).join(', ') : String(x))).join(', ');
  }
  if (v && typeof v === 'object') {
    return Object.entries(v)
      .map(([k2, v2]) => `${humanizeKey(k2)} ${formatValue(k2, v2, names)}`)
      .join(', ');
  }
  const s = String(v);
  return s.length > 140 ? `${s.slice(0, 137)}...` : s;
}

// Events that read far better as a sentence than as a field list. Everything
// not listed falls through to the generic renderer, so a new event never ends
// up as raw JSON.
const PHRASES = {
  'vm:transfer_owner': (d, n) => `Ownership transferred to ${d.target_username || n(d.to) || `user #${d.to}`}`
    + (d.from ? ` (was ${n(d.from) || `user #${d.from}`})` : ''),
  'admin:impersonation_start': (d, n) => `Started impersonating ${d.target_username || n(d.target_id) || 'a user'}`
    + (d.reason ? ` — ${d.reason}` : ''),
  'admin:impersonation_end': (d, n) => `Stopped impersonating ${n(d.target_id) || 'a user'}`,
  'user:impersonation_by_admin': (d, n) => `Impersonated by admin ${n(d.admin_id) || 'unknown'}`,
  'auth:login': () => 'Signed in',
  'auth:logout': () => 'Signed out',
  'auth:login_failed': (d) => `Failed sign-in${d.username ? ` for ${d.username}` : ''}`,
  'auth:register': (d) => `Registered${d.username ? ` as ${d.username}` : ''}`,
};

// The event column showed the raw token (`vm:transfer_owner`). Keep the token
// in the tooltip for anyone filtering or debugging, but label the pill so the
// column reads as English.
const EVENT_NS_LABEL = {
  vm: 'Server', auth: 'Auth', admin: 'Admin', billing: 'Billing', account: 'Account',
  api_key: 'API key', profile: 'Profile', subuser: 'Subuser', schedule: 'Schedule',
  backup: 'Backup', user: 'User',
};
const EVENT_NS = new Set(Object.keys(EVENT_NS_LABEL));

function humanizeEvent(event) {
  const s = String(event || '');
  if (!s) return '';
  const parts = s.split(':');
  const ns = EVENT_NS.has(parts[0]) && parts.length > 1 ? parts.shift() : '';
  const words = parts.join(':').replace(/_/g, ' ').replace(/:\s*/g, ': ')
    .split(' ').filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  const rest = words.join(' ');
  if (!ns) return rest || s;
  return `${EVENT_NS_LABEL[ns]} · ${rest}`;
}

function describeActivity(event, details, names) {
  if (!details) return '';
  const n = (id) => (id === null || id === undefined || id === '' ? '' : names.get(Number(id)) || '');
  const phrase = PHRASES[event];
  if (phrase) {
    try {
      const out = String(phrase(details, n) || '').trim();
      if (out) return out;
    } catch (_) { /* fall through to the generic form */ }
  }
  return Object.entries(details)
    .filter(([, v]) => !isBlank(v))
    .map(([k, v]) => `${humanizeKey(k)}: ${formatValue(k, v, names)}`)
    .join(' · ');
}

// One query for the whole page, so a log full of user ids costs a single
// lookup instead of one per row.
function resolveUserNames(rows) {
  const ids = new Set();
  for (const r of rows) {
    if (!r.details || typeof r.details !== 'object') continue;
    for (const [k, v] of Object.entries(r.details)) {
      if (USER_ID_KEYS.has(k) && !isBlank(v) && /^\d+$/.test(String(v))) ids.add(Number(v));
    }
  }
  const names = new Map();
  if (!ids.size) return names;
  const list = Array.from(ids);
  try {
    const found = db.prepare(
      `SELECT id, username FROM users WHERE id IN (${list.map(() => '?').join(',')})`
    ).all(...list);
    for (const u of found) names.set(Number(u.id), u.username);
  } catch (_) { /* leave the ids to render as user #n */ }
  return names;
}

function listActivity({ user_id = null, vm_id = null, limit = 100, offset = 0 }) {
  let sql = `
    SELECT a.*, u.username, v.name as vm_name
    FROM activity_logs a
    LEFT JOIN users u ON u.id = a.user_id
    LEFT JOIN vms v ON v.id = a.vm_id
    WHERE 1=1`;
  const params = [];
  if (user_id) { sql += ' AND a.user_id = ?'; params.push(user_id); }
  if (vm_id) { sql += ' AND a.vm_id = ?'; params.push(vm_id); }
  sql += ' ORDER BY a.id DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  const rows = db.prepare(sql).all(...params);
  for (const r of rows) {
    try { r.details = JSON.parse(r.details); } catch (_) { r.details = null; }
  }
  const names = resolveUserNames(rows);
  for (const r of rows) {
    r.details_text = describeActivity(r.event, r.details, names);
    r.event_label = humanizeEvent(r.event);
  }
  return rows;
}

function listLoginHistory({ user_id = null, limit = 100, offset = 0 }) {
  let sql = 'SELECT * FROM login_attempts WHERE 1=1';
  const params = [];
  if (user_id) { sql += ' AND user_id = ?'; params.push(user_id); }
  sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(sql).all(...params);
}

function recentLogin(userId) {
  return db.prepare(
    'SELECT * FROM login_attempts WHERE user_id = ? ORDER BY id DESC LIMIT 1'
  ).get(userId) || null;
}

module.exports = {
  logActivity, logLogin, listActivity, listLoginHistory, recentLogin,
  describeActivity, humanizeKey, humanizeEvent,
};
