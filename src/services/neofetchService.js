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
  barColors: ['\x1b[31m','\x1b[33m','\x1b[32m','\x1b[36m','\x1b[34m','\x1b[35m','\x1b[37m','\x1b[90m'],
};

// ── ASCII "VN" logo ────────────────────────────────────────────────
const LOGO_RAW = [
  '█████      █████   ███████  ██████',
  '███████   ██████   ████████ ████████',
  '  ███████ ██████    █████████████████',
  '   ████████████     █████████████████',
  '    ██████████      █████████████████',
  '     ████████       █████████████████',
  '      ██████        █████████  ██████',
  '       ████         ███████    ██████',
];
const LOGO_WIDTH = Math.max(...LOGO_RAW.map((l) => l.length));

const LOGO_COL = LOGO_RAW.map(l => A.logo + l + A.reset);

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
    kernel: os.release(),
    host: hostname,
    uptime: getUptime(),
    packages: getPackages(),
    shell: getShell(),
    cpu: `${cpuModel} (${cpus.length} cores)`,
    gpu: getGpu(),
    memory: getMemInfo(),
    disk: getDiskInfo(),
  };
}

// ── Render ────────────────────────────────────────────────────────────
function infoLines(info) {
  const user = 'admin';
  const lines = [
    { label: user + '@' + info.host, isTitle: true },
    { key: 'OS',      val: info.os },
    { key: 'Kernel',  val: info.kernel },
    { key: 'Uptime',  val: info.uptime },
    { key: 'Packages', val: info.packages },
    { key: 'Shell',   val: info.shell },
    { key: 'CPU',     val: info.cpu },
    { key: 'GPU',     val: info.gpu },
    { key: 'Memory',  val: info.memory },
    { key: 'Disk',    val: info.disk },
  ];
  return lines;
}

function colorBar() {
  return A.barColors.map(c => c + '███').join('') + A.reset;
}

function plainBar() {
  return '████████████████████████';
}

function renderPlain() {
  const info = collect();
  const lines = infoLines(info);
  const logoW = LOGO_WIDTH;
  const rows = [];

  for (let i = 0; i < Math.max(LOGO_RAW.length, lines.length); i++) {
    const left = (i < LOGO_RAW.length ? LOGO_RAW[i] : ''.padEnd(logoW, ' ')).padEnd(logoW, ' ');
    const line = lines[i];
    let right = '';
    if (line) {
      if (line.isTitle) {
        right = line.label;
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
  const info = collect();
  const lines = infoLines(info);
  const rows = [];
  const logoW = LOGO_WIDTH;

  for (let i = 0; i < Math.max(LOGO_COL.length, lines.length); i++) {
    const rawLeft = i < LOGO_RAW.length ? LOGO_RAW[i] : ''.padEnd(logoW, ' ');
    const leftColored = A.logo + rawLeft.padEnd(logoW, ' ') + A.reset;

    const line = lines[i];
    let right = '';
    if (line) {
      if (line.isTitle) {
        right = A.title + line.label + A.reset;
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
  return LOGO_RAW.join('\n');
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
  const logoW = LOGO_WIDTH;
  const rows = [];
  for (let i = 0; i < Math.max(LOGO_RAW.length, lines.length); i++) {
    const left = (i < LOGO_RAW.length ? LOGO_RAW[i] : ''.padEnd(logoW, ' ')).padEnd(logoW, ' ');
    const line = lines[i];
    let right = '';
    if (line) {
      right = line.isTitle ? line.label : `${line.key}: ${line.val}`;
    }
    rows.push(left + '  ' + right);
  }
  rows.push('');
  rows.push(plainBar());
  return rows.join('\n');
}

// Bash wrapper that shows the VN banner through whatever fetch tool exists.
function fetchShellScript(overrides = {}) {
  const info = collect();
  if (overrides.cpu) info.cpu = String(overrides.cpu);
  if (overrides.memory) info.memory = String(overrides.memory);
  if (overrides.disk) info.disk = String(overrides.disk);
  if (overrides.host) info.host = String(overrides.host);
  const banner = renderPlainWith(info).replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
  return `#!/bin/bash
# Venlix VN banner - shown via fastfetch / neofetch / screenfetch or as-is.
if command -v fastfetch >/dev/null 2>&1; then
  exec fastfetch --logo "\${VN_LOGO:-\${HOME}/.config/venlix/vn-ascii.txt}" --logo-type file-raw "\${@}"
fi
if command -v neofetch >/dev/null 2>&1; then
  exec neofetch --ascii "\${VN_LOGO:-\${HOME}/.config/venlix/vn-ascii.txt}" --ascii_colors 4 6 "\${@}"
fi
if command -v screenfetch >/dev/null 2>&1; then
  exec screenfetch "AsciiFile=\${VN_LOGO:-\${HOME}/.config/venlix/vn-ascii.txt}" "\${@}"
fi
echo -e "\${VN_BANNER:-${banner}}"
`;
}

// A single-file text banner for MOTD / SSH login (no fetch tools required).
function motdText(overrides = {}) {
  const info = collect();
  if (overrides.cpu) info.cpu = String(overrides.cpu);
  if (overrides.memory) info.memory = String(overrides.memory);
  if (overrides.disk) info.disk = String(overrides.disk);
  if (overrides.host) info.host = String(overrides.host);
  return renderPlainWith(info);
}

// ── Exports ───────────────────────────────────────────────────────────
module.exports = {
  collect,
  infoLines,
  renderPlain,
  renderColor,
  colorBar,
  logoPlain,
  bannerText,
  motdText,
  fetchShellScript,
  LOGO_RAW,
};
