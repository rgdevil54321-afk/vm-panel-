const express = require('express');
const vmService = require('../services/vmService');
const sshxService = require('../services/sshxService');
const activity = require('../services/activityService');
const { requireAuth } = require('../middleware/auth');

// Fallback terminal: sshx share links for a VM's SSH session, used when the
// panel console cannot connect. Owner/admin only - the link hands out a shell
// in the guest, and generating it needs the plaintext root password.
const router = express.Router();
router.use(requireAuth);

function gate(req, res) {
  const vm = vmService.getVm(parseInt(req.params.id, 10));
  if (!vm || !vmService.canAccess(req.user, vm, 'console')) {
    res.status(404).json({ error: 'Server not found or no access.' });
    return null;
  }
  if (!vmService.isOwnerOrAdmin(req.user, vm)) {
    res.status(403).json({ error: 'Only the server owner can generate an SSH link.' });
    return null;
  }
  if (!vmService.isRunning(vm)) {
    res.status(400).json({ error: 'Start the server first.' });
    return null;
  }
  return vm;
}

const ah = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res, next);
    if (out && typeof out.catch === 'function') out.catch(next);
  } catch (e) { next(e); }
};

router.post('/servers/:id/sshx', express.json(), ah(async (req, res) => {
  const vm = gate(req, res);
  if (!vm) return;
  try {
    const r = await sshxService.start(vm);
    if (!r.reused) {
      activity.logActivity({ user_id: req.user.id, vm_id: vm.id, event: 'vm:sshx_link', details: { name: vm.name } });
    }
    res.json({ ok: true, url: r.url, reused: !!r.reused, sshpass: !!r.sshpass });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || 'Failed to start sshx session' });
  }
}));

router.post('/servers/:id/sshx/stop', express.json(), ah(async (req, res) => {
  const vm = gate(req, res);
  if (!vm) return;
  sshxService.stop(vm);
  res.json({ ok: true });
}));

module.exports = router;
