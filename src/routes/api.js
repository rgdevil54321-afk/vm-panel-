const express = require('express');
const fs = require('fs');
const authService = require('../services/authService');
const vmService = require('../services/vmService');
const bootLogService = require('../services/bootLogService');
const backupService = require('../services/backupService');
const scheduleService = require('../services/scheduleService');
const agentService = require('../services/agentService');
const activity = require('../services/activityService');
const { db, settings } = require('../lib/db');
const { apiAuth, apiAdmin, getUserFromReq } = require('../middleware/auth');
const { uploadAvatar } = require('../middleware/upload');
const router = express.Router();

const json = express.json({ limit: '50mb' });

// ---------- Public auth ----------
router.post('/auth/login', json, (req, res) => {
  const { username, password, code } = req.body;
  const ip = req.ip || req.socket.remoteAddress;
  const result = authService.attemptLogin(String(username || '').trim(), String(password || ''), ip);
  if (!result.ok) return res.status(401).json({ error: result.error });
  if (result.tfaRequired) {
    if (!code) return res.json({ tfa_required: true, user: authService.publicUser(result.user) });
    const check = authService.confirmTfa(result.user, code);
    if (!check.ok) return res.status(401).json({ error: check.error });
  }
  const { token, user } = authService.finishLogin(result.user, ip);
  return res.json({ token, user });
});

