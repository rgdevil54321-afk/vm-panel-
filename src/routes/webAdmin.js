const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../lib/config');
const { db, settings } = require('../lib/db');
const vmService = require('../services/vmService');
const backupService = require('../services/backupService');
const authService = require('../services/authService');
const activity = require('../services/activityService');
const { requireAdmin } = require('../middleware/auth');
const { uploadLogo, uploadFavicon, uploadBackground, uploadMusic } = require('../middleware/upload');
const multer = require('multer');
const fs2 = require('fs');
const createUpload = multer({ dest: config.root + '/data/tmp' });
const router = express.Router();

router.use(requireAdmin);

function render(res, view, vars = {}) {
  res.render(`admin/${view}`, {
    page: 'admin-' + view,
    user: res.req.user,
    settings: settings.all(),
    ...vars,
  });
}

const nodeService = require('../services/nodeService');

router.get('/admin', (req, res) => {
  const vms = vmService.dbVms().map(vmService.serializeVm);
  const users = db.prepare('SELECT id, username, email, role, suspended, verified, created_at, last_login_at FROM users').all();
  const running = vms.filter((v) => v.status === 'running').length;
  const totalDisk = vms.reduce((a, v) => a + parseInt(v.disk_size || '0'), 0);
  const recentLogs = activity.listActivity({ limit: 12 });
  const nodeStats = nodeService.getNodeLiveStats();
  const cluster = nodeService.getClusterSummary();
  render(res, 'dashboard', { vms, users, running, totalDisk, recentLogs, usage: vmService.usage(), nodeStats, cluster });
});

router.get('/admin/nodes', (req, res) => {
  const cluster = nodeService.getClusterSummary();
  const nodes = nodeService.allNodes().map((n) => ({ ...n, vm_count: require('../services/nodeRegistry').nodeVmCount(n.id) }));
  render(res, 'nodes', { cluster, nodes });
});

router.get('/admin/nodes/:id', async (req, res) => {
  try {
    const detail = await nodeService.getNodeDetail(parseInt(req.params.id, 10));
    render(res, 'nodeDetail', { detail });
  } catch (e) {
    const cluster = nodeService.getClusterSummary();
    render(res, 'nodes', { cluster, nodes: nodeService.allNodes(), error: e.message });
  }
});

