#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
  getGpuMap,
  resolveGpuSelection,
  selectedVulkanDevices
} = require('./gpu-affinity');

const has = x => process.argv.includes(x);
const arg = (x, d = null) => {
  const i = process.argv.indexOf(x);
  return i >= 0 ? (process.argv[i + 1] ?? d) : d;
};

const MODE = has('--mine') ? 'mine' : has('--probe') ? 'probe' : 'map';
const REQUESTED = arg('--gpus', null);
const USAGE = Math.max(1, Math.min(100, Number(arg('--usage', process.env.UNICRED_USAGE || '100'))));
const STATS_MS = Math.max(1000, Number(arg('--stats-interval', process.env.UNICRED_STATS_INTERVAL || '5000')));
const ALLOW_UNPARTITIONED = has('--allow-unpartitioned');
const HEADLESS = has('--headless');
const DRY_RUN = has('--dry-run') || process.env.UNICRED_DRY_RUN === '1';
const AUTO_SUBMIT = has('--submit') || process.env.UNICRED_AUTO_SUBMIT === '1';
const INSPECT_KERNEL = has('--inspect-kernel');
const PARTITIONED = has('--partitioned');

function die(message) {
  console.error('\nERROR:', message);
  process.exit(1);
}

function chooseGpuIndices() {
  const map = getGpuMap();
  if (!map.length) die('No NVIDIA GPUs found with nvidia-smi.');

  if (!REQUESTED) return map.map(g => g.index);

  const indices = REQUESTED.split(',')
    .map(s => Number(s.trim()))
    .filter(Number.isInteger);

  if (!indices.length) die('Invalid --gpus value. Example: --gpus 0,1,2,3');

  for (const index of indices) {
    if (!map.some(g => g.index === index)) {
      die('Requested NVIDIA GPU ' + index + ' was not found.');
    }
  }

  return [...new Set(indices)];
}

function printMap() {
  const map = getGpuMap();
  console.log('====================================================');
  console.log('        UNICRED MULTI-GPU AFFINITY MAP');
  console.log('====================================================');

  if (!map.length) die('No NVIDIA GPUs detected.');

  for (const gpu of map) {
    console.log(
      '[GPU ' + gpu.index + '] ' +
      gpu.name +
      ' | PCI ' + gpu.busId +
      ' | Vulkan index ' + (gpu.vulkanIndex == null ? 'UNMAPPED' : gpu.vulkanIndex) +
      ' | Vulkan name ' + (gpu.vulkanName || 'n/a')
    );
  }

  const unresolved = map.filter(g => g.vulkanIndex == null);
  if (unresolved.length) {
    console.log('\n[WARN] One or more GPUs could not be mapped to Vulkan by PCI bus.');
    console.log('[WARN] Multi-GPU workers should not start until the mapping is resolved.');
    process.exitCode = 2;
  }
}

function parseHashrate(value) {
  const m = String(value || '').match(/([0-9.]+)\s*(GH\/s|MH\/s|KH\/s|H\/s)/i);
  if (!m) return 0;
  const n = Number(m[1]);
  const u = m[2].toUpperCase();
  if (u === 'GH/S') return n * 1e9;
  if (u === 'MH/S') return n * 1e6;
  if (u === 'KH/S') return n * 1e3;
  return n;
}

function formatRate(h) {
  if (h >= 1e9) return (h / 1e9).toFixed(2) + ' GH/s';
  if (h >= 1e6) return (h / 1e6).toFixed(2) + ' MH/s';
  if (h >= 1e3) return (h / 1e3).toFixed(2) + ' KH/s';
  return Math.round(h) + ' H/s';
}

