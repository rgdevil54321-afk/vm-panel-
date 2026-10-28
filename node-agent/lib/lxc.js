'use strict';
// ============================================================================
// LXC engine for the Venlix node agent.
//
// Mirrors the panel-side src/services/lxcService.js, but records machines into
// the agent's own state file (state.upsertVm) exactly like lib/qemu.js does, so
// every existing agent endpoint - /vms, /vms/:id/start, /stats, snapshots, ... -
// works for containers through the same dispatch the agent already performs.
//
// A container is not a VM: it shares the host kernel, so its memory figure is a
// cgroup limit rather than a reservation. That is what lets a node hand out far
// larger RAM figures for containers than it could for KVM guests.
// ============================================================================
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync, execSync } = require('child_process');
const state = require('./state');

const NODE_DIR = path.resolve(__dirname, '..');
const VM_DIR = path.resolve(NODE_DIR, process.env.VM_DIR || 'vms');

function hostLoadInfo() {
  try {
    const load = os.loadavg && os.loadavg()[0];
    const cores = os.cpus ? os.cpus().length : 1;
    if (typeof load === 'number' && cores > 0) {
      return { load, cores, ratio: load / cores };
    }
  } catch (_) {}
  return { load: 0, cores: 1, ratio: 0 };
}

function assertHostNotOverloaded(action = 'start') {
  const info = hostLoadInfo();
  if (info.ratio >= 0.98) {
    throw new Error(`Host is overloaded (load ${info.load.toFixed(2)} / ${info.cores} cores). Free up CPU/RAM before trying to ${action} an LXC VPS.`);
  }
}
const TEMPLATE_CACHE = path.join(VM_DIR, '.lxc-templates');
const TEMPLATE_SERVER = process.env.LXC_TEMPLATE_SERVER || 'https://images.linuxcontainers.org';

function ensureDirs() {
  fs.mkdirSync(VM_DIR, { recursive: true });
}

function hasBin(bin) {
  return spawnSync('which', [bin], { stdio: 'ignore' }).status === 0;
}

function lxcAvailable() {
  return hasBin('lxc-create') && hasBin('lxc-start');
}

function vmDir(vm) {
  return path.join(VM_DIR, String(vm.id));
}

// The lxc CLI resolves `-n <name>` as `<lxcpath>/<name>/config`, defaulting to
// /var/lib/lxc. Containers here live inside their VM directory, so every lxc
// command must be told where to look with `-P <lxcpath>` or it reports
// "No container config specified".
function lxcPath(vm) {
  const dir = path.join(vmDir(vm), 'lxc');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function lxcArgs(vm, args) {
  return ['-P', lxcPath(vm), ...args];
}

function containerName(vm) {
  return 'vp-' + vm.id + '-' + String(vm.name || 'ct').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
}

function genAgentToken() {
  return crypto.randomBytes(24).toString('hex');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function run(bin, args, { timeout = 120000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ code: -1, stdout: '', stderr: e.message }); }
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => { if (!done) { try { child.kill('SIGKILL'); } catch (_) {} } }, timeout);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => { done = true; clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + e.message }); });
    child.on('close', (code) => { done = true; clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Total physical RAM in MB; used to clamp a container's hard memory cap.
function hostMemMb() {
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const m = txt.match(/^MemTotal:\s+(\d+)\s+kB/m);
    if (m) return Math.floor(parseInt(m[1], 10) / 1024);
  } catch (_) {}
  return 0;
}

function readTail(file, bytes = 4000) {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - bytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch (_) { return ''; }
}

// ---------------------------------------------------------------------------
// template download / unpack
// ---------------------------------------------------------------------------
// images.linuxcontainers.org publishes one directory per daily build under
// .../default/ (no LATEST symlink, no rootfs.tar.xz at the default/ level), so
// the newest build directory has to be discovered from the listing first.
function baseDirUrl(entry) {
  const [, distro, release, arch] = entry;
  return `${TEMPLATE_SERVER}/images/${distro}/${release}/${arch || 'amd64'}/default/`;
}

function newestBuild(html) {
  const names = (html || '').match(/\d{8}_\d{2}:\d{2}/g) || [];
  if (!names.length) return null;
  return names.sort()[names.length - 1];
}

async function templateUrl(entry) {
  const listing = await run('sh', ['-c',
    `curl -fsSL ${shq(baseDirUrl(entry))} 2>/dev/null || wget -qO- ${shq(baseDirUrl(entry))} 2>/dev/null`
  ], { timeout: 30000 });
  const build = newestBuild(listing.stdout);
  if (!build) return null;
  return baseDirUrl(entry) + build.replace(':', '%3A') + '/rootfs.tar.xz';
}

function cachedTemplatePath(entry) {
  const [, distro, release, arch] = entry;
  return path.join(TEMPLATE_CACHE, `${distro}-${release}-${arch || 'amd64'}.tar.xz`);
}

async function ensureTemplate(entry) {
  fs.mkdirSync(TEMPLATE_CACHE, { recursive: true });
  const dest = cachedTemplatePath(entry);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024 * 1024) return dest;
  const tmp = dest + '.part';
  const url = await templateUrl(entry);
  if (!url) throw new Error('No published build found for ' + entry[0] + ' at ' + baseDirUrl(entry));
  const bin = hasBin('wget') ? 'wget' : (hasBin('curl') ? 'curl' : null);
  if (!bin) throw new Error('Neither wget nor curl is installed on this node');
  const args = bin === 'wget' ? ['-q', '-O', tmp, url] : ['-sSL', '-o', tmp, url];
  const r = await run(bin, args, { timeout: 30 * 60 * 1000 });
  if (r.code !== 0 || !fs.existsSync(tmp) || fs.statSync(tmp).size < 1024 * 1024) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw new Error('Template download failed: ' + (r.stderr || 'empty download').slice(0, 300));
  }
  fs.renameSync(tmp, dest);
  return dest;
}

