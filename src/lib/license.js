/**
 * Venlix licensing & install auth.
 *
 *  - Install auth key: install.sh gates on it. 5 wrong attempts blacklist the
 *    server so installation is refused; the unlock password clears the list.
 *  - Weekly license: keys are HMAC-SHA256(LICENSE_SECRET, 'vpanel-license:' +
 *    ISO week) formatted as 4 groups of 6 uppercase hex chars. A valid key for
 *    the current or the previous week grants 7 more days. Once the grant is
 *    expired EVERY page redirects to the license page, all VMs are powered off,
 *    and entering a valid key restarts the servers that were running.
 *
 * Values are read from VNLX_AUTH_KEY / VNLX_UNLOCK_PASSWORD /
 * VNLX_LICENSE_SECRET and fall back to the built-in defaults (see DEFAULTS).
 * Changing any of them in .env automatically changes the accepted keys.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const DEFAULTS = {
  AUTH_KEY: 'dHlbT-bU2OT-6UYJ0-y7plo',
  UNLOCK_PASSWORD: 'ibjcS-VXiXK-bgp2i-edlqV',
  LICENSE_SECRET: 'Ownp2-r2GZS-wMfCJ-J5U8z-iJXZt-Yjm9D-yTgf9-Wugmh',
};

const LICENSING_FILE = path.join(config.root, 'data', 'licensing.json');
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_AUTH_ATTEMPTS = 5;

function envOr(name, def) {
  const v = process.env['VNLX_' + name];
  return (v !== undefined && v !== null && String(v).trim() !== '') ? String(v).trim() : def;
}

function normalize(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function defaultState() {
  return {
    authAttempts: 0,
    blacklisted: false,
    grantedAt: null,
    expiresAt: null,
    shutdownForLicense: [],
    lastAction: null,
  };
}

function loadState() {
  let st;
  try {
    st = Object.assign(defaultState(), JSON.parse(fs.readFileSync(LICENSING_FILE, 'utf8')));
  } catch (_) {
    st = defaultState();
  }
  if (!Array.isArray(st.shutdownForLicense)) st.shutdownForLicense = [];
  return st;
}

function saveState(st) {
  try {
    fs.mkdirSync(path.dirname(LICENSING_FILE), { recursive: true });
    fs.writeFileSync(LICENSING_FILE, JSON.stringify(st, null, 2), 'utf8');
  } catch (e) { /* state persistence is best-effort */ }
}

// Fresh installs get a one-week grace before the first license is required,
// matching "panel works until a week passes, then a key is needed".
function ensureGrace(now) {
  const st = loadState();
  if (st.expiresAt) return st;
  st.grantedAt = new Date(now).toISOString();
  st.expiresAt = now + WEEK_MS;
  saveState(st);
  return st;
}

// ---- Install auth key ----

function authVerify(key) {
  const st = loadState();
  if (st.blacklisted) {
    return { ok: false, blacklisted: true, error: 'This server is blacklisted. Enter the unlock password to enable installation again.' };
  }
  const provided = normalize(key);
  if (provided && safeEqual(provided, normalize(envOr('AUTH_KEY', DEFAULTS.AUTH_KEY)))) {
    if (st.authAttempts) { st.authAttempts = 0; saveState(st); }
    return { ok: true };
  }
  st.authAttempts = (st.authAttempts || 0) + 1;
  if (st.authAttempts >= MAX_AUTH_ATTEMPTS) {
    st.blacklisted = true;
    saveState(st);
    return { ok: false, blacklisted: true, attempts: st.authAttempts, error: 'Too many wrong attempts. This server is now blacklisted.' };
  }
  saveState(st);
  return { ok: false, attempts: st.authAttempts, error: 'Invalid authorization key.' + ' (' + st.authAttempts + '/' + MAX_AUTH_ATTEMPTS + ')' };
}

function unlock(password) {
  const st = loadState();
  const target = normalize(envOr('UNLOCK_PASSWORD', DEFAULTS.UNLOCK_PASSWORD));
  if (!normalize(password) || !safeEqual(normalize(password), target)) {
    return { ok: false, error: 'Incorrect unlock password.' };
  }
  st.blacklisted = false;
  st.authAttempts = 0;
  saveState(st);
  return { ok: true, message: 'Unlocked. You can install the panel again.' };
}

// ---- Weekly license ----

function isoWeekOf(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Monday = 0
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((date - firstThursday) / (7 * DAY_MS));
  return date.getUTCFullYear() + '-' + String(week).padStart(2, '0');
}

