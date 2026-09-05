'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync, execSync } = require('child_process');
const crypto = require('crypto');
// Built-in UUID (Node 14.17+/16+): zero npm dependencies for the agent.
const uuidv4 = () => crypto.randomUUID();
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
  const userCpuModel = String(vm.cpu_model || 'default');
  const cpuModel = kvmAvailable && userCpuModel && userCpuModel !== 'default' && userCpuModel !== 'host'
    ? userCpuModel : (kvmAvailable ? 'host' : 'qemu64');
  const sockets = Math.max(1, parseInt(vm.cpu_sockets, 10) || 1);
  const cores = Math.max(1, parseInt(vm.cores_per_socket, 10) || 1);
  const threads = Math.max(1, parseInt(vm.threads_per_core, 10) || 1);
  const smp = `sockets=${sockets},cores=${cores},threads=${threads}`;
  const ballooning = String(vm.ballooning) === '1' || String(vm.ballooning) === 'true';

  let memBase = String(vm.memory || '2048');
  const memMax = parseInt(vm.mem_max, 10);
  const memBaseVal = parseInt(memBase, 10);
  const hotMax = Math.max(memMax || 0, parseInt(vm.memory_hotplug, 10) || 0);
  if (hotMax > memBaseVal) memBase = `${memBase},maxmem=${hotMax},slots=4`;

  const args = [
    '-m', memBase,
    '-smp', smp,
    '-cpu', cpuModel,
    '-machine', `type=${String(vm.machine_type || 'pc').split(',')[0]},accel=${accelMode}`,
  ];

  const firmware = String(vm.firmware || 'bios');
  if (firmware === 'uefi' || String(vm.secure_boot || '') === '1') {
    args.push('-drive', 'if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE.fd');
    args.push('-drive', `if=pflash,format=raw,file=${path.join(dir, 'efi_vars.fd')}`);
  }
  if (String(vm.tpm || '') === '1' && hasBin('swtpm')) {
    args.push('-chardev', `socket,id=chrtpm,path=${path.join(dir, 'swtpm.sock')}`);
    args.push('-tpmdev', 'emulator,id=tpm0,chardev=chrtpm');
    args.push('-object', 'tpm-crb,id=tpm0');
  }

  args.push('-drive', `file=${img},format=qcow2,if=virtio`);

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

  const bootOrder = String(vm.boot_order || 'c').replace(/[^a-z]/gi, '');
  args.push('-boot', `order=${bootOrder || 'c'}`);

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
  // Clamp requested RAM to what the host/container can actually provide
  // (leave 512MB for the system). Prevents un-bootable VMs on small nodes.
  // In containers the cgroup limit is the ceiling; on bare hosts it's totalmem.
  let capMb = Math.floor(os.totalmem() / 1024 / 1024);
  try {
    const max = parseInt(fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim(), 10);
    if (Number.isFinite(max) && max > 0 && max < os.totalmem()) capMb = Math.min(capMb, Math.floor(max / 1024 / 1024));
  } catch (e) {}
  try {
    const lim = parseInt(fs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim(), 10);
    if (Number.isFinite(lim) && lim > 0 && lim < os.totalmem()) capMb = Math.min(capMb, Math.floor(lim / 1024 / 1024));
  } catch (e) {}
  const maxVmMemMb = Math.max(256, capMb - 512);
  let memory = parseInt(data.memory || '2048', 10);
  if (!Number.isFinite(memory) || memory < 256) memory = 256;
  if (memory > maxVmMemMb) memory = maxVmMemMb;
  const cpus = parseInt(data.cpus || '2', 10);
  // Pre-flight: enough free disk for this VM's image? (image + seed + snapshots)
  const wantDiskBytes = (parseInt(String(diskSize).replace(/[^0-9]/g, ''), 10) || 20) * 1024 * 1024 * 1024;
  let freeDiskBytes = Infinity;
  try {
    const dfOut = execSync(`df -B1 "${VM_DIR}"`, { encoding: 'utf8' }).trim().split('\n')[1].split(/\s+/);
    freeDiskBytes = parseInt(dfOut[3], 10) || 0;
  } catch (e) {}
  if (freeDiskBytes !== Infinity && freeDiskBytes < wantDiskBytes + 2 * 1024 * 1024 * 1024) {
    throw new Error(`Not enough disk space on this node: VM needs ${Math.round(wantDiskBytes / 1024 ** 3)} GB (+2 GB headroom) but only ${(freeDiskBytes / 1024 ** 3).toFixed(1)} GB is free. Free up space or reduce the disk size.`);
  }
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
    description: data.description || '',
    tag: data.tag || '',
    region: data.region || '',
    vmid: data.vmid || '',
    cpu_sockets: parseInt(data.cpu_sockets, 10) || 1,
    cores_per_socket: parseInt(data.cores_per_socket, 10) || 1,
    threads_per_core: parseInt(data.threads_per_core, 10) || 1,
    cpu_model: data.cpu_model || 'default',
    cpu_units: parseInt(data.cpu_units, 10) || 1024,
    cpu_limit: String(data.cpu_limit || ''),
    mem_min: parseInt(data.mem_min, 10) || 0,
    mem_max: parseInt(data.mem_max, 10) || 0,
    ballooning: (data.ballooning === true || data.ballooning === 1 || data.ballooning === '1') ? 1 : 0,
    memory_hotplug: parseInt(data.memory_hotplug, 10) || 0,
    machine_type: data.machine_type || 'pc',
    firmware: data.firmware || 'bios',
    secure_boot: (data.secure_boot === true || data.secure_boot === 1 || data.secure_boot === '1') ? 1 : 0,
    tpm: (data.tpm === true || data.tpm === 1 || data.tpm === '1') ? 1 : 0,
    boot_order: data.boot_order || 'c',
    nic_model: data.nic_model || 'virtio',
    nic_count: Math.max(1, Math.min(6, parseInt(data.nic_count, 10) || 1)),
    storage_pool: data.storage_pool || 'default',
    disk_format: data.disk_format || 'qcow2',
    additional_disks: JSON.stringify(
      (Array.isArray(data.additional_disks) ? data.additional_disks : [])
        .filter((d) => d && d.size)
        .map((d) => ({ size: String(d.size), name: String(d.name || ''), bus: String(d.bus || 'virtio') }))
    ),
    cloudinit_userdata: data.cloudinit_userdata || '',
    cloudinit_packages: JSON.stringify(Array.isArray(data.cloudinit_packages) ? data.cloudinit_packages : []),
    cloudinit_commands: JSON.stringify(Array.isArray(data.cloudinit_commands) ? data.cloudinit_commands : []),
    cloudinit_files: JSON.stringify(Array.isArray(data.cloudinit_files) ? data.cloudinit_files : []),
    startup_script: data.startup_script || '',
    install_guest_agent: (data.install_guest_agent === true || data.install_guest_agent === 1 || data.install_guest_agent === '1') ? 1 : 0,
    enable_monitoring: (data.enable_monitoring === true || data.enable_monitoring === 1 || data.enable_monitoring === '1') ? 1 : 0,
    enable_backups: (data.enable_backups === true || data.enable_backups === 1 || data.enable_backups === '1') ? 1 : 0,
    backup_schedule: data.backup_schedule || '',
    timezone: data.timezone || 'UTC',
    locale: data.locale || 'en_US.UTF-8',
    advanced: typeof data.advanced === 'string' ? data.advanced : JSON.stringify(data.advanced || {}),
    created_at: now(),
    updated_at: now(),
  };
  state.upsertVm(vm);
  saveVmFiles(vm, osList, data);
  return vm;
}

