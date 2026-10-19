'use strict';
const http = require('http');
const https = require('https');
const { db } = require('../lib/db');
const logger = require('../lib/logger');

// ============================================================
// Venlix Nodes - panel-side node registry & agent client
// ============================================================

let heartbeatTimer = null;
const STATS_CACHE = new Map(); // nodeId -> cached stats object
const CONN_CACHE = new Map();  // nodeId -> last error

function now() {
  return new Date().toISOString();
}

// ---------- DB access ----------
function allNodes() {
  return db.prepare('SELECT * FROM nodes ORDER BY id ASC').all();
}

function getNode(id) {
  return db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
}

function getNodeByHost(host) {
  return db.prepare('SELECT * FROM nodes WHERE host = ?').get(host);
}

function createNode({ name, host, port, agent_token, location }) {
  const existing = db.prepare('SELECT id FROM nodes WHERE host = ? AND port = ?').get(host, parseInt(port, 10) || 3005);
  if (existing) throw new Error('A node with this host and port already exists');
  const info = db.prepare(
    `INSERT INTO nodes (name, host, port, agent_token, location, status, last_seen_at, added_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'offline', NULL, ?, ?)`
  ).run(
    String(name || 'Node'),
    String(host),
    parseInt(port, 10) || 3005,
    String(agent_token || ''),
    String(location || ''),
    now(),
    now()
  );
  const id = Number(info.lastInsertRowid);
  probeNode(id, { force: true });
  return getNode(id);
}

function updateNode(id, data) {
  const node = getNode(id);
  if (!node) throw new Error('Node not found');
  const fields = ['name', 'host', 'port', 'agent_token', 'location', 'ram_overcommit_ratio', 'max_vm_memory_mb'];
  const set = [];
  const vals = {};
  for (const f of fields) {
    if (data[f] !== undefined && data[f] !== '') {
      set.push(`${f} = @${f}`);
      if (f === 'port') {
        vals[f] = parseInt(data[f], 10);
      } else if (f === 'ram_overcommit_ratio') {
        // Clamp to 1.0–50.0 and reject NaN/Infinity so a bad value cannot
        // silently disable enforcement or allow an absurd overcommit.
        let r = parseFloat(data[f]);
        if (!Number.isFinite(r)) r = 1.0;
        if (r < 1.0) r = 1.0;
        if (r > 50.0) r = 50.0;
        vals[f] = r;
      } else if (f === 'max_vm_memory_mb') {
        // Pinned VM RAM ceiling in MB. 0 = auto (physical minus panel reserve).
        // Reject negatives/NaN so a bad value cannot disable the safety cap.
        let v = parseInt(data[f], 10);
        if (!Number.isFinite(v) || v < 0) v = 0;
        vals[f] = v;
      } else {
        vals[f] = String(data[f]);
      }
    }
  }
  if (set.length) {
    set.push('updated_at = @updated_at');
    vals.updated_at = now();
    db.prepare(`UPDATE nodes SET ${set.join(', ')} WHERE id = @id`).run({ ...vals, id });
  }
  probeNode(id, { force: true });
  return getNode(id);
}

function deleteNode(id) {
  const node = getNode(id);
  if (!node) throw new Error('Node not found');
  if (node.id === 1) throw new Error('Cannot delete the local primary node');
  const vmCount = db.prepare('SELECT COUNT(*) c FROM vms WHERE node_id = ?').get(id).c;
  if (vmCount > 0) throw new Error(`Cannot delete node: it still hosts ${vmCount} VM(s)`);
  db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
  CONN_CACHE.delete(id);
  STATS_CACHE.delete(id);
  return { ok: true };
}

function nodeVmCount(nodeId) {
  return db.prepare('SELECT COUNT(*) c FROM vms WHERE node_id = ?').get(nodeId).c;
}

