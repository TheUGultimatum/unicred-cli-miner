# Unicred CLI Miner — Multi-GPU Development

This branch is the experimental **multi-GPU development branch**.

The stable single-GPU implementation is maintained separately on:

```text
single-gpu-stable
```

Full multi-GPU development documentation:

[README-MULTI-GPU.md](./README-MULTI-GPU.md)

## Status

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

## First commands

```bash
cd /workspace/unicred-cli-miner

git fetch origin

git checkout multi-gpu-dev

git reset --hard origin/multi-gpu-dev

chmod +x setup-multi-gpu.sh

./setup-multi-gpu.sh

node --check gpu-affinity.js
node --check multi-gpu.js
node --check miner.js

node multi-gpu.js --map

node multi-gpu.js --probe
```

Do not start experimental multi-GPU mining until the requested GPUs pass the affinity probe.

For experimental testing only:

```bash
node multi-gpu.js --mine --gpus 0,1 --allow-unpartitioned
```

The `--allow-unpartitioned` flag exists because the live Unicred work-generation strategy has not yet been fully verified for deterministic multi-worker partitioning.
