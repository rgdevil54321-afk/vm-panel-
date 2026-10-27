'use strict';
// ============================================================================
// LXC container engine (panel-side, primary node).
//
// A system container is not a virtual machine: it shares the host kernel, so
//   * memory is a cgroup *limit* rather than a hard reservation, which is why
//     containers can be handed much larger RAM figures than a KVM guest can,
//   * there is no qemu process, no qcow2 disk, no cloud-init, no serial console.
//
// What replaces each QEMU concept:
//   qcow2 disk      -> a directory of unpacked distro rootfs (rootfs/)
//   qemu.pid        -> the lxc-* CLI reports state; we keep our own pid marker
//   boot.log/serial -> captured via `lxc-start -l ... -o ...` + journalctl
//   hostfwd ports   -> host networking, so sshd runs on its own port inside the
//                      container and the panel dials 127.0.0.1:<ssh_port>
//   cloud-init seed -> post-start bootstrap (password, sshd, vpanel-agent)
//
// Everything here shells out to the lxc CLI (lxc-create / lxc-start / ...) which
// is what ships with lxc / lxd-hosted classic lxc on Debian and Ubuntu.
// ============================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync, execFileSync } = require('child_process');
const config = require('../lib/config');
const { settings } = require('../lib/db');
const logger = require('../lib/logger');

const VM_DIR = config.vmDir;
// Templates are downloaded once and reused for every container of that distro.
const TEMPLATE_CACHE = path.join(VM_DIR, '.lxc-templates');
const TEMPLATE_SERVER = process.env.LXC_TEMPLATE_SERVER || 'https://images.linuxcontainers.org';

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
function run(bin, args, { timeout = 120000, input = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: e.message });
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { try { child.kill('SIGKILL'); } catch (_) {} }
    }, timeout);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => { done = true; clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + e.message }); });
    child.on('close', (code) => { done = true; clearTimeout(timer); resolve({ code, stdout, stderr }); });
    if (input != null) { try { child.stdin.end(input); } catch (_) {} }
    else { try { child.stdin.end(); } catch (_) {} }
  });
}

function hasBin(bin) {
  return spawnSync('which', [bin], { stdio: 'ignore' }).status === 0;
}

function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Total physical RAM in MB, used only to clamp a container's hard memory cap so
// it can never exceed what the node can actually back. Returns 0 when unknown.
function hostMemMb() {
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const m = txt.match(/^MemTotal:\s+(\d+)\s+kB/m);
    if (m) return Math.floor(parseInt(m[1], 10) / 1024);
  } catch (_) {}
  return 0;
}

// lxc-* can be missing on a host that was set up for VMs only. Every caller that
// needs it checks this first so the user gets an actionable message instead of
// an ENOENT.
function lxcAvailable() {
  return hasBin('lxc-create') && hasBin('lxc-start');
}

function containerDir(vm) {
  return path.join(VM_DIR, String(vm.id));
}

function now() {
  return new Date().toISOString();
}

function genAgentToken() {
  return crypto.randomBytes(24).toString('hex');
}

function genPassword() {
  return crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
}

// Name registered with the host's lxc. Prefixed so containers created by the
// panel never collide with unrelated ones on the same host, and derived from the
// row id so it is stable across restarts.
function containerName(vm) {
  return 'vp-' + vm.id + '-' + String(vm.name || 'ct').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
}

