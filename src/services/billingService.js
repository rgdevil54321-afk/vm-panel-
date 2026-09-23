const { db } = require('../lib/db');

// ---------- Plans ----------
function listPlans(activeOnly = false) {
  let sql = 'SELECT * FROM billing_plans';
  if (activeOnly) sql += ' WHERE active = 1';
  sql += ' ORDER BY price ASC, id ASC';
  return db.prepare(sql).all();
}

function getPlan(id) {
  return db.prepare('SELECT * FROM billing_plans WHERE id = ?').get(Number(id));
}

// ---------- Plans ----------
const PLAN_KINDS = ['invite', 'booster', 'paid', 'free'];
const VPS_TYPES = ['kvm', 'nat', 'storage', 'highcpu', 'gaming', 'backup'];

function planOfUser(userId) {
  const u = db.prepare('SELECT plan_id FROM users WHERE id = ?').get(Number(userId));
  if (!u || !u.plan_id) return null;
  return db.prepare('SELECT * FROM billing_plans WHERE id = ?').get(u.plan_id);
}

function createPlan(data) {
  const kind = PLAN_KINDS.includes(data.kind) ? data.kind : 'paid';
  const vpsType = VPS_TYPES.includes(String(data.vps_type || '').toLowerCase()) ? String(data.vps_type).toLowerCase() : 'kvm';
  db.prepare(
    'INSERT INTO billing_plans (name, description, price, currency, max_vms, max_cpu, max_mem_mb, max_disk_gb, active, created_at, kind, invites_required, boost_required, grace_days, duration_days, ip_include, renewable, vps_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(
    String(data.name || '').trim(),
    String(data.description || ''),
    parseFloat(data.price) || 0,
    String(data.currency || 'credits'),
    data.max_vms !== undefined && data.max_vms !== '' ? parseInt(data.max_vms, 10) : -1,
    data.max_cpu !== undefined && data.max_cpu !== '' ? parseInt(data.max_cpu, 10) : -1,
    data.max_mem_mb !== undefined && data.max_mem_mb !== '' ? parseInt(data.max_mem_mb, 10) : -1,
    data.max_disk_gb !== undefined && data.max_disk_gb !== '' ? parseInt(data.max_disk_gb, 10) : -1,
    data.active === undefined || data.active === true || data.active === 1 || data.active === '1' ? 1 : 0,
    new Date().toISOString(),
    kind,
    parseInt(data.invites_required, 10) > 0 ? parseInt(data.invites_required, 10) : 0,
    data.boost_required === true || data.boost_required === 1 || data.boost_required === '1' ? 1 : 0,
    parseInt(data.grace_days, 10) > 0 ? parseInt(data.grace_days, 10) : 5,
    parseInt(data.duration_days, 10) > 0 ? parseInt(data.duration_days, 10) : 30,
    String(data.ip_include || 'ipv4_shared').slice(0, 64),
    data.renewable === false || data.renewable === 0 || data.renewable === '0' ? 0 : 1,
    vpsType
  );
  return db.prepare('SELECT * FROM billing_plans ORDER BY id DESC LIMIT 1').get();
}

