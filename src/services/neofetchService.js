'use strict';
const os = require('os');
const { execSync } = require('child_process');
const { settings } = require('../lib/db');

// ── ANSI helpers ─────────────────────────────────────────────────────
const A = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  // neofetch palette
  title: '\x1b[1;33m',   // bold yellow  (username)
  at: '\x1b[0;37m',      // white @
  host: '\x1b[1;33m',    // bold yellow  (hostname)
  key: '\x1b[1;36m',     // bold cyan    (labels)
  sep: '\x1b[0;37m',     // white        (separator : / @)
  val: '\x1b[0m',        // normal       (values)
  logo: '\x1b[1;34m',    // bold blue    (V logo)
  bar: '\x1b[0;37m',
  barColors: ['\x1b[31m','\x1b[33m','\x1b[32m','\x1b[36m','\x1b[34m','\x1b[35m','\x1b[37m','\x1b[90m','\x1b[91m','\x1b[93m','\x1b[92m','\x1b[96m','\x1b[94m','\x1b[95m','\x1b[97m','\x1b[90m'],
};

// ── Configurable block logo (default "VN") ─────────────────────────
// 5-row block font so the panel logo can be any short text (A-Z, 0-9, space).
const BLOCK_FONT = {
  'A': [' ██ ', '█  █', '████', '█  █', '█  █'],
  'B': ['███ ', '█  █', '███ ', '█  █', '███ '],
  'C': [' ███', '█   ', '█   ', '█   ', ' ███'],
  'D': ['███ ', '█  █', '█  █', '█  █', '███ '],
  'E': ['████', '█   ', '███ ', '█   ', '████'],
  'F': ['████', '█   ', '███ ', '█   ', '█   '],
  'G': [' ███', '█   ', '█ ██', '█  █', ' ███'],
  'H': ['█  █', '█  █', '████', '█  █', '█  █'],
  'I': ['████', ' ██ ', ' ██ ', ' ██ ', '████'],
  'J': ['  ██', '  ██', '  ██', '█ ██', ' ██ '],
  'K': ['█  █', '█ █ ', '██  ', '█ █ ', '█  █'],
  'L': ['█   ', '█   ', '█   ', '█   ', '████'],
  'M': ['█  █', '████', '█  █', '█  █', '█  █'],
  'N': ['█  █', '██ █', '█ ██', '█  █', '█  █'],
  'O': [' ██ ', '█  █', '█  █', '█  █', ' ██ '],
  'P': ['███ ', '█  █', '███ ', '█   ', '█   '],
  'Q': [' ██ ', '█  █', '█  █', '█ ██', ' ███'],
  'R': ['███ ', '█  █', '███ ', '█ █ ', '█  █'],
  'S': [' ███', '█   ', ' ██ ', '   █', '███ '],
  'T': ['████', ' ██ ', ' ██ ', ' ██ ', ' ██ '],
  'U': ['█  █', '█  █', '█  █', '█  █', ' ██ '],
  'V': ['█  █', '█  █', '█  █', ' ██ ', ' ██ '],
  'W': ['█  █', '█  █', '████', '████', '█  █'],
  'X': ['█  █', ' ██ ', ' ██ ', ' ██ ', '█  █'],
  'Y': ['█  █', '█  █', ' ██ ', ' ██ ', ' ██ '],
  'Z': ['████', '   █', ' ██ ', '█   ', '████'],
  '0': [' ██ ', '█  █', '█  █', '█  █', ' ██ '],
  '1': [' ██ ', '███ ', ' ██ ', ' ██ ', '████'],
  '2': [' ██ ', '█  █', '  █ ', ' █  ', '████'],
  '3': ['███ ', '  █ ', ' ██ ', '  █ ', '███ '],
  '4': ['█ █ ', '█ █ ', '████', '  █ ', '  █ '],
  '5': ['████', '█   ', '███ ', '   █', '███ '],
  '6': [' ██ ', '█   ', '███ ', '█  █', ' ██ '],
  '7': ['████', '  █ ', ' █  ', ' █  ', ' █  '],
  '8': [' ██ ', '█  █', ' ██ ', '█  █', ' ██ '],
  '9': [' ██ ', '█  █', ' ███', '   █', ' ██ '],
  '?': [' ██ ', '█  █', '  █ ', '    ', '  █ '],
  ' ': ['    ', '    ', '    ', '    ', '    '],
};
const DEFAULT_LOGO_TEXT = 'VN';
function logoText() {
  const raw = String(settings.get('panel.logo_text') || DEFAULT_LOGO_TEXT).toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim();
  return (raw || DEFAULT_LOGO_TEXT).slice(0, 4);
}

