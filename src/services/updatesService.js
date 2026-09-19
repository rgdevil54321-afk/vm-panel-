const { execFile } = require('child_process');
const path = require('path');
const config = require('../lib/config');

const ROOT = config.root;

function runGit(args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: ROOT, timeout: 120000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: (stderr || err.message || '').trim().slice(0, 500), output: String(stdout || '').trim() });
      resolve({ ok: true, output: String(stdout || '').trim() });
    });
  });
}

async function isGitRepo() {
  const res = await runGit(['rev-parse', '--is-inside-work-tree']);
  return res.ok;
}

async function gitCurrent() {
  const shaRes = await runGit(['rev-parse', '--short', 'HEAD']);
  const sha = shaRes.ok ? shaRes.output : null;
  const branchRes = await runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchRes.ok ? branchRes.output : 'unknown';
  const dateRes = await runGit(['show', '-s', '--format=%ci', 'HEAD']);
  const date = dateRes.ok ? dateRes.output : null;
  const msgRes = await runGit(['log', '-1', '--format=%s']);
  const message = msgRes.ok ? msgRes.output : null;
  const dirty = await runGit(['status', '--porcelain']);
  return {
    ok: !!sha,
    sha,
    branch,
    date,
    message,
    git: await isGitRepo(),
    dirty: !!(dirty.ok && dirty.output),
    dirtyCount: dirty.ok ? dirty.output.split('\n').filter(Boolean).length : 0,
    root: ROOT,
  };
}

async function gitLog() {
  const res = await runGit(['log', '--oneline', '-25']);
  if (!res.ok) return [];
  return res.output.split('\n').filter(Boolean).map((line) => {
    const parts = line.split(' ');
    return { sha: parts.shift(), message: parts.join(' ') };
  });
}

async function fetchUpdates() {
  const res = await runGit(['fetch', 'origin', '--prune']);
  return { ok: res.ok, message: res.ok ? 'Fetched updates from origin.' : res.error, output: res.output };
}

async function statusAhead() {
  const res = await runGit(['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
  if (!res.ok) return { behind: 0, ahead: 0, tracking: false };
  const [behind, ahead] = res.output.split(/\s+/).map((n) => parseInt(n, 10) || 0);
  return { behind, ahead, tracking: true };
}

// Detect the pm2 app name so restarting actually targets the right process.
async function detectPm2Names() {
  return new Promise((resolve) => {
    execFile('pm2', ['jlist'], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve({ hasPm2: false, names: [] });
      try {
        const list = JSON.parse(String(stdout || '[]'));
        const names = (Array.isArray(list) ? list : []).map((p) => p && p.name).filter(Boolean);
        resolve({ hasPm2: true, names });
      } catch (_) {
        resolve({ hasPm2: true, names: [] });
      }
    });
  });
}

function restartPm2() {
  return new Promise(async (resolve) => {
    const { hasPm2, names } = await detectPm2Names();
    const shell = process.platform === 'win32';
    const candidates = ['vpanel', 'venlix', 'vpanel-pro'].filter((n) => names.includes(n));
    if (hasPm2 && candidates.length) {
      execFile(shell ? 'pm2' : 'bash', shell ? ['restart', candidates[0]] : ['-lc', `pm2 restart ${candidates[0]} --update-env`], { cwd: ROOT, timeout: 30000 }, (e) => {
        resolve({ ok: !e, detail: `pm2 restart ${candidates[0]}` });
      });
    } else if (hasPm2) {
      execFile(shell ? 'pm2' : 'bash', shell ? ['restart', 'all'] : ['-lc', 'pm2 restart all --update-env'], { cwd: ROOT, timeout: 30000 }, (e) => {
        resolve({ ok: !e, detail: 'pm2 restart all' });
      });
    } else {
      resolve({ ok: false, detail: 'pm2 not available - restart the panel manually' });
    }
  });
}

async function updateNow(restart = true) {
  const git = await isGitRepo();
  if (!git) {
    return { ok: false, message: 'Not a git checkout. Install the panel with: git clone https://github.com/rgdevil54321-afk/vm-panel-.git ' + ROOT, output: '' };
  }
  const beforePkg = (await runGit(['show', 'HEAD:package.json'])).output;

  const fetch = await runGit(['fetch', 'origin', '--prune']);
  if (!fetch.ok) return { ok: false, message: 'Fetch failed: ' + fetch.error, output: fetch.output };

  const branch = (await gitCurrent()).branch || 'main';
  const merge = await runGit(['merge', '--ff-only', `origin/${branch}`]);
  if (!merge.ok) return { ok: false, message: 'Pull failed: ' + merge.error, output: merge.output };

  const afterPkg = (await runGit(['show', 'HEAD:package.json'])).output;
  const depsChanged = beforePkg !== afterPkg;
  const installStep = { ran: false, message: '' };
  if (depsChanged) {
    installStep.ran = true;
    await new Promise((resolve) => {
      execFile('npm', ['install', '--no-audit', '--no-fund', '--omit=dev'], { cwd: ROOT, timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 }, (e) => {
        installStep.message = e ? 'npm install failed: ' + String(e.message).slice(0, 300) : 'npm install completed';
        resolve();
      });
    });
  }

  let restartResult = { ok: false, detail: 'not requested' };
  if (restart) restartResult = await restartPm2();

  const logs = [];
  if (fetch.ok) logs.push('fetched origin');
  if (merge.ok) logs.push('merged ' + branch);
  if (installStep.ran) logs.push(installStep.message);
  if (restartResult.detail) logs.push(restartResult.detail);
  return { ok: true, message: 'Updated successfully.', output: merge.output, logs, restart: restartResult.ok, depsChanged, installStep };
}

async function rollback() {
  const log = await gitLog();
  if (!log || log.length < 2) return { ok: false, message: 'No previous commit to roll back to.' };
  const prev = log[1].sha;
  const checkout = await runGit(['checkout', prev]);
  if (!checkout.ok) return { ok: false, message: 'Checkout failed: ' + checkout.error };
  await new Promise((resolve) => {
    execFile('npm', ['install', '--no-audit', '--no-fund', '--omit=dev'], { cwd: ROOT, timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 }, () => resolve());
  });
  const restartResult = await restartPm2();
  return { ok: true, message: 'Rolled back to ' + prev + '.', output: checkout.output, restart: restartResult.ok };
}

// Push the freshly-updated code to all registered remote node agents.
async function updateAllNodes() {
  try {
    const nodeRegistry = require('./nodeRegistry');
    const result = await nodeRegistry.pushUpdateToAll();
    return { ok: true, message: 'Update dispatched to all nodes.', results: result };
  } catch (e) {
    return { ok: false, message: (e && e.message) || 'Failed to push update to nodes' };
  }
}

module.exports = { gitCurrent, gitLog, fetchUpdates, statusAhead, updateNow, rollback, updateAllNodes, isGitRepo, detectPm2Names };