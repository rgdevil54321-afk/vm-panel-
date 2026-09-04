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
  const userCpuModel = String(vm.cpu_model || 'default');
  const cpuModel = kvmAvailable && userCpuModel && userCpuModel !== 'default' && userCpuModel !== 'host'
    ? userCpuModel : (kvmAvailable ? 'host' : 'qemu64');
  const sockets = Math.max(1, parseInt(vm.cpu_sockets, 10) || 1);
  const cores = Math.max(1, parseInt(vm.cores_per_socket, 10) || 1);
  const threads = Math.max(1, parseInt(vm.threads_per_core, 10) || 1);
  const smp = `sockets=${sockets},cores=${cores},threads=${threads}`;

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
    '-cpu', cpuModel,
    '-machine', `type=${String(vm.machine_type || 'pc').split(',')[0]},accel=${accelMode}`,
  ];

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
  const nicModel = String(vm.nic_model || 'virtio').toLowerCase();
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
  const parseJson = (s) => { try { return JSON.parse(s || 'null'); } catch (_) { return null; } };
  // Node host for SSH instructions (falls back to the panel's own host)
  let node_host = null;
  try {
    const n = db.prepare('SELECT host, port FROM nodes WHERE id = ?').get(row.node_id || 1);
    if (n) node_host = n.host;
  } catch (_) {}
  const out = {
    ...row,
    port_forwards: forwards,
    additional_disks: parseJson(row.additional_disks) || [],
    advanced: parseJson(row.advanced) || {},
    node_host: node_host || 'localhost',
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

  const writeFiles = [];
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
  if (writeFiles.length) {
    blocks.push(`write_files:\n${writeFiles.map((f) =>
      `  - path: ${f.path}\n    owner: root:root\n    permissions: '${f.permissions}'\n    content: |\n${String(f.content).split('\n').map((l) => '      ' + l).join('\n')}`
    ).join('\n')}`);
  }

  const runcmds = [];
  let commands = [];
  try { commands = JSON.parse(vm.cloudinit_commands || '[]'); } catch (_) { commands = []; }
  for (const c of commands) if (c) runcmds.push(String(c));
  const startupScript = String(vm.startup_script || '').trim();
  if (startupScript) {
    const b64 = Buffer.from(startupScript, 'utf8').toString('base64');
    runcmds.push(`echo '${b64}' | base64 -d > /usr/local/bin/vpanel-firstboot && chmod 755 /usr/local/bin/vpanel-firstboot && /usr/local/bin/vpanel-firstboot`);
  }
  const userData = String(vm.cloudinit_userdata || '').trim();

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
${blocks.join('\n')}
runcmd:
  - sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config || true
  - sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config || true
  - sed -i 's/^KbdInteractiveAuthentication.*/KbdInteractiveAuthentication yes/' /etc/ssh/sshd_config || true
  - systemctl restart sshd 2>/dev/null || service ssh restart 2>/dev/null || true
${agentSeedPayload(vm).map((c) => '  - ' + c).join('\n')}
${runcmds.map((c) => '  - ' + c).join('\n')}
${userData ? '\n# === User-supplied cloud-init (appended verbatim) ===\n' + userData : ''}
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
        disk_size, memory, cpus, ssh_port, vnc_port, agent_port, agent_token, gui_mode, port_forwards, start_on_boot, startup_command, status, notes, created_at, updated_at,
        description, tag, region, vmid, cpu_sockets, cores_per_socket, threads_per_core, cpu_model, cpu_type, cpu_units, cpu_limit,
        mem_min, mem_max, ballooning, memory_hotplug, machine_type, firmware, secure_boot, tpm, boot_order, nic_model, nic_count,
        storage_pool, disk_format, additional_disks, cloudinit_userdata, cloudinit_packages, cloudinit_commands, cloudinit_files,
        startup_script, install_guest_agent, enable_monitoring, enable_backups, backup_schedule, timezone, locale, advanced)
       VALUES (@node_id, @uuid, @owner_id, @name, @os_type, @codename, @img_url, @hostname, @username, @password,
        @disk_size, @memory, @cpus, @ssh_port, @vnc_port, @agent_port, @agent_token, @gui_mode, @port_forwards, @start_on_boot, @startup_command, 'stopped', @notes, @created, @created,
        @description, @tag, @region, @vmid, @cpu_sockets, @cores_per_socket, @threads_per_core, @cpu_model, @cpu_type, @cpu_units, @cpu_limit,
        @mem_min, @mem_max, @ballooning, @memory_hotplug, @machine_type, @firmware, @secure_boot, @tpm, @boot_order, @nic_model, @nic_count,
        @storage_pool, @disk_format, @additional_disks, @cloudinit_userdata, @cloudinit_packages, @cloudinit_commands, @cloudinit_files,
        @startup_script, @install_guest_agent, @enable_monitoring, @enable_backups, @backup_schedule, @timezone, @locale, @advanced)`
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
  };

  const info = db.prepare(
    `INSERT INTO vms (node_id, uuid, owner_id, name, os_type, codename, img_url, hostname, username, password,
      disk_size, memory, cpus, ssh_port, vnc_port, agent_port, agent_token, gui_mode, port_forwards, start_on_boot, startup_command, status, notes, created_at, updated_at,
      description, tag, region, vmid, cpu_sockets, cores_per_socket, threads_per_core, cpu_model, cpu_type, cpu_units, cpu_limit,
      mem_min, mem_max, ballooning, memory_hotplug, machine_type, firmware, secure_boot, tpm, boot_order, nic_model, nic_count,
      storage_pool, disk_format, additional_disks, cloudinit_userdata, cloudinit_packages, cloudinit_commands, cloudinit_files,
      startup_script, install_guest_agent, enable_monitoring, enable_backups, backup_schedule, timezone, locale, advanced)
     VALUES (@node_id, @uuid, @owner_id, @name, @os_type, @codename, @img_url, @hostname, @username, @password,
      @disk_size, @memory, @cpus, @ssh_port, @vnc_port, @agent_port, @agent_token, @gui_mode, @port_forwards, @start_on_boot, @startup_command, @status, @notes, @created, @created,
      @description, @tag, @region, @vmid, @cpu_sockets, @cores_per_socket, @threads_per_core, @cpu_model, @cpu_type, @cpu_units, @cpu_limit,
      @mem_min, @mem_max, @ballooning, @memory_hotplug, @machine_type, @firmware, @secure_boot, @tpm, @boot_order, @nic_model, @nic_count,
      @storage_pool, @disk_format, @additional_disks, @cloudinit_userdata, @cloudinit_packages, @cloudinit_commands, @cloudinit_files,
      @startup_script, @install_guest_agent, @enable_monitoring, @enable_backups, @backup_schedule, @timezone, @locale, @advanced)`
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
