#!/usr/bin/env bash
# =============================================================================
#  ⚡ Venlix Nodes - Next-Gen QEMU Virtual Machine Management Web Panel
#  Full Support Installer for Debian (11, 12, 13) & Ubuntu (20.04, 22.04, 24.04)
# =============================================================================

set -e

# ANSI Colors ($'...' quoting stores the REAL escape char, so plain `echo`
# renders colors too — not just printf.)
RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'
CYAN=$'\033[0;36m'
MAGENTA=$'\033[0;35m'
BOLD=$'\033[1m'
NC=$'\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -d "$SCRIPT_DIR/vpanel-pro" ]; then
  APP_DIR="$SCRIPT_DIR/vpanel-pro"
else
  APP_DIR="$SCRIPT_DIR"
fi

cd "$APP_DIR"

safe_clear() {
  clear 2>/dev/null || true
}

log_info()  { printf "${CYAN}${BOLD}[vPanel]${NC} %b\n" "$*"; }
log_ok()    { printf "${GREEN}${BOLD}[✔ SUCCESS]${NC} %b\n" "$*"; }
log_warn()  { printf "${YELLOW}${BOLD}[⚠ WARN]${NC} %b\n" "$*"; }
log_err()   { printf "${RED}${BOLD}[✖ ERROR]${NC} %b\n" "$*" >&2; }

check_root() {
  if [ "$(id -u)" -ne 0 ]; then
    log_err "This script must be run as root. Please run with: sudo bash install.sh"
    exit 1
  fi
}

detect_os() {
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS_ID="$ID"
    OS_VER="${VERSION_ID:-}"
    OS_NAME="${PRETTY_NAME:-$ID}"
  else
    log_err "Cannot detect Linux distribution (/etc/os-release missing)."
    exit 1
  fi

  case "$OS_ID" in
    debian|ubuntu)
      log_info "Detected Supported OS: ${GREEN}${OS_NAME}${NC}"
      ;;
    *)
      log_warn "Detected OS: ${OS_NAME}. Recommended distributions: Debian 11/12/13, Ubuntu 20.04/22.04/24.04."
      ;;
  esac
}