router.get('/admin/nodes/status', (req, res) => {
  try {
    const stats = nodeService.getNodeLiveStats();
    const cluster = nodeService.getClusterSummary();
    res.json({ ok: true, stats, cluster });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/admin/servers', (req, res) => {
  const vms = vmService.dbVms().map(vmService.serializeVm);
  render(res, 'servers', { vms });
});

router.get('/admin/servers/create', (req, res) => {
  const users = db.prepare('SELECT id, username, email FROM users ORDER BY username').all();
  const nodes = nodeService.allNodes();
  render(res, 'create', { osList: vmService.getOsList(), users, nodes });
});

router.post('/admin/servers/create', createUpload.fields([{ name: 'image', maxCount: 1 }]), async (req, res) => {
  try {
    const files = req.files || {};
    const ownerId = parseInt(req.body.owner_id || req.user.id, 10);
    const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(ownerId);
    if (!owner) return res.status(400).json({ error: 'Owner not found' });
    const data = { ...req.body };
    if (req.body.node_id) data.node_id = parseInt(req.body.node_id, 10);
    try { if (data.port_forwards) data.port_forwards = JSON.parse(data.port_forwards); } catch (_) { data.port_forwards = []; }
    // Parse wizard JSON list fields (sent as JSON strings via FormData)
    const jsonListFields = ['additional_disks', 'cloudinit_packages', 'cloudinit_commands', 'cloudinit_files', 'advanced'];
    for (const f of jsonListFields) {
      if (data[f] !== undefined) {
        try { data[f] = JSON.parse(data[f]); } catch (_) { data[f] = (f === 'advanced') ? {} : []; }
      }
    }
    if (files.image && files.image[0]) data.upload_image = files.image[0];
    if (files.image && files.image[0]) {
      try { fs2.mkdirSync(config.root + '/data/tmp', { recursive: true }); } catch (_) {}
    }
    const vm = await vmService.create({ user: owner, data });
    // keep the image file if it was a download; clean temp upload if used
    if (data.upload_image) {
      try { fs2.unlinkSync(data.upload_image.path); } catch (_) {}
    }
    return res.json({ ok: true, vm, redirect: `/admin/servers/${vm.id}` });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/admin/servers/:id/action', async (req, res) => {
  const vm = vmService.getVm(req.params.id);
  if (!vm) return res.status(404).json({ error: 'Server not found' });
  const { action } = req.body;
  try {
    if (action === 'start') await vmService.start(vm, { user: req.user }), res.json({ ok: true, status: 'running' });
    else if (action === 'stop') res.json({ ok: true, status: (await vmService.stop(vm, { user: req.user })).status });
    else if (action === 'kill') res.json({ ok: true, status: (await vmService.stop(vm, { user: req.user, force: true })).status });
    else if (action === 'restart') await vmService.restart(vm, req.user), res.json({ ok: true, status: 'running' });
    else if (action === 'delete') res.json(await vmService.remove(vm, req.user));
    else if (action === 'regenpass') {
      const newPass = 'vpn' + Math.random().toString(36).slice(2, 10);
      const updated = vmService.update(vm, { password: newPass }, req.user);
      res.json({ ok: true, password: updated.password });
    }
    else if (action === 'reinstall') {
      const { os } = req.body || {};
      res.json(await vmService.reinstall(vm, { os }, req.user));
    }
    else if (action === 'tmate') {
      const regen = !!(req.body && req.body.regen);
      res.json({ ok: true, ssh: await vmService.getTmateSsh(vm, regen) });
    }
    else res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/servers/:id/transfer', express.json(), (req, res) => {
  const vm = vmService.getVm(req.params.id);
  if (!vm) return res.status(404).json({ error: 'Server not found' });
  const { owner_id } = req.body;
  if (!owner_id) return res.status(400).json({ error: 'Owner ID is required' });
  try {
    const updated = vmService.transferOwner(vm, parseInt(owner_id, 10), req.user);
    res.json({ ok: true, vm: vmService.serializeVm(updated) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/admin/servers/:id', (req, res) => {
  const vm = vmService.getVm(req.params.id);
  if (!vm) return res.status(404).render('error/404', { code: 404, title: 'Not Found', message: 'Server not found', settings: settings.all(), user: req.user });
  const backups = backupService.listForVm(vm.id);
  const schedules = db.prepare('SELECT * FROM schedules WHERE vm_id = ?').all(vm.id);
  const subs = db.prepare('SELECT s.*, u.username FROM subusers s JOIN users u ON u.id = s.user_id WHERE s.vm_id = ?').all(vm.id);
  const allUsers = db.prepare('SELECT id, username, email FROM users ORDER BY username').all();
  render(res, 'serverDetail', { vm, backups, schedules, subs, allUsers, uptime: vmService.uptimeSeconds(vm), mem: vmService.memUsage(vm), osList: vmService.getOsList() });
});

router.get('/admin/users', (req, res) => {
  const users = db.prepare(
    `SELECT u.*,
      (SELECT COUNT(*) FROM vms WHERE owner_id = u.id) AS vm_count
     FROM users u ORDER BY u.id DESC`
  ).all();
  render(res, 'users', { users });
});

router.get('/admin/users/:id', (req, res) => {
  const target = authService.findById(req.params.id);
  if (!target) return res.redirect('/admin/users');
  const vms = db.prepare('SELECT * FROM vms WHERE owner_id = ?').all(target.id).map(vmService.serializeVm);
  const otherVms = db.prepare('SELECT v.*, u.username as owner_username FROM vms v JOIN users u ON u.id = v.owner_id WHERE v.owner_id != ? ORDER BY v.name').all(target.id).map(vmService.serializeVm);
  const loginHistory = activity.listLoginHistory({ user_id: target.id, limit: 100 });
  const logs = activity.listActivity({ user_id: target.id, limit: 100 });
  render(res, 'userDetail', { target: authService.publicUser(target), vms, otherVms, loginHistory, logs });
});

router.post('/admin/users/:id/assign-vm', express.json(), (req, res) => {
  const target = authService.findById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const { vm_id } = req.body;
  if (!vm_id) return res.status(400).json({ error: 'VM ID is required' });
  const vm = vmService.getVm(vm_id);
  if (!vm) return res.status(404).json({ error: 'Server not found' });
  try {
    vmService.transferOwner(vm, target.id, req.user);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/users/create', express.json(), (req, res) => {
  try {
    const user = authService.createUser({
      username: req.body.username,
      email: req.body.email,
      password: req.body.password,
      name: req.body.name,
      role: req.body.role || 'user',
      verified: true,
    });
    return res.json({ ok: true, user: authService.publicUser(user) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/admin/users/:id/update', express.json(), (req, res) => {
  try {
    const target = authService.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if ((req.body.suspended === false || req.body.role === 'user' || req.body.root_admin === false) && target.root_admin && authService.countAdmins() <= 1) {
      return res.status(400).json({ error: 'Cannot demote the last admin' });
    }
    const updated = authService.updateUser(target.id, req.body);
    activity.logActivity({ user_id: req.user.id, event: 'admin:user_update', details: { target: target.username, ...req.body } });
    return res.json({ ok: true, user: authService.publicUser(updated) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/admin/users/:id/delete', (req, res) => {
  try {
    const target = authService.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.root_admin && authService.countAdmins() <= 1) {
      return res.status(400).json({ error: 'Cannot delete the last admin' });
    }
    if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
    authService.deleteUser(target.id);
    activity.logActivity({ user_id: req.user.id, event: 'admin:user_delete', details: { target: target.username } });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/admin/users/:id/suspend', (req, res) => {
  try {
    const target = authService.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.root_admin && authService.countAdmins() <= 1) return res.status(400).json({ error: 'Cannot suspend the last admin' });
    const suspend = req.body.suspend !== false;
    authService.updateUser(target.id, { suspended: suspend });
    activity.logActivity({ user_id: req.user.id, event: suspend ? 'admin:user_suspend' : 'admin:user_unsuspend', details: { target: target.username } });
    return res.json({ ok: true, suspended: suspend });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.get('/admin/activity', (req, res) => {
  const logs = activity.listActivity({ limit: 500 });
  render(res, 'activity', { logs });
});

router.get('/admin/settings', (req, res) => {
  const all = settings.all();
  let wallpapers = [];
  const wallpaperCache = path.join(config.root, 'data/wallpapers.json');
  if (fs.existsSync(wallpaperCache)) {
    try { wallpapers = JSON.parse(fs.readFileSync(wallpaperCache, 'utf8')); } catch (_) {}
  }
  render(res, 'settings', { all, wallpapers, updated: req.query.updated || '' });
});

router.post('/admin/settings', express.json(), (req, res) => {
  const body = req.body || {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'panel.name') continue; // guarded
    settings.set(k, v);
  }
  activity.logActivity({ user_id: req.user.id, event: 'admin:settings_update', details: Object.keys(body) });
  return res.json({ ok: true, settings: settings.all() });
});

router.post('/admin/settings/general', express.urlencoded({ extended: true }), (req, res) => {
  const save = (key) => {
    if (req.body[key] !== undefined) settings.set(key, req.body[key]);
  };
  for (const key of [
    'panel.name', 'panel.logo_mode', 'panel.logo_url', 'panel.favicon_name',
    'panel.favicon_mode', 'panel.favicon_url', 'panel.bg_mode', 'panel.bg_color',
    'panel.bg_url', 'panel.bg_cover', 'panel.bg_overlay', 'panel.bg_video_url',
    'panel.music_mode', 'panel.music_url', 'panel.music_youtube', 'panel.music_autoplay',
    'panel.music_loop', 'panel.music_volume', 'panel.navbar_style', 'panel.navbar_transparent',
    'panel.navbar_blur', 'panel.accent', 'panel.theme',
    'panel.discord_url', 'panel.discord_enabled', 'panel.discord_code',
  ]) save(key);
  save('panel.wallpapers_api_key');
  for (const key of ['mail.host', 'mail.port', 'mail.secure', 'mail.user', 'mail.pass', 'mail.from']) save(key);
  for (const key of ['security.allow_register', 'security.require_verify', 'security.force_tfa', 'vm.auto_port_min', 'vm.auto_port_max', 'vm.vnc_port_min', 'vm.vnc_port_max', 'vm.agent_port_min', 'vm.agent_port_max', 'vm.default_memory', 'vm.default_cpus', 'vm.default_disk', 'vm.default_os']) save(key);
  if (req.body.vm_os_list) {
    try {
      settings.set('vm.os_list', JSON.stringify(JSON.parse(req.body.vm_os_list)));
    } catch (_) {}
  }
  activity.logActivity({ user_id: req.user.id, event: 'admin:settings_update' });
  return res.redirect('/admin/settings?updated=1');
});

router.post('/admin/settings/logo', uploadLogo.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  settings.set('panel.logo_mode', 'upload');
  settings.set('panel.logo_file', `/uploads/logo/${req.file.filename}`);
  return res.json({ ok: true, url: `/uploads/logo/${req.file.filename}` });
});

router.post('/admin/settings/favicon', uploadFavicon.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  settings.set('panel.favicon_mode', 'upload');
  settings.set('panel.favicon_file', `/uploads/favicon/${req.file.filename}`);
  return res.json({ ok: true, url: `/uploads/favicon/${req.file.filename}` });
});

router.post('/admin/settings/background', uploadBackground.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const isVideo = /\.(mp4|webm|avi|mov)$/i.test(req.file.filename);
  if (isVideo) {
    settings.set('panel.bg_mode', 'video');
    settings.set('panel.bg_video_file', `/uploads/background/${req.file.filename}`);
  } else {
    settings.set('panel.bg_mode', 'image');
    settings.set('panel.bg_file', `/uploads/background/${req.file.filename}`);
  }
  return res.json({ ok: true, url: `/uploads/background/${req.file.filename}`, mode: isVideo ? 'video' : 'image' });
});

router.post('/admin/settings/music', uploadMusic.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  settings.set('panel.music_mode', 'file');
  settings.set('panel.music_file', `/uploads/music/${req.file.filename}`);
  return res.json({ ok: true, url: `/uploads/music/${req.file.filename}` });
});

router.post('/admin/settings/logo-clear', (req, res) => {
  settings.set('panel.logo_mode', 'url');
  settings.set('panel.logo_file', '');
  res.json({ ok: true });
});
router.post('/admin/settings/favicon-clear', (req, res) => {
  settings.set('panel.favicon_mode', 'url');
  settings.set('panel.favicon_file', '');
  res.json({ ok: true });
});
router.post('/admin/settings/background-clear', (req, res) => {
  settings.set('panel.bg_mode', 'color');
  settings.set('panel.bg_file', '');
  settings.set('panel.bg_video_file', '');
  res.json({ ok: true });
});
router.post('/admin/settings/music-clear', (req, res) => {
  settings.set('panel.music_mode', 'none');
  settings.set('panel.music_file', '');
  res.json({ ok: true });
});

const wallpaperService = require('../services/wallpaperService');

router.get('/admin/wallpapers', async (req, res) => {
  try {
    const data = await wallpaperService.getWallpapers({
      category: req.query.category,
      page: req.query.page,
      query: req.query.q || req.query.query,
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed to fetch wallpapers: ' + e.message });
  }
});

router.post('/admin/wallpapers/apply', express.json(), (req, res) => {
  const { url, thumbnail, blur, transparency, overlay } = req.body;
  if (!url) return res.status(400).json({ error: 'No url provided' });
  settings.set('panel.bg_mode', 'image');
  settings.set('panel.bg_url', url);
  if (thumbnail) settings.set('panel.bg_thumb', thumbnail);
  if (blur !== undefined) settings.set('panel.bg_blur', String(blur));
  if (transparency !== undefined) settings.set('panel.bg_transparency', String(transparency));
  if (overlay !== undefined) settings.set('panel.bg_overlay', String(overlay));
  return res.json({ ok: true, message: 'Wallpaper applied successfully' });
});

module.exports = router;
