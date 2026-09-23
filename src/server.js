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

function crashDump(reason) {
  try {
    dbTransfer.emergencyCode(reason);
  } catch (e) {
    logger.error('[panel] emergency code failed: ' + e.message);
  }
}

process.on('SIGINT', () => {
  logger.info('[panel] shutting down');
  crashDump('SIGINT');
  io.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('[panel] terminating');
  crashDump('SIGTERM');
  io.close();
  process.exit(0);
});

process.on('uncaughtException', (e) => {
  logger.error('[panel] uncaught exception: ' + e.stack);
  crashDump('uncaughtException');
});

process.on('unhandledRejection', (e) => {
  logger.error('[panel] unhandled rejection: ' + (e && e.stack || e));
  crashDump('unhandledRejection');
});