// ---------- Agent HTTP client ----------
function agentRequest(node, { method = 'GET', path = '/', headers = {}, body, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const isHttps = String(node.host).startsWith('https://');
    let hostname = String(node.host).replace(/^https?:\/\//, '');
    const port = node.port || 3005;
    // Local primary node: always connect via loopback regardless of stored host
    if (node.agent_token === 'local-primary-no-agent') hostname = '127.0.0.1';
    const mod = isHttps ? https : http;
    const outHeaders = {
      ...headers,
      Authorization: 'Bearer ' + (node.agent_token || ''),
    };
    if (body && !outHeaders['Content-Length']) {
      outHeaders['Content-Length'] = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body);
    }
    if (body && !outHeaders['Content-Type']) {
      outHeaders['Content-Type'] = 'application/json';
    }
    // Settle exactly once: a response that dies mid-stream never emits 'end',
    // which previously left the promise — and its caller — hanging forever.
    let settled = false;
    const settle = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const req = mod.request({
      hostname,
      port,
      method,
      path,
      timeout,
      headers: outHeaders,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => settle(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', (e) => settle(reject, e));
      res.on('close', () => settle(reject, new Error('Agent connection closed before response completed')));
    });
    req.on('timeout', () => req.destroy(new Error('Agent request timed out')));
    req.on('error', (e) => settle(reject, e));
    if (body) req.write(body);
    req.end();
  });
}

