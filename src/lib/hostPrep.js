'use strict';

// Host-level preparation the panel needs in order to run VMs. Everything here is
// best-effort: if the panel is not root (or the host is not Linux) we log a clear
// one-line fix and carry on rather than crashing the panel.

const fs = require('fs');
const logger = require('./logger');

const PROCFS = '/proc/sys/vm/overcommit_memory';
const SYSCTL_FILE = '/etc/sysctl.d/99-venlix-vm.conf';
const SYSCTL_BODY = '# Venlix Nodes: let VMs reserve more RAM than is free right now.\n# QEMU maps the whole guest RAM up-front; the default heuristic overcommit\n# policy refuses that and surfaces as "cannot set up guest memory \'pc.ram\'".\nvm.overcommit_memory = 1\n';

function readOvercommit() {
  try {
    return fs.readFileSync(PROCFS, 'utf8').trim();
  } catch (_) {
    return null;
  }
}

function readSwapTotalKb() {
  try {
    const mem = fs.readFileSync('/proc/meminfo', 'utf8');
    const m = /^SwapTotal:\s+(\d+)\s+kB/m.exec(mem);
    return m ? parseInt(m[1], 10) : null;
  } catch (_) {
    return null;
  }
}

function writeQuiet(file, data) {
  try {
    fs.writeFileSync(file, data);
    return true;
  } catch (_) {
    return false;
  }
}

// A VM asks QEMU to map its full guest RAM at start. Under Linux's default
// heuristic overcommit (mode 0) that mmap is refused whenever the request is
// larger than free memory + swap, so a 63 GB guest on a 64 GB host fails with
// `cannot set up guest memory 'pc.ram': Cannot allocate memory` even though it
// would never touch most of that RAM. Mode 1 (always overcommit) is what
// libvirt/Proxmox hosts use; it lets the reservation succeed. Apply it on every
// boot so a fresh install "just works" without a manual sysctl.
function ensureMemoryOvercommit() {
  if (process.platform !== 'linux') return { supported: false };

  const before = readOvercommit();
  if (before === null) {
    logger.warn('[host] overcommit: cannot read ' + PROCFS + ' — skipping (non-standard host?)');
    return { supported: false };
  }

  // Persist first so a reboot keeps the setting even if writing /proc now fails.
  const persisted = writeQuiet(SYSCTL_FILE, SYSCTL_BODY);

  if (before === '1') return { supported: true, value: 1, changed: false, persisted };

  let applied = false;
  try {
    fs.writeFileSync(PROCFS, '1');
    applied = readOvercommit() === '1';
  } catch (e) {
    logger.warn('[host] overcommit: could not raise vm.overcommit_memory to 1 (' + (e.code || e.message) + '). Large VMs may fail to start. Fix with: sudo sysctl -w vm.overcommit_memory=1');
  }

  if (applied) {
    logger.info('[host] overcommit: vm.overcommit_memory ' + before + ' -> 1 (VMs may now reserve RAM beyond free memory)');
  }

  return { supported: true, value: applied ? 1 : Number(before), changed: applied, persisted };
}

// Not fatal, but worth one line: with overcommit on and no swap, a host that
// genuinely fills its RAM will OOM-kill guests instead of paging.
function warnIfNoSwap() {
  if (process.platform !== 'linux') return;
  const swapKb = readSwapTotalKb();
  if (swapKb === 0) {
    logger.warn('[host] no swap configured — guests that outgrow RAM will be OOM-killed. Optional: sudo fallocate -l 16G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile');
  }
}

// Panel-safety net: bias the kernel to kill a guest (QEMU) before it kills the
// panel if the host ever does run out of memory. -500 keeps the panel strongly
// preferred over guests without making it unkillable forever (which would risk a
// host-wide livelock if the panel itself misbehaved). Best-effort; needs root.
function protectPanelProcess() {
  if (process.platform !== 'linux') return { supported: false };
  const target = -500;
  try {
    const cur = parseInt(fs.readFileSync('/proc/self/oom_score_adj', 'utf8').trim(), 10);
    if (Number.isFinite(cur) && cur <= target) return { supported: true, value: cur, changed: false };
    fs.writeFileSync('/proc/self/oom_score_adj', String(target));
    logger.info('[host] oom: panel oom_score_adj set to ' + target + ' (guests are killed before the panel)');
    return { supported: true, value: target, changed: true };
  } catch (e) {
    // Not root, or a kernel without oom_score_adj: the pinned VM RAM cap is the
    // real protection, so this is only a bonus.
    return { supported: false, error: e.code || e.message };
  }
}

module.exports = { ensureMemoryOvercommit, warnIfNoSwap, protectPanelProcess, readOvercommit, readSwapTotalKb };
