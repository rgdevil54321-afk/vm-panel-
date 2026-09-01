#!/bin/bash
# ============================================================
# Venlix Nodes - Node Agent Installer
# Run on EACH machine that will host VMs (the "node"/slave).
#
#   sudo bash install-node.sh
#
# Runs an ELIGIBILITY PRECHECK first (QEMU, CPU, RAM, disk,
# virtualization), then installs the agent and prints a connect key.
# ============================================================
set -e

AGENT_DIR="/opt/venlix-node"

# ---------- colors --------------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'
BOLD='\033[1m'; NC='\033[0m'
ok()  { printf "${GREEN}${BOLD}  [PASS]${NC} %s\n" "$1"; }
warn(){ printf "${YELLOW}${BOLD}  [WARN]${NC} %s\n" "$1"; }
fail(){ printf "${RED}${BOLD}  [FAIL]${NC} %s\n" "$1"; }

# ---------- precheck collection (no early exit; report at end) ----------
PRECHECK_PASS=0; PRECHECK_WARN=0; PRECHECK_FAIL=0; PRECHECK_FATAL=0
NO_KVM_DETECTED=0
note_p(){ PRECHECK_PASS=$((PRECHECK_PASS+1)); }
note_w(){ PRECHECK_WARN=$((PRECHECK_WARN+1)); }
note_f(){ PRECHECK_FAIL=$((PRECHECK_FAIL+1)); }

