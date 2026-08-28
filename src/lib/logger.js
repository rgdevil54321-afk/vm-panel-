const fs = require('fs');
const path = require('path');

const levels = { error: 0, warn: 1, info: 2, debug: 3 };

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
    fs.appendFileSync(file, line + '\n');
  } catch (_) {}
}

module.exports = {
  error: (...a) => log('error', ...a),
  warn: (...a) => log('warn', ...a),
  info: (...a) => log('info', ...a),
  debug: (...a) => log('debug', ...a),
};
