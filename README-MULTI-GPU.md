# Unicred CLI Miner — Multi-GPU Development

Experimental multi-GPU development branch for the Unicred.fun browser proof-of-work miner.

> **Warning:** this branch is experimental.
>
> The stable single-GPU miner is kept separately on `single-gpu-stable`.
> Do not use this branch as the production/stable miner until multi-GPU affinity and work partitioning are fully verified.

---

## Development goal

Turn one Linux/Vast.ai instance with multiple NVIDIA GPUs into coordinated Unicred browser miners.

Target architecture:

```text
                 MULTI-GPU COORDINATOR
                         │
          ┌──────────────┼──────────────┐
          │              │              │
       Worker 0       Worker 1       Worker 2 ...
          │              │              │
      Chromium        Chromium        Chromium
      WebGPU          WebGPU          WebGPU
          │              │              │
        GPU 0           GPU 1           GPU 2 ...
```

The current code has two separate development problems:

1. **GPU affinity** — make each Chromium/WebGPU worker use a specific physical GPU.
2. **Work partitioning** — prevent multiple workers from doing duplicate search work.

GPU affinity is the first thing being implemented and tested.

Work partitioning is intentionally **not marked production-ready yet**.

---

# Stable branch safety

The known-good single-GPU implementation is protected in:

```text
single-gpu-stable
```

Multi-GPU changes happen only here:

```text
multi-gpu-dev
```

Rollback:

```bash
git fetch origin
git checkout single-gpu-stable
git reset --hard origin/single-gpu-stable
```

---

# Current multi-GPU architecture

## GPU discovery

The development code maps:

```text
nvidia-smi GPU index
        ↓
PCI bus address
        ↓
Vulkan physical device
        ↓
Vulkan device index
        ↓
vkdevicechooser
        ↓
Chromium/WebGPU worker
```

This avoids assuming that the NVIDIA index and Vulkan index are identical.

The mapping is based on PCI bus information.

---

# Vulkan device selection

Linux Vulkan applications can expose multiple physical devices and an application may otherwise choose the wrong one.

This branch uses `vkdevicechooser` to force a worker to a specific Vulkan physical device.

The launcher uses:

```text
ENABLE_DEVICE_CHOOSER_LAYER=1
VULKAN_DEVICE_INDEX=<vulkan-index>
```

The device chooser approach is commonly used to force a Vulkan application to a selected GPU on multi-GPU Linux systems. citeturn485817search1turn840259search0

---

# Install the multi-GPU development stack

Start from a fresh VPS or from a machine where the stable installer has already completed.

```bash
cd /workspace/unicred-cli-miner

git fetch origin

git checkout multi-gpu-dev

git reset --hard origin/multi-gpu-dev
```

Then:

```bash
chmod +x setup-multi-gpu.sh

./setup-multi-gpu.sh
```

The setup script installs the build dependencies and builds `vkdevicechooser`.

---

# 1. Inspect the physical GPU map

Run:

```bash
node multi-gpu.js --map
```

or:

```bash
npm run gpu-map
```

Expected style:

```text
[GPU 0] NVIDIA GeForce RTX 5090 | PCI 00000000:17:00.0 | Vulkan index 0
[GPU 1] NVIDIA GeForce RTX 5090 | PCI 00000000:18:00.0 | Vulkan index 1
[GPU 2] NVIDIA GeForce RTX 5090 | PCI 00000000:19:00.0 | Vulkan index 2
[GPU 3] NVIDIA GeForce RTX 5090 | PCI 00000000:1A:00.0 | Vulkan index 3
```

The exact indexes depend on the VPS.

---

# 2. Probe GPU affinity before mining

Do **not** start multi-GPU mining first.

Run:

```bash
node multi-gpu.js --probe
```

For two GPUs:

```bash
node multi-gpu.js --probe --gpus 0,1
```

For four GPUs:

```bash
node multi-gpu.js --probe --gpus 0,1,2,3
```

The probe launches a Chromium/WebGPU instance for each requested GPU and verifies that the requested Vulkan selection reaches the WebGPU startup path.

A probe that fails is a hard stop.

---

# Per-GPU direct probe

A single worker can also be tested directly:

```bash
node miner.js --gpu-index 0 --probe-only
```

Another GPU:

```bash
node miner.js --gpu-index 1 --probe-only
```

This is useful when debugging one GPU without launching the whole coordinator.

---

# Kernel inspection

The development miner contains an optional WebGPU instrumentation mode.

Use:

```bash
node miner.js --gpu-index 0 --dry-run --inspect-kernel
```

or:

```bash
node multi-gpu.js --gpus 0,1 --mine --allow-unpartitioned --inspect-kernel
```

The debug output is written to:

```text
.multi-gpu-logs/
```

The instrumentation captures useful information such as:

- WebGPU shader module source
- queue submission count
- `crypto.getRandomValues()` activity
- small random-value samples

The purpose is to inspect the actual Unicred client mining kernel before implementing deterministic work partitioning.

---

# Experimental multi-GPU mining

The development coordinator can launch one worker per selected GPU.

Example for two GPUs:

```bash
node multi-gpu.js --mine --gpus 0,1 --allow-unpartitioned
```

Four GPUs:

```bash
node multi-gpu.js --mine --gpus 0,1,2,3 --allow-unpartitioned
```

Full usage:

```bash
node multi-gpu.js --mine --usage 100 --gpus 0,1 --allow-unpartitioned
```

