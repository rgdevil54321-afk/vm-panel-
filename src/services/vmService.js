const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn, execSync, spawnSync } = require('child_process');
const net = require('net');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const config = require('../lib/config');
const { db, settings } = require('../lib/db');
const logger = require('../lib/logger');
const nodeRegistry = require('./nodeRegistry');
const { logActivity } = require('./activityService');
const webhooks = require('./webhookService');
const neofetchService = require('./neofetchService');

const VM_DIR = config.vmDir;
const RUNNING_PREFIX = 'qemu-system';

// Available memory in bytes: min(host view, cgroup v1/v2 limit for containers).
// Returns { bytes, limitedBy } so error messages explain WHERE the cap comes from.
function memoryBudget() {
  let avail = os.freemem();
  let limitedBy = 'host free memory (' + Math.round(os.freemem() / 1024 ** 2) + ' MB)';
  try {
    // cgroup v2
    const max = parseInt(fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim(), 10);
    const cur = parseInt(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim(), 10);
    if (Number.isFinite(max) && max > 0) {
      const cg = Math.max(0, max - cur);
      if (cg < avail) { avail = cg; limitedBy = 'container/cgroup v2 limit (' + Math.round(max / 1024 ** 2) + ' MB total, ' + Math.round(cur / 1024 ** 2) + ' MB used)'; }
    }
  } catch (_) {}
  try {
    // cgroup v1
    const lim = parseInt(fs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim(), 10);
    const used = parseInt(fs.readFileSync('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf8').trim(), 10);
    if (Number.isFinite(lim) && lim > 0 && lim < os.totalmem()) {
      const cg = Math.max(0, lim - used);
      if (cg < avail) { avail = cg; limitedBy = 'container/cgroup v1 limit (' + Math.round(lim / 1024 ** 2) + ' MB total, ' + Math.round(used / 1024 ** 2) + ' MB used)'; }
    }
  } catch (_) {}
  return { bytes: avail, limitedBy };
}

function ensureDirs() {
  for (const d of [VM_DIR, config.uploads.backup]) {
    fs.mkdirSync(d, { recursive: true });
  }
}
ensureDirs();

function vmDir(vm) {
  return path.join(VM_DIR, String(vm.id));
}

function hasBin(bin) {
  return spawnSync('which', [bin], { stdio: 'ignore' }).status === 0;
}

function getOsList() {
  let raw = settings.get('vm.os_list');
  if (typeof raw === 'string') raw = JSON.parse(raw);
  return Array.isArray(raw) ? raw : [];
}

function parseForwards(str) {
  const out = [];
  if (!str) return out;
  for (const part of String(str).split(',')) {
    const m = part.trim().match(/^(\d+):(\d+)$/);
    if (m) out.push({ host: parseInt(m[1], 10), guest: parseInt(m[2], 10) });
  }
  return out;
}

