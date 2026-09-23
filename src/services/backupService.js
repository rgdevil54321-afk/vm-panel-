const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { db, settings } = require('../lib/db');
const config = require('../lib/config');
const logger = require('../lib/logger');
const vmService = require('./vmService');
const { logActivity } = require('./activityService');

const BACKUP_DIR = config.uploads.backup;
fs.mkdirSync(BACKUP_DIR, { recursive: true });

function listForVm(vmId) {
  return db.prepare('SELECT * FROM backups WHERE vm_id = ? ORDER BY id DESC').all(vmId);
}

function getSlotLimit(vm) {
  const v = vm && vm.backup_slots;
  if (v != null && !isNaN(Number(v))) return Math.max(0, Number(v));
  return parseInt(settings.get('vm.default_backup_slots') || '5', 10);
}

function countFor(vmId) {
  return db.prepare('SELECT COUNT(*) AS c FROM backups WHERE vm_id = ?').get(vmId).c || 0;
}

function slotsFor(vmId) {
  const vm = vmService.getVm(vmId);
  return { slots: getSlotLimit(vm), used: countFor(vmId), free: Math.max(0, getSlotLimit(vm) - countFor(vmId)) };
}

function listAll() {
  return db.prepare(
    `SELECT b.*, v.name AS vm_name FROM backups b JOIN vms v ON v.id = b.vm_id ORDER BY b.id DESC`
  ).all();
}

function createBackup(vm, { user = null, name = null, kind = 'full' } = {}) {
  const slots = getSlotLimit(vm);
  if (slots === 0) {
    throw new Error('Backup slots are disabled for this machine (0 slots). Enable slots or edit the VM to raise the limit.');
  }
  if (countFor(vm.id) >= slots) {
    // enforce the slot limit by rotating out the oldest backup
    pruneBackups(vm.id, slots - 1);
  }
  if (vmService.isRunning(vm)) {
    // snapshot via qemu-img works on live (qcow2) too
    logger.info('[backup] VM is running; taking qemu snapshot');
  }
  const label = name || `backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const vmBackupDir = path.join(BACKUP_DIR, String(vm.id));
  fs.mkdirSync(vmBackupDir, { recursive: true });
  const dest = path.join(vmBackupDir, `${label}.qcow2`);
  const r = spawnSync('qemu-img', ['convert', '-U', '-O', 'qcow2', vm.img_file, dest], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || 'Backup conversion failed');
  const size = fs.statSync(dest).size;
  const info = db.prepare(
    'INSERT INTO backups (vm_id, name, file, size, kind, created_at) VALUES (?,?,?,?,?,?)'
  ).run(vm.id, label, dest, size, kind, new Date().toISOString());
  logActivity({ user_id: user ? user.id : null, vm_id: vm.id, event: 'backup:create', details: { name: label } });
  return db.prepare('SELECT * FROM backups WHERE id = ?').get(Number(info.lastInsertRowid));
}

function restoreBackup(backup, { user = null } = {}) {
  const vm = vmService.getVm(backup.vm_id);
  if (!vm) throw new Error('VM not found');
  if (vmService.isRunning(vm)) {
    vmService.stop(vm, { user, force: true });
  }
  if (!fs.existsSync(backup.file)) throw new Error('Backup file missing');
  const tmp = vm.img_file + '.restore';
  fs.copyFileSync(backup.file, tmp);
  fs.renameSync(tmp, vm.img_file);
  db.prepare('UPDATE vms SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), vm.id);
  logActivity({ user_id: user ? user.id : null, vm_id: vm.id, event: 'backup:restore', details: { name: backup.name } });
  return true;
}

function deleteBackup(backup, { user = null } = {}) {
  try { fs.unlinkSync(backup.file); } catch (_) {}
  try {
    fs.rmdirSync(path.dirname(backup.file));
  } catch (_) {}
  db.prepare('DELETE FROM backups WHERE id = ?').run(backup.id);
  logActivity({ user_id: user ? user.id : null, vm_id: backup.vm_id, event: 'backup:delete', details: { name: backup.name } });
  return true;
}

function pruneBackups(vmId, keep = 5) {
  const rows = db.prepare('SELECT id FROM backups WHERE vm_id = ? ORDER BY id DESC').all(vmId);
  if (rows.length <= keep) return;
  for (const row of rows.slice(keep)) {
    const b = db.prepare('SELECT * FROM backups WHERE id = ?').get(row.id);
    deleteBackup(b);
  }
}

module.exports = { listForVm, listAll, createBackup, restoreBackup, deleteBackup, pruneBackups, getSlotLimit, countFor, slotsFor };
