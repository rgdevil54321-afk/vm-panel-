const { db, settings } = require('../lib/db');
const logger = require('../lib/logger');
const vmService = require('./vmService');

let timer = null;

// Suspends machines whose expires_at has passed. Uses the same suspended_at
// flag as plan enforcement so ordinary owners cannot start them until renewed.
async function check() {
  if (String(settings.get('machine.expiry_enabled') || '1') === '0') return;
  const nowIso = new Date().toISOString();
  const rows = db.prepare(
    "SELECT id FROM vms WHERE expires_at IS NOT NULL AND expires_at != '' AND expires_at <= ?"
  ).all(nowIso);
  for (const r of rows) {
    let vm;
    try {
      vm = vmService.getVm(r.id);
    } catch (_) { continue; }
    if (!vm || !vm.expiry || !vm.expiry.expired) continue;
    try {
      if (!vm.suspended_at) {
        db.prepare('UPDATE vms SET suspended_at = ?, updated_at = ? WHERE id = ?').run(nowIso, nowIso, vm.id);
      }
      if (vmService.isRunning(vm)) await vmService.stop(vm, { force: true });
    } catch (e) {
      logger.warn(`[expiry] vm#${vm.id} suspend failed: ${e.message}`);
    }
  }
}

function start(intervalMs) {
  if (timer) clearInterval(timer);
  timer = setInterval(() => { check().catch(() => {}); }, intervalMs || 60000);
  // first sweep shortly after boot
  setTimeout(() => { check().catch(() => {}); }, 5000);
  return timer;
}

module.exports = { start, check };