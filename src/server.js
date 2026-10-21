#!/usr/bin/env node
process.title = 'venlix-nodes';

const logger = require('./lib/logger');

// Cap so a hung backup cannot block shutdown indefinitely.
const SHUTDOWN_DUMP_TIMEOUT_MS = 8000;

async function crashDump(reason) {
  const timer = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DUMP_TIMEOUT_MS));
  try {
    // Lazy require: an early-boot failure may leave dbTransfer unloadable, and
    // that must not turn into a second uncaught error while dying.
    const dbTransfer = require('./services/dbTransferService');
    await Promise.race([Promise.resolve(dbTransfer.emergencyCode(reason)), timer]);
  } catch (e) {
    logger.error('[panel] emergency code failed: ' + e.message);
  }
}

// shutdown() is guarded so a second SIGTERM while the first is still draining
// does not start a second export.
let shuttingDown = false;
function shutdown(signal, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[panel] ${signal}: draining, writing recovery code`);
  crashDump(reason)
    .catch(() => {})
    .then(() => {
      try { io.close(); } catch (_) {}
      // Kill sshx fallback sessions so their shells do not outlive the panel.
      try { require('./services/sshxService').stopAll(); } catch (_) {}
      process.exit(0);
    });
}

// False until bootstrap() returned: before that nothing is serving, so any
// fatal error must exit for pm2/systemd to restart us instead of leaving an
// "online" process with a dead port.
let booted = false;

function fatal(err) {
  const code = err && err.code;
  if (code === 'EADDRINUSE' || code === 'EACCES' || code === 'EPERM') {
    logger.error('[panel] cannot bind port (' + code + '): ' + (err.message || '') +
      ' — another instance is probably still running; stop it or free the port');
    process.exit(1);
  }
  if (!booted) {
    logger.error('[panel] fatal startup error: ' + (err && (err.stack || err.message) || err));
    process.exit(1);
  }
}

// Handlers are registered before app/bootstrap so crashes during module load
// or startup are logged and recovered instead of bypassing them.
process.on('SIGINT', () => shutdown('shutting down', 'SIGINT'));
process.on('SIGTERM', () => shutdown('terminating', 'SIGTERM'));

// Post-boot an uncaught exception is logged and the process keeps serving
// (one bad request should not take the panel down), but bind errors and any
// failure before startup completes exit so the supervisor can recover.
process.on('uncaughtException', (e) => {
  logger.error('[panel] uncaught exception: ' + (e && (e.stack || e.message) || e));
  fatal(e);
  crashDump('uncaughtException').catch(() => {});
});

process.on('unhandledRejection', (e) => {
  logger.error('[panel] unhandled rejection: ' + (e && (e.stack || e.message) || e));
  fatal(e);
  crashDump('unhandledRejection').catch(() => {});
});

// CLI first-run DB restore:  node src/server.js --restore-code ./code.file
const restoreIdx = process.argv.indexOf('--restore-code');
if (restoreIdx !== -1 && process.argv[restoreIdx + 1]) {
  try {
    const { restoreFromCodeFile } = require('./services/dbTransferService');
    restoreFromCodeFile(process.argv[restoreIdx + 1]);
  } catch (e) {
    console.error('[restore] failed: ' + e.message);
    process.exit(1);
  }
}

const { bootstrap } = require('./app');
const { io } = bootstrap();
booted = true;
