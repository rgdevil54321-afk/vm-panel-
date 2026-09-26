const express = require('express');
const path = require('path');
const qrcode = require('qrcode');
const config = require('../lib/config');
const { db, settings } = require('../lib/db');
const vmService = require('../services/vmService');
const specs = require('../lib/specs');
const bootLogService = require('../services/bootLogService');
const backupService = require('../services/backupService');
const authService = require('../services/authService');
const activity = require('../services/activityService');
const { requireAuth } = require('../middleware/auth');
const { requireLinkedAccounts } = require('../middleware/requireLinkedAccounts');
const { uploadAvatar } = require('../middleware/upload');
const logger = require('../lib/logger');
const crypto = require('crypto');
const router = express.Router();

function render(res, view, vars = {}) {
  const req = res.req;
  const proto = (req.secure || String(req.get('x-forwarded-proto') || '').split(',')[0].trim() === 'https') ? 'https' : 'http';
  res.render(`user/${view}`, {
    page: view,
    user: res.req.user,
    settings: settings.all(),
    siteUrl: proto + '://' + req.get('host'),
    ...vars,
  });
}

// Public pages: the footer links these, and a privacy policy / rules page that
// bounces visitors to the login screen is useless.
router.get('/privacy', (req, res) => render(res, 'privacy', {}));
router.get('/terms', (req, res) => render(res, 'terms', {}));

router.use(requireAuth);
router.use(requireLinkedAccounts);


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
  const isAdmin = req.user.role === 'admin' || req.user.root_admin;
  const subVms = db.prepare(
    'SELECT v.* FROM subusers s JOIN vms v ON v.id = s.vm_id WHERE s.user_id = ?'
  ).all(req.user.id).map(vmService.serializeVm);
  const running = [...vms, ...subVms].filter((v) => v.status === 'running').length;
  const recentActivity = activity.listActivity({ user_id: req.user.id, limit: 8 });
  // Admins also get every machine so the dashboard can show "My / All" servers.
  let allVms = vms;
  if (isAdmin) {
    allVms = db.prepare(
      'SELECT v.*, u.username AS owner_name, u.email AS owner_email FROM vms v JOIN users u ON u.id = v.owner_id ORDER BY v.id DESC'
    ).all().map((r) => ({ ...vmService.serializeVm(r), mine: r.owner_id === req.user.id }));
  }
  render(res, 'dashboard', { vms, allVms, canSeeAll: isAdmin, running, recentActivity });
});

router.get('/servers/:id', loadVm, (req, res) => {
  const allUsers = (req.user.role === 'admin' || req.user.root_admin)
    ? db.prepare('SELECT id, username, email FROM users ORDER BY username').all()
    : [];
  render(res, 'server/overview', { vm: req.vm, specs: specs.display(req.vm), backups: backupService.listForVm(req.vm.id), allUsers });
});

router.get('/servers/:id/overview', loadVm, (req, res) => {
  const allUsers = (req.user.role === 'admin' || req.user.root_admin)
    ? db.prepare('SELECT id, username, email FROM users ORDER BY username').all()
    : [];
  render(res, 'server/overview', { vm: req.vm, specs: specs.display(req.vm), backups: backupService.listForVm(req.vm.id), allUsers });
});

