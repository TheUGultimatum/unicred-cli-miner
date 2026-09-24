# Unicred CLI Miner

Single-GPU Ubuntu/Vast runner for the Unicred.fun browser proof-of-work miner.

> **Current project status: Single-GPU stable**
>
> The stable implementation intentionally uses **one GPU per miner instance**.
> Multi-GPU support is being developed separately and is not part of the stable path yet.

---

## What this project does

This project runs the Unicred browser miner from a Linux VPS instead of keeping a normal browser session open manually.

The miner:

- detects the NVIDIA GPU through `nvidia-smi`
- verifies that WebGPU is available
- requests a **high-performance NVIDIA WebGPU adapter**
- refuses software rendering such as SwiftShader/llvmpipe by default
- launches Chromium with GPU/WebGPU/Vulkan-oriented flags
- starts Unicred in **GPU mining mode**
- controls the mining usage slider
- prints live hashrate and GPU telemetry
- supports a safe **dry-run** mode
- can optionally connect a local wallet
- can locally sign and submit transactions when a valid mint transaction is requested
- checks the Unichain balance and estimated mint + gas cost before sending
- supports normal wallet signatures and EIP-712 typed-data signing

This repository is designed for rented NVIDIA GPU instances such as Vast.ai.

---

# Stable architecture

## Single GPU by design

The stable miner launches **one Chromium/WebGPU mining context**.

Even if the VPS contains multiple NVIDIA GPUs, the current stable miner does **not** turn them into independent workers.

Example:

```text
VPS
├── GPU 0  → active WebGPU miner
├── GPU 1  → not assigned to a second worker
├── GPU 2  → not assigned to a second worker
└── GPU 3  → not assigned to a second worker
```

The program may detect multiple GPUs with `nvidia-smi`, but stable mode still operates as a single-GPU miner.

This is intentional.

It keeps the known-good mining path isolated while multi-GPU work is developed separately.

---

# Reference performance

A known-good RTX 5090 Vast environment has produced roughly:

```text
Hashrate:        ~3.4–3.5 GH/s
GPU utilization: ~80–84%
Power:           ~480–491 W
Temperature:     ~71–72°C
VRAM usage:      ~112 MiB
```

These numbers are **reference observations, not guarantees**.

Actual performance depends on:

- GPU model
- NVIDIA driver
- WebGPU/Vulkan stack
- Chromium runtime
- VPS host configuration
- GPU scheduling
- current Unicred workload
- browser/client changes

Do not judge the miner from VRAM usage alone. WebGPU mining can use relatively little VRAM while still keeping the GPU busy.

---

# Requirements

## Recommended environment

- Ubuntu/Debian Linux
- NVIDIA GPU with a working Linux driver
- NVIDIA `nvidia-smi`
- Node.js 20+
- Internet access
- Enough Unichain ETH for a mint transaction if using `--submit``
- A dedicated wallet for unattended mining

A native Linux NVIDIA instance is preferred.

A CUDA-based Vast.ai image is fine as long as the NVIDIA driver is working.

---

# Quick start

## 1. Clone the repository

```bash
cd /workspace

git clone https://github.com/TheUGultimatum/unicred-cli-miner.git

cd /workspace/unicred-cli-miner
```

For the protected stable branch:

```bash
git fetch origin

git checkout single-gpu-stable

git reset --hard origin/single-gpu-stable
```

---

## 2. Run the installer

```bash
chmod +x install.sh

