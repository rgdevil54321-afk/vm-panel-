const fs = require('fs');
const path = require('path');
const config = require('../lib/config');
const logger = require('../lib/logger');

const DIR = path.join(config.root, 'data', 'panel-codes');
fs.mkdirSync(DIR, { recursive: true });
const CODE_PREFIX = 'vpanel-dbx1.';

function dbConn() { return require('../lib/db').db; }
function settingsConn() { return require('../lib/db').settings; }

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// Consistent snapshot of the live SQLite DB (safe with WAL).
async function capture() {
  const db = dbConn();
  const tmp = path.join(DIR, 'capture-' + stamp() + '.db');
  await db.backup(tmp);
  const buf = fs.readFileSync(tmp);
  try { fs.unlinkSync(tmp); } catch (_) {}
  return buf;
}

function counts() {
  const db = dbConn();
  const out = { vms: 0, users: 0, nodes: 0 };
  try {
    out.vms = db.prepare('SELECT COUNT(*) AS c FROM vms').get().c || 0;
  } catch (_) {}
  try {
    out.users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c || 0;
  } catch (_) {}
  try {
    out.nodes = db.prepare('SELECT COUNT(*) AS c FROM nodes').get().c || 0;
  } catch (_) {}
  return out;
}

function encode(buf, meta) {
  const header = Buffer.from(JSON.stringify(meta)).toString('base64');
  return CODE_PREFIX + header + '.' + buf.toString('base64');
}

function decode(code) {
  let s = String(code || '').trim();
  if (!s) throw new Error('Empty transfer code');
  if (s.startsWith(CODE_PREFIX)) s = s.slice(CODE_PREFIX.length);
  const dot = s.indexOf('.');
  if (dot <= 0) throw new Error('Invalid transfer code format');
  let header;
  try {
    header = JSON.parse(Buffer.from(s.slice(0, dot), 'base64').toString('utf8'));
  } catch (_) {
    throw new Error('Invalid transfer code header');
  }
  const buf = Buffer.from(s.slice(dot + 1), 'base64');
  if (!buf.length) throw new Error('Transfer code payload is empty');
  return { header, buf };
}

// Export the whole panel DB as a single portable "code".
async function exportCode() {
  const buf = await capture();
  const meta = { v: '1', at: new Date().toISOString(), size: buf.length, ...counts() };
  const code = encode(buf, meta);
  const file = path.join(DIR, 'panel-code-' + stamp() + '.code');
  fs.writeFileSync(file, code);
  return { code, file, size: buf.length, at: meta.at, counts: meta };
}

function latestFile() {
  const files = fs.existsSync(DIR)
    ? fs.readdirSync(DIR).filter((f) => f.endsWith('.code')).map((f) => path.join(DIR, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    : [];
  return files[0] || null;
}

// Replace the live DB with the decoded snapshot. Only safe when the panel is
// not running with that database open (fresh install / restart path).
function restoreFromCode(code) {
  const { header, buf } = decode(code);
  const target = config.dbPath;
  for (const suf of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(target + suf); } catch (_) {}
  }
  const tmp = target + '.restore';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, target);
  return header;
}

// CLI helper: restore from a code file before the panel boots.
function restoreFromCodeFile(file) {
  if (!file || !fs.existsSync(file)) throw new Error('Code file not found: ' + file);
  const header = restoreFromCode(fs.readFileSync(file, 'utf8'));
  logger.info(`[transfer] restored DB from ${path.basename(file)} (${header.at})`);
  return header;
}

