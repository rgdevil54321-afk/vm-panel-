const express = require('express');
const path = require('path');
const qrcode = require('qrcode');
const config = require('../lib/config');
const { db, settings } = require('../lib/db');
const vmService = require('../services/vmService');
const bootLogService = require('../services/bootLogService');
const backupService = require('../services/backupService');
const authService = require('../services/authService');
const activity = require('../services/activityService');
const { requireAuth } = require('../middleware/auth');
const { uploadAvatar } = require('../middleware/upload');
const router = express.Router();

router.use(requireAuth);

function render(res, view, vars = {}) {
  res.render(`user/${view}`, {
    page: view,
    user: res.req.user,
    settings: settings.all(),
    ...vars,
  });
}

function myVms(user) {
  return db.prepare(
    'SELECT v.* FROM vms v WHERE v.owner_id = ? ORDER BY v.id DESC'
  ).all(user.id).map(vmService.serializeVm);
}

function loadVm(req, res, next) {
  const vm = vmService.getVm(parseInt(req.params.id, 10));
  if (!vm || !vmService.canAccess(req.user, vm)) {
    return res.status(404).render('error/404', {
      code: 404, title: 'Not Found', message: 'Server not found or no access.',
      settings: settings.all(), user: req.user,
    });
  }
  const owner = db.prepare('SELECT username, email FROM users WHERE id = ?').get(vm.owner_id);
  if (owner) {
    vm.owner_name = owner.username;
    vm.owner_email = owner.email;
  }
  req.vm = vm;
  next();
}

router.get('/dashboard', (req, res) => {
  const vms = myVms(req.user);
  const subVms = db.prepare(
    'SELECT v.* FROM subusers s JOIN vms v ON v.id = s.vm_id WHERE s.user_id = ?'
  ).all(req.user.id).map(vmService.serializeVm);
  const running = [...vms, ...subVms].filter((v) => v.status === 'running').length;
  const recentActivity = activity.listActivity({ user_id: req.user.id, limit: 8 });
  render(res, 'dashboard', { vms, subVms, running, recentActivity });
});

router.get('/servers/:id', loadVm, (req, res) => {
  const allUsers = (req.user.role === 'admin' || req.user.root_admin)
    ? db.prepare('SELECT id, username, email FROM users ORDER BY username').all()
    : [];
  render(res, 'server/overview', { vm: req.vm, backups: backupService.listForVm(req.vm.id), allUsers });
});

router.get('/servers/:id/overview', loadVm, (req, res) => {
  const allUsers = (req.user.role === 'admin' || req.user.root_admin)
    ? db.prepare('SELECT id, username, email FROM users ORDER BY username').all()
    : [];
  render(res, 'server/overview', { vm: req.vm, backups: backupService.listForVm(req.vm.id), allUsers });
});

router.get('/servers/:id/status', loadVm, (req, res) => {
  res.json({ ok: true, stats: vmService.liveStats(req.vm) });
});

router.get('/servers/:id/console', loadVm, (req, res) => {
  render(res, 'server/console', { vm: req.vm });
});

router.get('/servers/:id/bootlog', loadVm, (req, res) => {
  res.json({ ok: true, log: vmService.getBootLog(req.vm) });
});

router.get('/servers/:id/bootlog/stream', loadVm, (req, res) => {
  bootLogService.handleSseStream(req, res, req.vm);
});

router.post('/servers/:id/bootlog/clear', loadVm, (req, res) => {
  bootLogService.clearBootLogs(req.vm);
  res.json({ ok: true });
});

router.get('/servers/:id/files', loadVm, (req, res) => {
  render(res, 'server/files', { vm: req.vm });
});

router.get('/servers/:id/backups', loadVm, (req, res) => {
  render(res, 'server/backups', { vm: req.vm, backups: backupService.listForVm(req.vm.id) });
});

router.get('/servers/:id/schedules', loadVm, (req, res) => {
  const schedules = db.prepare('SELECT * FROM schedules WHERE vm_id = ? ORDER BY id DESC').all(req.vm.id);
  render(res, 'server/schedules', { vm: req.vm, schedules });
});

router.get('/servers/:id/startup', loadVm, (req, res) => {
  render(res, 'server/startup', { vm: req.vm });
});

router.get('/servers/:id/settings', loadVm, (req, res) => {
  render(res, 'server/settings', { vm: req.vm });
});

router.get('/servers/:id/subusers', loadVm, (req, res) => {
  const subs = db.prepare(
    'SELECT s.*, u.username, u.email FROM subusers s JOIN users u ON u.id = s.user_id WHERE s.vm_id = ? ORDER BY s.id DESC'
  ).all(req.vm.id);
  const allUsers = db.prepare('SELECT id, username, email FROM users WHERE id != ? ORDER BY username').all(req.vm.owner_id || 0);
  render(res, 'server/subusers', { vm: req.vm, subs, allUsers });
});

