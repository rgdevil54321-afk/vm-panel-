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
  probeNode(id);
  return getNode(id);
}

function updateNode(id, data) {
  const node = getNode(id);
  if (!node) throw new Error('Node not found');
  const fields = ['name', 'host', 'port', 'agent_token', 'location'];
  const set = [];
  const vals = {};
  for (const f of fields) {
    if (data[f] !== undefined && data[f] !== '') {
      set.push(`${f} = @${f}`);
      vals[f] = f === 'port' ? parseInt(data[f], 10) : String(data[f]);
    }
  }
  if (set.length) {
    set.push('updated_at = @updated_at');
    vals.updated_at = now();
    db.prepare(`UPDATE nodes SET ${set.join(', ')} WHERE id = @id`).run({ ...vals, id });
  }
  probeNode(id);
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
function agentRequest(node, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const isHttps = String(node.host).startsWith('https://');
    const hostname = String(node.host).replace(/^https?:\/\//, '');
    const port = node.port || 3005;
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
    const req = mod.request({
      hostname,
      port,
      method,
      path,
      timeout: 8000,
      headers: outHeaders,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('Agent request timed out')));
    req.on('error', reject);
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
function markNode(id, status) {
  db.prepare('UPDATE nodes SET status = ?, last_seen_at = ?, updated_at = ? WHERE id = ?')
    .run(status, status === 'online' ? now() : null, now(), id);
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
  return stats;
}

function probeNode(nodeId) {
  const node = getNode(nodeId);
  if (!node) return;
  fetchNodeStats(node)
    .then((stats) => {
      STATS_CACHE.set(nodeId, stats);
      markNode(nodeId, 'online');
    })
    .catch((e) => {
      CONN_CACHE.set(nodeId, e.message);
      markNode(nodeId, 'offline');
    });
}

function startHeartbeat(intervalMs = 8000) {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  const tick = () => {
    for (const node of allNodes()) {
      if (node.agent_token && node.agent_token !== 'local-primary-no-agent') {
        probeNode(node.id);
      }
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
  });
}

async function startVmOnNode(node, vm) {
  return agentJson(node, { method: 'POST', path: `/vms/${vm.id}/start` });
}
async function stopVmOnNode(node, vm, force) {
  return agentJson(node, { method: 'POST', path: `/vms/${vm.id}/stop`, body: JSON.stringify({ force: !!force }) });
}
async function restartVmOnNode(node, vm) {
  return agentJson(node, { method: 'POST', path: `/vms/${vm.id}/restart` });
}
async function deleteVmOnNode(node, vm) {
  return agentJson(node, { method: 'DELETE', path: `/vms/${vm.id}` });
}
async function resizeVmOnNode(node, vm, newSize) {
  return agentJson(node, { method: 'POST', path: `/vms/${vm.id}/resize`, body: JSON.stringify({ disk_size: newSize }) });
}
async function vmStatsOnNode(node, vm) {
  return agentJson(node, { method: 'GET', path: `/vms/${vm.id}/stats` });
}
async function vmStatusOnNode(node, vm) {
  const d = await agentJson(node, { method: 'GET', path: `/vms/${vm.id}/status` });
  return d.status;
}
async function vmBootLogOnNode(node, vm) {
  return agentJson(node, { method: 'GET', path: `/vms/${vm.id}/bootlog` });
}
async function listVmsOnNode(node) {
  const d = await agentJson(node, { method: 'GET', path: '/vms' });
  return d.vms || [];
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
      usedCpu += parseInt(stats.cpu && stats.cpu.cores_count, 10) || 0;
      usedMem += parseInt(stats.memory && stats.memory.used_mb, 10) || 0;
      usedDisk += parseFloat(stats.disk && stats.disk.used_gb) || 0;
    }
    nodeSummaries.push({
      id: node.id,
      name: node.name,
      host: node.host,
      port: node.port,
      location: node.location || '',
      status: node.status,
      last_seen_at: node.last_seen_at,
      vm_total: vmCount,
      vm_running: runningOnNode,
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
      memory_percent: totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0,
      disk_percent: totalDisk > 0 ? Math.round((usedDisk / totalDisk) * 100) : 0,
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
  createVmOnNode, startVmOnNode, stopVmOnNode, restartVmOnNode, deleteVmOnNode,
  resizeVmOnNode, vmStatsOnNode, vmStatusOnNode, vmBootLogOnNode, listVmsOnNode,
  getClusterSummary, cachedStats, nodeError, nodeForVm,
};
