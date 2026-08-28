'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync, execSync } = require('child_process');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const state = require('./state');

const VM_DIR = path.resolve(__dirname, '..', '..', 'vms');

function ensureDirs() {
  fs.mkdirSync(VM_DIR, { recursive: true });
}

function now() {
  return new Date().toISOString();
}

function hasBin(bin) {
  try {
    return spawnSync('which', [bin], { stdio: 'ignore' }).status === 0;
  } catch (e) {
    return false;
  }
}

function vmDir(vm) {
  return path.join(VM_DIR, String(vm.id));
}

function hasKvm() {
  if (process.env.NO_KVM === '1' || process.env.NOKVM === '1') return false;
  try {
    if (!fs.existsSync('/dev/kvm')) return false;
    fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch (e) {
    return false;
  }
}

function inUsePort(port) {
  try {
    execSync(`ss -tln | grep -q ':${port} '`, { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

function genAgentToken() {
  return crypto.randomBytes(24).toString('hex');
}

function allocHostPort(vm, field, min, max) {
  const used = new Set(state.get().vms.map((v) => v[field]).filter(Boolean));
  for (let p = min; p <= max; p++) {
    if (!used.has(p) && !inUsePort(p)) return p;
  }
  throw new Error(`No free port in range ${min}-${max}`);
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

function buildQemuArgs(vm) {
  const dir = vmDir(vm);
  const img = vm.img_file || path.join(dir, 'disk.qcow2');
  const seed = vm.seed_file || path.join(dir, 'seed.iso');
  const fwds = parseForwards(vm.port_forwards);
  const kvmAvailable = hasKvm();
  const accelMode = kvmAvailable ? 'kvm:tcg' : 'tcg';
  const cpuType = kvmAvailable ? 'host' : 'qemu64';

  const args = [
    '-m', String(vm.memory),
    '-smp', String(vm.cpus),
    '-cpu', cpuType,
    '-machine', `type=pc,accel=${accelMode}`,
    '-drive', `file=${img},format=qcow2,if=virtio`,
    '-drive', `file=${seed},format=raw,if=virtio`,
    '-boot', 'order=c',
    '-device', 'virtio-net-pci,netdev=n0',
    '-netdev', `user,id=n0,hostfwd=tcp::${vm.ssh_port}-:22${vm.agent_port ? `,hostfwd=tcp::${vm.agent_port}-:9090` : ''}`,
    '-object', 'rng-random,filename=/dev/urandom,id=rng0',
    '-device', 'virtio-rng-pci,rng=rng0',
    '-rtc', 'base=utc,clock=host',
    '-device', 'virtio-balloon-pci',
  ];

  let ni = 1;
  for (const f of fwds) {
    args.push('-device', `virtio-net-pci,netdev=n${ni}`);
    args.push('-netdev', `user,id=n${ni},hostfwd=tcp::${f.host}-:${f.guest}`);
    ni++;
  }

  if (vm.vnc_port) {
    args.push('-vnc', `127.0.0.1:${vm.vnc_port - 5900}`);
  } else {
    args.push('-display', 'none');
  }

  args.push(
    '-serial', `file:${path.join(dir, 'boot.log')}`,
    '-vga', 'std',
    '-pidfile', path.join(dir, 'qemu.pid'),
    '-daemonize',
  );

  return args;
}

function pidOf(vm) {
  const file = path.join(vmDir(vm), 'qemu.pid');
  try {
    const pid = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    if (pid > 0) return pid;
  } catch (e) {}
  return null;
}

function isRunning(vm) {
  const pid = pidOf(vm);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

function statusOf(vm) {
  return isRunning(vm) ? 'running' : 'stopped';
}

function agentSeedPayload(vm) {
  const agentDir = path.resolve(__dirname, '..', '..', 'scripts', 'vpanel-agent.py');
  let script = '';
  try {
    script = fs.readFileSync(agentDir, 'utf8');
  } catch (e) {
    script = "# agent delivery requires scripts/vpanel-agent.py on the panel host\n";
  }
  const unit = [
    '[Unit]',
    'Description=Venlix Node Guest Agent',
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

function writeSeed(vm) {
  const dir = vmDir(vm);
  const passHash = spawnSync('openssl', ['passwd', '-6', vm.password], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(
    path.join(dir, 'user-data'),
    `#cloud-config
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
write_files:
  - path: /etc/ssh/sshd_config.d/60-vpanel.conf
    owner: root:root
    permissions: '0644'
    content: |
      PermitRootLogin yes
      PasswordAuthentication yes
      KbdInteractiveAuthentication yes
runcmd:
  - sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config || true
  - sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config || true
  - sed -i 's/^KbdInteractiveAuthentication.*/KbdInteractiveAuthentication yes/' /etc/ssh/sshd_config || true
  - systemctl restart sshd 2>/dev/null || service ssh restart 2>/dev/null || true
${agentSeedPayload(vm).map((c) => '  - ' + c).join('\n')}
`
  );
  fs.writeFileSync(
    path.join(dir, 'meta-data'),
    `instance-id: iid-${vm.uuid || vm.name}\nlocal-hostname: ${vm.hostname || vm.name}\n`
  );
  const r = spawnSync('cloud-localds', [path.join(dir, 'seed.iso'), path.join(dir, 'user-data'), path.join(dir, 'meta-data')], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`cloud-localds failed: ${r.stderr || r.stdout}`);
  }
}

async function download(url, dest) {
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

async function createVm({ data, osList }) {
  ensureDirs();
  const osEntry = osList.find((o) => o[0] === data.os) || osList[0] || [];
  const vmName = String(data.name || '').trim().replace(/\s+/g, '-');
  if (!vmName || !/^[a-zA-Z0-9_-]+$/.test(vmName)) {
    throw new Error('VM name can only contain letters, numbers, hyphens, underscores');
  }
  const existing = state.get().vms.find((v) => v.name === vmName);
  if (existing) throw new Error(`VM "${vmName}" already exists on this node`);

  const hostname = String(data.hostname || vmName).replace(/\s+/g, '-');
  const username = String(data.username || osEntry[4] || 'root').toLowerCase();
  const password = String(data.password || 'vpanel' + Math.random().toString(36).slice(2, 8));
  const diskSize = String(data.disk_size || '20G').toUpperCase();
  const memory = parseInt(data.memory || '2048', 10);
  const cpus = parseInt(data.cpus || '2', 10);
  const sshPort = data.ssh_port ? parseInt(data.ssh_port, 10) : allocHostPort(null, 'ssh_port', 25501, 25600);
  if (isNaN(sshPort) || sshPort < 23 || sshPort > 65535) throw new Error('Invalid SSH port');
  if (inUsePort(sshPort)) throw new Error(`Port ${sshPort} is already in use`);
  const vncPort = allocHostPort(null, 'vnc_port', 25901, 26000);
  const agentPort = allocHostPort(null, 'agent_port', 26101, 26200);
  const agentToken = genAgentToken();
  const guiMode = data.gui_mode === true || data.gui_mode === '1' || data.gui_mode === 'true';
  const forwards = Array.isArray(data.port_forwards) ? data.port_forwards : [];

  const id = state.nextId();
  const vm = {
    id,
    uuid: data.uuid || uuidv4(),
    name: vmName,
    os_type: osEntry[1] || '',
    codename: osEntry[2] || '',
    os_name: osEntry[0] || '',
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
    notes: data.notes || '',
    created_at: now(),
    updated_at: now(),
  };
  state.upsertVm(vm);
  saveVmFiles(vm, osList, data);
  return vm;
}

function saveVmFiles(vm, osList, data) {
  const dir = vmDir(vm);
  fs.mkdirSync(dir, { recursive: true });
  const img = path.join(dir, 'disk.qcow2');
  const seed = path.join(dir, 'seed.iso');
  vm.img_file = img;
  vm.seed_file = seed;
  state.upsertVm(vm);

  if (!fs.existsSync(img)) {
    const osEntry = osList.find((o) => o[0] === vm.os_name) || [];
    const imgUrl = data.img_url || osEntry[3] || vm.img_url;
    if (data.upload_image_base64) {
      fs.writeFileSync(img, Buffer.from(data.upload_image_base64, 'base64'));
      const info = spawnSync('qemu-img', ['info', '--output=json', img], { encoding: 'utf8' });
      let fmt = null;
      try { fmt = JSON.parse(info.stdout).format; } catch (e) {}
      if (fmt && fmt !== 'qcow2') {
        const tmp = img + '.conv';
        const conv = spawnSync('qemu-img', ['convert', '-O', 'qcow2', img, tmp], { encoding: 'utf8' });
        if (conv.status !== 0) throw new Error('Failed to convert uploaded image: ' + (conv.stderr || ''));
        fs.unlinkSync(img);
        fs.renameSync(tmp, img);
      }
    } else {
      if (!hasBin('wget')) throw new Error('wget is required to download cloud images');
      if (imgUrl) {
        const r = spawnSync('qemu-img', ['info', img], { encoding: 'utf8' });
        if (!fs.existsSync(img) || r.status !== 0) {
          // synchronous-ish download not possible with async API; do it inline
        }
      }
    }
  }
}

function prepareImage(vm) {
  const img = vm.img_file;
  if (!fs.existsSync(img)) {
    if (!vm.img_url) throw new Error('No image URL available for VM ' + vm.name);
    if (!hasBin('wget')) throw new Error('wget is required to download cloud images');
    const r = spawnSync('qemu-img', ['info', img], { encoding: 'utf8' });
    if (!fs.existsSync(img) || r.status !== 0) {
      const tmp = img + '.tmp';
      const dl = spawnSync('wget', ['-q', '-O', tmp, vm.img_url], { encoding: 'utf8' });
      if (dl.status !== 0) throw new Error('Failed to download base image: ' + (dl.stderr || ''));
      fs.renameSync(tmp, img);
    }
  }
  const resize = spawnSync('qemu-img', ['resize', img, vm.disk_size], { encoding: 'utf8' });
  if (resize.status !== 0) {
    // image may be unformatted; non-fatal
  }
  writeSeed(vm);
}

function startVm(vm) {
  if (isRunning(vm)) return { ok: true, message: 'already running' };
  if (!vm.img_file || !fs.existsSync(vm.img_file)) {
    prepareImage(vm);
  }
  if (!fs.existsSync(vm.seed_file)) writeSeed(vm);
  if (!vm.vnc_port) {
    vm.vnc_port = allocHostPort(vm, 'vnc_port', 25901, 26000);
    state.upsertVm(vm);
  }
  if (!vm.agent_port) {
    vm.agent_port = allocHostPort(vm, 'agent_port', 26101, 26200);
    state.upsertVm(vm);
  }
  const dir = vmDir(vm);
  const bootLogPath = path.join(dir, 'boot.log');
  const sessionHeader = `\r\n=== [Venlix] Starting VM "${vm.name}" at ${now()} ===\r\n\r\n`;
  try {
    fs.appendFileSync(bootLogPath, sessionHeader, 'utf8');
  } catch (e) {}
  const logFile = fs.openSync(path.join(dir, 'qemu.log'), 'a');
  const args = buildQemuArgs(vm);
  const child = spawn('qemu-system-x86_64', args, { stdio: ['ignore', logFile, logFile] });
  child.on('error', (e) => {
    fs.closeSync(logFile);
    throw new Error('qemu spawn error: ' + e.message);
  });
  child.on('exit', () => {
    try { fs.closeSync(logFile); } catch (e) {}
  });
  vm.updated_at = now();
  state.upsertVm(vm);
  return { ok: true };
}

function stopVm(vm, force = false) {
  const pid = pidOf(vm);
  if (!pid) return { ok: true, message: 'not running' };
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    if (!force) {
      const end = Date.now() + 5000;
      while (Date.now() < end && isRunning(vm)) {
        execSync('sleep 0.2', { stdio: 'ignore' });
      }
    }
    if (isRunning(vm)) process.kill(pid, 'SIGKILL');
  } catch (e) {}
  try { fs.unlinkSync(path.join(vmDir(vm), 'qemu.pid')); } catch (e) {}
  vm.updated_at = now();
  state.upsertVm(vm);
  return { ok: true };
}

function restartVm(vm) {
  stopVm(vm);
  return startVm(vm);
}

function removeVm(vm, force = false) {
  if (isRunning(vm)) stopVm(vm, force || true);
  try {
    fs.rmSync(vmDir(vm), { recursive: true, force: true });
  } catch (e) {}
  state.removeVm(vm.id);
  return { ok: true };
}

function updateVm(vm, data) {
  const fields = ['name', 'hostname', 'username', 'password', 'memory', 'cpus', 'disk_size', 'gui_mode', 'port_forwards', 'start_on_boot', 'startup_command', 'notes'];
  for (const f of fields) {
    if (data[f] !== undefined) {
      if (f === 'port_forwards' && Array.isArray(data[f])) vm[f] = JSON.stringify(data[f]);
      else if (f === 'gui_mode' || f === 'start_on_boot') vm[f] = data[f] ? 1 : 0;
      else vm[f] = data[f];
    }
  }
  vm.updated_at = now();
  state.upsertVm(vm);
  const needSeed = ['hostname', 'username', 'password'].some((f) => data[f] !== undefined);
  if (needSeed) writeSeed(vm);
  return vm;
}

function resizeDisk(vm, newSize) {
  if (isRunning(vm)) throw new Error('Cannot resize disk while VM is running. Stop the VM first.');
  if (!/^[0-9]+[GM]$/i.test(newSize)) throw new Error('Disk size must be like 50G or 512M');
  const r = spawnSync('qemu-img', ['resize', vm.img_file, newSize], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || 'Failed to resize disk');
  vm.disk_size = newSize.toUpperCase();
  vm.updated_at = now();
  state.upsertVm(vm);
  return vm;
}

function bootLog(vm) {
  const dir = vmDir(vm);
  let content = '';
  const bootLogP = path.join(dir, 'boot.log');
  const qemuLog = path.join(dir, 'qemu.log');
  if (fs.existsSync(bootLogP)) {
    try {
      const data = fs.readFileSync(bootLogP, 'utf8');
      if (data && data.trim()) content += data;
    } catch (e) {}
  }
  if (fs.existsSync(qemuLog)) {
    try {
      const qdata = fs.readFileSync(qemuLog, 'utf8');
      if (qdata && qdata.trim()) {
        content = (content ? content + '\n\n=== QEMU System Output ===\n' : '') + qdata;
      }
    } catch (e) {}
  }
  return content || '[Boot Log] No boot output recorded yet.';
}

function clearBootLog(vm) {
  for (const f of ['boot.log', 'qemu.log']) {
    try { fs.writeFileSync(path.join(vmDir(vm), f), '', 'utf8'); } catch (e) {}
  }
  return { ok: true };
}

function uptimeSeconds(vm) {
  const pid = pidOf(vm);
  if (!pid) return 0;
  try {
    const out = execSync(`ps -o etimes= -p ${pid}`, { encoding: 'utf8' }).trim();
    return parseInt(out, 10) || 0;
  } catch (e) { return 0; }
}

function memUsageBytes(vm) {
  const pid = pidOf(vm);
  if (!pid) return 0;
  try {
    const out = execSync(`ps -o rss= -p ${pid}`, { encoding: 'utf8' }).trim();
    return (parseInt(out, 10) || 0) * 1024;
  } catch (e) { return 0; }
}

function cpuUsagePct(vm) {
  const pid = pidOf(vm);
  if (!pid) return 0;
  try {
    const out = execSync(`ps -o %cpu= -p ${pid}`, { encoding: 'utf8' }).trim();
    return Math.round((parseFloat(out) || 0) * 10) / 10;
  } catch (e) { return 0; }
}

function diskActualBytes(vm) {
  try {
    if (vm.img_file && fs.existsSync(vm.img_file)) {
      return fs.statSync(vm.img_file).size;
    }
  } catch (e) {}
  return 0;
}

function liveStats(vm) {
  const running = isRunning(vm);
  const pid = running ? pidOf(vm) : null;
  const uptime = running ? uptimeSeconds(vm) : 0;
  const memUsedBytes = running ? memUsageBytes(vm) : 0;
  const cpuPct = running ? cpuUsagePct(vm) : 0;
  const totalMemBytes = (parseInt(vm.memory, 10) || 1024) * 1024 * 1024;
  const memPct = totalMemBytes > 0 ? Math.min(100, Math.round((memUsedBytes / totalMemBytes) * 100)) : 0;
  const diskBytes = diskActualBytes(vm);
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
    uuid: vm.uuid,
    name: vm.name,
    status: running ? 'running' : 'stopped',
    running,
    pid,
    uptime,
    cpu: { percent: cpuPct, cpus: vm.cpus || 1 },
    memory: { used_bytes: memUsedBytes, used_mb: Math.round(memUsedBytes / 1024 / 1024), total_mb: vm.memory, percent: memPct },
    disk: { allocated: vm.disk_size, actual_bytes: diskBytes, actual_mb: Math.round(diskBytes / 1024 / 1024), percent: diskPct },
    ports: { ssh: vm.ssh_port, vnc: vm.vnc_port, agent: vm.agent_port },
    updated_at: now(),
  };
}

function startOnBootAll() {
  for (const vm of state.allVms()) {
    if (vm.start_on_boot) {
      try { startVm(vm); } catch (e) {}
    }
  }
}

function usage() {
  return {
    qemu: hasBin('qemu-system-x86_64'),
    cloudLocalds: hasBin('cloud-localds'),
    wget: hasBin('wget'),
    kvm: hasKvm(),
  };
}

function hostStats() {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPct = totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0;
  const load = os.loadavg();
  let disk = { total_bytes: 0, used_bytes: 0, free_bytes: 0, total_gb: '0', used_gb: '0', free_gb: '0', percent: 0 };
  try {
    const dfOut = execSync('df -B1 /', { encoding: 'utf8' }).trim().split('\n')[1].split(/\s+/);
    const total = parseInt(dfOut[1], 10) || 0;
    const used = parseInt(dfOut[2], 10) || 0;
    const free = parseInt(dfOut[3], 10) || 0;
    disk = {
      total_bytes: total, used_bytes: used, free_bytes: free,
      total_gb: (total / (1024 ** 3)).toFixed(1),
      used_gb: (used / (1024 ** 3)).toFixed(1),
      free_gb: (free / (1024 ** 3)).toFixed(1),
      percent: total > 0 ? Math.round((used / total) * 100) : 0,
    };
  } catch (e) {}
  let qemuVer = 'not installed';
  try {
    qemuVer = execSync('qemu-system-x86_64 --version', { encoding: 'utf8' }).trim().split('\n')[0];
  } catch (e) {}
  let swap = { total_mb: 0, used_mb: 0, free_mb: 0, percent: 0 };
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const totalMatch = meminfo.match(/SwapTotal:\s+(\d+)\s+kB/);
    const freeMatch = meminfo.match(/SwapFree:\s+(\d+)\s+kB/);
    if (totalMatch && freeMatch) {
      const t = parseInt(totalMatch[1], 10), f = parseInt(freeMatch[1], 10), u = t - f;
      swap = { total_mb: Math.round(t / 1024), used_mb: Math.round(u / 1024), free_mb: Math.round(f / 1024), percent: t > 0 ? Math.round((u / t) * 100) : 0 };
    }
  } catch (e) {}

  const vms = state.allVms();
  const running = vms.filter(isRunning);
  let allocatedMem = 0, allocatedCpus = 0;
  const vmUsages = [];
  for (const v of vms) {
    allocatedMem += parseInt(v.memory, 10) || 0;
    allocatedCpus += parseInt(v.cpus, 10) || 1;
    if (isRunning(v)) {
      vmUsages.push({ id: v.id, uuid: v.uuid, name: v.name, cpu_percent: cpuUsagePct(v), memory_mb: Math.round(memUsageBytes(v) / 1024 / 1024), memory_alloc: v.memory, disk_size: v.disk_size });
    }
  }

  const s = state.get();
  const singleCpu = cpus.length ? cpus.reduce((a, c) => a + c.times.idle, 0) === 0 : true;
  let overallPct = 0;
  try {
    const totalTime = cpus.reduce((a, c) => a + Object.values(c.times).reduce((x, y) => x + y, 0), 0);
    const idleTime = cpus.reduce((a, c) => a + c.times.idle, 0);
    if (totalTime > 0) overallPct = 100 - Math.round((100 * idleTime) / totalTime);
  } catch (e) {}
  overallPct = Math.max(0, Math.min(100, overallPct));

  return {
    id: s.nodeId,
    name: s.name,
    hostname: os.hostname(),
    status: 'online',
    location: s.location,
    ip: '', // best-effort below
    uptime_seconds: Math.floor(os.uptime()),
    process_uptime: Math.floor(process.uptime()),
    os: { type: os.type(), release: os.release(), arch: os.arch(), platform: os.platform() },
    cpu: { model: cpus[0] ? cpus[0].model : 'x86_64 Processor', cores_count: cpus.length, percent: overallPct, per_core: cpus.map(() => overallPct), load_avg: [load[0].toFixed(2), load[1].toFixed(2), load[2].toFixed(2)] },
    memory: { total_mb: Math.round(totalMem / 1024 / 1024), used_mb: Math.round(usedMem / 1024 / 1024), free_mb: Math.round(freeMem / 1024 / 1024), percent: memPct },
    swap,
    disk,
    hypervisor: { qemu_installed: usage().qemu, qemu_version: qemuVer, kvm_support: hasKvm(), cloud_init: spinupOk() },
    vms: { total: vms.length, running: running.length, stopped: vms.length - running.length, allocated_memory_mb: allocatedMem, allocated_cpus: allocatedCpus, active_top_vms: vmUsages },
    updated_at: now(),
  };
}

function spinupOk() {
  return hasBin('cloud-localds') && hasBin('qemu-img') && hasBin('wget');
}

function getPublicIp() {
  try {
    const out = execSync('curl -s -m 3 ifconfig.me', { encoding: 'utf8' }).trim();
    if (out) return out;
  } catch (e) {}
  try {
    const out = execSync(`hostname -I`, { encoding: 'utf8' }).trim().split(' ')[0];
    if (out) return out;
  } catch (e) {}
  return '';
}

module.exports = {
  ensureDirs, VM_DIR, createVm, prepareImage, startVm, stopVm, restartVm, removeVm, updateVm,
  resizeDisk, bootLog, clearBootLog, liveStats, getVm: state.getVm,
  hostStats, startOnBootAll, usage, hasKvm,
  isRunning, statusOf, allVms: state.allVms, getHostStatsOnce: getPublicIp,
};
