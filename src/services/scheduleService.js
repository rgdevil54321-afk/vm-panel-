const cron = require('node-cron');
const { db } = require('../lib/db');
const logger = require('../lib/logger');
const vmService = require('./vmService');
const backupService = require('./backupService');
const { logActivity } = require('./activityService');

const jobs = new Map();

function toCron(text) {
  let t = String(text).trim();
  // accept simple presets like "*/5 * * * *"
  if (/^(\S+\s+){4}\S+$/.test(t)) return t;
  const presets = {
    hourly: '0 * * * *',
    daily: '0 2 * * *',
    weekly: '0 2 * * 0',
    monthly: '0 2 1 * *',
  };
  if (presets[t]) return presets[t];
  return null;
}

function runJob(schedule, vm) {
  return async () => {
    const sched = db.prepare('SELECT * FROM schedules WHERE id = ?').get(schedule.id);
    if (!sched || !sched.enabled) return;
    const curVm = vmService.getVm(sched.vm_id);
    if (!curVm) return;
    logger.info(`[cron] running "${sched.name}" (${sched.action}) for ${curVm.name}`);
    try {
      if (sched.action === 'start') await vmService.start(curVm);
      else if (sched.action === 'stop') vmService.stop(curVm);
      else if (sched.action === 'restart') await vmService.restart(curVm);
      else if (sched.action === 'backup') backupService.createBackup(curVm, { name: `sched-${Date.now()}` });
      db.prepare('UPDATE schedules SET last_run_at = ? WHERE id = ?').run(new Date().toISOString(), sched.id);
      logActivity({ vm_id: curVm.id, event: 'schedule:run', details: { name: sched.name, action: sched.action } });
    } catch (e) {
      logger.error('[cron] job error: ' + e.message);
    }
  };
}

function register(schedule) {
  unregister(schedule.id);
  const vm = vmService.getVm(schedule.vm_id);
  if (!vm || !schedule.enabled) return;
  const cronExpr = toCron(schedule.cron);
  if (!cronExpr) {
    logger.warn(`[cron] invalid expression for "${schedule.name}"`);
    return;
  }
  if (!cron.validate(cronExpr)) {
    logger.warn(`[cron] invalid cron "${schedule.cron}"`);
    return;
  }
  try {
    const task = cron.schedule(cronExpr, runJob(schedule, vm), { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    jobs.set(schedule.id, task);
    logger.info(`[cron] registered "${schedule.name}" ${cronExpr}`);
  } catch (e) {
    logger.error('[cron] register error: ' + e.message);
  }
}

function unregister(id) {
  const t = jobs.get(id);
  if (t) {
    t.stop();
    jobs.delete(id);
  }
}

function loadAll() {
  for (const s of db.prepare('SELECT * FROM schedules WHERE enabled = 1').all()) {
    register(s);
  }
}

function reload() {
  for (const id of jobs.keys()) unregister(id);
  loadAll();
}

function add(data, user) {
  const cronExpr = toCron(data.cron);
  if (!cronExpr) throw new Error('Invalid cron expression');
  if (!['start', 'stop', 'restart', 'backup'].includes(data.action)) throw new Error('Invalid action');
  const info = db.prepare(
    'INSERT INTO schedules (vm_id, name, cron, action, enabled, created_at) VALUES (?,?,?,?,?,?)'
  ).run(data.vm_id, data.name, cronExpr, data.action, data.enabled ? 1 : 0, new Date().toISOString());
  const sched = db.prepare('SELECT * FROM schedules WHERE id = ?').get(Number(info.lastInsertRowid));
  register(sched);
  logActivity({ user_id: user ? user.id : null, vm_id: data.vm_id, event: 'schedule:create', details: data });
  return sched;
}

function update(id, data, user) {
  const sched = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id);
  if (!sched) throw new Error('Schedule not found');
  const cronExpr = data.cron ? toCron(data.cron) : sched.cron;
  db.prepare('UPDATE schedules SET name = ?, cron = ?, action = ?, enabled = ? WHERE id = ?')
    .run(
      data.name ?? sched.name,
      cronExpr,
      data.action ?? sched.action,
      data.enabled !== undefined ? (data.enabled ? 1 : 0) : sched.enabled,
      id
    );
  const updated = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id);
  register(updated);
  logActivity({ user_id: user ? user.id : null, vm_id: sched.vm_id, event: 'schedule:update', details: data });
  return updated;
}

function remove(id, user) {
  const sched = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id);
  if (!sched) throw new Error('Schedule not found');
  unregister(id);
  db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
  logActivity({ user_id: user ? user.id : null, vm_id: sched.vm_id, event: 'schedule:delete', details: { name: sched.name } });
  return true;
}

module.exports = { add, update, remove, register, unregister, loadAll, reload, toCron };
