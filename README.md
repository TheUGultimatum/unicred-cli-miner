# Unicred CLI Miner

A Vast/Ubuntu runner for the official Unicred.fun browser proof-of-work miner.

## Vast.ai setup

Vast provides Linux Docker instances and supports SSH, Jupyter and command-only access. The Tunnels page is for exposing application ports; you do not need a tunnel for this miner. Use the instance's Connect/SSH or terminal interface.

Recommended instance:
- NVIDIA RTX 5090/4090/3090
- CUDA base image
- Linux
- SSH or Jupyter
- enough disk for Chromium and dependencies

Your current Vast setup with 2x RTX 5090 and a CUDA base image is suitable for testing.

## Install / test

```bash
git clone https://github.com/TheUGultimatum/unicred-cli-miner.git
cd unicred-cli-miner
chmod +x vast-start.sh
./vast-start.sh
```

The installer:
- checks all NVIDIA GPUs
- installs Node.js 20+
- installs Playwright
- installs Chromium
- installs Vulkan and Chromium runtime libraries
- runs NVIDIA/Vulkan checks
- runs a WebGPU dry run

## Safe test

```bash
node miner.js --dry-run
```

The miner launches Chromium with high-performance GPU flags and refuses software rendering by default.

Successful output should include an NVIDIA WebGPU adapter, not SwiftShader or llvmpipe.

## Real mining

Only after the dry run passes:

```bash
export UNICRED_PRIVATE_KEY='0xYOUR_KEY'
node miner.js --submit --usage 100
```

Never commit the key to GitHub or put it in screenshots.

## Live stats

Every 5 seconds the CLI reports:
- Unicred page hashrate
- WebGPU adapter
- each GPU's utilization
- temperature
- power draw
- VRAM usage
- driver version
- visible Unicred status/difficulty/race lines
- uptime

## 2x GPU note

`nvidia-smi` showing 2 GPUs does not automatically mean a single Chromium/WebGPU miner uses both. Chromium selects a WebGPU adapter; this repository does not pretend to have safe nonce/work partitioning until it is verified.

For now, start one miner and confirm which GPU receives the workload. A second independent miner should only be added after the Unicred work distribution is verified.

## Security

Use a dedicated wallet for an unattended cloud miner. Keep the private key in the VPS environment or a protected local file. Never commit it to GitHub.