function provisionDataDisks(vm) {
  const dir = vmDir(vm);
  let disks = [];
  try { disks = JSON.parse(vm.additional_disks || '[]'); } catch (_) { disks = []; }
  let di = 0;
  for (const d of disks) {
    if (!d || !d.size) continue;
    di++;
    const size = String(d.size || '10G').toUpperCase();
    if (!/^[0-9]+[GM]$/i.test(size)) continue;
    const relName = d.name ? String(d.name).replace(/[^a-zA-Z0-9_\-.]/g, '') : `data-${di}.qcow2`;
    const file = path.join(dir, relName.endsWith('.qcow2') ? relName : relName + '.qcow2');
    if (!fs.existsSync(file)) {
      spawnSync('qemu-img', ['create', '-f', 'qcow2', file, size], { encoding: 'utf8' });
    }
  }
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
  provisionDataDisks(vm);
  writeSeed(vm);
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

// Available memory in bytes: min(host view, cgroup v1/v2 limit for containers).
// Returns { bytes, limitedBy } so callers can explain WHERE the cap comes from.
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
  } catch (e) {}
  try {
    // cgroup v1
    const lim = parseInt(fs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim(), 10);
    const used = parseInt(fs.readFileSync('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf8').trim(), 10);
    if (Number.isFinite(lim) && lim > 0 && lim < os.totalmem()) {
      const cg = Math.max(0, lim - used);
      if (cg < avail) { avail = cg; limitedBy = 'container/cgroup v1 limit (' + Math.round(lim / 1024 ** 2) + ' MB total, ' + Math.round(used / 1024 ** 2) + ' MB used)'; }
    }
  } catch (e) {}
  return { bytes: avail, limitedBy };
}

