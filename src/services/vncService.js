const net = require('net');
const { WebSocketServer, WebSocket } = require('ws');
const logger = require('../lib/logger');
const authService = require('./authService');
const vmService = require('./vmService');
const nodeRegistry = require('./nodeRegistry');

function tokenFromReq(req) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const q = url.searchParams.get('token');
    if (q) return q;
  } catch (_) {}
  const cookie = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith('token='));
  return cookie ? cookie.split('=')[1] : null;
}

function authenticate(vmId, req) {
  const token = tokenFromReq(req);
  if (!token) return null;
  let user = null;
  try {
    const payload = authService.verifyToken(token);
    if (payload && payload.sub) user = authService.findById(Number(payload.sub));
  } catch (_) {
    return null;
  }
  if (!user || user.suspended) return null;
  const vm = vmService.getVm(vmId);
  if (!vm || !vmService.canAccess(user, vm, 'console')) return null;
  if (!vmService.isRunning(vm) || !vm.vnc_port) return null;
  return { user, vm };
}

// Local VMs: raw TCP to the loopback VNC port.
function attachLocal(ws, vm) {
  const tcp = net.connect({ host: '127.0.0.1', port: vm.vnc_port });
  let tcpReady = false;
  const pending = [];

  ws.on('message', (data) => {
    if (tcpReady) tcp.write(data);
    else pending.push(data);
  });

  tcp.on('connect', () => {
    tcpReady = true;
    while (pending.length) tcp.write(pending.shift());
  });

  tcp.on('data', (data) => {
    if (ws.readyState === ws.OPEN) ws.send(data, { binary: true });
  });

  const cleanup = () => {
    try { tcp.destroy(); } catch (_) {}
    try { ws.close(); } catch (_) {}
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);
  tcp.on('error', cleanup);
  tcp.on('close', cleanup);
}

// Remote VMs: bridge browser WS <-> agent WS relay (<agent-host>:<port>/vncws/<vmId>).
function attachRemote(ws, vm, node) {
  const isHttps = String(node.host).startsWith('https://');
  let hostname = String(node.host).replace(/^https?:\/\//, '');
  const port = node.port || 3005;
  const proto = isHttps ? 'wss' : 'ws';
  const url = `${proto}://${hostname}:${port}/vncws/${vm.id}`;

  const agentWs = new WebSocket(url, {
    headers: { Authorization: 'Bearer ' + (node.agent_token || '') },
  });

  let agentReady = false;
  const pending = [];

  ws.on('message', (data) => {
    if (agentReady && agentWs.readyState === WebSocket.OPEN) agentWs.send(data, { binary: true });
    else if (pending.length < 65536) pending.push(data);
  });

  agentWs.on('open', () => {
    agentReady = true;
    while (pending.length) {
      if (agentWs.readyState !== WebSocket.OPEN) break;
      agentWs.send(pending.shift(), { binary: true });
    }
  });

  agentWs.on('message', (data, isBinary) => {
    if (ws.readyState === ws.OPEN) ws.send(data, { binary: isBinary || true });
  });

  agentWs.on('error', () => {
    try { ws.close(1011, 'Agent relay unavailable'); } catch (_) {}
  });
  agentWs.on('close', () => {
    try { ws.close(); } catch (_) {}
  });

  const cleanup = () => {
    try { agentWs.close(); } catch (_) {}
    try { ws.close(); } catch (_) {}
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);
}

function attachVncProxy(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const m = req.url.match(/^\/vncws\/(\d+)(?:[?].*)?$/);
    if (!m) return;

    const ctx = authenticate(parseInt(m[1], 10), req);
    if (!ctx) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const vm = ctx.vm;
      const nodeId = vm.node_id || 1;
      let node = null;
      if (nodeId !== 1) {
        try { node = nodeRegistry.getNode(nodeId); } catch (_) {}
      }
      if (!node || !node.agent_token || node.agent_token === 'local-primary-no-agent') {
        attachLocal(ws, vm);
        logger.debug(`[vnc] ${ctx.user.username} -> vm ${vm.id} (local, port ${vm.vnc_port})`);
      } else {
        attachRemote(ws, vm, node);
        logger.debug(`[vnc] ${ctx.user.username} -> vm ${vm.id} via node ${node.name} (${node.host}:${node.port})`);
      }
    });
  });
}

module.exports = { attachVncProxy };