// The lxc CLI resolves `-n <name>` as `<lxcpath>/<name>/config`, defaulting to
// /var/lib/lxc. The panel keeps each container inside its VM directory instead,
// so EVERY lxc command must be told where to look with `-P <lxcpath>`.
// Omitting it is not a cosmetic problem: `lxc-start -n vp-1-test` with no -P
// looks in /var/lib/lxc/vp-1-test/config, finds nothing, and dies with
// "No container config specified" - exactly the failure this helper prevents.
function lxcPath(vm) {
  const dir = path.join(containerDir(vm), 'lxc');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Build the argv prefix every lxc CLI call needs so it sees the right path.
function lxcArgs(vm, args) {
  return ['-P', lxcPath(vm), ...args];
}

// ---------------------------------------------------------------------------
// OS / template catalog
// ---------------------------------------------------------------------------
// Tuple: [label, distro, release, arch]. Built from settings so admins only ever
// edit friendly names in Admin -> Settings.
function getLxcOsList() {
  let raw = settings.get('vm.os_list_lxc');
  try { if (typeof raw === 'string') raw = JSON.parse(raw); } catch (_) { raw = []; }
  return Array.isArray(raw) ? raw : [];
}

function findTemplateEntry(list, id) {
  return list.find((o) => o[0] === id || (o[1] + '/' + o[2]) === id) || null;
}

// images.linuxcontainers.org does NOT expose .../default/rootfs.tar.xz directly.
// Each release/arch publishes one directory per daily build, e.g.
//   /images/ubuntu/noble/amd64/default/20261018_07:42/rootfs.tar.xz
// and the newest build is simply the highest date-named subdirectory (there is
// no LATEST symlink on this mirror). Return the directory listing URL, then
// resolve the newest build inside it.
function baseDirUrl(entry) {
  const [, distro, release, arch] = entry;
  return `${TEMPLATE_SERVER}/images/${distro}/${release}/${arch || 'amd64'}/default/`;
}

// Pick the newest YYYYMMDD_HH:MM build directory out of an Apache listing.
function newestBuild(html) {
  const names = (html || '').match(/\d{8}_\d{2}:\d{2}/g) || [];
  if (!names.length) return null;
  // Lexicographic order works because the format is fixed-width.
  return names.sort()[names.length - 1];
}

// Resolve the concrete rootfs.tar.xz URL for a template, following the
// per-build directory layout above. Returns null if the listing has no builds.
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

// Download the rootfs tarball once, reuse it for every container of that distro.
async function ensureTemplate(entry, onProgress) {
  fs.mkdirSync(TEMPLATE_CACHE, { recursive: true });
  const dest = cachedTemplatePath(entry);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024 * 1024) return dest;
  const tmp = dest + '.part';
  const url = await templateUrl(entry);
  if (!url) {
    throw new Error('Could not find any published build for ' + entry[0] + ' at ' + baseDirUrl(entry) + ' — check the template entry (distro/release) in Admin → Settings.');
  }
  if (onProgress) onProgress('Downloading ' + entry[0] + ' rootfs...');
  // wget/curl both land here; wget is already a panel dependency for images.
  const bin = hasBin('wget') ? 'wget' : (hasBin('curl') ? 'curl' : null);
  if (!bin) throw new Error('Neither wget nor curl is installed - cannot download the container rootfs');
  const args = bin === 'wget'
    ? ['-q', '-O', tmp, url]
    : ['-sSL', '-o', tmp, url];
  const r = await run(bin, args, { timeout: 30 * 60 * 1000 });
  if (r.code !== 0 || !fs.existsSync(tmp) || fs.statSync(tmp).size < 1024 * 1024) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw new Error('Template download failed for ' + entry[0] + ': ' + (r.stderr || 'empty download').slice(0, 300));
  }
  fs.renameSync(tmp, dest);
  return dest;
}

