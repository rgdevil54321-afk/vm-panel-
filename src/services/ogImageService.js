'use strict';
// Branded 1200x630 PNG for link unfurls, rendered with a tiny built-in
// rasteriser + zlib PNG encoder. Avoids a native image dependency and, unlike
// the uploaded logo (often .webp) or an SVG, is a format Discord actually
// renders in a link embed.

const zlib = require('zlib');

const W = 1200;
const H = 630;

const FONT = {
  A: '01110,10001,10001,11111,10001,10001,10001',
  B: '11110,10001,10001,11110,10001,10001,11110',
  C: '01110,10001,10000,10000,10000,10001,01110',
  D: '11110,10001,10001,10001,10001,10001,11110',
  E: '11111,10000,10000,11110,10000,10000,11111',
  F: '11111,10000,10000,11110,10000,10000,10000',
  G: '01110,10001,10000,10111,10001,10001,01111',
  H: '10001,10001,10001,11111,10001,10001,10001',
  I: '11111,00100,00100,00100,00100,00100,11111',
  J: '00111,00010,00010,00010,00010,10010,01100',
  K: '10001,10010,10100,11000,10100,10010,10001',
  L: '10000,10000,10000,10000,10000,10000,11111',
  M: '10001,11011,10101,10101,10001,10001,10001',
  N: '10001,10001,11001,10101,10011,10001,10001',
  O: '01110,10001,10001,10001,10001,10001,01110',
  P: '11110,10001,10001,11110,10000,10000,10000',
  Q: '01110,10001,10001,10001,10101,10010,01101',
  R: '11110,10001,10001,11110,10100,10010,10001',
  S: '01111,10000,10000,01110,00001,00001,11110',
  T: '11111,00100,00100,00100,00100,00100,00100',
  U: '10001,10001,10001,10001,10001,10001,01110',
  V: '10001,10001,10001,10001,10001,01010,00100',
  W: '10001,10001,10001,10101,10101,11011,10001',
  X: '10001,10001,01010,00100,01010,10001,10001',
  Y: '10001,10001,01010,00100,00100,00100,00100',
  Z: '11111,00001,00010,00100,01000,10000,11111',
  0: '01110,10001,10011,10101,11001,10001,01110',
  1: '00100,01100,00100,00100,00100,00100,01110',
  2: '01110,10001,00001,00010,00100,01000,11111',
  3: '11111,00010,00100,00010,00001,10001,01110',
  4: '00010,00110,01010,10010,11111,00010,00010',
  5: '11111,10000,11110,00001,00001,10001,01110',
  6: '00110,01000,10000,11110,10001,10001,01110',
  7: '11111,00001,00010,00100,01000,01000,01000',
  8: '01110,10001,10001,01110,10001,10001,01110',
  9: '01110,10001,10001,01111,00001,00010,01100',
  ' ': '00000,00000,00000,00000,00000,00000,00000',
  '-': '00000,00000,00000,11111,00000,00000,00000',
  '.': '00000,00000,00000,00000,00000,01100,01100',
  ',': '00000,00000,00000,00000,01100,00100,01000',
  ':': '00000,01100,01100,00000,01100,01100,00000',
  '&': '01100,10010,10100,01000,10101,10010,01101',
  '!': '00100,00100,00100,00100,00100,00000,00100',
  '?': '01110,10001,00001,00010,00100,00000,00100',
  "'": '00100,00100,00000,00000,00000,00000,00000',
  '/': '00001,00010,00010,00100,01000,01000,10000',
  '(': '00010,00100,01000,01000,01000,00100,00010',
  ')': '01000,00100,00010,00010,00010,00100,01000',
  '+': '00000,00100,00100,11111,00100,00100,00000',
};

const GLYPH_W = 5;
const GLYPH_H = 7;

function glyph(ch) {
  return FONT[ch] || FONT['?'];
}

