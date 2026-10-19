const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config();

const root = path.resolve(__dirname, '..', '..');

// NaN-safe port parsing: a garbage PANEL_PORT/API_PORT must not reach listen().
function intPort(name, def) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

// The old hardcoded fallback secret let anyone with the source forge panel
// tokens. When JWT_SECRET is unset we generate one and persist it under data/
// so sessions survive restarts.
function loadJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(root, 'data', '.jwt-secret');
  try {
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
    if (existing) return existing;
    const generated = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, generated, { mode: 0o600 });
    return generated;
  } catch (e) {
    throw new Error('JWT_SECRET is not set and ' + file + ' could not be written; set JWT_SECRET in .env');
  }
}

const panelPort = intPort('PANEL_PORT', 3001);

const config = {
  root,
  panelPort,
  apiPort: intPort('API_PORT', 3002),
  panelUrl: process.env.PANEL_URL || `http://localhost:${panelPort}`,
  jwtSecret: loadJwtSecret(),
  jwtExpires: process.env.JWT_EXPIRES || '7d',
  dbPath: path.resolve(root, process.env.DB_PATH || 'data/vpanel.db'),
  vmDir: path.resolve(root, process.env.VM_DIR || 'vms'),
  autoPortMin: parseInt(process.env.AUTO_PORT_MIN || '25501', 10),
  autoPortMax: parseInt(process.env.AUTO_PORT_MAX || '25600', 10),
  autoVncPortMin: parseInt(process.env.AUTO_VNC_PORT_MIN || '25901', 10),
  autoVncPortMax: parseInt(process.env.AUTO_VNC_PORT_MAX || '26000', 10),
  autoAgentPortMin: parseInt(process.env.AUTO_AGENT_PORT_MIN || '26101', 10),
  autoAgentPortMax: parseInt(process.env.AUTO_AGENT_PORT_MAX || '26200', 10),
  allowRegister: String(process.env.ALLOW_REGISTER || '1') === '1',
  logLevel: process.env.LOG_LEVEL || 'info',
  uploads: {
    dir: path.resolve(root, 'public/uploads'),
    logo: path.resolve(root, 'public/uploads/logo'),
    favicon: path.resolve(root, 'public/uploads/favicon'),
    background: path.resolve(root, 'public/uploads/background'),
    music: path.resolve(root, 'public/uploads/music'),
    avatar: path.resolve(root, 'public/uploads/avatar'),
    backup: path.resolve(root, 'storage/backups'),
  },
  mail: {
    host: process.env.MAIL_HOST || '',
    port: parseInt(process.env.MAIL_PORT || '587', 10),
    secure: String(process.env.MAIL_SECURE || 'false') === 'true',
    user: process.env.MAIL_USER || '',
    pass: process.env.MAIL_PASS || '',
    from: process.env.MAIL_FROM || 'Venlix Nodes <no-reply@venlix.local>',
  },
  wallpaperApiKey: process.env.WALLPAPERS_API_KEY || '',
};

module.exports = config;