// ── Optional pixel/block logo drawn in the admin Neofetch designer ────
// When 'neofetch.logo_grid' is set, it replaces the block-text logo everywhere
// (banner preview, /etc/venlix/vn-ascii.txt, guest venlix-fetch, MOTD).
const LOGO_COLOR_CODES = {
  logo: '\x1b[1;34m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};
const LOGO_CHARS = new Set(('█▓▒░▄▀▌▐─│┼┌┐└┘┬├┤┴•●○■□◆◇★☆+-*/\\=<>^_|:.~@#%&$!?0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz').split(''));

// Sanitize a grid sent from the admin designer into { grid: [[{ch,fg}…]…] }.
function sanitizeLogoGrid(raw) {
  if (!raw || !Array.isArray(raw.grid)) return null;
  const rows = raw.grid.slice(0, 40).map((r) => {
    if (!Array.isArray(r)) return [];
    return r.slice(0, 60).map((c) => {
      const ch = String((c && c.ch) || ' ');
      return { ch: LOGO_CHARS.has(ch) ? ch : ' ', fg: (c && c.fg && LOGO_COLOR_CODES[c.fg]) ? c.fg : null };
    });
  });
  while (rows.length && rows[rows.length - 1].every((c) => !c.ch || c.ch === ' ')) rows.pop();
  if (!rows.length) return null;
  return { grid: rows };
}

function customLogoGrid() {
  let raw = settings.get('neofetch.logo_grid');
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch (_) { return null; }
  }
  return sanitizeLogoGrid(raw);
}

// Resolve the effective logo art. Custom grid -> per-cell colored rows, else the
// configured block-text logo (single accent color handled by the renderer).
function logoArt() {
  const g = customLogoGrid();
  if (g) {
    const plain = g.grid.map((row) => row.map((c) => c.ch).join(''));
    const width = Math.max(...plain.map((r) => r.length), 1);
    const colored = g.grid.map((row) => row.map((c) => {
      if (!c.ch || c.ch === ' ') return ' ';
      return (LOGO_COLOR_CODES[c.fg] || A.logo) + c.ch + A.reset;
    }).join(''));
    return { plain, colored, width };
  }
  const rows = logoRows(logoText());
  return { plain: rows, colored: null, width: logoWidth(rows) };
}

// Structured grid of the current block-text logo (used to seed the designer).
function defaultLogoGrid() {
  return { grid: logoRows(logoText()).map((row) => Array.from(row).map((ch) => ({ ch, fg: ch === ' ' ? null : 'logo' }))) };
}
function logoRows(text) {
  const chars = String(text || DEFAULT_LOGO_TEXT).toUpperCase().slice(0, 4).split('');
  const base = ['', '', '', '', ''];
  chars.forEach((ch, i) => {
    const g = BLOCK_FONT[ch] || BLOCK_FONT['?'];
    for (let r = 0; r < 5; r++) base[r] += (i ? ' ' : '') + (g[r] || '    ');
  });
  // Keep the logo COMPACT (like the original): 1x horizontal so 'VN' stays ~9
  // columns wide; 2x tall keeps a chunky banner while the info lines carry the
  // detail and width. NOTE: a regenerated banner only shows up after deploy /
  // re-seeding an existing VM.
  const rows = [];
  for (const r of base) {
    rows.push(r, r);
  }
  return rows;
}
function logoWidth(rows) { return Math.max(...rows.map((l) => l.length), 1); }
const LOGO_RAW = logoRows(DEFAULT_LOGO_TEXT);
const LOGO_WIDTH = logoWidth(LOGO_RAW);