// ---------------------------------------------------------------------------
// config generation
// ---------------------------------------------------------------------------
// Host networking: the container shares the host netns, so sshd inside it binds
// the host port directly. That is what keeps the console, the file manager and
// the guest agent working with exactly the same 127.0.0.1:<port> dial the QEMU
// path already uses - no bridge, no NAT, no hostfwd.
function writeConfig(vm) {
  const dir = containerDir(vm);
  // lxc CLI layout: <lxcpath>/<name>/config. lxcPath() creates the parent.
  const cfgDir = path.join(lxcPath(vm), containerName(vm));
  fs.mkdirSync(cfgDir, { recursive: true });
  // The config is regenerated below on every call, so an older install that put
  // it at the previous (non-CLI) location just leaves a stale file behind. Sweep
  // it so nothing downstream can read the wrong one.
  try {
    const stale = path.join(dir, 'lxc', 'config');
    if (fs.existsSync(stale)) fs.rmSync(stale, { force: true });
  } catch (_) {}
  const memMb = Math.max(64, parseInt(vm.memory, 10) || 512);
  const cpus = Math.max(1, parseInt(vm.cpus, 10) || 1);
  // Hard cap gets headroom over the advertised soft limit (see the comment on
  // the memory lines below), but never more than the host physically has.
  const memHardMb = Math.max(memMb, Math.min(Math.round(memMb * 1.5), hostMemMb() || (memMb * 2)));

  const lines = [
    '# Managed by Venlix - edits are overwritten on next start.',
    'lxc.uts.name = ' + containerName(vm),
    'lxc.arch = linux64',
    // Container root lives inside the VM directory so delete/backup/restore
    // reuse the same per-VM folder the QEMU path uses.
    'lxc.rootfs.path = dir:' + path.join(dir, 'rootfs'),
    // --- host networking -----------------------------------------------------
    'lxc.net.0.type = none',
    // --- isolation -----------------------------------------------------------
    // Unprivileged: root inside maps to an unprivileged host uid range, so a
    // container escape does not hand over the host. Requires a host subuid/subgid
    // range; we fall back to privileged below when that is unavailable.
    'lxc.apparmor.profile = generated',
    'lxc.cgroup2.devices.allow = c 1:3 rwm',   // /dev/null
    'lxc.cgroup2.devices.allow = c 1:5 rwm',   // /dev/zero
    'lxc.cgroup2.devices.allow = c 1:7 rwm',   // /dev/full
    'lxc.cgroup2.devices.allow = c 1:8 rwm',   // /dev/random
    'lxc.cgroup2.devices.allow = c 1:9 rwm',   // /dev/urandom
    'lxc.cgroup2.devices.allow = c 5:0 rwm',   // /dev/tty
    'lxc.cgroup2.devices.allow = c 5:1 rwm',   // /dev/console
    'lxc.cgroup2.devices.allow = c 5:2 rwm',   // /dev/ptmx
    'lxc.cgroup2.devices.allow = c 136:* rwm', // /dev/pts/*
    'lxc.cgroup2.devices.allow = c 10:200 rwm',// /dev/net/tun
    'lxc.mount.entry = /dev/net/tun dev/net/tun none bind,create=file',
    // --- resource limits -----------------------------------------------------
    // Container memory model. This is the whole reason LXC exists in the panel:
    // the advertised figure is a *soft* target, not a reservation, so many more
    // containers fit on one box than KVM guests.
    //
    //   memory.high  = the advertised RAM. Above this the kernel reclaims page
    //                  cache and aggressively throttles the cgroup, so the
    //                  customer feels pressure at their plan size.
    //   memory.max   = headroom above it. Setting memory.max == memory.high is a
    //                  trap: memory.current counts page cache, so an ordinary
    //                  file copy or package build would blow straight through the
    //                  limit and the OOM killer would kill the container's init.
    //                  A cap a little above the soft limit keeps the guarantee
    //                  ("this plan is N MB") while letting bursts breathe.
    // memory.max is capped at the host's real RAM so one container can never be
    // handed a limit the node cannot physically back.
    'lxc.cgroup2.memory.high = ' + memMb + 'M',
    'lxc.cgroup2.memory.max = ' + memHardMb + 'M',
    'lxc.cgroup2.cpu.max = ' + (cpus * 100000) + ' 100000',
  ];

  // Unprivileged mapping is only possible when the host has a subuid/subgid
  // range configured; otherwise lxc-start refuses to boot the container.
  const unpriv = canUseUnprivileged();
  if (unpriv) {
    lines.push('lxc.idmap = u 0 ' + unpriv.uidBase + ' 65536');
    lines.push('lxc.idmap = g 0 ' + unpriv.gidBase + ' 65536');
  } else {
    lines.push('# unprivileged mapping unavailable on this host - privileged fallback');
    lines.push('lxc.apparmor.profile = unconfined');
  }

  fs.writeFileSync(path.join(cfgDir, 'config'), lines.join('\n') + '\n', 'utf8');
  return path.join(cfgDir, 'config');
}

// Look at /etc/subuid and /etc/subgid for a range we can map into. Returns null
// when the host is not set up for unprivileged containers.
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
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------
// lxc-info is the authoritative source: the container may have been started or
// stopped outside the panel, so never trust the DB column for a local container.
function isRunning(vm) {
  if (!hasBin('lxc-info')) return false;
  const r = spawnSync('lxc-info', lxcArgs(vm, ['-n', containerName(vm), '-s']), { encoding: 'utf8', timeout: 10000 });
  if (r.status !== 0 || !r.stdout) return false;
  return /RUNNING/i.test(r.stdout);
}

function statusOf(vm) {
  return isRunning(vm) ? 'running' : 'stopped';
}