function canUseUnprivileged() {
  try {
    const readRange = (file) => {
      const txt = fs.readFileSync(file, 'utf8');
      for (const line of txt.split('\n')) {
        const m = line.match(/^root:(\d+):(\d+)\s*$/);
        if (m) return parseInt(m[1], 10);
      }
      return null;
    };
    const uidBase = readRange('/etc/subuid');
    const gidBase = readRange('/etc/subgid');
    if (uidBase == null || gidBase == null) return null;
    return { uidBase, gidBase };
  } catch (_) { return null; }
}

// Host networking keeps the panel's dial target identical to the QEMU path:
// sshd runs on the allocated port inside the container, reachable on the node's
// own address. No bridge, no NAT, no hostfwd.
function writeConfig(vm) {
  const dir = vmDir(vm);
  // lxc CLI layout: <lxcpath>/<name>/config. lxcPath() creates the parent.
  const cfgDir = path.join(lxcPath(vm), containerName(vm));
  fs.mkdirSync(cfgDir, { recursive: true });
  // The config is regenerated below on every call, so an older install that left
  // it at the previous (non-CLI) location only has a stale copy there. Sweep it
  // so nothing downstream can read the wrong file.
  try {
    const stale = path.join(dir, 'lxc', 'config');
    if (fs.existsSync(stale)) fs.rmSync(stale, { force: true });
  } catch (_) {}
  const memMb = Math.max(64, parseInt(vm.memory, 10) || 512);
  const cpus = Math.max(1, parseInt(vm.cpus, 10) || 1);
  // Hard cap gets headroom over the advertised soft limit, capped at host RAM.
  const memHardMb = Math.max(memMb, Math.min(Math.round(memMb * 1.5), hostMemMb() || (memMb * 2)));

  const lines = [
    '# Managed by Venlix node agent - edits are overwritten on next start.',
    'lxc.uts.name = ' + containerName(vm),
    'lxc.arch = linux64',
    'lxc.rootfs.path = dir:' + path.join(dir, 'rootfs'),
    'lxc.net.0.type = none',
    'lxc.apparmor.profile = generated',
    'lxc.cgroup2.devices.allow = c 1:3 rwm',
    'lxc.cgroup2.devices.allow = c 1:5 rwm',
    'lxc.cgroup2.devices.allow = c 1:7 rwm',
    'lxc.cgroup2.devices.allow = c 1:8 rwm',
    'lxc.cgroup2.devices.allow = c 1:9 rwm',
    'lxc.cgroup2.devices.allow = c 5:0 rwm',
    'lxc.cgroup2.devices.allow = c 5:1 rwm',
    'lxc.cgroup2.devices.allow = c 5:2 rwm',
    'lxc.cgroup2.devices.allow = c 136:* rwm',
    'lxc.cgroup2.devices.allow = c 10:200 rwm',
    'lxc.mount.entry = /dev/net/tun dev/net/tun none bind,create=file',
    // memory.high is the advertised soft limit; memory.max is headroom above it.
    // Setting them equal makes the OOM killer fire on ordinary page-cache growth.
    'lxc.cgroup2.memory.high = ' + memMb + 'M',
    'lxc.cgroup2.memory.max = ' + memHardMb + 'M',
    'lxc.cgroup2.cpu.max = ' + (cpus * 100000) + ' 100000',
  ];

  const unpriv = canUseUnprivileged();
  if (unpriv) {
    lines.push('lxc.idmap = u 0 ' + unpriv.uidBase + ' 65536');
    lines.push('lxc.idmap = g 0 ' + unpriv.gidBase + ' 65536');
    lines.push('lxc.apparmor.profile = generated');
  } else {
    lines.push('# unprivileged mapping unavailable on this host - try privileged mode');
    lines.push('lxc.apparmor.profile = unconfined');
    lines.push('# lxc.idmap entries removed for compatibility');
  }
  lines.push('lxc.cap.drop = ');
  lines.push('lxc.hook.autodev = 1');

  fs.writeFileSync(path.join(cfgDir, 'config'), lines.join('\n') + '\n', 'utf8');
  return path.join(cfgDir, 'config');
}