get_server_ip() {
  local ip
  ip=$(curl -s -4 https://api.ipify.org 2>/dev/null || curl -s -4 https://ifconfig.me 2>/dev/null || ip route get 1.1.1.1 2>/dev/null | awk '{print $7}' || echo "localhost")
  echo "$ip"
}

# =============================================================================
# 1. INSTALL VPANEL PRO
# =============================================================================
do_install() {
  safe_clear
  printf "${CYAN}${BOLD}"
  echo "================================================================="
  echo "             🚀 Installing Venlix Nodes on $OS_NAME                "
  echo "================================================================="
  printf "${NC}\n"

  # Step 1: System Packages
  log_info "Step 1/7: Updating APT package repositories..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y || true

  log_info "Step 2/7: Installing core system dependencies & QEMU packages..."
  apt-get install -y --no-install-recommends \
    git curl wget openssl ca-certificates tar gzip iproute2 procps \
    build-essential python3 make g++ \
    qemu-system-x86 qemu-utils cloud-image-utils || true

  # Step 2: Node.js 20 LTS Check
  log_info "Step 3/7: Verifying Node.js 20 LTS environment..."
  local install_node=0
  if ! command -v node >/dev/null 2>&1; then
    install_node=1
  else
    local cur_ver
    cur_ver=$(node -v | sed 's/^v//; s/\..*$//')
    if [ "${cur_ver:-0}" -lt 18 ]; then
      install_node=1
    fi
  fi

  if [ "$install_node" -eq 1 ]; then
    log_info "Installing Node.js 20.x LTS repository via NodeSource..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  fi
  log_ok "Node.js $(node -v) & NPM $(npm -v) ready"

  # Step 3: KVM / No-KVM check
  log_info "Step 4/7: Checking hardware virtualization (/dev/kvm)..."
  if [ -e "/dev/kvm" ]; then
    chmod 666 /dev/kvm || true
    log_ok "KVM Hardware Acceleration detected (/dev/kvm)"
  else
    log_warn "/dev/kvm not found or disabled. Enabling automatic No-KVM Mode (QEMU TCG Software Emulation)."
    export NO_KVM=1
  fi

  # Step 4: NPM Dependencies
  log_info "Step 5/7: Installing NPM packages & building native binaries..."
  npm install --no-audit --no-fund

  # Step 5: Initialize Application & Directories
  log_info "Step 6/7: Initializing storage directories & database..."
  mkdir -p data vms public/uploads/logo public/uploads/favicon public/uploads/background public/uploads/music public/uploads/avatar storage/backups storage/logs data/tmp
  node scripts/build.js

  # Setup .env
  if [ ! -f .env ]; then
    log_info "Generating secure .env configuration..."
    if [ -f .env.example ]; then
      cp .env.example .env
    else
      cat << 'EOF' > .env
PANEL_PORT=3001
API_PORT=3002
PANEL_URL=http://localhost:3001
JWT_SECRET=
JWT_EXPIRES=7d
AUTO_PORT_MIN=25501
AUTO_PORT_MAX=25600
AUTO_VNC_PORT_MIN=25901
AUTO_VNC_PORT_MAX=26000
AUTO_AGENT_PORT_MIN=26101
AUTO_AGENT_PORT_MAX=26200
ALLOW_REGISTER=1
EOF
    fi
    local secret
    secret="$(openssl rand -hex 32)"
    sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${secret}|" .env
  fi

  # Step 6: Create Admin User
  log_info "Step 7/7: Creating Administrator Account..."
  echo ""
  read -r -p "Enter Admin Username [default: admin]: " IN_USER
  IN_USER="${IN_USER:-admin}"

  read -r -p "Enter Admin Email [default: admin@vpanel.local]: " IN_EMAIL
  IN_EMAIL="${IN_EMAIL:-admin@vpanel.local}"

  read -r -s -p "Enter Admin Password [default: generate secure]: " IN_PASS
  echo ""
  if [ -z "$IN_PASS" ]; then
    IN_PASS="$(openssl rand -hex 6)"
    log_warn "Generated secure admin password: ${IN_PASS}"
  fi

  CREATEUSER_USERNAME="$IN_USER" \
  CREATEUSER_EMAIL="$IN_EMAIL" \
  CREATEUSER_PASSWORD="$IN_PASS" \
  CREATEUSER_ROLE=admin \
  node scripts/createuser.js >/dev/null 2>&1 || true

  # Step 7: Setup PM2 Daemon
  if ! command -v pm2 >/dev/null 2>&1; then
    log_info "Installing PM2 Process Manager globally..."
    npm install -g pm2 --no-audit --no-fund
  fi

  log_info "Starting Venlix Nodes cluster with PM2..."
  pm2 delete vpanel >/dev/null 2>&1 || true
  pm2 start ecosystem.config.js || pm2 start src/server.js --name vpanel
  pm2 save
  pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true

  local s_ip
  s_ip=$(get_server_ip)

  echo ""
  printf "${GREEN}${BOLD}"
  echo "================================================================="
  echo "           🎉 Venlix Nodes Successfully Installed & Online!        "
  echo "================================================================="
  printf "${NC}\n"
  echo "  🌐 Web Panel URL:    http://${s_ip}:3001"
  echo "  ⚡ REST API URL:     http://${s_ip}:3002/api"
  echo "  👤 Admin Username:   ${IN_USER}"
  echo "  🔑 Admin Password:   ${IN_PASS}"
  echo "  📧 Admin Email:      ${IN_EMAIL}"
  echo ""
  echo "  ⚙️  PM2 Process:      pm2 status | pm2 logs vpanel"
  echo "================================================================="
  echo ""

  # --- Node agent prompt (like Pterodactyl Wings) ---
  printf "${CYAN}${BOLD}  Do you want to install the Node Agent on this VPS as well?${NC}\n"
  echo "  This allows this machine to also host VMs (act as a hypervisor node)."
  echo "  You can always install it later via option [6] in the main menu."
  echo ""
  read -r -p "  Install Node Agent on this VPS? [Y/n]: " INSTALL_NODE
  INSTALL_NODE="${INSTALL_NODE:-Y}"
  if [[ "$INSTALL_NODE" =~ ^[Yy]$ ]]; then
    echo ""
    log_info "Installing Local Node Agent (same VPS, started via PM2)..."
    if [ -f "$APP_DIR/node-agent/install-local-node.sh" ]; then
      cd "$APP_DIR"
      bash node-agent/install-local-node.sh
    else
      log_warn "node-agent/install-local-node.sh not found. Skipping node agent install."
      log_info "You can install it later via the main menu option [6]."
    fi
  else
    echo ""
    log_info "Skipping Node Agent install. You can install it later via the main menu option [6]."
  fi
  echo ""
}

# =============================================================================
# 2. CREATE / RESET ADMIN USER (usercrate admin)
# =============================================================================
do_create_user() {
  safe_clear
  printf "${CYAN}${BOLD}"
  echo "================================================================="
  echo "               👤 Create / Reset Administrator User               "
  echo "================================================================="
  printf "${NC}\n"

  read -r -p "Enter Username [default: admin]: " A_USER
  A_USER="${A_USER:-admin}"

  read -r -p "Enter Email [default: ${A_USER}@vpanel.local]: " A_EMAIL
  A_EMAIL="${A_EMAIL:-${A_USER}@vpanel.local}"

  read -r -p "Enter Display Name [default: Administrator]: " A_NAME
  A_NAME="${A_NAME:-Administrator}"

  read -r -s -p "Enter Password: " A_PASS
  echo ""
  while [ -z "$A_PASS" ]; do
    read -r -s -p "Password cannot be empty. Please enter password: " A_PASS
    echo ""
  done

  log_info "Provisioning Administrator account '${A_USER}' in database..."

  CREATEUSER_USERNAME="$A_USER" \
  CREATEUSER_EMAIL="$A_EMAIL" \
  CREATEUSER_PASSWORD="$A_PASS" \
  CREATEUSER_NAME="$A_NAME" \
  CREATEUSER_ROLE=admin \
  node -e "
    const auth = require('./src/services/authService');
    const { db } = require('./src/lib/db');
    const username = process.env.CREATEUSER_USERNAME;
    const email = process.env.CREATEUSER_EMAIL;
    const password = process.env.CREATEUSER_PASSWORD;
    const name = process.env.CREATEUSER_NAME || username;

    const existing = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(username, email);
    if (existing) {
      auth.updateUser(existing.id, { password, role: 'admin', root_admin: 1, suspended: 0, verified: 1 });
      console.log('[✔] Administrator user ' + username + ' password updated and promoted to Root Admin.');
    } else {
      auth.createUser({ username, email, password, name, role: 'admin', root_admin: 1, verified: 1 });
      console.log('[✔] Administrator user ' + username + ' created successfully.');
    }
  "

  log_ok "Administrator account '${A_USER}' is ready for login."
  echo ""
}

# =============================================================================
# 2.5 INSTALL NODE AGENT (connect this machine to the panel as a node)
# =============================================================================
do_install_node() {
  safe_clear
  printf "${CYAN}${BOLD}"
  echo "================================================================="
  echo "         🖥️  Install Node Agent (Connect This Machine to Panel)      "
  echo "================================================================="
  printf "${NC}\n"

  if [ ! -f "node-agent/install-node.sh" ]; then
    log_warn "node-agent/install-node.sh not found in the current directory."
    read -r -p "Clone the venlix-nodes repo here to get the node installer? [y/N]: " C
    if [[ "$C" =~ ^[Yy]$ ]]; then
      rm -rf /tmp/venlix-node-install
      git clone --depth 1 https://github.com/rgdevil54321-afk/vm-panel-.git /tmp/venlix-node-install || { log_err "Git clone failed — check internet/SSH access to GitHub."; return 1; }
      ( cd /tmp/venlix-node-install && bash node-agent/install-node.sh )
      return_node_install_result
      return
    else
      log_err "Cannot install node agent without the repo. Aborting."
      return 1
    fi
  fi

  log_info "Launching the node-agent installer..."
  echo ""
  if [ -f "data/vpanel.db" ] && [ -f "node-agent/install-local-node.sh" ]; then
    log_info "A local panel database was detected — installing node agent via PM2 (same-host)."
    bash node-agent/install-local-node.sh
  else
    bash node-agent/install-node.sh
  fi
  return_node_install_result
  echo ""
}

# Verify the agent actually got installed and tell the user what to do next.
return_node_install_result() {
  echo ""
  if systemctl is-active --quiet venlix-node 2>/dev/null; then
    log_ok "Node agent service is running (systemd: venlix-node)."
    AGENT_INSTALLED=1
  elif pm2 jlist 2>/dev/null | grep -q '"venlix-node"'; then
    log_ok "Node agent is running under PM2 (venlix-node)."
    AGENT_INSTALLED=1
  elif [ -f /opt/venlix-node/agent.js ]; then
    log_warn "Agent files exist but the service is NOT running. Try: systemctl restart venlix-node   (or: pm2 restart venlix-node)"
  else
    log_err "Node agent was NOT installed. Scroll up for the precheck failure that stopped it."
  fi
  if [ "${AGENT_INSTALLED:-0}" = "1" ] && [ -f /opt/venlix-node/connect-key.txt ]; then
    echo ""
    printf "${GREEN}${BOLD}  ┌─────────────────────────────────────────────────────┐${NC}\n"
    printf "${GREEN}${BOLD}  │  CONNECT KEY (paste in Panel → Nodes → Connect):   │${NC}\n"
    printf "${GREEN}${BOLD}  │                                                     │${NC}\n"
    printf "${GREEN}${BOLD}  │  %s${NC}\n" "$(cat /opt/venlix-node/connect-key.txt)"
    printf "${GREEN}${BOLD}  └─────────────────────────────────────────────────────┘${NC}\n"
  fi
}

# =============================================================================
# 3. UPDATE VPANEL PRO
# =============================================================================
do_update() {
  safe_clear
  printf "${CYAN}${BOLD}"
  echo "================================================================="
  echo "                   🔄 Updating Venlix Nodes                        "
  echo "================================================================="
  printf "${NC}\n"

  if [ -d ".git" ]; then
    log_info "Fetching latest updates from git repository..."
    git pull || log_warn "Git pull reported conflicts or already up to date."
  else
    log_info "Preserving current source directory..."
  fi

  log_info "Updating npm packages..."
  npm install --no-audit --no-fund

  log_info "Running build & database migrations..."
  node scripts/build.js

  if command -v pm2 >/dev/null 2>&1; then
    log_info "Reloading PM2 cluster with zero downtime..."
    pm2 restart all || pm2 start ecosystem.config.js
    pm2 save
  fi

  log_ok "Venlix Nodes has been updated successfully!"
  echo ""
}

# =============================================================================
# 4. PM2 MANAGEMENT (pm2 mang)
# =============================================================================
do_pm2_menu() {
  while true; do
    safe_clear
    printf "${MAGENTA}${BOLD}"
    echo "================================================================="
    echo "                   ⚙️  PM2 Process Manager                       "
    echo "================================================================="
    printf "${NC}\n"
    echo "  [1] 📊 View Status (pm2 status)"
    echo "  [2] 🔄 Restart vPanel (pm2 restart vpanel)"
    echo "  [3] ⏹️  Stop vPanel (pm2 stop vpanel)"
    echo "  [4] ▶️  Start vPanel (pm2 start vpanel)"
    echo "  [5] 📜 View Live Logs (pm2 logs vpanel)"
    echo "  [6] ⚡ Enable Auto-start on System Boot"
    echo "  [7] 🚫 Disable Auto-start on System Boot"
    echo "  [0] 🔙 Back to Main Menu"
    echo ""
    read -r -p "Select PM2 Option [0-7]: " PM2_OPT

    case "$PM2_OPT" in
      1)
        echo ""
        pm2 status
        echo ""
        read -r -p "Press Enter to continue..." _
        ;;
      2)
        log_info "Restarting vPanel cluster..."
        pm2 restart all
        log_ok "vPanel restarted."
        read -r -p "Press Enter to continue..." _
        ;;
      3)
        log_info "Stopping vPanel cluster..."
        pm2 stop all
        log_ok "vPanel stopped."
        read -r -p "Press Enter to continue..." _
        ;;
      4)
        log_info "Starting vPanel cluster..."
        pm2 start ecosystem.config.js || pm2 start all
        log_ok "vPanel started."
        read -r -p "Press Enter to continue..." _
        ;;
      5)
        log_info "Streaming live PM2 logs (Ctrl+C to exit)..."
        pm2 logs vpanel --lines 50
        ;;
      6)
        log_info "Configuring PM2 startup systemd service..."
        pm2 save
        pm2 startup systemd -u root --hp /root || true
        log_ok "Auto-start on boot enabled."
        read -r -p "Press Enter to continue..." _
        ;;
      7)
        log_info "Disabling PM2 startup service..."
        pm2 unstartup systemd || true
        log_ok "Auto-start on boot disabled."
        read -r -p "Press Enter to continue..." _
        ;;
      0)
        break
        ;;
      *)
        log_warn "Invalid option. Please choose between 0 and 7."
        sleep 1
        ;;
    esac
  done
}

