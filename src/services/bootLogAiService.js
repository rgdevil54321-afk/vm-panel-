const fs = require('fs');
const path = require('path');
const vmService = require('./vmService');

const PATTERNS = [
  {
    id: 'disk_full',
    weight: 0.95,
    label: 'Disk full / out of space',
    severity: 'critical',
    hint: 'The disk may be full. Open File Manager and delete large files, or grow the disk in Storage tab.',
    patterns: [/No space left on device/i, /out of space/i, /ENOSPC/i, /write failed: no space/i],
  },
  {
    id: 'kernel_panic',
    weight: 0.95,
    label: 'Kernel panic',
    severity: 'critical',
    hint: 'Kernel panicked during boot. Try restarting; if persistent, reinstall the OS image.',
    patterns: [/kernel panic/i, /Oops:/, /BUG: unable to handle/i, /general protection fault/i],
  },
  {
    id: 'read_only_fs',
    weight: 0.9,
    label: 'Filesystem mounted read-only',
    severity: 'critical',
    hint: 'The filesystem switched to read-only, usually a disk error. Check disk health and grows.',
    patterns: [/Remounting filesystem read-only/i, /read-only file system/i],
  },
  {
    id: 'init_failure',
    weight: 0.85,
    label: 'Init / systemd failed to start',
    severity: 'high',
    hint: 'The init system failed. Boot into a rescue image or reinstall.',
    patterns: [/Failed to mount/i, /systemd\[1\]: Failed to start/i, /grub rescue/i, /no init found/i, /cannot.{0,30}find \/init/i],
  },
  {
    id: 'vnc_no_display',
    weight: 0.6,
    label: 'VNC stuck / no graphical session',
    severity: 'medium',
    hint: 'The server may be booting headless. A GUI only appears if a display manager is installed.',
    patterns: [/Starting GNOME Display Manager.*takes long/i, /display-manager.*failed/i, /no screens found/i, /No devices to open/],
  },
  {
    id: 'swap_oom',
    weight: 0.8,
    label: 'Out of memory',
    severity: 'high',
    hint: 'Out of memory during boot. Increase RAM or reduce services.',
    patterns: [/out of memory/i, /Cannot allocate memory/i, /oom-killer/i, /killed process/i],
  },
  {
    id: 'supervisor_dead',
    weight: 0.85,
    label: 'QEMU `supervisor` process exited unexpectedly',
    severity: 'critical',
    hint: 'The QEMU process died. Check qemu.log tail for the exit reason, then restart.',
    patterns: [/supervisor: connection closed/i, /kvm: already loaded|failed to initialize kvm/i, /qemu: terminated/i, /vmrun:\s+(failed|error)/i],
  },
  {
    id: 'timeout_issue',
    weight: 0.7,
    label: 'Slow boot / long delays',
    severity: 'medium',
    hint: 'Boot is stalled on a service. This is often a missing kernel module or slow disk.',
    patterns: [/a start job is running for/i, /Timed out waiting for/i, /dependency failed/i],
  },
  {
    id: 'no_network',
    weight: 0.75,
    label: 'Network interface failed to come up',
    severity: 'high',
    hint: 'The VM cannot reach the network. Check the NIC model and that the bridge exists.',
    patterns: [/link is not ready/i, /no carrier/i, /Failed to start .*network/i, /dhcp.*failed|failed to get ip/i],
  },
  {
    id: 'fsck_errors',
    weight: 0.7,
    label: 'Filesystem check errors',
    severity: 'medium',
    hint: 'fsck reported inconsistencies. This can be transient after a crash.',
    patterns: [/fsck.*error/i, /EXT4-fs error/i, /journal.*corrupt/i, /recover journal/i],
  },
  {
    id: 'leader_booted',
    weight: 0.4,
    label: 'System booted (informational)',
    severity: 'info',
    hint: 'Logs indicate the reachable end of boot. If SSH is unreachable, check the firewall rules.',
    patterns: [/Reached target.*Multi-User System/i, /Started.*Login Service/i, /KVM.*[0-9.]+ q35/i],
  },
];

function analyze(text) {
  const findings = [];
  const limit = Math.min(text.length, 200000);
  const sample = text.slice(-limit);
  for (const p of PATTERNS) {
    for (const re of p.patterns) {
      if (re.test(sample)) {
        const m = sample.match(re);
        findings.push({
          id: p.id,
          label: p.label,
          severity: p.severity,
          confidence: p.weight,
          hint: p.hint,
          match: m ? m[0].slice(0, 200) : null,
        });
        break;
      }
    }
  }
  // de-dup by id (keep the most severe instance)
  const seen = new Map();
  for (const f of findings) {
    const prev = seen.get(f.id);
    if (!prev || prev.confidence < f.confidence) seen.set(f.id, f);
  }
  const list = [...seen.values()];
  let state = 'healthy';
  let score = 0;
  if (list.some((f) => f.severity === 'critical')) { state = 'critical'; score = 0.9; }
  else if (list.some((f) => f.severity === 'high')) { state = 'concerning'; score = 0.65; }
  else if (list.some((f) => f.severity === 'medium')) { state = 'warning'; score = 0.4; }
  if (list.some((f) => f.id === 'leader_booted')) {
    // A booted marker + lower-severity findings => likely reached login
    if (state === 'warning' || state === 'healthy') { state = 'booting'; score = Math.max(score, 0.25); }
  }
  return { state, score, findings: list.slice(0, 12) };
}

/**
 * Root cause summary for a VM boot log. Pass vm (already loaded).
 */
function diagnose(vm) {
  let log = '';
  try { log = vmService.getBootLog(vm); } catch (_) {}
  const metrics = {
    lines: log ? log.split('\n').length : 0,
    chars: log ? log.length : 0,
  };
  const analysis = analyze(log || '');
  return { ...analysis, metrics, has_log: !!log };
}

module.exports = { analyze, diagnose };