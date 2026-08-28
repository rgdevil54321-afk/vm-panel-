const express = require('express');
const authService = require('../services/authService');
const vmService = require('../services/vmService');
const bootLogService = require('../services/bootLogService');
const backupService = require('../services/backupService');
const scheduleService = require('../services/scheduleService');
const agentService = require('../services/agentService');
const activity = require('../services/activityService');
const { db, settings } = require('../lib/db');
const { apiAuth, apiAdmin } = require('../middleware/auth');
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

// ---------- Authenticated ----------
router.use(apiAuth);

router.get('/auth/me', (req, res) => res.json({ user: authService.publicUser(req.user) }));

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
router.get('/vms/:id/backups', loadVm, (req, res) => res.json({ backups: backupService.listForVm(req.vm.id) }));
router.post('/vms/:id/backups', loadVm, json, (req, res) => {
  try { res.json({ ok: true, backup: backupService.createBackup(req.vm, { user: req.user, name: req.body.name }) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
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
      'panel.theme', 'panel.accent'
    ];
    for (const k of fields) {
      if (req.body[k] !== undefined) settings.set(k, String(req.body[k]));
    }
    res.json({ ok: true, message: 'Customization saved', settings: settings.all() });
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

module.exports = router;
