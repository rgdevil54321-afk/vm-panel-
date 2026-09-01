#!/bin/bash
# ============================================================
# Venlix Nodes - ONE-LINE node installer
#
#   sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/rgdevil54321-afk/vm-panel-/main/bootstrap.sh)"
#
#   OR  (download once, then run)
#   curl -fsSL -o /tmp/vn-bootstrap.sh https://raw.githubusercontent.com/rgdevil54321-afk/vm-panel-/main/bootstrap.sh
#   sudo bash /tmp/vn-bootstrap.sh
#
# Does EVERYTHING automatically:
#   - installs missing deps (git, curl, node, qemu)
#   - runs the eligibility precheck
#   - installs the node agent (systemd or PM2, auto-detected)
#   - if the node is not publicly reachable (container / LXC / no public IP),
#     it asks for a Cloudflare token and sets up a persistent tunnel
#   - prints the connect key for your panel
# ============================================================
set -e

REPO_URL="https://github.com/rgdevil54321-afk/vm-panel-.git"
REPO_BRANCH="main"
INSTALL_DIR="/opt/venlix-node-installer"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'

echo ""
echo "=============================================="
echo "  Venlix Nodes - one-line Node installer"
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

# -------- fetch the installer repo --------
echo "[+] Fetching installer code..."
if [[ -d "$INSTALL_DIR/.git" ]]; then
  (cd "$INSTALL_DIR" && git fetch --depth 1 origin "$REPO_BRANCH" >/dev/null 2>&1 && git reset --hard "origin/$REPO_BRANCH" >/dev/null 2>&1) || true
else
  mkdir -p "$INSTALL_DIR"
  git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$INSTALL_DIR" >/dev/null 2>&1 || {
    echo "${RED}[x] Could not clone the installer repo. Check network / github access.${NC}" >&2
    exit 1
  }
fi

cd "$INSTALL_DIR"

# -------- run the real installer (pass through any env the user set) --------
echo ""
echo "[+] Starting the node-agent installer..."
sudo bash node-agent/install-node.sh "$@"

echo ""
echo "${GREEN}== One-line install finished. Use the connect key above in your panel. ==${NC}"
echo ""