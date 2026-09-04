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

# On any error, report exactly which line failed (helps one-liner debugging).
trap 'rc=$?; echo ""; echo "${RED}[x] Stopped at line $LINENO (exit $rc) in install-node.sh.${NC}" >&2; exit $rc' ERR
trap 'echo ""' EXIT

# ---------- colors --------------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'
BOLD='\033[1m'; NC='\033[0m'
ok()  { printf "${GREEN}${BOLD}  [PASS]${NC} %s\n" "$1"; }
warn(){ printf "${YELLOW}${BOLD}  [WARN]${NC} %s\n" "$1"; }
fail(){ printf "${RED}${BOLD}  [FAIL]${NC} %s\n" "$1"; }

# ---------- precheck collection (no early exit; report at end) ----------
PRECHECK_PASS=0; PRECHECK_WARN=0; PRECHECK_FAIL=0; PRECHECK_FATAL=0
NO_KVM_DETECTED=0
TUN_URL=""
note_p(){ PRECHECK_PASS=$((PRECHECK_PASS+1)); }
note_w(){ PRECHECK_WARN=$((PRECHECK_WARN+1)); }
note_f(){ PRECHECK_FAIL=$((PRECHECK_FAIL+1)); }

# ---------- universal environment detection ----------
# Sets: SVC (systemd|pm2|launchd|upstart|rc|unknown), VIRT (host|lxc|docker|...)
detect_env() {
  VIRT="host"
  if command -v systemd-detect-virt >/dev/null 2>&1; then
    VIRT="$(systemd-detect-virt 2>/dev/null || echo host)"
  elif [[ -n "$(cat /proc/1/cgroup 2>/dev/null | grep -iE 'docker|lxc|containerd' | head -1)" ]]; then
    VIRT="container"
  elif [[ -d /.dockerenv ]]; then
    VIRT="docker"
  fi
  [[ "$VIRT" == "none" || -z "$VIRT" ]] && VIRT="host"

  SVC="unknown"
  if [[ -d /run/systemd/system ]] || command -v systemctl >/dev/null 2>&1; then
    SVC="systemd"
  elif [[ "$(uname -s)" == "Darwin" ]] && command -v launchctl >/dev/null 2>&1; then
    SVC="launchd"
  elif command -v pm2 >/dev/null 2>&1 || command -v npm >/dev/null 2>&1; then
    SVC="pm2"
  elif [[ -d /etc/init ]] && command -v start >/dev/null 2>&1; then
    SVC="upstart"
  elif [[ -d /etc/init.d ]]; then
    SVC="rc"
  fi
  return 0
}

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

  # 1b. environment / container + service manager detection (universal compat)
  detect_env
  case "$SVC" in
    systemd) ok "Environment: $VIRT (systemd available)"; note_p ;;
    pm2)    warn "Environment: $VIRT — no systemd, will auto-run via PM2"; note_w ;;
    launchd) ok "Environment: $VIRT (macOS launchd available)"; note_p ;;
    upstart) warn "Environment: $VIRT (upstart detected)"; note_w ;;
    rc)     warn "Environment: $VIRT (sysvinit/rc.d)"; note_w ;;
    *)      warn "Environment: $VIRT — unknown init, will fall back to PM2"; note_w ;;
  esac
  # If we are inside a container (LXC/Docker) and the agent port cannot be
  # reached from outside, flag it clearly so the user knows to forward the port.
  if [[ "$VIRT" != "host" ]]; then
    warn "Detected container/virtualization: $VIRT. The agent binds 0.0.0.0:$AGENT_PORT, but a REMOTE panel can only reach it if the container's port is forwarded on the parent host / cloud firewall."; note_w
  fi

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

# ---------- prompt (auto-friendly: defaults accept with Enter) ----------
# Allow passing values via args/env so one-liners need no typing:
#   sudo bash install-node.sh "<name>" "<agent-token>"
#   NODE_NAME=x AGENT_TOKEN=y CLOUDFLARED_TUNNEL_TOKEN=z bash install-node.sh
if [[ -n "$1" ]]; then NODE_NAME="$1"; fi
if [[ -n "$2" ]]; then AGENT_TOKEN="$2"; fi
if [[ -z "$NODE_NAME" ]]; then
  read -r -p "Node name (default Node): " NODE_NAME
  NODE_NAME="${NODE_NAME:-Node}"
fi
if [[ -z "$AGENT_TOKEN" ]]; then
  read -r -p "Agent token (from panel -> Nodes -> Create Node): " AGENT_TOKEN
