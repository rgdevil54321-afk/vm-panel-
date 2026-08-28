const express = require('express');
const http = require('http');
const path = require('path');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const { Server } = require('socket.io');
const config = require('./lib/config');
const logger = require('./lib/logger');
const { settings } = require('./lib/db');
const { getUserFromReq } = require('./middleware/auth');
const vmService = require('./services/vmService');
const sshService = require('./services/sshService');
const bootLogService = require('./services/bootLogService');
const scheduleService = require('./services/scheduleService');
const activity = require('./services/activityService');
const { attachVncProxy } = require('./services/vncService');

const authService = require('./services/authService');

function createWebApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(config.root, 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json({ limit: '50mb' }));
  app.use(cookieParser());
  app.use((req, res, next) => {
    res.locals.settings = settings.all();
    res.locals.user = null;
    res.locals.uploadUrl = (p) => p ? (String(p).startsWith('http') ? p : `/uploads${String(p).startsWith('/uploads') ? '' : '/'}${p}`) : '';
    next();
  });
  app.use(express.static(path.join(config.root, 'public')));
  app.use('/uploads', express.static(path.join(config.root, 'public/uploads')));

  // expose auth for middleware
  const { optionalAuth } = require('./middleware/auth');
  app.use(optionalAuth);

  app.get('/', (req, res) => res.redirect(req.user ? '/dashboard' : '/login'));
  app.use('/', require('./routes/webAuth'));
  app.use('/', require('./routes/webUser'));
  app.use('/', require('./routes/webAdmin'));
  app.use('/api', require('./routes/api'));

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    res.status(404).render('error/404', {
      code: 404, title: 'Not Found', message: 'The page you are looking for does not exist.',
      settings: settings.all(), user: req.user || null,
    });
  });
  app.use((err, req, res, next) => {
    logger.error('[panel] web error: ' + (err.stack || err.message));
    if (req.path.startsWith('/api/')) return res.status(500).json({ error: err.message || 'Server error' });
    res.status(500).render('error/404', {
      code: 500, title: 'Server Error', message: err.message || 'An unexpected error occurred.',
      settings: settings.all(), user: req.user || null,
    });
  });
  return app;
}

function createApiApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '50mb' }));
  app.use(cookieParser());
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use('/api', require('./routes/api'));
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  return app;
}

function attachConsoleSocket(io) {
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.headers?.cookie?.split(';').find((c) => c.trim().startsWith('token='))?.split('=')[1];
      const user = token ? authService.verifyToken(token) : null;
      if (!user) return next(new Error('Not authenticated'));
      socket.data.user = authService.findById(Number(user.sub));
      if (!socket.data.user || socket.data.user.suspended) return next(new Error('Not authenticated'));
      next();
    } catch (e) {
      next(new Error('Not authenticated'));
    }
  });

  io.on('connection', (socket) => {
    socket.on('console:join', ({ vmId }) => {
      // Cancel previous pending join
      socket.data.isLeaving = false;

      // Clean up any existing stream on this socket
      if (socket.data.stream) {
        try { socket.data.stream.end(); } catch (_) {}
        socket.data.stream = null;
      }
      if (socket.data.conn) {
        try { socket.data.conn.end(); } catch (_) {}
        socket.data.conn = null;
      }

      const vm = vmService.getVm(parseInt(vmId, 10));
      if (!vm || !vmService.canAccess(socket.data.user, vm, 'console')) {
        socket.emit('console:error', 'Access denied or server not found');
        return;
      }
      if (!vmService.isRunning(vm)) {
        socket.emit('console:offline');
        return;
      }

      sshService.shellStreamWithRetry(vm, {
        maxRetries: 30,
        retryDelay: 1500,
        shouldContinue: () => socket.connected && !socket.data.isLeaving && vmService.isRunning(vm),
      })
        .then(({ conn, stream }) => {
          if (socket.data.isLeaving || !socket.connected) {
            try { stream.end(); } catch (_) {}
            try { conn.end(); } catch (_) {}
            return;
          }
          socket.data.stream = stream;
          socket.data.conn = conn;
          socket.emit('console:ready', { cols: socket.data.cols || 80, rows: socket.data.rows || 24 });
          stream.on('data', (d) => socket.emit('console:data', d.toString('utf8')));
          stream.on('close', () => {
            socket.emit('console:close');
            socket.data.stream = null;
            socket.data.conn = null;
          });
          stream.on('error', () => {
            socket.emit('console:close');
            socket.data.stream = null;
            socket.data.conn = null;
          });
          stream.setWindow(socket.data.rows || 24, socket.data.cols || 80);
        })
        .catch((e) => {
          if (socket.data.isLeaving || !socket.connected) return;
          if (!vmService.isRunning(vm)) {
            socket.emit('console:offline');
          } else {
            socket.emit('console:error', 'SSH connection failed: ' + e.message);
          }
        });
    });

    socket.on('console:leave', () => {
      socket.data.isLeaving = true;
      if (socket.data.stream) {
        try { socket.data.stream.end(); } catch (_) {}
        socket.data.stream = null;
      }
      if (socket.data.conn) {
        try { socket.data.conn.end(); } catch (_) {}
        socket.data.conn = null;
      }
    });

    socket.on('console:input', (data) => {
      if (socket.data.stream) socket.data.stream.write(data);
    });

    socket.on('console:resize', ({ cols, rows }) => {
      socket.data.cols = cols;
      socket.data.rows = rows;
      if (socket.data.stream) socket.data.stream.setWindow(rows, cols);
    });

    socket.on('bootlog:join', ({ vmId }) => {
      const vm = vmService.getVm(parseInt(vmId, 10));
      if (!vm || !vmService.canAccess(socket.data.user, vm, 'console')) {
        socket.emit('bootlog:error', 'Access denied or server not found');
        return;
      }
      if (socket.data.bootLogStream) {
        socket.data.bootLogStream.close();
        socket.data.bootLogStream = null;
      }
      socket.emit('bootlog:ready', {
        vmId: vm.id,
        status: vm.status,
        isRunning: vmService.isRunning(vm),
      });
      socket.data.bootLogStream = bootLogService.createBootLogStream(vm, {
        onData: (text, meta) => {
          socket.emit('bootlog:data', {
            text,
            init: !!meta.init,
            source: meta.source || 'boot',
            vmId: vm.id,
          });
        },
        onError: (e) => socket.emit('bootlog:error', e.message),
        onClose: () => socket.emit('bootlog:close', { vmId: vm.id }),
      });
    });

    socket.on('bootlog:leave', () => {
      if (socket.data.bootLogStream) {
        socket.data.bootLogStream.close();
        socket.data.bootLogStream = null;
      }
    });

    socket.on('bootlog:clear', ({ vmId }) => {
      const vm = vmService.getVm(parseInt(vmId, 10));
      if (!vm || !vmService.canAccess(socket.data.user, vm, 'console')) {
        socket.emit('bootlog:error', 'Access denied or server not found');
        return;
      }
      bootLogService.clearBootLogs(vm);
      socket.emit('bootlog:cleared', { vmId: vm.id });
    });

    socket.on('disconnect', () => {
      if (socket.data.stream) socket.data.stream.end();
      if (socket.data.conn) socket.data.conn.end();
      if (socket.data.bootLogStream) {
        socket.data.bootLogStream.close();
        socket.data.bootLogStream = null;
      }
    });
  });
}

