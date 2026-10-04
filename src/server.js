#!/usr/bin/env node
process.title = 'venlix-nodes';

// CLI first-run DB restore:  node src/server.js --restore-code ./code.file
const restoreIdx = process.argv.indexOf('--restore-code');
if (restoreIdx !== -1 && process.argv[restoreIdx + 1]) {
  const { restoreFromCodeFile } = require('./services/dbTransferService');
  try {
    restoreFromCodeFile(process.argv[restoreIdx + 1]);
  } catch (e) {
    console.error('[restore] failed: ' + e.message);
    process.exit(1);
  }
}

const { bootstrap } = require('./app');
const logger = require('./lib/logger');
const dbTransfer = require('./services/dbTransferService');

const { io } = bootstrap();

// emergencyCode() is async: it runs db.backup() then reads the snapshot into
// memory and encodes it. Calling it without awaiting, then exiting on the next
// line, tore the process down mid-export every time, so the one moment we most
// wanted a recovery code was the moment it never finished writing. Returns a
// promise that never rejects, and caps the wait so a hung backup cannot block
// shutdown indefinitely.
const SHUTDOWN_DUMP_TIMEOUT_MS = 8000;

async function crashDump(reason) {
  const timer = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DUMP_TIMEOUT_MS));
  try {
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
      process.exit(0);
    });
}

process.on('SIGINT', () => shutdown('shutting down', 'SIGINT'));
process.on('SIGTERM', () => shutdown('terminating', 'SIGTERM'));

// A rejection or exception is logged and the process keeps serving, which is
// deliberate: one bad request should not take the panel down. Neither handler
// exits.
process.on('uncaughtException', (e) => {
  logger.error('[panel] uncaught exception: ' + e.stack);
  crashDump('uncaughtException').catch(() => {});
});

process.on('unhandledRejection', (e) => {
  logger.error('[panel] unhandled rejection: ' + (e && e.stack || e));
  crashDump('unhandledRejection').catch(() => {});
});