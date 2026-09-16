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

function createPlan(data) {
  db.prepare(
    'INSERT INTO billing_plans (name, description, price, currency, max_vms, max_cpu, max_mem_mb, max_disk_gb, active, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
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
    new Date().toISOString()
  );
  return db.prepare('SELECT * FROM billing_plans ORDER BY id DESC LIMIT 1').get();
}

function updatePlan(id, data) {
  const plan = getPlan(id);
  if (!plan) return null;
  db.prepare(
    'UPDATE billing_plans SET name = ?, description = ?, price = ?, currency = ?, max_vms = ?, max_cpu = ?, max_mem_mb = ?, max_disk_gb = ?, active = ? WHERE id = ?'
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

module.exports = {
  listPlans, getPlan, createPlan, updatePlan, deletePlan, applyPlanToUser,
  listInvoices, createInvoice, markInvoicePaid, deleteInvoice,
  listCoupons, getCoupon, createCoupon, deleteCoupon, redeemCoupon,
};