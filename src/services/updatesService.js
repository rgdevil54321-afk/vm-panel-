const { execFile } = require('child_process');
const path = require('path');
const config = require('../lib/config');

const ROOT = config.root;

function runGit(args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: ROOT, timeout: 60000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: (stderr || err.message || '').trim().slice(0, 500), output: String(stdout || '').trim() });
      resolve({ ok: true, output: String(stdout || '').trim() });
    });
  });
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
  return {
    ok: !!sha,
    sha,
    branch,
    date,
    message,
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

async function updateNow(restart = true) {
  const pull = await runGit(['pull', '--ff-only', 'origin']);
  if (!pull.ok) return { ok: false, message: 'Pull failed: ' + pull.error, output: pull.output };
  if (restart && process.env.PM2_HOME) {
    await new Promise((resolve) => {
      execFile(process.platform === 'win32' ? 'pm2' : 'bash',
        process.platform === 'win32' ? ['restart', 'vpanel'] : ['-lc', 'pm2 restart vpanel --update-env'],
        { cwd: ROOT, timeout: 30000 }, () => resolve());
    });
  }
  return { ok: true, message: 'Updated successfully.', output: pull.output };
}

async function rollback() {
  const log = await gitLog();
  if (!log || log.length < 2) return { ok: false, message: 'No previous commit to roll back to.' };
  const prev = log[1].sha;
  const checkout = await runGit(['checkout', prev]);
  if (!checkout.ok) return { ok: false, message: 'Checkout failed: ' + checkout.error };
  if (process.env.PM2_HOME) {
    await new Promise((resolve) => {
      execFile(process.platform === 'win32' ? 'pm2' : 'bash',
        process.platform === 'win32' ? ['restart', 'vpanel'] : ['-lc', 'pm2 restart vpanel --update-env'],
        { cwd: ROOT, timeout: 30000 }, () => resolve());
    });
  }
  return { ok: true, message: 'Rolled back to ' + prev + '.', output: checkout.output };
}

module.exports = { gitCurrent, gitLog, fetchUpdates, statusAhead, updateNow, rollback };