function rootfsReady(vm) {
  const root = path.join(containerDir(vm), 'rootfs');
  try {
    return fs.existsSync(path.join(root, 'etc')) || fs.existsSync(path.join(root, 'bin'));
  } catch (_) {
    return false;
  }
}

// Unpack the cached template into the container's rootfs directory. Runs once,
// at creation time, so the first `start` is instant.
async function unpackRootfs(vm, entry, onProgress) {
  const dir = containerDir(vm);
  const root = path.join(dir, 'rootfs');
  if (rootfsReady(vm)) return;
  const tarball = await ensureTemplate(entry, onProgress);
  fs.mkdirSync(root, { recursive: true });
  if (onProgress) onProgress('Unpacking rootfs...');
  // xz is not guaranteed; busybox tar handles .tar.xz on every modern distro.
  const r = await run('tar', ['-xpf', tarball, '-C', root], { timeout: 30 * 60 * 1000 });
  if (r.code !== 0) {
    throw new Error('Failed to unpack the rootfs: ' + (r.stderr || 'tar exited ' + r.code).slice(0, 300));
  }
  // Tiny template fixups: container templates assume the lxc tooling is present.
  writeContainerIdentity(vm, root);
}

// Write the hostname and a root password hash straight into the rootfs, so the
// container is reachable over SSH without cloud-init (which LXC has none of).
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
  // Root password hash: openssl is a hard dependency of the panel already, and
  // falling back to chpasswd happens in the bootstrap script.
  if (vm.password) {
    try {
      const r = spawnSync('openssl', ['passwd', '-6', String(vm.password)], { encoding: 'utf8', timeout: 15000 });
      if (r.status === 0 && r.stdout && r.stdout.trim()) {
        const shadow = path.join(root, 'etc/shadow');
        let txt = fs.readFileSync(shadow, 'utf8');
        txt = txt.replace(/^root:[^:]*:/m, 'root:' + r.stdout.trim() + ':');
        fs.writeFileSync(shadow, txt, 'utf8');
      }
    } catch (e) {
      logger.warn('[lxc] could not pre-set the root password for vm ' + vm.id + ': ' + e.message);
    }
  }
}

// Everything that has to happen once the container is up: sshd listening on the
// panel's port, the guest agent installed so the file manager works, the
// customer's chosen username created. All of it is best-effort - a container
// that boots but fails a nicety is still better than one that refuses to start.
async function bootstrap(vm) {
  const name = containerName(vm);
  const steps = [];

  // The distro templates ship without a configured sshd; enable and start it.
  steps.push(
    // Make sure the port matches what the panel dials.
    `sed -i 's/^#\\?Port .*/Port ${vm.ssh_port || 22}/' /etc/ssh/sshd_config 2>/dev/null || true`,
    // Permit root login with a password - this is a rented container, the
    // password is the credential the panel hands the customer.
    `sed -i 's/^#\\?PermitRootLogin .*/PermitRootLogin yes/' /etc/ssh/sshd_config 2>/dev/null || true`,
    `sed -i 's/^#\\?PasswordAuthentication .*/PasswordAuthentication yes/' /etc/ssh/sshd_config 2>/dev/null || true`,
    // Distros differ on the service manager; cover all three spellings.
    `(command -v systemctl >/dev/null && systemctl enable --now ssh 2>/dev/null) || (command -v systemctl >/dev/null && systemctl enable --now sshd 2>/dev/null) || (command -v rc-update >/dev/null && rc-update add sshd default && rc-service sshd start 2>/dev/null) || (/etc/init.d/sshd start 2>/dev/null) || true`,
    // Apply the password even when the rootfs pre-seed did not take.
    vm.password ? `echo 'root:${String(vm.password).replace(/'/g, "'\\''")}' | chpasswd 2>/dev/null || true` : '',
    // Customer username, when it is not the distro default.
    vm.username && vm.username !== 'root'
      ? `(id ${vm.username} >/dev/null 2>&1 || useradd -m -s /bin/bash ${vm.username} 2>/dev/null || adduser -D -s /bin/sh ${vm.username} 2>/dev/null) || true; echo '${vm.username}:${String(vm.password || 'root').replace(/'/g, "'\\''")}' | chpasswd 2>/dev/null || true`
      : '',
    // Guest agent: gives the panel the file manager, exec and read/write APIs.
    agentInstallScript(vm)
  ).filter(Boolean);

  const script = steps.join('\n');
  const r = await run('lxc-attach', lxcArgs(vm, ['-n', name, '--', '/bin/sh', '-c', script]), { timeout: 180000 });
  if (r.code !== 0) {
    logger.warn('[lxc] bootstrap for vm ' + vm.id + ' reported: ' + (r.stderr || r.stdout || 'exit ' + r.code).slice(0, 400));
  }
  return r;
}

