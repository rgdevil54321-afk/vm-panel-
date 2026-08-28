<div align="center">

# ⚡ Venlix Nodes
### Multi-Node QEMU/KVM Virtual Machine Management Web Panel

[![Node.js](https://img.shields.io/badge/Node.js-v18+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express.js-000000?style=for-the-badge&logo=express&logoColor=white)](https://expressjs.com)
[![QEMU](https://img.shields.io/badge/QEMU-Virtualization-FF6600?style=for-the-badge&logo=qemu&logoColor=white)](https://www.qemu.org/)
[![SQLite](https://img.shields.io/badge/better--sqlite3-003B57?style=for-the-badge&logo=sqlite&logoColor=white)](https://github.com/WiseLibs/better-sqlite3)
[![License](https://img.shields.io/badge/License-MIT-6366F1?style=for-the-badge)](LICENSE)

*A high-performance, dark glassmorphic, multi-node control panel for hosting, managing, and automating QEMU virtual servers across a cluster of hypervisor nodes.*

---

</div>

## 🌟 Highlights & Key Features

### 🎨 1. Cosmic Glassmorphism UI & Studio
- **Deep Slate Dark Design**: Modern translucent glass cards with glowing accent halo borders (`--panel-blur`, `--panel-transparency`).
- **Integrated 4K Wallpaper Browser**: Browse, search, preview, favorite, and 1-click apply high-res 4K wallpapers directly from [4kwallpapers.com](https://4kwallpapers.com/) across 15+ categories (*Anime, Space, Dark/AMOLED, Nature, Supercars, Gaming, Abstract, etc.*).
- **Interactive Sliders**: Real-time CSS Backdrop Blur (0px – 40px) and UI Transparency (0% – 100%) controls without page reloads.
- **Custom Media Backgrounds**: Upload local images or looping video backgrounds (`.mp4`, `.webm`).

### ⚡ 2. Intuitive VM Creation Wizard
- **⚡ Hardware Sizing Presets**: 1-click quick presets (*Starter, Standard, Compute/Dev, Powerhouse*).
- **Dual-Control Resource Sliders**: Real-time synchronized range sliders and inputs for vCPUs and RAM.
- **Filterable Distro Grid**: Cloud-image support for **Ubuntu** (22.04, 24.04), **Debian** (11, 12, 13), **Fedora** (40), **CentOS Stream**, **AlmaLinux**, and **Rocky Linux**.
- **Live Deployment Blueprint**: Real-time sticky summary card updating specifications and cost calculations as you configure.

### 💻 3. Next-Gen SSH Terminal & Serial Boot Logs
- **Integrated Xterm.js Console**: Responsive web terminal connecting directly to guest instances over SSH.
- **Kernel Boot & Startup Logs**: Dual-tab interface streaming live QEMU serial output, kernel messages, and cloud-init progress in real time.
- **Toolbar Utilities**: Auto-refresh toggle (3s polling), auto-scroll, and 1-click clipboard copy.

### 📁 4. High-Performance File Manager
- **Guest Agent & SSH Dual-Engine**: Ultra-fast file operations with automatic graceful fallback.
- **Accurate File Size Sizing**: Monospace human-readable formatting (`Bytes, KB, MB, GB`).
- **Large Code Editor Modal**: Fullscreen multi-line editor (`width: min(1000px, 96vw)`) with monospace fonts and UTF-8 support.
- **Multi-File Uploads**: Drag-and-drop or select multi-file uploads with payload support up to 200MB+.

### 🛡️ 5. Multi-User & Enterprise Security
- **Role-Based Access Control**: Root Administrators and Standard Users.
- **Subuser Delegation**: Assign granular per-server permissions (*Console, File Manager, Backups, Power Controls*).
- **Two-Factor Authentication (2FA)**: TOTP authenticator app support (Google Authenticator, Authy).
- **Comprehensive Audit Logs**: Real-time event timeline logging all VM power actions, logins, and permission changes.

### 💾 6. Snapshots & Cron Automation
- **Instant Disk Backups**: 1-click snapshot creation, restoration, and raw disk download.
- **Automated Scheduling**: Standard 5-field Cron automation for automatic backups, restarts, and routine maintenance.

---

## 🏗️ Architecture & Tech Stack

```text
┌─────────────────────────────────────────────────────────────┐
│                       vPanel Pro UI                         │
│   (Glassmorphism CSS • EJS Templates • Socket.IO • Xterm)   │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTP / WebSocket (Port 3001)
┌──────────────────────────────▼──────────────────────────────┐
│                    Node.js + Express Core                   │
│  (Auth Middleware • SQLite/better-sqlite3 • VM Orchestrator)│
└──────────────┬──────────────────────────────┬───────────────┘
               │                              │
┌──────────────▼──────────────┐┌──────────────▼───────────────┐
│     QEMU Hypervisor Engine  ││     vPanel Guest Agent       │
│  (-drive, -smp, -m, -netdev)││  (Python HTTP Daemon / SSH)  │
└─────────────────────────────┘└──────────────────────────────┘
```

---

## 📋 System Requirements

- **Operating System**: Linux (Ubuntu 20.04+, Debian 11+, RHEL/CentOS 9+, Fedora, Arch Linux)
- **Node.js**: v18.0.0 or higher (Node 20+ recommended)
- **Hypervisor**: QEMU (`qemu-system-x86_64`, `qemu-img`)
- **Utilities**: `cloud-image-utils` (`cloud-localds`), `wget`, `openssl`, `python3`

---

## 🚀 Quick Start & Installation

### Option 1: Automated Setup (Recommended)

```bash
# Clone the repository
git clone https://github.com/nobita329/vpanel-pro.git
cd vpanel-pro

# Run the automated installer
sudo bash install.sh --admin-pass 'your_secure_password'
```

### Option 2: Manual Installation

```bash
# 1. Clone repository and install dependencies
git clone https://github.com/nobita329/vpanel-pro.git
cd vpanel-pro
npm install

# 2. Build assets
npm run build

# 3. Create administrator account
npm run createuser

# 4. Start vPanel Pro
npm start
```

### Production Deployment with PM2

```bash
# Start cluster process
pm2 start ecosystem.config.js

# Save process list for system reboot
pm2 save
pm2 startup
```

---

## 🌐 Default Ports & Access

| Service | Default URL | Description |
| :--- | :--- | :--- |
| **Web Panel** | `http://<host_ip>:3001` | Main user dashboard and management interface |
| **REST API** | `http://<host_ip>:3001/api` | RESTful API for automation & integrations |
| **VM Port Range** | `25501 - 25600` | Dynamic host-forwarded SSH ports |
| **Agent Port Range**| `26101 - 26200` | Internal guest-daemon communication |

---

## ⚙️ Configuration Environment (`.env`)

```ini
# Panel Ports & Server
PANEL_PORT=3001
API_PORT=3002
NODE_ENV=production

# Security & Secrets
JWT_SECRET=your_super_secret_jwt_key_here
ALLOW_REGISTER=1
FORCE_TFA=0

# Storage Locations
VM_DIR=./vms
DB_PATH=./data/vpanel.db

# Automatic Port Forwarding Ranges
AUTO_PORT_MIN=25501
AUTO_PORT_MAX=25600
AUTO_AGENT_PORT_MIN=26101
AUTO_AGENT_PORT_MAX=26200
```

---

## 🔌 API Reference Overview

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/login` | Authenticate and obtain JWT bearer token |
| `GET` | `/api/vms` | List all accessible virtual machines |
| `POST` | `/api/vms/:id/action` | Trigger power action (`start`, `stop`, `restart`, `kill`) |
| `GET` | `/api/vms/:id/bootlog` | Stream kernel boot & serial output logs |
| `GET` | `/api/vms/:id/files?path=/` | List files and directories in guest filesystem |
| `GET` | `/api/vms/:id/files/download` | Download file from guest |
| `POST` | `/api/vms/:id/files/upload` | Upload binary/text file to guest |
| `GET` | `/api/wallpapers?category=all` | Browse 4K wallpaper library with search & pagination |
| `POST` | `/api/wallpapers/apply` | 1-click apply wallpaper and glassmorphism styles |

---

## 📜 License

Distributed under the MIT License. See `LICENSE` for more information.

<div align="center">
  <sub>Built with ❤️ by <a href="https://github.com/nobita329">Nobita</a> for developers and sysadmins worldwide.</sub>
</div>
