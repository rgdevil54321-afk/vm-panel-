'use strict';

function spoof(vm) {
  return {
    cpu: String((vm && vm.neofetch_cpu) || '').trim(),
    mem: String((vm && vm.neofetch_mem) || '').trim(),
    disk: String((vm && vm.neofetch_disk) || '').trim(),
  };
}

function real(vm) {
  const memory = Number((vm && vm.memory) || 0);
  return {
    cpu: `${(vm && vm.cpus) || 0} vCPU`,
    mem: `${memory} MB`,
    memGb: (memory / 1024).toFixed(1),
    memMb: memory,
    disk: String((vm && vm.disk_size) || ''),
  };
}

// Best-effort parse of a human size ("256 GB", "2TB", "8192 MB") into MB.
function parseMb(text) {
  const m = String(text || '').match(/([\d.]+)\s*(tb|gb|mb|kb|b)?/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n) || n <= 0) return null;
  const unit = (m[2] || 'mb').toLowerCase();
  const mult = { b: 1 / (1024 * 1024), kb: 1 / 1024, mb: 1, gb: 1024, tb: 1024 * 1024 }[unit] || 1;
  return Math.round(n * mult);
}

// User-facing view: when a spoof is set, show ONLY the spoofed specs.
function display(vm) {
  const s = spoof(vm);
  const r = real(vm);
  const hasSpoof = !!(s.cpu || s.mem || s.disk);
  return {
    hasSpoof,
    spoof: s,
    real: r,
    cpu: s.cpu || r.cpu,
    mem: s.mem || r.mem,
    memGb: s.mem ? null : r.memGb,
    memTotalMb: s.mem ? (parseMb(s.mem) || r.memMb) : r.memMb,
    disk: s.disk || r.disk,
  };
}

module.exports = { spoof, real, display, parseMb };