async function probeGpu(gpuIndex) {
  const selection = resolveGpuSelection(gpuIndex);
  const env = {
    ...process.env,
    ...selection.env,
    UNICRED_MULTI_GPU: '1',
    UNICRED_GPU_INDEX: String(gpuIndex),
    UNICRED_WORKER_ID: 'probe-' + gpuIndex
  };

  const args = [
    'miner.js',
    '--gpu-index', String(gpuIndex),
    '--worker-id', 'probe-' + gpuIndex,
    '--probe-only'
  ];

  if (HEADLESS) args.push('--headless');

  console.log(
    '\n[PROBE] GPU ' + gpuIndex +
    ' → Vulkan ' + selection.vulkanIndex +
    ' → ' + selection.name
  );

  const p = spawn(process.execPath, args, {
    cwd: __dirname,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  p.stdout.on('data', data => process.stdout.write('[GPU' + gpuIndex + '] ' + data));
  p.stderr.on('data', data => process.stderr.write('[GPU' + gpuIndex + '][ERR] ' + data));

  await new Promise(resolve => p.on('exit', () => resolve()));
  if (p.exitCode !== 0) {
    throw new Error('Probe failed for GPU ' + gpuIndex + ' with exit code ' + p.exitCode);
  }
}

function launchWorker(gpuIndex, workerPosition, workerCount) {
  const selection = resolveGpuSelection(gpuIndex);
  const workerId = 'gpu-' + gpuIndex;

  const env = {
    ...process.env,
    ...selection.env,
    UNICRED_MULTI_GPU: '1',
    UNICRED_GPU_INDEX: String(gpuIndex),
    UNICRED_WORKER_ID: workerId,
    UNICRED_WORKER_INDEX: String(workerPosition),
    UNICRED_WORKER_COUNT: String(workerCount),
    UNICRED_PARTITIONED: PARTITIONED ? '1' : '0',
    UNICRED_STATS_INTERVAL: String(STATS_MS)
  };

  const args = [
    'miner.js',
    '--gpu-index', String(gpuIndex),
    '--worker-id', workerId,
    '--usage', String(USAGE)
  ];

  if (HEADLESS) args.push('--headless');
  if (DRY_RUN) args.push('--dry-run');
  if (AUTO_SUBMIT) args.push('--submit');
  if (INSPECT_KERNEL) args.push('--inspect-kernel');
  if (PARTITIONED) args.push('--partitioned', '--worker-index', String(workerPosition), '--worker-count', String(workerCount));

  const logDir = path.resolve(process.env.UNICRED_MULTI_GPU_LOG_DIR || '.multi-gpu-logs');
  fs.mkdirSync(logDir, { recursive: true });

  const logPath = path.join(logDir, workerId + '.log');
  const stream = fs.createWriteStream(logPath, { flags: 'a' });

  console.log(
    '[START] ' + workerId +
    ' | ' + selection.name +
    ' | Vulkan=' + selection.vulkanIndex +
    ' | log=' + logPath
  );

  const child = spawn(process.execPath, args, {
    cwd: __dirname,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const state = {
    gpuIndex,
    workerId,
    child,
    rate: 0,
    online: true
  };

  function handle(data, isErr) {
    const text = data.toString();
    stream.write(text);

    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      process.stdout.write('[' + workerId + '] ' + line + '\n');

      const match = line.match(/\[STATS\]\s+hashrate\s+(.+)/i);
      if (match) state.rate = parseHashrate(match[1]);

      const partitionMatch = line.match(/\[PARTITION\]\s+Params ctrBase=(\d+)/i);
      if (partitionMatch) {
        const ctrBase = Number(partitionMatch[1]);
        state.firstCtrBase = state.firstCtrBase ?? ctrBase;
        state.lastCtrBase = ctrBase;
        if (workers.every(w => Number.isFinite(w.lastCtrBase))) {
          const bases = workers.map(w => w.lastCtrBase);
          if (new Set(bases).size !== 1) {
            console.log('\n[COORDINATOR] Different ctrBase values detected across workers. Stopping instead of assuming independent work. bases=' + bases.join(','));
            stopAll(workers, 'ctrBase mismatch');
          }
        }
      }

      if (/TX SENT:/i.test(line)) {
        console.log('\n[COORDINATOR] A worker submitted a transaction.');
        stopAll(workers, 'winner detected');
      }
    }

    if (isErr) stream.write('[stderr]\n');
  }

  child.stdout.on('data', data => handle(data, false));
  child.stderr.on('data', data => handle(data, true));

  child.on('exit', (code, signal) => {
    state.online = false;
    stream.end();
    console.log(
      '\n[' + workerId + '] exited code=' + code +
      ' signal=' + (signal || 'none')
    );
  });

  return state;
}

function stopAll(workers, reason) {
  console.log('[COORDINATOR] Stopping all workers: ' + reason);
  for (const worker of workers) {
    if (!worker.online) continue;
    worker.child.kill('SIGINT');
  }
}

let workers = [];

async function main() {
  if (MODE === 'map') {
    printMap();
    console.log('\nRun the safe validation first:');
    console.log('  node multi-gpu.js --probe');
    console.log('\nThen experimental mining:');
    console.log('  node multi-gpu.js --mine --allow-unpartitioned');
    return;
  }

  const gpuIndices = chooseGpuIndices();
  printMap();

  for (const index of gpuIndices) {
    const selection = resolveGpuSelection(index);
    const selected = selectedVulkanDevices(selection.env);

    console.log(
      '[CHECK] GPU ' + index +
      ' mapped to Vulkan index ' + selection.vulkanIndex +
      ' | selected Vulkan devices: ' +
      (selected.length ? selected.map(d => d.name).join(', ') : 'unknown')
    );

    if (MODE !== 'map' && selected.length > 1) {
      die(
        'GPU ' + index +
        ' was not isolated by vkdevicechooser. ' +
        'Expected one selected Vulkan device, got ' + selected.length + '.'
      );
    }
  }

  if (MODE === 'probe') {
    for (const index of gpuIndices) {
      await probeGpu(index);
    }
    console.log('\n[PROBE] All requested GPU affinity probes completed.');
    return;
  }

  if (!ALLOW_UNPARTITIONED && !PARTITIONED) {
    die(
      'Multi-GPU mining is blocked until you select a work mode. ' +
      'Use --partitioned for deterministic counter partitioning, or ' +
      '--allow-unpartitioned for legacy duplicate-work testing.'
    );
  }

  console.log('\n====================================================');
  console.log('      EXPERIMENTAL MULTI-GPU MINING');
  console.log('====================================================');
  console.log('Workers:', gpuIndices.length);
  console.log('Usage:', USAGE + '%');
  console.log('Work partitioning: ' + (PARTITIONED ? 'DETERMINISTIC CTR STRIDE' : 'NOT VERIFIED'));
  console.log('This mode is for development only.');
  if (PARTITIONED) {
    console.log('Formula: ctr = ctrBase + gid.x * ' + gpuIndices.length + ' + workerIndex');
  }
  console.log('====================================================\n');

  if (AUTO_SUBMIT && !process.env.UNICRED_PRIVATE_KEY) {
    die('--submit requires UNICRED_PRIVATE_KEY in the coordinator environment.');
  }

  if (PARTITIONED && gpuIndices.length < 2) {
    die('Partitioned mode requires at least 2 GPUs.');
  }

  workers = gpuIndices.map((gpuIndex, workerPosition) =>
    launchWorker(gpuIndex, workerPosition, gpuIndices.length)
  );

  setInterval(() => {
    const total = workers.reduce((sum, worker) => sum + worker.rate, 0);
    const live = workers.filter(worker => worker.online).length;
    console.log(
      '\n[AGGREGATE] ' +
      formatRate(total) +
      ' | workers ' + live + '/' + workers.length
    );
  }, STATS_MS);

  process.on('SIGINT', () => {
    stopAll(workers, 'Ctrl+C');
    setTimeout(() => process.exit(0), 1500).unref();
  });

  await new Promise(() => {});
}

main().catch(error => die(error.stack || error.message || String(error)));