// ── System info collector ─────────────────────────────────────────────
function getGpu() {
  const custom = settings.get('panel.gpu_name');
  if (custom) return custom;
  try {
    const out = execSync("lspci 2>/dev/null | grep -iE 'vga|3d controller|display controller' | head -1", { encoding: 'utf8', timeout: 3000 }).trim();
    if (out) return out.replace(/^[0-9a-f:. ]+/, '').replace(/\[[^\]]*\]/g, '').trim() || 'Unknown GPU';
  } catch (_) {}
  return 'Unknown GPU';
}

function getUptime() {
  const secs = Math.floor(os.uptime());
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const parts = [];
  if (d) parts.push(d + ' days');
  if (h) parts.push(h + ' hours');
  parts.push(m + ' mins');
  return parts.join(', ');
}

function getMemInfo() {
  const override = settings.get('panel.ram_name');
  if (override) return override;
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const toGB = (b) => (b / 1073741824).toFixed(1);
  return `${toGB(used)} GiB / ${toGB(total)} GiB`;
}

function getDiskInfo() {
  const override = settings.get('panel.disk_name');
  if (override) return override;
  try {
    const out = execSync('df -B1 / 2>/dev/null | tail -1', { encoding: 'utf8', timeout: 3000 }).trim().split(/\s+/);
    const used = (parseInt(out[2], 10) / 1073741824).toFixed(1);
    const total = (parseInt(out[1], 10) / 1073741824).toFixed(1);
    const pct = out[4] || '?';
    return `${used} GiB / ${total} GiB (${pct})`;
  } catch (_) { return 'Unknown'; }
}

function getPackages() {
  let count = 0;
  try {
    count = parseInt(execSync('dpkg -l 2>/dev/null | grep ^ii | wc -l', { encoding: 'utf8', timeout: 3000 }).trim(), 10) || 0;
  } catch (_) {}
  return count ? `dpkg (${count})` : 'dpkg';
}

function getShell() {
  return process.env.SHELL || '/bin/bash';
}

function collect() {
  const cpus = os.cpus();
  const hostname = settings.get('panel.hostname') || 'Venlix Nodes';
  const cpuModel = settings.get('panel.cpu_name') || (cpus[0] ? cpus[0].model : 'x86_64 Processor');

  return {
    os: `${os.type()} ${os.release().split('-')[0]}`,
    model: settings.get('panel.model_name') || 'Venlix Cloud Node',
    kernel: os.release(),
    host: hostname,
    node: settings.get('panel.hostname') || 'Venlix Nodes',
    uptime: getUptime(),
    packages: getPackages(),
    shell: getShell(),
    resolution: settings.get('panel.resolution_name') || '1920x1080',
    de: settings.get('panel.de_name') || 'GNOME',
    wm: settings.get('panel.wm_name') || 'Xfwm4',
    theme: settings.get('panel.theme_name') || 'Adwaita-dark [GTK2/3]',
    terminal: settings.get('panel.terminal_name') || 'xterm-256color',
    cpu: `${cpuModel} (${cpus.length} cores)`,
    gpu: getGpu(),
    memory: getMemInfo(),
    disk: getDiskInfo(),
  };
}