// The same agent the QEMU guests run, fetched from the panel tree. Kept as a
// shell pipeline so the container needs nothing but curl/wget and python3.
function agentInstallScript(vm) {
  const token = vm.agent_token || '';
  const port = vm.agent_port || 9090;
  if (!token) return '';
  return [
    `mkdir -p /opt/vpanel`,
    `printf '%s' '${token}' > /etc/vpanel-agent.token`,
    `chmod 600 /etc/vpanel-agent.token`,
    // Prefer a copy already staged in the VM dir (panel ships it), fall back to
    // fetching from the repo so a fresh node works with no extra setup.
    `(cp /opt/vpanel/agent.py /opt/vpanel/vpanel-agent.py 2>/dev/null) || (command -v curl >/dev/null && curl -sSfL ${agentSourceUrl()} -o /opt/vpanel/vpanel-agent.py) || true`,
    `if [ -f /opt/vpanel/vpanel-agent.py ]; then VPANEL_AGENT_PORT=${port} nohup python3 /opt/vpanel/vpanel-agent.py >/var/log/vpanel-agent.log 2>&1 & fi`,
    `true`
  ].join('\n');
}

function agentSourceUrl() {
  const repo = process.env.VENLIX_REPO || 'https://raw.githubusercontent.com/rgdevil54321-afk/vm-panel-/main';
  return repo.replace(/\.git$/, '').replace(/\/$/, '') + '/scripts/vpanel-agent.py';
}

// Start a container. Mirrors vmService.start's contract: resolve to a small
// result object rather than throwing, so the route layer can report a reason.
async function start(vm) {
  if (!lxcAvailable()) {
    throw new Error('LXC is not installed on this node. Run: apt-get install -y lxc lxc-templates (or use a QEMU machine).');
  }
  if (!rootfsReady(vm)) {
    throw new Error('Container rootfs is missing. Reinstall this machine to recreate it.');
  }
  if (isRunning(vm)) return { ok: true, already: true };

  const dir = containerDir(vm);
  const cfgPath = writeConfig(vm);
  const logFile = path.join(dir, 'lxc-start.log');
  const name = containerName(vm);

  // Guard against a stale registration left by an unclean shutdown.
  try { spawnSync('lxc-stop', ['-f', cfgPath, '-n', name, '-k'], { stdio: 'ignore', timeout: 20000 }); } catch (_) {}
  try { spawnSync('lxc-stop', lxcArgs(vm, ['-n', name, '-k']), { stdio: 'ignore', timeout: 20000 }); } catch (_) {}
  try { spawnSync('lxc-stop', ['-n', name, '-k'], { stdio: 'ignore', timeout: 20000 }); } catch (_) {}

  // Prefer explicit config path (-f) to avoid lxcpath/name resolution issues
  let r = await run('lxc-start', ['-f', cfgPath, '-n', name, '-d', '-l', 'DEBUG', '-o', logFile], { timeout: 120000 });
  if (r.code !== 0) {
    r = await run('lxc-start', lxcArgs(vm, ['-n', name, '-d', '-l', 'DEBUG', '-o', logFile]), { timeout: 120000 });
  }
  if (r.code !== 0) {
    r = await run('lxc-start', ['-P', path.join(dir, 'lxc'), '-n', name, '-d', '-l', 'DEBUG', '-o', logFile], { timeout: 120000 });
  }
  if (r.code !== 0) {
    // Last resort: try without -n if config is self-describing
    r = await run('lxc-start', ['-f', cfgPath, '-d', '-l', 'DEBUG', '-o', logFile], { timeout: 120000 });
  }
  if (r.code !== 0) {
    const detail = readTail(logFile) || r.stderr || ('lxc-start exited ' + r.code);
    throw new Error('Container failed to start: ' + detail.slice(0, 400));
  }

  // Wait for the registered state, not just the process exit.
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (isRunning(vm)) break;
    await sleep(400);
  }
  if (!isRunning(vm)) {
    throw new Error('Container did not reach RUNNING in time. Last log: ' + (readTail(logFile) || 'none').slice(0, 300));
  }

  // sshd needs a moment even after the container is RUNNING.
  await waitForPort(vm.ssh_port, 15000);
  bootstrap(vm).catch((e) => logger.warn('[lxc] bootstrap error for vm ' + vm.id + ': ' + e.message));
  // Bootstrap is async; nudge sshd once more shortly after in case the first
  // attempt raced the container's init.
  setTimeout(() => { bootstrap(vm).catch(() => {}); }, 8000);
  return { ok: true };
}

