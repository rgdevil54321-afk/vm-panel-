const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn, execSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const config = require('../lib/config');
const { db, settings } = require('../lib/db');
const logger = require('../lib/logger');
const nodeRegistry = require('./nodeRegistry');
const { logActivity } = require('./activityService');

const VM_DIR = config.vmDir;
const RUNNING_PREFIX = 'qemu-system';

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

function dbVms() {
  return db.prepare(
    `SELECT v.*, u.username AS owner_name, u.email AS owner_email
     FROM vms v JOIN users u ON u.id = v.owner_id`
  ).all();
}

function serializeVm(row) {
  if (!row) return null;
  let forwards = [];
  try { forwards = JSON.parse(row.port_forwards || '[]'); } catch (_) {}
  const remote = (Number(row.node_id) || 1) !== 1;
  const out = {
    ...row,
    port_forwards: forwards,
    gui_mode: !!row.gui_mode,
    start_on_boot: !!row.start_on_boot,
    status: remote ? (row.status || 'stopped') : statusOf(row),
    managed: remote,
    dir: vmDir(row),
  };
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

async function create({ user, data }) {
  const osList = getOsList();
  const osEntry = osList.find((o) => o[0] === data.os) || osList[0];
  const vmName = String(data.name || '').trim().replace(/\s+/g, '-');
  if (!vmName || !/^[a-zA-Z0-9_-]+$/.test(vmName)) {
    throw new Error('VM name can only contain letters, numbers, hyphens, underscores');
  }
  const exists = db.prepare('SELECT id FROM vms WHERE name = ? AND owner_id = ?').get(vmName, user.id);
  if (exists) throw new Error(`VM "${vmName}" already exists`);

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
    };
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
        disk_size, memory, cpus, ssh_port, vnc_port, agent_port, agent_token, gui_mode, port_forwards, start_on_boot, startup_command, status, notes, created_at, updated_at)
       VALUES (@node_id, @uuid, @owner_id, @name, @os_type, @codename, @img_url, @hostname, @username, @password,
        @disk_size, @memory, @cpus, @ssh_port, @vnc_port, @agent_port, @agent_token, @gui_mode, @port_forwards, @start_on_boot, @startup_command, 'stopped', @notes, @created, @created)`
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
  };

  const info = db.prepare(
    `INSERT INTO vms (node_id, uuid, owner_id, name, os_type, codename, img_url, hostname, username, password,
      disk_size, memory, cpus, ssh_port, vnc_port, agent_port, agent_token, gui_mode, port_forwards, start_on_boot, startup_command, status, notes, created_at, updated_at)
     VALUES (@node_id, @uuid, @owner_id, @name, @os_type, @codename, @img_url, @hostname, @username, @password,
      @disk_size, @memory, @cpus, @ssh_port, @vnc_port, @agent_port, @agent_token, @gui_mode, @port_forwards, @start_on_boot, @startup_command, @status, @notes, @created, @created)`
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

  writeSeed(vm);
  setDbStatus(id, 'stopped');
  logActivity({ user_id: user.id, vm_id: id, event: 'vm:create', details: { name: vmName, port: sshPort } });

  return getVm(id);
}

async function start(vm, { user = null } = {}) {
  if (isRunning(vm)) return { ok: true, message: 'already running', status: 'running' };

  if (isRemoteVm(vm)) {
    const node = remoteNodeFor(vm);
    if (!node) throw new Error('Node not found for this VM');
    try {
      await nodeRegistry.startVmOnNode(node, vm);
    } catch (e) {
      throw new Error('Node start failed: ' + e.message);
    }
    setDbStatus(vm.id, 'running');
    logActivity({ user_id: user ? user.id : null, vm_id: vm.id, event: 'vm:start', details: { node: node.name } });
    return { ok: true, status: 'running' };
  }

  if (!fs.existsSync(vm.img_file)) throw new Error(`Image file not found: ${vm.img_file}`);
  if (!fs.existsSync(vm.seed_file)) {
    writeSeed(vm);
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
  logger.info(`[vm] starting ${vm.name}: qemu-system-x86_64 ${args.join(' ')}`);
  const child = spawn('qemu-system-x86_64', args, { stdio: ['ignore', logFile, logFile] });
  child.on('error', (e) => {
    logger.error('[vm] qemu spawn error: ' + e.message);
    setDbStatus(vm.id, 'stopped');
  });
  child.on('exit', () => {
    fs.closeSync(logFile);
    setDbStatus(vm.id, 'stopped');
  });
  await new Promise((r) => setTimeout(r, 1500));
  setDbStatus(vm.id, 'running');
  logActivity({ user_id: user ? user.id : null, vm_id: vm.id, event: 'vm:start' });
  return { ok: true };
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
  return { ok: true };
}

async function restart(vm, user) {
  if (isRemoteVm(vm)) {
    const node = remoteNodeFor(vm);
    if (!node) throw new Error('Node not found for this VM');
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

async function getTmateSsh(vm, regen) {
  const node = remoteNodeFor(vm);
  if (!node) throw new Error('Node not found for this VM');
  const r = await nodeRegistry.tmateVmOnNode(node, vm, !!regen);
  if (!r || !r.ssh) throw new Error('No tmate SSH address returned');
  return r.ssh;
}

function update(vm, data, user) {
  const fields = ['name', 'hostname', 'username', 'password', 'memory', 'cpus', 'disk_size', 'gui_mode', 'port_forwards', 'start_on_boot', 'startup_command', 'notes', 'owner_id'];
  const set = [];
  const vals = {};
  for (const f of fields) {
    if (data[f] !== undefined) {
      set.push(`${f} = @${f}`);
      if (f === 'port_forwards' && Array.isArray(data[f])) vals[f] = JSON.stringify(data[f]);
      else if (f === 'gui_mode' || f === 'start_on_boot') vals[f] = data[f] ? 1 : 0;
      else if (f === 'owner_id') vals[f] = parseInt(data[f], 10);
      else vals[f] = data[f];
    }
  }
  if (set.length) {
    set.push('updated_at = @updated_at');
    vals.updated_at = now();
    db.prepare(`UPDATE vms SET ${set.join(', ')} WHERE id = @id`).run({ ...vals, id: vm.id });
  }
  const needSeed = ['hostname', 'username', 'password'].some((f) => data[f] !== undefined);
  if (needSeed) writeSeed(vm);
  logActivity({ user_id: user ? user.id : null, vm_id: vm.id, event: 'vm:update', details: data });
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

module.exports = {
  VM_DIR, vmDir, dbVms, getVm, create, start, stop, restart, remove, update,
  resizeDisk, isRunning, isRemoteVm, statusOf, serializeVm, canAccess, allocPort, allocVncPort, allocAgentPort,
  parseForwards, usage, uptimeSeconds, memUsage, cpuUsage, diskActualUsage, liveStats, liveStatsRemote, totalDiskUsage, startOnBootAll, getOsList, getBootLog, clearBootLog, hasKvm, transferOwner,
  reinstall, getTmateSsh,
};
