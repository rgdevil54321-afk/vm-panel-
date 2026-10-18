const { db, settings } = require('../lib/db');

// ---------- Storage pools ----------
function listPools(activeOnly = false) {
  let sql = 'SELECT p.*, n.name AS node_name FROM storage_pools p LEFT JOIN nodes n ON n.id = p.node_id';
  if (activeOnly) sql += ' WHERE p.active = 1';
  sql += ' ORDER BY p.id ASC';
  return db.prepare(sql).all();
}
function getPool(id) {
  return db.prepare('SELECT * FROM storage_pools WHERE id = ?').get(Number(id));
}
function createPool(data) {
  if (!data.name || !String(data.name).trim()) throw new Error('Pool name is required');
  if (!data.path || !String(data.path).trim()) throw new Error('Pool path is required');
  db.prepare(
    'INSERT INTO storage_pools (name, type, path, node_id, active, options, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(
    String(data.name).trim(),
    String(data.type || 'dir'),
    String(data.path).trim(),
    data.node_id ? Number(data.node_id) : null,
    data.active === undefined || data.active === true || data.active === 1 || data.active === '1' ? 1 : 0,
    data.options ? JSON.stringify(data.options) : null,
    new Date().toISOString()
  );
  return db.prepare('SELECT * FROM storage_pools ORDER BY id DESC LIMIT 1').get();
}
function updatePool(id, data) {
  const pool = getPool(id);
  if (!pool) return null;
  db.prepare(
    'UPDATE storage_pools SET name = ?, type = ?, path = ?, node_id = ?, active = ?, options = ? WHERE id = ?'
  ).run(
    String(data.name !== undefined ? data.name : pool.name).trim(),
    String(data.type !== undefined ? data.type : pool.type || 'dir'),
    String(data.path !== undefined ? data.path : pool.path).trim(),
    data.node_id !== undefined ? (data.node_id ? Number(data.node_id) : null) : pool.node_id,
    data.active === undefined || data.active === true || data.active === 1 || data.active === '1' ? 1 : 0,
    data.options ? JSON.stringify(data.options) : (pool.options || null),
    id
  );
  return getPool(id);
}
function deletePool(id) {
  return db.prepare('DELETE FROM storage_pools WHERE id = ?').run(Number(id)).changes > 0;
}

// ---------- VNets ----------
function listVnets() {
  return db.prepare('SELECT v.*, n.name AS node_name FROM vnets v LEFT JOIN nodes n ON n.id = v.node_id ORDER BY v.id ASC').all();
}
function getVnet(id) {
  return db.prepare('SELECT * FROM vnets WHERE id = ?').get(Number(id));
}
function rulesForVnet(vnetId) {
  return db.prepare('SELECT * FROM vnet_rules WHERE vnet_id = ? ORDER BY priority ASC, id ASC').all(Number(vnetId));
}
function createVnet(data) {
  if (!data.name || !String(data.name).trim()) throw new Error('Network name is required');
  db.prepare(
    'INSERT INTO vnets (name, node_id, bridge, cidr, gateway, nat, dhcp, enabled, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(
    String(data.name).trim(),
    data.node_id ? Number(data.node_id) : null,
    String(data.bridge || ''),
    String(data.cidr || ''),
    String(data.gateway || ''),
    data.nat === undefined || data.nat === true || data.nat === 1 || data.nat === '1' ? 1 : 0,
    data.dhcp === undefined || data.dhcp === true || data.dhcp === 1 || data.dhcp === '1' ? 1 : 0,
    data.enabled === undefined || data.enabled === true || data.enabled === 1 || data.enabled === '1' ? 1 : 0,
    new Date().toISOString()
  );
  return db.prepare('SELECT * FROM vnets ORDER BY id DESC LIMIT 1').get();
}
function updateVnet(id, data) {
  const net = getVnet(id);
  if (!net) return null;
  db.prepare(
    'UPDATE vnets SET name = ?, node_id = ?, bridge = ?, cidr = ?, gateway = ?, nat = ?, dhcp = ?, enabled = ? WHERE id = ?'
  ).run(
    String(data.name !== undefined ? data.name : net.name).trim(),
    data.node_id !== undefined ? (data.node_id ? Number(data.node_id) : null) : net.node_id,
    String(data.bridge !== undefined ? data.bridge : (net.bridge || '')),
    String(data.cidr !== undefined ? data.cidr : (net.cidr || '')),
    String(data.gateway !== undefined ? data.gateway : (net.gateway || '')),
    data.nat === undefined || data.nat === true || data.nat === 1 || data.nat === '1' ? 1 : 0,
    data.dhcp === undefined || data.dhcp === true || data.dhcp === 1 || data.dhcp === '1' ? 1 : 0,
    data.enabled === undefined || data.enabled === true || data.enabled === 1 || data.enabled === '1' ? 1 : 0,
    id
  );
  return getVnet(id);
}
function deleteVnet(id) {
  db.prepare('DELETE FROM vnet_rules WHERE vnet_id = ?').run(Number(id));
  return db.prepare('DELETE FROM vnets WHERE id = ?').run(Number(id)).changes > 0;
}