router.get('/servers/:id/activity', loadVm, (req, res) => {
  const logs = activity.listActivity({ vm_id: req.vm.id, limit: 200 });
  render(res, 'server/activity', { vm: req.vm, logs });
});

router.post('/servers/:id/power', loadVm, express.json(), async (req, res) => {
  const action = req.body.action;
  try {
    if (action === 'start') {
      const vmDir = vmService.VM_DIR;
      void vmDir;
      await vmService.start(req.vm, { user: req.user });
      return res.json({ ok: true, status: 'running' });
    }
    if (action === 'stop') {
      await vmService.stop(req.vm, { user: req.user });
      return res.json({ ok: true, status: 'stopped' });
    }
    if (action === 'kill') {
      await vmService.stop(req.vm, { user: req.user, force: true });
      return res.json({ ok: true, status: 'stopped' });
    }
    if (action === 'restart') {
      await vmService.restart(req.vm, req.user);
      return res.json({ ok: true, status: 'running' });
    }
    if (action === 'tmate') {
      // Remote SSH via tmate — works from anywhere, no port forwarding needed
      const regen = !!(req.body && req.body.regen);
      if (!vmService.canAccess(req.user, req.vm, 'power')) {
        return res.status(403).json({ error: 'No permission for this server' });
      }
      return res.json({ ok: true, ssh: await vmService.getTmateSsh(req.vm, regen) });
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/servers/:id/settings', loadVm, express.json(), (req, res) => {
  try {
    const vm = vmService.update(req.vm, req.body, req.user);
    return res.json({ ok: true, vm });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/servers/:id/resize', loadVm, express.json(), async (req, res) => {
  try {
    const vm = await vmService.resizeDisk(req.vm, req.body.disk_size, req.user);
    return res.json({ ok: true, vm });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/servers/:id/backups', loadVm, express.json(), (req, res) => {
  try {
    const backup = backupService.createBackup(req.vm, { user: req.user, name: req.body.name });
    return res.json({ ok: true, backup });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/servers/:id/backups/:bid/restore', loadVm, (req, res) => {
  try {
    const backup = db.prepare('SELECT * FROM backups WHERE id = ? AND vm_id = ?').get(req.params.bid, req.vm.id);
    if (!backup) return res.status(404).json({ error: 'Backup not found' });
    backupService.restoreBackup(backup, { user: req.user });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/servers/:id/backups/:bid/delete', loadVm, (req, res) => {
  try {
    const backup = db.prepare('SELECT * FROM backups WHERE id = ? AND vm_id = ?').get(req.params.bid, req.vm.id);
    if (!backup) return res.status(404).json({ error: 'Backup not found' });
    backupService.deleteBackup(backup, { user: req.user });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/servers/:id/backups/:bid/download', loadVm, (req, res) => {
  const backup = db.prepare('SELECT * FROM backups WHERE id = ? AND vm_id = ?').get(req.params.bid, req.vm.id);
  if (!backup) return res.status(404).send('Backup not found');
  res.download(backup.file, `${req.vm.name}-${backup.name}.qcow2`);
});

router.post('/servers/:id/schedules', loadVm, express.json(), (req, res) => {
  try {
    const scheduleService = require('../services/scheduleService');
    const sched = scheduleService.add({ ...req.body, vm_id: req.vm.id }, req.user);
    return res.json({ ok: true, schedule: sched });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/servers/:id/schedules/:sid/delete', loadVm, (req, res) => {
  try {
    const scheduleService = require('../services/scheduleService');
    const sched = db.prepare('SELECT * FROM schedules WHERE id = ? AND vm_id = ?').get(req.params.sid, req.vm.id);
    if (!sched) return res.status(404).json({ error: 'Schedule not found' });
    scheduleService.remove(sched.id, req.user);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/servers/:id/subusers', loadVm, express.json(), (req, res) => {
  try {
    const { user_id, permissions } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    if (Number(user_id) === req.vm.owner_id) return res.status(400).json({ error: 'Owner cannot be a subuser' });
    const exists = db.prepare('SELECT id FROM subusers WHERE vm_id = ? AND user_id = ?').get(req.vm.id, user_id);
    if (exists) return res.status(400).json({ error: 'User already has access to this server' });
    db.prepare(
      'INSERT INTO subusers (vm_id, user_id, permissions, created_at) VALUES (?,?,?,?)'
    ).run(req.vm.id, user_id, JSON.stringify(permissions || ['*']), new Date().toISOString());
    activity.logActivity({ user_id: req.user.id, vm_id: req.vm.id, event: 'subuser:add', details: { user_id } });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/servers/:id/subusers/:sid/delete', loadVm, (req, res) => {
  try {
    db.prepare('DELETE FROM subusers WHERE id = ? AND vm_id = ?').run(req.params.sid, req.vm.id);
    activity.logActivity({ user_id: req.user.id, vm_id: req.vm.id, event: 'subuser:remove' });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/servers/:id/transfer', loadVm, express.json(), (req, res) => {
  if (req.user.role !== 'admin' && !req.user.root_admin && req.vm.owner_id !== req.user.id) {
    return res.status(403).json({ error: 'Only server owner or administrators can transfer ownership' });
  }
  const { owner_id } = req.body;
  if (!owner_id) return res.status(400).json({ error: 'Owner ID is required' });
  try {
    const updated = vmService.transferOwner(req.vm, parseInt(owner_id, 10), req.user);
    res.json({ ok: true, vm: vmService.serializeVm(updated) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/servers/:id/delete', loadVm, async (req, res) => {
  if (req.vm.owner_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the owner can delete this server' });
  }
  try {
    await vmService.remove(req.vm, req.user);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.get('/profile', (req, res) => {
  const loginHistory = activity.listLoginHistory({ user_id: req.user.id, limit: 50 });
  render(res, 'profile', { loginHistory });
});

router.post('/profile', express.urlencoded({ extended: true }), (req, res) => {
  try {
    const data = {};
    if (req.body.name !== undefined) data.name = req.body.name;
    if (req.body.email) data.email = req.body.email;
    if (req.body.language) data.language = req.body.language;
    authService.updateUser(req.user.id, data);
    return render(res, 'profile', {
      success: 'Profile updated!',
      loginHistory: activity.listLoginHistory({ user_id: req.user.id, limit: 50 }),
    });
  } catch (e) {
    return render(res, 'profile', {
      error: e.message,
      loginHistory: activity.listLoginHistory({ user_id: req.user.id, limit: 50 }),
    });
  }
});

router.post('/profile/avatar', uploadAvatar.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const url = `/uploads/avatar/${req.file.filename}`;
  authService.updateUser(req.user.id, { avatar: url });
  return res.json({ ok: true, avatar: url });
});

router.post('/profile/password', express.json(), (req, res) => {
  const { current, password } = req.body;
  const bcrypt = require('bcryptjs');
  if (!bcrypt.compareSync(current, req.user.password)) return res.status(400).json({ error: 'Current password is incorrect' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'New password too short' });
  authService.updateUser(req.user.id, { password });
  activity.logActivity({ user_id: req.user.id, event: 'profile:password_changed' });
  return res.json({ ok: true });
});

router.get('/settings', (req, res) => render(res, 'userSettings', { tfaSetup: null }));
router.get('/user-settings', (req, res) => res.redirect('/settings'));
router.post('/settings', express.urlencoded({ extended: true }), (req, res) => {
  try {
    const data = {};
    if (req.body.avatar_url) data.avatar = req.body.avatar_url;
    if (req.body.language) data.language = req.body.language;
    authService.updateUser(req.user.id, data);
    return render(res, 'userSettings', { success: 'Settings saved!' });
  } catch (e) {
    return render(res, 'userSettings', { error: e.message });
  }
});

router.get('/settings/tfa/setup', (req, res) => {
  const tfaSetup = authService.setupTfa(req.user);
  return render(res, 'userSettings', { tfaSetup });
});

router.post('/settings/tfa/enable', express.json(), (req, res) => {
  const result = authService.enableTfa(req.user, req.body.code);
  if (!result.ok) return res.status(400).json({ error: result.error });
  return res.json({ ok: true });
});

router.post('/settings/tfa/disable', express.json(), (req, res) => {
  const result = authService.disableTfa(req.user, req.body.code);
  if (!result.ok) return res.status(400).json({ error: result.error });
  return res.json({ ok: true });
});

router.get('/activity', (req, res) => {
  const logs = activity.listActivity({ user_id: req.user.id, limit: 200 });
  render(res, 'activity', { logs });
});

router.get('/qrcode', (req, res) => {
  const data = req.query.data;
  if (!data) return res.status(400).end();
  qrcode.toBuffer(data, { width: 220, margin: 1 })
    .then((buf) => { res.setHeader('Content-Type', 'image/png'); res.send(buf); })
    .catch(() => res.status(500).end());
});

router.get('/notifications', (req, res) => {
  const notifs = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id);
  render(res, 'notifications', { notifs });
});

router.post('/notifications/:id/read', (req, res) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

module.exports = router;