function rootfsReady(vm) {
  const root = path.join(vmDir(vm), 'rootfs');
  try { return fs.existsSync(path.join(root, 'etc')) || fs.existsSync(path.join(root, 'bin')); }
  catch (_) { return false; }
}

function writeContainerIdentity(vm, root) {
  const hostname = String(vm.hostname || vm.name || 'venlix').replace(/[^a-zA-Z0-9.-]/g, '').slice(0, 63) || 'venlix';
  try { fs.writeFileSync(path.join(root, 'etc/hostname'), hostname + '\n', 'utf8'); } catch (_) {}
  try {
    const hosts = path.join(root, 'etc/hosts');
    let txt = '';
    try { txt = fs.readFileSync(hosts, 'utf8'); } catch (_) {}
    if (!txt.includes(hostname)) {
      txt = txt.replace(/127\.0\.1\.1.*\n/, '') + `\n127.0.1.1\t${hostname}\n`;
      fs.writeFileSync(hosts, txt.replace(/^\n+/, ''), 'utf8');
    }
  } catch (_) {}
  if (vm.password) {
    try {
      const r = spawnSync('openssl', ['passwd', '-6', String(vm.password)], { encoding: 'utf8', timeout: 15000 });
      if (r.status === 0 && r.stdout && r.stdout.trim()) {
        const shadow = path.join(root, 'etc/shadow');
        let txt = fs.readFileSync(shadow, 'utf8');
        txt = txt.replace(/^root:[^:]*:/m, 'root:' + r.stdout.trim() + ':');
        fs.writeFileSync(shadow, txt, 'utf8');
      }
    } catch (e) {}
  }
}

async function unpackRootfs(vm, entry) {
  const root = path.join(vmDir(vm), 'rootfs');
  if (rootfsReady(vm)) return;
  const tarball = await ensureTemplate(entry);
  fs.mkdirSync(root, { recursive: true });
  const r = await run('tar', ['-xpf', tarball, '-C', root], { timeout: 30 * 60 * 1000 });
  if (r.code !== 0) throw new Error('Failed to unpack the rootfs: ' + (r.stderr || 'tar exited ' + r.code).slice(0, 300));
  writeContainerIdentity(vm, root);
}

