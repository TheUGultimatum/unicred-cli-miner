#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

if [[ $EUID -eq 0 ]]; then SUDO=""; else SUDO="sudo"; fi

$SUDO apt-get update
$SUDO apt-get install -y nodejs npm chromium ca-certificates curl

node -v
npm -v
chromium --version || true

npm install --omit=dev
chmod +x miner.js

mkdir -p "$HOME/.config/unicred-miner"
chmod 700 "$HOME/.config/unicred-miner"

cat > "$HOME/.config/unicred-miner/config.env.example" <<'CFG'
# Example only. Never commit a real key.
# chmod 600 ~/.config/unicred-miner/config.env
# UNICRED_PRIVATE_KEY=0x...
# UNICRED_RPC_URL=https://mainnet.unichain.org
# UNICRED_AUTO_SUBMIT=1
# UNICRED_USAGE=100
CFG
chmod 600 "$HOME/.config/unicred-miner/config.env.example"

echo
echo "Installed."
echo "Safe test: node miner.js --dry-run"
echo "Submission:  UNICRED_PRIVATE_KEY=0x... node miner.js --submit"
