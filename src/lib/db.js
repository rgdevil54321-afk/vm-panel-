const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

if (!fs.existsSync(path.dirname(config.dbPath))) {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
}

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  root_admin INTEGER NOT NULL DEFAULT 0,
  language TEXT NOT NULL DEFAULT 'en',
  avatar TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  verify_token TEXT,
  suspended INTEGER NOT NULL DEFAULT 0,
  tfa_enabled INTEGER NOT NULL DEFAULT 0,
  tfa_secret TEXT,
  last_login_at TEXT,
  last_login_ip TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  ip TEXT,
  username TEXT,
  status TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reset_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 3005,
  agent_token TEXT NOT NULL,
  location TEXT,
  status TEXT DEFAULT 'offline',
  capacity_cpus INTEGER DEFAULT 0,
  capacity_memory_mb INTEGER DEFAULT 0,
  capacity_disk_gb INTEGER DEFAULT 0,
  last_seen_at TEXT,
  added_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER,
  uuid TEXT UNIQUE NOT NULL,
  owner_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  os_type TEXT,
  codename TEXT,
  img_url TEXT,
  hostname TEXT,
  username TEXT,
  password TEXT,
  disk_size TEXT DEFAULT '20G',
  memory INTEGER DEFAULT 2048,
  cpus INTEGER DEFAULT 2,
  ssh_port INTEGER NOT NULL,
  gui_mode INTEGER NOT NULL DEFAULT 0,
  port_forwards TEXT,
  img_file TEXT,
  seed_file TEXT,
  start_on_boot INTEGER NOT NULL DEFAULT 0,
  startup_command TEXT,
  auto_create INTEGER NOT NULL DEFAULT 1,
  status TEXT DEFAULT 'stopped',
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS subusers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vm_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  permissions TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (vm_id) REFERENCES vms(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vm_id INTEGER NOT NULL,
  name TEXT,
  file TEXT,
  size INTEGER DEFAULT 0,
  kind TEXT DEFAULT 'full',
  created_at TEXT NOT NULL,
  FOREIGN KEY (vm_id) REFERENCES vms(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vm_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  action TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (vm_id) REFERENCES vms(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  vm_id INTEGER,
  event TEXT NOT NULL,
  details TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT,
  body TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_vms_owner ON vms(owner_id);
CREATE INDEX IF NOT EXISTS idx_subusers_vm ON subusers(vm_id);
CREATE INDEX IF NOT EXISTS idx_subusers_user ON subusers(user_id);
CREATE INDEX IF NOT EXISTS idx_backups_vm ON backups(vm_id);
CREATE INDEX IF NOT EXISTS idx_schedules_vm ON schedules(vm_id);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_vm ON activity_logs(vm_id);
CREATE INDEX IF NOT EXISTS idx_login_ip ON login_attempts(ip);
`);

const defaultSettings = {
  'panel.name': 'Venlix Nodes',
  'panel.logo_mode': 'url',
  'panel.logo_url': '',
  'panel.logo_file': '',
  'panel.favicon_name': 'Venlix',
  'panel.favicon_mode': 'url',
  'panel.favicon_url': '',
  'panel.favicon_file': '',
  'panel.bg_mode': 'color',
  'panel.bg_color': '#0b1020',
  'panel.bg_url': '',
  'panel.bg_file': '',
  'panel.bg_video_file': '',
  'panel.bg_video_url': '',
  'panel.bg_cover': '1',
  'panel.bg_overlay': '0.55',
  'panel.music_mode': 'none',
  'panel.music_url': '',
  'panel.music_file': '',
  'panel.music_youtube': '',
  'panel.music_autoplay': '0',
  'panel.music_loop': '1',
  'panel.music_volume': '35',
  'panel.sfx_enabled': '1',
  'panel.sfx_volume': '40',
  'panel.secret_blur': '0',
  'panel.navbar_style': 'glass',
  'panel.navbar_transparent': '1',
  'panel.navbar_blur': '1',
  'panel.accent': '#6366f1',
  'panel.theme': 'dark',
  'panel.wallpapers_api_key': '',
  'mail.host': config.mail.host,
  'mail.port': String(config.mail.port),
  'mail.secure': String(config.mail.secure),
  'mail.user': config.mail.user,
  'mail.pass': config.mail.pass,
  'mail.from': config.mail.from,
  'mail.verify': String(Boolean(config.mail.host)),
  'security.allow_register': config.allowRegister ? '1' : '0',
  'security.require_verify': '0',
  'security.force_tfa': '0',
  'vm.auto_port_min': String(config.autoPortMin),
  'vm.auto_port_max': String(config.autoPortMax),
  'vm.vnc_port_min': String(config.autoVncPortMin),
  'vm.vnc_port_max': String(config.autoVncPortMax),
  'vm.agent_port_min': String(config.autoAgentPortMin),
  'vm.agent_port_max': String(config.autoAgentPortMax),
  'vm.default_memory': '2048',
  'vm.default_cpus': '2',
  'vm.default_disk': '20G',
  'vm.default_os': 'Ubuntu 24.04',
  'vm.os_list': JSON.stringify([
    ['Ubuntu 22.04', 'ubuntu', 'jammy', 'https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img', 'ubuntu', 'root'],
    ['Ubuntu 24.04', 'ubuntu', 'noble', 'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img', 'ubuntu', 'root'],
    ['Debian 11', 'debian', 'bullseye', 'https://cloud.debian.org/images/cloud/bullseye/latest/debian-11-generic-amd64.qcow2', 'debian', 'root'],
    ['Debian 12', 'debian', 'bookworm', 'https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-generic-amd64.qcow2', 'debian', 'root'],
    ['Debian 13', 'debian', 'trixie', 'https://cloud.debian.org/images/cloud/trixie/daily/latest/debian-13-generic-amd64-daily.qcow2', 'debian', 'root'],
    ['Fedora 40', 'fedora', '40', 'https://download.fedoraproject.org/pub/fedora/linux/releases/40/Cloud/x86_64/images/Fedora-Cloud-Base-40-1.14.x86_64.qcow2', 'fedora', 'root'],
    ['CentOS Stream 9', 'centos', 'stream9', 'https://cloud.centos.org/centos/9-stream/x86_64/images/CentOS-Stream-GenericCloud-9-latest.x86_64.qcow2', 'centos', 'root'],
    ['AlmaLinux 9', 'almalinux', '9', 'https://repo.almalinux.org/almalinux/9/cloud/x86_64/images/AlmaLinux-9-GenericCloud-latest.x86_64.qcow2', 'almalinux', 'root'],
    ['Rocky Linux 9', 'rockylinux', '9', 'https://download.rockylinux.org/pub/rocky/9/images/x86_64/Rocky-9-GenericCloud.latest.x86_64.qcow2', 'rocky', 'root']
  ]),
  'vm.default_cpu_model': 'default',
  'vm.default_nic_model': 'virtio',
  'vm.default_machine_type': 'pc',
  'vm.default_firmware': 'bios',
  'vm.data_disk_default': '10G',
  'billing.enabled': '0',
  'billing.base_price': '0',
  'billing.ram_price': '0',
  'billing.disk_price': '0',
  'billing.signup_credits': '0',
  'billing.daily_bonus': '0',
};

const vmsColumns = db.prepare('PRAGMA table_info(vms)').all().map((c) => c.name);
if (!vmsColumns.includes('vnc_port')) {
  db.exec('ALTER TABLE vms ADD COLUMN vnc_port INTEGER');
}
if (!vmsColumns.includes('agent_port')) {
  db.exec('ALTER TABLE vms ADD COLUMN agent_port INTEGER');
}
if (!vmsColumns.includes('agent_token')) {
  db.exec('ALTER TABLE vms ADD COLUMN agent_token TEXT');
}
if (!vmsColumns.includes('node_id')) {
  db.exec('ALTER TABLE vms ADD COLUMN node_id INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_vms_node ON vms(node_id)');
}
// ---- Per-user preferences ----
const userColumns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userColumns.includes('music_enabled')) {
  db.exec('ALTER TABLE users ADD COLUMN music_enabled INTEGER NOT NULL DEFAULT 0');
}
if (!userColumns.includes('sfx_enabled')) {
  db.exec('ALTER TABLE users ADD COLUMN sfx_enabled INTEGER NOT NULL DEFAULT 1');
}
if (!userColumns.includes('music_volume')) {
  db.exec('ALTER TABLE users ADD COLUMN music_volume INTEGER NOT NULL DEFAULT 35');
}
if (!userColumns.includes('sfx_volume')) {
  db.exec('ALTER TABLE users ADD COLUMN sfx_volume INTEGER NOT NULL DEFAULT 40');
}
if (!userColumns.includes('secret_blur')) {
  db.exec('ALTER TABLE users ADD COLUMN secret_blur INTEGER NOT NULL DEFAULT 0');
}

// ---- Per-user quotas + credits (billing) ----
const userQuotaCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
const addUserCol = (name, ddl) => { if (!userQuotaCols.includes(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${ddl}`); };
addUserCol('credits', 'REAL NOT NULL DEFAULT 0');
addUserCol('last_bonus_at', 'TEXT DEFAULT NULL');
addUserCol('max_vms', 'INTEGER NOT NULL DEFAULT -1');
addUserCol('max_cpu', 'INTEGER NOT NULL DEFAULT -1');
addUserCol('max_mem_mb', 'INTEGER NOT NULL DEFAULT -1');
addUserCol('max_disk_gb', 'INTEGER NOT NULL DEFAULT -1');

// tmate SSH address for local VMs (remote VMs store it on the agent side)
const vmTmateCol = db.prepare('PRAGMA table_info(vms)').all().map((c) => c.name);
if (!vmTmateCol.includes('tmate_ssh')) {
  db.exec("ALTER TABLE vms ADD COLUMN tmate_ssh TEXT DEFAULT NULL");
}

// Webhooks configuration for a VM (JSON array of {url, secret, events[]})
const vmWebhookCol = db.prepare('PRAGMA table_info(vms)').all().map((c) => c.name);
if (!vmWebhookCol.includes('webhooks')) {
  db.exec("ALTER TABLE vms ADD COLUMN webhooks TEXT DEFAULT '[]'");
}

// Backup retention (# backups to keep) per schedule
const schedCols = db.prepare('PRAGMA table_info(schedules)').all().map((c) => c.name);
if (!schedCols.includes('retention')) {
  db.exec('ALTER TABLE schedules ADD COLUMN retention INTEGER NOT NULL DEFAULT 5');
}

// ---- Venlix hKVM-style VM creator advanced columns ----
const vmAdvColumns = {
  description: 'TEXT',
  tag: 'TEXT',
  region: 'TEXT',
  vmid: 'TEXT',
  cpu_sockets: 'INTEGER',
  cores_per_socket: 'INTEGER',
  threads_per_core: 'INTEGER',
  cpu_model: 'TEXT',
  cpu_type: 'TEXT',
  cpu_units: 'INTEGER',
  cpu_limit: 'INTEGER',
  mem_min: 'INTEGER',
  mem_max: 'INTEGER',
  ballooning: 'INTEGER',
  memory_hotplug: 'INTEGER',
  machine_type: 'TEXT',
  firmware: 'TEXT',
  secure_boot: 'INTEGER',
  tpm: 'INTEGER',
  boot_order: 'TEXT',
  nic_model: 'TEXT',
  nic_count: 'INTEGER',
  storage_pool: 'TEXT',
  disk_format: 'TEXT',
  additional_disks: 'TEXT',
  cloudinit_userdata: 'TEXT',
  cloudinit_packages: 'TEXT',
  cloudinit_commands: 'TEXT',
  cloudinit_files: 'TEXT',
  startup_script: 'TEXT',
  install_guest_agent: 'INTEGER',
  enable_monitoring: 'INTEGER',
  enable_backups: 'INTEGER',
  backup_schedule: 'TEXT',
  timezone: 'TEXT',
  locale: 'TEXT',
  advanced: 'TEXT',
};
for (const [col, type] of Object.entries(vmAdvColumns)) {
  if (!vmsColumns.includes(col)) {
    db.exec(`ALTER TABLE vms ADD COLUMN ${col} ${type}`);
  }
}

function seedSettings() {
  const stmt = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(defaultSettings)) stmt.run(k, v);
}
seedSettings();

// Rebrand to Venlix Nodes: force the panel name to 'Venlix Nodes'
// regardless of the value that shipped with the original vpanel install.
db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('Venlix Nodes', 'panel.name');

const S = {
  get(key, fallback = null) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) return fallback;
    try { return JSON.parse(row.value); } catch (_) { return row.value; }
  },
  set(key, value) {
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, typeof value === 'string' ? value : JSON.stringify(value));
  },
  all() {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const out = {};
    for (const r of rows) {
      try { out[r.key] = JSON.parse(r.value); } catch (_) { out[r.key] = r.value; }
    }
    return out;
  },
};

module.exports = { db, settings: S };