./install.sh
```

The installer prepares the Linux environment and checks the GPU stack.

It installs/checks:

- system packages required by Chromium
- Vulkan libraries and tools
- NVIDIA utilities
- Node.js 20+
- project npm dependencies
- Playwright Chromium
- X11/Xvfb-related runtime requirements
- Google Chrome Stable on amd64 systems
- NVIDIA/Vulkan diagnostics

The miner itself launches the Playwright Chromium executable.

---

# Mandatory safety test: dry run

Before using a real wallet, run:

```bash
node miner.js --dry-run
```

The dry run is the first validation step.

It should show:

```text
Detected NVIDIA GPUs: 1
WebGPU: {"available":true,...}
Mining started.
```

The WebGPU adapter should identify NVIDIA hardware.

The miner will stop instead of continuing when it detects that WebGPU is unavailable or appears to be using software rendering.

---

# Monitor the GPU

Open another SSH/terminal session and run:

```bash
watch -n 1 'nvidia-smi --query-gpu=name,utilization.gpu,temperature.gpu,power.draw,memory.used,memory.total,clocks.current.sm --format=csv'
```

Useful fields:

```text
GPU name
GPU utilization
Temperature
Power draw
VRAM used
VRAM total
SM clock
```

For a healthy RTX 5090 mining session, you should normally see meaningful GPU utilization and power draw rather than only a few percent of usage.

The miner also prints its own warning when a single RTX 5090 remains at unusually low load after startup.

---

# Real mining

After the dry run works, start the normal miner:

```bash
node miner.js
```

This mode finds solutions but does not enable automatic transaction submission.

---

# Automatic signing + submission

To enable wallet-backed submission:

```bash
read -rsp "Enter private key: " UNICRED_PRIVATE_KEY
echo

export UNICRED_PRIVATE_KEY
```

Check the derived address:

```bash
node -e "const {Wallet}=require('ethers'); console.log(new Wallet(process.env.UNICRED_PRIVATE_KEY).address)"
```

The accepted format is:

```text
0x + 64 hexadecimal characters
```

Then check the Unichain balance:

```bash
node -e "const {ethers}=require('ethers'); (async()=>{const p=new ethers.JsonRpcProvider('https://mainnet.unichain.org'); const a=new ethers.Wallet(process.env.UNICRED_PRIVATE_KEY).address; console.log('Address:',a); console.log('Unichain ETH:',ethers.formatEther(await p.getBalance(a)));})()"
```

Start automatic submission:

```bash
node miner.js --submit --usage 100
```

---

# How auto-submit works

The private key is kept on the VPS process and is not uploaded to GitHub.

When `--submit`` is enabled, the miner can:

1. expose a local Ethereum provider interface to the Unicred page
2. answer wallet/RPC requests through the local signer
3. sign normal messages when requested
4. sign EIP-712 typed data when requested
5. receive a transaction request from the page
6. check the Unichain wallet balance
7. estimate gas when necessary
8. verify that mint value + gas are affordable
9. sign/send the transaction
10. wait for confirmation

The signer is attached directly to the Unichain RPC:

```text
https://mainnet.unichain.org
```

Expected chain ID:

```text
130
```

---

# Important: winning is not guaranteed

This miner participates in a live proof-of-work race.

Running the miner does **not** guarantee an NFT.

A successful automatic mint depends on the live Unicred race and whether this miner produces the winning valid solution in time.

Therefore:

```text
High hashrate ≠ guaranteed mint
```

The purpose of the CLI is to maximize valid PoW throughput while keeping wallet signing and submission local.

---

# CLI options

## Dry run

```bash
node miner.js --dry-run
```

Disables transaction signing/submission.

---

## Find only

```bash
node miner.js
```

Runs the miner without automatic transaction submission.

---

## Auto-submit

```bash
node miner.js --submit
```

Enables local signing and transaction submission.

---

## Mining usage

Use:

```bash
node miner.js --submit --usage 100
```

The value is clamped between:

```text
1–100
```

100 is the normal full-usage setting.

---

## Custom stats interval

Default:

```text
5000 ms
```

Example:

```bash
node miner.js --stats-interval 2000
```

This changes the CLI reporting interval to 2 seconds.

It does not directly control the underlying WebGPU hash loop.

---

## Headless mode

The normal stable path uses X11/Xvfb.

For headless Chromium:

```bash
node miner.js --headless
```

Use this only when the environment has been verified to keep WebGPU working correctly.

---

# Environment variables

The miner supports the following environment variables.

```text
UNICRED_PRIVATE_KEY
UNICRED_RPC_URL
UNICRED_DRY_RUN
UNICRED_AUTO_SUBMIT
UNICRED_USAGE
UNICRED_STATS_INTERVAL
UNICRED_XVFB
UNICRED_ALLOW_SOFTWARE
UNICRED_CPU_MODE
```

Defaults:

```text
UNICRED_RPC_URL=https://mainnet.unichain.org
UNICRED_USAGE=100
UNICRED_STATS_INTERVAL=5000
```

Dry run:

```bash
export UNICRED_DRY_RUN=1
```

Auto-submit:

```bash
export UNICRED_AUTO_SUBMIT=1
```

Custom RPC:

```bash
export UNICRED_RPC_URL="https://mainnet.unichain.org"
```

Custom usage:

```bash
export UNICRED_USAGE=100
```

Custom stats interval:

```bash
export UNICRED_STATS_INTERVAL=5000
```

Disable the built-in Xvfb startup when a valid display already exists:

```bash
export UNICRED_XVFB=0
```

---

# GPU safety behavior

The stable miner is intentionally strict.

By default it:

- requires a working WebGPU adapter
- requests the high-performance adapter
- checks for NVIDIA hardware
- rejects obvious software adapters
- forces Unicred GPU mode
- stops if Unicred reports that CPU mining started
- warns when GPU load becomes abnormally low

The code uses Chromium flags intended to keep the browser on the hardware graphics path, including:

```text
--enable-gpu
--ignore-gpu-blocklist
--disable-software-rasterizer
--force_high_performance_gpu
--use-webgpu-power-preference=high-performance
--enable-unsafe-webgpu
--enable-features=Vulkan,UseOzonePlatform
--use-angle=vulkan
```

---

# Security

## Never commit your private key

Do not put a real private key inside:

```text
README.md
miner.js
install.sh
package.json
.env files committed to Git
Docker images
GitHub issues
GitHub discussions
screenshots
public logs
```

Use a dedicated wallet for cloud mining.

Recommended workflow:

```bash
read -rsp "Enter private key: " UNICRED_PRIVATE_KEY
echo

export UNICRED_PRIVATE_KEY
```

This keeps the key out of the command history in normal shells.

If a private key is ever exposed publicly, move the funds/NFTs to another wallet and stop using the exposed key.

---

# Troubleshooting

## 1. `nvidia-smi` does not work

Run:

```bash
nvidia-smi
```

Then:

```bash
nvidia-smi -L
```

If these fail, fix the NVIDIA driver/runtime before debugging the miner.

---

## 2. WebGPU adapter is unavailable

Run:

```bash
vulkaninfo --summary
```

Then:

```bash
nvidia-smi
```

Also check that the miner is running inside the repository:

```bash
cd /workspace/unicred-cli-miner
```

Then retry:

```bash
node miner.js --dry-run
```

---

## 3. WebGPU detects software rendering

The stable miner normally refuses this.

Look for indicators such as:

```text
SwiftShader
llvmpipe
software
```

Do not bypass the GPU check just to make the process run.

Fix the NVIDIA/Vulkan/Chromium stack instead.

---

## 4. Hashrate is much lower than expected

Check the actual GPU:

```bash
nvidia-smi
```

Then look for:

```text
low utilization
low power draw
low clocks
CPU mining
software WebGPU
```

A healthy mining session should not look like:

```text
GPU utilization: 4%
Power:            ~20 W
```

When the workload is configured correctly, an RTX 5090 can operate at substantially higher GPU utilization and power.

---

## 5. Unicred starts CPU mining

The miner intentionally stops instead of silently wasting a rented GPU.

Check:

```bash
node miner.js --dry-run
```

and confirm the UI reports GPU mode.

---

## 6. `Cannot find module 'ethers'`

Run commands from the repository directory:

```bash
cd /workspace/unicred-cli-miner
```

Then verify:

```bash
node -e "console.log(require('ethers').version)"
```

---

## 7. Private key format error

A raw EVM private key must look like:

```text
0x....................................................
```

It must contain exactly:

```text
0x + 64 hex characters
```

Do not enter a seed phrase where a raw private key is expected.

---

## 8. Insufficient Unichain ETH

Check:

```bash
node -e "const {ethers}=require('ethers'); (async()=>{const p=new ethers.JsonRpcProvider('https://mainnet.unichain.org'); const a=new ethers.Wallet(process.env.UNICRED_PRIVATE_KEY).address; console.log(ethers.formatEther(await p.getBalance(a)),'ETH');})()"
```

The submission code checks affordability before sending the transaction.