router.get('/servers/:id/status', loadVm, async (req, res) => {
  try {
    res.json({ ok: true, stats: await vmService.fullStatsFor(req.vm) });
  } catch (e) {
    res.json({ ok: true, stats: vmService.liveStats(req.vm) });
  }
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

router.get('/servers/:id/bootlog/diagnose', loadVm, (req, res) => {
  try {
    const result = require('../services/bootLogAiService').diagnose(req.vm);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/servers/:id/files', loadVm, (req, res) => {
  render(res, 'server/files', { vm: req.vm });
});

router.get('/servers/:id/backups', loadVm, (req, res) => {
  render(res, 'server/backups', { vm: req.vm, backups: backupService.listForVm(req.vm.id), slots: backupService.slotsFor(req.vm.id) });
});

// ---------- Snapshots ----------
router.get('/servers/:id/snapshots', loadVm, async (req, res) => {
  try {
    const data = await vmService.snapshotsFor(req.vm);
    render(res, 'server/snapshots', { vm: req.vm, snapshots: data.snapshots || [], running: vmService.statusOf(req.vm) === 'running' });
  } catch (e) {
    render(res, 'server/snapshots', { vm: req.vm, snapshots: [], snapshotsError: e.message, running: vmService.statusOf(req.vm) === 'running' });
  }
});

router.get('/servers/:id/snapshots/list', loadVm, async (req, res) => {
  try {
    const data = await vmService.snapshotsFor(req.vm);
    return res.json({ ok: true, snapshots: data.snapshots || [] });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/servers/:id/snapshots', loadVm, express.json(), async (req, res) => {
  try {
    const name = String(req.body.name || '').trim() || ('snapshot-' + Date.now().toString(36));
    const result = await vmService.createSnapshotFor(req.vm, name);
    activity.logActivity({ user_id: req.user.id, vm_id: req.vm.id, event: 'vm:snapshot:create', details: { name: result.name, node: req.vm.node_id } });
    return res.json({ ok: true, result });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/servers/:id/snapshots/:sname/revert', loadVm, async (req, res) => {
  try {
    const result = await vmService.revertSnapshotFor(req.vm, req.params.sname);
    activity.logActivity({ user_id: req.user.id, vm_id: req.vm.id, event: 'vm:snapshot:revert', details: { name: req.params.sname } });
    return res.json({ ok: true, result });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/servers/:id/snapshots/:sname/delete', loadVm, async (req, res) => {
  try {
    const result = await vmService.deleteSnapshotFor(req.vm, req.params.sname);
    activity.logActivity({ user_id: req.user.id, vm_id: req.vm.id, event: 'vm:snapshot:delete', details: { name: req.params.sname } });
    return res.json({ ok: true, result });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ---------- Storage volumes ----------
router.get('/servers/:id/volumes', loadVm, (req, res) => {
  render(res, 'server/volumes', { vm: req.vm, running: vmService.statusOf(req.vm) === 'running', ...vmService.volumesFor(req.vm) });
});

router.post('/servers/:id/volumes', loadVm, express.json(), async (req, res) => {
  try {
    const updated = await vmService.addDataDiskFor(req.vm, req.body, req.user);
    return res.json({ ok: true, vm: updated });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/servers/:id/volumes/:name/grow', loadVm, express.json(), async (req, res) => {
  try {
    const updated = await vmService.growDataDiskFor(req.vm, req.params.name, req.body.size, req.user);
    return res.json({ ok: true, vm: updated });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
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
  const logs = activity.listActivity({ vm_id: req.vm.id, limit: 100 });
  render(res, 'server/activity', { vm: req.vm, logs });
});

// ---------- Webhooks ----------
router.get('/servers/:id/webhooks', loadVm, (req, res) => {
  const webhookService = require('../services/webhookService');
  const hooks = webhookService.getWebhooks(req.vm);
  render(res, 'server/webhooks', { vm: req.vm, hooks, running: vmService.statusOf(req.vm) === 'running' });
});

router.post('/servers/:id/webhooks', loadVm, express.json(), (req, res) => {
  try {
    const webhookService = require('../services/webhookService');
    if (!String(req.body.url || '').trim()) return res.status(400).json({ error: 'URL is required' });
    try { new URL(req.body.url); } catch (_) { return res.status(400).json({ error: 'Invalid URL' }); }
    let evts = req.body.events || ['vm:start', 'vm:stop'];
    if (typeof evts === 'string') evts = evts.split(',').map((s) => s.trim()).filter(Boolean);
    const hooks = webhookService.getWebhooks(req.vm);
    const hook = { url: String(req.body.url).trim(), secret: req.body.secret || '', events: evts };
    if (req.body.kind) hook.kind = String(req.body.kind);
    if (req.body.chat_id) hook.chat_id = String(req.body.chat_id);
    hooks.push(hook);
    const updated = webhookService.setWebhooks(req.vm, hooks);
    activity.logActivity({ user_id: req.user.id, vm_id: req.vm.id, event: 'vm:webhook:create', details: { url: req.body.url } });
    res.json({ ok: true, hooks: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/servers/:id/webhooks/:index', loadVm, (req, res) => {
  try {
    const webhookService = require('../services/webhookService');
    const hooks = webhookService.getWebhooks(req.vm);
    const idx = parseInt(req.params.index, 10);
    if (!Number.isFinite(idx) || idx < 0 || idx >= hooks.length) return res.status(400).json({ error: 'Bad index' });
    hooks.splice(idx, 1);
    const updated = webhookService.setWebhooks(req.vm, hooks);
    res.json({ ok: true, hooks: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
      // Async job (Cloudflare cuts long requests): start it and let the
      // browser poll /servers/:id/tmate-status until the address is ready.
      const regen = !!(req.body && req.body.regen);
      if (!vmService.canAccess(req.user, req.vm, 'power')) {
        return res.status(403).json({ error: 'No permission for this server' });
      }
      const job = vmService.startTmateJob(req.vm, regen);
      return res.json({ ok: true, pending: true, job: job.job, note: job.note });
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.get('/servers/:id/tmate-status', loadVm, (req, res) => {
  if (!vmService.canAccess(req.user, req.vm, 'power')) {
    return res.status(403).json({ error: 'No permission for this server' });
  }
  return res.json(vmService.tmateJobStatus(req.vm));
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
    const slots = backupService.slotsFor(req.vm.id);
    if (slots.free <= 0) return res.status(400).json({ error: `Backup slot limit reached (${slots.used}/${slots.slots}). Delete a backup or raise the machine's backup slots.` });
    const backup = backupService.createBackup(req.vm, { user: req.user, name: req.body.name });
    return res.json({ ok: true, backup, slots });
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

router.get('/account', (req, res) => {
  const loginHistory = activity.listLoginHistory({ user_id: req.user.id, limit: 50 });
  render(res, 'account', { loginHistory, tfaSetup: null });
});

router.get('/profile', (req, res) => res.redirect('/account'));
router.get('/user-settings', (req, res) => res.redirect('/settings'));

router.post('/account', express.urlencoded({ extended: true }), (req, res) => {
  try {
    const data = {};
    if (req.body.name !== undefined) data.name = req.body.name;
    if (req.body.email) data.email = req.body.email;
    authService.updateUser(req.user.id, data);
    const loginHistory = activity.listLoginHistory({ user_id: req.user.id, limit: 50 });
    return render(res, 'account', { success: 'Profile updated!', loginHistory, tfaSetup: null });
  } catch (e) {
    const loginHistory = activity.listLoginHistory({ user_id: req.user.id, limit: 50 });
    return render(res, 'account', { error: e.message, loginHistory, tfaSetup: null });
  }
});

router.get('/settings', (req, res) => {
  const msgs = { 'discord_linked': 'Discord account linked successfully!', 'discord_unlinked': 'Discord account unlinked.', 'discord_not_configured': 'Discord linking is not configured yet — ask an admin to add the OAuth client ID/secret in the Bot section.', 'discord_denied': 'Discord authorization was cancelled.', 'discord_oauth_failed': 'Discord authorization failed. Try again.', 'discord_badstate': 'Discord authorization expired or was tampered with. Try again.', 'google_linked': 'Google account linked successfully!', 'google_unlinked': 'Google account unlinked.', 'google_not_configured': 'Google linking is not configured yet - ask an admin to add the OAuth client ID/secret.', 'google_denied': 'Google authorization was cancelled.', 'google_oauth_failed': 'Google authorization failed. Try again.', 'google_already_linked': 'That Google account is already linked to a different user.', 'link_required': 'Link both a Discord and a Google account below to continue using the panel.' };
  const err = msgs[req.query.err] ? msgs[req.query.err] : (req.query.err || '');
  const ok = msgs[req.query.ok] ? msgs[req.query.ok] : (req.query.ok || '');
  render(res, 'userSettings', { tfaSetup: null, error: err, success: ok });
});
router.get('/user-settings', (req, res) => res.redirect('/settings'));

function oauthRedirectUri(req) {
  const path = '/settings/discord/callback';
  // See webAuth.js oauthRedirectUri: prefer the configured canonical URL so the
  // callback is stable no matter which hostname reached the panel.
  const configured = String(settings.get('panel.site_url') || '').trim().replace(/\/+$/, '');
  if (configured) return configured + path;
  const proto = req.headers['x-forwarded-proto'] === 'https' || req.secure ? 'https' : 'http';
  return proto + '://' + req.get('host') + path;
}
function discordState(userId) {
  const hmac = crypto.createHmac('sha256', config.jwtSecret).update(String(userId)).digest('hex');
  return userId + '.' + hmac;
}

router.get('/settings/discord/link', (req, res) => {
  const d = require('../services/discordService');
  if (!d.oauthConfigured()) return res.redirect('/settings?err=discord_not_configured');
  res.redirect(d.authorizeUrl(oauthRedirectUri(req), discordState(req.user.id)));
});

router.get('/settings/discord/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/settings?err=discord_denied');
  const parts = String(state || '').split('.');
  const userId = parseInt(parts[0], 10);
  if (!parts[1] || !userId) return res.redirect('/settings?err=discord_badstate');
  const expected = crypto.createHmac('sha256', config.jwtSecret).update(String(userId)).digest('hex');
  const a = Buffer.from(String(parts[1]));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.redirect('/settings?err=discord_badstate');
  const d = require('../services/discordService');
  const tok = await d.exchangeCode(String(code || ''), oauthRedirectUri(req));
  if (!tok.ok || !tok.data || !tok.data.access_token) return res.redirect('/settings?err=discord_oauth_failed');
  const me = await d.getOAuthUser(tok.data.access_token);
  if (!me.ok || !me.data || !me.data.id) return res.redirect('/settings?err=discord_oauth_failed');
  db.prepare('UPDATE users SET discord_id = ?, discord_name = ?, discord_avatar = ?, discord_linked_at = ?, updated_at = ? WHERE id = ?')
    .run(String(me.data.id), String(me.data.username || '').slice(0, 64), d.cdnAvatar(me.data), new Date().toISOString(), new Date().toISOString(), userId);
  activity.logActivity({ user_id: userId, event: 'account:discord_link', details: { discord_id: me.data.id, discord_name: me.data.username || '' } });

  // Best-effort: pull them into the community server via their own OAuth grant
  // (needs the guilds.join scope, which authorizeUrl now requests). Membership
  // only - no role is assigned. Never block linking on this.
  let joined = '';
  try {
    const gid = String(settings.get('bot.guild_id') || '').trim();
    if (gid) {
      const r = await d.addGuildMember(gid, String(me.data.id), tok.data.access_token);
      if (r.ok) joined = r.alreadyMember ? 'already_member' : 'joined';
      else logger.warn('[discord] guild auto-join failed: status=' + r.status + ' ' + String(r.error || '').slice(0, 200));
    }
  } catch (e) {
    logger.warn('[discord] guild auto-join error: ' + e.message);
  }
  res.redirect('/settings?ok=discord_linked' + (joined ? '&joined=' + joined : ''));
});

router.post('/settings/discord/unlink', express.json(), (req, res) => {
  db.prepare('UPDATE users SET discord_id = NULL, discord_name = NULL, discord_avatar = NULL, discord_linked_at = NULL, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), req.user.id);
  activity.logActivity({ user_id: req.user.id, event: 'account:discord_unlink' });
  res.json({ ok: true });
});

// ---- Google account linking (mirrors the Discord flow above) ----
function googleRedirectUri(req) {
  const proto = req.headers['x-forwarded-proto'] === 'https' || req.secure ? 'https' : 'http';
  return proto + '://' + req.get('host') + '/settings/google/callback';
}
function googleStateOk(state) {
  const parts = String(state || '').split('.');
  const userId = parseInt(parts[0], 10);
  if (!parts[1] || !userId) return 0;
  const expected = crypto.createHmac('sha256', config.jwtSecret).update(String(userId)).digest('hex');
  const a = Buffer.from(String(parts[1]));
  const b = Buffer.from(expected);
  return (a.length === b.length && crypto.timingSafeEqual(a, b)) ? userId : 0;
}

router.get('/settings/google/link', (req, res) => {
  const g = require('../services/googleService');
  if (!g.oauthConfigured()) return res.redirect('/settings?err=google_not_configured');
  res.redirect(g.authorizeUrl(googleRedirectUri(req), discordState(req.user.id)));
});

router.get('/settings/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/settings?err=google_denied');
  const userId = googleStateOk(state);
  if (!userId) return res.redirect('/settings?err=discord_badstate');
  const g = require('../services/googleService');
  const tok = await g.exchangeCode(String(code || ''), googleRedirectUri(req));
  if (!tok.ok || !tok.data || !tok.data.access_token) return res.redirect('/settings?err=google_oauth_failed');
  const me = await g.getOAuthUser(tok.data.access_token);
  if (!me.ok || !me.data || !me.data.sub) return res.redirect('/settings?err=google_oauth_failed');
  const gid = String(me.data.sub);
  const taken = db.prepare('SELECT id FROM users WHERE google_id = ? AND id != ?').get(gid, userId);
  if (taken) return res.redirect('/settings?err=google_already_linked');
  const avatar = me.data.picture ? String(me.data.picture) : null;
  db.prepare('UPDATE users SET google_id = ?, google_name = ?, google_avatar = ?, google_linked_at = ?, updated_at = ? WHERE id = ?')
    .run(gid, String(me.data.name || me.data.email || '').slice(0, 64), avatar, new Date().toISOString(), new Date().toISOString(), userId);
  activity.logActivity({ user_id: userId, event: 'account:google_link', details: { google_id: gid } });
  res.redirect('/settings?ok=google_linked');
});

router.post('/settings/google/unlink', express.json(), (req, res) => {
  db.prepare('UPDATE users SET google_id = NULL, google_name = NULL, google_avatar = NULL, google_linked_at = NULL, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), req.user.id);
  activity.logActivity({ user_id: req.user.id, event: 'account:google_unlink' });
  res.json({ ok: true });
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

router.get('/billing', (req, res) => {
  const q = vmService.effectiveQuota(req.user);
  const bonusEnabled = String(settings.get('billing.enabled') || '0') === '1' && (parseFloat(settings.get('billing.daily_bonus') || '0') || 0) > 0;
  const lastBonus = req.user.last_bonus_at ? new Date(req.user.last_bonus_at) : null;
  const canClaim = bonusEnabled && (!lastBonus || Date.now() - lastBonus.getTime() >= 24 * 3600 * 1000);
  const activePlan = require('../services/billingService').getActiveUserPlan(req.user.id);
  render(res, 'billing', {
    q,
    billingEnabled: String(settings.get('billing.enabled') || '0') === '1',
    bonusEnabled, canClaim,
    nextBonusAt: lastBonus ? new Date(lastBonus.getTime() + 24 * 3600 * 1000).toISOString() : null,
    activePlan,
    prices: {
      base: parseFloat(settings.get('billing.base_price') || '0') || 0,
      ram: parseFloat(settings.get('billing.ram_price') || '0') || 0,
      disk: parseFloat(settings.get('billing.disk_price') || '0') || 0,
      bonus: parseFloat(settings.get('billing.daily_bonus') || '0') || 0,
    },
  });
});

router.post('/billing/claim', (req, res) => {
  try {
    if (String(settings.get('billing.enabled') || '0') !== '1') return res.status(400).json({ error: 'Billing disabled' });
    const bonus = parseFloat(settings.get('billing.daily_bonus') || '0') || 0;
    if (bonus <= 0) return res.status(400).json({ error: 'Daily bonus disabled' });
    const last = req.user.last_bonus_at ? new Date(req.user.last_bonus_at).getTime() : 0;
    if (Date.now() - last < 24 * 3600 * 1000) {
      return res.status(429).json({ error: 'Already claimed. Come back in ' + Math.ceil((24 * 3600 * 1000 - (Date.now() - last)) / 3600000) + 'h.' });
    }
    db.prepare('UPDATE users SET credits = credits + ?, last_bonus_at = ? WHERE id = ?').run(bonus, new Date().toISOString(), req.user.id);
    activity.logActivity({ user_id: req.user.id, event: 'billing:bonus_claim', details: { amount: bonus } });
    return res.json({ ok: true, amount: bonus });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});
router.post('/settings', express.urlencoded({ extended: true }), (req, res) => {
  try {
    const data = {};
    if (req.body.avatar_url) data.avatar = req.body.avatar_url;
    if (req.body.language) data.language = req.body.language;
    if (req.body.music_enabled !== undefined) data.music_enabled = req.body.music_enabled === 'on' || req.body.music_enabled === '1' || req.body.music_enabled === 'true' ? 1 : 0;
    if (req.body.music_volume !== undefined) data.music_volume = Math.max(0, Math.min(100, parseInt(req.body.music_volume, 10) || 35));
    if (req.body.sfx_enabled !== undefined) data.sfx_enabled = req.body.sfx_enabled === 'on' || req.body.sfx_enabled === '1' || req.body.sfx_enabled === 'true' ? 1 : 0;
    authService.updateUser(req.user.id, data);
    const loginHistory = activity.listLoginHistory({ user_id: req.user.id, limit: 50 });
    return render(res, 'account', { success: 'Settings saved!', loginHistory, tfaSetup: null });
  } catch (e) {
    const loginHistory = activity.listLoginHistory({ user_id: req.user.id, limit: 50 });
    return render(res, 'account', { error: e.message, loginHistory, tfaSetup: null });
  }
});

router.get('/settings/tfa/setup', (req, res) => {
  const tfaSetup = authService.setupTfa(req.user);
  const loginHistory = activity.listLoginHistory({ user_id: req.user.id, limit: 50 });
  return render(res, 'account', { tfaSetup, loginHistory });
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