function updatePlan(id, data) {
  const plan = getPlan(id);
  if (!plan) return null;
  db.prepare(
    'UPDATE billing_plans SET name = ?, description = ?, price = ?, currency = ?, max_vms = ?, max_cpu = ?, max_mem_mb = ?, max_disk_gb = ?, active = ?, kind = ?, invites_required = ?, boost_required = ?, grace_days = ?, duration_days = ?, ip_include = ?, renewable = ?, vps_type = ? WHERE id = ?'
  ).run(
    String(data.name !== undefined ? data.name : plan.name).trim(),
    String(data.description !== undefined ? data.description : plan.description || ''),
    data.price !== undefined ? parseFloat(data.price) || 0 : plan.price,
    String(data.currency !== undefined ? data.currency : plan.currency || 'credits'),
    data.max_vms !== undefined && data.max_vms !== '' ? parseInt(data.max_vms, 10) : plan.max_vms,
    data.max_cpu !== undefined && data.max_cpu !== '' ? parseInt(data.max_cpu, 10) : plan.max_cpu,
    data.max_mem_mb !== undefined && data.max_mem_mb !== '' ? parseInt(data.max_mem_mb, 10) : plan.max_mem_mb,
    data.max_disk_gb !== undefined && data.max_disk_gb !== '' ? parseInt(data.max_disk_gb, 10) : plan.max_disk_gb,
    data.active === undefined || data.active === true || data.active === 1 || data.active === '1' ? 1 : 0,
    data.kind !== undefined ? (PLAN_KINDS.includes(data.kind) ? data.kind : 'paid') : plan.kind,
    data.invites_required !== undefined ? (parseInt(data.invites_required, 10) > 0 ? parseInt(data.invites_required, 10) : 0) : plan.invites_required,
    data.boost_required !== undefined ? (data.boost_required === true || data.boost_required === 1 || data.boost_required === '1' ? 1 : 0) : plan.boost_required,
    data.grace_days !== undefined ? (parseInt(data.grace_days, 10) > 0 ? parseInt(data.grace_days, 10) : 5) : plan.grace_days,
    data.duration_days !== undefined ? (parseInt(data.duration_days, 10) > 0 ? parseInt(data.duration_days, 10) : 30) : plan.duration_days,
    data.ip_include !== undefined ? String(data.ip_include).slice(0, 64) : plan.ip_include,
    data.renewable !== undefined ? (data.renewable === false || data.renewable === 0 || data.renewable === '0' ? 0 : 1) : plan.renewable,
    data.vps_type !== undefined ? (VPS_TYPES.includes(String(data.vps_type).toLowerCase()) ? String(data.vps_type).toLowerCase() : plan.vps_type) : plan.vps_type,
    id
  );
  return getPlan(id);
}

function deletePlan(id) {
  return db.prepare('DELETE FROM billing_plans WHERE id = ?').run(Number(id)).changes > 0;
}

// Apply a plan to a user (sets their quota columns).
function applyPlanToUser(plan, user) {
  if (!plan) return false;
  db.prepare(
    'UPDATE users SET max_vms = ?, max_cpu = ?, max_mem_mb = ?, max_disk_gb = ? WHERE id = ?'
  ).run(plan.max_vms, plan.max_cpu, plan.max_mem_mb, plan.max_disk_gb, user.id);
  return true;
}

// ---------- Invoices ----------
function listInvoices(userId = null) {
  let sql = 'SELECT i.*, u.username FROM invoices i LEFT JOIN users u ON u.id = i.user_id';
  const params = [];
  if (userId) { sql += ' WHERE i.user_id = ?'; params.push(userId); }
  sql += ' ORDER BY i.id DESC LIMIT 500';
  return db.prepare(sql).all(...params);
}

function createInvoice(userId, data) {
  db.prepare(
    'INSERT INTO invoices (user_id, amount, currency, description, status, created_at) VALUES (?,?,?,?,?,?)'
  ).run(
    Number(userId),
    parseFloat(data.amount) || 0,
    String(data.currency || 'credits'),
    String(data.description || ''),
    'pending',
    new Date().toISOString()
  );
  return db.prepare('SELECT * FROM invoices ORDER BY id DESC LIMIT 1').get();
}

function markInvoicePaid(id, operator) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(Number(id));
  if (!inv) return null;
  if (inv.status === 'paid') return inv;
  db.prepare('UPDATE invoices SET status = ?, paid_at = ? WHERE id = ?').run(
    'paid', new Date().toISOString(), inv.id
  );
  // Credits are added to the user's balance.
  db.prepare('UPDATE users SET credits = credits + ? WHERE id = ?').run(inv.amount, inv.user_id);
  if (operator) {
    db.prepare('UPDATE invoices SET description = ? WHERE id = ?').run(
      (inv.description ? inv.description + ' ' : '') + '(paid by ' + operator.username + ')', inv.id
    );
  }
  return db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id);
}

function deleteInvoice(id) {
  return db.prepare('DELETE FROM invoices WHERE id = ?').run(Number(id)).changes > 0;
}

