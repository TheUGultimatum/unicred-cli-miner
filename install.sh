#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

if [[ $EUID -eq 0 ]]; then
  SUDO=""
  CONFIG_DIR="/root/.config/unicred-miner"
else
  SUDO="sudo"
  CONFIG_DIR="$HOME/.config/unicred-miner"
fi

export DEBIAN_FRONTEND=noninteractive

echo "== Unicred CLI Miner: automatic Ubuntu setup =="

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This installer requires Ubuntu/Debian with apt."
  exit 1
fi

$SUDO apt-get update

echo "[1/6] Installing base + Chromium + Vulkan dependencies..."
$SUDO apt-get install -y \
  ca-certificates curl git wget gnupg lsb-release software-properties-common \
  pciutils procps psmisc jq unzip xz-utils fontconfig dbus dbus-x11 \
  libglib2.0-0t64 libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 \
  libcups2t64 libdrm2 libgbm1 libgtk-3-0t64 libx11-6 libx11-xcb1 libxcb1 \
  libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
  libxshmfence1 libxss1 libxtst6 libasound2t64 libfontconfig1 libfreetype6 \
  libexpat1 libvulkan1 vulkan-tools mesa-vulkan-drivers mesa-utils

for pkg in libglvnd0 nvidia-vulkan-icd; do
  if apt-cache show "$pkg" >/dev/null 2>&1; then
    $SUDO apt-get install -y "$pkg" || true
  fi
done

echo "[2/6] Checking NVIDIA driver..."
NVIDIA_OK=0
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
  NVIDIA_OK=1
  nvidia-smi --query-gpu=name,driver_version,memory.total,utilization.gpu --format=csv,noheader || true
fi

IS_WSL=0
if [[ -d /usr/lib/wsl || -d /usr/lib/wsl/lib ]]; then
  IS_WSL=1
fi

if [[ "$NVIDIA_OK" -eq 0 && "$IS_WSL" -eq 0 ]]; then
  echo "No working NVIDIA driver detected. Installing Ubuntu's recommended driver..."
  $SUDO apt-get install -y ubuntu-drivers-common
  $SUDO ubuntu-drivers autoinstall || true
elif [[ "$NVIDIA_OK" -eq 0 && "$IS_WSL" -eq 1 ]]; then
  echo "WSL/host GPU passthrough detected; host controls the NVIDIA driver. Skipping driver replacement."
fi

echo "[3/6] Installing Node.js 20+ if needed..."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "Node.js 20+ required, found $(node --version)"
  exit 1
fi

echo "Node: $(node --version)"
echo "npm:  $(npm --version)"

echo "[4/6] Installing project dependencies..."
rm -rf node_modules
npm install

echo "[5/6] Installing Playwright Chromium + remaining system deps..."
npx playwright install chromium
npx playwright install-deps chromium || true

chmod +x miner.js
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

cat > "$CONFIG_DIR/config.env.example" <<'CFG'
# NEVER commit a real private key.
# UNICRED_PRIVATE_KEY=0x...
# UNICRED_RPC_URL=https://mainnet.unichain.org
# UNICRED_AUTO_SUBMIT=1
# UNICRED_USAGE=100
CFG
chmod 600 "$CONFIG_DIR/config.env.example"

echo "[6/6] Final GPU/Vulkan checks..."
echo "--- NVIDIA ---"
command -v nvidia-smi && nvidia-smi --query-gpu=name,driver_version,memory.total,utilization.gpu --format=csv,noheader || true

echo "--- Vulkan ---"
command -v vulkaninfo && vulkaninfo --summary 2>/dev/null | grep -E 'deviceName|driverName|apiVersion' | head -n 20 || true

echo "--- Playwright ---"
node -e "const {chromium}=require('playwright'); console.log(chromium.executablePath())"

echo
echo "Installation complete."
echo "SAFE TEST:"
echo "  cd $ROOT"
echo "  node miner.js --dry-run"
echo
echo "Do NOT use --submit until the dry-run reports an NVIDIA WebGPU adapter."
