#!/usr/bin/env bash
set -e

echo "========================================="
echo "  Starting vPanel Pro Container Service  "
echo "========================================="

# Detect KVM availability
if [ "$NO_KVM" = "1" ] || [ "$NOKVM" = "1" ] || [ ! -e "/dev/kvm" ]; then
  echo "[vpanel] Operating Mode: No-KVM (QEMU TCG Software Emulation)"
  export NO_KVM=1
else
  echo "[vpanel] Operating Mode: KVM Hardware Accelerated (/dev/kvm)"
  export NO_KVM=0
fi

# Ensure persistent storage directories exist
mkdir -p /app/data /app/vms /app/uploads/logo /app/uploads/favicon /app/uploads/background /app/uploads/music /app/uploads/backup /app/storage/logs

# Run build / directory initialization
node scripts/build.js

# If database is fresh and has no users, create default admin
if [ -f "/app/scripts/createuser.js" ]; then
  node -e "
    const { db } = require('./src/lib/db');
    const row = db.prepare('SELECT COUNT(*) as count FROM users').get();
    if (row.count === 0) {
      console.log('[vpanel] Creating default administrator user: admin / admin123');
      const auth = require('./src/services/authService');
      auth.createUser({
        username: process.env.ADMIN_USER || 'admin',
        email: process.env.ADMIN_EMAIL || 'admin@vpanel.local',
        password: process.env.ADMIN_PASSWORD || 'admin123',
        name: 'Administrator',
        role: 'admin',
        root_admin: 1,
        verified: 1
      });
    }
  " || true
fi

echo "[vpanel] Ready on port 3001 (Web) and port 3002 (API)"
exec "$@"
