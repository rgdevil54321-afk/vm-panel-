#!/usr/bin/env node
const { bootstrap } = require('./app');
const logger = require('./lib/logger');

process.title = 'venlix-nodes';

const { io } = bootstrap();

process.on('SIGINT', () => {
  logger.info('[panel] shutting down');
  io.close();
  process.exit(0);
});

process.on('uncaughtException', (e) => {
  logger.error('[panel] uncaught exception: ' + e.stack);
});

process.on('unhandledRejection', (e) => {
  logger.error('[panel] unhandled rejection: ' + (e && e.stack || e));
});