fi
if [[ -z "$AGENT_TOKEN" ]]; then
  # No token given: generate a join key instead (panel onboards via Connect With Key)
  echo "    [!] No agent token given — the connect key printed at the end will onboard this node."
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

echo "[+] Agent has ZERO npm dependencies (uses Node's built-in crypto) — nothing to install."
cd "$AGENT_DIR"
# sanity check: agent must load without any npm packages
if ! node -e "require('./agent.js')" --check 2>/dev/null; then
  node --check agent.js || { echo "[x] agent.js syntax error — report this." >&2; exit 1; }
fi

# ---------- set node metadata ----------
cat > /tmp/venlix-meta.json <<EOF
{"name":"$NODE_NAME"}
EOF
AGENT_TOKEN="$AGENT_TOKEN" node -e "require('dotenv')" 2>/dev/null || true
# simplest: store name via env on first boot; agent reads AGENT_NODE_NAME
echo "AGENT_NODE_NAME=$NODE_NAME" >> "$AGENT_DIR/.env"

# ---------- service manager (universal: systemd / launchd / upstart / rc / PM2) ----------
start_with_pm2() {
  echo "[+] Setting up agent with PM2..."
  if ! command -v pm2 >/dev/null 2>&1; then
    npm install -g pm2 >/dev/null 2>&1 || true
  fi
  if ! command -v pm2 >/dev/null 2>&1; then
    export PATH="$PATH:/usr/local/bin:/usr/bin:/opt/node/bin"
    command -v pm2 >/dev/null 2>&1 || true
  fi
  if ! command -v pm2 >/dev/null 2>&1; then
    echo "[x] Could not install PM2. Install Node.js >= 16 and retry, or run the agent manually: node $AGENT_DIR/agent.js" >&2
    return 1
  fi
  cd "$AGENT_DIR"
  pm2 start agent.js --name venlix-node --update-env >/dev/null 2>&1 \
    || pm2 start agent.js --name venlix-node >/dev/null 2>&1
  pm2 save >/dev/null 2>&1 || true
  pm2 startup >/dev/null 2>&1 || true
  echo "[+] Agent running via PM2 (name: venlix-node). Auto-restarts on failure."
}

NODE_BIN="$(command -v node || echo /usr/bin/node)"
setup_systemd() {
  echo "[+] Creating systemd service..."
  cat > /etc/systemd/system/venlix-node.service <<EOF
[Unit]
Description=Venlix Nodes - Node Agent (QEMU VM Hypervisor)
After=network.target

[Service]
Type=simple
WorkingDirectory=$AGENT_DIR
EnvironmentFile=$AGENT_DIR/.env
ExecStart=$NODE_BIN $AGENT_DIR/agent.js
Restart=on-failure
RestartSec=3
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable venlix-node 2>/dev/null || true
  systemctl restart venlix-node || true
  systemctl is-active --quiet venlix-node || start_with_pm2
}

setup_launchd() {
  echo "[+] Creating macOS launchd agent..."
  local plist="$HOME/Library/LaunchAgents/com.venlix.node.plist"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.venlix.node</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/env</string><string>node</string><string>$AGENT_DIR/agent.js</string></array>
  <key>WorkingDirectory</key><string>$AGENT_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$AGENT_DIR/agent.log</string>
  <key>StandardErrorPath</key><string>$AGENT_DIR/agent.log</string>
</dict></plist>
EOF
  launchctl unload "$plist" 2>/dev/null || true
  launchctl load "$plist" 2>/dev/null || start_with_pm2
}

case "$SVC" in
  systemd) setup_systemd ;;
  launchd) setup_launchd ;;
  upstart)
    echo "[+] Writing upstart job..."
    cat > /etc/init/venlix-node.conf <<EOF
description "Venlix Node Agent"
start on started networking
stop on runlevel [016]
respawn
env AGENT_DIR=$AGENT_DIR
exec $NODE_BIN \$AGENT_DIR/agent.js
EOF
    start venlix-node 2>/dev/null || true
    ;;
  rc)
    echo "[+] Writing sysvinit script..."
    cat > /etc/init.d/venlix-node <<EOF
#!/bin/sh
### BEGIN INIT INFO
# Provides:          venlix-node
# Required-Start:    $network
# Required-Stop:     $network
# Default-Start:     2 3 4 5
# Default-Stop:      0 1 6
### END INIT INFO
case "\$1" in
  start) (cd $AGENT_DIR && nohup $NODE_BIN agent.js >> $AGENT_DIR/agent.log 2>&1 &) ;;
  stop)  pkill -f "$AGENT_DIR/agent.js" || true ;;