---

# Why single-GPU first?

The stable miner is intentionally kept simple.

A true multi-GPU implementation is not just:

```text
launch 4 browsers
```

A correct multi-GPU implementation needs:

```text
GPU affinity
+
independent workers
+
work/nonce partitioning
+
shared race coordination
+
stale-work cancellation
+
winner propagation
+
single winning submission path
```

Without that coordination, several workers can simply perform duplicated work instead of multiplying useful throughput.

That is why the stable branch remains single-GPU.

---

# Multi-GPU development

The repository also contains a separate development branch:

```text
multi-gpu-dev
```

The development branch is based on the stable single-GPU code so experiments can happen without changing the protected stable branch.

The intended development target is:

```text
2 GPUs
→ prove real scaling
→ verify independent GPU affinity
→ verify nonces/work are not duplicated
→ coordinate workers
→ handle winner/stale-work events
→ test 4 GPUs
```

A theoretical four-RTX-5090 setup could approach the sum of four independent workers if the workload scales linearly, but that is **not implemented or guaranteed yet**.

---

# Branch structure

Stable:

```text
main
single-gpu-stable
```

Development:

```text
multi-gpu-dev
```

The rule for development is simple:

```text
stable mining changes → single-gpu-stable
multi-GPU experiments  → multi-gpu-dev
```

Do not experiment on the stable mining branch.

---

# Safe rollback

To return to the protected stable branch:

```bash
cd /workspace/unicred-cli-miner

git fetch origin

git checkout single-gpu-stable

git reset --hard origin/single-gpu-stable
```

To verify the current branch:

```bash
git branch --show-current
```

Expected:

```text
single-gpu-stable
```

---

# Fresh VPS setup

For a completely new Ubuntu/Debian NVIDIA GPU instance:

```bash
cd /workspace

git clone https://github.com/TheUGultimatum/unicred-cli-miner.git

cd /workspace/unicred-cli-miner

git fetch origin

git checkout single-gpu-stable

git reset --hard origin/single-gpu-stable

chmod +x install.sh

./install.sh

node --check miner.js

node miner.js --dry-run
```

Then in another terminal:

```bash
watch -n 1 'nvidia-smi --query-gpu=name,utilization.gpu,temperature.gpu,power.draw,memory.used,memory.total,clocks.current.sm --format=csv'
```

After the dry run is confirmed:

```bash
read -rsp "Enter private key: " UNICRED_PRIVATE_KEY
echo

export UNICRED_PRIVATE_KEY

node -e "const {Wallet}=require('ethers'); console.log(new Wallet(process.env.UNICRED_PRIVATE_KEY).address)"

node miner.js --submit --usage 100
```

---

# Current stable scope

This version is focused on:

```text
Ubuntu
NVIDIA GPU
WebGPU
Chromium
Unicred GPU mode
Single GPU
Local wallet signing
Optional transaction submission
Live mining telemetry
```

It is **not** currently a true multi-GPU miner.

---

# Development roadmap

### Stable

- [x] NVIDIA GPU detection
- [x] WebGPU validation
- [x] Hardware-only GPU path
- [x] Unicred GPU mode selection
- [x] Live hashrate reporting
- [x] GPU telemetry
- [x] Dry-run mode
- [x] Local wallet integration
- [x] Unichain RPC
- [x] Local transaction signing
- [x] EIP-712 signing
- [x] Automatic transaction submission
- [x] Single-GPU stable branch

### Multi-GPU

- [ ] Per-GPU browser workers
- [ ] Verified GPU affinity
- [ ] Work/nonce partitioning
- [ ] Worker coordinator
- [ ] Winner/stale-work propagation
- [ ] Aggregate hashrate reporting
- [ ] 2-GPU validation
- [ ] 4-GPU validation
- [ ] Production multi-GPU branch

---

# Project principle

The priority is:

```text
REAL GPU WORK
      ↓
VALID POW THROUGHPUT
      ↓
SAFE LOCAL SIGNING
      ↓
RELIABLE SUBMISSION
```

Not:

```text
fake GPU utilization
duplicated workers
software rendering
or theoretical hashrate
```

The miner should only claim performance that the actual GPU and Unicred workload are producing.