// ---------- Coupons ----------
function listCoupons() {
  return db.prepare('SELECT * FROM coupons ORDER BY id DESC').all();
}

function getCoupon(code) {
  return db.prepare('SELECT * FROM coupons WHERE lower(code) = lower(?)').get(String(code).trim());
}

function createCoupon(data) {
  if (!data.code || !String(data.code).trim()) throw new Error('Coupon code is required');
  db.prepare(
    'INSERT INTO coupons (code, type, value, valid_until, max_uses, uses, active, created_at) VALUES (?,?,?,?,?,0,?,?)'
  ).run(
    String(data.code).trim().toUpperCase(),
    String(data.type || 'credits'),
    parseFloat(data.value) || 0,
    data.valid_until ? String(data.valid_until) : null,
    data.max_uses !== undefined && data.max_uses !== '' ? parseInt(data.max_uses, 10) : 0,
    data.active === undefined || data.active === true || data.active === 1 || data.active === '1' ? 1 : 0,
    new Date().toISOString()
  );
  return db.prepare('SELECT * FROM coupons ORDER BY id DESC LIMIT 1').get();
}

function deleteCoupon(id) {
  return db.prepare('DELETE FROM coupons WHERE id = ?').run(Number(id)).changes > 0;
}

// Redeem a coupon for a user, returning the added amount.
function redeemCoupon(code, userId) {
  if (!code || !String(code).trim()) throw new Error('Enter a coupon code');
  const coupon = getCoupon(code);
  if (!coupon || !coupon.active) throw new Error('Invalid or inactive coupon');
  if (coupon.valid_until) {
    const until = new Date(coupon.valid_until).getTime();
    if (Number.isFinite(until) && until < Date.now()) throw new Error('This coupon has expired');
  }
  if (coupon.max_uses > 0 && coupon.uses >= coupon.max_uses) throw new Error('This coupon has reached its usage limit');

  const claimed = db.prepare('SELECT * FROM coupon_claims WHERE coupon_id = ? AND user_id = ?').get(coupon.id, Number(userId));
  if (claimed) throw new Error('You have already used this coupon');

  let amount = 0;
  if (coupon.type === 'percent') {
    // Percent bonus applied to the user's current balance.
    const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(Number(userId));
    const base = Number(user ? user.credits : 0);
    amount = Math.round(base * (coupon.value / 100) * 100) / 100;
  } else {
    amount = coupon.value;
  }

  db.prepare('UPDATE users SET credits = credits + ? WHERE id = ?').run(amount, Number(userId));
  db.prepare('UPDATE coupons SET uses = uses + 1 WHERE id = ?').run(coupon.id);
  db.prepare('INSERT INTO coupon_claims (coupon_id, user_id, claimed_at) VALUES (?,?,?)').run(
    coupon.id, Number(userId), new Date().toISOString()
  );
  return { amount, type: coupon.type, code: coupon.code };
}

// ---------- Plan assignments (invite / booster / paid sectors) ----------
function getUserPlanRow(id) {
  return db.prepare('SELECT * FROM user_plans WHERE id = ?').get(Number(id));
}

function listUserPlans() {
  return db.prepare(
    `SELECT up.*, u.username, u.email, u.discord_id, u.discord_name,
            p.name AS plan_name, p.kind AS plan_kind, p.invites_required, p.boost_required,
            p.grace_days, p.duration_days, p.ip_include, p.renewable, p.price
     FROM user_plans up
     JOIN users u ON u.id = up.user_id
     JOIN billing_plans p ON p.id = up.plan_id
     ORDER BY up.id DESC LIMIT 500`
  ).all();
}

function getActiveUserPlan(userId) {
  return db.prepare(
    `SELECT up.*, p.name AS plan_name, p.kind AS plan_kind, p.invites_required, p.boost_required,
            p.grace_days, p.duration_days, p.ip_include, p.renewable
     FROM user_plans up JOIN billing_plans p ON p.id = up.plan_id
     WHERE up.user_id = ? ORDER BY up.id DESC LIMIT 1`
  ).get(Number(userId)) || null;
}