// Raw 24-char uppercase hex code for a given week (keys handed to customers use
// displayLicense() which adds the dashes).
function licenseCode(date = new Date()) {
  return crypto.createHmac('sha256', envOr('LICENSE_SECRET', DEFAULTS.LICENSE_SECRET))
    .update('vpanel-license:' + isoWeekOf(date))
    .digest('hex')
    .toUpperCase()
    .slice(0, 24);
}

function displayLicense(date = new Date()) {
  return licenseCode(date).match(/.{1,6}/g).join('-');
}

function isValidKey(key) {
  const target = normalize(key);
  if (!target) return false;
  const now = new Date();
  return target === licenseCode(now) || target === licenseCode(new Date(now.getTime() - WEEK_MS));
}

function activate(key) {
  if (!isValidKey(key)) {
    return { ok: false, error: 'Invalid license key. Check the key (current or previous week) and try again.' };
  }
  const st = loadState();
  st.grantedAt = new Date().toISOString();
  st.expiresAt = Date.now() + WEEK_MS;
  if (st.lastAction === 'locked') st.lastAction = 'unlocked';
  saveState(st);
  return { ok: true, message: 'License activated. The panel is unlocked for another 7 days.' };
}

function isLocked() {
  const st = ensureGrace(Date.now());
  return Date.now() > st.expiresAt;
}

function status() {
  const st = ensureGrace(Date.now());
  const locked = Date.now() > st.expiresAt;
  return {
    blacklisted: st.blacklisted,
    authAttempts: st.authAttempts || 0,
    grantedAt: st.grantedAt,
    expiresAt: st.expiresAt,
    locked,
    daysLeft: locked ? 0 : Math.max(0, Math.ceil((st.expiresAt - Date.now()) / DAY_MS)),
    currentLicense: displayLicense(),
  };
}

// ---- Express middleware ----

function submitLicense(req, res) {
  let key = '';
  try { key = (req.body && req.body.key) || ''; } catch (_) {}
  const r = activate(String(key).trim());
  if (!r.ok) return res.status(401).json({ ok: false, error: r.error });
  return res.json({ ok: true, message: r.message });
}

function webGate(req, res, next) {
  if (!isLocked()) return next();
  return res.redirect('/license');
}

function apiGate(req, res, next) {
  if (!isLocked()) return next();
  return res.status(403).json({ error: 'License expired. Submit a valid license key via POST /api/license/submit.' });
}

// ---- Enforcer: power VMs off when locked, restart them when unlocked ----

function log(msg) {
  try { require('./logger').info(msg); } catch (_) { console.error(msg); }
}

function tick() {
  const st = ensureGrace(Date.now());
  const locked = Date.now() > st.expiresAt;
  if (locked && st.lastAction !== 'locked') {
    let vmService;
    try { vmService = require('../services/vmService'); } catch (_) {}
    if (vmService) {
      for (const vm of (vmService.dbVms ? vmService.dbVms() : [])) {
        try {
          if (vmService.isRunning(vm)) {
            vmService.stop(vm);
            if (st.shutdownForLicense.indexOf(vm.id) === -1) st.shutdownForLicense.push(vm.id);
          }
        } catch (_) {}
      }
    }
    st.lastAction = 'locked';
    saveState(st);
    log('[license] EXPIRED - panel locked, all VMs powered off.');
  } else if (!locked && st.lastAction === 'locked') {
    let vmService;
    try { vmService = require('../services/vmService'); } catch (_) {}
    const ids = st.shutdownForLicense || [];
    st.shutdownForLicense = [];
    st.lastAction = 'unlocked';
    saveState(st);
    if (vmService) {
      for (const id of ids) {
        try {
          const vm = vmService.getVm(id);
          if (vm && !vmService.isRunning(vm)) vmService.start(vm);
        } catch (_) {}
      }
    }
    log('[license] valid key entered - unlocked, previously running VMs restarted.');
  }
}

let _tickTimer = null;
function startTick(intervalMs = 60 * 1000) {
  if (_tickTimer) return;
  tick();
  _tickTimer = setInterval(tick, intervalMs);
  if (_tickTimer.unref) _tickTimer.unref();
}

module.exports = {
  authVerify,
  unlock,
  makeLicense: displayLicense,
  isValidKey,
  activate,
  isLocked,
  status,
  submitLicense,
  webGate,
  apiGate,
  tick,
  startTick,
  DEFAULTS,
};