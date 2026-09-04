#!/bin/bash
# ============================================================
# Venlix Nodes - ONE-LINE MASTER installer / management suite
#
#   sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/rgdevil54321-afk/vm-panel-/main/bootstrap.sh)"
#
#   OR  (download once, then run)
#   curl -fsSL -o /tmp/vn-bootstrap.sh https://raw.githubusercontent.com/rgdevil54321-afk/vm-panel-/main/bootstrap.sh
#   sudo bash /tmp/vn-bootstrap.sh
#
# Fetches the repo and launches the full MANAGEMENT SUITE (install.sh),
# which lets you manage EVERYTHING from one place:
#   1. Install the full panel (npm deps, admin, PM2)
#   2. Create / reset admin user
#   3. Update (git pull + rebuild + reload)
#   4. PM2 management (status / restart / logs / boot)
#   5. Uninstall
#   6. Install node agent (connect this machine to the panel)
#   7. System status (health, nodes, pm2, resources)
#   8. Backup / Restore (DB + VMs + uploads)
#   9. Firewall wizard (open panel/node/VM ports)
#  10. Node management (status, tunnel, connect key)
#  11. SSL / HTTPS via Caddy
#  12. Change ports (panel / api / agent)
#
# To go STRAIGHT to one action, pass the option number/name:
#   sudo bash .../bootstrap.sh --install        # full panel install
#   sudo bash .../bootstrap.sh --node           # install node agent only
#   sudo bash .../bootstrap.sh --pm2            # PM2 management menu
#   sudo bash .../bootstrap.sh --status         # system status overview
#   sudo bash .../bootstrap.sh --backup         # backup / restore
#   sudo bash .../bootstrap.sh --firewall       # firewall wizard
#   sudo bash .../bootstrap.sh --create-admin   # admin setup
#   sudo bash .../bootstrap.sh --update         # update panel
#   sudo bash .../bootstrap.sh --uninstall      # uninstall
# ============================================================
set -e

REPO_URL="https://github.com/rgdevil54321-afk/vm-panel-.git"
REPO_BRANCH="main"
INSTALL_DIR="/opt/venlix-nodes"

  RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; BOLD=$'\033[1m'; NC=$'\033[0m'

echo ""
echo "=============================================="
echo "  Venlix Nodes - MASTER Management Suite"
echo "=============================================="
echo ""

# -------- deps needed to fetch the repo --------
for c in curl git; do
  if ! command -v "$c" >/dev/null 2>&1; then
    echo "[+] Installing $c..."
    if command -v apt-get >/dev/null 2>&1; then
      DEBIAN_FRONTEND=noninteractive apt-get update -y -qq >/dev/null 2>&1
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$c" >/dev/null 2>&1
    fi
  fi
done

# -------- fetch the repo --------
echo "[+] Fetching management suite code..."
if [[ -d "$INSTALL_DIR/.git" ]]; then
  (cd "$INSTALL_DIR" && git fetch --depth 1 origin "$REPO_BRANCH" >/dev/null 2>&1 && git reset --hard "origin/$REPO_BRANCH" >/dev/null 2>&1) || true
else
  mkdir -p "$INSTALL_DIR"
  git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$INSTALL_DIR" >/dev/null 2>&1 || {
    echo "${RED}[x] Could not clone the repo. Check network / github access.${NC}" >&2
    exit 1
  }
fi

cd "$INSTALL_DIR"

# -------- launch the master menu (or a specific action) --------
echo ""
echo "  Code ready at: $INSTALL_DIR"
echo ""
# Forward the cloudflare token so tunneled-node installs can be hands-off.
export CLOUDFLARED_TUNNEL_TOKEN="${CLOUDFLARED_TUNNEL_TOKEN:-}"

if [ $# -gt 0 ]; then
  echo "[+] Running action: $*"
  sudo bash install.sh "$@"
else
  echo "[+] Launching the master management menu..."
  sudo bash install.sh
fi

echo ""
echo ""
echo "${GREEN}== Master suite finished. You can reopen it anytime with:${NC}"
echo "    sudo bash install.sh"
echo "    (or) sudo bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/rgdevil54321-afk/vm-panel-/main/bootstrap.sh)\""
echo ""