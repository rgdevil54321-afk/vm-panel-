const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('../lib/logger');

// Fallback terminal: when the panel console cannot reach a guest over SSH,
// generate an sshx (https://sshx.io) share link that opens the SAME SSH
// session in the browser. The sshx client is end-to-end encrypted, so the
// hosted relay only ever sees ciphertext; the link fragment carries the key.
//
// Flow: write a tiny wrapper script that execs ssh (with sshpass when the
// host has it, so the user lands directly in the guest shell), then run
// `sshx --shell <wrapper>` and capture the printed link.

const SESSION_DIR = path.join(__dirname, '..', '..', 'storage', 'sshx');
const START_TIMEOUT_MS = 45000;

const sessions = new Map(); // vmId -> { url, child, wrapper, sshpass, startedAt }
let binPath = null;
let installTried = false;
let sshpassFound = null; // null = not probed yet

// The wrapper scripts written by writeWrapper embed the guest's root password in
// an `export SSHPASS=...` line, so they are credentials on disk. Every session
// removes its own on exit, but a hard kill (SIGKILL, OOM, power loss) leaves them
// behind. Sweep the directory on startup so a leaked password never survives a
// panel restart.
function sweepStaleWrappers() {
  try {
    if (!fs.existsSync(SESSION_DIR)) return;
    for (const f of fs.readdirSync(SESSION_DIR)) {
      if (!f.endsWith('.sh')) continue;
      try { fs.unlinkSync(path.join(SESSION_DIR, f)); } catch (_) {}
    }
  } catch (_) {}
}
sweepStaleWrappers();

function run(cmd, args, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

const BIN_PROBES = [
  ['-c', 'command -v sshx'],
  ['-c', 'test -x /usr/local/bin/sshx && echo /usr/local/bin/sshx'],
  ['-c', 'test -x /usr/bin/sshx && echo /usr/bin/sshx'],
];

async function probeBinary() {
  for (const args of BIN_PROBES) {
    try {
      const { stdout } = await run('sh', args, { timeout: 5000 });
      const p = stdout.trim().split('\n').pop().trim();
      if (p) return p;
    } catch (_) {}
  }
  return null;
}

let lastInstallAttempt = 0;
const INSTALL_RETRY_MS = 5 * 60 * 1000; // do not hammer the installer

async function findBinary() {
  if (binPath) return binPath;
  let found = await probeBinary();
  // `installTried` used to latch forever: one failed download (DNS blip, proxy
  // hiccup) permanently disabled the fallback for the life of the process, so a
  // later attempt reported "not installed" even after the network recovered.
  // Retry, but at most once every INSTALL_RETRY_MS.
  if (!found && (!installTried || Date.now() - lastInstallAttempt > INSTALL_RETRY_MS)) {
    installTried = true;
    lastInstallAttempt = Date.now();
    logger.info('[sshx] binary not found, installing via https://sshx.io/get');
    try {
      await run('sh', ['-c', 'curl -sSf https://sshx.io/get | sh'], { timeout: 120000 });
    } catch (e) {
      logger.warn('[sshx] install failed: ' + ((e && e.message) || e));
    }
    found = await probeBinary();
  }
  if (!found) {
    throw new Error('sshx is not installed on the panel host and could not be downloaded. Install it manually: curl -sSf https://sshx.io/get | sh');
  }
  binPath = found;
  return found;
}

async function hasSshpass() {
  if (sshpassFound !== null) return sshpassFound;
  try {
    const { stdout } = await run('sh', ['-c', 'command -v sshpass'], { timeout: 5000 });
    sshpassFound = !!stdout.trim();
  } catch (_) {
    sshpassFound = false;
  }
  return sshpassFound;
}

function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// sshx execs the --shell value directly with execvp(shell, &[shell]): the string
// is a PROGRAM PATH, not a shell command, and NO extra argv is ever appended.
// So the wrapper must be an executable file with a shebang, at an absolute path
// with no spaces (a space would make execvp look for a file whose name literally
// contains the space). SESSION_DIR is derived from __dirname, so a panel checked
// out under a path with spaces would break this - refuse early with a clear
// message instead of letting sshx fail with a bare ENOENT.
function writeWrapper(vm, target, useSshpass) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  if (/\s/.test(SESSION_DIR)) {
    throw new Error('The panel directory path contains spaces ("' + SESSION_DIR + '"), which sshx cannot exec. Install the panel under a path without spaces to use the SSH link fallback.');
  }
  const file = path.join(SESSION_DIR, `vm${vm.id}-${Date.now()}.sh`);
  const sshCmd = 'ssh ' + [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'LogLevel=ERROR',
    '-o', 'ConnectTimeout=10',
    '-p', String(target.port),
    String(vm.username) + '@' + String(target.host),
  ].map(shq).join(' ');
  let body;
  if (useSshpass) {
    // SSHPASS is read from the environment by `sshpass -e`, so the password
    // never appears in the process list (it would with `sshpass -p <pw>`).
    body = 'export SSHPASS=' + shq(vm.password || '') + '\nexec sshpass -e ' + sshCmd + '\n';
  } else {
    body = 'exec ' + sshCmd + '\n';
  }
  const script = '#!/bin/sh\n# Generated by the Venlix panel - sshx fallback shell for VM #' + vm.id + '\n' + body;
  fs.writeFileSync(file, script, { mode: 0o700 });
  // writeFileSync honours the mode only when creating the file; make sure the
  // bit is actually set so execvp can run it on filesystems with odd umasks.
  try { fs.chmodSync(file, 0o700); } catch (_) {}
  return file;
}

