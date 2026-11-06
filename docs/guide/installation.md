---
title: "Installation on Ubuntu Linux"
description: "Prerequisites, automated environment setup, and installation steps for OpenCode Router on Ubuntu 24.04 LTS x86_64."
---

# Installation on Ubuntu Linux

This guide details system prerequisites, environment setup, and installation steps for **OpenCode Router** on Linux.

---

## Supported Operating Systems

| Distribution | Status | Architecture | Verification Notes |
| :--- | :---: | :---: | :--- |
| **Ubuntu 24.04 LTS** | **Tested & Verified** | x86_64 | Primary development, build, and test validation platform. |
| Ubuntu 22.04 LTS | *Likely Compatible* | x86_64 | Untested; requires Node.js >= 18.0.0. |
| Debian 12 (Bookworm) | *Likely Compatible* | x86_64 | Untested; standard Debian package dependencies apply. |
| Fedora / Arch Linux | *Untested* | x86_64 | Untested; curl and unzip dependencies apply. |
| macOS / Windows | *Unsupported* | Any | Linux-specific paths and launcher scripts utilized. |

---

## Prerequisites

Before installing, ensure the required utilities and runtime environments are installed on your Ubuntu host:

```bash
# Update package repositories
sudo apt update

# Install system utilities
sudo apt install -y curl unzip git

# Verify Node.js (version 18.0.0 or higher required)
node -v
npm -v
```

If Node.js is not installed, install it using the official NodeSource repository or nvm:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

---

## Step-by-Step Installation

### 1. Clone the Repository
```bash
git clone https://github.com/EhsanCreator/OpenCode-Router.git
cd OpenCode-Router
```

### 2. Install Node Dependencies
```bash
npm install
```

### 3. Run Automated Startup Script
```bash
./start.sh
```

The `start.sh` script automatically performs the following tasks:
1. **Xray-Core Provisioning**: Detects host architecture (`x86_64` or `arm64`) and downloads the official release if `bin/xray` is missing.
2. **Frontend Compilation**: Builds the Vite/React application if `dist/` is not present.
3. **Permissions Setup**: Marks `bin/opencode-vpn` executable.
4. **Service Launch**: Starts the backend Express service on port `3000`.
5. **Browser Launch**: Opens `http://localhost:3000` in your default desktop browser.

---

## Desktop Integration (Optional)

To integrate OpenCode Router into your Ubuntu desktop and application launcher menu:
```bash
./scripts/create-desktop-launcher.sh
```
This generates:
- `~/Desktop/OpenCode-Router.desktop`
- `~/.local/share/applications/opencode-router.desktop`

---

## Making `opencode-vpn` Available Globally

To run the dedicated launcher from any terminal directory without entering the project path:
```bash
mkdir -p ~/.local/bin
ln -sf "$(pwd)/bin/opencode-vpn" ~/.local/bin/opencode-vpn
```
Ensure `~/.local/bin` is in your shell `$PATH`.