// ── Render ────────────────────────────────────────────────────────────
function infoLines(info) {
  const user = info.user || 'admin';
  const title = user + '@' + info.host;
  const lines = [
    { label: title, isTitle: true },
    { isSep: true, width: title.length },
    { key: 'OS',      val: info.os },
  ];
  if (info.model) lines.push({ key: 'Model', val: info.model });
  if (info.node || info.host) lines.push({ key: 'Host', val: info.node || info.host || 'vps' });
  lines.push({ key: 'Kernel',  val: info.kernel });
  lines.push({ key: 'Uptime',  val: info.uptime });
  lines.push({ key: 'Packages', val: info.packages });
  lines.push({ key: 'Shell',   val: info.shell });
  lines.push({ key: 'Resolution', val: info.resolution });
  lines.push({ key: 'DE',      val: info.de });
  lines.push({ key: 'WM',      val: info.wm });
  lines.push({ key: 'Theme',   val: info.theme });
  lines.push({ key: 'Terminal', val: info.terminal });
  lines.push({ key: 'CPU',     val: info.cpu });
  if (info.gpu && info.gpu !== 'Unknown GPU') lines.push({ key: 'GPU', val: info.gpu });
  lines.push({ key: 'Memory',  val: info.memory });
  lines.push({ key: 'Disk',    val: info.disk });
  if (info.ipv4) lines.push({ key: 'IPv4', val: info.ipv4 });
  if (info.ipv4 && info.gateway) lines.push({ key: 'IPv4 Gateway', val: info.gateway });
  if (info.ipv6) lines.push({ key: 'IPv6', val: info.ipv6 });
  if (info.ipv6 && info.gateway6) lines.push({ key: 'IPv6 Gateway', val: info.gateway6 });
  if (info.region) lines.push({ key: 'Region', val: info.region });
  return lines;
}

function colorBar() {
  const c = A.barColors;
  const row1 = c.slice(0, 8).map((x) => x + '████').join('') + A.reset;
  const row2 = c.slice(8, 16).map((x) => x + '████').join('') + A.reset;
  return row1 + '\n' + row2;
}

function plainBar() {
  return '████████████████████████████████████████████████████████\n████████████████████████████████████████████████████████';
}

function renderPlain() {
  const info = collect();
  const lines = infoLines(info);
  const art = logoArt();
  const logo = art.plain;
  const logoW = art.width;
  const topPad = Math.max(0, Math.floor((logo.length - lines.length) / 2));
  const total = Math.max(logo.length, lines.length + topPad);
  const rows = [];

  for (let i = 0; i < total; i++) {
    const left = (i < logo.length ? logo[i] : '').padEnd(logoW, ' ');
    const li = i - topPad;
    const line = (li >= 0 && li < lines.length) ? lines[li] : null;
    let right = '';
    if (line) {
      if (line.isTitle) {
        right = line.label;
      } else if (line.isSep) {
        right = '-'.repeat(line.width || 11);
      } else {
        right = `${line.key}: ${line.val}`;
      }
    }
    rows.push(left + '  ' + right);
  }
  rows.push('');
  rows.push(plainBar());
  return rows.join('\n');
}

function renderColor() {
  return renderColorWith(collect());
}

function renderColorWith(info) {
  const lines = infoLines(info);
  const art = logoArt();
  const logo = art.plain;
  const logoW = art.width;
  const topPad = Math.max(0, Math.floor((logo.length - lines.length) / 2));
  const total = Math.max(logo.length, lines.length + topPad);
  const rows = [];

  for (let i = 0; i < total; i++) {
    const rawLeft = i < logo.length ? logo[i] : '';
    let leftColored;
    if (art.colored) {
      leftColored = (i < art.colored.length ? art.colored[i] : '') + ' '.repeat(Math.max(0, logoW - rawLeft.length));
    } else {
      leftColored = A.logo + rawLeft.padEnd(logoW, ' ') + A.reset;
    }

    const li = i - topPad;
    const line = (li >= 0 && li < lines.length) ? lines[li] : null;
    let right = '';
    if (line) {
      if (line.isTitle) {
        right = A.title + line.label + A.reset;
      } else if (line.isSep) {
        right = A.sep + '-'.repeat(line.width || 11) + A.reset;
      } else {
        right = A.key + line.key + A.sep + ': ' + A.val + line.val + A.reset;
      }
    }
    rows.push(leftColored + '  ' + right);
  }
  rows.push('');
  rows.push(colorBar());
  return rows.join('\n');
}

// ── Exportable banner artifacts (neofetch / fastfetch / screenfetch / motd) ──
function logoPlain() {
  return logoArt().plain.join('\n');
}