router.post('/auth/register', json, (req, res) => {
  if (settings.get('security.allow_register') === '0') return res.status(403).json({ error: 'Registration disabled' });
  try {
    const user = authService.createUser({
      username: String(req.body.username || '').trim(),
      email: String(req.body.email || '').trim().toLowerCase(),
      password: String(req.body.password || ''),
      name: String(req.body.name || '').trim() || req.body.username,
      role: 'user',
      verified: settings.get('security.require_verify') !== '1',
    });
    return res.json({ ok: true, user: authService.publicUser(user) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.get('/settings/public', (req, res) => {
  const s = settings.all();
  return res.json({
    name: s['panel.name'],
    allow_register: s['security.allow_register'],
    require_verify: s['security.require_verify'],
    version: '1.0.0',
  });
});

// Beacon save endpoint: sendBeacon cannot set Authorization headers,
// so auth falls back to the login cookie (same-origin). Registered
// BEFORE router.use(apiAuth) on purpose.
router.post('/customization/save-beacon', json, (req, res) => {
  const user = getUserFromReq(req); // sendBeacon sends cookies, no Bearer header
  if (!user || (user.role !== 'admin' && !user.root_admin)) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const fields = ['panel.bg_overlay', 'panel.bg_blur', 'panel.bg_transparency'];
    for (const k of fields) {
      if (req.body[k] !== undefined) settings.set(k, String(req.body[k]));
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- Authenticated ----------
router.use(apiAuth);

router.get('/auth/me', (req, res) => res.json({ user: authService.publicUser(req.user), impersonation: req.impersonation ? { admin_id: req.impersonation.admin.id, admin_username: req.impersonation.admin.username } : null }));

// End an admin impersonation session and mint a fresh token for the admin.
router.post('/impersonation/leave', json, (req, res) => {
  try {
    const impSvc = require('../services/impersonationService');
    if (!req.impersonation) return res.status(400).json({ error: 'Not impersonating' });
    const adminId = req.impersonation.admin.id;
    impSvc.endImpersonation(req.impersonation, req.user);
    const status = db.prepare('SELECT role, root_admin, suspended FROM users WHERE id = ?').get(adminId);
    if (!status || status.suspended) return res.status(403).json({ error: 'Admin account unavailable' });
    const admin = db.prepare('SELECT * FROM users WHERE id = ?').get(adminId);
    const token = authService.signToken(admin);
    res.json({ ok: true, token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- API Keys (self-service for each user; admin list endpoint added) ----------
router.get('/api-keys', (req, res) => {
  const apiKeyService = require('../services/apiKeyService');
  res.json({ ok: true, keys: apiKeyService.listApiKeys(req.user.id) });
});

router.post('/api-keys', json, (req, res) => {
  try {
    const apiKeyService = require('../services/apiKeyService');
    const created = apiKeyService.createApiKey(req.user.id, req.body.name, req.body.scopes || 'r_servers');
    activity.logActivity({ user_id: req.user.id, event: 'api_key:create', details: { name: req.body.name || 'untitled', prefix: created.prefix } });
    res.json({ ok: true, key: created.key, prefix: created.prefix });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/api-keys/:id', (req, res) => {
  const apiKeyService = require('../services/apiKeyService');
  const ok = apiKeyService.deleteApiKey(req.user.id, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Key not found' });
  activity.logActivity({ user_id: req.user.id, event: 'api_key:revoke', details: { id: req.params.id } });
  res.json({ ok: true });
});

router.get('/user/activity', (req, res) => {
  const logs = activity.listActivity({ user_id: req.user.id, limit: parseInt(req.query.limit || '100', 10) });
  res.json({ logs });
});

router.get('/user/login-history', (req, res) => {
  res.json({ history: activity.listLoginHistory({ user_id: req.user.id, limit: 100 }) });
});

router.post('/user/profile', json, (req, res) => {
  try {
    const data = {};
    if (req.body.name) data.name = req.body.name;
    if (req.body.email) data.email = req.body.email;
    if (req.body.language) data.language = req.body.language;
    const u = authService.updateUser(req.user.id, data);
    return res.json({ ok: true, user: authService.publicUser(u) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Per-user ambient music + sound effects preferences
router.post('/user/ambient-music', json, (req, res) => {
  const enabled = req.body.enabled ? 1 : 0;
  const volume = Math.max(0, Math.min(100, parseInt(req.body.volume, 10) || 35));
  const { db } = require('../lib/db');
  db.prepare('UPDATE users SET music_enabled = ?, music_volume = ?, updated_at = ? WHERE id = ?')
    .run(enabled, volume, new Date().toISOString(), req.user.id);
  res.json({ ok: true, enabled: !!enabled, volume });
});

router.post('/user/sfx', json, (req, res) => {
  const enabled = req.body.enabled ? 1 : 0;
  const volume = Math.max(0, Math.min(100, parseInt(req.body.volume, 10) || 40));
  const { db } = require('../lib/db');
  db.prepare('UPDATE users SET sfx_enabled = ?, sfx_volume = ?, updated_at = ? WHERE id = ?')
    .run(enabled, volume, new Date().toISOString(), req.user.id);
  res.json({ ok: true, enabled: !!enabled, volume });
});

// Per-user secret blur preference
router.post('/user/secret-blur', json, (req, res) => {
  const enabled = req.body.enabled ? 1 : 0;
  const { db } = require('../lib/db');
  db.prepare('UPDATE users SET secret_blur = ?, secret_blur_set = 1, updated_at = ? WHERE id = ?')
    .run(enabled, new Date().toISOString(), req.user.id);
  res.json({ ok: true, enabled: !!enabled });
});

router.post('/user/avatar', uploadAvatar.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const url = `/uploads/avatar/${req.file.filename}`;
  authService.updateUser(req.user.id, { avatar: url });
  res.json({ ok: true, avatar: url });
});

router.post('/user/password', json, (req, res) => {
  const bcrypt = require('bcryptjs');
  if (!bcrypt.compareSync(req.body.current, req.user.password)) return res.status(400).json({ error: 'Current password incorrect' });
  if (!req.body.password || req.body.password.length < 6) return res.status(400).json({ error: 'Password too short' });
  authService.updateUser(req.user.id, { password: req.body.password });
  res.json({ ok: true });
});

// ---------- VMs ----------
function loadVm(req, res, next) {
  const vm = vmService.getVm(req.params.id);
  if (!vm || !vmService.canAccess(req.user, vm)) return res.status(404).json({ error: 'Server not found' });
  const row = db.prepare('SELECT agent_token FROM vms WHERE id = ?').get(vm.id);
  if (row && row.agent_token) {
    Object.defineProperty(vm, 'agent_token', { value: row.agent_token, enumerable: false, configurable: true });
  }
  req.vm = vm;
  next();
}

router.get('/vms', (req, res) => {
  if (req.user.role === 'admin' || req.user.root_admin) {
    const all = db.prepare('SELECT v.*, u.username as owner_username, u.email as owner_email FROM vms v JOIN users u ON u.id = v.owner_id ORDER BY v.id DESC').all().map(vmService.serializeVm);
    return res.json({ vms: all });
  }
  const mine = db.prepare('SELECT * FROM vms WHERE owner_id = ?').all(req.user.id).map(vmService.serializeVm);
  const shared = db.prepare(
    'SELECT v.* FROM subusers s JOIN vms v ON v.id = s.vm_id WHERE s.user_id = ?'
  ).all(req.user.id).map(vmService.serializeVm);
  res.json({ vms: [...mine, ...shared] });
});

router.post('/vms', json, async (req, res) => {
  try {
    const vm = await vmService.create({ user: req.user, data: req.body });
    return res.json({ ok: true, vm });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.get('/vms/:id', loadVm, (req, res) => res.json({ vm: req.vm }));
router.post('/vms/:id/start', loadVm, async (req, res) => {
  try { await vmService.start(req.vm, { user: req.user }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/vms/:id/stop', loadVm, async (req, res) => {
  try { await vmService.stop(req.vm, { user: req.user, force: !!req.body.force }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/vms/:id/restart', loadVm, async (req, res) => {
  try { await vmService.restart(req.vm, req.user); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.get(['/vms/:id/status', '/vms/:id/stats'], loadVm, async (req, res) => {
  try {
    if (vmService.isRemoteVm(req.vm)) {
      const stats = await vmService.liveStatsRemote(req.vm);
      return res.json({ ok: true, id: req.vm.id, ...(stats || { status: req.vm.status }) });
    }
    const stats = vmService.liveStats(req.vm);
    res.json({ ok: true, id: req.vm.id, status: stats.status, uptime: stats.uptime, mem: stats.memory.used_bytes, ...stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.get('/vms/:id/bootlog', loadVm, (req, res) => {
  res.json({ ok: true, log: vmService.getBootLog(req.vm) });
});
router.get('/vms/:id/bootlog/stream', loadVm, (req, res) => {
  bootLogService.handleSseStream(req, res, req.vm);
});
router.post('/vms/:id/bootlog/clear', loadVm, (req, res) => {
  bootLogService.clearBootLogs(req.vm);
  res.json({ ok: true });
});
router.get('/vms/:id/bootlog/diagnose', loadVm, (req, res) => {
  try {
    const result = require('../services/bootLogAiService').diagnose(req.vm);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.delete('/vms/:id', loadVm, async (req, res) => {
  try {
    if (req.vm.owner_id !== req.user.id && req.user.role !== 'admin' && !req.user.root_admin) return res.status(403).json({ error: 'Forbidden' });
    await vmService.remove(req.vm, req.user);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch('/vms/:id', loadVm, json, (req, res) => {
  try { res.json({ ok: true, vm: vmService.update(req.vm, req.body, req.user) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/vms/:id/resize', loadVm, json, async (req, res) => {
  try { res.json({ ok: true, vm: await vmService.resizeDisk(req.vm, req.body.disk_size, req.user) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Files (via VM Agent API, SSH fallback) ----------
router.get('/vms/:id/files', loadVm, async (req, res) => {
  try {
    const files = await agentService.listDir(req.vm, req.query.path || '/');
    res.json({ ok: true, files, transport: req.vm.agent_port ? 'agent' : 'ssh' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/vms/:id/files/read', loadVm, async (req, res) => {
  try {
    const content = await agentService.readFile(req.vm, req.query.path);
    res.json({ ok: true, content });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/vms/:id/files/write', loadVm, json, async (req, res) => {
  try {
    await agentService.writeFile(req.vm, req.body.path, req.body.content);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/vms/:id/files/mkdir', loadVm, json, async (req, res) => {
  try { await agentService.mkdir(req.vm, req.body.path); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/vms/:id/files/delete', loadVm, json, async (req, res) => {
  try { await agentService.rm(req.vm, req.body.path, { recursive: !!req.body.recursive }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/vms/:id/files/rename', loadVm, json, async (req, res) => {
  try { await agentService.rename(req.vm, req.body.from, req.body.to); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/vms/:id/files/chmod', loadVm, json, async (req, res) => {
  try { await agentService.chmod(req.vm, req.body.path, req.body.mode); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/vms/:id/files/upload', loadVm, express.raw({ limit: '200mb', type: '*/*' }), async (req, res) => {
  const targetPath = String(req.headers['x-file-path'] || '/');
  try {
    await agentService.upload(req.vm, targetPath, req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.get('/vms/:id/files/download', loadVm, async (req, res) => {
  try {
    const data = await agentService.download(req.vm, req.query.path);
    const name = req.query.path.split('/').pop() || 'file';
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Backups / Schedules / Subusers ----------
router.get('/vms/:id/backups', loadVm, (req, res) => res.json({ backups: backupService.listForVm(req.vm.id), slots: backupService.slotsFor(req.vm.id) }));
router.post('/vms/:id/backups', loadVm, json, (req, res) => {
  try {
    const slots = backupService.slotsFor(req.vm.id);
    if (slots.free <= 0) return res.status(400).json({ error: `Backup slot limit reached (${slots.used}/${slots.slots}). Delete a backup or raise the machine's backup slots.` });
    res.json({ ok: true, backup: backupService.createBackup(req.vm, { user: req.user, name: req.body.name }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/vms/:id/backups/:bid/restore', loadVm, (req, res) => {
  const b = db.prepare('SELECT * FROM backups WHERE id = ? AND vm_id = ?').get(req.params.bid, req.vm.id);
  if (!b) return res.status(404).json({ error: 'Backup not found' });
  try { backupService.restoreBackup(b, { user: req.user }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/vms/:id/backups/:bid', loadVm, (req, res) => {
  const b = db.prepare('SELECT * FROM backups WHERE id = ? AND vm_id = ?').get(req.params.bid, req.vm.id);
  if (!b) return res.status(404).json({ error: 'Backup not found' });
  backupService.deleteBackup(b, { user: req.user });
  res.json({ ok: true });
});

router.get('/vms/:id/schedules', loadVm, (req, res) => {
  res.json({ schedules: db.prepare('SELECT * FROM schedules WHERE vm_id = ?').all(req.vm.id) });
});
router.post('/vms/:id/schedules', loadVm, json, (req, res) => {
  try { res.json({ ok: true, schedule: scheduleService.add({ ...req.body, vm_id: req.vm.id }, req.user) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/vms/:id/schedules/:sid', loadVm, (req, res) => {
  try { scheduleService.remove(req.params.sid, req.user); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/vms/:id/subusers', loadVm, (req, res) => {
  res.json({ subusers: db.prepare('SELECT s.*, u.username, u.email FROM subusers s JOIN users u ON u.id = s.user_id WHERE s.vm_id = ?').all(req.vm.id) });
});
router.post('/vms/:id/subusers', loadVm, json, (req, res) => {
  try {
    const exists = db.prepare('SELECT id FROM subusers WHERE vm_id = ? AND user_id = ?').get(req.vm.id, req.body.user_id);
    if (exists) return res.status(400).json({ error: 'Already exists' });
    const info = db.prepare('INSERT INTO subusers (vm_id, user_id, permissions, created_at) VALUES (?,?,?,?)')
      .run(req.vm.id, req.body.user_id, JSON.stringify(req.body.permissions || ['*']), new Date().toISOString());
    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/vms/:id/subusers/:sid', loadVm, (req, res) => {
  db.prepare('DELETE FROM subusers WHERE id = ? AND vm_id = ?').run(req.params.sid, req.vm.id);
  res.json({ ok: true });
});

router.get('/vms/:id/activity', loadVm, (req, res) => {
  res.json({ logs: activity.listActivity({ vm_id: req.vm.id, limit: 200 }) });
});

// ---------- Admin API ----------
router.get('/admin/vms', apiAdmin, (req, res) => res.json({ vms: vmService.dbVms().map(vmService.serializeVm) }));
router.get('/admin/users', apiAdmin, (req, res) => {
  res.json({ users: db.prepare('SELECT * FROM users ORDER BY id DESC').all().map(authService.publicUser) });
});
router.post('/admin/users', apiAdmin, json, (req, res) => {
  try { res.json({ ok: true, user: authService.publicUser(authService.createUser(req.body)) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch('/admin/users/:id', apiAdmin, json, (req, res) => {
  try { res.json({ ok: true, user: authService.publicUser(authService.updateUser(req.params.id, req.body)) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/admin/users/:id', apiAdmin, (req, res) => {
  try { authService.deleteUser(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/admin/activity', apiAdmin, (req, res) => res.json({ logs: activity.listActivity({ limit: 500 }) }));
router.get('/admin/settings', apiAdmin, (req, res) => res.json({ settings: settings.all() }));
router.put('/admin/settings', apiAdmin, json, (req, res) => {
  for (const [k, v] of Object.entries(req.body || {})) settings.set(k, v);
  res.json({ ok: true, settings: settings.all() });
});
router.get('/admin/stats', apiAdmin, (req, res) => {
  const vms = vmService.dbVms();
  res.json({
    users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    vms: vms.length,
    running: vms.filter((v) => vmService.isRunning(v)).length,
    backups: db.prepare('SELECT COUNT(*) c FROM backups').get().c,
    disk_usage: vmService.totalDiskUsage(),
  });
});

// ---------- Panel API key (bots & automation) ----------
const panelKeyGen = require('crypto');
router.get('/admin/api-key', apiAdmin, (req, res) => {
  const cb = () => { const k = require('../middleware/auth').ensurePanelKey(); res.json({ key: k }); };
  cb();
});
router.post('/admin/api-key/regenerate', apiAdmin, (req, res) => {
  const key = 'vp_panel_' + panelKeyGen.randomBytes(24).toString('base64url');
  settings.set('api.panel_key', key);
  res.json({ key });
});

// ---------- DB transfer (export/restore code) ----------
const dbTransfer = require('../services/dbTransferService');
router.get('/admin/transfer/export', apiAdmin, async (req, res) => {
  try {
    const info = await dbTransfer.exportCode();
    res.json({ ok: true, ...info });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.get('/admin/transfer/latest', apiAdmin, (req, res) => {
  try {
    const f = dbTransfer.latestFile();
    if (!f) return res.status(404).json({ error: 'No transfer code saved yet' });
    res.json({ ok: true, file: f, ...dbTransfer.decode(fs.readFileSync(f, 'utf8')).header });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.post('/admin/transfer/emergency', apiAdmin, async (req, res) => {
  try {
    const file = await dbTransfer.emergencyCode('manual');
    res.json({ ok: true, file });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.post('/admin/transfer/restore', apiAdmin, json, (req, res) => {
  try {
    const header = dbTransfer.restoreFromCode(req.body.code || '');
    res.json({ ok: true, header, message: 'Database restored. Panel is restarting in 1 second.' });
    setTimeout(() => process.exit(0), 1000);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- Wallpapers & Customization API ----------
const wallpaperService = require('../services/wallpaperService');

router.get('/wallpapers', async (req, res) => {
  try {
    const data = await wallpaperService.getWallpapers({
      category: req.query.category,
      page: req.query.page,
      query: req.query.q || req.query.query,
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Live (looping video) wallpapers
router.get('/wallpapers/live', (req, res) => {
  try {
    res.json(wallpaperService.getLiveWallpapers());
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/wallpapers/apply', json, (req, res) => {
  try {
    const { url, mode = 'image', overlay, blur, transparency } = req.body || {};
    if (url) {
      if (mode === 'video') {
        settings.set('panel.bg_mode', 'video');
        settings.set('panel.bg_video_url', url);
        settings.set('panel.bg_video_file', '');
      } else {
        settings.set('panel.bg_mode', 'image');
        settings.set('panel.bg_url', url);
        settings.set('panel.bg_file', '');
      }
    }
    if (overlay !== undefined) settings.set('panel.bg_overlay', String(overlay));
    if (blur !== undefined) settings.set('panel.bg_blur', String(blur));
    if (transparency !== undefined) settings.set('panel.bg_transparency', String(transparency));
    res.json({ ok: true, message: 'Background applied successfully', settings: settings.all() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/customization/save', json, (req, res) => {
  try {
    const fields = [
      'panel.bg_mode', 'panel.bg_color', 'panel.bg_url', 'panel.bg_video_url',
      'panel.bg_overlay', 'panel.bg_cover', 'panel.bg_blur', 'panel.bg_transparency',
      'panel.theme', 'panel.accent', 'panel.sfx_enabled', 'panel.sfx_volume', 'panel.secret_blur'
    ];
    for (const k of fields) {
      if (req.body[k] !== undefined) settings.set(k, String(req.body[k]));
    }
    res.json({ ok: true, message: 'Customization saved', settings: settings.all() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/settings/music-volume', json, (req, res) => {
  try {
    if (req.body.volume !== undefined) settings.set('panel.music_volume', String(req.body.volume));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/admin/nodes/status', (req, res) => {
  try {
    const nodeService = require('../services/nodeService');
    res.json({ ok: true, stats: nodeService.getNodeLiveStats(), cluster: nodeService.getClusterSummary() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- Venlix multi-node admin API ----------
const nodeRegistry = require('../services/nodeRegistry');

router.get('/admin/nodes', apiAdmin, (req, res) => {
  try {
    res.json({ ok: true, cluster: nodeRegistry.getClusterSummary() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/admin/nodes', apiAdmin, json, (req, res) => {
  try {
    const node = nodeRegistry.createNode({
      name: req.body.name,
      host: req.body.host,
      port: req.body.port,
      agent_token: req.body.agent_token,
      location: req.body.location,
    });
    res.json({ ok: true, node });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.patch('/admin/nodes/:id', apiAdmin, json, (req, res) => {
  try {
    const node = nodeRegistry.updateNode(parseInt(req.params.id, 10), req.body);
    res.json({ ok: true, node });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.delete('/admin/nodes/:id', apiAdmin, (req, res) => {
  try {
    nodeRegistry.deleteNode(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/admin/nodes/:id', apiAdmin, async (req, res) => {
  try {
    const nodeService = require('../services/nodeService');
    const detail = await nodeService.getNodeDetail(parseInt(req.params.id, 10));
    res.json({ ok: true, ...detail });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/admin/nodes/:id/probe', apiAdmin, (req, res) => {
  try {
    nodeRegistry.probeNode(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/admin/nodes/:id/update', apiAdmin, async (req, res) => {
  try {
    const node = nodeRegistry.getNode(parseInt(req.params.id, 10));
    if (!node) return res.status(404).json({ ok: false, error: 'Node not found' });
    const data = await nodeRegistry.pushUpdateToNode(node);
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/admin/nodes/update', apiAdmin, async (req, res) => {
  try {
    const data = await nodeRegistry.pushUpdateToAll();
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/admin/nodes/connect-key', apiAdmin, json, async (req, res) => {
  try {
    const node = await nodeRegistry.onboardNodeByKey(req.body.key || '', { location: req.body.location });
    res.json({ ok: true, node });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- Billing (admin) ----------
router.get('/admin/billing/plans', apiAdmin, (req, res) => {
  const bs = require('../services/billingService');
  res.json({ ok: true, plans: bs.listPlans() });
});
router.post('/admin/billing/plans', apiAdmin, json, (req, res) => {
  try {
    const bs = require('../services/billingService');
    const plan = bs.createPlan(req.body || {});
    if (req.user) activity.logActivity({ user_id: req.user.id, event: 'billing:plan_create', details: { name: plan.name } });
    res.json({ ok: true, plan });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/admin/billing/plans/:id', apiAdmin, json, (req, res) => {
  try {
    const bs = require('../services/billingService');
    const plan = bs.updatePlan(req.params.id, req.body || {});
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    res.json({ ok: true, plan });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/admin/billing/plans/:id', apiAdmin, (req, res) => {
  const bs = require('../services/billingService');
  res.json({ ok: bs.deletePlan(req.params.id) });
});

router.get('/admin/billing/coupons', apiAdmin, (req, res) => {
  const bs = require('../services/billingService');
  res.json({ ok: true, coupons: bs.listCoupons() });
});
router.post('/admin/billing/coupons', apiAdmin, json, (req, res) => {
  try {
    const bs = require('../services/billingService');
    const coupon = bs.createCoupon(req.body || {});
    res.json({ ok: true, coupon });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/admin/billing/coupons/:id', apiAdmin, (req, res) => {
  const bs = require('../services/billingService');
  res.json({ ok: bs.deleteCoupon(req.params.id) });
});

router.get('/admin/billing/invoices', apiAdmin, (req, res) => {
  const bs = require('../services/billingService');
  res.json({ ok: true, invoices: bs.listInvoices() });
});
router.post('/admin/billing/invoices', apiAdmin, json, (req, res) => {
  try {
    const bs = require('../services/billingService');
    const target = db.prepare('SELECT id, username FROM users WHERE id = ?').get(Number(req.body.user_id));
    if (!target) return res.status(404).json({ error: 'User not found' });
    const inv = bs.createInvoice(target.id, req.body || {});
    activity.logActivity({ user_id: req.user.id, event: 'billing:invoice_create', details: { user_id: target.id, amount: inv.amount } });
    res.json({ ok: true, invoice: inv });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/admin/billing/invoices/:id/pay', apiAdmin, (req, res) => {
  try {
    const bs = require('../services/billingService');
    const inv = bs.markInvoicePaid(req.params.id, req.user);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    activity.logActivity({ user_id: req.user.id, event: 'billing:invoice_paid', details: { invoice_id: inv.id, user_id: inv.user_id, amount: inv.amount } });
    res.json({ ok: true, invoice: inv });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/admin/billing/invoices/:id', apiAdmin, (req, res) => {
  const bs = require('../services/billingService');
  res.json({ ok: bs.deleteInvoice(req.params.id) });
});

router.post('/admin/users/:id/assign-plan', apiAdmin, json, (req, res) => {
  try {
    const bs = require('../services/billingService');
    const target = authService.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    const plan = req.body && req.body.plan_id ? bs.getPlan(req.body.plan_id) : null;
    if (!plan) return res.status(400).json({ error: 'Plan not found' });
    bs.applyPlanToUser(plan, target);
    activity.logActivity({ user_id: req.user.id, event: 'billing:plan_assign', details: { user_id: target.id, plan: plan.name } });
    res.json({ ok: true, plan });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Billing (user self-service) ----------
router.get('/billing/invoices', apiAuth, (req, res) => {
  const bs = require('../services/billingService');
  res.json({ ok: true, invoices: bs.listInvoices(req.user.id) });
});
router.post('/billing/coupon/redeem', apiAuth, json, (req, res) => {
  try {
    const bs = require('../services/billingService');
    const result = bs.redeemCoupon(req.body && req.body.code, req.user.id);
    activity.logActivity({ user_id: req.user.id, event: 'billing:coupon_redeem', details: { code: result.code, amount: result.amount, type: result.type } });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- Discord bot (admin) ----------
router.get('/admin/bot/status', apiAdmin, async (req, res) => {
  const d = require('../services/discordService');
  const gw = require('../services/discordGateway');
  const base = {
    configured: d.botConfigured(),
    guild_id: String(settings.get('bot.guild_id') || ''),
    enabled: String(settings.get('bot.enabled') || '0') === '1',
    check_interval_min: String(settings.get('bot.check_interval_min') || '5'),
    presence: String(settings.get('bot.presence') || ''),
    gateway: gw.state(),
  };
  if (!base.configured) return res.json({ ok: true, ...base, me: null });
  const me = await d.getBotUser();
  const token_app_id = d.decodeBotId();
  let app_info = null;
  let app_error = null;
  try {
    const a = await d.getOAuthApp();
    if (a.ok) app_info = a.app; else app_error = a.error;
  } catch (e) { app_error = e.message; }
  res.json({
    ok: true, ...base,
    token_app_id, app_info, app_error,
    me: me.ok ? me.data : null, me_error: me.ok ? null : (me.error || 'discord api unreachable'),
  });
});

router.post('/admin/bot/detect', apiAdmin, json, async (req, res) => {
  try {
    const d = require('../services/discordService');
    const token_app_id = d.decodeBotId();
    if (!token_app_id) return res.json({ ok: false, error: 'Could not extract an application ID from the token. Check that the token is complete.' });
    const a = await d.getOAuthApp();
    if (!a.ok) return res.json({ ok: false, error: a.error });
    if (req.body && req.body.apply) settings.set('bot.client_id', token_app_id);
    res.json({ ok: true, token_app_id, app: a.app, applied: !!(req.body && req.body.apply) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/admin/bot/profile', apiAdmin, json, async (req, res) => {
  try {
    const d = require('../services/discordService');
    const r = await d.updateBotProfile(req.body || {});
    res.json({ ok: r.ok, me: r.ok ? r.data : null, error: r.ok ? null : r.error });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/admin/bot/presence', apiAdmin, json, async (req, res) => {
  try {
    const b = req.body || {};
    const gw = require('../services/discordGateway');
    if (b.text !== undefined) settings.set('bot.presence', String(b.text));
    if (b.type !== undefined) settings.set('bot.presence_type', String(b.type));
    if (b.state !== undefined) settings.set('bot.presence_state', String(b.state));
    if (b.rotate !== undefined) settings.set('bot.presence_rotate', b.rotate ? '1' : '0');
    if (b.interval !== undefined) settings.set('bot.presence_interval', String(parseInt(b.interval, 10) || 30));
    gw.refresh();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/admin/bot/guilds', apiAdmin, async (req, res) => {
  const d = require('../services/discordService');
  if (!d.botConfigured()) return res.status(400).json({ ok: false, guilds: [], error: 'Bot token not configured' });
  const r = await d.getGuilds();
  res.json({ ok: r.ok, guilds: r.guilds, error: r.ok ? null : (r.error || 'discord api error') });
});

router.get('/admin/bot/guilds/:gid/invites', apiAdmin, async (req, res) => {
  const d = require('../services/discordService');
  if (!d.botConfigured()) return res.status(400).json({ ok: false, invites: [], error: 'Bot token not configured' });
  const r = await d.getGuildInvites(req.params.gid);
  res.json({ ok: r.ok, guild_id: req.params.gid, invites: r.invites, error: r.ok ? null : (r.error || 'discord api error') });
});

router.get('/admin/bot/guilds/:gid/member/:uid', apiAdmin, async (req, res) => {
  const d = require('../services/discordService');
  if (!d.botConfigured()) return res.status(400).json({ ok: false, member: null, error: 'Bot token not configured' });
  const r = await d.getGuildMember(req.params.gid, req.params.uid);
  res.json({ ok: r.ok, guild_id: req.params.gid, user_id: req.params.uid, member: r.ok ? r.data : null, error: r.ok ? null : (r.error || 'discord api error') });
});

router.post('/admin/bot/test', apiAdmin, json, async (req, res) => {
  const d = require('../services/discordService');
  if (!d.botConfigured()) return res.status(400).json({ ok: false, error: 'Bot token not configured' });
  const me = await d.getBotUser();
  if (!me.ok) return res.status(502).json({ ok: false, error: me.error || 'Discord API unreachable' });
  let dm = null;
  const userId = String(req.body && req.body.user_id || '').trim();
  if (userId) {
    const msg = String(req.body && req.body.message || 'Venlix panel bot test').trim();
    dm = await d.sendDm(userId, msg);
  }
  res.json({ ok: true, me: me.data, dm: dm ? { ok: dm.ok, error: dm.error } : null });
});

router.post('/admin/bot/run-guard', apiAdmin, async (req, res) => {
  const pg = require('../services/planGuardService');
  res.json(await pg.run());
});

// ---------- Billing: user plan assignments (admin) ----------
router.get('/admin/billing/user-plans', apiAdmin, (req, res) => {
  const bs = require('../services/billingService');
  res.json({ ok: true, plans: bs.listUserPlans() });
});

router.post('/admin/billing/user-plans', apiAdmin, json, (req, res) => {
  try {
    const bs = require('../services/billingService');
    const target = db.prepare('SELECT id, username FROM users WHERE id = ?').get(Number(req.body.user_id));
    if (!target) return res.status(404).json({ error: 'User not found' });
    const plan = bs.getPlan(req.body.plan_id);
    if (!plan) return res.status(400).json({ error: 'Plan not found' });
    const up = bs.assignPlanToUser(target, plan, {
      assignedBy: req.user.id,
      days: req.body.days,
      inviteCode: req.body.invite_code,
      note: req.body.note,
    });
    activity.logActivity({ user_id: req.user.id, event: 'billing:user_plan_assign', details: { target: target.id, plan: plan.name } });
    res.json({ ok: true, plan: up });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/admin/billing/user-plans/:id/renew', apiAdmin, json, async (req, res) => {
  try {
    const bs = require('../services/billingService');
    const up = bs.renewUserPlan(Number(req.params.id), req.body.days, req.user.id);
    if (!up) return res.status(404).json({ error: 'Plan assignment not found' });
    activity.logActivity({ user_id: req.user.id, event: 'billing:user_plan_renew', details: { user_plan_id: up.id, user_id: up.user_id } });
    res.json({ ok: true, plan: up });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/admin/billing/user-plans/:id/cancel', apiAdmin, (req, res) => {
  try {
    const bs = require('../services/billingService');
    const up = bs.getUserPlanRow(Number(req.params.id));
    if (!up) return res.status(404).json({ error: 'Plan assignment not found' });
    bs.cancelUserPlan(up.id);
    activity.logActivity({ user_id: req.user.id, event: 'billing:user_plan_cancel', details: { user_plan_id: up.id, user_id: up.user_id } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/admin/billing/user-plans/:id/status', apiAdmin, json, async (req, res) => {
  const st = String(req.body && req.body.status || '');
  if (!['active', 'warned', 'suspended'].includes(st)) return res.status(400).json({ error: 'Invalid status' });
  const bs = require('../services/billingService');
  const up = bs.getUserPlanRow(Number(req.params.id));
  if (!up) return res.status(404).json({ error: 'Plan assignment not found' });
  bs.setUserPlanStatus(up.id, st, String(req.body.detail || 'manual override').slice(0, 200));
  if (st === 'active') await vmService.setUserVmsUnsuspended(up.user_id).catch(() => {});
  res.json({ ok: true, plan: bs.getUserPlanRow(up.id) });
});

// ---------- Self-renewal (user) ----------
router.post('/billing/plan/renew', apiAuth, json, (req, res) => {
  try {
    const bs = require('../services/billingService');
    const up = bs.getActiveUserPlan(req.user.id);
    if (!up) return res.status(400).json({ error: 'No active plan' });
    const plan = bs.getPlan(up.plan_id);
    if (!plan || !plan.renewable) return res.status(400).json({ error: 'This plan is not renewable' });
    const days = Number(req.body && req.body.days) > 0 ? Number(req.body.days) : (plan.duration_days > 0 ? plan.duration_days : 30);
    const renewed = bs.renewUserPlan(up.id, days, req.user.id);
    res.json({ ok: true, plan: renewed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Updates + Templates (admin) ----------
router.get('/admin/updates/status', apiAdmin, async (req, res) => {
  try {
    const us = require('../services/updatesService');
    const [current, log, ahead] = await Promise.all([us.gitCurrent(), us.gitLog(), us.statusAhead()]);
    res.json({ ok: true, current, log, ahead });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/admin/updates/fetch', apiAdmin, async (req, res) => {
  const us = require('../services/updatesService');
  res.json(await us.fetchUpdates());
});
router.post('/admin/updates/update', apiAdmin, async (req, res) => {
  const us = require('../services/updatesService');
  res.json(await us.updateNow());
});
router.post('/admin/updates/rollback', apiAdmin, async (req, res) => {
  const us = require('../services/updatesService');
  res.json(await us.rollback());
});
router.post('/admin/updates/nodes', apiAdmin, async (req, res) => {
  const us = require('../services/updatesService');
  res.json(await us.updateAllNodes());
});
router.get('/admin/neofetch/export', apiAdmin, (req, res) => {
  const ns = require('../services/neofetchService');
  res.json({
    ok: true,
    ascii: ns.logoPlain(),
    motd: ns.motdText(),
    script: ns.fetchShellScript(),
  });
});

router.get('/admin/templates/list', apiAdmin, (req, res) => {
  const osList = settings.get('vm.os_list');
  const templates = Array.isArray(osList)
    ? osList.map((t) => (Array.isArray(t) ? { name: t[0], os_type: t[1], codename: t[2], img_url: t[3], username: t[4], password: t[5] } : t))
    : [];
  res.json({ ok: true, templates });
});
router.post('/admin/templates', apiAdmin, json, (req, res) => {
  try {
    const osList = settings.get('vm.os_list');
    const arr = Array.isArray(osList) ? osList : [];
    const t = req.body || {};
    if (!t.name || !String(t.name).trim()) return res.status(400).json({ error: 'Template name is required' });
    arr.push([String(t.name).trim(), String(t.os_type || 'ubuntu'), String(t.codename || ''), String(t.img_url || ''), String(t.username || 'root'), String(t.password || 'root')]);
    settings.set('vm.os_list', arr);
    res.json({ ok: true, templates: arr });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Replace entire template list in one shot
router.put('/admin/templates', apiAdmin, json, (req, res) => {
  try {
    const incoming = req.body && Array.isArray(req.body.templates) ? req.body.templates : [];
    const arr = incoming.map((t) => [String(t.name || '').trim(), String(t.os_type || 'ubuntu'), String(t.codename || ''), String(t.img_url || ''), String(t.username || 'root'), String(t.password || 'root')]);
    settings.set('vm.os_list', arr);
    res.json({ ok: true, templates: arr });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/admin/templates/:idx', apiAdmin, json, (req, res) => {
  try {
    const osList = settings.get('vm.os_list');
    const arr = Array.isArray(osList) ? osList : [];
    const idx = parseInt(req.params.idx, 10);
    if (!Number.isFinite(idx) || idx < 0 || idx >= arr.length) return res.status(404).json({ error: 'Template not found' });
    const t = req.body || {};
    arr[idx] = [String(t.name).trim(), String(t.os_type || 'ubuntu'), String(t.codename || ''), String(t.img_url || ''), String(t.username || 'root'), String(t.password || 'root')];
    settings.set('vm.os_list', arr);
    res.json({ ok: true, templates: arr });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/admin/templates/:idx', apiAdmin, (req, res) => {
  const osList = settings.get('vm.os_list');
  const arr = Array.isArray(osList) ? osList : [];
  const idx = parseInt(req.params.idx, 10);
  if (!Number.isFinite(idx) || idx < 0 || idx >= arr.length) return res.status(404).json({ error: 'Template not found' });
  arr.splice(idx, 1);
  settings.set('vm.os_list', arr);
  res.json({ ok: true, templates: arr });
});

// ---------- Infra: storage pools ----------
router.get('/admin/infra/pools', apiAdmin, (req, res) => {
  const infra = require('../services/infraService');
  res.json({ ok: true, pools: infra.listPools() });
});
router.post('/admin/infra/pools', apiAdmin, json, (req, res) => {
  try {
    const infra = require('../services/infraService');
    res.json({ ok: true, pool: infra.createPool(req.body || {}) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/admin/infra/pools/:id', apiAdmin, json, (req, res) => {
  try {
    const infra = require('../services/infraService');
    const pool = infra.updatePool(req.params.id, req.body || {});
    if (!pool) return res.status(404).json({ error: 'Pool not found' });
    res.json({ ok: true, pool });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/admin/infra/pools/:id', apiAdmin, (req, res) => {
  const infra = require('../services/infraService');
  res.json({ ok: infra.deletePool(req.params.id) });
});

// ---------- Infra: vnets + firewall ----------
router.get('/admin/infra/vnets', apiAdmin, (req, res) => {
  const infra = require('../services/infraService');
  const nets = infra.listVnets().map((n) => ({ ...n, rules: infra.rulesForVnet(n.id) }));
  res.json({ ok: true, vnets: nets });
});
router.post('/admin/infra/vnets', apiAdmin, json, (req, res) => {
  try {
    const infra = require('../services/infraService');
    res.json({ ok: true, vnet: infra.createVnet(req.body || {}) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/admin/infra/vnets/:id', apiAdmin, json, (req, res) => {
  try {
    const infra = require('../services/infraService');
    const net = infra.updateVnet(req.params.id, req.body || {});
    if (!net) return res.status(404).json({ error: 'Network not found' });
    res.json({ ok: true, vnet: net });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/admin/infra/vnets/:id', apiAdmin, (req, res) => {
  const infra = require('../services/infraService');
  res.json({ ok: infra.deleteVnet(req.params.id) });
});
router.post('/admin/infra/vnets/:id/rules', apiAdmin, json, (req, res) => {
  try {
    const infra = require('../services/infraService');
    const rule = infra.createRule(req.params.id, req.body || {});
    res.json({ ok: true, rule });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/admin/infra/rules/:id', apiAdmin, json, (req, res) => {
  try {
    const infra = require('../services/infraService');
    const rule = infra.updateRule(req.params.id, req.body || {});
    if (!rule) return res.status(404).json({ error: 'Rule not found' });
    res.json({ ok: true, rule });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/admin/infra/rules/:id', apiAdmin, (req, res) => {
  const infra = require('../services/infraService');
  res.json({ ok: infra.deleteRule(req.params.id) });
});

// ---------- Infra: ISO library ----------
router.get('/admin/infra/isos', apiAdmin, (req, res) => {
  const infra = require('../services/infraService');
  res.json({ ok: true, isos: infra.listIsos(), pools: infra.listPools() });
});
router.put('/admin/infra/isos', apiAdmin, json, (req, res) => {
  try {
    const infra = require('../services/infraService');
    const isos = infra.saveIsos(Array.isArray(req.body.isos) ? req.body.isos : []);
    res.json({ ok: true, isos });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/admin/infra/isos', apiAdmin, json, (req, res) => {
  try {
    const infra = require('../services/infraService');
    res.json({ ok: true, isos: infra.addIso(req.body || {}) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/admin/infra/isos/:idx', apiAdmin, json, (req, res) => {
  try {
    const infra = require('../services/infraService');
    const arr = infra.updateIso(req.params.idx, req.body || {});
    if (!arr) return res.status(404).json({ error: 'ISO not found' });
    res.json({ ok: true, isos: arr });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Push infra config to remote node agents
router.post('/admin/infra/push', apiAdmin, async (req, res) => {
  try {
    const infra = require('../services/infraService');
    const nodeRegistry = require('../services/nodeRegistry');
    const config = infra.infraConfig();
    const nodes = nodeRegistry.allNodes();
    const results = [];
    for (const node of nodes) {
      if (node.id === 1 && node.agent_token === 'local-primary-no-agent') {
        results.push({ node_id: 1, name: node.name, status: 'skipped', message: 'Local primary node applies infra config on VM create' });
        continue;
      }
      try {
        const r = await nodeRegistry.agentJson(node, { method: 'POST', path: '/infra', body: JSON.stringify(config) });
        results.push({ node_id: node.id, name: node.name, status: 'ok', message: (r && r.message) || 'sent' });
      } catch (e) {
        results.push({ node_id: node.id, name: node.name, status: 'error', message: e.message });
      }
    }
    res.json({ ok: true, results });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