// Template lookup that tolerates the label ("Ubuntu 24.04"), the bare distro id
// ("ubuntu") or "distro/release" ("ubuntu/noble"), because the control that
// submitted the value differs between the create wizard and the reinstall form.
function findTemplateEntry(list, id) {
  if (!id) return null;
  return (list || []).find((o) => o && (o[0] === id || (o[1] + '/' + o[2]) === id || o[1] === id)) || null;
}
// ---------------------------------------------------------------------------
// create - same contract as qemu.createVm: resolves with the stored VM record
// ---------------------------------------------------------------------------
async function createVm({ data, osList }) {
  ensureDirs();
  const entry = findTemplateEntry(osList, data.os) || osList[0] || [];
  if (!entry.length) throw new Error('No container templates configured on this node');
  const vmName = String(data.name || '').trim().replace(/\s+/g, '-');
  if (!vmName || !/^[a-zA-Z0-9_-]+$/.test(vmName)) {
    throw new Error('VM name can only contain letters, numbers, hyphens, underscores');
  }
  const existing = state.get().vms.find((v) => v.name === vmName);
  if (existing) throw new Error(`VM "${vmName}" already exists on this node`);

  const hostname = String(data.hostname || vmName).replace(/\s+/g, '-');
  const username = String(data.username || 'root').toLowerCase();
  const password = String(data.password || 'vpanel' + Math.random().toString(36).slice(2, 8));
  const diskSize = String(data.disk_size || '20G').toUpperCase();

  // RAM: containers get a cgroup limit, so the only real ceiling is what the node
  // can keep resident. Unlike the QEMU path we do NOT clamp to (totalmem - 512):
  // a container's limit is not a reservation, so a large figure is legitimate.
  // Only sanity-bound it so a typo cannot set a nonsensical cgroup value.
  let memory = parseInt(data.memory || '2048', 10);
  if (!Number.isFinite(memory) || memory < 64) memory = 64;

  const cpus = Math.max(1, parseInt(data.cpus || '2', 10) || 2);
  const sshPort = data.ssh_port ? parseInt(data.ssh_port, 10) : allocHostPort('ssh_port', 25501, 25600);
  if (isNaN(sshPort) || sshPort < 23 || sshPort > 65535) throw new Error('Invalid SSH port');
  if (inUsePort(sshPort)) throw new Error(`Port ${sshPort} is already in use`);

  const id = state.nextId();
  const dir = path.join(VM_DIR, String(id));
  fs.mkdirSync(dir, { recursive: true });

  const vm = {
    id,
    uuid: crypto.randomUUID(),
    name: vmName,
    os_name: entry[0],
    os_type: entry[1] || '',
    codename: entry[2] || '',
    hostname,
    username,
    password,
    disk_size: diskSize,
    memory,
    cpus,
    ssh_port: sshPort,
    // No VNC for containers - there is no framebuffer to expose. Left null so
    // every consumer that checks `vm.vnc_port` sees a container has none.
    vnc_port: null,
    agent_port: parseInt(data.agent_port, 10) || null,
    agent_token: data.agent_token || genAgentToken(),
    port_forwards: JSON.stringify(Array.isArray(data.port_forwards) ? data.port_forwards : []),
    gui_mode: 0,
    start_on_boot: data.start_on_boot ? 1 : 0,
    startup_command: data.startup_command || '',
    status: 'stopped',
    notes: data.notes || '',
    description: data.description || '',
    tag: data.tag || '',
    region: data.region || '',
    ip_mode: data.ip_mode || 'none',
    ip_address: data.ip_address || '',
    ip_gateway: data.ip_gateway || '',
    ip_prefix: data.ip_prefix || '',
    ipv6_address: data.ipv6_address || '',
    ipv6_gateway: data.ipv6_gateway || '',
    ipv6_prefix: data.ipv6_prefix || '',
    neofetch_cpu: data.neofetch_cpu || '',
    neofetch_mem: data.neofetch_mem || '',
    neofetch_disk: data.neofetch_disk || '',
    neofetch_gpu: data.neofetch_gpu || '',
    vps_type: data.vps_type || 'kvm',
    backup_slots: data.backup_slots != null ? parseInt(data.backup_slots, 10) : null,
    virt_type: 'lxc',
    img_file: null,
    seed_file: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  state.upsertVm(vm);
  try {
    await unpackRootfs(vm, entry);
    writeConfig(vm);
  } catch (e) {
    // Roll the record back so a failed unpack does not leave a phantom machine.
    state.removeVm(id);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    throw e;
  }
  return vm;
}

// ---------------------------------------------------------------------------
// port helpers (the QEMU lib keeps its own; containers need the same behaviour)
// ---------------------------------------------------------------------------
function inUsePort(port) {
  try { execSync(`ss -tln | grep -q ':${port} '`, { stdio: 'ignore' }); return true; }
  catch (_) { return false; }
}

function allocHostPort(field, min, max) {
  const used = new Set(state.allVms().map((v) => v[field]).filter(Boolean).map(Number));
  for (let p = min; p <= max; p++) {
    if (!used.has(p) && !inUsePort(p)) return p;
  }
  throw new Error(`No free ${field} in range ${min}-${max}`);
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------
function isRunning(vm) {
  if (!hasBin('lxc-info')) return false;
  const r = spawnSync('lxc-info', lxcArgs(vm, ['-n', containerName(vm), '-s']), { encoding: 'utf8', timeout: 10000 });
  if (r.status !== 0 || !r.stdout) return false;
  return /RUNNING/i.test(r.stdout);
}

function statusOf(vm) {
  return isRunning(vm) ? 'running' : 'stopped';
}

function containerInitPid(vm) {
  if (!hasBin('lxc-info')) return null;
  const r = spawnSync('lxc-info', lxcArgs(vm, ['-n', containerName(vm), '-p']), { encoding: 'utf8', timeout: 8000 });
  if (r.status !== 0 || !r.stdout) return null;
  const m = String(r.stdout).match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

function agentInstallScript(vm) {
  if (!vm.agent_token) return '';
  const port = vm.agent_port || 9090;
  const repo = process.env.VENLIX_REPO || 'https://raw.githubusercontent.com/rgdevil54321-afk/vm-panel-/main';
  const url = repo.replace(/\.git$/, '').replace(/\/$/, '') + '/scripts/vpanel-agent.py';
  return [
    'mkdir -p /opt/vpanel',
    `printf '%s' '${vm.agent_token}' > /etc/vpanel-agent.token`,
    'chmod 600 /etc/vpanel-agent.token',
    `(cp /opt/vpanel/agent.py /opt/vpanel/vpanel-agent.py 2>/dev/null) || (command -v curl >/dev/null && curl -sSfL ${url} -o /opt/vpanel/vpanel-agent.py) || true`,
    `if [ -f /opt/vpanel/vpanel-agent.py ]; then VPANEL_AGENT_PORT=${port} nohup python3 /opt/vpanel/vpanel-agent.py >/var/log/vpanel-agent.log 2>&1 & fi`,
    'true',
  ].join('\n');
}

async function bootstrap(vm) {
  const name = containerName(vm);
  const steps = [
    `sed -i 's/^#\\?Port .*/Port ${vm.ssh_port || 22}/' /etc/ssh/sshd_config 2>/dev/null || true`,
    `sed -i 's/^#\\?PermitRootLogin .*/PermitRootLogin yes/' /etc/ssh/sshd_config 2>/dev/null || true`,
    `sed -i 's/^#\\?PasswordAuthentication .*/PasswordAuthentication yes/' /etc/ssh/sshd_config 2>/dev/null || true`,
    `(command -v systemctl >/dev/null && systemctl enable --now ssh 2>/dev/null) || (command -v systemctl >/dev/null && systemctl enable --now sshd 2>/dev/null) || (command -v rc-update >/dev/null && rc-update add sshd default && rc-service sshd start 2>/dev/null) || (/etc/init.d/sshd start 2>/dev/null) || true`,
    vm.password ? `echo 'root:${String(vm.password).replace(/'/g, "'\\''")}' | chpasswd 2>/dev/null || true` : '',
    vm.username && vm.username !== 'root'
      ? `(id ${vm.username} >/dev/null 2>&1 || useradd -m -s /bin/bash ${vm.username} 2>/dev/null || adduser -D -s /bin/sh ${vm.username} 2>/dev/null) || true; echo '${vm.username}:${String(vm.password || 'root').replace(/'/g, "'\\''")}' | chpasswd 2>/dev/null || true`
      : '',
    agentInstallScript(vm),
  ].filter(Boolean).join('\n');
  return run('lxc-attach', lxcArgs(vm, ['-n', name, '--', '/bin/sh', '-c', steps]), { timeout: 180000 });
}

function waitForPort(port, timeoutMs) {
  return new Promise((resolve) => {
    if (!port) return resolve(false);
    const net = require('net');
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const sock = net.connect({ host: '127.0.0.1', port });
      sock.on('connect', () => { sock.destroy(); resolve(true); });
      sock.on('error', () => {
        sock.destroy();
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(attempt, 500);
      });
      sock.setTimeout(2000, () => { sock.destroy(); });
    };
    attempt();
  });
}

async function startVm(vm) {
  try { assertHostNotOverloaded('start'); } catch (e) { return { ok: false, error: e.message }; }
  if (!lxcAvailable()) return { ok: false, error: 'LXC is not installed on this node (apt-get install -y lxc lxc-templates)' };
  if (!rootfsReady(vm)) return { ok: false, error: 'Container rootfs is missing - reinstall this machine' };
  if (isRunning(vm)) return { ok: true, already: true };
  const dir = vmDir(vm);
  const cfgPath = writeConfig(vm);
  const name = containerName(vm);
  const logFile = path.join(dir, 'lxc-start.log');
  try { spawnSync('lxc-stop', ['-f', cfgPath, '-n', name, '-k'], { stdio: 'ignore', timeout: 20000 }); } catch (_) {}
  try { spawnSync('lxc-stop', lxcArgs(vm, ['-n', name, '-k']), { stdio: 'ignore', timeout: 20000 }); } catch (_) {}
  try { spawnSync('lxc-stop', ['-n', name, '-k'], { stdio: 'ignore', timeout: 20000 }); } catch (_) {}

  let r = await run('lxc-start', ['-f', cfgPath, '-n', name, '-d', '-l', 'DEBUG', '-o', logFile], { timeout: 120000 });
  if (r.code !== 0) {
    r = await run('lxc-start', lxcArgs(vm, ['-n', name, '-d', '-l', 'DEBUG', '-o', logFile]), { timeout: 120000 });
  }
  if (r.code !== 0) {
    r = await run('lxc-start', ['-P', path.join(dir, 'lxc'), '-n', name, '-d', '-l', 'DEBUG', '-o', logFile], { timeout: 120000 });
  }
  if (r.code !== 0) {
    r = await run('lxc-start', ['-f', cfgPath, '-d', '-l', 'DEBUG', '-o', logFile], { timeout: 120000 });
  }
  if (r.code !== 0) {
    return { ok: false, error: 'Container failed to start: ' + (readTail(logFile) || r.stderr || '').slice(0, 400) };
  }
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !isRunning(vm)) await sleep(400);
  if (!isRunning(vm)) {
    return { ok: false, error: 'Container did not reach RUNNING in time: ' + (readTail(logFile) || '').slice(0, 300) };
  }
  await waitForPort(vm.ssh_port, 15000);
  bootstrap(vm).catch(() => {});
  setTimeout(() => { bootstrap(vm).catch(() => {}); }, 8000);
  return { ok: true };
}

function stopVm(vm, force = false) {
  if (!hasBin('lxc-stop')) return { ok: false, error: 'LXC is not installed on this node' };
  let cfgPath;
  try { cfgPath = writeConfig(vm); } catch (_) {}
  const args = ['-n', containerName(vm)];
  if (force) args.push('-k');
  let r = spawnSync('lxc-stop', lxcArgs(vm, args), { encoding: 'utf8', timeout: force ? 20000 : 60000 });
  if (r.status !== 0 && cfgPath) {
    try { r = spawnSync('lxc-stop', ['-f', cfgPath, ...args], { encoding: 'utf8', timeout: force ? 20000 : 60000 }); } catch (_) {}
  }
  if (r.status !== 0) {
    const err = String(r.stderr || '');
    if (!/not running|does not exist|no such container/i.test(err)) return { ok: false, error: err.slice(0, 300) };
  }
  return { ok: true };
}

async function restartVm(vm) {
  stopVm(vm, false);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && isRunning(vm)) await sleep(300);
  if (isRunning(vm)) stopVm(vm, true);
  await sleep(500);
  return startVm(vm);
}

