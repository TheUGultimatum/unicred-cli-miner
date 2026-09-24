# Unicred CLI Miner

Single-GPU Ubuntu/Vast runner for the Unicred.fun browser proof-of-work miner.

## Goal

This repository intentionally runs **one GPU miner per instance**.

It:
- detects the NVIDIA GPU
- installs the required Linux, Vulkan and Chromium dependencies automatically
- installs Node.js 20+
- installs Playwright Chromium
- launches Chromium with hardware-GPU/high-performance WebGPU flags
- refuses software rendering such as SwiftShader/llvmpipe
- selects the Unicred GPU mining mode
- prints live hashrate and GPU telemetry
- supports optional local wallet signing/submission after the dry run passes

## Vast.ai

Use a native Linux NVIDIA GPU instance. A CUDA base image is fine.

Connect through Vast's SSH or terminal/Jupyter interface. Tunnels are not required.

For a single RTX 5090 instance:

```bash
git clone https://github.com/TheUGultimatum/unicred-cli-miner.git
cd unicred-cli-miner
chmod +x install.sh
./install.sh
```

The installer handles Node.js, Playwright Chromium, Vulkan/Chromium runtime libraries, Xvfb and NVIDIA checks.

## Mandatory first step: dry run

Run:

```bash
node miner.js --dry-run
```

The dry run uses a temporary wallet and does not sign or submit transactions.

It should report an NVIDIA WebGPU adapter and then start Unicred GPU mining.

The miner exits if it detects CPU-only mining or software rendering.

## Live stats

The CLI reports:
- page-reported Unicred hashrate
- WebGPU adapter
- GPU utilization
- GPU temperature
- power draw
- VRAM usage
- driver version
- Unicred status/difficulty/race text
- uptime

The objective is maximum valid Unicred PoW throughput. A fixed 95-99% `nvidia-smi` utilization cannot be guaranteed because browser workload, WebGPU dispatch, driver scheduling and the live race determine actual utilization.

## Real mining and automatic minting

Only after a successful dry run:

```bash
export UNICRED_PRIVATE_KEY='0xYOUR_PRIVATE_KEY'
node miner.js --submit --usage 100
```

The private key is used locally. The miner can:
- check the wallet balance
- estimate the transaction's mint value + gas cost
- sign locally
- submit the transaction
- wait for confirmation
- handle EIP-712 signing if the site requests it

It does **not** send the private key to Unicred or store it in the repository.

Never put the private key in GitHub, chat, screenshots, shell scripts or Docker images.

Use a dedicated wallet for unattended cloud mining.

## Stopping

```text
Ctrl+C
```