function stop(vm, force = false) {
  const name = containerName(vm);
  if (!hasBin('lxc-stop')) return { ok: false, error: 'LXC is not installed on this node' };
  let cfgPath;
  try { cfgPath = writeConfig(vm); } catch (_) {}
  const args = ['-n', name];
  if (force) args.push('-k');       // SIGKILL
  let r = spawnSync('lxc-stop', lxcArgs(vm, args), { encoding: 'utf8', timeout: force ? 20000 : 60000 });
  if (r.status !== 0 && cfgPath) {
    try { r = spawnSync('lxc-stop', ['-f', cfgPath, ...args], { encoding: 'utf8', timeout: force ? 20000 : 60000 }); } catch (_) {}
  }
  if (r.status !== 0) {
    const err = String(r.stderr || '');
    // "not running" is a success as far as the panel is concerned.
    if (!/not running|does not exist|no such container/i.test(err)) {
      return { ok: false, error: err.slice(0, 300) || ('lxc-stop exited ' + r.status) };
    }
  }
  return { ok: true };
}

async function restart(vm) {
  await stop(vm, false);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && isRunning(vm)) await sleep(300);
  if (isRunning(vm)) await stop(vm, true);
  await sleep(500);
  return start(vm);
}

// Delete a container and its rootfs. `lxc-destroy` handles unregistering; the
// directory itself is removed by the caller along with the VM row.
function remove(vm) {
  const name = containerName(vm);
  try { if (isRunning(vm)) spawnSync('lxc-stop', lxcArgs(vm, ['-n', name, '-k']), { stdio: 'ignore', timeout: 20000 }); } catch (_) {}
  if (hasBin('lxc-destroy')) {
    const r = spawnSync('lxc-destroy', lxcArgs(vm, ['-n', name]), { encoding: 'utf8', timeout: 30000 });
    if (r.status !== 0 && !/does not exist|no such container/i.test(String(r.stderr || ''))) {
      logger.warn('[lxc] lxc-destroy for ' + name + ': ' + String(r.stderr || '').slice(0, 200));
    }
  }
}

// ---------------------------------------------------------------------------
// stats - read straight from the container's cgroup, which is exact rather than
// the ps-based estimate the QEMU path has to use.
// ---------------------------------------------------------------------------
function cgroupPath(vm) {
  // lxc puts each container under its own cgroup; the exact parent differs
  // between cgroup v1 and v2, so probe both.
  const name = containerName(vm);
  const candidates = [
    `/sys/fs/cgroup/lxc.payload.${name}`,
    `/sys/fs/cgroup/lxc/${name}`,
    `/sys/fs/cgroup/lxc.monitor.${name}`,
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return null;
}

function readInt(file) {
  try { const n = parseInt(fs.readFileSync(file, 'utf8').trim(), 10); return Number.isFinite(n) ? n : null; } catch (_) { return null; }
}

function liveStats(vm) {
  const out = { running: isRunning(vm), uptimeSeconds: null, memUsage: null, cpuUsage: null, diskActualUsage: null };
  const cg = cgroupPath(vm);
  if (cg) {
    const memCur = readInt(path.join(cg, 'memory.current'));
    if (memCur != null) out.memUsage = memCur;
    out.memoryLimit = readInt(path.join(cg, 'memory.max'));
  }
  // Disk: the rootfs is a real directory, du is the honest number.
  try {
    out.diskActualUsage = dirSize(path.join(containerDir(vm), 'rootfs'));
  } catch (_) {}
  // Uptime from the host's view of the container's init pid.
  const pid = containerInitPid(vm);
  if (pid) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const bootTime = parseFloat(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
      const startTicks = parseInt(stat.split(') ')[1].split(' ')[19], 10);
      const hz = 100; // USER_HZ is 100 on every supported platform
      out.uptimeSeconds = Math.max(0, Math.round(bootTime - startTicks / hz));
    } catch (_) {}
  }
  return out;
}

