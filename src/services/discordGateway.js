// Discord Gateway presence connection for the Venlix bot.
// REST-only bots show as OFFLINE in Discord. This lightweight gateway client
// connects with intents=0 (no events needed), keeps the heartbeat alive and
// announces an online presence so the bot appears ONLINE in every server it
// belongs to. If the 'ws' module is not available the gateway is skipped and
// the bot keeps working in REST mode (just appears offline).
'use strict';

let WebSocket = null;
try { WebSocket = require('ws'); } catch (_) { /* ws optional */ }

const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';

let ws = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let heartbeatAck = true;
let lastSeq = null;
let sessionId = null;
let reconnectAttempts = 0;
let stopped = true;

function db() { return require('../lib/db'); }

function token() {
  return String(db().settings.get('bot.token') || '').trim();
}

function configured() { return !!token(); }

function enabled() {
  return String(db().settings.get('bot.enabled') || '0') === '1';
}

function presenceText() {
  const t = String(db().settings.get('bot.presence') || '').trim();
  return t.slice(0, 128) || 'Venlix panel';
}

function presence() {
  return {
    status: 'online',
    since: null,
    afk: false,
    activities: [{ name: presenceText(), type: 3 }],
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function sendPresence() { send({ op: 3, d: presence() }); }

function clearTimers() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
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

function setPresence(text) {
  db().settings.set('bot.presence', String(text || '').trim());
  if (isRunning()) sendPresence();
}

function state() {
  return {
    available: isAvailable(),
    running: isRunning(),
    intended: configured() && enabled(),
    presence: String(db().settings.get('bot.presence') || ''),
  };
}

module.exports = {
  start, stop, sync, setPresence, state,
  isRunning, isAvailable, configured, enabled, presenceText,
};