async function notifyOwner(codeInfo, label) {
  try {
    const { settings } = require('../lib/db');
    if (String(settings.get('bot.enabled') || '0') !== '1') {
      logger.warn('[transfer] bot disabled - owner NOT notified for ' + label + ' (code saved to ' + path.basename(codeInfo.file) + ')');
      return;
    }
    const db = dbConn();
    const discord = require('./discordService');
    // Must match the admin test used everywhere else (role = 'admin' OR
    // root_admin = 1). Querying root_admin alone silently matched nobody on
    // panels where the owner only has role = 'admin'.
    const admins = db.prepare(
      "SELECT * FROM users WHERE (role = 'admin' OR root_admin = 1) AND discord_id IS NOT NULL AND discord_id != ''"
    ).all();
    if (!admins.length) {
      const anyAdmin = db.prepare("SELECT username, discord_id FROM users WHERE role = 'admin' OR root_admin = 1").all();
      logger.warn(
        '[transfer] no admin has a linked Discord account - owner NOT notified for ' + label +
        '. Admins: ' + (anyAdmin.length ? anyAdmin.map((a) => a.username + (a.discord_id ? '' : ' (unlinked)')).join(', ') : 'none') +
        '. Code saved to ' + path.basename(codeInfo.file) + '.'
      );
      return;
    }
    const key = String(settings.get('api.panel_key') || '');
    const base = key
      ? `\nFetchable from the panel API with header \`Authorization: Bearer ${key.slice(0, 8)}...\``
      : '';
    const short = codeInfo.code.length < 1500
      ? '\n```\n' + codeInfo.code + '\n```'
      : `\nCode saved to \`${path.basename(codeInfo.file)}\` (${(codeInfo.size / 1024).toFixed(0)} KB) — too large for a DM, fetch via the panel API instead.`;
    const msg =
      `:satellite: Panel transfer code (${label})\n` +
      `Generated: ${codeInfo.at}\n` +
      `VMs: ${codeInfo.counts.vms || 0} · Users: ${codeInfo.counts.users || 0} · Nodes: ${codeInfo.counts.nodes || 0}` +
      base + short;
    for (const a of admins) {
      try {
        const r = await discord.sendDm(a.discord_id, msg);
        if (!r || !r.ok) logger.warn('[transfer] DM notify failed: ' + ((r && r.error) || (r && r.status)));
        else logger.info('[transfer] owner notified (' + label + ') via ' + a.username);
      } catch (_) {}
    }
  } catch (e) {
    logger.warn('[transfer] notifyOwner failed: ' + e.message);
  }
}

// Emergency code written right before a crash / shutdown. A misbehaving promise
// can reject in a tight loop, and every rejection used to write a full DB
// snapshot (~250 KB), so throttle repeat reasons and prune old codes.
const EMERGENCY_MIN_GAP_MS = 5 * 60 * 1000;
const EMERGENCY_KEEP = 5;
const _lastEmergency = new Map();

function pruneOldCodes() {
  try {
    const files = fs.existsSync(DIR)
      ? fs.readdirSync(DIR).filter((f) => f.endsWith('.code')).map((f) => path.join(DIR, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
      : [];
    for (const f of files.slice(EMERGENCY_KEEP)) {
      try { fs.unlinkSync(f); } catch (_) {}
    }
  } catch (_) {}
}

async function emergencyCode(reason, { force = false } = {}) {
  const now = Date.now();
  if (!force) {
    const last = _lastEmergency.get(reason) || 0;
    if (now - last < EMERGENCY_MIN_GAP_MS) {
      logger.warn('[transfer] emergency code (' + reason + ') suppressed - same reason within ' + (EMERGENCY_MIN_GAP_MS / 60000) + 'min');
      return null;
    }
  }
  _lastEmergency.set(reason, now);
  try {
    const info = await exportCode();
    pruneOldCodes();
    logger.error('[transfer] emergency code (' + reason + ') saved: ' + path.basename(info.file));
    notifyOwner(info, 'EMERGENCY ' + reason).catch(() => {});
    return info.file;
  } catch (e) {
    logger.error('[transfer] emergency export failed: ' + e.message);
    return null;
  }
}

// Daily code + optional bot DM.
async function daily() {
  try {
    const { settings } = require('../lib/db');
    if (String(settings.get('transfer.daily_enabled') || '1') === '0') {
      logger.info('[transfer] daily export disabled (transfer.daily_enabled=0)');
      return null;
    }
    const info = await exportCode();
    logger.info('[transfer] daily code saved: ' + path.basename(info.file));
    notifyOwner(info, 'DAILY').catch(() => {});
    return info.file;
  } catch (e) {
    logger.error('[transfer] daily export failed: ' + e.message);
    return null;
  }
}

module.exports = { exportCode, restoreFromCode, restoreFromCodeFile, emergencyCode, daily, latestFile, decode, capture, DIR };