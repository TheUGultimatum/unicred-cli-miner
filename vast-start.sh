#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "=============================================="
echo "        UNICRED VAST GPU SETUP / TEST"
echo "=============================================="

if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "ERROR: nvidia-smi not found. This is not a usable NVIDIA GPU container."
  exit 1
fi

echo
echo "[1/5] NVIDIA"
nvidia-smi --query-gpu=index,name,driver_version,memory.total,utilization.gpu --format=csv,noheader

echo
echo "[2/5] Vast container"
echo "NVIDIA_VISIBLE_DEVICES=\${NVIDIA_VISIBLE_DEVICES:-unset}"
echo "NVIDIA_DRIVER_CAPABILITIES=\${NVIDIA_DRIVER_CAPABILITIES:-unset}"

echo
echo "[3/5] Install"
chmod +x install.sh
./install.sh

echo
echo "[4/5] Vulkan"
if command -v vulkaninfo >/dev/null 2>&1; then
  vulkaninfo --summary 2>&1 | grep -E 'deviceName|driverName|deviceType' | head -n 40 || true
else
  echo "vulkaninfo not installed"
fi

echo
echo "[5/5] Safe WebGPU test"
node miner.js --dry-run

echo
echo "If WebGPU reports an NVIDIA adapter, run:"
echo
echo "  export UNICRED_PRIVATE_KEY='0xYOUR_PRIVATE_KEY'"
echo "  node miner.js --submit --usage 100"
echo
echo "Stats are printed every 5 seconds."
echo "The miner refuses SwiftShader/llvmpipe by default."
echo
echo "IMPORTANT: 2 GPUs being visible does not mean one browser miner uses both."
echo "Do not launch duplicate miners against the same Unicred race until work partitioning is verified."
