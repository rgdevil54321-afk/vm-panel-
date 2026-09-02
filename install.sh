#!/usr/bin/env bash
# =============================================================================
#  ⚡ Venlix Nodes - Next-Gen QEMU Virtual Machine Management Web Panel
#  Full Support Installer for Debian (11, 12, 13) & Ubuntu (20.04, 22.04, 24.04)
# =============================================================================

set -e

# ANSI Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
BOLD='\033[1m'
NC='\033[0m'

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
      git clone --depth 1 https://github.com/rgdevil54321-afk/vm-panel-.git /tmp/venlix-node-install
      cd /tmp/venlix-node-install
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
  echo ""
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
# MAIN INTERACTIVE MENU
# =============================================================================
show_menu() {
  while true; do
    safe_clear
    printf "${CYAN}${BOLD}"
    echo "================================================================="
    echo "                   ⚡ Venlix Nodes Management Suite                "
    echo "            Full Support: Debian 11/12/13 & Ubuntu 20/22/24      "
    echo "================================================================="
    printf "${NC}"
    echo ""
    echo "  [1] 🚀 1. Install (Full automated install for Debian/Ubuntu)"
    echo "  [2] 👤 2. User Create Admin (usercrate admin)"
    echo "  [3] 🔄 3. Update (Pull updates, rebuild & zero-downtime reload)"
    echo "  [4] ⚙️  4. PM2 Management (pm2 mang - restart, logs, boot startup)"
    echo "  [5] 🗑️  5. Uninstall (Safe uninstall wizard)"
    echo "  [6] 🖥️  6. Install Node Agent (connect this machine to the panel)"
    echo "  [0] 🚪 0. Exit"
    echo ""
    printf "${CYAN}=================================================================${NC}\n"
    read -r -p "Enter choice [0-6]: " CHOICE

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
      0)
        log_info "Exiting Venlix Nodes Installer. Goodbye!"
        exit 0
        ;;
      *)
        log_warn "Invalid option '$CHOICE'. Please choose 1, 2, 3, 4, 5, 6, or 0."
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
    6|--node|node) do_install_node ;;
    *) show_menu ;;
  esac
else
  show_menu
fi
