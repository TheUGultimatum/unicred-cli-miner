#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

if [[ $EUID -eq 0 ]]; then SUDO=""; else SUDO="sudo"; fi

echo "== Unicred CLI Miner installer =="

$SUDO apt-get update
$SUDO apt-get install -y ca-certificates curl git

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
fi

echo "Node: $(node --version)"
echo "npm:  $(npm --version)"

rm -rf node_modules
npm install

# Do not use Ubuntu's chromium snap wrapper.
# Playwright installs and launches its own compatible Chromium build.
npx playwright install --with-deps chromium

chmod +x miner.js

mkdir -p /root/.config/unicred-miner
chmod 700 /root/.config/unicred-miner

cat > /root/.config/unicred-miner/config.env.example <<'CFG'
# Example only. NEVER put a real private key in GitHub.
# chmod 600 /root/.config/unicred-miner/config.env
# UNICRED_PRIVATE_KEY=0x...
# UNICRED_RPC_URL=https://mainnet.unichain.org
# UNICRED_AUTO_SUBMIT=1
# UNICRED_USAGE=100
CFG
chmod 600 /root/.config/unicred-miner/config.env.example

echo
echo "Installation complete."
echo
echo "Run a safe GPU/browser test first:"
echo "  cd $ROOT"
echo "  node miner.js --dry-run"
