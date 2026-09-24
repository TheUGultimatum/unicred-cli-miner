#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
WORKDIR="\${ROOT}/.multi-gpu-tools"
PREFIX="/opt/unicred-vkdevicechooser"
REPO="https://github.com/aejsmith/vkdevicechooser.git"
REF="1.0"

if [[ $EUID -eq 0 ]]; then
  SUDO=""
else
  SUDO="sudo"
fi

export DEBIAN_FRONTEND=noninteractive

echo "== Unicred Multi-GPU experimental setup =="

$SUDO apt-get update
$SUDO apt-get install -y \
  git g++ make meson ninja-build pkg-config jq \
  vulkan-tools vulkan-headers libvulkan-dev \
  vulkan-validationlayers vulkan-validationlayers-dev

mkdir -p "$WORKDIR"

if [[ ! -d "$WORKDIR/vkdevicechooser/.git" ]]; then
  rm -rf "$WORKDIR/vkdevicechooser"
  git clone --depth 1 --branch "$REF" "$REPO" "$WORKDIR/vkdevicechooser"
else
  git -C "$WORKDIR/vkdevicechooser" fetch --depth 1 origin "$REF"
  git -C "$WORKDIR/vkdevicechooser" checkout -f "$REF"
fi

cd "$WORKDIR/vkdevicechooser"

if [[ -d "$WORKDIR/build" ]]; then
  rm -rf "$WORKDIR/build"
fi

echo "[BUILD] Configuring vkdevicechooser..."
meson setup "$WORKDIR/build" . --prefix="$PREFIX"

echo "[BUILD] Compiling..."
meson compile -C "$WORKDIR/build"

echo "[INSTALL] Installing..."
$SUDO rm -rf "$PREFIX"
$SUDO meson install -C "$WORKDIR/build"

LAYER_MANIFEST="$PREFIX/share/vulkan/implicit_layer.d/vkdevicechooser.json"
LAYER_LIB="$PREFIX/lib/libvkdevicechooser.so"

if [[ ! -f "$LAYER_MANIFEST" ]]; then
  echo "ERROR: vkdevicechooser manifest not found:"
  echo "  $LAYER_MANIFEST"
  find "$PREFIX" -maxdepth 5 -type f | sort || true
  exit 1
fi

if [[ ! -f "$LAYER_LIB" ]]; then
  echo "ERROR: vkdevicechooser library not found:"
  echo "  $LAYER_LIB"
  find "$PREFIX" -maxdepth 5 -type f | sort || true
  exit 1
fi

$SUDO mkdir -p /etc/vulkan/implicit_layer.d
$SUDO cp "$LAYER_MANIFEST" /etc/vulkan/implicit_layer.d/vkdevicechooser.json

cat <<EOF | $SUDO tee /etc/profile.d/unicred-multi-gpu.sh >/dev/null
export UNICRED_VKDEVICECHOOSER=1
export VK_ADD_LAYER_PATH="$PREFIX/share/vulkan/implicit_layer.d"
EOF

$SUDO chmod 644 /etc/profile.d/unicred-multi-gpu.sh

echo
echo "== Vulkan devices =="
vulkaninfo --summary 2>/dev/null | grep -E 'GPU[0-9]+|deviceName|vendorID|deviceID' | head -n 80 || true

echo
echo "== Installed vkdevicechooser =="
echo "Manifest: $LAYER_MANIFEST"
echo "Library:  $LAYER_LIB"

echo
echo "Safe validation examples:"
echo "  node multi-gpu.js --map"
echo "  node multi-gpu.js --probe"
echo
echo "Do NOT start experimental mining until every requested GPU passes --probe."