function removeVm(vm) {
  const name = containerName(vm);
  try { if (isRunning(vm)) spawnSync('lxc-stop', lxcArgs(vm, ['-n', name, '-k']), { stdio: 'ignore', timeout: 20000 }); } catch (_) {}
  if (hasBin('lxc-destroy')) {
    try { spawnSync('lxc-destroy', lxcArgs(vm, ['-n', name]), { encoding: 'utf8', timeout: 30000 }); } catch (_) {}
  }
  try { fs.rmSync(vmDir(vm), { recursive: true, force: true }); } catch (_) {}
  state.removeVm(vm.id);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------
function cgroupPath(vm) {
  const name = containerName(vm);
  for (const c of [`/sys/fs/cgroup/lxc.payload.${name}`, `/sys/fs/cgroup/lxc/${name}`]) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return null;
}

function readInt(file) {
  try { const n = parseInt(fs.readFileSync(file, 'utf8').trim(), 10); return Number.isFinite(n) ? n : null; }
  catch (_) { return null; }
}

function dirSize(dir, seen = { bytes: 0 }) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return seen.bytes; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) dirSize(p, seen);
      else if (e.isFile()) seen.bytes += fs.statSync(p).size;
    } catch (_) {}
  }
  return seen.bytes;
}

function liveStats(vm) {
  const running = isRunning(vm);
  const out = { running, uptimeSeconds: 0, memUsage: 0, cpuUsage: 0, diskActualUsage: 0, memoryLimit: null };
  const cg = cgroupPath(vm);
  if (cg) {
    out.memUsage = readInt(path.join(cg, 'memory.current')) || 0;
    out.memoryLimit = readInt(path.join(cg, 'memory.max'));
  }
  try { out.diskActualUsage = dirSize(path.join(vmDir(vm), 'rootfs')); } catch (_) {}
  const pid = running ? containerInitPid(vm) : null;
  if (pid) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const bootTime = parseFloat(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
      const startTicks = parseInt(stat.split(') ')[1].split(' ')[19], 10);
      out.uptimeSeconds = Math.max(0, Math.round(bootTime - startTicks / 100));
    } catch (_) {}
  }
  return out;
}