esac
EOF
    chmod +x /etc/init.d/venlix-node
    /etc/init.d/venlix-node start 2>/dev/null || start_with_pm2
    ;;
  *) start_with_pm2 ;;
esac

# ---------- persistent Cloudflare tunnel (container / no-public-IP nodes) ----------
# Installs cloudflared and runs it via the SAME manager (systemd/PM2) so it
# survives reboots. Two modes:
#   - NAMED tunnel (best): needs CLOUDFLARED_TUNNEL_TOKEN or a configured
#     cloudflared login; yields a stable hostname.
#   - QUICK tunnel (fallback): zero-config, stable only while the process runs.
TUN_BIN="/usr/local/bin/cloudflared"
tunnel_ensure_bin() {
  if [[ -x "$TUN_BIN" ]]; then return 0; fi
  echo "    Downloading cloudflared..."
  curl -sSL -o "$TUN_BIN" \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
    && chmod +x "$TUN_BIN" || { echo "    $RED[x]$NC cloudflared download failed ($(uname -s)/$(uname -m) not prebuilt?)."; return 1; }
  return 0
}
run_tunnel_via_manager() {
  # $1 = full cloudflared run command string; runs via systemd or PM2.
  local CMD="$1"
  case "$SVC" in
    systemd)
      cat > /etc/systemd/system/venlix-tunnel.service <<EOF
[Unit]
Description=Venlix Node Cloudflare Tunnel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$CMD
Restart=on-failure
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
      systemctl daemon-reload
      systemctl enable venlix-tunnel 2>/dev/null || true
      systemctl restart venlix-tunnel 2>/dev/null || true
      ;;
    *)
      # PM2 (or any fallback): wrap the command so it survives reboots
      pm2 delete venlix-tunnel >/dev/null 2>&1 || true
      pm2 start bash --name venlix-tunnel -- -c "$CMD" >/dev/null 2>&1 || true
      pm2 save >/dev/null 2>&1 || true
      pm2 startup >/dev/null 2>&1 || true
      ;;
  esac
}
setup_tunnel() {
  echo ""
  echo "  ${BOLD}-- Cloudflare reverse tunnel --${NC}"
  echo "    For a STABLE, persistent node address set env CLOUDFLARED_TUNNEL_TOKEN"
  echo "    (from a Cloudflare named tunnel) before running. Without it we use a"
  echo "    free quick tunnel whose URL rotates across restarts."
  # Auto-prompt for a token if one is needed and not already provided
  if [[ -z "$CLOUDFLARED_TUNNEL_TOKEN" ]] && [[ -z "$TUNNEL_TOKEN" ]]; then
    read -r -p "    Have a Cloudflare named-tunnel token? Paste it (enter = quick tunnel): " TOK
    CLOUDFLARED_TUNNEL_TOKEN="${CLOUDFLARED_TUNNEL_TOKEN:-$TOK}"
  fi
  # 1. Named tunnel if credentials are present
  if [[ -n "$CLOUDFLARED_TUNNEL_TOKEN" ]] || [[ -n "$TUNNEL_TOKEN" ]]; then
    local TOKEN="${CLOUDFLARED_TUNNEL_TOKEN:-$TUNNEL_TOKEN}"
    tunnel_ensure_bin || return 1
    echo "    Using NAMED tunnel (stable hostname). Restarting service..."
    run_tunnel_via_manager "$TUN_BIN tunnel run --token $TOKEN"
    TUN_URL="https://<your-named-tunnel-hostname>"
    echo "    ${GREEN}[+] Named tunnel service installed ($(echo "$SVC")).${NC}"
    echo "    Point Cloudflare DNS at the tunnel, then set the node host in the panel."
    return 0
  fi
  # 2. Quick tunnel fallback (zero-config)
  echo "    No tunnel token set — using a QUICK tunnel (URL changes on restart)."
  if command -v cloudflared >/dev/null 2>&1 || tunnel_ensure_bin; then
    local TUN_LOG="/tmp/cloudflared-venlix.log"
    local URL=""
    # probe once to learn the quick URL
    cloudflared tunnel --url "http://127.0.0.1:${AGENT_PORT}" >"$TUN_LOG" 2>&1 &
    local PID=$!
    for i in 1 2 3 4 5 6; do sleep 2; URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUN_LOG" | head -1)"; [[ -n "$URL" ]] && break; done
    if [[ -n "$URL" ]]; then
      kill "$PID" 2>/dev/null || true
      echo "    Quick tunnel URL: $URL"
      # install it persistently; the quick URL may rotate across restarts
      run_tunnel_via_manager "$TUN_BIN tunnel --url http://127.0.0.1:${AGENT_PORT} --logfile $AGENT_DIR/cloudflared-tunnel.log"
      TUN_URL="$URL"
      echo ""
      echo "    ${GREEN}[+] Tunnel service installed via $SVC (auto-starts on boot).${NC}"
      echo "    The current tunnel address is: $TUN_URL"
      echo "    Use the connect key  ${JOIN_CODE}@${TUN_URL#https://}:443  in the panel."
      echo "    NOTE: quick-tunnel URLs rotate when the service restarts; for a stable address,"
      echo "          re-run with CLOUDFLARED_TUNNEL_TOKEN=<token> to use a named tunnel."
    else
      kill "$PID" 2>/dev/null || true
      echo "    ${YELLOW}[!] Could not get a quick tunnel URL right now. Check internet, or set CLOUDFLARED_TUNNEL_TOKEN for a named tunnel.${NC}"
      TUN_URL=""
    fi
  else
    echo "    ${YELLOW}[!] cloudflared unavailable. Install it, or forward ${AGENT_PORT} manually.${NC}"
    TUN_URL=""
  fi
}

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
# Persist the connect key so the management suite can re-display it later.
echo "${JOIN_CODE}@${NODE_HOST}:${AGENT_PORT}" > "$AGENT_DIR/connect-key.txt" 2>/dev/null || true
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
LOCAL_HTTP="$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${AGENT_PORT}/health" 2>/dev/null)"
LOCAL_HTTP="${LOCAL_HTTP:0:3}"
PUB_HTTP="$(curl -s -m 6 -o /dev/null -w '%{http_code}' "http://${NODE_HOST}:${AGENT_PORT}/health" 2>/dev/null)"
PUB_HTTP="${PUB_HTTP:0:3}"
echo "    Local agent  (127.0.0.1:${AGENT_PORT}/health): ${LOCAL_HTTP}"
echo "    Public reach (${NODE_HOST}:${AGENT_PORT}/health):  ${PUB_HTTP}"
if [[ "$LOCAL_HTTP" == "000" ]]; then
  echo "    ${RED}[x] Agent is NOT responding locally. Check the service (systemctl status venlix-node / pm2 logs venlix-node).${NC}"
