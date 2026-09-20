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
const planGuardService = require('./services/planGuardService');
const activity = require('./services/activityService');
const { attachVncProxy } = require('./services/vncService');

const authService = require('./services/authService');

function createWebApp() {
  const app = express();
  app.disable('x-powered-by');
  // Cache buster: changes on every panel restart so browsers reload JS/CSS
  app.set('panelBootId', Date.now().toString(36));
  app.set('view engine', 'ejs');
  app.set('views', path.join(config.root, 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json({ limit: '50mb' }));
  app.use(cookieParser());
  app.use((req, res, next) => {
    res.locals.settings = settings.all();
    res.locals.user = null;
    res.locals.panelBootId = app.get('panelBootId');
    res.locals.uploadUrl = (p) => p ? (String(p).startsWith('http') ? p : `/uploads${String(p).startsWith('/uploads') ? '' : '/'}${p}`) : '';
    next();
  });
  app.use(express.static(path.join(config.root, 'public')));
  app.use('/uploads', express.static(path.join(config.root, 'public/uploads')));

  // expose auth for middleware
  const { optionalAuth } = require('./middleware/auth');
  app.use(optionalAuth);
  const { i18nMiddleware } = require('./lib/i18n');
  app.use(i18nMiddleware);

  app.get('/', (req, res) => res.redirect(req.user ? '/dashboard' : '/login'));
  app.use('/', require('./routes/webAuth'));
  app.use('/', require('./routes/webUser'));
  app.use('/', require('./routes/webAdmin'));
  // Admin views call JSON endpoints without an /api prefix (VP.api('/admin/...')).
  // Mount the API router at the root as well; page routes above take precedence.
  app.use('/', require('./routes/api'));
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

// ---------------- Persistent multi-terminal sessions ----------------
// Sessions live server-side and survive client reconnects: output is buffered
// and replayed on attach, so refreshing the page or switching tabs never loses
// the running shell. Multiple terminal tabs per VM are supported.
const terminalSessions = new Map(); // vmId -> Map(sessionId -> session)
const MAX_SESSIONS_PER_VM = 4;
const BUFFER_MAX_BYTES = 256 * 1024;
const IDLE_CLOSE_MS = 15 * 60 * 1000;

function sessionsFor(vmId) {
  if (!terminalSessions.has(vmId)) terminalSessions.set(vmId, new Map());
  return terminalSessions.get(vmId);
}

function findSession(sessionId) {
  for (const m of terminalSessions.values()) {
    const s = m.get(sessionId);
    if (s) return s;
  }
  return null;
}

function closeSession(session, reason) {
  if (!session || session.closed) return;
  session.closed = true;
  try { if (session.stream) session.stream.end(); } catch (_) {}
  try { if (session.conn) session.conn.end(); } catch (_) {}
  for (const s of session.clients) {
    try { s.emit('console:close', { sessionId: session.id, reason: reason || 'closed' }); } catch (_) {}
    if (s.data.sessions) s.data.sessions.delete(session.id);
  }
  session.clients.clear();
  const m = terminalSessions.get(session.vmId);
  if (m) {
    m.delete(session.id);
    if (m.size === 0) terminalSessions.delete(session.vmId);
  }
}

function gcTerminalSessions() {
  const now = Date.now();
  for (const [vmId, m] of Array.from(terminalSessions.entries())) {
    let running = false;
    try {
      const vm = vmService.getVm(vmId);
      running = vm ? vmService.isRunning(vm) : false;
    } catch (_) { running = false; }
    for (const session of Array.from(m.values())) {
      const idle = now - session.lastActivity;
      if (session.closed || !running || (session.clients.size === 0 && idle > IDLE_CLOSE_MS)) {
        closeSession(session, !running ? 'server-stopped' : 'idle-timeout');
      }
    }
    if (m.size === 0) terminalSessions.delete(vmId);
  }
}
setInterval(gcTerminalSessions, 30 * 1000).unref();

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
    socket.data.sessions = new Set(); // session ids this socket is attached to

    function detachFrom(session) {
      if (!session) return;
      session.clients.delete(socket);
      socket.data.sessions.delete(session.id);
      session.lastActivity = Date.now();
    }

    function attach(session, { replay = true } = {}) {
      session.clients.add(socket);
      socket.data.sessions.add(session.id);
      session.lastActivity = Date.now();
      const hasBuffer = replay && session.buffer.length > 0;
      if (hasBuffer) {
        socket.emit('console:buffer', { sessionId: session.id, text: session.buffer.join('') });
      }
      socket.emit('console:ready', {
        sessionId: session.id,
        cols: session.cols || socket.data.cols || 80,
        rows: session.rows || socket.data.rows || 24,
        replayed: !!hasBuffer,
      });
      try { session.stream.setWindow(session.rows || 24, session.cols || 80); } catch (_) {}
    }

    socket.on('console:join', ({ vmId, terminalId, reattach }) => {
      const vid = parseInt(vmId, 10);
      const vm = vmService.getVm(vid);
      if (!vm || !vmService.canAccess(socket.data.user, vm, 'console')) {
        socket.emit('console:error', 'Access denied or server not found');
        return;
      }
      if (!vmService.isRunning(vm)) {
        socket.emit('console:offline');
        return;
      }

      const m = sessionsFor(vid);

      // 1) Reattach: same terminal id, or any live session for this VM.
      //    This is what makes reconnects instant and lossless.
      if (reattach) {
        let session = (terminalId && m.get(terminalId)) || null;
        if (!session) {
          for (const s of m.values()) {
            if (!s.closed) { session = s; break; }
          }
        }
        if (session && !session.closed) {
          attach(session, { replay: true });
          return;
        }
      } else if (terminalId && m.get(terminalId) && !m.get(terminalId).closed) {
        // Explicit re-join of a known session (e.g. switching tabs)
        attach(m.get(terminalId), { replay: true });
        return;
      }

      // 2) Create a brand new session
      if (m.size >= MAX_SESSIONS_PER_VM) {
        let evicted = false;
        for (const s of Array.from(m.values())) {
          if (s.clients.size === 0) { closeSession(s, 'evicted'); evicted = true; break; }
        }
        if (!evicted) {
          socket.emit('console:error', 'Maximum terminal sessions reached for this server');
          return;
        }
      }

      const sid = terminalId || ('t' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
      if (!socket.data.pendingJoins) socket.data.pendingJoins = new Set();
      const joinToken = sid + ':' + Date.now();
      socket.data.pendingJoins.add(joinToken);

      sshService.shellStreamWithRetry(vm, {
        maxRetries: 60,
        retryDelay: 1500,
        shouldContinue: () => socket.connected && socket.data.pendingJoins.has(joinToken) && vmService.isRunning(vm),
      })
        .then(({ conn, stream }) => {
          if (!socket.connected || !socket.data.pendingJoins.has(joinToken)) {
            try { stream.end(); } catch (_) {}
            try { conn.end(); } catch (_) {}
            return;
          }
          socket.data.pendingJoins.delete(joinToken);
          const session = {
            id: sid,
            vmId: vid,
            conn,
            stream,
            buffer: [],
            bufferBytes: 0,
            rows: socket.data.rows || 24,
            cols: socket.data.cols || 80,
            clients: new Set(),
            lastActivity: Date.now(),
            closed: false,
          };
          sessionsFor(vid).set(sid, session);
          stream.on('data', (d) => {
            if (session.closed) return;
            const text = d.toString('utf8');
            session.buffer.push(text);
            session.bufferBytes += Buffer.byteLength(text);
            while (session.bufferBytes > BUFFER_MAX_BYTES && session.buffer.length > 1) {
              session.bufferBytes -= Buffer.byteLength(session.buffer[0]);
              session.buffer.shift();
            }
            session.lastActivity = Date.now();
            for (const c of session.clients) {
              try { c.emit('console:data', { sessionId: sid, text }); } catch (_) {}
            }
          });
          const onEnd = () => closeSession(session, 'stream-closed');
          stream.on('close', onEnd);
          stream.on('error', onEnd);
          try { stream.setWindow(session.rows, session.cols); } catch (_) {}
          attach(session, { replay: false });
        })
        .catch((e) => {
          if (socket.data.pendingJoins) socket.data.pendingJoins.delete(joinToken);
          if (!socket.connected) return;
          if (!vmService.isRunning(vm)) {
            socket.emit('console:offline');
          } else {
            socket.emit('console:error', 'SSH connection failed: ' + e.message);
          }
        });
    });

    socket.on('console:leave', () => {
      for (const sid of Array.from(socket.data.sessions)) {
        detachFrom(findSession(sid));
      }
    });

    socket.on('console:kill', ({ sessionId }) => {
      const s = sessionId && findSession(sessionId);
      if (s) closeSession(s, 'killed');
    });

    socket.on('console:input', ({ sessionId, data }) => {
      if (!sessionId || typeof data !== 'string' || !data) return;
      const s = findSession(sessionId);
      if (s && !s.closed && s.clients.has(socket)) {
        try { s.stream.write(data); } catch (_) {}
        s.lastActivity = Date.now();
      }
    });

    socket.on('console:resize', ({ sessionId, cols, rows }) => {
      cols = Math.max(20, Math.min(500, parseInt(cols, 10) || 80));
      rows = Math.max(5, Math.min(300, parseInt(rows, 10) || 24));
      socket.data.cols = cols;
      socket.data.rows = rows;
      const s = sessionId && findSession(sessionId);
      if (s && !s.closed && s.clients.has(socket)) {
        s.cols = cols;
        s.rows = rows;
        try { s.stream.setWindow(rows, cols); } catch (_) {}
      }
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
      socket.data.joining = null;
      // Detach but KEEP sessions alive so reconnects replay the buffer.
      for (const sid of Array.from(socket.data.sessions)) {
        detachFrom(findSession(sid));
      }
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
  planGuardService.start();
  try {
    require('./services/discordGateway').sync();
  } catch (_) { /* gateway optional */ }
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