function inUsePort(port) {
  try {
    execSync(`ss -tln | grep -q ':${port} '`, { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

function allocPort() {
  const min = parseInt(settings.get('vm.auto_port_min') || config.autoPortMin, 10);
  const max = parseInt(settings.get('vm.auto_port_max') || config.autoPortMax, 10);
  const used = new Set(
    db.prepare('SELECT ssh_port FROM vms').all().map((r) => r.ssh_port)
  );
  for (let p = min; p <= max; p++) {
    if (!used.has(p) && !inUsePort(p)) return p;
  }
  throw new Error(`No free port in range ${min}-${max}. All ports in use.`);
}

function allocVncPort() {
  const min = parseInt(settings.get('vm.vnc_port_min') || config.autoVncPortMin, 10);
  const max = parseInt(settings.get('vm.vnc_port_max') || config.autoVncPortMax, 10);
  if (min <= 5900) throw new Error('VNC port range must start above 5900');
  const used = new Set(
    db.prepare('SELECT vnc_port FROM vms').all().map((r) => r.vnc_port)
  );
  for (let p = min; p <= max; p++) {
    if (!used.has(p) && !inUsePort(p)) return p;
  }
  throw new Error(`No free VNC port in range ${min}-${max}. All ports in use.`);
}

function allocAgentPort() {
  const min = parseInt(settings.get('vm.agent_port_min') || config.autoAgentPortMin, 10);
  const max = parseInt(settings.get('vm.agent_port_max') || config.autoAgentPortMax, 10);
  const used = new Set(
    db.prepare('SELECT agent_port FROM vms').all().map((r) => r.agent_port)
  );
  for (let p = min; p <= max; p++) {
    if (!used.has(p) && !inUsePort(p)) return p;
  }
  throw new Error(`No free agent port in range ${min}-${max}. All ports in use.`);
}

function genAgentToken() {
  return crypto.randomBytes(24).toString('hex');
}

function ensureAgentPort(vm) {
  if (!vm.agent_port) {
    vm.agent_port = allocAgentPort();
    db.prepare('UPDATE vms SET agent_port = ?, updated_at = ? WHERE id = ?').run(vm.agent_port, now(), vm.id);
  }
  if (!vm.agent_token) {
    vm.agent_token = genAgentToken();
    db.prepare('UPDATE vms SET agent_token = ?, updated_at = ? WHERE id = ?').run(vm.agent_token, now(), vm.id);
  }
  return vm;
}

function ensureVncPort(vm) {
  if (vm.vnc_port) return vm.vnc_port;
  const port = allocVncPort();
  db.prepare('UPDATE vms SET vnc_port = ?, updated_at = ? WHERE id = ?').run(port, now(), vm.id);
  vm.vnc_port = port;
  return port;
}

function isRemoteVm(vm) {
  return vm && (Number(vm.node_id) || 1) !== 1;
}

// Neofetch-style OS label for the spoofed guest banner, e.g. "Ubuntu x86_64".
function guestOsLabel(vm) {
  const t = String((vm && (vm.os_type || vm.os)) || '').trim();
  if (!t) return '';
  if (/\s/.test(t)) return t;
  const cap = t.charAt(0).toUpperCase() + t.slice(1);
  const arch = os.arch() === 'x64' ? 'x86_64' : (os.arch() || 'x86_64');
  return `${cap} ${arch}`;
}

function remoteNodeFor(vm) {
  return nodeRegistry.getNode(vm.node_id);
}

// resolve live status for a VM, dispatching to its node when remote
async function resolveStatus(vm) {
  if (isRemoteVm(vm)) {
    const node = remoteNodeFor(vm);
    if (!node) return 'stopped';
    try {
      return await nodeRegistry.vmStatusOnNode(node, vm);
    } catch (e) {
      return 'stopped';
    }
  }
  return statusOf(vm);
}

function hasKvm() {
  if (process.env.NO_KVM === '1' || process.env.NOKVM === '1') return false;
  try {
    if (!fs.existsSync('/dev/kvm')) return false;
    fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function buildQemuArgs(vm) {
  const dir = vmDir(vm);
  const img = vm.img_file || path.join(dir, 'disk.qcow2');
  const seed = vm.seed_file || path.join(dir, 'seed.iso');
  const fwds = parseForwards(vm.port_forwards);
  const kvmAvailable = hasKvm();
  const accelMode = kvmAvailable ? 'kvm:tcg' : 'tcg';
  const userCpuModel = String(vm.cpu_model || 'default');
  const cpuModel = kvmAvailable && userCpuModel && userCpuModel !== 'default' && userCpuModel !== 'host'
    ? userCpuModel : (kvmAvailable ? 'host' : 'qemu64');
  const sockets = Math.max(1, parseInt(vm.cpu_sockets, 10) || 1);
  const cores = Math.max(1, parseInt(vm.cores_per_socket, 10) || 1);
  const threads = Math.max(1, parseInt(vm.threads_per_core, 10) || 1);
  const smp = `sockets=${sockets},cores=${cores},threads=${threads}`;

  // Hardware spoof (DMI/SMBIOS + optional hypervisor masking)
  const spoofHw = String(settings.get('vm.spoof_hw') ?? '1') !== '0';
  const hideHv = String(settings.get('vm.spoof_hypervisor') || '0') === '1';
  const scr = (v, d) => String(v && String(v).trim() ? v : d).trim().replace(/,/g, ' ').replace(/'/g, '').slice(0, 60);
  const uuidOk = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(String(vm.uuid || ''));
  const smbiosSpoof = spoofHw ? [
    `type=0,vendor=${scr(settings.get('vm.spoof_bios_vendor'), 'American Megatrends International, LLC.')},version=${scr(settings.get('vm.spoof_bios_version'), '5.27')},date=${scr(settings.get('vm.spoof_bios_date'), '02/16/2023')}`,
    `type=1,manufacturer=${scr(settings.get('vm.spoof_sys_manufacturer'), 'Dell Inc.')},product=${scr(settings.get('vm.spoof_sys_product'), 'PowerEdge R740')},version=${scr(settings.get('vm.spoof_sys_version'), 'Not Specified')},serial=${scr(settings.get('vm.spoof_sys_serial'), '2X4C4R2')},family=Server${uuidOk ? `,uuid=${vm.uuid}` : ''}`,
    `type=2,manufacturer=${scr(settings.get('vm.spoof_board_manufacturer'), 'Dell Inc.')},product=${scr(settings.get('vm.spoof_board_product'), '0CNDVR')},serial=${scr(settings.get('vm.spoof_board_serial'), '/2X4C4R2/CN7476347A00R9.')}`,
    `type=3,manufacturer=${scr(settings.get('vm.spoof_sys_manufacturer'), 'Dell Inc.')},version=${scr(settings.get('vm.spoof_sys_version'), 'Not Specified')},serial=${scr(settings.get('vm.spoof_sys_serial'), '2X4C4R2')}`,
  ] : [];
  const cpuArg = kvmAvailable && hideHv ? `${cpuModel},kvm=off,-hypervisor` : cpuModel;

  // Memory: base, optional balloon min + hotplug max
  let memBase = String(vm.memory || '2048');
  const memMax = parseInt(vm.mem_max, 10);
  const ballooning = String(vm.ballooning) === '1' || String(vm.ballooning) === 'true';
  // Hotplug: allow ballooning up to memMax via QEMU maxmem + slots (memory_hotplug)
  const memBaseVal = parseInt(memBase, 10);
  if ((memMax && memMax > memBaseVal) || (vm.memory_hotplug && vm.memory_hotplug > memBaseVal)) {
    const hotMax = Math.max(memMax || 0, parseInt(vm.memory_hotplug, 10) || 0);
    memBase = `${memBase},maxmem=${hotMax},slots=4`;
  }
  const args = [
    '-m', memBase,
    '-smp', smp,
    '-cpu', cpuArg,
    '-machine', `type=${String(vm.machine_type || 'pc').split(',')[0]},accel=${accelMode}`,
  ];
  if (smbiosSpoof.length) {
    for (const s of smbiosSpoof) args.push('-smbios', s);
    if (uuidOk) args.push('-uuid', vm.uuid);
  }

  // Firmware / UEFI / secure boot / TPM
  const firmware = String(vm.firmware || 'bios');
  if (firmware === 'uefi' || String(vm.secure_boot || '') === '1') {
    args.push('-drive', 'if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE.fd');
    args.push('-drive', `if=pflash,format=raw,file=${path.join(dir, 'efi_vars.fd')}`);
  }
  if (String(vm.tpm || '') === '1') {
    if (hasBin('swtpm')) {
      args.push('-chardev', `socket,id=chrtpm,path=${path.join(dir, 'swtpm.sock')}`);
      args.push('-tpmdev', 'emulator,id=tpm0,chardev=chrtpm');
      args.push('-object', 'tpm-crb,id=tpm0');
    } else {
      logger.warn('[vm] TPM requested but swtpm is not installed; skipping TPM device');
    }
  }

  // Primary disk (cloud image / install media). qcow2 format.
  args.push('-drive', `file=${img},format=qcow2,if=virtio`);

  // Additional data disks
  let dataDisks = [];
  try { dataDisks = JSON.parse(vm.additional_disks || '[]'); } catch (_) { dataDisks = []; }
  let di = 0;
  for (const d of dataDisks) {
    if (!d || !d.size) continue;
    di++;
    const relName = d.name ? String(d.name).replace(/[^a-zA-Z0-9_\-.]/g, '') : `data-${di}.qcow2`;
    const dataFile = path.join(dir, relName.endsWith('.qcow2') ? relName : relName + '.qcow2');
    if (!fs.existsSync(dataFile)) continue;
    args.push('-drive', `file=${dataFile},format=qcow2,if=${String(d.bus || 'virtio').toLowerCase()}`);
  }
  args.push('-drive', `file=${seed},format=raw,if=virtio`);

  // Boot order
  const bootOrder = String(vm.boot_order || 'c').replace(/[^a-z]/gi, '');
  args.push('-boot', `order=${bootOrder || 'c'}`);

  // Network: NIC model + count (slirp user net per NIC)
  // 'virtio' is a shorthand for the full QEMU device name 'virtio-net-pci'.
  const rawNic = String(vm.nic_model || 'virtio').toLowerCase();
  const nicModel = rawNic === 'virtio' ? 'virtio-net' : rawNic;
  const nicCount = Math.max(1, Math.min(6, parseInt(vm.nic_count, 10) || 1));
  args.push('-device', `${nicModel}-pci,netdev=n0`);
  args.push('-netdev', `user,id=n0,hostfwd=tcp::${vm.ssh_port}-:22${vm.agent_port ? `,hostfwd=tcp::${vm.agent_port}-:9090` : ''}`);
  let ni = 1;
  for (const f of fwds) {
    args.push('-device', `${nicModel}-pci,netdev=n${ni}`);
    args.push('-netdev', `user,id=n${ni},hostfwd=tcp::${f.host}-:${f.guest}`);
    ni++;
  }
  for (; ni < nicCount; ni++) {
    args.push('-device', `${nicModel}-pci,netdev=n${ni}`);
    args.push('-netdev', `user,id=n${ni}`);
  }

  args.push('-object', 'rng-random,filename=/dev/urandom,id=rng0');
  args.push('-device', 'virtio-rng-pci,rng=rng0');
  args.push('-rtc', 'base=utc,clock=host');
  if (ballooning) args.push('-device', 'virtio-balloon-pci');

  if (vm.vnc_port) {
    args.push('-vnc', `127.0.0.1:${vm.vnc_port - 5900}`);
    if (vm.gui_mode && process.env.DISPLAY) {
      args.push('-display', 'gtk');
    }
  } else if (vm.gui_mode && process.env.DISPLAY) {
    args.push('-display', 'gtk');
  } else {
    args.push('-display', 'none');
  }

  args.push(
    '-serial', `file:${path.join(dir, 'boot.log')}`,
    '-vga', 'std',
    '-pidfile', path.join(dir, 'qemu.pid'),
    '-qmp', `unix:${path.join(dir, 'qmp.sock')},server,nowait`,
    '-daemonize',
  );

  return args;
}

function getBootLog(vm) {
  const dir = vmDir(vm);
  let content = '';
  const bootLog = path.join(dir, 'boot.log');
  const qemuLog = path.join(dir, 'qemu.log');
  if (fs.existsSync(bootLog)) {
    try {
      const data = fs.readFileSync(bootLog, 'utf8');
      if (data && data.trim()) content += data;
    } catch (_) {}
  }
  if (fs.existsSync(qemuLog)) {
    try {
      const qdata = fs.readFileSync(qemuLog, 'utf8');
      if (qdata && qdata.trim()) {
        content = (content ? content + '\n\n=== QEMU System Output ===\n' : '') + qdata;
      }
    } catch (_) {}
  }
  return content || '[Boot Log] No boot output recorded yet. Start the server to stream boot logs.';
}

function clearBootLog(vm) {
  const dir = vmDir(vm);
  const bootLog = path.join(dir, 'boot.log');
  const qemuLog = path.join(dir, 'qemu.log');
  try {
    if (fs.existsSync(bootLog)) fs.writeFileSync(bootLog, '', 'utf8');
    if (fs.existsSync(qemuLog)) fs.writeFileSync(qemuLog, '', 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

function pidOf(vm) {
  const file = path.join(vmDir(vm), 'qemu.pid');
  try {
    const pid = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    if (pid > 0) return pid;
  } catch (_) {}
  return null;
}

function isRunning(vm) {
  if (!vm) return false;
  if ((Number(vm.node_id) || 1) !== 1) {
    return (vm.status || 'stopped') === 'running';
  }
  const pid = pidOf(vm);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function statusOf(vm) {
  if (!vm) return 'stopped';
  if ((Number(vm.node_id) || 1) !== 1) return vm.status || 'stopped';
  return isRunning(vm) ? 'running' : 'stopped';
}

// ---------------------------------------------------------------------------
// QMP/HMP monitor helpers + snapshots + io/net telemetry (local VMs).
// Mirrors the node-agent implementation; remote VMs proxy to the agent.
// ---------------------------------------------------------------------------
function localQmpTalk(vm, commandLine) {
  return new Promise((resolve) => {
    const sockPath = path.join(vmDir(vm), 'qmp.sock');
    if (!fs.existsSync(sockPath)) return resolve({ error: 'QMP socket not present (VM not running?)' });
    let sock;
    try {
      sock = net.connect(sockPath);
    } catch (e) {
      return resolve({ error: e.message });
    }
    let buf = '';
    let phase = 'greeting';
    let settled = false;
    function settle(err, data) {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (_) {}
      resolve(err ? { error: String(err.message || err) } : data);
    }
    sock.on('error', (e) => settle(new Error('QMP socket: ' + (e.message || e))));
    sock.setTimeout(8000, () => settle(new Error('QMP timeout')));
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let o;
        try { o = JSON.parse(line); } catch (_) { continue; }
        if (o && o.event) continue;
        if (phase === 'greeting' && o && o.QMP) {
          phase = 'capwait';
          sock.write(JSON.stringify({ execute: 'qmp_capabilities' }) + '\n');
          continue;
        }
        if (phase === 'capwait' && o && o.return !== undefined) {
          phase = 'ready';
          sock.write(commandLine + '\n');
          continue;
        }
        if (phase === 'ready') {
          if (o && o.error) return settle(new Error('QMP: ' + (o.error.desc || o.error.class)));
          if (o && o.return !== undefined) return settle(null, o.return);
        }
      }
    });
  });
}

async function localHmp(vm, cmd) {
  const r = await localQmpTalk(vm, JSON.stringify({ execute: 'human-monitor-command', arguments: { 'command-line': cmd } }));
  if (r && r.error) throw new Error(r.error);
  return r && r.return !== undefined ? r.return : '';
}

const LOCAL_SNAP_LINE = /^\s*(\d+)\s+(\S+)\s+([0-9.]+(?:\s*(?:KiB|MiB|GiB|kB|MB|GB|bytes))?)\s+(.+)$/;

function parseSnapshotsLocal(text) {
  const out = [];
  if (!text) return out;
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\r/g, '');
    const m = line.match(LOCAL_SNAP_LINE);
    if (!m) continue;
    const sizeText = (m[3] || '').trim();
    let sizeBytes = 0;
    const sizeM = sizeText.match(/^([0-9.]+)\s*(KiB|MiB|GiB|kB|MB|GB|bytes)?$/i);
    if (sizeM) {
      const num = parseFloat(sizeM[1]);
      const u = (sizeM[2] || 'bytes').toLowerCase();
      if (u === 'gib' || u === 'gb') sizeBytes = num * 1024 ** 3;
      else if (u === 'mib' || u === 'mb') sizeBytes = num * 1024 ** 2;
      else if (u === 'kib' || u === 'kb') sizeBytes = num * 1024;
      else sizeBytes = num;
    }
    out.push({ id: parseInt(m[1], 10), name: m[2], size_text: sizeText, size_bytes: sizeBytes, date: (m[4] || '').trim().slice(0, 22), vmclock: (m[4] || '').trim().split(/\s+/)[3] || '' });
  }
  return out;
}

function sanitizeSnapNameLocal(name) {
  const clean = String(name || '').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return clean || 'snap-' + Date.now().toString(36);
}

function parseHumanBytesLocal(text) {
  const m = String(text || '0').trim().match(/^([0-9.]+)\s*([KMG]?i?B|bytes)?$/i);
  if (!m) return 0;
  const num = parseFloat(m[1]);
  const u = (m[2] || 'bytes').toLowerCase();
  if (u === 'gib' || u === 'gb') return num * 1024 ** 3;
  if (u === 'mib' || u === 'mb') return num * 1024 ** 2;
  if (u === 'kib' || u === 'kb') return num * 1024;
  return num;
}

async function localIoStats(vm) {
  if (!isRunning(vm)) return { read_bytes: 0, write_bytes: 0, reads: 0, writes: 0 };
  const r = await localQmpTalk(vm, JSON.stringify({ execute: 'query-blockstats' })).catch(() => null);
  let readBytes = 0, writeBytes = 0, reads = 0, writes = 0;
  if (r && Array.isArray(r)) {
    for (const d of r) {
      const s = d.stats || {};
      if (Number.isFinite(s.rd_bytes)) { readBytes += s.rd_bytes; reads += s.rd_operations || 0; }
      if (Number.isFinite(s.wr_bytes)) { writeBytes += s.wr_bytes; writes += s.wr_operations || 0; }
    }
  }
  return { read_bytes: readBytes, write_bytes: writeBytes, reads, writes };
}

async function localNetTotals(vm) {
  if (!isRunning(vm)) return { rx_bytes: 0, tx_bytes: 0, rx_packets: 0, tx_packets: 0 };
  try {
    const text = await localHmp(vm, 'info usernet');
    let rxBytes = 0, txBytes = 0, rxPkts = 0, txPkts = 0;
    for (const raw of String(text).split('\n')) {
      const line = raw.replace(/\r/g, '');
      const m = line.match(/<<\s*([0-9.]+(?:[KMG]i?B|bytes)?)\[(\d+)\]\s*>>\s*([0-9.]+(?:[KMG]i?B|bytes)?)\[(\d+)\]/i);
      if (!m) continue;
      rxBytes += parseHumanBytesLocal(m[1]);
      rxPkts += parseInt(m[2], 10) || 0;
      txBytes += parseHumanBytesLocal(m[3]);
      txPkts += parseInt(m[4], 10) || 0;
    }
    return { rx_bytes: rxBytes, tx_bytes: txBytes, rx_packets: rxPkts, tx_packets: txPkts };
  } catch (e) {
    return { rx_bytes: 0, tx_bytes: 0, rx_packets: 0, tx_packets: 0 };
  }
}

async function localListSnapshots(vm) {
  try {
    if (isRunning(vm)) return { ok: true, snapshots: parseSnapshotsLocal(await localHmp(vm, 'info snapshots')) };
    const img = vm.img_file || path.join(vmDir(vm), 'disk.qcow2');
    if (!fs.existsSync(img)) return { ok: true, snapshots: [] };
    const r = spawnSync('qemu-img', ['snapshot', '-l', img], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('qemu-img snapshot -l: ' + (r.stderr || 'failed'));
    return { ok: true, snapshots: parseSnapshotsLocal(r.stdout) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function localCreateSnapshot(vm, name) {
  const tag = sanitizeSnapNameLocal(name);
  if (isRunning(vm)) {
    const r = await localHmp(vm, 'savevm ' + tag).catch((e) => ({ error: e.message }));
    if (r && r.error) throw new Error('savevm failed: ' + r.error);
    return { ok: true, name: tag, running: true };
  }
  const img = vm.img_file || path.join(vmDir(vm), 'disk.qcow2');
  const r = spawnSync('qemu-img', ['snapshot', '-c', tag, img], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('Snapshot failed: ' + (r.stderr || 'qemu-img returned ' + r.status));
  return { ok: true, name: tag, running: false };
}

async function localDeleteSnapshot(vm, name) {
  const tag = sanitizeSnapNameLocal(name);
  if (isRunning(vm)) {
    const r = await localHmp(vm, 'delvm ' + tag).catch((e) => ({ error: e.message }));
    if (r && r.error) throw new Error('delvm failed: ' + r.error);
    return { ok: true };
  }
  const img = vm.img_file || path.join(vmDir(vm), 'disk.qcow2');
  const r = spawnSync('qemu-img', ['snapshot', '-d', tag, img], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('Snapshot delete failed: ' + (r.stderr || 'qemu-img returned ' + r.status));
  return { ok: true };
}

async function localRevertSnapshot(vm, name) {
  const tag = sanitizeSnapNameLocal(name);
  if (isRunning(vm)) {
    let err = null;
    try { await localHmp(vm, 'stop'); } catch (e) {}
    try {
      const r = await localHmp(vm, 'loadvm ' + tag).catch((e) => ({ error: e.message }));
      if (r && r.error) err = r.error;
    } catch (e) { err = e.message; }
    try { await localHmp(vm, 'cont'); } catch (e) {}
    if (err) throw new Error('Revert (live) failed: ' + err);
    return { ok: true, running: true };
  }
  const img = vm.img_file || path.join(vmDir(vm), 'disk.qcow2');
  const r = spawnSync('qemu-img', ['snapshot', '-a', tag, img], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('Revert failed: ' + (r.stderr || 'qemu-img returned ' + r.status));
  return { ok: true, running: false };
}

async function localFullStats(vm) {
  const live = liveStats(vm);
  const [io, net2] = await Promise.all([localIoStats(vm), localNetTotals(vm)]);
  return { ...live, io, network: net2 };
}

// ---- Dispatchers (local vs remote node) ----
function isLocalVm(vm) {
  return (Number(vm.node_id) || 1) === 1;
}

async function snapshotsFor(vm) {
  if (isLocalVm(vm)) return localListSnapshots(vm);
  const node = nodeRegistry.getNode(vm.node_id);
  if (!node) throw new Error('No node owns this VM');
  const d = await nodeRegistry.listSnapshotsOnNode(node, vm);
  if (d && d.ok === false) throw new Error(d.error || 'Failed to list snapshots');
  return { snapshots: (d.snapshots || []).map((s) => ({ ...s, date: s.date || '' })) };
}

async function createSnapshotFor(vm, name) {
  if (isLocalVm(vm)) return localCreateSnapshot(vm, name);
  const node = nodeRegistry.getNode(vm.node_id);
  if (!node) throw new Error('No node owns this VM');
  const d = await nodeRegistry.createSnapshotOnNode(node, vm, name);
  if (d && d.ok === false) throw new Error(d.error || 'Snapshot failed');
  return { ok: true, name: String(name) };
}

async function revertSnapshotFor(vm, name) {
  if (isLocalVm(vm)) return localRevertSnapshot(vm, name);
  const node = nodeRegistry.getNode(vm.node_id);
  if (!node) throw new Error('No node owns this VM');
  const d = await nodeRegistry.revertSnapshotOnNode(node, vm, name);
  if (d && d.ok === false) throw new Error(d.error || 'Revert failed');
  return d;
}

async function deleteSnapshotFor(vm, name) {
  if (isLocalVm(vm)) return localDeleteSnapshot(vm, name);
  const node = nodeRegistry.getNode(vm.node_id);
  if (!node) throw new Error('No node owns this VM');
  const d = await nodeRegistry.deleteSnapshotOnNode(node, vm, name);
  if (d && d.ok === false) throw new Error(d.error || 'Snapshot delete failed');
  return d;
}

async function fullStatsFor(vm) {
  if (isLocalVm(vm)) return localFullStats(vm);
  const node = nodeRegistry.getNode(vm.node_id);
  if (!node) throw new Error('No node owns this VM');
  const d = await nodeRegistry.vmStatsOnNode(node, vm);
  return d.stats || d;
}

function dbVms() {
  return db.prepare(
    `SELECT v.*, u.username AS owner_name, u.email AS owner_email
     FROM vms v JOIN users u ON u.id = v.owner_id`
  ).all();
}

function vmExpiry(row) {
  const raw = row.expires_at || null;
  if (!raw) return { at: null, expired: false, days_left: -1 };
  const at = new Date(raw).getTime();
  const expired = !isNaN(at) && at <= Date.now();
  return { at: raw, expired, days_left: isNaN(at) ? -1 : Math.max(0, Math.ceil((at - Date.now()) / 86400000)) };
}

function expiryFromDays(days) {
  const d = parseInt(days, 10);
  if (!d || isNaN(d) || d <= 0) return null;
  return new Date(Date.now() + d * 86400000).toISOString();
}

function toBackupSlots(v) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return parseInt(settings.get('vm.default_backup_slots') || '5', 10);
  return Math.max(0, n);
}

// ---- Networking helpers: make every chosen IP "just work" ----
// Strip any trailing /prefix so "10.0.0.5/24" or "2001:db8::5/64" becomes a pure address.
function stripCidr(addr) {
  const s = String(addr || '').trim();
  const slash = s.indexOf('/');
  return slash > 0 ? s.slice(0, slash).trim() : s;
}

function sanitizePrefix(p, def, max) {
  const n = parseInt(p, 10);
  if (isNaN(n) || n <= 0) return String(def);
  return String(Math.min(n, max));
}

// Derive a network address from an IPv4 address + prefix (returns the subnet base).
function ipv4Network(ip, prefix) {
  const p = Math.max(0, Math.min(32, parseInt(prefix, 10) || 24));
  const octets = String(ip).split('.').map((o) => parseInt(o, 10));
  if (octets.length !== 4 || octets.some((o) => isNaN(o))) return '';
  const mask = [0, 0, 0, 0].map((_, i) => {
    const bits = Math.max(0, Math.min(8, p - i * 8));
    return parseInt('1'.repeat(bits).padEnd(8, '0'), 2);
  });
  return octets.map((o, i) => o & mask[i]).join('.');
}

// Expand an IPv6 address to full 8-hextet form so bit-masking is trivial.
function expandV6(ip) {
  const lower = String(ip).toLowerCase();
  let head = lower;
  let tail = '';
  const dbl = lower.indexOf('::');
  if (dbl >= 0) { head = lower.slice(0, dbl); tail = lower.slice(dbl + 2); }
  let left = head ? head.split(':') : [];
  let right = tail ? tail.split(':') : [];
  if (!head) left = [];
  const missing = 8 - left.length - right.length;
  const fill = Array(Math.max(0, missing)).fill('0');
  const groups = left.concat(fill, right).map((g) => g.padStart(4, '0'));
  return groups;
}

function ipv6Network(ip, prefix) {
  const p = Math.max(0, Math.min(128, parseInt(prefix, 10) || 64));
  const groups = expandV6(ip);
  if (groups.length !== 8 || groups.some((g) => /[^0-9a-f]/.test(g))) return '';
  // mask the first `p` bits across the 8 groups
  const bytes = [];
  for (const g of groups) {
    bytes.push(parseInt(g.slice(0, 2), 16), parseInt(g.slice(2, 4), 16));
  }
  for (let i = 0; i < 16; i++) {
    const bitPos = (i + 1) * 8;
    if (p < bitPos) {
      const bitsKept = Math.max(0, 8 - (bitPos - p));
      bytes[i] = bytes[i] & parseInt('1'.repeat(bitsKept).padEnd(8, '0'), 2);
    }
  }
  const out = [];
  for (let i = 0; i < 16; i += 2) {
    out.push(((bytes[i] << 8) | bytes[i + 1]).toString(16).padStart(4, '0'));
  }
  return out.join(':');
}

// Derive the subnet's gateway when the admin didn't provide one:
// IPv4 → first usable address in the subnet (.1); IPv6 → network base with ::1.
function deriveGateway(addr, prefix) {
  const ip = stripCidr(addr);
  if (!ip) return '';
  if (ip.includes(':')) {
    const net = ipv6Network(ip, prefix);
    if (!net) return '';
    return net === '' ? '' : net + ':1';
  }
  const p = Math.max(0, Math.min(32, parseInt(prefix, 10) || 24));
  const net = ipv4Network(ip, p);
  if (!net) return '';
  if (p >= 31) return ip; // /31 or /32 → no gateway to derive
  const parts = net.split('.').map(Number);
  return [...parts.slice(0, 3), parts[3] === 255 ? 254 : parts[3] + 1].join('.');
}

function resolveVpsType(data, user) {
  const allowed = ['kvm', 'nat', 'storage', 'highcpu', 'gaming', 'backup'];
  const given = String(data && data.vps_type || '').trim().toLowerCase();
  if (allowed.includes(given)) return given;
  try {
    if (user && user.id) {
      const plan = require('./billingService').planOfUser(user.id);
      if (plan && plan.vps_type && allowed.includes(String(plan.vps_type).toLowerCase())) {
        return String(plan.vps_type).toLowerCase();
      }
    }
  } catch (_) {}
  return String(settings.get('vm.default_vps_type') || 'kvm').toLowerCase();
}

function serializeVm(row) {
  if (!row) return null;
  let forwards = [];
  try { forwards = JSON.parse(row.port_forwards || '[]'); } catch (_) {}
  const remote = (Number(row.node_id) || 1) !== 1;
  const parseJson = (s) => { try { return JSON.parse(s || 'null'); } catch (_) { return null; } };
  // Node host for SSH instructions (falls back to the panel's own host)
  let node_host = null;
  let node_name = null;
  try {
    const n = db.prepare('SELECT host, port, name FROM nodes WHERE id = ?').get(row.node_id || 1);
    if (n) { node_host = n.host; node_name = n.name; }
  } catch (_) {}
  const ipMode = String(row.ip_mode || 'nat');
  const v4 = String(row.ip_address || '').trim();
  const v6 = String(row.ipv6_address || '').trim();
  const staticV4 = ['ipv4_shared', 'ipv4_dedicated', 'dual'].includes(ipMode) && !!v4;
  // Shared IPv4 (SDT-BOT "shared IPv4" concept): NAT / ipv4_shared VMs have no
  // address of their own - they are all reachable THROUGH the panel node's own
  // reachable IPv4 on a unique forwarded port. Preference (SDT-BOT order):
  //   1) node's Tailscale 100.x mesh IPv4 (reachable from ANY of your devices,
  //      no public IPv4 needed - this is exactly how SDT-BOT makes an ipv6-
  //      only node share an IPv4);
  //   2) node host if it is a real non-loopback address;
  //   3) else auto-detect the node's public IPv4 once (cached via hostDetect)
  //      so the SSH/overview hint is never 127.0.0.1.
  let sharedV4 = null;
  if (node_host && node_host !== '127.0.0.1' && node_host !== 'localhost' && node_host !== '::1' && !String(node_host).includes(':')) {
    sharedV4 = node_host;
  } else if (!staticV4) {
    try {
      const nd = require('./hostDetect').detectNetwork();
      const a = (nd.addresses || []).find((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x.addr) && !String(x.addr).startsWith('127.'));
      if (a) sharedV4 = a.addr;
    } catch (_) {}
  }
  const modeLabels = {
    nat: 'NAT (shared port forward)',
    ipv4_shared: 'IPv4 shared',
    ipv4_dedicated: 'IPv4 dedicated',
    ipv6: 'IPv6 only',
    dual: 'Dual stack (IPv4 + IPv6)',
  };
  const out = {
    ...row,
    port_forwards: forwards,
    additional_disks: parseJson(row.additional_disks) || [],
    advanced: parseJson(row.advanced) || {},
    node_host: node_host || 'localhost',
    node_name: node_name || 'Venlix Node',
    network_mode: ipMode,
    network_mode_label: modeLabels[ipMode] || ipMode,
    connect_host: staticV4 ? v4 : (sharedV4 || node_host || 'localhost'),
    connect_port: staticV4 ? 22 : row.ssh_port,
    connect_ip: staticV4 ? v4 : (v6 || sharedV4 || node_host || 'localhost'),
    gui_mode: !!row.gui_mode,
    start_on_boot: !!row.start_on_boot,
    ballooning: row.ballooning === 1 || row.ballooning === '1',
    secure_boot: row.secure_boot === 1 || row.secure_boot === '1',
    tpm: row.tpm === 1 || row.tpm === '1',
    install_guest_agent: row.install_guest_agent === 1 || row.install_guest_agent === '1',
    enable_monitoring: row.enable_monitoring === 1 || row.enable_monitoring === '1',
    enable_backups: row.enable_backups === 1 || row.enable_backups === '1',
    status: remote ? (row.status || 'stopped') : statusOf(row),
    managed: remote,
    dir: vmDir(row),
    vps_type: row.vps_type || 'kvm',
    expiry: vmExpiry(row),
    backup_slots: row.backup_slots != null ? Number(row.backup_slots) : Number(settings.get('vm.default_backup_slots') || '5'),
  };
  if (remote) {
    const ov = neofetchOverrides(row);
    if (ov.spoofOn) {
      try {
        out.neofetch_banner = neofetchService.fetchShellScript({
          cpu: ov.cpu, memory: ov.mem, disk: ov.disk, gpu: ov.gpu,
          host: String(row.hostname || row.name),
          user: String(row.username || ''),
          os: guestOsLabel(row),
          node: String(node_name || row.hostname || row.name || ''),
          region: String(row.region || ''),
          ipv4: String(row.ip_address || ''),
          ipv6: String(row.ipv6_address || ''),
          gateway: String(row.ip_gateway || ''),
          gateway6: String(row.ipv6_gateway || ''),
        });
      } catch (_) {}
    }
  }
  delete out.agent_token;
  return out;
}

function getVm(id) {
  const row = db.prepare('SELECT * FROM vms WHERE id = ?').get(id);
  return serializeVm(row);
}

function canAccess(user, vm, perm = null) {
  if (!vm) return false;
  if (user.role === 'admin' || user.root_admin) return true;
  if (vm.owner_id === user.id) return true;
  const sub = db.prepare(
    'SELECT * FROM subusers WHERE vm_id = ? AND user_id = ?'
  ).get(vm.id, user.id);
  if (!sub) return false;
  if (!perm) return true;
  let perms = [];
  try { perms = JSON.parse(sub.permissions || '[]'); } catch (_) {}
  return perms.includes(perm) || perms.includes('*');
}

function setDbStatus(id, status) {
  db.prepare('UPDATE vms SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, new Date().toISOString(), id);
}

function now() {
  return new Date().toISOString();
}

async function download(url, dest) {
  logger.info(`[vm] downloading ${url}`);
  return new Promise((resolve, reject) => {
    const tmp = dest + '.tmp';
    const child = spawn('wget', ['-q', '--show-progress', '-O', tmp, url], { stdio: 'inherit' });
    child.on('close', (code) => {
      if (code === 0) {
        fs.renameSync(tmp, dest);
        resolve(dest);
      } else {
        reject(new Error(`wget failed with code ${code}`));
      }
    });
    child.on('error', reject);
  });
}

function agentSeedPayload(vm) {
  const script = fs.readFileSync(path.join(config.root, 'scripts/vpanel-agent.py'), 'utf8');
  const unit = [
    '[Unit]',
    'Description=vPanel VM Agent',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    'ExecStart=/usr/local/bin/vpanel-agent',
    'Restart=on-failure',
    'RestartSec=3',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
  ].join('\n');
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  return [
    `echo '${b64(script)}' | base64 -d > /usr/local/bin/vpanel-agent && chmod 755 /usr/local/bin/vpanel-agent`,
    `echo '${vm.agent_token}' > /etc/vpanel-agent.token && chmod 600 /etc/vpanel-agent.token`,
    `printf '%s' '${b64(unit)}' | base64 -d > /etc/systemd/system/vpanel-agent.service`,
    'systemctl daemon-reload || true',
    'systemctl enable --now vpanel-agent 2>/dev/null || (nohup /usr/local/bin/vpanel-agent >/var/log/vpanel-agent.log 2>&1 &) || true',
  ];
}

function provisionAdditionalDisks(vm, dir) {
  let disks = [];
  try { disks = JSON.parse(vm.additional_disks || '[]'); } catch (_) { disks = []; }
  const meta = [];
  for (let i = 0; i < disks.length; i++) {
    const d = disks[i];
    const size = String(d.size || '10G').toUpperCase();
    if (!/^[0-9]+[GM]$/i.test(size)) continue;
    const relName = d.name ? String(d.name).replace(/[^a-zA-Z0-9_\-.]/g, '') : `data-${i + 1}.qcow2`;
    const file = path.join(dir, relName.endsWith('.qcow2') ? relName : relName + '.qcow2');
    if (!fs.existsSync(file)) {
      spawnSync('qemu-img', ['create', '-f', 'qcow2', file, size], { encoding: 'utf8' });
    }
    meta.push({
      file,
      size,
      bus: String(d.bus || 'virtio').slice(0, 16),
      index: i + 1,
    });
  }
  vm._dataDisks = meta;
}

// Resolve neofetch banner settings for a VM. Per-VM custom values win; any
// blank field falls back to the panel's Host Identity (host CPU/GPU/RAM/disk).
// The banner is baked whenever the VM's hardware spoofing is enabled, even if
// no per-VM field is customised - otherwise a fresh VM leaks its real specs.
function neofetchOverrides(vm) {
  const spHw = String(vm && vm.spoof_hw !== undefined && vm.spoof_hw !== null
    ? vm.spoof_hw
    : (settings.get('vm.spoof_hw') ?? '1'));
  return {
    spoofOn: spHw !== '0' && spHw !== 0 && spHw !== false,
    cpu: String((vm && vm.neofetch_cpu) || '').trim() || String(settings.get('panel.cpu_name') || '').trim(),
    mem: String((vm && vm.neofetch_mem) || '').trim() || String(settings.get('panel.ram_name') || '').trim(),
    disk: String((vm && vm.neofetch_disk) || '').trim() || String(settings.get('panel.disk_name') || '').trim(),
    gpu: String((vm && vm.neofetch_gpu) || '').trim() || String(settings.get('panel.gpu_name') || '').trim(),
  };
}

function writeSeed(vm) {
  const dir = vmDir(vm);
  const passHash = spawnSync('openssl', ['passwd', '-6', vm.password], { encoding: 'utf8' }).stdout.trim();

  // ---- Optional advanced cloud-init blocks ----
  const blocks = [];
  const tz = String(vm.timezone || '').trim();
  if (tz) blocks.push(`timezone: ${tz}`);
  const loc = String(vm.locale || '').trim();
  if (loc) blocks.push(`locale: ${loc}`);

  let packages = [];
  try { packages = JSON.parse(vm.cloudinit_packages || '[]'); } catch (_) { packages = []; }
  if (packages.length) blocks.push(`packages:\n${packages.map((p) => '  - ' + p).join('\n')}`);

  const writeFiles = [{
    path: '/etc/ssh/sshd_config.d/00-vpanel.conf',
    permissions: '0644',
    content: 'PermitRootLogin yes\nPasswordAuthentication yes\nKbdInteractiveAuthentication yes\n',
  }];
  try {
    const cf = JSON.parse(vm.cloudinit_files || '[]');
    if (Array.isArray(cf)) {
      for (const f of cf) {
        if (f && f.path) writeFiles.push({
          path: String(f.path),
          permissions: String(f.permissions || '0644'),
          content: String(f.content || ''),
        });
      }
    }
  } catch (_) {}

  // ---- Static IP assignment (shared/dedicated IPv4, IPv6, dual) ----
  // DHCP stays ENABLED on purpose: the panel's own SSH path (node:ssh_port →
  // QEMU hostfwd → guest 22) depends on the slirp DHCP lease (10.0.2.x). The
  // static address is added as a secondary on the same NIC so a dedicated IP
  // never breaks the web console / terminal connection. Gateways and routes
  // are derived automatically so a bare "pick an IP" always ends up reachable.
  let networkConfig = null;
  const mode = String(vm.ip_mode || 'nat');
  const v4raw = stripCidr(vm.ip_address);
  const v6raw = stripCidr(vm.ipv6_address);
  const v4 = v4raw; const v6 = v6raw;
  const v4prefix = sanitizePrefix(vm.ip_prefix, 24, 32);
  const v6prefix = sanitizePrefix(vm.ipv6_prefix, 64, 128);
  const v4gw = (() => {
    if (mode === 'ipv6') return null;
    const given = stripCidr(vm.ip_gateway);
    if (given) return given;
    if (v4) return deriveGateway(v4, v4prefix);
    return null;
  })();
  const v6gw = (() => {
    if (mode === 'ipv4_shared' || mode === 'ipv4_dedicated') return null;
    const given = stripCidr(vm.ipv6_gateway);
    if (given) return given;
    if (v6) return deriveGateway(v6, v6prefix);
    return null;
  })();
  if (mode !== 'nat' && (v4 || v6)) {
    const addresses = [];
    const routes = [];
    const dns = ['1.1.1.1', '8.8.8.8'];
    if (mode !== 'ipv6' && v4) {
      addresses.push(`"${v4}/${v4prefix}"`);
      if (v4gw) routes.push(`      - to: default\n        via: ${v4gw}\n        metric: 256`);
    }
    if ((mode === 'ipv6' || mode === 'dual') && v6) {
      addresses.push(`"${v6}/${v6prefix}"`);
      if (v6gw) routes.push(`      - to: "::/0"\n        via: ${v6gw}\n        metric: 256`);
      dns.push('2606:4700:4700::1111', '2606:4700:4700::1001');
    }
    networkConfig = `version: 2
ethernets:
  vnet0:
    match:
      name: "e*"
    dhcp4: true
    dhcp6: false
    addresses:
    ${addresses.map((a) => '      - ' + a).join('\n')}
${routes.length ? `    routes:
${routes.join('\n')}
` : ''}    nameservers:
      addresses: [${dns.join(', ')}]
`;
  }

  // ---- Per-VM neofetch spoof (custom CPU/RAM/disk shown inside the guest) ----
  // Baked whenever hardware spoofing is on; per-VM values fall back to the host
  // identity so guests always show a VN banner instead of real specs.
  const ov = neofetchOverrides(vm);
  if (ov.spoofOn) {
    writeFiles.push({
      path: '/usr/local/bin/venlix-fetch',
      permissions: '0755',
      content: neofetchService.fetchShellScript({
        cpu: ov.cpu,
        memory: ov.mem,
        disk: ov.disk,
        gpu: ov.gpu,
        host: String(vm.hostname || vm.name),
        user: String(vm.username || ''),
        os: guestOsLabel(vm),
        node: String(vm.node_name || settings.get('panel.hostname') || vm.hostname || vm.name || ''),
        region: String(vm.region || ''),
        ipv4: String(vm.ip_address || ''),
        ipv6: String(vm.ipv6_address || ''),
        gateway: String(vm.ip_gateway || ''),
        gateway6: String(vm.ipv6_gateway || ''),
      }),
    });
    writeFiles.push({
      path: '/etc/venlix/vn-ascii.txt',
      permissions: '0644',
      content: neofetchService.logoPlain(),
    });
  }
  if (writeFiles.length) {
    blocks.push(`write_files:\n${writeFiles.map((f) =>
      `  - path: ${f.path}\n    owner: root:root\n    permissions: '${f.permissions}'\n    content: |\n${String(f.content).split('\n').map((l) => '      ' + l).join('\n')}`
    ).join('\n')}`);
  }

  const runcmds = [];
  let commands = [];
  try { commands = JSON.parse(vm.cloudinit_commands || '[]'); } catch (_) { commands = []; }
  for (const c of commands) if (c) runcmds.push(String(c));
  if (ov.spoofOn) {
    runcmds.push('chmod +x /usr/local/bin/venlix-fetch || true');
    runcmds.push('test -d /etc/venlix || mkdir -p /etc/venlix || true');
    runcmds.push(`for _b in neofetch fastfetch screenfetch; do _p=/usr/local/bin/$_b; if [ -e "$_p" ] && [ ! -L "$_p" ]; then mv -f "$_p" "$_p.venlix-real" 2>/dev/null || true; fi; ln -sf /usr/local/bin/venlix-fetch "$_p"; done`);
    runcmds.push(`printf 'alias neofetch=venlix-fetch\\nalias fastfetch=venlix-fetch\\nalias screenfetch=venlix-fetch\\n' > /etc/profile.d/vn-fetch.sh`);
    runcmds.push('chmod 644 /etc/profile.d/vn-fetch.sh || true');
  }
  const startupScript = String(vm.startup_script || '').trim();
  if (startupScript) {
    const b64 = Buffer.from(startupScript, 'utf8').toString('base64');
    runcmds.push(`echo '${b64}' | base64 -d > /usr/local/bin/vpanel-firstboot && chmod 755 /usr/local/bin/vpanel-firstboot && /usr/local/bin/vpanel-firstboot`);
  }
  const userData = String(vm.cloudinit_userdata || '').trim();

  const seedUserData = `#cloud-config
output:
  all: '| tee -a /dev/ttyS0 /dev/console'
hostname: ${vm.hostname || vm.name}
ssh_pwauth: true
disable_root: false
users:
  - name: ${vm.username}
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    lock_passwd: false
    passwd: ${passHash}
chpasswd:
  list: |
    root:${vm.password}
    ${vm.username}:${vm.password}
  expire: false
package_update: true
${blocks.join('\n')}
runcmd:
  - rm -f /etc/ssh/sshd_config.d/60-cloudimg-settings.conf /etc/ssh/sshd_config.d/10-cloudimg-settings.conf /etc/ssh/sshd_config.d/60-vpanel.conf || true
  - sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config || true
  - sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config || true
  - sed -i 's/^KbdInteractiveAuthentication.*/KbdInteractiveAuthentication yes/' /etc/ssh/sshd_config || true
  - (command -v sshd >/dev/null 2>&1 || apt-get install -y openssh-server >/dev/null 2>&1) || true
  - systemctl enable ssh 2>/dev/null || systemctl enable sshd 2>/dev/null || true
  - systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || service ssh restart 2>/dev/null || true
${agentSeedPayload(vm).map((c) => '  - ' + c).join('\n')}
${runcmds.map((c) => '  - ' + c).join('\n')}
${userData ? '\n# === User-supplied cloud-init (appended verbatim) ===\n' + userData : ''}
`;
  fs.writeFileSync(path.join(dir, 'user-data'), seedUserData);
  // Include a content hash in the instance-id so cloud-init re-runs its
  // per-instance modules (write_files/runcmd/passwords) whenever the seed
  // actually changes, instead of staying stuck on a stale first-boot config.
  const seedRev = crypto.createHash('sha1').update(seedUserData).digest('hex').slice(0, 10);
  fs.writeFileSync(
    path.join(dir, 'meta-data'),
    `instance-id: iid-${vm.uuid || vm.name}-${seedRev}\nlocal-hostname: ${vm.hostname || vm.name}\n`
  );
  if (networkConfig) {
    fs.writeFileSync(path.join(dir, 'network-config'), `#cloud-config\n${networkConfig}`);
  }

  const r = spawnSync('cloud-localds',
    networkConfig
      ? [path.join(dir, 'seed.iso'), path.join(dir, 'user-data'), path.join(dir, 'meta-data'), path.join(dir, 'network-config')]
      : [path.join(dir, 'seed.iso'), path.join(dir, 'user-data'), path.join(dir, 'meta-data')],
    { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`cloud-localds failed: ${r.stderr || r.stdout}`);
  }
}

function normalizeAdvanced(data) {
  const int = (v, d) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : d;
  };
  const defaultCpu = int(settings.get('vm.default_cpus'), 2);
  const sockets = Math.min(Math.max(int(data.cpu_sockets, 1), 1), 8);
  const coresPerSocket = Math.min(Math.max(int(data.cores_per_socket, defaultCpu), 1), 32);
  const threads = Math.min(Math.max(int(data.threads_per_core, 1), 1), 2);
  // Effective vCPU = sockets * cores * threads (top-level cpus sliders override total)
  const totalCpus = int(data.cpus, sockets * coresPerSocket * threads);

  let extraDisks = [];
  if (data.additional_disks) {
    try {
      const raw = typeof data.additional_disks === 'string' ? JSON.parse(data.additional_disks) : data.additional_disks;
      extraDisks = (Array.isArray(raw) ? raw : []).filter((d) => d && d.size);
    } catch (_) { extraDisks = []; }
  }

  return {
    description: String(data.description || '').slice(0, 2000),
    tag: String(data.tag || '').slice(0, 200),
    region: String(data.region || '').slice(0, 200),
    vmid: String(data.vmid || '').slice(0, 64),
    cpu_sockets: sockets,
    cores_per_socket: coresPerSocket,
    threads_per_core: threads,
    cpu_model: String(data.cpu_model || settings.get('vm.default_cpu_model') || 'default').slice(0, 64),
    cpu_type: String(data.cpu_type || 'host').slice(0, 32),
    cpu_units: int(data.cpu_units, 1024),
    cpu_limit: Math.max(0, int(data.cpu_limit, 0)),
    mem_min: int(data.mem_min, 0),
    mem_max: int(data.mem_max, 0),
    ballooning: data.ballooning === '1' || data.ballooning === 1 || data.ballooning === true,
    memory_hotplug: int(data.memory_hotplug, 0),
    machine_type: String(data.machine_type || settings.get('vm.default_machine_type') || 'pc').slice(0, 32),
    firmware: String(data.firmware || settings.get('vm.default_firmware') || 'bios').slice(0, 16),
    secure_boot: data.secure_boot === '1' || data.secure_boot === 1 || data.secure_boot === true,
    tpm: data.tpm === '1' || data.tpm === 1 || data.tpm === true,
    boot_order: String(data.boot_order || 'c').slice(0, 16),
    nic_model: String(data.nic_model || settings.get('vm.default_nic_model') || 'virtio').slice(0, 32),
    nic_count: Math.min(Math.max(int(data.nic_count, 1), 1), 6),
    storage_pool: String(data.storage_pool || 'default').slice(0, 200),
    disk_format: String(data.disk_format || 'qcow2').slice(0, 16),
    additional_disks: extraDisks,
    advanced: (function () {
      let a = {};
      try { a = typeof data.advanced === 'string' ? JSON.parse(data.advanced || '{}') : (data.advanced || {}); } catch (_) {}
      return a;
    })(),
    cloudinit_userdata: String(data.cloudinit_userdata || ''),
    cloudinit_packages: (data.cloudinit_packages || [])
      .map((p) => String(p).trim()).filter(Boolean),
    cloudinit_commands: (data.cloudinit_commands || [])
      .map((c) => String(c).trim()).filter(Boolean),
    cloudinit_files: (function () {
      try {
        const raw = typeof data.cloudinit_files === 'string' ? JSON.parse(data.cloudinit_files || '[]') : (data.cloudinit_files || []);
        return Array.isArray(raw) ? raw : [];
      } catch (_) { return []; }
    })(),
    startup_script: String(data.startup_script || ''),
    install_guest_agent: data.install_guest_agent === '1' || data.install_guest_agent === 1 || data.install_guest_agent === true,
    enable_monitoring: data.enable_monitoring === '1' || data.enable_monitoring === 1 || data.enable_monitoring === true,
    enable_backups: data.enable_backups === '1' || data.enable_backups === 1 || data.enable_backups === true,
    backup_schedule: String(data.backup_schedule || ''),
    timezone: String(data.timezone || 'UTC').slice(0, 64),
    locale: String(data.locale || 'en_US.UTF-8').slice(0, 64),
    // ---- Networking (shared/dedicated IPv4, IPv6, NAT) ----
    ip_mode: ['ipv4_shared', 'ipv4_dedicated', 'ipv6', 'dual', 'nat'].includes(data.ip_mode) ? data.ip_mode : 'nat',
    ip_address: stripCidr(data.ip_address).slice(0, 64),
    ip_gateway: (() => {
      const g = stripCidr(data.ip_gateway);
      if (g) return g.slice(0, 64);
      return deriveGateway(data.ip_address, sanitizePrefix(data.ip_prefix, 24, 32)) || '';
    })(),
    ip_prefix: sanitizePrefix(data.ip_prefix, 24, 32),
    ipv6_address: stripCidr(data.ipv6_address).slice(0, 64),
    ipv6_gateway: (() => {
      const g = stripCidr(data.ipv6_gateway);
      if (g) return g.slice(0, 64);
      return deriveGateway(data.ipv6_address, sanitizePrefix(data.ipv6_prefix, 64, 128)) || '';
    })(),
    ipv6_prefix: sanitizePrefix(data.ipv6_prefix, 64, 128),
    // ---- Per-VM neofetch spoof (custom CPU/RAM/disk shown inside the guest) ----
    neofetch_cpu: String(data.neofetch_cpu || '').trim().slice(0, 200),
    neofetch_mem: String(data.neofetch_mem || '').trim().slice(0, 200),
    neofetch_disk: String(data.neofetch_disk || '').trim().slice(0, 200),
    neofetch_gpu: String(data.neofetch_gpu || '').trim().slice(0, 200),
  };
}

async function create({ user, data }) {
  const osList = getOsList();
  const osEntry = osList.find((o) => o[0] === data.os) || osList[0];
  const vmName = String(data.name || '').trim().replace(/\s+/g, '-');
  if (!vmName || !/^[a-zA-Z0-9_-]+$/.test(vmName)) {
    throw new Error('VM name can only contain letters, numbers, hyphens, underscores');
  }
  const exists = db.prepare('SELECT id FROM vms WHERE name = ? AND owner_id = ?').get(vmName, user.id);
  if (exists) throw new Error(`VM "${vmName}" already exists`);

  // ---- Block creation while the user's plan is suspended/expired ----
  const blocked = db.prepare(
    "SELECT * FROM user_plans WHERE user_id = ? AND status IN ('suspended','expired') ORDER BY id DESC LIMIT 1"
  ).get(user.id);
  if (blocked) {
    throw new Error('Your plan is currently suspended or expired. Restore it to create new VMs.');
  }

  // ---- Quota + credit enforcement ----
  const { q, wantMem, wantDiskGb } = checkQuota(user, data);
  const cost = billingCost(wantMem, wantDiskGb);
  chargeCredits(user, cost);

  // ---- Normalize advanced hKVM-style fields (safe defaults, TCG/Docker compatible) ----
  const adv = normalizeAdvanced(data);

  // ---- Remote node deployment ----
  const targetNodeId = data.node_id !== undefined && data.node_id !== '' && data.node_id !== null
    ? parseInt(data.node_id, 10) : 1;
  if (targetNodeId !== 1) {
    const node = nodeRegistry.getNode(targetNodeId);
    if (!node) throw new Error('Selected node not found');
    if (!node.agent_token || node.agent_token === 'local-primary-no-agent') {
      throw new Error('Selected node has no agent configured');
    }
    const payload = {
      uuid: uuidv4(),
      name: vmName,
      os: data.os,
      hostname: String(data.hostname || vmName).replace(/\s+/g, '-'),
      username: String(data.username || osEntry[4] || 'root').toLowerCase(),
      password: String(data.password || 'vpanel' + Math.random().toString(36).slice(2, 8)),
      disk_size: String(data.disk_size || settings.get('vm.default_disk') || '20G').toUpperCase(),
      memory: parseInt(data.memory || settings.get('vm.default_memory') || '2048', 10),
      cpus: parseInt(data.cpus || settings.get('vm.default_cpus') || '2', 10),
      start_on_boot: data.start_on_boot ? 1 : 0,
      startup_command: data.startup_command || '',
      notes: data.notes || '',
      gui_mode: data.gui_mode === true || data.gui_mode === '1' || data.gui_mode === 'true',
      port_forwards: Array.isArray(data.port_forwards) ? data.port_forwards : [],
      description: adv.description,
      tag: adv.tag,
      region: adv.region,
      vmid: adv.vmid,
      cpu_sockets: adv.cpu_sockets,
      cores_per_socket: adv.cores_per_socket,
      threads_per_core: adv.threads_per_core,
      cpu_model: adv.cpu_model,
      cpu_units: adv.cpu_units,
      cpu_limit: adv.cpu_limit,
      mem_min: adv.mem_min,
      mem_max: adv.mem_max,
      ballooning: adv.ballooning,
      memory_hotplug: adv.memory_hotplug,
      machine_type: adv.machine_type,
      firmware: adv.firmware,
      secure_boot: adv.secure_boot,
      tpm: adv.tpm,
      boot_order: adv.boot_order,
      nic_model: adv.nic_model,
      nic_count: adv.nic_count,
      storage_pool: adv.storage_pool,
      disk_format: adv.disk_format,
      additional_disks: adv.additional_disks,
      cloudinit_userdata: adv.cloudinit_userdata,
      cloudinit_packages: adv.cloudinit_packages,
      cloudinit_commands: adv.cloudinit_commands,
      cloudinit_files: adv.cloudinit_files,
      startup_script: adv.startup_script,
      install_guest_agent: adv.install_guest_agent,
      enable_monitoring: adv.enable_monitoring,
      enable_backups: adv.enable_backups,
      backup_schedule: adv.backup_schedule,
      timezone: adv.timezone,
      locale: adv.locale,
      advanced: adv.advanced,
      ip_mode: adv.ip_mode,
      ip_address: adv.ip_address,
      ip_gateway: adv.ip_gateway,
      ip_prefix: adv.ip_prefix,
      ipv6_address: adv.ipv6_address,
      ipv6_gateway: adv.ipv6_gateway,
      ipv6_prefix: adv.ipv6_prefix,
      spoof_hw: String(settings.get('vm.spoof_hw') ?? '1'),
      spoof_hypervisor: String(settings.get('vm.spoof_hypervisor') || '0'),
      spoof_bios_vendor: String(settings.get('vm.spoof_bios_vendor') || ''),
      spoof_bios_version: String(settings.get('vm.spoof_bios_version') || ''),
      spoof_bios_date: String(settings.get('vm.spoof_bios_date') || ''),
      spoof_sys_manufacturer: String(settings.get('vm.spoof_sys_manufacturer') || ''),
      spoof_sys_product: String(settings.get('vm.spoof_sys_product') || ''),
      spoof_sys_version: String(settings.get('vm.spoof_sys_version') || ''),
      spoof_sys_serial: String(settings.get('vm.spoof_sys_serial') || ''),
      spoof_board_manufacturer: String(settings.get('vm.spoof_board_manufacturer') || ''),
      spoof_board_product: String(settings.get('vm.spoof_board_product') || ''),
      spoof_board_serial: String(settings.get('vm.spoof_board_serial') || ''),
      neofetch_cpu: adv.neofetch_cpu,
      neofetch_mem: adv.neofetch_mem,
      neofetch_disk: adv.neofetch_disk,
      neofetch_gpu: adv.neofetch_gpu,
      vps_type: resolveVpsType(data, user),
      expires_at: expiryFromDays(data.expiry_days),
      backup_slots: toBackupSlots(data.backup_slots),
    };
    {
      const ov = neofetchOverrides(payload);
      if (ov.spoofOn) {
        try {
          payload.neofetch_banner = neofetchService.fetchShellScript({
            cpu: ov.cpu, memory: ov.mem, disk: ov.disk, gpu: ov.gpu,
            host: payload.hostname, user: payload.username,
            os: guestOsLabel(payload), node: node.name, region: payload.region,
            ipv4: payload.ip_address, ipv6: payload.ipv6_address,
            gateway: payload.ip_gateway, gateway6: payload.ipv6_gateway,
          });
        } catch (_) {}
      }
    }
    if (data.ssh_port) payload.ssh_port = parseInt(data.ssh_port, 10);
    if (data.upload_image && data.upload_image.path && fs.existsSync(data.upload_image.path)) {
      payload.upload_image_base64 = fs.readFileSync(data.upload_image.path).toString('base64');
    }

    let remote;
    try {
      remote = await nodeRegistry.createVmOnNode(node, payload);
    } catch (e) {
      throw new Error('Node deploy failed: ' + e.message);
    }
    const rv = remote.vm;
    if (!rv) throw new Error('Node did not return VM info');

    const info = db.prepare(
      `INSERT INTO vms (node_id, uuid, owner_id, name, os_type, codename, img_url, hostname, username, password,
        disk_size, memory, cpus, ssh_port, vnc_port, agent_port, agent_token, gui_mode, port_forwards, start_on_boot, startup_command, status, notes, created_at, updated_at,
        description, tag, region, vmid, cpu_sockets, cores_per_socket, threads_per_core, cpu_model, cpu_type, cpu_units, cpu_limit,
        mem_min, mem_max, ballooning, memory_hotplug, machine_type, firmware, secure_boot, tpm, boot_order, nic_model, nic_count,
        storage_pool, disk_format, additional_disks, cloudinit_userdata, cloudinit_packages, cloudinit_commands, cloudinit_files,
        startup_script, install_guest_agent, enable_monitoring, enable_backups, backup_schedule, timezone, locale, advanced,
        ip_mode, ip_address, ip_gateway, ip_prefix, ipv6_address, ipv6_gateway, ipv6_prefix, neofetch_cpu, neofetch_mem, neofetch_disk, neofetch_gpu,
        vps_type, expires_at, backup_slots)
       VALUES (@node_id, @uuid, @owner_id, @name, @os_type, @codename, @img_url, @hostname, @username, @password,
        @disk_size, @memory, @cpus, @ssh_port, @vnc_port, @agent_port, @agent_token, @gui_mode, @port_forwards, @start_on_boot, @startup_command, 'stopped', @notes, @created, @created,
        @description, @tag, @region, @vmid, @cpu_sockets, @cores_per_socket, @threads_per_core, @cpu_model, @cpu_type, @cpu_units, @cpu_limit,
        @mem_min, @mem_max, @ballooning, @memory_hotplug, @machine_type, @firmware, @secure_boot, @tpm, @boot_order, @nic_model, @nic_count,
        @storage_pool, @disk_format, @additional_disks, @cloudinit_userdata, @cloudinit_packages, @cloudinit_commands, @cloudinit_files,
        @startup_script, @install_guest_agent, @enable_monitoring, @enable_backups, @backup_schedule, @timezone, @locale, @advanced,
        @ip_mode, @ip_address, @ip_gateway, @ip_prefix, @ipv6_address, @ipv6_gateway, @ipv6_prefix, @neofetch_cpu, @neofetch_mem, @neofetch_disk, @neofetch_gpu,
        @vps_type, @expires_at, @backup_slots)`
    ).run({
      node_id: targetNodeId,
      uuid: rv.uuid,
      owner_id: user.id,
      name: rv.name,
      os_type: rv.os_type || '',
      codename: rv.codename || '',
      img_url: rv.img_url || '',
      hostname: rv.hostname,
      username: rv.username,
      password: rv.password,
      disk_size: rv.disk_size,
      memory: rv.memory,
      cpus: rv.cpus,
      ssh_port: rv.ssh_port,
      vnc_port: rv.vnc_port,
      agent_port: rv.agent_port,
      agent_token: rv.agent_token,
      gui_mode: rv.gui_mode ? 1 : 0,
      port_forwards: rv.port_forwards ? (Array.isArray(rv.port_forwards) ? JSON.stringify(rv.port_forwards) : rv.port_forwards) : '[]',
      start_on_boot: rv.start_on_boot ? 1 : 0,
      startup_command: rv.startup_command || '',
      notes: rv.notes || '',
      description: rv.description || adv.description,
      tag: rv.tag || adv.tag,
      region: rv.region || adv.region,
      vmid: rv.vmid || adv.vmid,
      cpu_sockets: rv.cpu_sockets != null ? rv.cpu_sockets : adv.cpu_sockets,
      cores_per_socket: rv.cores_per_socket != null ? rv.cores_per_socket : adv.cores_per_socket,
      threads_per_core: rv.threads_per_core != null ? rv.threads_per_core : adv.threads_per_core,
      cpu_model: rv.cpu_model || adv.cpu_model,
      cpu_type: rv.cpu_type || adv.cpu_type,
      cpu_units: rv.cpu_units != null ? rv.cpu_units : adv.cpu_units,
      cpu_limit: rv.cpu_limit != null ? rv.cpu_limit : String(adv.cpu_limit),
      mem_min: rv.mem_min != null ? rv.mem_min : adv.mem_min,
      mem_max: rv.mem_max != null ? rv.mem_max : adv.mem_max,
      ballooning: (rv.ballooning || adv.ballooning) ? 1 : 0,
      memory_hotplug: rv.memory_hotplug || adv.memory_hotplug,
      machine_type: rv.machine_type || adv.machine_type,
      firmware: rv.firmware || adv.firmware,
      secure_boot: (rv.secure_boot || adv.secure_boot) ? 1 : 0,
      tpm: (rv.tpm || adv.tpm) ? 1 : 0,
      boot_order: rv.boot_order || adv.boot_order,
      nic_model: rv.nic_model || adv.nic_model,
      nic_count: rv.nic_count || adv.nic_count,
      storage_pool: rv.storage_pool || adv.storage_pool,
      disk_format: rv.disk_format || adv.disk_format,
      additional_disks: (typeof rv.additional_disks === 'string' ? rv.additional_disks : JSON.stringify(rv.additional_disks || adv.additional_disks)),
      cloudinit_userdata: rv.cloudinit_userdata || adv.cloudinit_userdata,
      cloudinit_packages: (typeof rv.cloudinit_packages === 'string' ? rv.cloudinit_packages : JSON.stringify(rv.cloudinit_packages || adv.cloudinit_packages)),
      cloudinit_commands: (typeof rv.cloudinit_commands === 'string' ? rv.cloudinit_commands : JSON.stringify(rv.cloudinit_commands || adv.cloudinit_commands)),
      cloudinit_files: (typeof rv.cloudinit_files === 'string' ? rv.cloudinit_files : JSON.stringify(rv.cloudinit_files || adv.cloudinit_files)),
      startup_script: rv.startup_script || adv.startup_script,
      install_guest_agent: (rv.install_guest_agent || adv.install_guest_agent) ? 1 : 0,
      enable_monitoring: (rv.enable_monitoring || adv.enable_monitoring) ? 1 : 0,
      enable_backups: (rv.enable_backups || adv.enable_backups) ? 1 : 0,
      backup_schedule: rv.backup_schedule || adv.backup_schedule,
      timezone: rv.timezone || adv.timezone,
      locale: rv.locale || adv.locale,
      advanced: (typeof rv.advanced === 'string' ? rv.advanced : JSON.stringify(rv.advanced || adv.advanced)),
      ip_mode: rv.ip_mode || adv.ip_mode,
      ip_address: rv.ip_address || adv.ip_address,
      ip_gateway: rv.ip_gateway || adv.ip_gateway,
      ip_prefix: rv.ip_prefix || adv.ip_prefix,
      ipv6_address: rv.ipv6_address || adv.ipv6_address,
      ipv6_gateway: rv.ipv6_gateway || adv.ipv6_gateway,
      ipv6_prefix: rv.ipv6_prefix || adv.ipv6_prefix,
      neofetch_cpu: rv.neofetch_cpu || adv.neofetch_cpu,
      neofetch_mem: rv.neofetch_mem || adv.neofetch_mem,
      neofetch_disk: rv.neofetch_disk || adv.neofetch_disk,
      neofetch_gpu: rv.neofetch_gpu || adv.neofetch_gpu,
      vps_type: rv.vps_type || payload.vps_type || 'kvm',
      expires_at: payload.expires_at || null,
      backup_slots: payload.backup_slots,
      created: now(),
    });
    const id = Number(info.lastInsertRowid);
    setDbStatus(id, 'stopped');
    logActivity({ user_id: user.id, vm_id: id, event: 'vm:create', details: { name: vmName, node: node.name } });
    return getVm(id);
  }

  const hostname = String(data.hostname || vmName).replace(/\s+/g, '-');
  const username = String(data.username || osEntry[4] || 'root').toLowerCase();
  const password = String(data.password || 'vpanel' + Math.random().toString(36).slice(2, 8));
  const diskSize = String(data.disk_size || settings.get('vm.default_disk') || '20G').toUpperCase();
  // Pre-flight: enough free disk for this VM's image?
  {
    const wantBytes = (parseInt(String(diskSize).replace(/[^0-9]/g, ''), 10) || 20) * 1024 ** 3;
    try {
      const { execSync } = require('child_process');
      const dfOut = execSync(`df -B1 "${VM_DIR}"`, { encoding: 'utf8' }).trim().split('\n')[1].split(/\s+/);
      const freeBytes = parseInt(dfOut[3], 10) || 0;
      if (freeBytes < wantBytes + 2 * 1024 ** 3) {
        throw new Error(`Not enough disk space: VM needs ${Math.round(wantBytes / 1024 ** 3)} GB (+2 GB headroom) but only ${(freeBytes / 1024 ** 3).toFixed(1)} GB is free on the panel host.`);
      }
    } catch (e) {
      if (String(e.message).startsWith('Not enough disk')) throw e;
    }
  }
  const memory = parseInt(data.memory || settings.get('vm.default_memory') || '2048', 10);
  const cpus = parseInt(data.cpus || settings.get('vm.default_cpus') || '2', 10);
  const sshPort = data.ssh_port ? parseInt(data.ssh_port, 10) : allocPort();
  if (isNaN(sshPort) || sshPort < 23 || sshPort > 65535) throw new Error('Invalid SSH port');
  if (inUsePort(sshPort)) throw new Error(`Port ${sshPort} is already in use`);
  const vncPort = allocVncPort();
  const agentPort = allocAgentPort();
  const agentToken = genAgentToken();
  const guiMode = data.gui_mode === true || data.gui_mode === '1' || data.gui_mode === 'true';
  const forwards = Array.isArray(data.port_forwards) ? data.port_forwards : [];

  const vm = {
    node_id: 1,
    uuid: uuidv4(),
    owner_id: user.id,
    name: vmName,
    os_type: osEntry[1] || '',
    codename: osEntry[2] || '',
    img_url: osEntry[3] || '',
    hostname,
    username,
    password,
    disk_size: diskSize,
    memory,
    cpus,
    ssh_port: sshPort,
    vnc_port: vncPort,
    agent_port: agentPort,
    agent_token: agentToken,
    gui_mode: guiMode ? 1 : 0,
    port_forwards: JSON.stringify(forwards),
    start_on_boot: data.start_on_boot ? 1 : 0,
    startup_command: data.startup_command || '',
    status: 'stopped',
    notes: data.notes || '',
    description: adv.description,
    tag: adv.tag,
    region: adv.region,
    vmid: adv.vmid,
    cpu_sockets: adv.cpu_sockets,
    cores_per_socket: adv.cores_per_socket,
    threads_per_core: adv.threads_per_core,
    cpu_model: adv.cpu_model,
    cpu_type: adv.cpu_type,
    cpu_units: adv.cpu_units,
    cpu_limit: String(adv.cpu_limit || ''),
    mem_min: adv.mem_min,
    mem_max: adv.mem_max,
    ballooning: adv.ballooning ? 1 : 0,
    memory_hotplug: adv.memory_hotplug,
    machine_type: adv.machine_type,
    firmware: adv.firmware,
    secure_boot: adv.secure_boot ? 1 : 0,
    tpm: adv.tpm ? 1 : 0,
    boot_order: adv.boot_order,
    nic_model: adv.nic_model,
    nic_count: adv.nic_count,
    storage_pool: adv.storage_pool,
    disk_format: adv.disk_format,
    additional_disks: JSON.stringify(adv.additional_disks),
    cloudinit_userdata: adv.cloudinit_userdata,
    cloudinit_packages: JSON.stringify(adv.cloudinit_packages),
    cloudinit_commands: JSON.stringify(adv.cloudinit_commands),
    cloudinit_files: JSON.stringify(adv.cloudinit_files),
    startup_script: adv.startup_script,
    install_guest_agent: adv.install_guest_agent ? 1 : 0,
    enable_monitoring: adv.enable_monitoring ? 1 : 0,
    enable_backups: adv.enable_backups ? 1 : 0,
    backup_schedule: adv.backup_schedule,
    timezone: adv.timezone,
    locale: adv.locale,
    advanced: JSON.stringify(adv.advanced),
    ip_mode: adv.ip_mode,
    ip_address: adv.ip_address,
    ip_gateway: adv.ip_gateway,
    ip_prefix: adv.ip_prefix,
    ipv6_address: adv.ipv6_address,
    ipv6_gateway: adv.ipv6_gateway,
    ipv6_prefix: adv.ipv6_prefix,
    neofetch_cpu: adv.neofetch_cpu,
    neofetch_mem: adv.neofetch_mem,
    neofetch_disk: adv.neofetch_disk,
    neofetch_gpu: adv.neofetch_gpu,
    vps_type: resolveVpsType(data, user),
    expires_at: expiryFromDays(data.expiry_days),
    backup_slots: toBackupSlots(data.backup_slots),
  };

  const info = db.prepare(
    `INSERT INTO vms (node_id, uuid, owner_id, name, os_type, codename, img_url, hostname, username, password,
      disk_size, memory, cpus, ssh_port, vnc_port, agent_port, agent_token, gui_mode, port_forwards, start_on_boot, startup_command, status, notes, created_at, updated_at,
      description, tag, region, vmid, cpu_sockets, cores_per_socket, threads_per_core, cpu_model, cpu_type, cpu_units, cpu_limit,
      mem_min, mem_max, ballooning, memory_hotplug, machine_type, firmware, secure_boot, tpm, boot_order, nic_model, nic_count,
      storage_pool, disk_format, additional_disks, cloudinit_userdata, cloudinit_packages, cloudinit_commands, cloudinit_files,
      startup_script, install_guest_agent, enable_monitoring, enable_backups, backup_schedule, timezone, locale, advanced,
      ip_mode, ip_address, ip_gateway, ip_prefix, ipv6_address, ipv6_gateway, ipv6_prefix, neofetch_cpu, neofetch_mem, neofetch_disk, neofetch_gpu,
      vps_type, expires_at, backup_slots)
     VALUES (@node_id, @uuid, @owner_id, @name, @os_type, @codename, @img_url, @hostname, @username, @password,
      @disk_size, @memory, @cpus, @ssh_port, @vnc_port, @agent_port, @agent_token, @gui_mode, @port_forwards, @start_on_boot, @startup_command, @status, @notes, @created, @created,
      @description, @tag, @region, @vmid, @cpu_sockets, @cores_per_socket, @threads_per_core, @cpu_model, @cpu_type, @cpu_units, @cpu_limit,
      @mem_min, @mem_max, @ballooning, @memory_hotplug, @machine_type, @firmware, @secure_boot, @tpm, @boot_order, @nic_model, @nic_count,
      @storage_pool, @disk_format, @additional_disks, @cloudinit_userdata, @cloudinit_packages, @cloudinit_commands, @cloudinit_files,
      @startup_script, @install_guest_agent, @enable_monitoring, @enable_backups, @backup_schedule, @timezone, @locale, @advanced,
      @ip_mode, @ip_address, @ip_gateway, @ip_prefix, @ipv6_address, @ipv6_gateway, @ipv6_prefix, @neofetch_cpu, @neofetch_mem, @neofetch_disk, @neofetch_gpu,
      @vps_type, @expires_at, @backup_slots)`
  ).run({ ...vm, created: now() });

  const id = Number(info.lastInsertRowid);
  const dir = path.join(VM_DIR, String(id));
  fs.mkdirSync(dir, { recursive: true });
  vm.id = id;
  vm.img_file = path.join(dir, 'disk.qcow2');
  vm.seed_file = path.join(dir, 'seed.iso');

  db.prepare('UPDATE vms SET img_file = ?, seed_file = ? WHERE id = ?').run(vm.img_file, vm.seed_file, id);

  const img = vm.img_file;
  if (!fs.existsSync(img)) {
    if (data.upload_image && data.upload_image.originalname && data.upload_image.size) {
      fs.copyFileSync(data.upload_image.path, img);
      logger.info('[vm] using uploaded image');
      const info = spawnSync('qemu-img', ['info', '--output=json', img], { encoding: 'utf8' });
      let fmt = null;
      try { fmt = JSON.parse(info.stdout).format; } catch (_) {}
      if (fmt && fmt !== 'qcow2') {
        logger.info(`[vm] uploaded image format is ${fmt}; converting to qcow2`);
        const tmp = img + '.conv';
        const conv = spawnSync('qemu-img', ['convert', '-O', 'qcow2', img, tmp], { encoding: 'utf8' });
        if (conv.status !== 0) throw new Error('Failed to convert uploaded image: ' + (conv.stderr || ''));
        fs.unlinkSync(img);
        fs.renameSync(tmp, img);
      }
    } else {
      if (!hasBin('wget')) throw new Error('wget is required to download cloud images');
      const r = spawnSync('qemu-img', ['info', img], { encoding: 'utf8' });
      if (!fs.existsSync(img) || r.status !== 0) {
        logger.info(`[vm] downloading base image for ${osEntry[0]}`);
        await download(vm.img_url, img);
      }
    }
  }

  const resize = spawnSync('qemu-img', ['resize', img, diskSize], { encoding: 'utf8' });
  if (resize.status !== 0) {
    logger.warn('[vm] resize failed (image may be unformatted): ' + (resize.stderr || ''));
  }

  provisionAdditionalDisks(vm, dir);

  writeSeed(vm);
  setDbStatus(id, 'stopped');
  logActivity({ user_id: user.id, vm_id: id, event: 'vm:create', details: { name: vmName, port: sshPort } });

  return getVm(id);
}

// Push the current seed input (banner, spoof toggles, cloud-init inputs) to a
// remote agent before start/restart so config changes reach the guest, even for
// VMs that were created before the feature existed. The agent re-seeds and the
// instance-id hash makes cloud-init re-apply only when content actually changed.
async function syncSeedToNode(node, vm) {
  const data = {
    hostname: vm.hostname,
    username: vm.username,
    password: vm.password,
    timezone: vm.timezone,
    locale: vm.locale,
    cloudinit_userdata: vm.cloudinit_userdata,
    cloudinit_packages: vm.cloudinit_packages,
    cloudinit_commands: vm.cloudinit_commands,
    cloudinit_files: vm.cloudinit_files,
    startup_script: vm.startup_script,
    spoof_hw: String(vm.spoof_hw !== undefined && vm.spoof_hw !== null ? vm.spoof_hw : (settings.get('vm.spoof_hw') ?? '1')),
    spoof_hypervisor: String(settings.get('vm.spoof_hypervisor') || '0'),
    spoof_bios_vendor: String(settings.get('vm.spoof_bios_vendor') || ''),
    spoof_bios_version: String(settings.get('vm.spoof_bios_version') || ''),
    spoof_bios_date: String(settings.get('vm.spoof_bios_date') || ''),
    spoof_sys_manufacturer: String(settings.get('vm.spoof_sys_manufacturer') || ''),
    spoof_sys_product: String(settings.get('vm.spoof_sys_product') || ''),
    spoof_sys_version: String(settings.get('vm.spoof_sys_version') || ''),
    spoof_sys_serial: String(settings.get('vm.spoof_sys_serial') || ''),
    spoof_board_manufacturer: String(settings.get('vm.spoof_board_manufacturer') || ''),
    spoof_board_product: String(settings.get('vm.spoof_board_product') || ''),
    spoof_board_serial: String(settings.get('vm.spoof_board_serial') || ''),
  };
  const ov = neofetchOverrides(vm);
  if (ov.spoofOn) {
    try {
      data.neofetch_banner = neofetchService.fetchShellScript({
        cpu: ov.cpu, memory: ov.mem, disk: ov.disk, gpu: ov.gpu,
        host: String(vm.hostname || vm.name),
        user: String(vm.username || ''),
        os: guestOsLabel(vm),
        node: String(node.name || ''),
        region: String(vm.region || ''),
        ipv4: String(vm.ip_address || ''),
        ipv6: String(vm.ipv6_address || ''),
        gateway: String(vm.ip_gateway || ''),
        gateway6: String(vm.ipv6_gateway || ''),
      });
    } catch (_) {}
  }
  await nodeRegistry.patchVmOnNode(node, vm, data);
}

async function start(vm, { user = null } = {}) {
  if (isRunning(vm)) return { ok: true, message: 'already running', status: 'running' };

  if (vm.suspended_at && (!user || (user.role !== 'admin' && !user.root_admin))) {
    throw new Error('This VM is suspended because its plan requirement was not met. Restore your plan (invites / boost / renewal) to continue.');
  }

  if (!user || (user.role !== 'admin' && !user.root_admin)) {
    const expAt = vm.expires_at || (vm.expiry && vm.expiry.at);
    if (expAt) {
      const t = new Date(expAt).getTime();
      if (!isNaN(t) && t <= Date.now()) {
        throw new Error('This machine has expired. Renew it from the admin panel to start it again.');
      }
    }
  }

  if (isRemoteVm(vm)) {
    const node = remoteNodeFor(vm);
    if (!node) throw new Error('Node not found for this VM');
    try {
      await syncSeedToNode(node, vm);
    } catch (e) {
      logger.warn('[vm] seed sync to node failed (continuing): ' + e.message);
    }
    try {
      await nodeRegistry.startVmOnNode(node, vm);
    } catch (e) {
      throw new Error('Node start failed: ' + e.message);
    }
    setDbStatus(vm.id, 'running');
    logActivity({ user_id: user ? user.id : null, vm_id: vm.id, event: 'vm:start', details: { node: node.name } });
    webhooks.emit(vm, 'vm:start', { id: vm.id, name: vm.name, node: node.name });
    return { ok: true, status: 'running' };
  }

  if (!fs.existsSync(vm.img_file)) throw new Error(`Image file not found: ${vm.img_file}`);
  // Refresh the seed on every start so template fixes reach existing VMs.
  // The instance-id carries a content hash, so cloud-init only re-runs its
  // per-instance modules when the seed actually changed.
  writeSeed(vm);
  // Pre-flight: enough free RAM for the guest (+64MB QEMU overhead)?
  const wantBytes = (parseInt(vm.memory, 10) || 512) * 1024 * 1024;
  const budget = memoryBudget();
  if (budget.bytes < wantBytes + 64 * 1024 * 1024) {
    throw new Error(`Not enough free memory to start this VM: it needs ${Math.round(wantBytes / 1024 / 1024)} MB (+64 MB QEMU overhead) but only ${Math.max(0, Math.round(budget.bytes / 1024 / 1024))} MB is available — limited by the ${budget.limitedBy}. The physical host may have much more RAM, but this process runs inside a container/cgroup cap. Fix: raise the container memory limit (Proxmox LXC: Options > Memory; Docker: --memory), or set the VM's RAM lower.`);
  }
  ensureVncPort(vm);
  ensureAgentPort(vm);
  const dir = vmDir(vm);
  const bootLogPath = path.join(dir, 'boot.log');
  const sessionHeader = `\r\n=== [Venlix] Starting VM "${vm.name}" at ${new Date().toISOString()} ===\r\n\r\n`;
  try {
    fs.appendFileSync(bootLogPath, sessionHeader, 'utf8');
  } catch (_) {}
  const logFile = fs.openSync(path.join(dir, 'qemu.log'), 'a');
  const args = buildQemuArgs(vm);
  const pidFile = path.join(dir, 'qemu.pid');
  try { fs.unlinkSync(pidFile); } catch (_) {}
  logger.info(`[vm] starting ${vm.name}: qemu-system-x86_64 ${args.join(' ')}`);
  const child = spawn('qemu-system-x86_64', args, { stdio: ['ignore', logFile, logFile] });
  child.on('error', (e) => {
    logger.error('[vm] qemu spawn error: ' + e.message);
    setDbStatus(vm.id, 'stopped');
  });
  child.on('exit', () => {
    try { fs.closeSync(logFile); } catch (_) {}
  });

  // QEMU uses -daemonize: wait for its pidfile, then verify the daemon lives.
  const deadline = Date.now() + 5000;
  let daemonPid = null;
  while (Date.now() < deadline) {
    try {
      daemonPid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (daemonPid > 0) break;
    } catch (_) {}
    if (child.exitCode) break; // launcher failed hard
    await new Promise((r) => setTimeout(r, 150));
  }
  let alive = false;
  if (daemonPid > 0) {
    await new Promise((r) => setTimeout(r, 400));
    try { process.kill(daemonPid, 0); alive = true; } catch (_) { alive = false; }
  }
  if (!alive) {
    let tail = '';
    try {
      tail = fs.readFileSync(path.join(dir, 'qemu.log'), 'utf8').split('\n').slice(-12).join('\n').trim();
    } catch (_) {}
    setDbStatus(vm.id, 'stopped');
    throw new Error('QEMU failed to start. ' + (tail ? 'Output:\n' + tail : 'No output captured.'));
  }
  setDbStatus(vm.id, 'running');
  logActivity({ user_id: user ? user.id : null, vm_id: vm.id, event: 'vm:start' });
  webhooks.emit(vm, 'vm:start', { id: vm.id, name: vm.name });
  return { ok: true, pid: daemonPid };
}

async function stop(vm, { user = null, force = false } = {}) {
  if (isRemoteVm(vm)) {
    const node = remoteNodeFor(vm);
    if (node) {
      try {
        await nodeRegistry.stopVmOnNode(node, vm, force);
      } catch (e) {
        throw new Error('Node stop failed: ' + e.message);
      }
    }
    setDbStatus(vm.id, 'stopped');
    logActivity({ user_id: user ? user.id : null, vm_id: vm.id, event: force ? 'vm:kill' : 'vm:stop' });
    return { ok: true, status: 'stopped' };
  }

  const pid = pidOf(vm);
  if (!pid) {
    setDbStatus(vm.id, 'stopped');
    return { ok: true, message: 'not running' };
  }
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    if (!force) {
      const end = Date.now() + 5000;
      while (Date.now() < end && isRunning(vm)) {
        execSync('sleep 0.2', { stdio: 'ignore' });
      }
    }
    if (isRunning(vm)) process.kill(pid, 'SIGKILL');
  } catch (e) {
    logger.warn('[vm] stop error: ' + e.message);
  }
  try { fs.unlinkSync(path.join(vmDir(vm), 'qemu.pid')); } catch (_) {}
  setDbStatus(vm.id, 'stopped');
  logActivity({ user_id: user ? user.id : null, vm_id: vm.id, event: force ? 'vm:kill' : 'vm:stop' });
  webhooks.emit(vm, 'vm:stop', { id: vm.id, name: vm.name, forced: !!force });
  return { ok: true };
}

async function restart(vm, user) {
  if (isRemoteVm(vm)) {
    const node = remoteNodeFor(vm);
    if (!node) throw new Error('Node not found for this VM');
    try {
      await syncSeedToNode(node, vm);
    } catch (e) {
      logger.warn('[vm] seed sync to node failed (continuing): ' + e.message);
    }
    try {
      await nodeRegistry.restartVmOnNode(node, vm);
    } catch (e) {
      throw new Error('Node restart failed: ' + e.message);
    }
    setDbStatus(vm.id, 'running');
    logActivity({ user_id: user ? user.id : null, vm_id: vm.id, event: 'vm:restart' });
    return { ok: true };
  }
  await stop(vm, { user });
  await new Promise((r) => setTimeout(r, 1500));
  return start(vm, { user });
}

async function remove(vm, user) {
  if (isRemoteVm(vm)) {
    const node = remoteNodeFor(vm);
    if (node) {
      try {
        await nodeRegistry.deleteVmOnNode(node, vm);
      } catch (e) {
        logger.warn('[vm] node delete error for ' + vm.name + ': ' + e.message);
      }
    }
  } else {
    if (isRunning(vm)) await stop(vm, { user, force: true });
    try {
      fs.rmSync(vmDir(vm), { recursive: true, force: true });
    } catch (e) {
      logger.warn('[vm] cleanup error: ' + e.message);
    }
  }
  db.prepare('DELETE FROM backups WHERE vm_id = ?').run(vm.id);
  db.prepare('DELETE FROM schedules WHERE vm_id = ?').run(vm.id);
  db.prepare('DELETE FROM subusers WHERE vm_id = ?').run(vm.id);
  db.prepare('DELETE FROM activity_logs WHERE vm_id = ?').run(vm.id);
  db.prepare('DELETE FROM vms WHERE id = ?').run(vm.id);
  logActivity({ user_id: user ? user.id : null, vm_id: vm.id, event: 'vm:delete', details: { name: vm.name } });
  return { ok: true };
}

async function reinstall(vm, data, user) {
  const node = remoteNodeFor(vm);
  if (!node) throw new Error('Node not found for this VM');
  const r = await nodeRegistry.reinstallVmOnNode(node, vm, data || {});
  await nodeRegistry.syncOsToNode(node).catch(() => {});
  setDbStatus(vm.id, data ? 'running' : 'running');
  logActivity({ user_id: user ? user.id : null, vm_id: vm.id, event: 'vm:reinstall', details: { os: (data && data.os) || vm.os_type } });
  return r;
}

// tmate jobs: the panel request returns instantly (Cloudflare kills requests
// after ~100s) and the browser polls for the result while the job runs.
const tmateJobs = new Map();

function startTmateJob(vm, regen) {
  const key = String(vm.id);
  const existing = tmateJobs.get(key);
  if (existing && existing.status === 'running' && Date.now() - existing.started < 5 * 60 * 1000) {
    return { pending: true, job: key, note: 'already running' };
  }
  const job = { status: 'running', started: Date.now(), ssh: null, error: null };
  tmateJobs.set(key, job);
  getTmateSsh(vm, regen)
    .then((ssh) => { job.status = 'done'; job.ssh = ssh; })
    .catch((e) => { job.status = 'error'; job.error = e.message; })
    .finally(() => setTimeout(() => tmateJobs.delete(key), 10 * 60 * 1000));
  return { pending: true, job: key };
}

function tmateJobStatus(vm) {
  const key = String(vm.id);
  const job = tmateJobs.get(key);
  if (!job) {
    // No live job — if we already have a stored address, serve it.
    const stored = vm.tmate_ssh;
    if (stored) return { status: 'done', ssh: stored };
    return { status: 'none' };
  }
  if (job.status === 'done') return { status: 'done', ssh: job.ssh };
  if (job.status === 'error') return { status: 'error', error: job.error };
  return { status: 'running', started: job.started };
}

async function getTmateSsh(vm, regen) {
  // Local VMs (node 1): connect to the guest via SSH and run tmate there.
  if (!isRemoteVm(vm)) {
    const ssh = require('./sshService');
    const script = [
      'export DEBIAN_FRONTEND=noninteractive',
      'command -v tmate >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq tmate) >/dev/null 2>&1 || true',
      'rm -f /tmp/tmate.sock',
      'tmux kill-session -t vpanel-tmate 2>/dev/null || true',
      'command -v tmux >/dev/null 2>&1 || (apt-get install -y -qq tmux) >/dev/null 2>&1 || true',
      'tmate -S /tmp/tmate.sock new-session -d -s vpanel-tmate 2>/dev/null || true',
      'for i in $(seq 1 45); do [ -S /tmp/tmate.sock ] && break; sleep 1; done',
      'tmate -S /tmp/tmate.sock wait tmate-ready 2>/dev/null || true',
      "tmate -S /tmp/tmate.sock display -p '#{tmate_ssh}' 2>/dev/null || true",
    ].join('\n');

    let conn = null;
    let lastErr = null;
    const deadline = Date.now() + 3 * 60 * 1000; // 3 minutes total
    let attempt = 0;
    while (Date.now() < deadline) {
      attempt++;
      try {
        conn = await ssh.connect(vm, { readyTimeout: 20000 });
        break;
      } catch (e) {
        lastErr = e;
        conn = null;
        await new Promise((r) => setTimeout(r, 8000));
      }
    }
    if (!conn) {
      throw new Error('Could not SSH into the VM after ' + attempt + ' attempts (' + (lastErr ? lastErr.message : 'timeout') + '). The guest may still be booting (cloud-init takes 1-3 min), SSH may not be installed, or the VM has no network. Try again in a minute.');
    }
    try {
      const r = await ssh.exec(conn, script, { timeout: 180000 });
      const out = String((r && (r.stdout || r.data)) || '').trim();
      const m = out.match(/\b([a-z0-9]+)\@tmate\.io\b/i);
      if (!m) {
        throw new Error('Could not obtain a tmate SSH address. Is the VM running with internet access? Output: ' + out.slice(-300));
      }
      db.prepare('UPDATE vms SET tmate_ssh = ?, updated_at = ? WHERE id = ?').run(m[1] + '@tmate.io', now(), vm.id);
      return m[1] + '@tmate.io';
    } finally {
      try { conn.end(); } catch (_) {}
    }
  }
  // Remote VMs: ask the node's agent.
  const node = remoteNodeFor(vm);
  if (!node) throw new Error('Node not found for this VM');
  const r = await nodeRegistry.tmateVmOnNode(node, vm, !!regen);
  if (!r || !r.ssh) throw new Error('No tmate SSH address returned');
  return r.ssh;
}

function update(vm, data, user) {
  const fields = ['name', 'hostname', 'username', 'password', 'memory', 'cpus', 'disk_size', 'gui_mode', 'port_forwards', 'start_on_boot', 'startup_command', 'notes', 'owner_id',
    'ip_mode', 'ip_address', 'ip_gateway', 'ip_prefix', 'ipv6_address', 'ipv6_gateway', 'ipv6_prefix',
    'os_type', 'region', 'tag', 'vmid', 'timezone', 'locale',
    'vps_type', 'expires_at', 'backup_slots',
    'neofetch_cpu', 'neofetch_mem', 'neofetch_disk', 'neofetch_gpu'];
  const set = [];
  const vals = {};
  for (const f of fields) {
    if (data[f] !== undefined) {
      set.push(`${f} = @${f}`);
      if (f === 'port_forwards' && Array.isArray(data[f])) vals[f] = JSON.stringify(data[f]);
      else if (f === 'gui_mode' || f === 'start_on_boot') vals[f] = data[f] ? 1 : 0;
      else if (f === 'owner_id') vals[f] = parseInt(data[f], 10);
      else if (f === 'ip_mode') vals[f] = ['ipv4_shared', 'ipv4_dedicated', 'ipv6', 'dual', 'nat'].includes(String(data[f] || '').trim()) ? String(data[f]).trim() : 'nat';
      else if (f === 'expires_at') vals[f] = data[f] ? data[f] : null;
      else if (f === 'vps_type') vals[f] = String(data[f] || 'kvm');
      else if (f === 'backup_slots') vals[f] = toBackupSlots(data[f]);
      else if (f === 'ip_address' || f === 'ipv6_address') vals[f] = stripCidr(data[f]).slice(0, 64);
      else if (f === 'ip_gateway') { const g = stripCidr(data[f]); vals[f] = (g || deriveGateway(data.ip_address !== undefined ? data.ip_address : vm.ip_address, data.ip_prefix !== undefined ? data.ip_prefix : vm.ip_prefix)).slice(0, 64); }
      else if (f === 'ipv6_gateway') { const g = stripCidr(data[f]); vals[f] = (g || deriveGateway(data.ipv6_address !== undefined ? data.ipv6_address : vm.ipv6_address, data.ipv6_prefix !== undefined ? data.ipv6_prefix : vm.ipv6_prefix)).slice(0, 64); }
      else if (f === 'ip_prefix') vals[f] = sanitizePrefix(data[f], 24, 32);
      else if (f === 'ipv6_prefix') vals[f] = sanitizePrefix(data[f], 64, 128);
      else vals[f] = data[f];
    }
  }
  if (set.length) {
    set.push('updated_at = @updated_at');
    vals.updated_at = now();
    db.prepare(`UPDATE vms SET ${set.join(', ')} WHERE id = @id`).run({ ...vals, id: vm.id });
  }
  const needSeed = ['hostname', 'username', 'password', 'neofetch_cpu', 'neofetch_mem', 'neofetch_disk', 'neofetch_gpu',
    'cloudinit_files', 'cloudinit_packages', 'cloudinit_commands', 'cloudinit_userdata',
    'ip_mode', 'ip_address', 'ip_gateway', 'ip_prefix', 'ipv6_address', 'ipv6_gateway', 'ipv6_prefix',
    'os_type', 'timezone', 'locale', 'startup_script']
    .some((f) => data[f] !== undefined);
  if (needSeed) writeSeed(getVm(vm.id) || vm);
  logActivity({ user_id: user ? user.id : null, vm_id: vm.id, event: 'vm:update', details: data });
  return getVm(vm.id);
}

function renewExpiry(vm, { days = 0, to = null, actor = null } = {}) {
  const daysNum = parseInt(days, 10);
  let target;
  if (to) {
    target = new Date(to);
    if (isNaN(target.getTime())) throw new Error('Invalid expiry date');
  } else if (daysNum > 0) {
    target = new Date(Date.now() + daysNum * 86400000);
  } else {
    target = null;
  }
  const expiresAt = target ? target.toISOString() : null;
  const exp = vm.expiry || vmExpiry(vm);
  const nowIso = now();
  let cleared = false;
  if (vm.suspended_at && exp.expired) {
    db.prepare('UPDATE vms SET suspended_at = NULL, updated_at = ? WHERE id = ?').run(nowIso, vm.id);
    cleared = true;
  }
  db.prepare('UPDATE vms SET expires_at = ?, updated_at = ? WHERE id = ?').run(expiresAt, nowIso, vm.id);
  logActivity({
    user_id: actor ? actor.id : null, vm_id: vm.id, event: 'vm:renew',
    details: { days: daysNum, expires_at: expiresAt, cleared_suspension: cleared },
  });
  return getVm(vm.id);
}

function transferOwner(vm, newOwnerId, actor) {
  const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(newOwnerId);
  if (!targetUser) throw new Error('Target user not found');
  db.prepare('UPDATE vms SET owner_id = ?, updated_at = ? WHERE id = ?').run(targetUser.id, now(), vm.id);
  logActivity({ user_id: actor ? actor.id : null, vm_id: vm.id, event: 'vm:transfer_owner', details: { from: vm.owner_id, to: targetUser.id, target_username: targetUser.username } });
  return getVm(vm.id);
}

async function resizeDisk(vm, newSize, user) {
  if (isRunning(vm)) throw new Error('Cannot resize disk while VM is running. Stop the VM first.');
  if (!/^[0-9]+[GM]$/i.test(newSize)) throw new Error('Disk size must be like 50G or 512M');
  if (isRemoteVm(vm)) {
    const node = remoteNodeFor(vm);
    if (!node) throw new Error('Node not found for this VM');
    try {
      await nodeRegistry.resizeVmOnNode(node, vm, newSize.toUpperCase());
    } catch (e) {
      throw new Error('Node resize failed: ' + e.message);
    }
    db.prepare('UPDATE vms SET disk_size = ?, updated_at = ? WHERE id = ?').run(newSize.toUpperCase(), now(), vm.id);
    logActivity({ user_id: user ? user.id : null, vm_id: vm.id, event: 'vm:resize', details: { newSize } });
    return getVm(vm.id);
  }
  const r = spawnSync('qemu-img', ['resize', vm.img_file, newSize], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || 'Failed to resize disk');
  db.prepare('UPDATE vms SET disk_size = ?, updated_at = ? WHERE id = ?').run(newSize.toUpperCase(), now(), vm.id);
  logActivity({ user_id: user ? user.id : null, vm_id: vm.id, event: 'vm:resize', details: { newSize } });
  return getVm(vm.id);
}

// ---------- Quotas + credits (billing) ----------
function parseDiskGb(value) {
  const m = String(value || '0').trim().toUpperCase().match(/^([0-9.]+)([GM])$/);
  if (!m) return 0;
  const num = parseFloat(m[1]);
  return m[2] === 'G' ? num : num / 1024;
}

function effectiveQuota(user) {
  const g = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : -1; };
  let vms = db.prepare(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(memory),0) AS mem, COALESCE(SUM(cpus),0) AS cpu FROM vms WHERE owner_id = ?`
  ).get(user.id);
  const diskNowGb = db.prepare('SELECT disk_size FROM vms WHERE owner_id = ?').all(user.id)
    .reduce((a, r) => a + parseDiskGb(r.disk_size), 0);
  return {
    used_vms: vms.cnt, used_cpu: vms.cpu, used_mem_mb: vms.mem, used_disk_gb: diskNowGb,
    max_vms: g(user.max_vms), max_cpu: g(user.max_cpu), max_mem_mb: g(user.max_mem_mb), max_disk_gb: g(user.max_disk_gb),
    credits: Number(user.credits) || 0,
  };
}

function checkQuota(user, data, osListEntry) {
  const q = effectiveQuota(user);
  const wantMem = parseInt(data.memory || settings.get('vm.default_memory') || '2048', 10);
  const wantCpu = parseInt(data.cpus || settings.get('vm.default_cpus') || '2', 10);
  const wantDiskGb = parseDiskGb(data.disk_size || settings.get('vm.default_disk') || '20G');
  if (q.max_vms >= 0 && q.used_vms >= q.max_vms) {
    throw new Error('Quota exceeded: you may run at most ' + q.max_vms + ' VM(s) and already have ' + q.used_vms + '.');
  }
  if (q.max_cpu >= 0 && q.used_cpu + wantCpu > q.max_cpu) {
    throw new Error('Quota exceeded: CPU limit is ' + q.max_cpu + ' cores, this would make ' + (q.used_cpu + wantCpu) + '.');
  }
  if (q.max_mem_mb >= 0 && q.used_mem_mb + wantMem > q.max_mem_mb) {
    throw new Error(`Quota exceeded: RAM limit is ${q.max_mem_mb} MB, this would make ${q.used_mem_mb + wantMem} MB.`);
  }
  if (q.max_disk_gb >= 0 && q.used_disk_gb + wantDiskGb > q.max_disk_gb) {
    throw new Error(`Quota exceeded: disk limit is ${q.max_disk_gb} GB, this would make ${(q.used_disk_gb + wantDiskGb).toFixed(1)} GB.`);
  }
  return { q, wantMem, wantDiskGb };
}

function billingCost(wantMem, wantDiskGb) {
  const enabled = String(settings.get('billing.enabled') || '0') === '1';
  if (!enabled) return 0;
  const base = parseFloat(settings.get('billing.base_price') || '0') || 0;
  const ramPrice = parseFloat(settings.get('billing.ram_price') || '0') || 0;
  const diskPrice = parseFloat(settings.get('billing.disk_price') || '0') || 0;
  return base + ramPrice * (wantMem / 1024) + diskPrice * wantDiskGb;
}

function chargeCredits(user, cost) {
  if (cost <= 0) return;
  const { credits } = effectiveQuota(user);
  if (credits < cost) {
    throw new Error(`Not enough credits: this VM costs ${cost.toFixed(2)} credits but you have ${credits.toFixed(2)}.`);
  }
  db.prepare('UPDATE users SET credits = credits - ? WHERE id = ?').run(cost, user.id);
}

// ---------- Storage volumes (data disks) ----------
function parseDataDisks(vm) {
  let disks = [];
  try { disks = JSON.parse(vm.additional_disks || '[]'); } catch (e) { disks = []; }
  return Array.isArray(disks) ? disks : [];
}

function persistDataDisks(vm, disks) {
  db.prepare('UPDATE vms SET additional_disks = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(disks), now(), vm.id);
}

function normalizeDiskSizeLocal(size) {
  const m = String(size || '').trim().toUpperCase().match(/^([0-9]+)([GM])$/);
  if (!m) throw new Error('Disk size must be like 50G or 512M');
  const num = parseInt(m[1], 10);
  if (num < 1) throw new Error('Disk size must be at least 1 unit');
  return { number: num, unit: m[2] };
}

function freeDiskBytesLocal() {
  try {
    const { execSync } = require('child_process');
    const out = execSync(`df -B1 "${VM_DIR}"`, { encoding: 'utf8' }).trim().split('\n')[1].split(/\s+/);
    return parseInt(out[3], 10) || 0;
  } catch (e) {
    return 0;
  }
}

async function addDataDiskFor(vm, data, user) {
  const { number, unit } = normalizeDiskSizeLocal(data && data.size);
  const size = number + unit;
  const bus = String((data && data.bus) || 'virtio').replace(/[^a-z0-9_-]/gi, '').slice(0, 16) || 'virtio';
  if (isLocalVm(vm)) {
    const wantBytes = size.endsWith('G') ? number * 1024 ** 3 : number * 1024 ** 2;
    const freeNow = freeDiskBytesLocal();
    if (freeNow < wantBytes + 2 * 1024 ** 3) {
      throw new Error(`Not enough disk space: needs ${size} (+2 GB headroom) but only ${(freeNow / 1024 ** 3).toFixed(1)} GB free on the local host.`);
    }
    const dir = vmDir(vm);
    let disks = parseDataDisks(vm);
    let name = String((data && data.name) || '').replace(/[^a-zA-Z0-9_\-.]/g, '').slice(0, 40);
    if (!name) name = 'data-' + (disks.length + 1);
    let file = path.join(dir, name.endsWith('.qcow2') ? name : name + '.qcow2');
    let i = 1;
    while (fs.existsSync(file)) {
      i++;
      file = path.join(dir, `${name}-${i}.qcow2`);
    }
    const r = spawnSync('qemu-img', ['create', '-f', 'qcow2', file, size], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('Failed to create data disk: ' + (r.stderr || 'qemu-img returned ' + r.status));
    disks.push({ name: path.basename(file, '.qcow2'), size, bus, file });
    persistDataDisks(vm, disks);
  } else {
    const node = remoteNodeFor(vm);
    if (!node) throw new Error('Node not found for this VM');
    const d = await nodeRegistry.addDiskOnNode(node, vm, { name: data && data.name, size, bus });
    if (!d || d.ok === false) throw new Error((d && d.error) || 'Failed to add data disk on node');
    persistDataDisks(vm, parseDataDisks({ additional_disks: d.vm ? d.vm.additional_disks : '[]' }));
  }
  logActivity({ user_id: user ? user.id : null, vm_id: vm.id, event: 'vm:disk:add', details: { size, bus } });
  return getVm(vm.id);
}

async function growDataDiskFor(vm, diskName, newSize, user) {
  normalizeDiskSizeLocal(newSize);
  if (isLocalVm(vm)) {
    let disks = parseDataDisks(vm);
    const idx = disks.findIndex((d) => d.name === diskName || String(d.file || '').replace(/\.qcow2$/, '').split(path.sep).pop() === diskName || d.name === String(diskName).replace(/\.qcow2$/, ''));
    if (idx < 0) throw new Error('Data disk not found: ' + diskName);
    const disk = disks[idx];
    normalizeDiskSizeLocal(disk.size);
    const r = spawnSync('qemu-img', ['resize', disk.file || path.join(vmDir(vm), disk.name.endsWith('.qcow2') ? disk.name : disk.name + '.qcow2'), String(newSize).toUpperCase()], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('Failed to grow data disk: ' + (r.stderr || 'qemu-img returned ' + r.status));
    disk.size = String(newSize).toUpperCase();
    disks[idx] = disk;
    persistDataDisks(vm, disks);
  } else {
    const node = remoteNodeFor(vm);
    if (!node) throw new Error('Node not found for this VM');
    const d = await nodeRegistry.growDiskOnNode(node, vm, diskName, newSize);
    if (!d || d.ok === false) throw new Error((d && d.error) || 'Failed to grow data disk on node');
    persistDataDisks(vm, parseDataDisks({ additional_disks: d.vm ? d.vm.additional_disks : '[]' }));
  }
  logActivity({ user_id: user ? user.id : null, vm_id: vm.id, event: 'vm:disk:grow', details: { disk: diskName, newSize: String(newSize).toUpperCase() } });
  return getVm(vm.id);
}

function volumesFor(vm) {
  const main = {
    name: 'root',
    size: vm.disk_size,
    bus: 'virtio',
    file: vm.img_file,
    primary: true,
  };
  return { volumes: [main, ...parseDataDisks(vm)], running: isRunning(vm) };
}

function usage() {
  return {
    qemu: hasBin('qemu-system-x86_64'),
    cloudLocalds: hasBin('cloud-localds'),
    wget: hasBin('wget'),
    kvm: hasBin('qemu-kvm') || hasBin('/usr/libexec/qemu-kvm'),
  };
}

function uptimeSeconds(vm) {
  const pid = pidOf(vm);
  if (!pid) return 0;
  try {
    const out = execSync(`ps -o etimes= -p ${pid}`, { encoding: 'utf8' }).trim();
    return parseInt(out, 10) || 0;
  } catch (_) { return 0; }
}

function memUsage(vm) {
  const pid = pidOf(vm);
  if (!pid) return 0;
  try {
    const out = execSync(`ps -o rss= -p ${pid}`, { encoding: 'utf8' }).trim();
    return (parseInt(out, 10) || 0) * 1024;
  } catch (_) { return 0; }
}

function totalDiskUsage() {
  try {
    const out = execSync(`du -sb ${VM_DIR}`, { encoding: 'utf8' });
    return parseInt(out.split('\t')[0], 10) || 0;
  } catch (_) { return 0; }
}

function startOnBootAll() {
  const vms = db.prepare('SELECT * FROM vms WHERE start_on_boot = 1').all().map(serializeVm);
  for (const vm of vms) {
    try { start(vm); } catch (e) { logger.error('[vm] autostart failed ' + vm.name + ': ' + e.message); }
  }
}

function cpuUsage(vm) {
  const pid = pidOf(vm);
  if (!pid) return 0;
  try {
    const out = execSync(`ps -o %cpu= -p ${pid}`, { encoding: 'utf8' }).trim();
    return Math.round((parseFloat(out) || 0) * 10) / 10;
  } catch (_) { return 0; }
}

function diskActualUsage(vm) {
  try {
    if (vm.img_file && fs.existsSync(vm.img_file)) {
      return fs.statSync(vm.img_file).size;
    }
  } catch (_) {}
  return 0;
}

function liveStats(vm) {
  const running = isRunning(vm);
  const pid = running ? pidOf(vm) : null;
  const uptime = running ? uptimeSeconds(vm) : 0;
  const memUsedBytes = running ? memUsage(vm) : 0;
  const cpuPct = running ? cpuUsage(vm) : 0;
  const totalMemBytes = (parseInt(vm.memory, 10) || 1024) * 1024 * 1024;
  const memPct = totalMemBytes > 0 ? Math.min(100, Math.round((memUsedBytes / totalMemBytes) * 100)) : 0;
  const diskBytes = diskActualUsage(vm);
  let totalDiskBytes = 20 * 1024 * 1024 * 1024;
  if (vm.disk_size) {
    const m = String(vm.disk_size).trim().match(/^(\d+)([GMK]?)$/i);
    if (m) {
      const num = parseInt(m[1], 10);
      const unit = (m[2] || 'G').toUpperCase();
      if (unit === 'G') totalDiskBytes = num * 1024 * 1024 * 1024;
      else if (unit === 'M') totalDiskBytes = num * 1024 * 1024;
      else if (unit === 'K') totalDiskBytes = num * 1024;
    }
  }
  const diskPct = totalDiskBytes > 0 ? Math.min(100, Math.round((diskBytes / totalDiskBytes) * 100)) : 0;

  return {
    id: vm.id,
    name: vm.name,
    status: running ? 'running' : 'stopped',
    running,
    pid,
    uptime,
    cpu: {
      percent: cpuPct,
      cpus: vm.cpus || 1,
    },
    memory: {
      used_bytes: memUsedBytes,
      used_mb: Math.round(memUsedBytes / 1024 / 1024),
      total_mb: vm.memory,
      percent: memPct,
    },
    disk: {
      allocated: vm.disk_size,
      actual_bytes: diskBytes,
      actual_mb: Math.round(diskBytes / 1024 / 1024),
      percent: diskPct,
    },
    ports: {
      ssh: vm.ssh_port,
      vnc: vm.vnc_port,
      agent: vm.agent_port,
    },
    updated_at: new Date().toISOString(),
  };
}

async function liveStatsRemote(vm) {
  const node = remoteNodeFor(vm);
  if (!node) return null;
  const data = await nodeRegistry.vmStatsOnNode(node, vm);
  return {
    id: vm.id,
    name: vm.name,
    ...(data.stats || data),
  };
}

// Suspension enforcement for plan violations. Stops every running VM of a user
// and flips a per-VM flag so normal users cannot start them again until restored.
async function setUserVmsSuspended(userId, reason) {
  const vms = db.prepare('SELECT * FROM vms WHERE owner_id = ?').all(userId);
  const nowIso = now();
  for (const vm of vms) {
    db.prepare('UPDATE vms SET suspended_at = ?, updated_at = ? WHERE id = ?')
      .run(nowIso, nowIso, vm.id);
    try { await stop(vm, {}); } catch (_) {}
  }
  return vms.length;
}

async function setUserVmsUnsuspended(userId) {
  const vms = db.prepare('SELECT * FROM vms WHERE owner_id = ?').all(userId);
  const nowIso = now();
  for (const vm of vms) {
    if (vm.suspended_at) {
      db.prepare('UPDATE vms SET suspended_at = NULL, updated_at = ? WHERE id = ?')
        .run(nowIso, vm.id);
    }
  }
  return vms.length;
}

module.exports = {
  VM_DIR, vmDir, dbVms, getVm, create, start, stop, restart, remove, update,
  resizeDisk, isRunning, isRemoteVm, statusOf, serializeVm, canAccess, allocPort, allocVncPort, allocAgentPort,
  parseForwards, usage, uptimeSeconds, memUsage, cpuUsage, diskActualUsage, liveStats, liveStatsRemote, totalDiskUsage, startOnBootAll, getOsList, getBootLog, clearBootLog, hasKvm, transferOwner,
  reinstall, getTmateSsh, startTmateJob, tmateJobStatus,
  snapshotsFor, createSnapshotFor, revertSnapshotFor, deleteSnapshotFor, fullStatsFor,
  addDataDiskFor, growDataDiskFor, volumesFor, effectiveQuota,
  renewExpiry, vmExpiry,
  setUserVmsSuspended, setUserVmsUnsuspended,
};
