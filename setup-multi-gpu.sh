#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
WORKDIR="${ROOT}/.multi-gpu-tools"
PREFIX="/opt/unicred-vkdevicechooser"
REPO="https://github.com/aejsmith/vkdevicechooser.git"
REF="1.0"
VULKAN_LOADER_REF="v1.3.275"
VULKAN_LAYER_HEADER="$WORKDIR/include/vulkan/vk_layer_dispatch_table.h"

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
  vulkan-tools libvulkan-dev \
  vulkan-validationlayers vulkan-utility-libraries-dev

mkdir -p "$WORKDIR/include/vulkan"

# vkdevicechooser 1.0 includes Vulkan Loader\x27s generated internal dispatch-table
# header. Ubuntu 24.04\x27s libvulkan-dev does not ship that generated header.
if [[ ! -s "$VULKAN_LAYER_HEADER" ]]; then
  echo "[VULKAN] Installing generated Vulkan Loader layer dispatch header..."
  curl -fsSL \
    "https://raw.githubusercontent.com/KhronosGroup/Vulkan-Loader/${VULKAN_LOADER_REF}/loader/generated/vk_layer_dispatch_table.h" \
    -o "$VULKAN_LAYER_HEADER"
fi

if [[ ! -s "$VULKAN_LAYER_HEADER" ]]; then
  echo "ERROR: failed to obtain $VULKAN_LAYER_HEADER"
  exit 1
fi


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
rm -rf "$WORKDIR/build"
export CXXFLAGS="-I$WORKDIR/include ${CXXFLAGS:-}"
meson setup "$WORKDIR/build" . --prefix="$PREFIX"

echo "[BUILD] Compiling..."
meson compile -C "$WORKDIR/build"

echo "[INSTALL] Installing..."
$SUDO rm -rf "$PREFIX"
$SUDO meson install -C "$WORKDIR/build"

LAYER_MANIFEST="$PREFIX/share/vulkan/implicit_layer.d/vkdevicechooser.json"
LAYER_LIB_MULTIARCH="$PREFIX/lib/x86_64-linux-gnu/libvkdevicechooser.so"
LAYER_LIB="$PREFIX/lib/libvkdevicechooser.so"

if [[ ! -f "$LAYER_MANIFEST" ]]; then
  echo "ERROR: vkdevicechooser manifest not found:"
  echo "  $LAYER_MANIFEST"
  find "$PREFIX" -maxdepth 5 -type f | sort || true
  exit 1
fi

# Meson installs the shared library under the Debian/Ubuntu multiarch lib
# directory. vkdevicechooser's manifest intentionally names the library by
# basename, so expose that library through the prefix's normal lib directory
# and the dynamic linker path.
if [[ ! -f "$LAYER_LIB" && -f "$LAYER_LIB_MULTIARCH" ]]; then
  $SUDO ln -sfn "$LAYER_LIB_MULTIARCH" "$LAYER_LIB"
fi

if [[ ! -f "$LAYER_LIB" ]]; then
  echo "ERROR: vkdevicechooser library not found:"
  find "$PREFIX" -maxdepth 5 -type f -name 'libvkdevicechooser.so' -print || true
  exit 1
fi

$SUDO mkdir -p /etc/vulkan/implicit_layer.d
$SUDO cp "$LAYER_MANIFEST" /etc/vulkan/implicit_layer.d/vkdevicechooser.json

$SUDO tee /etc/ld.so.conf.d/unicred-vkdevicechooser.conf >/dev/null <<EOF
$PREFIX/lib
$PREFIX/lib/x86_64-linux-gnu
EOF
$SUDO ldconfig

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