async function agentJson(node, opts) {
  const r = await agentRequest(node, opts);
  let parsed = null;
  try { parsed = JSON.parse(r.body.toString()); } catch (e) { parsed = null; }
  if (r.status >= 400) {
    const msg = parsed && parsed.error ? parsed.error : ('Agent error ' + r.status);
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return parsed || {};
}

// ---------- Capacity / probe ----------
const PROBING = new Set();     // probes currently in flight
const PROBE_FAILS = new Map(); // nodeId -> consecutive failures
const PROBE_UNTIL = new Map(); // nodeId -> earliest next attempt (backoff while down)

function markNode(id, status) {
  if (status === 'online') {
    db.prepare('UPDATE nodes SET status = ?, last_seen_at = ?, updated_at = ? WHERE id = ?')
      .run(status, now(), now(), id);
  } else {
    // last_seen_at is the last successful contact — never blank it on offline.
    db.prepare('UPDATE nodes SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
  }
}

async function fetchNodeStats(node) {
  const data = await agentJson(node, { path: '/stats' });
  const stats = data.stats;
  if (!stats) throw new Error('Missing stats in agent response');
  stats.node_id = node.id;
  stats.node_name = node.name;
  stats.host = node.host;
  stats.port = node.port;
  stats.location = node.location || stats.location || '';
  const diskTotalGb = parseFloat(stats.disk && stats.disk.total_gb) || 0;
  const memTotalMb = parseInt(stats.memory && stats.memory.total_mb, 10) || 0;
  const cpuCores = parseInt(stats.cpu && stats.cpu.cores_count, 10) || 0;
  db.prepare('UPDATE nodes SET capacity_cpus = ?, capacity_memory_mb = ?, capacity_disk_gb = ? WHERE id = ?')
    .run(cpuCores, memTotalMb, Math.round(diskTotalGb), node.id);
  stats.specs = {
    cpu_model: String(stats.cpu && (stats.cpu.model || 'Unknown')).slice(0, 80),
    cpu_cores: cpuCores,
    ram_total_gb: (memTotalMb / 1024).toFixed(0),
    disk_total_gb: String(diskTotalGb),
    platform: ((stats.os && (stats.os.platform || stats.os.type)) || 'unknown') + ' ' + ((stats.os && stats.os.arch) || ''),
    kvm: !!(stats.hypervisor && stats.hypervisor.kvm_support),
    qemu_installed: !!(stats.hypervisor && stats.hypervisor.qemu_installed),
    qemu_version: String((stats.hypervisor && stats.hypervisor.qemu_version) || ''),
  };
  return stats;
}

function probeNode(nodeId, { force = false } = {}) {
  // Heartbeat interval equals the request timeout, so probes can overlap and
  // race each other's status writes — only one at a time per node.
  if (PROBING.has(nodeId)) return;
  if (!force && Date.now() < (PROBE_UNTIL.get(nodeId) || 0)) return; // backoff for down nodes
  const node = getNode(nodeId);
  if (!node) return;
  PROBING.add(nodeId);
  fetchNodeStats(node)
    .then((stats) => {
      STATS_CACHE.set(nodeId, stats);
      CONN_CACHE.delete(nodeId); // clear the stale error so the UI stops showing it
      PROBE_FAILS.delete(nodeId);
      PROBE_UNTIL.delete(nodeId);
      markNode(nodeId, 'online');
    })
    .catch((e) => {
      CONN_CACHE.set(nodeId, e.message);
      const fails = (PROBE_FAILS.get(nodeId) || 0) + 1;
      PROBE_FAILS.set(nodeId, fails);
      PROBE_UNTIL.set(nodeId, Date.now() + Math.min(60000, 8000 * 2 ** (fails - 1)));
      markNode(nodeId, 'offline');
    })
    .finally(() => PROBING.delete(nodeId));
}

function startHeartbeat(intervalMs = 8000) {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  const tick = () => {
    for (const node of allNodes()) {
      if (!node.agent_token) continue;
      // Local primary node: probe via loopback, not the stored (possibly wrong) host
      probeNode(node.id);
    }
  };
  tick();
  heartbeatTimer = setInterval(tick, intervalMs);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ---------- VM routing (dispatch to the node that owns a VM) ----------
function nodeForVm(vm) {
  const node = getNode(vm.node_id);
  if (!node) throw new Error('No node owns this VM');
  return node;
}

async function createVmOnNode(node, payload) {
  // Sync the OS list so the node has the newest cloud-image catalog.
  try {
    const osList = require('./vmService').getOsList();
    if (Array.isArray(osList)) {
      await agentJson(node, { method: 'POST', path: '/os', body: JSON.stringify({ os_list: osList }) });
    }
  } catch (e) {
    logger.warn('[nodes] failed to sync os_list to node ' + node.id + ': ' + e.message);
  }
  return agentJson(node, {
    method: 'POST',
    path: '/vms',
    body: JSON.stringify(payload),
    timeout: 300000, // the agent downloads the base image synchronously; can take minutes
  });
}

async function startVmOnNode(node, vm) {
  // Agent-side start/stop block on pidfile and port-release waits, so the 8s
  // default aborted mid-work and reported false "start/stop failed" errors.
  return agentJson(node, { method: 'POST', path: `/vms/${vm.uuid}/start`, timeout: 60000 });
}
async function stopVmOnNode(node, vm, force) {
  return agentJson(node, { method: 'POST', path: `/vms/${vm.uuid}/stop`, body: JSON.stringify({ force: !!force }), timeout: 60000 });
}
async function restartVmOnNode(node, vm) {
  return agentJson(node, { method: 'POST', path: `/vms/${vm.uuid}/restart`, timeout: 60000 });
}
async function deleteVmOnNode(node, vm) {
  return agentJson(node, { method: 'DELETE', path: `/vms/${vm.uuid}`, timeout: 60000 });
}
async function patchVmOnNode(node, vm, data) {
  return agentJson(node, { method: 'PATCH', path: `/vms/${vm.uuid}`, body: JSON.stringify(data || {}) });
}
async function resizeVmOnNode(node, vm, newSize) {
  return agentJson(node, { method: 'POST', path: `/vms/${vm.uuid}/resize`, body: JSON.stringify({ disk_size: newSize }), timeout: 120000 });
}
async function addDiskOnNode(node, vm, data) {
  return agentJson(node, { method: 'POST', path: `/vms/${vm.uuid}/disks`, body: JSON.stringify(data || {}), timeout: 120000 });
}
async function growDiskOnNode(node, vm, name, size) {
  return agentJson(node, { method: 'POST', path: `/vms/${vm.uuid}/disks/${encodeURIComponent(name)}/resize`, body: JSON.stringify({ size }), timeout: 120000 });
}
async function vmStatsOnNode(node, vm) {
  return agentJson(node, { method: 'GET', path: `/vms/${vm.uuid}/stats` });
}
async function vmStatusOnNode(node, vm) {
  const d = await agentJson(node, { method: 'GET', path: `/vms/${vm.uuid}/status` });
  return d.status;
}
async function vmBootLogOnNode(node, vm) {
  return agentJson(node, { method: 'GET', path: `/vms/${vm.uuid}/bootlog` });
}
async function reinstallVmOnNode(node, vm, data) {
  return agentJson(node, { method: 'POST', path: `/vms/${vm.uuid}/reinstall`, body: JSON.stringify(data || {}), timeout: 300000 });
}
async function tmateVmOnNode(node, vm, regen) {
  return agentJson(node, { method: 'POST', path: `/vms/${vm.uuid}/tmate${regen ? '/regen' : ''}`, body: '{}', timeout: 300000 });
}
async function listSnapshotsOnNode(node, vm) {
  return agentJson(node, { method: 'GET', path: `/vms/${vm.uuid}/snapshots` });
}
async function createSnapshotOnNode(node, vm, name) {
  return agentJson(node, { method: 'POST', path: `/vms/${vm.uuid}/snapshots`, body: JSON.stringify({ name }), timeout: 120000 });
}
async function revertSnapshotOnNode(node, vm, name) {
  return agentJson(node, { method: 'POST', path: `/vms/${vm.uuid}/snapshots/${encodeURIComponent(name)}/revert`, timeout: 120000 });
}
async function deleteSnapshotOnNode(node, vm, name) {
  return agentJson(node, { method: 'DELETE', path: `/vms/${vm.uuid}/snapshots/${encodeURIComponent(name)}`, timeout: 60000 });
}
async function listVmsOnNode(node) {
  const d = await agentJson(node, { method: 'GET', path: '/vms' });
  return d.vms || [];
}

// ---------- Remote node maintenance ----------
async function syncOsToNode(node) {
  const osList = require('./vmService').getOsList();
  if (!Array.isArray(osList)) throw new Error('OS list unavailable');
  return agentJson(node, { method: 'POST', path: '/os', body: JSON.stringify({ os_list: osList }) });
}

async function pushUpdateToNode(node) {
  if (node.id === 1 && node.agent_token === 'local-primary-no-agent') {
    throw new Error('Primary node is the panel itself and is updated in place (git pull + npm install + restart).');
  }
  const data = await agentJson(node, { method: 'POST', path: '/update', body: JSON.stringify({}), timeout: 300000 }); // git clone + npm install on the node
  return data;
}

async function pushUpdateToAll() {
  const nodes = allNodes();
  const results = [];
  for (const node of nodes) {
    if (node.id === 1 && node.agent_token === 'local-primary-no-agent') {
      results.push({ node_id: node.id, name: node.name, status: 'skipped', message: 'Primary node is the panel itself' });
      continue;
    }
    try {
      const r = await pushUpdateToNode(node);
      results.push({ node_id: node.id, name: node.name, status: 'ok', message: (r && r.message) || 'update started' });
    } catch (e) {
      results.push({ node_id: node.id, name: node.name, status: 'error', message: e.message });
    }
  }
  return { results };
}

function randomToken(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// Parse a "connect key" printed by install-node.sh:  CODE@HOST:PORT
// Returns { code, host, port } or throws.
function parseJoinKey(key) {
  const s = String(key || '').trim();
  const at = s.lastIndexOf('@');
  if (at <= 0) throw new Error('Invalid connect key. Expected format: CODE@HOST:PORT');
  const code = s.slice(0, at).trim();
  const hostPort = s.slice(at + 1).trim();
  const m = hostPort.match(/^([^:]+):(\d+)$/);
  if (!m) throw new Error('Invalid connect key. Expected format: CODE@HOST:PORT');
  return { code, host: m[1], port: parseInt(m[2], 10) };
}

// Onboard a node using only its printed connect key. The panel generates a
// fresh token, exchanges it on the node via /join (validated by the join code),
// then registers the node in the DB and probes it.
async function onboardNodeByKey(key, { location } = {}) {
  let parsed;
  try {
    parsed = parseJoinKey(key);
  } catch (e) {
    throw new Error('Invalid connect key format. It must look like CODE@HOST:PORT (e.g. AB12-CD34-EF56@1.2.3.4:3005)');
  }
  const { code, host, port } = parsed;
  let node = getNodeByHost(host);
  if (node && node.port === port) {
    throw new Error('A node with this host and port is already registered');
  }
  const token = randomToken(32);
  const temp = { host, port, agent_token: '' };
  // The /join endpoint is pre-auth; it accepts the join code + new token.
  let r;
  try {
    r = await agentJson(temp, {
      method: 'POST',
      path: '/join',
      body: JSON.stringify({ code, token }),
    });
  } catch (e) {
    const msg = String(e.message || e);
    if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|timed out|ECONNRESET/i.test(msg)) {
      throw new Error(`Cannot reach the node agent at ${host}:${port} (${msg}). Make sure the agent is running on the node and this port is open/forwarded (on containers: forward the port or use the Cloudflare tunnel in the node installer).`);
    }
    throw new Error('Node rejected the join request: ' + msg);
  }
  const meta = (r && r.node) || {};
  node = createNode({
    name: meta.name || host,
    host,
    port,
    agent_token: token,
    location: location || meta.location || '',
  });
  probeNode(node.id, { force: true });
  return node;
}

// ---------- Aggregate view for the whole cluster ----------
function getClusterSummary() {
  const nodes = allNodes();
  let total = 0, running = 0;
  let allocatedMem = 0, allocatedCpus = 0;
  let totalCpu = 0, totalMem = 0, totalDisk = 0;
  let usedCpu = 0, usedMem = 0, usedDisk = 0;
  const nodeSummaries = [];

  for (const node of nodes) {
    const stats = cachedStats(node.id);
    const vmCount = nodeVmCount(node.id);
    total += vmCount;

    let runningOnNode = 0;
    if (stats && stats.vms) runningOnNode = stats.vms.running || 0;
    running += runningOnNode;
    if (stats) {
      if (stats.vms) {
        allocatedMem += parseInt(stats.vms.allocated_memory_mb, 10) || 0;
        allocatedCpus += parseInt(stats.vms.allocated_cpus, 10) || 0;
      }
      totalCpu += parseInt(stats.cpu && stats.cpu.cores_count, 10) || 0;
      totalMem += parseInt(stats.memory && stats.memory.total_mb, 10) || 0;
      totalDisk += parseFloat(stats.disk && stats.disk.total_gb) || 0;
      usedMem += parseInt(stats.memory && stats.memory.used_mb, 10) || 0;
      usedDisk += parseFloat(stats.disk && stats.disk.used_gb) || 0;
      const cores = parseInt(stats.cpu && stats.cpu.cores_count, 10) || 0;
      const pct = parseFloat(stats.cpu && stats.cpu.percent) || 0;
      usedCpu += cores ? (cores * pct) / 100 : 0;
    }
    nodeSummaries.push({
      id: node.id,
      name: node.name,
      host: node.host,
      port: node.port,
      location: node.location || '',
      status: node.status,
      agent: !!(node.agent_token && node.agent_token !== 'local-primary-no-agent'),
      last_seen_at: node.last_seen_at,
      vm_total: vmCount,
      vm_running: runningOnNode,
      ram_overcommit_ratio: parseFloat(node.ram_overcommit_ratio) || 1.0,
      stats,
    });
  }

  return {
    nodes: nodeSummaries,
    node_count: nodes.length,
    online_nodes: nodes.filter((n) => n.status === 'online').length,
    offline_nodes: nodes.filter((n) => n.status === 'offline').length,
    vms: { total, running, stopped: total - running, allocated_memory_mb: allocatedMem, allocated_cpus: allocatedCpus },
    capacity: { cpu: totalCpu, memory_mb: totalMem, disk_gb: totalDisk },
    usage: {
      cpu_percent: totalCpu > 0 ? Math.round((usedCpu / totalCpu) * 100) : 0,
      cpu_used: Math.round(usedCpu),
      cpu_remaining: Math.max(0, totalCpu - Math.round(usedCpu)),
      memory_percent: totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0,
      memory_used_mb: usedMem,
      memory_remaining_mb: Math.max(0, totalMem - usedMem),
      disk_percent: totalDisk > 0 ? Math.round((usedDisk / totalDisk) * 100) : 0,
      disk_used_gb: Math.round(usedDisk),
      disk_remaining_gb: Math.max(0, Math.round(totalDisk - usedDisk)),
    },
    updated_at: now(),
  };
}

function cachedStats(nodeId) {
  return STATS_CACHE.get(nodeId) || null;
}

function nodeError(nodeId) {
  return CONN_CACHE.get(nodeId) || null;
}

module.exports = {
  now, allNodes, getNode, createNode, updateNode, deleteNode, nodeVmCount,
  agentRequest, agentJson, fetchNodeStats, probeNode, startHeartbeat, stopHeartbeat,
  createVmOnNode, startVmOnNode, stopVmOnNode, restartVmOnNode, deleteVmOnNode, patchVmOnNode,
  resizeVmOnNode, vmStatsOnNode, vmStatusOnNode, vmBootLogOnNode, listVmsOnNode,
  reinstallVmOnNode, tmateVmOnNode,
  syncOsToNode, pushUpdateToNode, pushUpdateToAll, onboardNodeByKey,
  addDiskOnNode, growDiskOnNode,
  listSnapshotsOnNode, createSnapshotOnNode, revertSnapshotOnNode, deleteSnapshotOnNode,
  getClusterSummary, cachedStats, nodeError, nodeForVm,
};