async function fullStats(vm) {
  const s = liveStats(vm);
  let net = { rx: 0, tx: 0 };
  try {
    const r = await run('lxc-attach', lxcArgs(vm, ['-n', containerName(vm), '--', '/bin/sh', '-c', 'cat /proc/net/dev 2>/dev/null']), { timeout: 15000 });
    if (r.code === 0) {
      for (const line of r.stdout.split('\n')) {
        const m = line.match(/^\s*([^\s:]+):\s*(\d+)(?:\s+\d+){7}\s+(\d+)/);
        if (m && m[1] !== 'lo') { net.rx += parseInt(m[2], 10); net.tx += parseInt(m[3], 10); }
      }
    }
  } catch (_) {}
  const totalMemBytes = (parseInt(vm.memory, 10) || 1024) * 1024 * 1024;
  return {
    stats: {
      id: vm.id,
      name: vm.name,
      status: s.running ? 'running' : 'stopped',
      running: s.running,
      virt_type: 'lxc',
      pid: s.running ? containerInitPid(vm) : null,
      uptime: s.uptimeSeconds,
      cpu: { percent: s.cpuUsage || 0, cpus: vm.cpus || 1 },
      memory: {
        used_bytes: s.memUsage || 0,
        used_mb: Math.round((s.memUsage || 0) / 1024 / 1024),
        total_mb: vm.memory,
        limit_mb: s.memoryLimit ? Math.round(s.memoryLimit / 1024 / 1024) : vm.memory,
        percent: totalMemBytes > 0 ? Math.min(100, Math.round(((s.memUsage || 0) / totalMemBytes) * 100)) : 0,
      },
      disk: { allocated: vm.disk_size, actual_bytes: s.diskActualUsage || 0, actual_mb: Math.round((s.diskActualUsage || 0) / 1024 / 1024), percent: 0 },
      ports: { ssh: vm.ssh_port, vnc: null, agent: vm.agent_port },
      updated_at: new Date().toISOString(),
    },
    io: null,
    net,
  };
}