function startVm(vm) {
  if (isRunning(vm)) return { ok: true, message: 'already running' };
  // Pre-flight: can the host/container actually provide the guest RAM?
  const wantBytes = (parseInt(vm.memory, 10) || 512) * 1024 * 1024;
  const budget = memoryBudget();
  if (budget.bytes < wantBytes + 64 * 1024 * 1024) { // keep 64MB headroom for QEMU itself
    const haveMb = Math.max(0, Math.round(budget.bytes / 1024 / 1024));
    return {
      ok: false,
      error: `Not enough free memory to start this VM: it needs ${Math.round(wantBytes / 1024 / 1024)} MB (+64 MB QEMU overhead) but only ${haveMb} MB is available — limited by the ${budget.limitedBy}. The physical host may have much more RAM, but this process runs inside a container/cgroup cap. Fix: raise the container memory limit (Proxmox LXC: Options > Memory; Docker: --memory), or set the VM's RAM lower.`,
    };
  }
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
  const pidFile = path.join(dir, 'qemu.pid');
  // Clear any stale pid from a previous run so the checks below are truthful.
  try { fs.unlinkSync(pidFile); } catch (e) {}

  let child;
  try {
    child = spawn('qemu-system-x86_64', args, { stdio: ['ignore', logFile, logFile] });
  } catch (e) {
    try { fs.closeSync(logFile); } catch (_) {}
    return { ok: false, error: 'qemu spawn failed: ' + e.message + '. Is qemu-system-x86_64 installed?' };
  }
  child.on('error', (e) => {
    try { fs.closeSync(logFile); } catch (_) {}
    console.error('[qemu] spawn error:', e.message);
  });
  child.on('exit', () => {
    try { fs.closeSync(logFile); } catch (e) {}
  });

  // QEMU runs with -daemonize: the launcher parent exits immediately after
  // the real daemon forks. Wait for the pidfile to appear, then verify that
  // daemon is actually alive, and capture stderr if it never showed up.
  const DEADLINE = Date.now() + 5000;
  let daemonPid = null;
  while (Date.now() < DEADLINE) {
    try {
      const txt = fs.readFileSync(pidFile, 'utf8').trim();
      daemonPid = parseInt(txt, 10);
      if (daemonPid > 0) break;
    } catch (e) {}
    if (child.exitCode !== null && child.exitCode !== undefined && child.exitCode !== 0) {
      // Launcher failed hard (bad args, missing binary) — no daemon will ever appear.
      break;
    }
    execSync('sleep 0.15', { stdio: 'ignore' });
  }

  let alive = false;
  if (daemonPid > 0) {
    // Re-check twice: a daemon can fail right after writing its pidfile.
    for (let i = 0; i < 2; i++) {
      try { process.kill(daemonPid, 0); alive = true; } catch (e) { alive = false; }
      if (!alive) break;
      execSync('sleep 0.3', { stdio: 'ignore' });
    }
  }

  if (!alive) {
    let tail = '';
    try {
      tail = fs.readFileSync(path.join(dir, 'qemu.log'), 'utf8').split('\n').slice(-12).join('\n').trim();
    } catch (e) {}
    try { fs.unlinkSync(pidFile); } catch (e) {}
    return {
      ok: false,
      error: 'QEMU failed to start. ' + (tail ? 'Last QEMU output:\n' + tail : 'No output captured (is qemu-system-x86_64 installed? On containers without /dev/kvm set NO_KVM=1 in the agent .env).'),
    };
  }

  vm.updated_at = now();
  state.upsertVm(vm);
  return { ok: true, pid: daemonPid };
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
  const booleans = ['start_on_boot', 'gui_mode', 'ballooning', 'secure_boot', 'tpm', 'install_guest_agent', 'enable_monitoring', 'enable_backups'];
  const jsons = {
    port_forwards: (v) => (Array.isArray(v) ? JSON.stringify(v) : v),
    additional_disks: (v) => (Array.isArray(v) ? JSON.stringify(v) : v),
    cloudinit_packages: (v) => (Array.isArray(v) ? JSON.stringify(v) : v),
    cloudinit_commands: (v) => (Array.isArray(v) ? JSON.stringify(v) : v),
    cloudinit_files: (v) => (Array.isArray(v) ? JSON.stringify(v) : v),
  };
  const ints = ['memory', 'cpus', 'cpu_sockets', 'cores_per_socket', 'threads_per_core', 'cpu_units', 'cpu_limit', 'mem_min', 'mem_max', 'memory_hotplug', 'nic_count'];
  const fields = ['name', 'hostname', 'username', 'password', 'memory', 'cpus', 'disk_size', 'gui_mode', 'port_forwards', 'start_on_boot', 'startup_command', 'notes',
    'description', 'tag', 'region', 'vmid', 'cpu_sockets', 'cores_per_socket', 'threads_per_core', 'cpu_model', 'cpu_units', 'cpu_limit', 'mem_min', 'mem_max',
    'ballooning', 'memory_hotplug', 'machine_type', 'firmware', 'secure_boot', 'tpm', 'boot_order', 'nic_model', 'nic_count', 'storage_pool', 'disk_format',
    'additional_disks', 'cloudinit_userdata', 'cloudinit_packages', 'cloudinit_commands', 'cloudinit_files', 'startup_script', 'install_guest_agent',
    'enable_monitoring', 'enable_backups', 'backup_schedule', 'timezone', 'locale', 'advanced'];
  for (const f of fields) {
    if (data[f] !== undefined) {
      if (jsons[f]) vm[f] = jsons[f](data[f]);
      else if (booleans.includes(f)) vm[f] = data[f] ? 1 : 0;
      else if (ints.includes(f)) vm[f] = parseInt(data[f], 10) || vm[f];
      else vm[f] = data[f];
    }
  }
  vm.updated_at = now();
  state.upsertVm(vm);
  const needSeed = ['hostname', 'username', 'password', 'timezone', 'locale', 'cloudinit_packages', 'cloudinit_commands', 'cloudinit_files', 'cloudinit_userdata', 'startup_script'].some((f) => data[f] !== undefined);
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

  // Also read the real host hardware (visible via /proc/meminfo inside a
  // container) vs the container's cgroup cap. In a container hostMem is the
  // physical RAM; totalMem here is the capped view. We report BOTH so the
  // panel isn't confusing about why a 180GB box only lets VMs use 16GB.
  let hostTotalMb = totalMem / 1024 / 1024;
  let hostFreeMb = freeMem / 1024 / 1024;
  let cgroupLimitMb = null;
  try {
    const mi = fs.readFileSync('/proc/meminfo', 'utf8');
    const m = mi.match(/MemTotal:\s+(\d+)\s+kB/);
    const f = mi.match(/MemAvailable:\s+(\d+)\s+kB/) || mi.match(/MemFree:\s+(\d+)\s+kB/);
    if (m) hostTotalMb = parseInt(m[1], 10) / 1024 / 1024;
    if (f) hostFreeMb = parseInt(f[1], 10) / 1024 / 1024;
  } catch (e) {}
  try {
    const max = parseInt(fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim(), 10);
    if (Number.isFinite(max) && max > 0 && max < os.totalmem()) cgroupLimitMb = max / 1024 / 1024;
  } catch (e) {}
  try {
    const lim = parseInt(fs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim(), 10);
    if (Number.isFinite(lim) && lim > 0 && lim < os.totalmem()) cgroupLimitMb = Math.min(cgroupLimitMb || Infinity, lim / 1024 / 1024);
  } catch (e) {}

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
    memory: { total_mb: Math.round(totalMem / 1024 / 1024), used_mb: Math.round(usedMem / 1024 / 1024), free_mb: Math.round(freeMem / 1024 / 1024), percent: memPct, host_total_mb: Math.round(hostTotalMb), host_free_mb: Math.round(hostFreeMb), cgroup_limit_mb: cgroupLimitMb ? Math.round(cgroupLimitMb) : null, container_capped: !!cgroupLimitMb },
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

const AGENT_ROOT = path.resolve(__dirname, '..');
const UPDATE_TMP = path.join(os.tmpdir(), 'venlix-node-update');

// Pull the latest node-agent code from the panel repo, reinstall deps, then
// restart the systemd service (`venlix-node`) in the background so this HTTP
// request can return a result before the process is recycled.
function updateAgent({ repo, branch, log }) {
  log = log || (() => {});
  if (!process.getuid || process.getuid() !== 0) {
    log('update requires root (agent runs as root systemd service)');
    throw new Error('Agent must be root to self-update');
  }
  // 1. Shallow-clone only the file tree we need (cheap GET of the repo head).
  fs.rmSync(UPDATE_TMP, { recursive: true, force: true });
  const clone = spawnSync('git', ['clone', '--depth', '1', '--branch', branch, '--single-branch', repo, UPDATE_TMP], { encoding: 'utf8' });
  if (clone.status !== 0) {
    const msg = (clone.stderr || '').split('\n').filter(Boolean).pop() || 'git clone failed';
    log('clone failed: ' + msg);
    throw new Error('git clone failed: ' + msg);
  }
  const srcAgent = path.join(UPDATE_TMP, 'node-agent');
  if (!fs.existsSync(srcAgent)) {
    log('node-agent/ folder not found in repo head');
    fs.rmSync(UPDATE_TMP, { recursive: true, force: true });
    throw new Error('node-agent folder not found in repo head');
  }
  // 2. Copy fresh files over the installed agent (preserve .env and data).
  const entries = fs.readdirSync(srcAgent);
  for (const ent of entries) {
    if (ent === '.env' || ent === 'data') continue;
    fs.rmSync(path.join(AGENT_ROOT, ent), { recursive: true, force: true });
    fs.cpSync(path.join(srcAgent, ent), path.join(AGENT_ROOT, ent), { recursive: true });
  }
  // 3. Reinstall dependencies.
  const npm = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: AGENT_ROOT, encoding: 'utf8' });
  if (npm.status !== 0) {
    log('npm install failed: ' + (npm.stderr || '').split('\n').filter(Boolean).pop());
    throw new Error('npm install failed after update');
  }
  // 4. Restart the service in background.
  const child = spawn('systemctl', ['restart', 'venlix-node'], { detached: true, stdio: 'ignore' });
  child.unref();
  log('update complete; restarting venlix-node service');
  return { ok: true, message: 'Agent updated and restarting' };
}

