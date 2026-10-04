const fs = require('fs');
const path = require('path');

const levels = { error: 0, warn: 1, info: 2, debug: 3 };

const MAX_BYTES = 8 * 1024 * 1024;   // rotate at 8 MB
const KEEP = 3;                      // panel.log.1 .. panel.log.3

// Rotates panel.log by shifting each numbered file one slot down and dropping
// the oldest. lastSize is cached because this module runs on every log line and
// a statSync per line is real overhead on a busy panel.
let lastSize = 0;
let lastCheck = 0;

function rotateIfNeeded(file) {
  try {
    const oldest = file + '.' + KEEP;
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
    for (let i = KEEP - 1; i >= 1; i--) {
      const from = file + '.' + i;
      if (fs.existsSync(from)) fs.renameSync(from, file + '.' + (i + 1));
    }
    fs.renameSync(file, file + '.1');
    lastSize = 0;
  } catch (_) {
    // A failed rotation must never propagate into the caller that was logging.
    lastSize = 0;
  }
}

function log(level, ...args) {
  const cfg = require('./config');
  const lvl = levels[cfg.logLevel] ?? levels.info;
  if (levels[level] > lvl) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] ${args.join(' ')}`;
  console.log(line);
  try {
    const dir = path.resolve(cfg.root, 'storage/logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'panel.log');
    const now = Date.now();
    // Re-stat at most once a second; otherwise trust the running byte count.
    if (now - lastCheck > 1000) {
      lastCheck = now;
      try {
        const size = fs.statSync(file).size;
        lastSize = size;
        if (size >= MAX_BYTES) { rotateIfNeeded(file); lastSize = 0; }
      } catch (_) { lastSize = 0; }
    } else if (lastSize + Buffer.byteLength(line) + 1 >= MAX_BYTES) {
      rotateIfNeeded(file);
      lastSize = 0;
    }
    fs.appendFileSync(file, line + '\n');
    lastSize += Buffer.byteLength(line) + 1;
  } catch (_) {}
}

module.exports = {
  error: (...a) => log('error', ...a),
  warn: (...a) => log('warn', ...a),
  info: (...a) => log('info', ...a),
  debug: (...a) => log('debug', ...a),
};