function bootstrap() {
  for (const d of [
    config.vmDir,
    config.uploads.dir, config.uploads.logo, config.uploads.favicon,
    config.uploads.background, config.uploads.music, config.uploads.avatar, config.uploads.backup,
    path.join(config.root, 'data'),
    path.join(config.root, 'storage/logs'),
  ]) {
    fs.mkdirSync(d, { recursive: true });
  }

  scheduleService.loadAll();
  const nodeRegistry = require('./services/nodeRegistry');
  nodeRegistry.startHeartbeat(parseInt(process.env.NODE_HEARTBEAT_MS || '8000', 10));

  const webApp = createWebApp();
  const apiApp = createApiApp();

  const webServer = http.createServer(webApp);
  const io = new Server(webServer, {
    maxHttpBufferSize: 1e7,
    pingInterval: 10000,
    pingTimeout: 25000,
    cors: { origin: '*' }
  });
  attachConsoleSocket(io);
  attachVncProxy(webServer);

  // Auto-seed admin if none exists
  try {
    if (authService.countAdmins() === 0) {
      const username = process.env.ADMIN_USERNAME || 'admin';
      const email = process.env.ADMIN_EMAIL || 'admin@venlix.local';
      const password = process.env.ADMIN_PASSWORD || 'admin12345';
      const user = authService.createUser({ username, email, password, name: 'Administrator', role: 'admin', verified: true });
      const { db } = require('./lib/db');
      db.prepare('UPDATE users SET root_admin = 1 WHERE id = ?').run(user.id);
      logger.info(`[panel] auto-seeded initial admin: ${username} (${email})`);
    }
  } catch (e) {
    logger.warn('[panel] auto-seed admin: ' + e.message);
  }

  webServer.listen(config.panelPort, '0.0.0.0', () => {
    logger.info(`[panel] Venlix Nodes web running on http://0.0.0.0:${config.panelPort}`);
  });
  apiApp.listen(config.apiPort, '0.0.0.0', () => {
    logger.info(`[panel] Venlix Nodes API running on http://0.0.0.0:${config.apiPort}/api`);
  });

  // Autostart VMs flagged to start on boot
  setTimeout(() => vmService.startOnBootAll(), 3000);

  return { webServer, io, apiApp };
}

module.exports = { bootstrap, createWebApp, createApiApp };