// ---------- Firewall rules ----------
function createRule(vnetId, data) {
  if (!data.protocol || !String(data.protocol).trim()) throw new Error('Protocol is required');
  db.prepare(
    'INSERT INTO vnet_rules (vnet_id, direction, protocol, port, source, action, priority, description, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(
    Number(vnetId),
    String(data.direction || 'in'),
    String(data.protocol).trim().toLowerCase(),
    String(data.port || ''),
    String(data.source || ''),
    String(data.action || 'allow'),
    parseInt(data.priority, 10) || 100,
    String(data.description || ''),
    new Date().toISOString()
  );
  return db.prepare('SELECT * FROM vnet_rules ORDER BY id DESC LIMIT 1').get();
}
function deleteRule(id) {
  return db.prepare('DELETE FROM vnet_rules WHERE id = ?').run(Number(id)).changes > 0;
}
function updateRule(id, data) {
  const rule = db.prepare('SELECT * FROM vnet_rules WHERE id = ?').get(Number(id));
  if (!rule) return null;
  db.prepare(
    'UPDATE vnet_rules SET direction = ?, protocol = ?, port = ?, source = ?, action = ?, priority = ?, description = ? WHERE id = ?'
  ).run(
    String(data.direction !== undefined ? data.direction : rule.direction),
    String(data.protocol !== undefined ? data.protocol : rule.protocol).toLowerCase(),
    String(data.port !== undefined ? data.port : (rule.port || '')),
    String(data.source !== undefined ? data.source : (rule.source || '')),
    String(data.action !== undefined ? data.action : rule.action),
    parseInt(data.priority, 10) || 100,
    String(data.description !== undefined ? data.description : (rule.description || '')),
    id
  );
  return db.prepare('SELECT * FROM vnet_rules WHERE id = ?').get(id);
}

// ---------- ISO library ----------
function listIsos() {
  const raw = settings.get('iso.library');
  return Array.isArray(raw) ? raw : [];
}
function saveIsos(arr) {
  settings.set('iso.library', arr);
  return arr;
}
function addIso(data) {
  if (!data.name || !String(data.name).trim()) throw new Error('ISO name is required');
  const arr = listIsos();
  arr.push({
    name: String(data.name).trim(),
    url: String(data.url || ''),
    pool_id: data.pool_id ? Number(data.pool_id) : null,
    size_mb: parseFloat(data.size_mb) || 0,
    description: String(data.description || ''),
  });
  return saveIsos(arr);
}
function updateIso(idx, data) {
  const arr = listIsos();
  const i = parseInt(idx, 10);
  if (!Number.isFinite(i) || i < 0 || i >= arr.length) return null;
  arr[i] = {
    name: String(data.name || arr[i].name).trim(),
    url: String(data.url !== undefined ? data.url : (arr[i].url || '')),
    pool_id: data.pool_id !== undefined ? (data.pool_id ? Number(data.pool_id) : null) : (arr[i].pool_id || null),
    size_mb: parseFloat(data.size_mb) || 0,
    description: String(data.description !== undefined ? data.description : (arr[i].description || '')),
  };
  return saveIsos(arr);
}

// ---------- Serialize actionable config for agents ----------
function infraConfig() {
  const nodes = db.prepare('SELECT id, name, host, port, agent_token FROM nodes ORDER BY id ASC').all();
  return {
    pools: listPools().map((p) => ({ name: p.name, type: p.type, path: p.path, node_id: p.node_id, active: p.active, options: (() => { try { return JSON.parse(p.options); } catch (_) { return null; } })() })),
    networks: listVnets().map((v) => ({
      name: v.name, node_id: v.node_id, bridge: v.bridge, cidr: v.cidr, gateway: v.gateway,
      nat: v.nat, dhcp: v.dhcp, enabled: v.enabled,
      rules: rulesForVnet(v.id).map((r) => ({ direction: r.direction, protocol: r.protocol, port: r.port, source: r.source, action: r.action, priority: r.priority, description: r.description })),
    })),
    vnets: listVnets().map((v) => ({
      name: v.name, node_id: v.node_id, bridge: v.bridge, cidr: v.cidr, gateway: v.gateway,
      nat: v.nat, dhcp: v.dhcp, enabled: v.enabled,
      rules: rulesForVnet(v.id).map((r) => ({ direction: r.direction, protocol: r.protocol, port: r.port, source: r.source, action: r.action, priority: r.priority, description: r.description })),
    })),
    isos: listIsos(),
    nodes,
  };
}

module.exports = {
  listPools, getPool, createPool, updatePool, deletePool,
  listVnets, getVnet, rulesForVnet, createVnet, updateVnet, deleteVnet,
  createRule, deleteRule, updateRule,
  listIsos, saveIsos, addIso, updateIso,
  infraConfig,
};