function bootLog(vm) {
  const dir = vmDir(vm);
  const parts = [];
  for (const f of ['lxc-start.log', 'console.log']) {
    const p = path.join(dir, f);
    try { if (fs.existsSync(p)) parts.push(fs.readFileSync(p, 'utf8')); } catch (_) {}
  }
  if (parts.join('').trim()) return parts.join('\n');
  try {
    const r = spawnSync('lxc-attach', lxcArgs(vm, ['-n', containerName(vm), '--', '/bin/sh', '-c', 'dmesg 2>/dev/null | tail -n 100']), { encoding: 'utf8', timeout: 15000 });
    if (r.status === 0 && r.stdout && r.stdout.trim()) return r.stdout;
  } catch (_) {}
  return '[Boot Log] No container output recorded yet.';
}

function clearBootLog(vm) {
  const dir = vmDir(vm);
  for (const f of ['lxc-start.log', 'console.log']) {
    try { fs.truncateSync(path.join(dir, f), 0); } catch (_) {}
  }
  return { ok: true };
}

function updateVm(vm, data) {
  const allowed = ['name', 'hostname', 'memory', 'cpus', 'start_on_boot', 'notes', 'description', 'tag', 'region', 'password', 'port_forwards', 'startup_command', 'neofetch_cpu', 'neofetch_mem', 'neofetch_disk', 'neofetch_gpu'];
  for (const k of allowed) {
    if (data[k] !== undefined) vm[k] = data[k];
  }
  vm.updated_at = new Date().toISOString();
  state.upsertVm(vm);
  return vm;
}