---

# Why `--allow-unpartitioned` exists

A naive multi-GPU miner can launch four browsers and still perform overlapping work.

That would create:

```text
4 browsers
4 GPUs
but potentially duplicated search
```

rather than:

```text
4 independent search workers
```

The current coordinator therefore blocks multi-GPU mining unless you explicitly use:

```text
--allow-unpartitioned
```

This flag means:

> I understand that work partitioning has not yet been verified and I am running this only for development/testing.

Do not treat aggregate hashrate from this mode as final production performance.

---

# Current worker behavior

Each worker receives:

```text
GPU index
Worker ID
Vulkan device index
Usage
RPC configuration
Wallet configuration
```

Workers are separate Node.js + Chromium processes.

Each worker has its own Xvfb display when non-headless mode is used:

```text
GPU 0 → DISPLAY=:99
GPU 1 → DISPLAY=:100
GPU 2 → DISPLAY=:101
GPU 3 → DISPLAY=:102
```

---

# Aggregate hashrate

The coordinator reads worker hashrate lines and calculates an aggregate total.

Example:

```text
GPU 0 → 3.50 GH/s
GPU 1 → 3.45 GH/s
GPU 2 → 3.42 GH/s
GPU 3 → 3.48 GH/s

Aggregate → 13.85 GH/s
```

This is a measurement, not a guarantee.

The final production architecture must verify that the work being counted is actually independent useful work.

---

# Automatic submission behavior

The normal signer logic is inherited from the single-GPU miner.

A worker can use:

```bash
--submit
```

with:

```text
UNICRED_PRIVATE_KEY
UNICRED_RPC_URL
```

When one worker reports a submitted transaction, the coordinator attempts to stop the remaining workers.

This is currently a development coordination mechanism.

It is **not yet the final winner-handling architecture**.

---

# GPU telemetry

Use another terminal:

```bash
watch -n 1 'nvidia-smi --query-gpu=name,utilization.gpu,temperature.gpu,power.draw,memory.used,memory.total,clocks.current.sm --format=csv'
```

For a true multi-GPU run, the selected GPUs should show meaningful workload.

Example target pattern:

```text
GPU0  ~80%+ utilization
GPU1  ~80%+ utilization
GPU2  ~80%+ utilization
GPU3  ~80%+ utilization
```

Exact utilization is workload- and driver-dependent.

---

# Useful commands

## Show mapping

```bash
node multi-gpu.js --map
```

## Probe every GPU

```bash
node multi-gpu.js --probe
```

## Probe selected GPUs

```bash
node multi-gpu.js --probe --gpus 0,1
```

## Probe one GPU directly

```bash
node miner.js --gpu-index 1 --probe-only
```

## Check syntax

```bash
node --check gpu-affinity.js
node --check multi-gpu.js
node --check miner.js
```

## Development mining

```bash
node multi-gpu.js --mine --gpus 0,1 --allow-unpartitioned
```

---

# Development roadmap

## Phase 1 — GPU affinity

- [x] Detect all NVIDIA GPUs
- [x] Read PCI bus identifiers
- [x] Read Vulkan physical devices
- [x] Map NVIDIA GPU → Vulkan device
- [x] Add vkdevicechooser setup
- [x] Launch a worker with a requested GPU index
- [x] Add safe GPU probes
- [ ] Validate affinity on a real multi-RTX 5090 VPS

## Phase 2 — Multi-worker control

- [x] Coordinator process
- [x] One worker process per GPU
- [x] Per-worker logs
- [x] Aggregate hashrate
- [x] Ctrl+C shutdown propagation
- [x] Stop remaining workers after a submission event

## Phase 3 — Work partitioning

- [ ] Inspect the live Unicred WGSL mining shader
- [ ] Identify nonce/work generation
- [ ] Identify batch boundaries
- [ ] Identify random/sequential search strategy
- [ ] Define deterministic worker ranges or independent work seeds
- [ ] Verify zero intentional overlap
- [ ] Reset all workers when the live race changes
- [ ] Re-test aggregate throughput

## Phase 4 — Production multi-GPU

- [ ] Remove `--allow-unpartitioned` requirement
- [ ] Make worker scheduling race-aware
- [ ] Verified stale-work cancellation
- [ ] Verified winner propagation
- [ ] Verified single submission authority
- [ ] 2-GPU benchmark
- [ ] 4-GPU benchmark
- [ ] Production release branch

---

# Important technical note

Chrome's WebGPU path is not itself a generic multi-adapter mining framework. Current Chromium documentation notes platform limitations around simultaneous GPU adapters, so this project deliberately uses **separate browser processes** instead of trying to make one page request multiple adapters. citeturn640143search1

For Linux Vulkan, physical-device selection can be controlled externally before Chromium starts. That is why this branch uses a Vulkan device-selection layer rather than relying only on WebGPU's `powerPreference` option. citeturn840259search0turn840259search5

---

# Current status

```text
GPU discovery             ✅
NVIDIA → Vulkan mapping   ✅
Vulkan device chooser     ✅
Per-GPU worker launcher   ✅
Aggregate stats           ✅
Kernel inspection         ✅
Work partitioning         ❌ NOT VERIFIED
Production multi-GPU      ❌ NOT READY
```

The next engineering task is to inspect the captured Unicred WebGPU shader and determine exactly how the client generates its search numbers.

Once that is known, the workers can be given deterministic independent work rather than simply running duplicate browser instances.