function hexToRgb(hex) {
  const m = String(hex || '').trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return [99, 102, 241];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function textWidth(text, scale) {
  return String(text || '').length * (GLYPH_W + 1) * scale - scale;
}

// Greedy word wrap to a pixel width.
function wrap(text, scale, maxWidth) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? line + ' ' + word : word;
    if (textWidth(candidate, scale) <= maxWidth || !line) line = candidate;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

function render(opts = {}) {
  const cfg = {
    name: String(opts.name || 'Venlix Nodes'),
    desc: String(opts.desc || 'Fast NVMe storage, DDoS protection and private Tailscale networking.'),
    accent: String(opts.accent || '#6366f1'),
  };
  const rgb = Buffer.alloc(W * H * 3);
  const [ar, ag, ab] = hexToRgb(cfg.accent);

  // Diagonal gradient background.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = (x / W + y / H) / 2;
      const i = (y * W + x) * 3;
      rgb[i] = Math.round(11 + (22 - 11) * t);
      rgb[i + 1] = Math.round(16 + (27 - 16) * t);
      rgb[i + 2] = Math.round(32 + (51 - 32) * t);
    }
  }

  const rect = (x0, y0, w, h, r, g, b, alpha) => {
    for (let y = Math.max(0, y0); y < Math.min(H, y0 + h); y++) {
      for (let x = Math.max(0, x0); x < Math.min(W, x0 + w); x++) {
        const i = (y * W + x) * 3;
        if (alpha >= 1) {
          rgb[i] = r; rgb[i + 1] = g; rgb[i + 2] = b;
        } else {
          rgb[i] = Math.round(rgb[i] * (1 - alpha) + r * alpha);
          rgb[i + 1] = Math.round(rgb[i + 1] * (1 - alpha) + g * alpha);
          rgb[i + 2] = Math.round(rgb[i + 2] * (1 - alpha) + b * alpha);
        }
      }
    }
  };

  // Soft accent glows in opposite corners.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d1 = Math.hypot(x - 1080, y - 90);
      const d2 = Math.hypot(x - 110, y - 570);
      let a = Math.max(0, 0.26 * (1 - d1 / 460));
      a += Math.max(0, 0.16 * (1 - d2 / 380));
      if (a > 0) {
        const i = (y * W + x) * 3;
        rgb[i] = Math.round(rgb[i] * (1 - a) + ar * a);
        rgb[i + 1] = Math.round(rgb[i + 1] * (1 - a) + ag * a);
        rgb[i + 2] = Math.round(rgb[i + 2] * (1 - a) + ab * a);
      }
    }
  }

  const text = (str, x0, y0, scale, r, g, b) => {
    let cx = x0;
    for (const raw of String(str || '')) {
      const ch = raw.toUpperCase();
      const rows = glyph(ch).split(',');
      for (let gy = 0; gy < GLYPH_H; gy++) {
        for (let gx = 0; gx < GLYPH_W; gx++) {
          if (rows[gy][gx] !== '1') continue;
          rect(cx + gx * scale, y0 + gy * scale, scale, scale, r, g, b, 1);
        }
      }
      cx += (GLYPH_W + 1) * scale;
    }
  };

  // Logo tile + first letter of the panel name.
  rect(72, 70, 104, 104, ar, ag, ab, 1);
  const initial = cfg.name.trim().charAt(0).toUpperCase() || 'V';
  const initScale = 9;
  text(initial, 72 + (104 - textWidth(initial, initScale)) / 2, 70 + (104 - GLYPH_H * initScale) / 2, initScale, 255, 255, 255);

  // Panel name beside the tile.
  const name = cfg.name.slice(0, 22);
  text(name, 200, 104, 6, 255, 255, 255);

  // Headline.
  text('RELIABLE KVM VPS HOSTING', 74, 250, 5, 232, 236, 255);

  // Description, wrapped.
  const lines = wrap(cfg.desc, 3, 1040).slice(0, 3);
  lines.forEach((ln, idx) => text(ln, 74, 322 + idx * 34, 3, 169, 178, 214));

  // Feature pills.
  const pillY = 470;
  const pills = ['NVME', 'DDOS', 'TAILSCALE'];
  let px = 74;
  for (const p of pills) {
    const pw = textWidth(p, 3) + 56;
    rect(px, pillY, pw, 52, ar, ag, ab, 0.22);
    text(p, px + 28, pillY + 15, 3, 223, 228, 255);
    px += pw + 16;
  }

  // Credit line.
  text('MADE BY TIRED MC', 74, 566, 3, 127, 137, 181);

  return encodePng(rgb);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(rgb) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0;
    rgb.copy(raw, y * (1 + W * 3) + 1, y * W * 3, (y + 1) * W * 3);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { render, W, H };