// ---------------------------------------------------------------------------
// In-guest execution via the vpanel guest agent (POST /exec on the VM's agent
// port, forwarded from host to guest:9090). Requires the VM to be running and
// the guest agent token.
// ---------------------------------------------------------------------------
function execInGuest(vm, cmd, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    if (!vm.agent_port) return reject(new Error('VM has no agent port assigned'));
    if (!vm.agent_token) return reject(new Error('VM has no guest agent token'));
    const body = JSON.stringify({ cmd: String(cmd), timeout: Math.max(5, Math.floor(timeoutMs / 1000)) });
    const req = http.request(
      {
        host: '127.0.0.1',
        port: vm.agent_port,
        path: '/exec',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Authorization': 'Bearer ' + vm.agent_token,
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch (e) { parsed = null; }
          if (res.statusCode >= 400) {
            return reject(new Error((parsed && parsed.error) || ('Guest agent error ' + res.statusCode)));
          }
          resolve(parsed || {});
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Guest agent timed out')));
    req.on('error', (e) => reject(e));
    req.end(body);
  });
}

// ---------------------------------------------------------------------------
// tmate: run the tmate installer + a fresh session in the guest, read back the
// generated "ssh <random>@tmate.io" server address. Requires internet inside
// the guest (tmate connects out). Stores the address on the vm so the panel can
// read it later.
// ---------------------------------------------------------------------------
async function getTmateSsh(vm) {
  if (!isRunning(vm)) throw new Error('VM must be running to reach the tmate session');
  const script = [
    'export DEBIAN_FRONTEND=noninteractive',
    'command -v tmux >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq tmux) >/dev/null 2>&1 || true',
    'command -v tmate >/dev/null 2>&1 || (apt-get install -y -qq tmate) >/dev/null 2>&1 || true',
    'rm -f /tmp/tmate.sock 2>/dev/null || true',
    'tmux kill-session -t vpanel-tmate 2>/dev/null || true',
    'tmate -S /tmp/tmate.sock new-session -d -s vpanel-tmate 2>/dev/null || true',
    'for i in $(seq 1 45); do [ -S /tmp/tmate.sock ] && break; sleep 1; done',
    'tmate -S /tmp/tmate.sock wait tmate-ready 2>/dev/null || true',
    "tmate -S /tmp/tmate.sock display -p '#{tmate_ssh}' 2>/dev/null || true",
    'rm -f /tmp/tmate_addr 2>/dev/null || true',
    "tmate -S /tmp/tmate.sock display -p '#{tmate_ssh}' >/tmp/tmate_addr 2>/dev/null || true",
    'cat /tmp/tmate_addr 2>/dev/null || true',
  ].join('\n');
  // The guest agent / SSH may not be up yet right after boot: retry up to ~3 min.
  const deadline = Date.now() + 3 * 60 * 1000;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const r = await execInGuest(vm, script, 180000);
      const out = String((r && r.stdout) || '').trim();
      const m = out.match(/\b([a-z0-9]+)\@tmate\.io\b/i);
      if (!m) throw new Error('tmate did not return an SSH address yet' + (out ? ' (guest output: ' + out.slice(-120) + ')' : ''));
      if (!vm.tmate_ssh || vm.tmate_ssh !== m[1] + '@tmate.io') {
        vm.tmate_ssh = m[1] + '@tmate.io';
        state.upsertVm(vm);
      }
      return vm.tmate_ssh;
    } catch (e) {
      lastErr = e;
      // "no agent port/token" style errors will not fix themselves with retries
      if (/no agent port|no guest agent token/i.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
  throw new Error('Guest did not become reachable in 3 minutes (still booting / no internet / guest agent missing). Last error: ' + (lastErr ? lastErr.message : 'timeout'));
}

async function regenerateTmate(vm) {
  await stopVm(vm, true).catch(() => {});
  await startVm(vm);
  await new Promise((r) => setTimeout(r, 30000));
  return getTmateSsh(vm);
}

// ---------------------------------------------------------------------------
// Reinstall a VM from an OS template. Optionally switch to a different template
// (os is the template name, e.g. "Ubuntu 22.04"). Wipes the current disk and
// reprovisions from the template image, reapplying cloud-init.
// ---------------------------------------------------------------------------
async function reinstallVm(vm, { os } = {}) {
  const osList = state.osList();
  let entry = null;
  if (os) {
    entry = osList.find((o) => o[0] === os);
    if (!entry) throw new Error('Unknown OS template: ' + os);
  } else {
    entry = osList.find((o) => o[0] === vm.os_name) || osList[0] || [];
  }
  await stopVm(vm, true).catch(() => {});

  if (vm.img_file && fs.existsSync(vm.img_file)) {
    try { fs.unlinkSync(vm.img_file); } catch (e) {}
  }
  if (vm.seed_file && fs.existsSync(vm.seed_file)) {
    try { fs.unlinkSync(vm.seed_file); } catch (e) {}
  }

  vm.os_name = String(entry[0] || vm.os_name);
  vm.os_type = String(entry[1] || '');
  vm.codename = String(entry[2] || '');
  vm.img_url = String(entry[3] || vm.img_url);
  vm.username = String(vm.username || entry[4] || 'root').toLowerCase();
  vm.tmate_ssh = '';
  vm.updated_at = now();
  state.upsertVm(vm);

  prepareImage(vm);
  await startVm(vm);
  return { ok: true, vm };
}


module.exports = {
  ensureDirs, VM_DIR, createVm, prepareImage, startVm, stopVm, restartVm, removeVm, updateVm,
  resizeDisk, bootLog, clearBootLog, liveStats, getVm: state.getVm,
  hostStats, startOnBootAll, usage, hasKvm, updateAgent,
  isRunning, statusOf, allVms: state.allVms, getHostStatsOnce: getPublicIp,
  reinstallVm, getTmateSsh, regenerateTmate,
};