# =============================================================================
# 5. UNINSTALL VPANEL PRO
# =============================================================================
do_uninstall() {
  safe_clear
  printf "${RED}${BOLD}"
  echo "================================================================="
  echo "                 🗑️  Uninstall Venlix Nodes                        "
  echo "================================================================="
  printf "${NC}\n"

  read -r -p "Are you sure you want to completely uninstall Venlix Nodes? (y/N): " CONFIRM
  if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
    log_info "Uninstall aborted."
    return
  fi

  read -r -p "Do you want to KEEP your VM disks and database data? [Y/n]: " KEEP_DATA
  KEEP_DATA="${KEEP_DATA:-Y}"

  log_info "Stopping and removing PM2 daemon process..."
  if command -v pm2 >/dev/null 2>&1; then
    pm2 delete vpanel >/dev/null 2>&1 || true
    pm2 save >/dev/null 2>&1 || true
    pm2 unstartup systemd >/dev/null 2>&1 || true
  fi

  if [[ "$KEEP_DATA" == "n" || "$KEEP_DATA" == "N" ]]; then
    log_info "Removing all data, VMs, and uploads..."
    rm -rf data/vpanel.db data/tmp vms/* public/uploads/logo/* public/uploads/favicon/* public/uploads/background/*
  else
    log_info "Preserving database and VM disks."
  fi

  log_ok "Venlix Nodes has been uninstalled successfully."
  echo ""
}

# =============================================================================
# 6. SYSTEM STATUS OVERVIEW
# =============================================================================
do_status() {
  safe_clear
  printf "${MAGENTA}${BOLD}"
  echo "================================================================="
  echo "               📊 Venlix Nodes - System Status                   "
  echo "================================================================="
  printf "${NC}\n"

  uptime -p 2>/dev/null | sed 's/^/  Uptime         : /'
  echo "  CPU cores      : $(nproc 2>/dev/null)"
  echo "  RAM            : $(free -h 2>/dev/null | awk 'NR==2{print $3"/"$2}')"
  echo "  Disk           : $(df -h / 2>/dev/null | awk 'NR==2{print $3"/"$2" ("$5") used"}')"

  echo ""
  echo "  --- Local services (via PM2) ---"
  if command -v pm2 >/dev/null 2>&1; then
    pm2 ls | grep -E "vpanel|venlix-node|venlix-tunnel|online|errored|stopped" || pm2 ls
  else
    echo "  PM2 not installed."
  fi

  echo ""
  echo "  --- Agent reachability ---"
  curl -s -m 3 -o /dev/null -w "  Local agent (127.0.0.1:3005/health) : %{http_code}\n" http://127.0.0.1:3005/health 2>/dev/null || echo "  Local agent : 000"
  local PANEL_PORT
  PANEL_PORT="${PANEL_PORT:-3001}"
  curl -s -m 3 -o /dev/null -w "  Web panel  (127.0.0.1:${PANEL_PORT}/login)  : %{http_code}\n" "http://127.0.0.1:${PANEL_PORT}/login" 2>/dev/null || echo "  Web panel  : 000"
  echo ""
  read -r -p "  Press Enter to return..." _
}

# =============================================================================
# 7. BACKUP / RESTORE
# =============================================================================
do_backup_menu() {
  while true; do
    safe_clear
    printf "${MAGENTA}${BOLD}"
    echo "================================================================="
    echo "                 💾 Backup / Restore                              "
    echo "================================================================="
    printf "${NC}\n"
    echo "  [1] 💾 Create a full backup (DB + .env + uploads + VM disks)"
    echo "  [2] 📂 List existing backups"
    echo "  [3] ↩️  Restore from a backup"
    echo "  [0] 🔙 Back"
    echo ""
    read -r -p "  Select option [0-3]: " BK_OPT
    case "$BK_OPT" in
      1)
        do_backup_create
        read -r -p "  Press Enter to continue..." _
        ;;
      2)
        do_backup_list
        read -r -p "  Press Enter to continue..." _
        ;;
      3)
        do_backup_restore
        read -r -p "  Press Enter to continue..." _
        ;;
      0) break ;;
      *) log_warn "Invalid option." ;;
    esac
  done
}

do_backup_create() {
  local STAMP now
  STAMP="$(date +%Y%m%d-%H%M%S)"
  local BKROOT="${BKROOT:-$APP_DIR/../backups}"
  mkdir -p "$BKROOT"
  local OUT="$BKROOT/venlix-backup-$STAMP.tar.gz"
  log_info "Creating full backup -> $OUT"
  rm -rf "$APP_DIR/data/tmp"
  tar -czf "$OUT" \
    -C "$(dirname "$APP_DIR")" "$(basename "$APP_DIR")/data" \
    "$(basename "$APP_DIR")/vms" \
    "$(basename "$APP_DIR")/uploads" \
    --exclude="*/tmp/*" 2>/dev/null
  if [ -f "$OUT" ]; then
    log_ok "Backup created: $OUT ($(du -h "$OUT" | awk '{print $1}'))"
  else
    log_warn "Backup tool finished with no file — check permissions/disk space."
  fi
}

do_backup_list() {
  local BKROOT="${BKROOT:-$APP_DIR/../backups}"
  if [ ! -d "$BKROOT" ] || [ -z "$(ls -A "$BKROOT" 2>/dev/null)" ]; then
    log_warn "No backups found in $BKROOT"
    return 0
  fi
  echo ""
  log_info "Backups in $BKROOT:"
  ls -lh "$BKROOT" | grep -v '^total' | awk '{print "  "$5"\t"$9}'
  echo ""
}

do_backup_restore() {
  local BKROOT="${BKROOT:-$APP_DIR/../backups}"
  do_backup_list
  read -r -p "  Enter backup filename to restore (or Enter to cancel): " BFILE
  if [ -z "$BFILE" ]; then log_info "Cancelled."; return 0; fi
  local SRC="$BKROOT/$BFILE"
  if [ ! -f "$SRC" ]; then log_err "Backup not found: $SRC"; return 1; fi
  read -r -p "  WARNING: This overwrites current DB/VMs. Continue? (y/N): " CONFIRM
  if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then log_info "Cancelled."; return 0; fi

  log_info "Stopping services before restore..."
  pm2 stop all >/dev/null 2>&1 || true
  log_info "Restoring backup..."
  mkdir -p "$APP_DIR"
  tar -xzf "$SRC" -C "$(dirname "$APP_DIR")"
  log_info "Restarting services..."
  pm2 start all >/dev/null 2>&1 || true
  log_ok "Restore complete. Restarting panel to apply..."
  pm2 restart vpanel >/dev/null 2>&1 || pm2 start ecosystem.config.js >/dev/null 2>&1 || true
}

# =============================================================================
# 8. FIREWALL WIZARD
# =============================================================================
do_firewall() {
  safe_clear
  printf "${MAGENTA}${BOLD}"
  echo "================================================================="
  echo "                 🔥 Firewall (UFW) Wizard                        "
  echo "================================================================="
  printf "${NC}\n"
  echo "  Opens:"
  echo "    3001/tcp (panel web)"
  echo "    3002/tcp (panel API)"
  echo "    3005/tcp (node agent)"
  echo "    SSH (22/tcp, if closed)"
  echo "    VM port range 25501-25600 (SSH/port-forward)"
  echo "    VNC range 5900-6000"
  echo ""
  read -r -p "  Proceed with these rules? [Y/n]: " FW_GO
  FW_GO="${FW_GO:-Y}"
  if [[ "$FW_GO" =~ ^[Nn]$ ]]; then log_info "Cancelled."; return 0; fi

  if ! command -v ufw >/dev/null 2>&1; then
    log_info "Installing UFW..."
    DEBIAN_FRONTEND=noninteractive apt-get install -y ufw >/dev/null 2>&1 || true
  fi
  if ! command -v ufw >/dev/null 2>&1; then
    log_err "UFW not available on this system. Open the ports in your cloud/provider firewall instead."
    return 1
  fi
  ufw allow 22/tcp >/dev/null 2>&1
  ufw allow 3001/tcp >/dev/null 2>&1
  ufw allow 3002/tcp >/dev/null 2>&1
  ufw allow 3005/tcp >/dev/null 2>&1
  ufw allow 25501:25600/tcp >/dev/null 2>&1
  ufw allow 5900:6000/tcp >/dev/null 2>&1
  ufw allow 80/tcp >/dev/null 2>&1
  ufw allow 443/tcp >/dev/null 2>&1
  if [ "$(ufw status 2>/dev/null | grep -c 'Status: active')" -eq 0 ]; then
    echo "n" | ufw enable >/dev/null 2>&1 || true
  fi
  log_ok "Firewall rules applied. Current status:"
  ufw status | grep -E "3001|3002|3005|25501|5900|22|80|443|Status" | sed 's/^/    /'
  echo ""
  read -r -p "  Press Enter to continue..." _
}

# =============================================================================
# 9. NODE AGENT MANAGEMENT SUBMENU
# =============================================================================
do_node_menu() {
  while true; do
    safe_clear
    printf "${MAGENTA}${BOLD}"
    echo "================================================================="
    echo "               🖥️  Node Agent Management                        "
    echo "================================================================="
    printf "${NC}\n"
    echo "  [1] 📊 Node status (pm2 + health)"
    echo "  [2] 🚀 Install / reinstall node agent (this machine)"
    echo "  [3] 🔗 Show node connect key (for the panel UI)"
    echo "  [4] 🌐 Tunnel status / install Cloudflare tunnel"
    echo "  [5] 📜 Node logs"
    echo "  [6] 🔄 Restart node agent"
    echo "  [0] 🔙 Back"
    echo ""
    read -r -p "  Select option [0-6]: " ND_OPT
    case "$ND_OPT" in
      1)
        do_node_status
        read -r -p "  Press Enter to continue..." _
        ;;
      2)
        read -r -p "  This installs the node agent on THIS machine. Continue? [Y/n]: " ND_INST
        if [[ "$ND_INST" =~ ^[Yy]$ ]] || [ -z "$ND_INST" ]; then
          log_info "Launching node-agent installer..."
          if [ -f "data/vpanel.db" ] && [ -f "node-agent/install-local-node.sh" ]; then
            bash node-agent/install-local-node.sh
          elif [ -f "node-agent/install-node.sh" ]; then
            bash node-agent/install-node.sh
          else
            log_err "node-agent installer not found. Fetch the repo first."
          fi
        fi
        read -r -p "  Press Enter to continue..." _
        ;;
      3)
        do_show_connect_key
        read -r -p "  Press Enter to continue..." _
        ;;
      4)
        do_node_tunnel
        read -r -p "  Press Enter to continue..." _
        ;;
      5)
        log_info "Streaming node logs (Ctrl+C to exit)..."
        pm2 logs venlix-node --lines 50 || journalctl -u venlix-node -n 50 --no-pager 2>/dev/null || log_warn "No logs found."
        ;;
      6)
        log_info "Restarting node agent..."
        pm2 restart venlix-node 2>/dev/null || systemctl restart venlix-node 2>/dev/null || true
        log_ok "Node agent restart requested."
        read -r -p "  Press Enter to continue..." _
        ;;
      0) break ;;
      *) log_warn "Invalid option." ;;
    esac
  done
}

do_node_status() {
  echo ""
  if command -v pm2 >/dev/null 2>&1; then
    pm2 status venlix-node 2>/dev/null || true
  fi
  curl -s -m 3 -o /dev/null -w "  Agent health (127.0.0.1:3005/health): %{http_code}\n" http://127.0.0.1:3005/health 2>/dev/null || echo "  Agent health: 000 (not reachable)"
  echo ""
}

do_show_connect_key() {
  echo ""
  if [ -f "/opt/venlix-node/.env" ]; then
    local CK JP
    JP="$(grep 'AGENT_JOIN_CODE=' /opt/venlix-node/.env 2>/dev/null | cut -d= -f2-)"
    local PUB
    PUB="$(curl -s -m 4 -4 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
    echo "  Connect key (paste in panel -> Connect With Node Key):"
    echo "      ${JP}@${PUB}:3005"
    echo ""
  else
    log_warn "No node agent installed at /opt/venlix-node."
  fi
}

do_node_tunnel() {
  echo ""
  if [ -f "/opt/venlix-node/cloudflared-tunnel.log" ]; then
    echo "  Cloudflare tunnel log tail:"
    tail -n 15 /opt/venlix-node/cloudflared-tunnel.log 2>/dev/null | sed 's/^/    /'
  fi
  if systemctl list-unit-files 2>/dev/null | grep -q venlix-tunnel; then
    echo "  Tunnel service: $(systemctl is-active venlix-tunnel 2>/dev/null)"
  fi
  if command -v pm2 >/dev/null 2>&1 && pm2 ls 2>/dev/null | grep -q venlix-tunnel; then
    echo "  Tunnel service: $(pm2 ls 2>/dev/null | grep venlix-tunnel | grep -oE 'online|errored|stopped')"
  fi
  read -r -p "  Install/refresh a Cloudflare tunnel now? [Y/n]: " TRY
  if [[ "$TRY" =~ ^[Yy]$ ]] || [ -z "$TRY" ]; then
    bash node-agent/install-node.sh 2>/dev/null; log_warn "For tunnel-only setup, run: bash node-agent/install-node.sh and choose the tunnel option."
  fi
  echo ""
}

# =============================================================================
# 10. SSL / HTTPS VIA CADDY
# =============================================================================
do_ssl() {
  safe_clear
  printf "${MAGENTA}${BOLD}"
  echo "================================================================="
  echo "                🔐 HTTPS via Caddy (auto SSL)                    "
  echo "================================================================="
  printf "${NC}\n"
  if ! command -v apt-get >/dev/null 2>&1; then
    log_err "Caddy setup requires apt. This box may not support it."
    read -r -p "Press Enter..." _
    return 0
  fi
  echo "  Caddy terminates HTTPS and proxies to the panel (3001) + API (3002)."
  echo ""
  read -r -p "  Your domain (e.g. panel.example.com): " CDOMAIN
  if [ -z "$CDOMAIN" ]; then log_warn "No domain given."; return 0; fi
  read -r -p "  Must the subdomain resolve to this server's public IP. Continue? [Y/n]: " CG
  if [[ "$CG" =~ ^[Nn]$ ]]; then log_warn "Cancelled."; return 0; fi

  DNSPROVIDER=""
  read -r -p "  DNS provider for wildcard/turnstile? (cloudflare, or blank for DNS verify): " DNS_ANS
  case "$DNS_ANS" in
    cloudflare|Cloudflare)
      read -r -p "  Cloudflare API Token: " CFTOK
      DNSPROVIDER="cloudflare"
      ;;
  esac

  log_info "Installing Caddy..."
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https >/dev/null 2>&1
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null || true
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null 2>&1 || true
  apt-get update >/dev/null 2>&1
  DEBIAN_FRONTEND=noninteractive apt-get install -y caddy >/dev/null 2>&1 || true

  cat > /etc/caddy/Caddyfile <<EOF
$CDOMAIN {
    reverse_proxy 127.0.0.1:3001
    reverse_proxy /api/* 127.0.0.1:3002
    encode gzip
}
EOF
  log_info "Make sure the SECURE_BEARER or cookie auth works over the new host, then:"
  systemctl reload caddy 2>/dev/null || systemctl restart caddy 2>/dev/null || true
  if curl -s -o /dev/null -w "%{http_code}" "https://${CDOMAIN}/login" -m 15 2>/dev/null | grep -qE "200|30[0-9]"; then
    log_ok "HTTPS is live: https://${CDOMAIN}"
  else
    log_warn "Caddy installed. Verify DNS points here and reload: systemctl reload caddy"
  fi
  read -r -p "  Press Enter to continue..." _
}

# =============================================================================
# 11. CHANGE PORTS
# =============================================================================
do_change_ports() {
  safe_clear
  printf "${MAGENTA}${BOLD}"
  echo "================================================================="
  echo "                 🔧 Change Panel / API / Agent Ports             "
  echo "================================================================="
  printf "${NC}\n"

  local CURP CURAPI
  CURP="$(grep -E '^PANEL_PORT=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2-)"
  CURAPI="$(grep -E '^API_PORT=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2-)"
  CURP="${CURP:-3001}"
  CURAPI="${CURAPI:-3002}"
  echo "  Current: panel=$CURP  api=$CURAPI  agent=3005"
  echo ""
  read -r -p "  New panel web port (Enter to keep $CURP): " NPANEL
  NPANEL="${NPANEL:-$CURP}"
  read -r -p "  New API port (Enter to keep $CURAPI): " NAPI
  NAPI="${NAPI:-$CURAPI}"
  read -r -p "  New agent port (Enter to keep 3005): " NAGENT
  NAGENT="${NAGENT:-3005}"

  if [ -f "$APP_DIR/.env" ]; then
    sed -i "s|^PANEL_PORT=.*|PANEL_PORT=${NPANEL}|" "$APP_DIR/.env"
    sed -i "s|^API_PORT=.*|API_PORT=${NAPI}|" "$APP_DIR/.env"
    grep -qE '^PANEL_PORT=' "$APP_DIR/.env" || echo "PANEL_PORT=${NPANEL}" >> "$APP_DIR/.env"
    grep -qE '^API_PORT=' "$APP_DIR/.env" || echo "API_PORT=${NAPI}" >> "$APP_DIR/.env"
  fi

  if [ -f "/opt/venlix-node/.env" ]; then
    sed -i "s|^AGENT_PORT=.*|AGENT_PORT=${NAGENT}|" /opt/venlix-node/.env
    grep -qE '^AGENT_PORT=' /opt/venlix-node/.env || echo "AGENT_PORT=${NAGENT}" >> /opt/venlix-node/.env
    log_info "Agent port updated (restart node agent to apply)."
  fi

  log_info "Restarting services to apply port changes..."
  pm2 restart all >/dev/null 2>&1 || true
  log_ok "Ports updated: panel=${NPANEL} api=${NAPI} agent=${NAGENT}"
  log_warn "Open the new ports in the firewall (menu option Firewall)."
  echo ""
  read -r -p "  Press Enter to continue..." _
}

# =============================================================================
# MAIN INTERACTIVE MENU
# =============================================================================
show_menu() {
  while true; do
    safe_clear
    printf "${MAGENTA}${BOLD}"
    echo " __      __                _ _       _"
    echo " \ \    / /_ _  __ _ _  __(_|)_ __  | |__  _   _"
    echo "  \ \/\/ / _\` | '_\` | || \ / | '  \ | '_ \| | | |"
    echo "   \_/\_/\__,_|\__, |\_,_/_|_|_|_|_||_| |_|\__, |"
    echo "               |___/                        |___/"
    printf "${NC}"
    printf "${CYAN}${BOLD}"
    echo "  ╭───────────────────────────────────────────────────────────╮"
    echo "  │          ⚡  Venlix Nodes Management Suite  ⚡            │"
    echo "  │      Debian 11/12/13 & Ubuntu 20.04/22.04/24.04         │"
    echo "  ╰───────────────────────────────────────────────────────────╯"
    printf "${NC}"
    echo ""
    echo "  ${BOLD}DEPLOY${NC}"
    echo "   ${CYAN}[1]${NC} 🚀 Install Panel         Full automated install"
    echo "   ${CYAN}[2]${NC} 👤 Create Admin         New administrator account"
    echo "   ${CYAN}[3]${NC} 🔄 Update Panel         Pull + rebuild + reload"
    echo ""
    echo "  ${BOLD}MANAGE${NC}"
    echo "   ${CYAN}[4]${NC} ⚙️  PM2 Manager         Status · restart · logs · boot"
    echo "   ${CYAN}[5]${NC} 🗑️  Uninstall            Safe removal wizard"
    echo "   ${CYAN}[6]${NC} 🖥️  Install Node Agent   Connect machine → panel"
    echo ""
    echo "  ${BOLD}TOOLS${NC}"
    echo "   ${CYAN}[7]${NC} 📊 System Status       Health · nodes · resources"
    echo "   ${CYAN}[8]${NC} 💾 Backup / Restore    DB · VMs · uploads"
    echo "   ${CYAN}[9]${NC} 🔥 Firewall Wizard     Open panel/node/VM ports"
    echo "   ${CYAN}[10]${NC} 🖥️ Node Management    Status · tunnel · key"
    echo "   ${CYAN}[11]${NC} 🔐 SSL / HTTPS        Free auto-SSL via Caddy"
    echo "   ${CYAN}[12]${NC} 🔧 Change Ports       Panel / API / agent"
    echo ""
    echo "   ${RED}[0]${NC} 🚪 Exit"
    echo ""
    printf "${CYAN}─────────────────────────────────────────────────────────────${NC}\n"
    read -r -p "  Select option ${BOLD}[0-12]${NC} › " CHOICE

    case "$CHOICE" in
      1)
        do_install
        read -r -p "Press Enter to return to menu..." _
        ;;
      2)
        do_create_user
        read -r -p "Press Enter to return to menu..." _
        ;;
      3)
        do_update
        read -r -p "Press Enter to return to menu..." _
        ;;
      4)
        do_pm2_menu
        ;;
      5)
        do_uninstall
        read -r -p "Press Enter to return to menu..." _
        ;;
      6)
        do_install_node
        read -r -p "Press Enter to return to menu..." _
        ;;
      7)
        do_status
        ;;
      8)
        do_backup_menu
        ;;
      9)
        do_firewall
        ;;
      10)
        do_node_menu
        ;;
      11)
        do_ssl
        ;;
      12)
        do_change_ports
        ;;
      0)
        log_info "Exiting Venlix Nodes Installer. Goodbye!"
        exit 0
        ;;
      *)
        log_warn "Invalid option '$CHOICE'. Please choose 0-12."
        sleep 1.2
        ;;
    esac
  done
}

# Entrypoint
check_root
detect_os

# If arguments were passed directly (e.g. --install or --create-admin)
if [ $# -gt 0 ]; then
  case "$1" in
    1|--install|install) do_install ;;
    2|--usercrate|--create-admin|createuser) do_create_user ;;
    3|--update|update) do_update ;;
    4|--pm2|pm2) do_pm2_menu ;;
    5|--uninstall|uninstall) do_uninstall ;;
    6|--node|--install-node|node) do_install_node ;;
    7|--status|status) do_status ;;
    8|--backup|backup) do_backup_menu ;;
    9|--firewall|firewall) do_firewall ;;
    10|--nodes|node-mgmt) do_node_menu ;;
    11|--ssl|--https|caddy) do_ssl ;;
    12|--ports|change-ports) do_change_ports ;;
    *) show_menu ;;
  esac
else
  show_menu
fi
