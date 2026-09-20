// Discord Gateway presence connection for the Venlix bot.
// REST-only bots show as OFFLINE in Discord. This lightweight gateway client
// connects with intents=0 (no events needed), keeps the heartbeat alive and
// announces an online presence so the bot appears ONLINE in every server it
// belongs to. A status manager offers presence state (online/idle/dnd),
// activity type (Playing/Watching/...) and rotating status lines.
// If the 'ws' module is not available the gateway is skipped and the bot keeps
// working in REST mode (just appears offline).
'use strict';

let WebSocket = null;
try { WebSocket = require('ws'); } catch (_) { /* ws optional */ }

const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';

const ACTIVITY_TYPES = { playing: 0, streaming: 1, listening: 2, watching: 3, custom: 4, competing: 5 };

let ws = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let rotationTimer = null;
let heartbeatAck = true;
let lastSeq = null;
let sessionId = null;
let reconnectAttempts = 0;
let stopped = true;
let rotationIndex = 0;

function db() { return require('../lib/db'); }

function token() {
  return String(db().settings.get('bot.token') || '').trim();
}

function configured() { return !!token(); }

function enabled() {
  return String(db().settings.get('bot.enabled') || '0') === '1';
}

function get(k, d) {
  const v = db().settings.get(k);
  return v === undefined || v === null ? d : v;
}

function presenceState() {
  const s = String(get('bot.presence_state', 'online')).toLowerCase();
  return s === 'idle' || s === 'dnd' ? s : 'online';
}

function activityType() {
  const t = String(get('bot.presence_type', 'watching')).toLowerCase();
  return ACTIVITY_TYPES[t] !== undefined ? t : 'watching';
}

function statusLines() {
  const raw = String(get('bot.presence', ''));
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return lines.length ? lines : ['Venlix panel'];
}

function rotateEnabled() { return String(get('bot.presence_rotate', '1')) === '1'; }

function rotateInterval() {
  const s = parseInt(get('bot.presence_interval', '30'), 10);
  return Math.max(10, Math.min(600, s || 30));
}

function buildActivity(name) {
  const t = activityType();
  const activity = { name: String(name || 'Venlix panel').slice(0, 128), type: ACTIVITY_TYPES[t] };
  if (t === 'streaming') activity.url = 'https://twitch.tv/venlix';
  return activity;
}

function presence() {
  return {
    status: presenceState(),
    since: null,
    afk: false,
    activities: [buildActivity(statusLines()[rotationIndex] || statusLines()[0])],
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function sendPresence() {
  if (!stopped) send({ op: 3, d: presence() });
}

function startRotation() {
  if (rotationTimer) clearInterval(rotationTimer);
  rotationTimer = null;
  if (!rotateEnabled() || statusLines().length < 2) { rotationIndex = 0; return; }
  rotationTimer = setInterval(() => {
    rotationIndex = (rotationIndex + 1) % statusLines().length;
    sendPresence();
  }, rotateInterval() * 1000);
  if (rotationTimer.unref) rotationTimer.unref();
}

function clearTimers() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (rotationTimer) { clearInterval(rotationTimer); rotationTimer = null; }
}

function closeRaw() {
  if (ws) {
    try { ws.removeAllListeners(); ws.close(); } catch (_) { /* ignore */ }
  }
  ws = null;
}

function scheduleReconnect() {
  clearTimers();
  if (stopped) return;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
  reconnectAttempts++;
  reconnectTimer = setTimeout(connect, delay);
}

function onMessage(raw) {
  let msg;
  try { msg = JSON.parse(String(raw)); } catch (_) { return; }
  if (msg.s !== undefined && msg.s !== null) lastSeq = msg.s;

  switch (msg.op) {
    case 10: { // HELLO
      reconnectAttempts = 0;
      const iv = (msg.d && msg.d.heartbeat_interval) || 41250;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatAck = true;
      heartbeatTimer = setInterval(() => {
        if (!heartbeatAck && ws && ws.readyState === WebSocket.OPEN) { ws.terminate(); return; }
        heartbeatAck = false;
        send({ op: 1, d: lastSeq });
      }, iv);
      if (rotationTimer) { clearInterval(rotationTimer); rotationTimer = null; }
      startRotation();
      if (sessionId && lastSeq != null) {
        send({ op: 6, d: { token: token(), session_id: sessionId, seq: lastSeq } });
      } else {
        send({ op: 2, d: { token: token(), intents: 0, properties: { os: 'linux', browser: 'VenlixNodes', device: 'VenlixNodes' }, presence: presence() } });
      }
      break;
    }
    case 1: // server-requested heartbeat
      send({ op: 1, d: lastSeq });
      break;
    case 11: // HEARTBEAT_ACK
      heartbeatAck = true;
      break;
    case 7: // RECONNECT
      scheduleReconnect();
      break;
    case 9: // INVALID_SESSION (d=false means no resume possible)
      if (!msg.d) { sessionId = null; lastSeq = null; }
      scheduleReconnect();
      break;
    case 0: // DISPATCH
      if (msg.t === 'READY') sessionId = (msg.d && msg.d.session_id) || null;
      if (msg.t === 'READY' || msg.t === 'RESUMED') sendPresence();
      break;
    default:
      break;
  }
}

function connect() {
  if (stopped || !WebSocket || !configured() || !enabled()) return;
  try {
    ws = new WebSocket(GATEWAY, { perMessageDeflate: true });
    ws.on('open', () => { /* nothing to send until HELLO */ });
    ws.on('message', onMessage);
    ws.on('error', () => { /* handled by close */ });
    ws.on('close', () => {
      ws = null;
      if (!stopped) {
        try { if (heartbeatTimer) clearInterval(heartbeatTimer); } catch (_) { /* ignore */ }
        heartbeatTimer = null;
        heartbeatAck = true;
        scheduleReconnect();
      }
    });
  } catch (_) {
    scheduleReconnect();
  }
}

function isRunning() {
  return !!(ws && WebSocket && ws.readyState === WebSocket.OPEN);
}

function isAvailable() { return !!WebSocket; }

function start() {
  stopped = false;
  startRotation();
  if (!isRunning()) connect();
}

function stop() {
  stopped = true;
  reconnectAttempts = 0;
  clearTimers();
  closeRaw();
}

function sync() {
  if (configured() && enabled()) start();
  else stop();
}

// Re-read presence settings, rebuild the rotation and push the current status.
function refresh() {
  startRotation();
  if (isRunning()) sendPresence();
}

function setPresence(text) {
  db().settings.set('bot.presence', String(text || ''));
  refresh();
}

function state() {
  const lines = statusLines();
  return {
    available: isAvailable(),
    running: isRunning(),
    intended: configured() && enabled(),
    state: presenceState(),
    type: activityType(),
    lines: lines.length,
    current: lines[rotationIndex] || lines[0] || '',
    rotate: rotateEnabled(),
    interval: rotateInterval(),
  };
}

module.exports = {
  start, stop, sync, refresh, setPresence, state,
  isRunning, isAvailable, configured, enabled,
};