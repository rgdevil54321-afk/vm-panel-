'use strict';
const os = require('os');
const { execSync } = require('child_process');

function run(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', timeout: 4000 }).trim(); } catch (_) { return ''; }
}

// Auto-detect the host's own network + hardware so the panel can pre-fill
// static IP / gateway / prefix / DNS for VMs instead of asking the admin.
function detectNetwork() {
  const out = {
    hostname: run('hostname') || os.hostname() || '',
    primary_interface: '',
    gateway: '',
    dns: [],
    addresses: [],
    cpu_model: '',
    cpu_count: 0,
    mem_total_mb: 0,
    disk_free_gb: 0,
  };
  try {
    const j = JSON.parse(run('ip -j addr'));
    for (const itf of (j || [])) {
      const flags = itf.flags || [];
      if (flags.includes('LOOPBACK') && !flags.includes('UP')) continue;
      if (flags.includes('LOOPBACK')) continue;
      for (const a of (itf.addr_info || [])) {
        if (a.family !== 'inet') continue;
        out.addresses.push({
          iface: itf.ifname,
          addr: a.local,
          prefix: a.prefixlen,
          cidr: `${a.local}/${a.prefixlen}`,
        });
      }
      if (!out.primary_interface && itf.addr_info && itf.addr_info.some((a) => a.family === 'inet')) {
        out.primary_interface = itf.ifname;
      }
    }
  } catch (_) {}
  // Default route → gateway + primary interface
  try {
    const rt = JSON.parse(run('ip -j route'));
    for (const r of (rt || [])) {
      if (r.dst === 'default' && r.gateway && !out.gateway) {
        out.gateway = r.gateway;
        if (r.dev) out.primary_interface = r.dev;
      }
    }
  } catch (_) {}
  // DNS servers
  const resolv = run('cat /etc/resolv.conf 2>/dev/null');
  out.dns = resolv.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('nameserver'))
    .map((l) => l.split(/\s+/)[1])
    .filter(Boolean);
  // Host specs
  out.cpu_model = run('grep -m1 "model name" /proc/cpuinfo').replace(/^.*:\s*/g, '').trim();
  out.cpu_count = parseInt(run("grep -c '^processor' /proc/cpuinfo"), 10) || os.cpus().length || 0;
  const memKiB = parseInt(run("grep MemTotal /proc/meminfo | awk '{print $2}'"), 10) || 0;
  out.mem_total_mb = Math.floor(memKiB / 1024);
  const df = run('df -BG / 2>/dev/null | tail -1').split(/\s+/);
  out.disk_free_gb = parseInt(df[3], 10) || 0;
  return out;
}

module.exports = { detectNetwork };