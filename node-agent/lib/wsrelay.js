'use strict';
// Minimal RFC6455 WebSocket <-> raw TCP relay (Node built-ins only).
// Used to expose the QEMU VNC port (bound to loopback) to the Venlix panel.
const crypto = require('crypto');
const net = require('net');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 32 * 1024 * 1024;

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function buildFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

function closeFrame(code = 1000, reason = '') {
  const body = Buffer.alloc(2 + Buffer.byteLength(reason));
  body.writeUInt16BE(code, 0);
  body.write(reason, 2);
  return buildFrame(0x8, body);
}

// Streams a WebSocket session to a TCP socket.
function relay(socket, tcp, log) {
  const pending = [];
  let tcpReady = false;

  function tcpWrite(data) {
    if (tcpReady) tcp.write(data);
    else pending.push(data);
  }

  tcp.on('connect', () => {
    tcpReady = true;
    while (pending.length) tcp.write(pending.shift());
  });

  // WebSocket frame parser (client -> server, masked frames, binary/text/continuation).
  let buf = Buffer.alloc(0);
  let fragOpcode = null;
  let fragParts = [];

  function handleFrame(opcode, payload, fin) {
    if (opcode === 0x8) {
      try { socket.write(closeFrame(1000)); } catch (_) {}
      safeDestroy(socket);
      return;
    }
    if (opcode === 0x9) {
      try { socket.write(buildFrame(0xa, payload)); } catch (_) {}
      return;
    }
    if (opcode === 0x1 || opcode === 0x2) {
      if (fin) tcpWrite(payload);
      else { fragOpcode = opcode; fragParts = [payload]; }
      return;
    }
    if (opcode === 0x0) {
      fragParts.push(payload);
      if (fin) {
        tcpWrite(Buffer.concat(fragParts));
        fragOpcode = null;
        fragParts = [];
      }
      return;
    }
  }

  function processBuffer() {
    while (buf.length >= 2) {
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_PAYLOAD)) return safeDestroy(socket);
        len = Number(big);
        offset = 10;
      }
      let maskKey = null;
      if (masked) {
        if (buf.length < offset + 4) return;
        maskKey = buf.slice(offset, offset + 4);
        offset += 4;
      }
      if (buf.length < offset + len) return;
      let payload = buf.slice(offset, offset + len);
      if (masked) {
        const unmasked = Buffer.alloc(len);
        for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
        payload = unmasked;
      }
      buf = buf.slice(offset + len);
      handleFrame(opcode, payload, fin);
    }
  }

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    processBuffer();
  });

  // TCP -> client: single binary frame per chunk (VNC input to noVNC).
  tcp.on('data', (data) => {
    try { socket.write(buildFrame(0x2, data)); } catch (_) {}
  });

  const cleanup = () => {
    try { tcp.destroy(); } catch (_) {}
    try { socket.destroy(); } catch (_) {}
  };
  socket.on('close', () => { if (fragOpcode) { fragOpcode = null; fragParts = []; } cleanup(); });
  socket.on('error', cleanup);
  tcp.on('error', cleanup);
  tcp.on('close', () => {
    try { socket.end(buildFrame(0x8, Buffer.from([3, 232]))); } catch (_) {}
  });
}

function safeDestroy(s) {
  try { s.destroy(); } catch (_) {}
}

// Handle an HTTP upgrade request for /vncws/:vmId
function handleUpgrade(req, socket, head, { auth, getVncPort }) {
  const m = req.url.match(/^\/vncws\/([^/?#]+)/);
  if (!m) return safeDestroy(socket);

  const id = decodeURIComponent(m[1]);
  if (!auth(req)) {
    try {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    } catch (_) {}
    return safeDestroy(socket);
  }

  const key = req.headers['sec-websocket-key'];
  if (!key) return safeDestroy(socket);

  let port = null;
  try { port = getVncPort(id); } catch (_) {}
  if (!port) {
    try {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    } catch (_) {}
    return safeDestroy(socket);
  }

  try {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n'
    );
  } catch (_) {
    return safeDestroy(socket);
  }
  if (head && head.length) socket.unshift(head);

  const tcp = net.connect({ host: '127.0.0.1', port });
  relay(socket, tcp, () => {});
}

module.exports = { handleUpgrade };