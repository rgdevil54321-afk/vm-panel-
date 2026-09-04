'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const qemu = require('./lib/qemu');
const state = require('./lib/state');

// minimal .env loader (zero external deps - built-in modules only)
(function loadEnv() {
  const envPath = path.resolve(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) {
      let v = m[2].replace(/^['"]|['"]$/g, '').trim();
      process.env[m[1]] = v;
    }
  }
})();

if (process.env.AGENT_NODE_NAME) {
  try { state.setNodeMeta({ name: process.env.AGENT_NODE_NAME }); } catch (e) {}
}
if (process.env.AGENT_JOIN_CODE && !state.joinCode()) {
  try { state.setJoinCode(process.env.AGENT_JOIN_CODE); } catch (e) {}
}

const PORT = parseInt(process.env.AGENT_PORT || '3005', 10);
const TOKEN = process.env.AGENT_TOKEN || '';
const HOST = process.env.AGENT_HOST || '0.0.0.0';

qemu.ensureDirs();

function serializeVm(vm) {
  if (!vm) return null;
  let forwards = [];
  try { forwards = JSON.parse(vm.port_forwards || '[]'); } catch (e) {}
  const out = {
    ...vm,
    port_forwards: forwards,
    gui_mode: !!vm.gui_mode,
    start_on_boot: !!vm.start_on_boot,
    status: qemu.isRunning(vm) ? 'running' : 'stopped',
    running: qemu.isRunning(vm),
  };
  delete out.agent_token;
  delete out.password;
  return out;
}

function readBody(req, limit = 300 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

function auth(req) {
  if (!TOKEN) return false;
  const h = req.headers['authorization'] || '';
  const provided = h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-agent-token'] || '');
  if (!provided) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(TOKEN));
}

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  const method = req.method.toUpperCase();
  const p = u.pathname.replace(/\/+$/, '') || '/';

  // ---- pre-auth: health probe (no secrets exposed) ----
  if (method === 'GET' && p === '/health') {
    return json(res, 200, { ok: true, agent: 'venlix-node', vms: state.get().vms.length, ts: Date.now() });
  }

  // ---- pre-auth: node onboarding via join key ----
  if (method === 'POST' && p === '/join') {
    try {
      const body = await readBody(req, 1 * 1024 * 1024);
      const data = JSON.parse(body.toString() || '{}');
      const givenCode = String(data.code || '').trim();
      const currentToken = process.env.AGENT_TOKEN || data.token || '';
      if (!givenCode) return json(res, 400, { ok: false, error: 'Join code is required' });
      if (state.joinCode() && givenCode !== state.joinCode()) {
        return json(res, 401, { ok: false, error: 'Invalid join code' });
      }
      // A claimed node (joinCode consumed/empty) may only be re-keyed if the
      // caller is already an authenticated agent (passed above auth normally).
      if (!state.joinCode() && !auth(req)) {
        return json(res, 401, { ok: false, error: 'Node already claimed; use an authenticated token to re-key' });
      }
      const tokenToStore = String(data.token || '').trim() || currentToken;
      if (!tokenToStore) return json(res, 400, { ok: false, error: 'A new agent token is required' });
      // Persist the new token into .env (preserving all other AGENT_* vars)
      const envPath = path.join(__dirname, '.env');
      let env = '';
      try { env = fs.readFileSync(envPath, 'utf8'); } catch (e) {}
      env = env.split('\n').filter((l) => !/^AGENT_TOKEN=/.test(l)).join('\n');
      if (env && !env.endsWith('\n')) env += '\n';
      env += 'AGENT_TOKEN=' + tokenToStore + '\n';
      fs.writeFileSync(envPath, env, 'utf8');
      // Consume the join code so it cannot be used again.
      state.setJoinCode('');
      const s = state.get();
      const reply = { ok: true, node: { name: s.name, location: s.location } };
      json(res, 200, reply);
      // Restart so the process picks up the new token (exit 1 -> systemd on-failure restart).
      setTimeout(() => process.exit(1), 800);
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  if (!auth(req)) return json(res, 401, { ok: false, error: 'Unauthorized' });

  try {
    // ---- meta / status ----
    if (method === 'GET' && p === '/ping') {
      return json(res, 200, { ok: true, agent: 'venlix-node', version: 1 });
    }
    if (method === 'GET' && p === '/stats') {
      const s = qemu.hostStats();
      s.ip = qemu.getHostStatsOnce();
      return json(res, 200, { ok: true, stats: s });
    }
    if (method === 'GET' && p === '/usage') {
      return json(res, 200, { ok: true, usage: qemu.usage() });
    }
    if (method === 'GET' && p === '/os') {
      return json(res, 200, { ok: true, os_list: state.osList() });
    }
    if (method === 'POST' && p === '/os') {
      const body = await readBody(req);
      const data = JSON.parse(body.toString() || '{}');
      if (Array.isArray(data.os_list)) state.setOsList(data.os_list);
      return json(res, 200, { ok: true });
    }
    if (method === 'POST' && p === '/meta') {
      const body = await readBody(req);
      const data = JSON.parse(body.toString() || '{}');
      const s = state.setNodeMeta({ name: data.name, location: data.location });
      return json(res, 200, { ok: true, node: { id: s.nodeId, name: s.name, location: s.location } });
    }
    if (method === 'POST' && p === '/update') {
      const body = await readBody(req, 1 * 1024 * 1024);
      const data = JSON.parse(body.toString() || '{}');
      const repo = data.repo || process.env.AGENT_UPDATE_REPO || 'https://github.com/rgdevil54321-afk/vm-panel-.git';
      const branch = data.branch || process.env.AGENT_UPDATE_BRANCH || 'main';
      qemu.updateAgent({ repo, branch, log: (m) => process.stderr.write('[venlix-update] ' + m + '\n') });
      return json(res, 200, { ok: true, message: 'Update started on node' });
    }

    // ---- VM collection ----
    if (method === 'GET' && p === '/vms') {
      const vms = state.allVms().map(serializeVm);
      return json(res, 200, { ok: true, vms });
    }
    if (method === 'POST' && p === '/vms') {
      const body = await readBody(req);
      const data = JSON.parse(body.toString() || '{}');
      const osList = state.osList();
      const vm = await qemu.createVm({ data, osList });
      const created = state.getVm(vm.id);
      qemu.prepareImage(created);
      return json(res, 201, { ok: true, vm: serializeVm(state.getVm(vm.id)) });
    }

    // ---- VM by id ----
    const vmMatch = p.match(/^\/vms\/([^/]+)(\/.*)?$/);
    if (vmMatch) {
      const id = decodeURIComponent(vmMatch[1]);
      const sub = vmMatch[2] || '';
      const vm = state.getVm(id);
      if (!vm) return json(res, 404, { ok: false, error: 'VM not found' });

      if (method === 'GET' && sub === '') return json(res, 200, { ok: true, vm: serializeVm(vm) });
      if (method === 'DELETE' && sub === '') {
        qemu.removeVm(vm);
        return json(res, 200, { ok: true });
      }
      if (method === 'PATCH' && sub === '') {
        const body = await readBody(req);
        const data = JSON.parse(body.toString() || '{}');
        return json(res, 200, { ok: true, vm: serializeVm(qemu.updateVm(vm, data)) });
      }
      if (method === 'POST' && sub === '/start') {
        const result = qemu.startVm(vm);
        if (result && result.ok === false) return json(res, 500, { ok: false, error: result.error || 'QEMU failed to start' });
        return json(res, 200, { ok: true, result });
      }
      if (method === 'POST' && sub === '/stop') {
        const body = await readBody(req);
        let force = false;
        try { force = !!(JSON.parse(body.toString() || '{}').force); } catch (e) {}
        return json(res, 200, { ok: true, result: qemu.stopVm(vm, force) });
      }
      if (method === 'POST' && sub === '/restart') return json(res, 200, { ok: true, result: qemu.restartVm(vm) });
      if (method === 'POST' && sub === '/resize') {
        const body = await readBody(req);
        const data = JSON.parse(body.toString() || '{}');
        return json(res, 200, { ok: true, vm: serializeVm(qemu.resizeDisk(vm, data.disk_size)) });
      }
      if (method === 'GET' && sub === '/status') return json(res, 200, { ok: true, status: qemu.statusOf(vm), running: qemu.isRunning(vm) });
      if (method === 'GET' && sub === '/stats') return json(res, 200, { ok: true, stats: qemu.liveStats(vm) });
      if (method === 'GET' && sub === '/bootlog') return json(res, 200, { ok: true, log: qemu.bootLog(vm) });
      if (method === 'POST' && sub === '/bootlog/clear') return json(res, 200, qemu.clearBootLog(vm));

      if (method === 'POST' && sub === '/tmate') {
        try {
          const ssh = await qemu.getTmateSsh(vm);
          return json(res, 200, { ok: true, ssh });
        } catch (e) {
          return json(res, 502, { ok: false, error: e.message });
        }
      }
      if (method === 'POST' && sub === '/tmate/regen') {
        try {
          const ssh = await qemu.regenerateTmate(vm);
          return json(res, 200, { ok: true, ssh });
        } catch (e) {
          return json(res, 502, { ok: false, error: e.message });
        }
      }
      if (method === 'POST' && sub === '/reinstall') {
        const body = await readBody(req);
        let data = {};
        try { data = JSON.parse(body.toString() || '{}'); } catch (e) {}
        try {
          const r = await qemu.reinstallVm(vm, data);
          return json(res, 200, r);
        } catch (e) {
          return json(res, 502, { ok: false, error: e.message });
        }
      }

      return json(res, 404, { ok: false, error: 'Unknown VM endpoint' });
    }

    return json(res, 404, { ok: false, error: 'Not found' });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`[venlix-node] agent listening on ${HOST}:${PORT}\n`);
});

process.on('SIGINT', () => {
  process.stdout.write('[venlix-node] shutting down\n');
  process.exit(0);
});

process.on('uncaughtException', (e) => {
  process.stderr.write('[venlix-node] uncaught: ' + (e.stack || e.message) + '\n');
});

setTimeout(() => qemu.startOnBootAll(), 3000);