function assignPlanToUser(user, plan, { assignedBy = null, days = null, inviteCode = null, note = '' } = {}) {
  if (!plan || !user) throw new Error('User and plan are required');
  applyPlanToUser(plan, user);
  const kind = plan.kind || 'paid';
  const dur = days && days > 0 ? days : (plan.duration_days > 0 ? plan.duration_days : parseInt(require('./db').settings.get('plans.default_renew_days') || '30', 10));
  const expires = kind === 'paid' ? new Date(Date.now() + dur * 86400000).toISOString() : null;
  db.prepare(
    `INSERT INTO user_plans (user_id, plan_id, assigned_by, assigned_at, expires_at, renewals, status, note, invite_code)
     VALUES (?,?,?,?,?,0,'active',?,?)`
  ).run(user.id, plan.id, assignedBy, new Date().toISOString(), expires, String(note || ''), inviteCode ? String(inviteCode).trim() : null);
  const id = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
  db.prepare('UPDATE users SET plan_id = ? WHERE id = ?').run(plan.id, user.id);
  // A fresh assignment always lifts any previous suspension.
  require('./vmService').setUserVmsUnsuspended(user.id).catch(() => {});
  return getUserPlanRow(id);
}

function renewUserPlan(userPlanId, days = null, operatorId = null) {
  const up = getUserPlanRow(userPlanId);
  if (!up) return null;
  const plan = getPlan(up.plan_id);
  const addDays = days && days > 0 ? days : (plan && plan.duration_days > 0 ? plan.duration_days : parseInt(require('./db').settings.get('plans.default_renew_days') || '30', 10));
  let base = up.expires_at ? new Date(up.expires_at) : new Date();
  if (base.getTime() < Date.now()) base = new Date();
  base.setDate(base.getDate() + addDays);
  db.prepare(
    `UPDATE user_plans SET expires_at = ?, status = 'active', warned_at = NULL, suspended_at = NULL,
       renewals = renewals + 1, assigned_by = COALESCE(?, assigned_by), last_check_ok = 1,
       last_check_detail = 'renewed for ' || ? || ' days'
     WHERE id = ?`
  ).run(base.toISOString(), operatorId, addDays, userPlanId);
  require('./vmService').setUserVmsUnsuspended(up.user_id).catch(() => {});
  return getUserPlanRow(userPlanId);
}

function cancelUserPlan(userPlanId) {
  const up = getUserPlanRow(userPlanId);
  if (!up) return false;
  db.prepare("UPDATE user_plans SET status = 'cancelled' WHERE id = ?").run(userPlanId);
  return true;
}

function setUserPlanStatus(userPlanId, status, detail = '') {
  const up = getUserPlanRow(userPlanId);
  if (!up) return false;
  db.prepare('UPDATE user_plans SET status = ?, last_check_at = ?, last_check_detail = ? WHERE id = ?')
    .run(status, new Date().toISOString(), String(detail).slice(0, 200), userPlanId);
}

function logPlanCheck(userPlanId, userId, ok, detail) {
  db.prepare('INSERT INTO plan_checks (user_plan_id, user_id, ok, detail, created_at) VALUES (?,?,?,?,?)')
    .run(userPlanId, Number(userId), ok ? 1 : 0, String(detail || '').slice(0, 300), new Date().toISOString());
}

function notifyUser(userId, title, body) {
  try {
    db.prepare('INSERT INTO notifications (user_id, title, body, created_at) VALUES (?,?,?,?)')
      .run(Number(userId), String(title), String(body), new Date().toISOString());
  } catch (_) {}
}

module.exports = {
  listPlans, getPlan, createPlan, updatePlan, deletePlan, applyPlanToUser,
  listInvoices, createInvoice, markInvoicePaid, deleteInvoice,
  listCoupons, getCoupon, createCoupon, deleteCoupon, redeemCoupon,
  listUserPlans, getActiveUserPlan, getUserPlanRow, assignPlanToUser, renewUserPlan,
  cancelUserPlan, setUserPlanStatus, logPlanCheck, notifyUser,
};