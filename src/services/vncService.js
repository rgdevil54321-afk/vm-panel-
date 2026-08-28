const net = require('net');
const { WebSocketServer } = require('ws');
const logger = require('../lib/logger');
const authService = require('./authService');
const vmService = require('./vmService');

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
      const tcp = net.connect({ host: '127.0.0.1', port: ctx.vm.vnc_port });
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

      logger.debug(`[vnc] ${ctx.user.username} -> vm ${ctx.vm.id} (port ${ctx.vm.vnc_port})`);
    });
  });
}

module.exports = { attachVncProxy };