function killChild(child) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM'); // detached: kill the whole group (sshx + ssh)
  } catch (_) {
    try { child.kill('SIGTERM'); } catch (_) {}
  }
}

// Resolves with { child, url } once sshx prints its link. The -q flag is
// tried first (prints only the URL); builds without it are retried once
// without the flag, and the link is parsed out of the normal banner too.
function spawnOnce(bin, name, wrapper, quiet) {
  return new Promise((resolve, reject) => {
    const args = quiet ? ['-q'] : [];
    args.push('--name', name, '--shell', wrapper);
    const child = spawn(bin, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killChild(child);
      const e = new Error('sshx did not print a link within ' + (START_TIMEOUT_MS / 1000) + 's (no route to sshx.io?)');
      e.timeout = true;
      reject(e);
    }, START_TIMEOUT_MS);
    const onData = (buf) => {
      if (settled) return;
      out += buf.toString();
      // Strip ANSI escape sequences first: the non-quiet greeting colours the
      // link, so a raw match would capture the trailing reset codes and hand the
      // user a URL with invisible junk appended.
      const clean = out.replace(/\x1b\[[0-9;]*m/g, '');
      const m = clean.match(/https?:\/\/[^\s"']+/);
      if (m) {
        settled = true;
        clearTimeout(timer);
        // Trim characters that can legitimately terminate a URL in prose but are
        // not part of it.
        resolve({ child, url: m[0].replace(/[.,)\]]+$/, '') });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('sshx exited with code ' + code + (out ? ': ' + out.slice(0, 300) : '')));
    });
  });
}

async function spawnSession(bin, vm, wrapper) {
  const name = 'venlix-' + String(vm.name || 'vm').replace(/[^\w.-]+/g, '-').slice(0, 40);
  try {
    return await spawnOnce(bin, name, wrapper, true);
  } catch (e) {
    // Only a usage/flag complaint is worth retrying without -q. Anything else
    // (no route to sshx.io, wrapper missing, bad credentials) fails the same way
    // without -q, so retrying would just make the user wait another 45 s.
    if (e && e.timeout) throw e;
    const looksLikeFlagError = /unexpected argument|unknown|unrecognized|usage|-q/i.test((e && e.message) || '');
    if (!looksLikeFlagError) throw e;
    logger.warn('[sshx] quiet mode failed, retrying without -q: ' + ((e && e.message) || e));
    return await spawnOnce(bin, name, wrapper, false);
  }
}

function cleanup(vmId) {
  const s = sessions.get(vmId);
  if (!s) return;
  sessions.delete(vmId);
  if (s.wrapper) {
    try { fs.unlinkSync(s.wrapper); } catch (_) {}
  }
}

async function start(vm) {
  if (!vm || !vm.id) throw new Error('Unknown server');
  const existing = sessions.get(vm.id);
  if (existing && existing.url && existing.child && existing.child.exitCode === null) {
    return { url: existing.url, reused: true, sshpass: existing.sshpass };
  }
  if (existing) cleanup(vm.id);

  if (!vm.username || !vm.ssh_port) throw new Error('This server has no SSH configuration.');
  const bin = await findBinary();
  const target = require('./sshService').sshTarget(vm);
  const useSshpass = (await hasSshpass()) && typeof vm.password === 'string' && vm.password.length > 0;
  const wrapper = writeWrapper(vm, target, useSshpass);
  try {
    const { child, url } = await spawnSession(bin, vm, wrapper);
    const session = { url, child, wrapper, sshpass: useSshpass, startedAt: Date.now() };
    sessions.set(vm.id, session);
    child.on('exit', () => {
      logger.info('[sshx] session for vm ' + vm.id + ' ended');
      cleanup(vm.id);
    });
    logger.info(`[sshx] vm ${vm.id} shared at ${url}`);
    return { url, reused: false, sshpass: useSshpass };
  } catch (e) {
    try { fs.unlinkSync(wrapper); } catch (_) {}
    throw e;
  }
}

function stop(vm) {
  const s = vm && vm.id ? sessions.get(vm.id) : null;
  if (!s) return false;
  killChild(s.child);
  cleanup(vm.id);
  return true;
}

function stopAll() {
  for (const id of Array.from(sessions.keys())) stop({ id });
}

module.exports = { start, stop, stopAll };