function containerInitPid(vm) {
  if (!hasBin('lxc-info')) return null;
  const r = spawnSync('lxc-info', lxcArgs(vm, ['-n', containerName(vm), '-p']), { encoding: 'utf8', timeout: 8000 });
  if (r.status !== 0 || !r.stdout) return null;
  const m = String(r.stdout).match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

// Recursive size without pulling in a dependency. Only used for the stats tile.
function dirSize(dir, seen = { bytes: 0 }) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return seen.bytes; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) { dirSize(p, seen); }
      else if (e.isFile()) { seen.bytes += fs.statSync(p).size; }
    } catch (_) {}
  }
  return seen.bytes;
}

// Network totals come from the container's own /proc/net/dev via attach, which is
// accurate for host networking regardless of which veth (if any) is involved.
async function netTotals(vm) {
  const r = await run('lxc-attach', lxcArgs(vm, ['-n', containerName(vm), '--', '/bin/sh', '-c', 'cat /proc/net/dev 2>/dev/null']), { timeout: 15000 });
  if (r.code !== 0) return { rx: 0, tx: 0 };
  let rx = 0;
  let tx = 0;
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^\s*([^\s:]+):\s*(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
    if (m && m[1] !== 'lo') { rx += parseInt(m[2], 10); tx += parseInt(m[3], 10); }
  }
  return { rx, tx };
}

// Boot output: lxc logs go to lxc-start.log plus the container's console. Stitch
// whatever exists so the boot log pane shows something useful.
function bootLog(vm) {
  const dir = containerDir(vm);
  const parts = [];
  for (const f of ['lxc-start.log', 'console.log']) {
    const p = path.join(dir, f);
    try { if (fs.existsSync(p)) parts.push(fs.readFileSync(p, 'utf8')); } catch (_) {}
  }
  return parts.join('\n');
}

function clearBootLog(vm) {
  const dir = containerDir(vm);
  for (const f of ['lxc-start.log', 'console.log']) {
    try { fs.truncateSync(path.join(dir, f), 0); } catch (_) {}
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// disk: the container's rootfs is a directory tree, so "disk size" is enforced
// by how much the filesystem allows rather than by a qcow2 allocation.
// ---------------------------------------------------------------------------
function resizeDisk(vm, newSize) {
  // Record the new limit; the rootfs is a directory on the node's filesystem.
  return { ok: true, disk_size: newSize };
}

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------
function readTail(file, bytes = 4000) {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - bytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch (_) {
    return '';
  }
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
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

// ---------------------------------------------------------------------------
// creation entry point, called by vmService.create
// ---------------------------------------------------------------------------
async function createContainer({ vm, entry, onProgress }) {
  if (!lxcAvailable()) {
    throw new Error('LXC is not installed on this node. Run: apt-get install -y lxc lxc-templates');
  }
  const dir = containerDir(vm);
  fs.mkdirSync(dir, { recursive: true });
  await unpackRootfs(vm, entry, onProgress);
  writeConfig(vm);
  return dir;
}

// Rebuild a container in place: destroy it, wipe the rootfs and unpack a fresh
// copy of the template. This is the LXC equivalent of a QEMU reinstall.
async function rebuildContainer({ vm, entry, onProgress }) {
  if (!lxcAvailable()) {
    throw new Error('LXC is not installed on this node. Run: apt-get install -y lxc lxc-templates');
  }
  remove(vm);
  const dir = containerDir(vm);
  try { fs.rmSync(path.join(dir, 'rootfs'), { recursive: true, force: true }); } catch (_) {}
  fs.mkdirSync(dir, { recursive: true });
  await unpackRootfs(vm, entry, onProgress);
  writeConfig(vm);
  return dir;
}

module.exports = {
  lxcAvailable,
  getLxcOsList,
  findTemplateEntry,
  templateUrl,
  baseDirUrl,
  containerName,
  containerDir,
  createContainer,
  rebuildContainer,
  unpackRootfs,
  ensureTemplate,
  writeConfig,
  rootfsReady,
  isRunning,
  statusOf,
  start,
  stop,
  restart,
  remove,
  liveStats,
  netTotals,
  bootLog,
  clearBootLog,
  resizeDisk,
  bootstrap,
  dirSize,
  genAgentToken,
  genPassword,
};