elif [[ "$PUB_HTTP" != "200" && "$PUB_HTTP" != "401" && "$PUB_HTTP" != "302" ]]; then
  echo "    ${YELLOW}[!] Agent is up locally but NOT reachable from outside on ${NODE_HOST}:${AGENT_PORT} (curl=$PUB_HTTP).${NC}"
  # Container (LXC/Docker) special case / reverse-tunnel offer
  if [[ "$VIRT" != "host" ]] || [[ "$NODE_HOST" == "<this-server-ip>" ]]; then
    echo ""
    echo "    This looks like a container (${VIRT}) or a host without a directly-bindable public IP."
    echo "    A remote panel cannot reach the agent unless:"
    echo "      (a) the container/parent forwards port ${AGENT_PORT} to this box, OR"
    echo "      (b) we run a persistent reverse tunnel so the agent is reachable via a public URL."
    echo ""
    read -r -p "    Set up a persistent Cloudflare reverse tunnel to expose the agent? [Y/n]: " TR
    if [[ ! "$TR" =~ ^[Nn]$ ]]; then
      TUN_URL=""
      setup_tunnel || true
      if [[ -n "$TUN_URL" ]]; then
        echo ""
        echo "    ${GREEN}[+] Tunnel service installed and auto-start on boot is enabled.${NC}"
        echo "    In your panel, "Connect With Node Key" using the tunnel address given above."
      fi
    fi
  else
    echo "        Open ${AGENT_PORT}/tcp in your VPS/cloud firewall (or run a reverse tunnel / port-forward)."
  fi
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
if [[ -n "$STALE_MIGRATE" ]]; then
  echo "  Prior data kept  : yes (migrated existing node state)"
else
  echo "  Prior data kept  : no (fresh install)"
fi
echo "  Backup of old data: ${BACKUP_DIR:-none (fresh install)}"
echo "  Service manager  : $SVC (detected virt: ${VIRT:-host})"
echo "  Reachability     : local=$LOCAL_HTTP public=$PUB_HTTP"
[[ -n "$TUN_URL" ]] && echo "  Tunnel           : $TUN_URL (auto-start on boot)"
echo ""
echo "  Connect with key: ${JOIN_CODE}@${NODE_HOST}:${AGENT_PORT}"
echo "============================================="
echo ""