precheck() {
  echo ""
  echo "============================================="
  echo "  Node Agent Installer"
  echo "============================================="
  echo ""
  echo "${BOLD}--- PRE-INSTALL ELIGIBILITY CHECK ---${NC}"
  echo ""

  # 1. root
  if [[ $EUID -eq 0 ]]; then ok "Run as root"; note_p; else fail "Must run as root (sudo)"; note_f; PRECHECK_FATAL=1; fi

  # 2. architecture
  local arch
  arch="$(uname -m)"
  if [[ "$arch" == "x86_64" || "$arch" == "amd64" ]]; then ok "Architecture $arch (x86_64 supported)"; note_p; else warn "Architecture $arch — QEMU x86 emulation may be slow/unsupported"; note_w; fi

  # 3. CPU cores
  local cores
  cores="$(nproc 2>/dev/null || echo 1)"
  if [[ "$cores" -ge 2 ]]; then
    ok "vCPUs/cores: $cores"; note_p
  else
    warn "Only $cores core(s). Small nodes (1 vCPU) can't run useful QEMU VMs comfortably."; note_w
  fi

  # 4. RAM
  local mem_mb_total mem_mb_free
  mem_mb_total="$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"
  mem_mb_free="$(awk '/MemAvailable/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"
  if [[ "$mem_mb_total" -ge 2048 ]]; then
    ok "RAM ${mem_mb_total} MB (${mem_mb_free} MB free)"; note_p
  else
    warn "Only ${mem_mb_total} MB RAM. QEMU VMs need RAM to be useful. Recommended >= 2048 MB."; note_w
  fi

  # 5. Disk space (for VM images)
  local disk_gb
  disk_gb="$(df -P "$AGENT_DIR" 2>/dev/null | awk 'NR==2{print $4/1024/1024}' || df -P / 2>/dev/null | awk 'NR==2{print $4/1024/1024}')"
  if [[ -n "$disk_gb" ]] && [[ "$(printf '%.0f' "$disk_gb")" -ge 10 ]]; then
    ok "Disk space: ${disk_gb} GB available"; note_p
  else
    warn "Low disk space (~${disk_gb} GB). VM images consume several GB each."; note_w
  fi

  # 6. CPU virtualization flag (for KVM)
  local virt_flag
  virt_flag="$(grep -Eoh '(vmx|svm)' /proc/cpuinfo 2>/dev/null | sort -u | tr -d '\n')"
  if [[ -e /dev/kvm ]]; then
    ok "KVM available (/dev/kvm) — hardware acceleration"; note_p
    NO_KVM_DETECTED=0
  elif [[ -n "$virt_flag" ]]; then
    warn "CPU supports virtualization ($virt_flag) but /dev/kvm is absent (nested virt / container?). Falling back to QEMU TCG."; note_w
    NO_KVM_DETECTED=1
  else
    warn "No CPU virtualization flags and no /dev/kvm. Using QEMU TCG (software emulation) — slower but works."; note_w
    NO_KVM_DETECTED=1
  fi

  # 7. QEMU binaries present (or installable via apt)
  local missing=()
  for b in qemu-system-x86_64 qemu-img cloud-localds; do
    command -v "$b" >/dev/null 2>&1 || missing+=("$b")
  done
  if [[ ${#missing[@]} -eq 0 ]]; then ok "QEMU tooling present (qemu-system-x86_64, qemu-img, cloud-localds)"; note_p
  elif command -v apt-get >/dev/null 2>&1; then warn "QEMU binaries missing (${missing[*]}) — will be installed via apt"; note_w
  else fail "QEMU binaries missing and no apt-get available: ${missing[*]}"; note_f; PRECHECK_FATAL=1; fi

  # 8. Agent port free
  local agent_port="${AGENT_PORT:-3005}"
  if ss -tln 2>/dev/null | awk '{print $4}' | grep -q ":$agent_port\$" 2>/dev/null || ! (command -v ss >/dev/null 2>&1); then
    warn "Port $agent_port already in use — another agent/panel may be running. Verify before continuing."; note_w
  else
    ok "Agent port $agent_port is free"; note_p
  fi

  # 9. Writable agent dir
  if mkdir -p "$AGENT_DIR" 2>/dev/null; then ok "Agent dir writable ($AGENT_DIR)"; note_p; else warn "Could not write to $AGENT_DIR — /opt permission?"; note_w; fi

  # 10. Public IP detection (for connect key)
  local pub
  pub="$(curl -s -m 5 -4 https://api.ipify.org 2>/dev/null || curl -s -m 5 ifconfig.me 2>/dev/null || echo '')"
  if [[ -n "$pub" ]]; then ok "Public IP detected: $pub"; note_p; else warn "Could not detect public IP — will fall back to local address for the connect key. Ensure the panel can reach this node."; note_w; fi

  echo ""
  echo "${BOLD}--------------------------------------${NC}"
  printf "${GREEN}${BOLD}  PASS: %s${NC}   ${YELLOW}${BOLD}WARN: %s${NC}   ${RED}${BOLD}FAIL: %s${NC}\n" "$PRECHECK_PASS" "$PRECHECK_WARN" "$PRECHECK_FAIL"
  echo "${BOLD}--------------------------------------${NC}"
  echo ""

  if [[ "$PRECHECK_FATAL" == "1" ]]; then
    echo "${RED}${BOLD}[x] Fatal issues found: this machine is not eligible as a node. Fix them and re-run.${NC}"
    exit 1
  fi
  if [[ "$PRECHECK_WARN" -gt 0 ]]; then
    read -r -p "Non-fatal warnings above. Continue installing anyway? [Y/n]: " ACC
    if [[ "$ACC" =~ ^[Nn]$ ]]; then echo "Aborted."; exit 1; fi
  fi
  echo ""
}

precheck

# ---------- prompt ----------
read -p "Node name (e.g. Node-2-Mumbai): " NODE_NAME
NODE_NAME="${NODE_NAME:-Node}"
read -p "Agent token (from panel -> Nodes -> Create Node): " AGENT_TOKEN
if [[ -z "$AGENT_TOKEN" ]]; then
  echo "Agent token is required." >&2
  exit 1
fi

# ---------- system deps (QEMU stack) ----------
echo "[+] Updating packages..."
apt-get update -y -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  qemu-system-x86 qemu-utils cloud-image-utils cloud-init \
  wget curl openssl python3 nodejs npm \
  >/dev/null 2>&1 || true

# ---------- Node.js runtime check ----------
if ! command -v node >/dev/null 2>&1; then
  echo "[!] Node.js not found; installing Node 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null 2>&1
fi

# ---------- copy agent ----------
echo "[+] Installing agent to $AGENT_DIR"
mkdir -p "$AGENT_DIR"
if [[ -d ./node-agent ]]; then
  cp -r ./node-agent/. "$AGENT_DIR/"
elif [[ -f agent.js ]]; then
  cp -r . "$AGENT_DIR/"
else
  echo "[x] Could not find the node-agent files. Run this script from the venlix-nodes repo root." >&2
  exit 1
fi

# ---------- write env ----------
AGENT_UPDATE_REPO="${AGENT_UPDATE_REPO:-https://github.com/rgdevil54321-afk/vm-panel-.git}"
AGENT_UPDATE_BRANCH="${AGENT_UPDATE_BRANCH:-main}"
# Detect KVM once; prefer explicit env, else reuse precheck's NO_KVM.
export NO_KVM="${NO_KVM:-${NO_KVM_DETECTED:-0}}"
# Generate a one-time join key so the panel can onboard this node by pasting a code.
JOIN_CODE="$(cat /dev/urandom | tr -dc 'A-Z0-9' | head -c 12 | sed 's/.\{4\}/&-/g' | sed 's/-$//')"
cat > "$AGENT_DIR/.env" <<EOF
AGENT_PORT=${AGENT_PORT:-3005}
AGENT_HOST=0.0.0.0
AGENT_TOKEN=$AGENT_TOKEN
AGENT_JOIN_CODE=$JOIN_CODE
AGENT_UPDATE_REPO=$AGENT_UPDATE_REPO
AGENT_UPDATE_BRANCH=$AGENT_UPDATE_BRANCH
NO_KVM=${NO_KVM:-0}
EOF

# Create state + vm dirs
mkdir -p "$AGENT_DIR/data" "$AGENT_DIR/vms"

# ---------- backup + migrate existing agent data ----------
BACKUP_DIR=""
STALE_MIGRATE=""
# Preserve prior node-state.json (all VMs, node meta, ports) and .env so a
# re-install / update never loses a node's running workloads or its join state.
BACKUP_DIR="$AGENT_DIR/backups/$(date +%Y%m%d-%H%M%S)"
if [[ -f "$AGENT_DIR/data/node-state.json" ]] || [[ -f "$AGENT_DIR/.env" ]]; then
  mkdir -p "$BACKUP_DIR"
  [[ -f "$AGENT_DIR/data/node-state.json" ]] && cp -a "$AGENT_DIR/data/node-state.json" "$BACKUP_DIR/" 2>/dev/null
  for d in vm logs; do
    [[ -d "$AGENT_DIR/$d" ]] && cp -a "$AGENT_DIR/$d" "$BACKUP_DIR/" 2>/dev/null
  done
  echo "[+] Backed up existing agent data to $BACKUP_DIR"
  # Migrate: if the node already has a state file, carry it forward so this
  # install reads the OLD vms instead of starting empty.
  if [[ -s "$AGENT_DIR/data/node-state.json" ]]; then
    STALE_MIGRATE=1
  fi
else
  echo "[+] Fresh install (no prior agent data found)."
fi

echo "[+] Installing Node dependencies (uuid only)..."
cd "$AGENT_DIR"
# uuid is the only third-party dependency (no native build)
npm install uuid --save
if [[ ! -d node_modules ]]; then
  echo "[x] npm install failed. Check network access." >&2
  exit 1
fi

# ---------- set node metadata ----------
cat > /tmp/venlix-meta.json <<EOF
{"name":"$NODE_NAME"}
EOF
AGENT_TOKEN="$AGENT_TOKEN" node -e "require('dotenv')" 2>/dev/null || true
# simplest: store name via env on first boot; agent reads AGENT_NODE_NAME
echo "AGENT_NODE_NAME=$NODE_NAME" >> "$AGENT_DIR/.env"

# ---------- service manager (systemd preferred, PM2 fallback) ----------
start_with_pm2() {
  echo "[+] Setting up agent with PM2 (no systemd on this host)..."
  if ! command -v pm2 >/dev/null 2>&1; then
    npm install -g pm2 >/dev/null 2>&1 || true
  fi
  if ! command -v pm2 >/dev/null 2>&1; then
    # pm2 sometimes installs to a node bin dir not on PATH
    export PATH="$PATH:/usr/local/bin:/usr/bin:/opt/node/bin"
    command -v pm2 >/dev/null 2>&1 || npm root -g >/dev/null 2>&1
  fi
  # load .env values for the PM2 process
  cd "$AGENT_DIR"
  pm2 start agent.js --name venlix-node --update-env >/dev/null 2>&1 \
    || pm2 start agent.js --name venlix-node >/dev/null 2>&1
  pm2 save >/dev/null 2>&1 || true
  pm2 startup >/dev/null 2>&1 || true
  echo "[+] Agent started via PM2 (name: venlix-node). Auto-restarts on failure."
}

if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
  echo "[+] Creating systemd service (PID 1 is systemd)..."
  cat > /etc/systemd/system/venlix-node.service <<EOF
[Unit]
Description=Venlix Nodes - Node Agent (QEMU VM Hypervisor)
After=network.target

[Service]
Type=simple
WorkingDirectory=$AGENT_DIR
EnvironmentFile=$AGENT_DIR/.env
ExecStart=/usr/bin/node $AGENT_DIR/agent.js
Restart=on-failure
RestartSec=3
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable venlix-node
  systemctl restart venlix-node || true
  if ! systemctl is-active --quiet venlix-node; then
    echo "    [!] systemd service not active — falling back to PM2."
    start_with_pm2
  fi
else
  echo "[!] No systemd detected on this host — using PM2 (great for Docker/container VPSs)."
  start_with_pm2
fi

# Resolve the address the PANEL must use to reach this node.
# Prefer the PUBLIC IP (works when the panel is on another VPS / Codesandbox),
# because `hostname -I` inside containers yields unroutable bridge IPs (172.17.x.x).
AGENT_PORT="${AGENT_PORT:-3005}"
echo "[+] Detecting the public/reachable address for this node..."
PUB_IP="$(curl -s -m 5 -4 https://api.ipify.org 2>/dev/null || curl -s -m 5 ifconfig.me 2>/dev/null || echo '')"
if [[ -z "$PUB_IP" ]]; then
  echo "    [!] Could not auto-detect public IP; falling back to network address."
  PUB_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi
if [[ -z "$PUB_IP" ]]; then
  PUB_IP="<this-server-ip>"
fi

echo ""
echo "  This node is reachable by the panel via:  $PUB_IP"
read -r -p "  Enter the address the panel should use (or press Enter to keep [$PUB_IP]): " NODE_HOST
NODE_HOST="${NODE_HOST:-$PUB_IP}"

echo ""
echo "============================================="
echo "  Node agent installed — CONNECT WITH KEY"
echo "============================================="
echo ""
echo "  Node name : $NODE_NAME"
echo ""
echo "  >>> Connect Key <<<"
echo ""
echo "      ${JOIN_CODE}@${NODE_HOST}:${AGENT_PORT}"
echo ""
echo "  On your panel:"
echo "    1. Go to Nodes & Cluster Overview"
echo "    2. Click 'Connect With Node Key'"
echo "    3. Paste the Connect Key above"
echo "    -> Your node connects automatically."
echo ""
echo "  (Port $AGENT_PORT must be reachable from the panel via the firewall.)"
echo "============================================="

# ---------- optional firewall open (best effort) ----------
echo ""
echo "[+] Optional: open TCP port $AGENT_PORT in the local firewall for the panel."
if command -v ufw >/dev/null 2>&1; then
  read -r -p "  Open $AGENT_PORT/tcp with UFW? [Y/n]: " FY
  if [[ ! "$FY" =~ ^[Nn]$ ]]; then
    ufw allow "$AGENT_PORT"/tcp >/dev/null 2>&1 && echo "    OK: ufw allow $AGENT_PORT/tcp" || echo "    [!] ufw allow failed (is UFW enabled?)."
  fi
elif command -v apt-get >/dev/null 2>&1; then
  read -r -p "  ufw not found. Install ufw and open $AGENT_PORT/tcp? [Y/n]: " FU
  if [[ ! "$FU" =~ ^[Nn]$ ]]; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ufw >/dev/null 2>&1 \
      && ufw allow "$AGENT_PORT"/tcp >/dev/null 2>&1 \
      && echo "    OK: ufw installed, $AGENT_PORT/tcp allowed (enable it later with 'ufw enable')." \
      || echo "    [!] Could not install/configure ufw. Open $AGENT_PORT/tcp in your VPS/cloud firewall instead."
  fi
else
  echo "    [!] No ufw and no apt-get. Open $AGENT_PORT/tcp in your VPS/cloud firewall manually."
fi
echo ""
echo "  Done. See the connect key above to attach this node to your panel."

# ---------- reachability self-test ----------
echo ""
echo "[+] Verifying the agent is up and the panel-facing port is reachable..."
sleep 1
LOCAL_HTTP="$(curl -s -m 5 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${AGENT_PORT}/health" 2>/dev/null || echo '000')"
PUB_HTTP="$(curl -s -m 6 -o /dev/null -w "%{http_code}" "http://${NODE_HOST}:${AGENT_PORT}/health" 2>/dev/null || echo '000')"
echo "    Local agent  (127.0.0.1:${AGENT_PORT}/health): ${LOCAL_HTTP}"
echo "    Public reach (${NODE_HOST}:${AGENT_PORT}/health):  ${PUB_HTTP}"
if [[ "$LOCAL_HTTP" == "000" ]]; then
  echo "    ${RED}[x] Agent is NOT responding locally. Check the service (systemctl status venlix-node / pm2 logs venlix-node).${NC}"
elif [[ "$PUB_HTTP" == "000" ]]; then
  echo "    ${YELLOW}[!] Agent is up locally but NOT reachable from outside on ${NODE_HOST}:${AGENT_PORT}.${NC}"
  echo "        Open ${AGENT_PORT}/tcp in your VPS/cloud firewall, or run a reverse tunnel / port-forward to it."
else
  echo "    ${GREEN}[OK] Agent reachable locally AND via ${NODE_HOST}:${AGENT_PORT}. Ready to connect to the panel.${NC}"
fi

# ---------- final summary ----------
echo ""
echo "============================================="
echo "  INSTALL SUMMARY"
echo "============================================="
echo "  Node name        : $NODE_NAME"
echo "  Agent dir        : $AGENT_DIR"
echo "  Agent port       : $AGENT_PORT"
echo "  QEMU acceleration: $([ "${NO_KVM}" = "1" ] && echo 'TCG (software, NO_KVM=1)' || echo 'KVM (hardware, NO_KVM=0)')"
echo "  Prior data kept  : ${STALE_MIGRATE:+yes (migrated)}${STALE_MIGRATE- no (fresh install)}"
echo "  Backup of old data: ${BACKUP_DIR:-none (fresh install)}"
echo "  Service manager  : $(command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] && echo 'systemd' || echo 'PM2')"
echo "  Reachability     : local=$LOCAL_HTTP public=$PUB_HTTP"
echo ""
echo "  Connect with key: ${JOIN_CODE}@${NODE_HOST}:${AGENT_PORT}"
echo "============================================="
echo ""