function resizeDisk(vm, newSize) {
  vm.disk_size = String(newSize || vm.disk_size).toUpperCase();
  vm.updated_at = new Date().toISOString();
  state.upsertVm(vm);
  return vm;
}

async function startOnBootAll() {
  for (const vm of state.allVms()) {
    if (vm.virt_type !== 'lxc') continue;
    if (!vm.start_on_boot) continue;
    if (isRunning(vm)) continue;
    try { await startVm(vm); } catch (e) { /* one bad container must not stop the rest */ }
  }
}

async function rebuildVm(vm, data) {
  // Reinstall = destroy the container, wipe its rootfs and unpack a fresh copy of
  // the (possibly new) template. Mirrors qemu.reinstallVm's contract.
  const list = state.get().os_list_lxc || [];
  // Look the requested template up tolerantly, and fall back to the machine's
  // current template (label, then distro/release) before giving up - a reinstall
  // that keeps the same OS must never fail just because the value was submitted
  // as a distro id.
  const fromData = data && data.os ? findTemplateEntry(list, data.os) : null;
  const current = findTemplateEntry(list, vm.os_name) || findTemplateEntry(list, vm.os_type + '/' + vm.codename);
  const tmpl = fromData || current || (vm.os_name ? { 0: vm.os_name, 1: vm.os_type, 2: vm.codename, 3: 'amd64' } : null);
  if (!tmpl) throw new Error('Container template not found for reinstall');

  removeVm(vm);
  const dir = vmDir(vm);
  fs.mkdirSync(dir, { recursive: true });
  vm.os_name = tmpl[0];
  vm.os_type = tmpl[1];
  vm.codename = tmpl[2];
  if (data && data.password) vm.password = data.password;
  state.upsertVm(vm);
  await unpackRootfs(vm, tmpl);
  writeConfig(vm);
  const started = await startVm(vm);
  return { ok: true, vm: serializeFromState(vm.id), started };
}

function serializeFromState(id) {
  const v = state.getVm(id);
  return v || null;
}

module.exports = {
  ensureDirs,
  lxcAvailable,
  vmDir,
  containerName,
  createVm,
  rebuildVm,
  unpackRootfs,
  writeConfig,
  rootfsReady,
  isRunning,
  statusOf,
  startVm,
  stopVm,
  restartVm,
  removeVm,
  liveStats,
  fullStats,
  bootLog,
  clearBootLog,
  updateVm,
  resizeDisk,
  startOnBootAll,
  genAgentToken,
};