// Full plain banner with a configurable host/label (used for motd / SSH login).
function bannerText(hostOverride = null, overrides = {}) {
  const info = collect();
  if (hostOverride) info.host = hostOverride;
  if (overrides.cpu) info.cpu = `${overrides.cpu}`;
  if (overrides.memory) info.memory = overrides.memory;
  if (overrides.disk) info.disk = overrides.disk;
  return renderPlainWith(info);
}

function renderPlainWith(info) {
  const lines = infoLines(info);
  const art = logoArt();
  const logo = art.plain;
  const logoW = art.width;
  const topPad = Math.max(0, Math.floor((logo.length - lines.length) / 2));
  const total = Math.max(logo.length, lines.length + topPad);
  const rows = [];
  for (let i = 0; i < total; i++) {
    const left = (i < logo.length ? logo[i] : '').padEnd(logoW, ' ');
    const li = i - topPad;
    const line = (li >= 0 && li < lines.length) ? lines[li] : null;
    let right = '';
    if (line) {
      right = line.isTitle ? line.label : (line.isSep ? '-'.repeat(line.width || 11) : `${line.key}: ${line.val}`);
    }
    rows.push(left + '  ' + right);
  }
  rows.push('');
  rows.push(plainBar());
  return rows.join('\n');
}

// Bash wrapper that prints the spoofed VN banner (does NOT call the real fetch tool,
// otherwise the real CPU/RAM/disk would leak through).
function fetchShellScript(overrides = {}) {
  const info = collect();
  if (overrides.cpu) info.cpu = String(overrides.cpu);
  if (overrides.memory) info.memory = String(overrides.memory);
  if (overrides.disk) info.disk = String(overrides.disk);
  if (overrides.host) info.host = String(overrides.host);
  if (overrides.user) info.user = String(overrides.user);
  if (overrides.os) info.os = String(overrides.os);
  if (overrides.node) info.node = String(overrides.node);
  if (overrides.gpu !== undefined) info.gpu = String(overrides.gpu);
  if (overrides.ipv4) info.ipv4 = String(overrides.ipv4);
  if (overrides.ipv6) info.ipv6 = String(overrides.ipv6);
  if (overrides.gateway) info.gateway = String(overrides.gateway);
  if (overrides.gateway6) info.gateway6 = String(overrides.gateway6);
  if (overrides.region) info.region = String(overrides.region);
  const banner = renderColorWith(info);
  const b64 = Buffer.from(banner + '\n', 'utf8').toString('base64');
  return `#!/bin/bash
# Venlix VN banner - replaces neofetch / fastfetch / screenfetch output with the
# spoofed specs. Run with "--real" to launch the genuine neofetch instead.
if [ "\${1:-}" = "--real" ]; then
  shift
  for _vn_p in /usr/bin/neofetch /bin/neofetch /usr/local/bin/neofetch.venlix-real; do
    [ -x "$_vn_p" ] && exec "$_vn_p" "\${@}"
  done
  echo "neofetch is not installed" >&2
  exit 1
fi
echo '${b64}' | base64 -d
`;
}

// A single-file text banner for MOTD / SSH login (no fetch tools required).
function motdText(overrides = {}) {
  const info = collect();
  if (overrides.cpu) info.cpu = String(overrides.cpu);
  if (overrides.memory) info.memory = String(overrides.memory);
  if (overrides.disk) info.disk = String(overrides.disk);
  if (overrides.host) info.host = String(overrides.host);
  if (overrides.ipv4) info.ipv4 = String(overrides.ipv4);
  if (overrides.ipv6) info.ipv6 = String(overrides.ipv6);
  if (overrides.gateway) info.gateway = String(overrides.gateway);
  if (overrides.gateway6) info.gateway6 = String(overrides.gateway6);
  return renderPlainWith(info);
}

// ── Exports ───────────────────────────────────────────────────────────
module.exports = {
  collect,
  infoLines,
  renderPlain,
  renderColor,
  renderColorWith,
  colorBar,
  logoPlain,
  logoText,
  logoRows,
  bannerText,
  motdText,
  fetchShellScript,
  customLogoGrid,
  defaultLogoGrid,
  sanitizeLogoGrid,
  logoArt,
  LOGO_RAW,
};
