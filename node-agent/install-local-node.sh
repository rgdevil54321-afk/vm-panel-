#!/bin/bash
# ============================================================
# Venlix Nodes - LOCAL Node Agent Installer (same-host as panel)
# Starts the agent via PM2 (like the panel) so it works even
# inside containers where systemd is not running as PID 1.
#   sudo bash node-agent/install-local-node.sh
# ============================================================
set -e

APP_DIR="$(pwd)"
AGENT_DIR="/opt/venlix-node"
AGENT_PORT="${AGENT_PORT:-3005}"
JOIN_CODE="$(cat /dev/urandom | tr -dc 'A-Z0-9' | head -c 12 | sed 's/.\{4\}/&-/g' | sed 's/-$//')"
AGENT_UPDATE_REPO="${AGENT_UPDATE_REPO:-https://github.com/rgdevil54321-afk/vm-panel-.git}"
AGENT_UPDATE_BRANCH="${AGENT_UPDATE_BRANCH:-main}"

echo ""
echo "============================================="
echo "  Venlix Nodes - Local Node Agent (PM2)"
echo "============================================="
echo ""

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
  echo "[x] Could not find the node-agent files. Run this from the venlix-nodes repo root." >&2
  exit 1
fi

# ---------- write env ----------
NODE_NAME="${NODE_NAME:-Primary Node}"
cat > "$AGENT_DIR/.env" <<EOF
AGENT_PORT=$AGENT_PORT
AGENT_HOST=0.0.0.0
AGENT_TOKEN=local-primary-no-agent
AGENT_JOIN_CODE=$JOIN_CODE
AGENT_UPDATE_REPO=$AGENT_UPDATE_REPO
AGENT_UPDATE_BRANCH=$AGENT_UPDATE_BRANCH
AGENT_NODE_NAME=$NODE_NAME
NO_KVM=${NO_KVM:-}
EOF

mkdir -p "$AGENT_DIR/data" "$AGENT_DIR/vms"

echo "[+] Agent has ZERO npm dependencies (Node built-in crypto) — nothing to install."
cd "$AGENT_DIR"
node --check agent.js || { echo "[x] agent.js syntax error." >&2; exit 1; }

# ---------- start via PM2 (works without systemd) ----------
if ! command -v pm2 >/dev/null 2>&1; then
  echo "[+] Installing PM2..."
  if ! timeout 240 npm install -g pm2 --no-audit --no-fund > /tmp/venlix-pm2-npm.log 2>&1; then
    echo "[!] PM2 install failed:"
    tail -n 10 /tmp/venlix-pm2-npm.log || true
    exit 1
  fi
fi
echo "[+] Registering agent with PM2..."
pm2 delete venlix-node >/dev/null 2>&1 || true
pm2 start "$AGENT_DIR/agent.js" --name venlix-node
pm2 save >/dev/null 2>&1 || true
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true

# ---------- create local primary node in the panel DB ----------
echo "[+] Ensuring local primary node in panel DB..."
cd "$APP_DIR"
if [ -f data/vpanel.db ]; then
  node -e "
    try {
      const Database = require('better-sqlite3');
      const db = new Database('data/vpanel.db');
      const row = db.prepare('SELECT id FROM nodes WHERE host = ? AND port = ?').get('127.0.0.1', $AGENT_PORT);
      if (!row) {
        db.prepare('INSERT INTO nodes (name, host, port, agent_token, location, status, last_seen_at, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('$NODE_NAME', '127.0.0.1', $AGENT_PORT, 'local-primary-no-agent', 'Primary Datacenter', 'offline', null, new Date().toISOString(), new Date().toISOString());
        console.log('[✔] Local primary node created (127.0.0.1:' + $AGENT_PORT + ').');
      } else {
        console.log('[i] Local primary node already exists.');
      }
    } catch (e) { console.log('[!] Could not create primary node: ' + e.message); }
  "
else
  echo "[!] data/vpanel.db not found here — skipping primary node creation. Run this from the panel repo root or onboard via Connect With Key."
fi

echo ""
echo "============================================="
echo "  Local Node Agent installed (PM2)"
echo "============================================="
echo "  Agent       : $AGENT_DIR/agent.js"
echo "  Listen      : 0.0.0.0:$AGENT_PORT"
echo "  Manage      : pm2 status venlix-node | pm2 logs venlix-node"
echo "============================================="
