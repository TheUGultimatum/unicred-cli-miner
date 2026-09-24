#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { chromium } = require('playwright');
const { resolveGpuSelection } = require('./gpu-affinity');

const SITE = 'https://unicred.fun/';
const RPC_URL = process.env.UNICRED_RPC_URL || 'https://mainnet.unichain.org';
const CHAIN_ID = 130;
const CHAIN_HEX = '0x82';

const has = (x) => process.argv.includes(x);
const arg = (x, d = null) => {
  const i = process.argv.indexOf(x);
  return i >= 0 ? (process.argv[i + 1] ?? d) : d;
};

const DRY_RUN = has('--dry-run') || process.env.UNICRED_DRY_RUN === '1';
const AUTO_SUBMIT = has('--submit') || process.env.UNICRED_AUTO_SUBMIT === '1';
const HEADLESS = has('--headless') ? true : false;
const STRICT_GPU = !has('--allow-software') && process.env.UNICRED_ALLOW_SOFTWARE !== '1';
const FORCE_GPU_MODE = !has('--cpu') && process.env.UNICRED_CPU_MODE !== '1';
const USAGE = Math.max(1, Math.min(100, Number(arg('--usage', process.env.UNICRED_USAGE || '100'))));
const STATS_MS = Math.max(1000, Number(arg('--stats-interval', process.env.UNICRED_STATS_INTERVAL || '5000')));
const USE_XVFB = process.env.UNICRED_XVFB !== '0';
const GPU_INDEX_RAW = arg('--gpu-index', process.env.UNICRED_GPU_INDEX);
const GPU_INDEX = GPU_INDEX_RAW == null ? null : Number(GPU_INDEX_RAW);
const WORKER_ID = arg('--worker-id', process.env.UNICRED_WORKER_ID || 'single');
const PROBE_ONLY = has('--probe-only') || process.env.UNICRED_PROBE_ONLY === '1';
const INSPECT_KERNEL = has('--inspect-kernel') || process.env.UNICRED_INSPECT_KERNEL === '1';
const PARTITIONED = has('--partitioned') || process.env.UNICRED_PARTITIONED === '1';
const WORKER_INDEX = Math.max(0, Number(arg('--worker-index', process.env.UNICRED_WORKER_INDEX || '0')));
const WORKER_COUNT = Math.max(1, Number(arg('--worker-count', process.env.UNICRED_WORKER_COUNT || '1')));

function die(message) {
  console.error('\nERROR:', message);
  process.exit(1);
}

function execOutput(command, args) {
  const r = spawnSync(command, args, { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

function gpuRows() {
  const out = execOutput('nvidia-smi', [
    '--query-gpu=index,name,driver_version,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw',
    '--format=csv,noheader,nounits'
  ]);
  if (!out) return [];
  return out.split('\n').map(line => {
    const p = line.split(',').map(s => s.trim());
    return {
      index: p[0], name: p[1], driver: p[2],
      memUsed: p[3], memTotal: p[4], util: p[5],
      temp: p[6], power: p[7]
    };
  });
}

function printGpuStats() {
  const rows = gpuRows();
  if (!rows.length) {
    console.log('[GPU] nvidia-smi unavailable');
    return rows;
  }
  for (const g of rows) {
    console.log(
      '[GPU' + g.index + '] ' + g.name +
      ' | util ' + g.util + '%' +
      ' | temp ' + g.temp + 'C' +
      ' | power ' + g.power + 'W' +
      ' | VRAM ' + g.memUsed + '/' + g.memTotal + ' MiB' +
      ' | driver ' + g.driver
    );
  }
  return rows;
}

function validatePrivateKey(pk) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) die('Invalid private key format.');
  return pk;
}

function startVirtualDisplay(display=':99') {
  if (process.env.DISPLAY || !USE_XVFB) return null;
  const xvfb = spawn('Xvfb', [display, '-screen', '0', '1440x900x24', '-nolisten', 'tcp'], {
    stdio: 'ignore',
    detached: false
  });
  process.env.DISPLAY = display;
  return xvfb;
}

async function assertAffordableMint(rpc, tx, wallet) {
  const balance = await rpc.getBalance(wallet.address);
  const value = BigInt(tx.value || 0);
  let gasLimit = tx.gasLimit ? BigInt(tx.gasLimit) : 0n;
  if (!gasLimit) gasLimit = await rpc.estimateGas({...tx, from: wallet.address});

  const fee = await rpc.getFeeData();
  const gasPrice = tx.gasPrice ? BigInt(tx.gasPrice) : (fee.maxFeePerGas || fee.gasPrice || 0n);
  const worstCase = value + gasLimit * gasPrice;

  console.log('[MINT] Balance:', ethers.formatEther(balance), 'ETH');
  console.log('[MINT] Value:', ethers.formatEther(value), 'ETH');
  console.log('[MINT] Gas limit:', gasLimit.toString());
  console.log('[MINT] Estimated max cost:', ethers.formatEther(worstCase), 'ETH');

  if (balance < worstCase) {
    throw new Error(
      'Insufficient Unichain ETH for mint + gas. Need about ' +
      ethers.formatEther(worstCase) + ' ETH, wallet has ' +
      ethers.formatEther(balance) + ' ETH.'
    );
  }
  return {balance, value, gasLimit, worstCase};
}

function providerScript() {
  return "(()=>{const listeners=new Map();const rpc=(m,p)=>window.__unicred_rpc(m,p||[]);window.ethereum={isMetaMask:true,isRabby:true,isUniCredCLI:true,request({method,params}){return rpc(method,params||[])},sendAsync(payload,callback){const a=Array.isArray(payload)?payload:[payload];Promise.all(a.map(x=>rpc(x.method,x.params||[]))).then(results=>{const r=Array.isArray(payload)?results.map((result,i)=>({jsonrpc:'2.0',id:a[i].id,result})):({jsonrpc:'2.0',id:a[0].id,result:results[0]});callback(null,r)}).catch(callback)},send(payload){if(typeof payload==='string')return rpc(payload,[]);if(Array.isArray(payload))return Promise.all(payload.map(x=>rpc(x.method,x.params||[])));return rpc(payload.method,payload.params||[])},on(event,fn){if(!listeners.has(event))listeners.set(event,[]);listeners.get(event).push(fn);return this},removeListener(event,fn){listeners.set(event,(listeners.get(event)||[]).filter(x=>x!==fn));return this}};window.dispatchEvent(new Event('ethereum#initialized'));})();";
}

function parseHashrateValue(text) {
  const m = text.match(/(?:HASHRATE|RATE)\s*[:|]?\s*(\d+(?:\.\d+)?)\s*(GH\/s|MH\/s|KH\/s|H\/s)/i);
  return m ? m[1] + ' ' + m[2] : 'n/a';
}

function parseLabeledValue(text, label) {
  const lines = text.split(/\n/).map(s => s.trim()).filter(Boolean);
  const i = lines.findIndex(line => new RegExp('^' + label + '\\b', 'i').test(line));
  if (i >= 0) {
    const line = lines[i].replace(new RegExp('^' + label + '\\s*[:|]?\\s*', 'i'), '').trim();
    if (line && !/^(?:HASHRATE|EXPECTED|STREAK|DIFFICULTY|CPU|GPU|LIVE RACE)\b/i.test(line)) {
      return line;
    }
    if (lines[i + 1] && !/^(?:HASHRATE|EXPECTED|STREAK|DIFFICULTY|CPU|GPU|LIVE RACE)\b/i.test(lines[i + 1])) {
      return lines[i + 1];
    }
  }
  return 'n/a';
}

async function readMetricFromDom(page, label) {
  try {
    return await page.evaluate((label) => {
      const all = Array.from(document.querySelectorAll('body *'));
      const exact = all.filter(el => (el.textContent || '').trim() === label);
      for (const el of exact) {
        let p = el.parentElement;
        for (let depth = 0; p && depth < 4; depth++, p = p.parentElement) {
          const text = (p.innerText || '').replace(/\\n+/g, ' ').replace(/\\s+/g, ' ').trim();
          if (text && text.length < 160 && text.includes(label)) {
            const rest = text.replace(new RegExp('^' + label + '\\s*[:|]?\\s*', 'i'), '').trim();
            if (rest && rest !== label) return rest;
          }
        }
      }
      return null;
    }, label);
  } catch {
    return null;
  }
}

async function extractStats(page, text) {
  const hashDom = await readMetricFromDom(page, 'HASHRATE');
  const expectedDom = await readMetricFromDom(page, 'EXPECTED');
  const streakDom = await readMetricFromDom(page, 'STREAK');
  const difficultyDom = await readMetricFromDom(page, 'DIFFICULTY');

  return {
    hashrate: (hashDom && /(?:GH\/s|MH\/s|KH\/s|H\/s)/i.test(hashDom))
      ? hashDom
      : parseHashrateValue(text),
    expected: expectedDom || parseLabeledValue(text, 'EXPECTED'),
    streak: streakDom || parseLabeledValue(text, 'STREAK'),
    difficulty: difficultyDom || parseLabeledValue(text, 'DIFFICULTY')
  };
}

async function selectGpuMode(page) {
  if (!FORCE_GPU_MODE) return;

  const controls = await page.locator('button').evaluateAll(buttons =>
    buttons.map(el => ({
      text: (el.innerText || '').trim(),
      ariaPressed: el.getAttribute('aria-pressed'),
      disabled: el.disabled,
      visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
    })).filter(x => /^(CPU|GPU)$/i.test(x.text))
  );
  console.log('[MODE] CPU/GPU controls:', JSON.stringify(controls));

  const gpuButtons = page.locator('button').filter({hasText: /^GPU$/i});
  const count = await gpuButtons.count();
  if (!count) die('GPU mode button not found on unicred.fun.');

  let clicked = false;
  for (let i = 0; i < count; i++) {
    const btn = gpuButtons.nth(i);
    if (await btn.isVisible().catch(() => false)) {
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click({force:true}).catch(async () => {
        await btn.evaluate(el => el.click());
      });
      clicked = true;
      break;
    }
  }

  if (!clicked) die('GPU mode button exists but is not visible.');

  await page.waitForTimeout(1000);

  const after = await page.locator('button').evaluateAll(buttons =>
    buttons.map(el => ({
      text: (el.innerText || '').trim(),
      ariaPressed: el.getAttribute('aria-pressed'),
      disabled: el.disabled,
      visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
    })).filter(x => /^(CPU|GPU)$/i.test(x.text))
  );
  console.log('[MODE] After GPU click:', JSON.stringify(after));
}


function webGpuInstrumentationScript() {
  return String.raw`(()=> {
    const workerIndex = ${WORKER_INDEX};
    const workerCount = ${WORKER_COUNT};
    const partitioned = ${PARTITIONED};
    const inspectKernel = ${INSPECT_KERNEL};

    window.__UNICRED_DEBUG = {
      startedAt: Date.now(),
      shaders: [],
      queueSubmitCount: 0,
      randomCalls: 0,
      randomSamples: [],
      shaderPatched: false,
      partitionFormula: null,
      partitionWorkerIndex: workerIndex,
      partitionWorkerCount: workerCount,
      paramsWrites: [],
      dispatches: []
    };

    const paramsBuffers = new WeakSet();
    const seenShaderModules = new WeakSet();

    const installHooks = () => {
      try {
        if (window.GPUDevice && !window.GPUDevice.__unicredHooksInstalled) {
          const originalShader = window.GPUDevice.prototype.createShaderModule;
          if (typeof originalShader === 'function') {
            window.GPUDevice.prototype.createShaderModule = function(desc) {
              try {
                if (desc && typeof desc.code === 'string') {
                  let code = desc.code;
                  let changed = false;

                  if (partitioned) {
                    const re = /let\s+ctr\s*=\s*p\.ctrBase\s*\+\s*gid\.x\s*;/;
                    if (re.test(code)) {
                      code = code.replace(
                        re,
                        'let ctr = p.ctrBase + gid.x * ' + workerCount + 'u + ' + workerIndex + 'u;'
                      );
                      window.__UNICRED_DEBUG.shaderPatched = true;
                      window.__UNICRED_DEBUG.partitionFormula =
                        'ctr = ctrBase + gid.x * ' + workerCount + ' + ' + workerIndex;
                      changed = true;
                      console.log(
                        '[PARTITION] patched mining shader: ' +
                        window.__UNICRED_DEBUG.partitionFormula
                      );
                    }
                  }

                  if (inspectKernel && !seenShaderModules.has(desc)) {
                    seenShaderModules.add(desc);
                    window.__UNICRED_DEBUG.shaders.push({
                      t: Date.now(),
                      label: desc.label || null,
                      originalCode: desc.code.slice(0, 1000000),
                      code: code.slice(0, 1000000)
                    });
                  }

                  if (changed) {
                    return originalShader.call(this, {...desc, code});
                  }
                }
              } catch (e) {
                console.log('[PARTITION] shader hook error: ' + e.message);
              }
              return originalShader.apply(this, arguments);
            };
          }

          const originalBindGroup = window.GPUDevice.prototype.createBindGroup;
          if (typeof originalBindGroup === 'function') {
            window.GPUDevice.prototype.createBindGroup = function(desc) {
              try {
                if (desc && Array.isArray(desc.entries)) {
                  for (const entry of desc.entries) {
                    if (entry && entry.binding === 1 && entry.resource && entry.resource.buffer) {
                      paramsBuffers.add(entry.resource.buffer);
                    }
                  }
                }
              } catch {}
              return originalBindGroup.apply(this, arguments);
            };
          }

          window.GPUDevice.__unicredHooksInstalled = true;

          // Partitioned mining only needs the shader rewrite.
          // Do not install diagnostic queue/crypto hooks during live mining.
          if (partitioned) return;
        }

        if (window.GPUQueue && !window.GPUQueue.__unicredHooksInstalled) {
          const originalSubmit = window.GPUQueue.prototype.submit;
          if (typeof originalSubmit === 'function') {
            window.GPUQueue.prototype.submit = function(commandBuffers) {
              window.__UNICRED_DEBUG.queueSubmitCount += Array.isArray(commandBuffers) ? commandBuffers.length : 1;
              return originalSubmit.apply(this, arguments);
            };
          }

          const originalWriteBuffer = window.GPUQueue.prototype.writeBuffer;
          if (typeof originalWriteBuffer === 'function') {
            window.GPUQueue.prototype.writeBuffer = function(buffer, bufferOffset, data, dataOffset, size) {
              try {
                if (paramsBuffers.has(buffer)) {
                  let bytes = null;
                  if (ArrayBuffer.isView(data)) {
                    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
                  } else if (data instanceof ArrayBuffer) {
                    bytes = new Uint8Array(data);
                  }

                  if (bytes && bytes.byteLength >= 16) {
                    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                    const ctrBase = view.getUint32(4, true);

                    if (window.__UNICRED_DEBUG.paramsWrites.length < 32) {
                      window.__UNICRED_DEBUG.paramsWrites.push({
                        t: Date.now(),
                        ctrBase,
                        hiSw: view.getUint32(0, true),
                        tHi: view.getUint32(8, true),
                        tLo: view.getUint32(12, true)
                      });
                    }

                    if (window.__UNICRED_DEBUG.paramsWrites.length <= 3) {
                      console.log('[PARTITION] Params ctrBase=' + ctrBase);
                    }
                  }
                }
              } catch {}
              return originalWriteBuffer.apply(this, arguments);
            };
          }

          window.GPUQueue.__unicredHooksInstalled = true;
        }

        if (window.GPUComputePassEncoder && !window.GPUComputePassEncoder.__unicredHooksInstalled) {
          const originalDispatch = window.GPUComputePassEncoder.prototype.dispatchWorkgroups;
          if (typeof originalDispatch === 'function') {
            window.GPUComputePassEncoder.prototype.dispatchWorkgroups = function(x, y=1, z=1) {
              if (window.__UNICRED_DEBUG.dispatches.length < 32) {
                window.__UNICRED_DEBUG.dispatches.push({
                  t: Date.now(),
                  x, y, z,
                  countersPerDispatch: Number(x) * 256
                });
              }
              return originalDispatch.apply(this, arguments);
            };
          }
          window.GPUComputePassEncoder.__unicredHooksInstalled = true;
        }

        if (window.crypto && typeof window.crypto.getRandomValues === 'function' &&
            !window.crypto.__unicredRandomHooked) {
          const originalRandom = window.crypto.getRandomValues.bind(window.crypto);
          window.crypto.getRandomValues = function(view) {
            const out = originalRandom(view);
            window.__UNICRED_DEBUG.randomCalls++;
            if (window.__UNICRED_DEBUG.randomSamples.length < 32) {
              try {
                window.__UNICRED_DEBUG.randomSamples.push({
                  t: Date.now(),
                  length: view.byteLength || 0,
                  bytes: Array.from(new Uint8Array(view.buffer, view.byteOffset, Math.min(view.byteLength, 64)))
                });
              } catch {}
            }
            return out;
          };
          window.__unicredRandomHooked = true;
        }
      } catch (e) {
        console.log('[PARTITION] instrumentation error: ' + e.message);
      }
    };

    installHooks();
    if (!partitioned) setInterval(installHooks, 100);
  })();`;
}

async function main() {
  console.clear();
  console.log('====================================================');
  console.log('              UNICRED VAST GPU MINER');
  console.log('====================================================');

  const gpus = printGpuStats();
  if (!gpus.length) die('No NVIDIA GPU detected.');

  let gpuSelection = null;
  if (GPU_INDEX_RAW != null) {
    if (!Number.isInteger(GPU_INDEX) || GPU_INDEX < 0) {
      die('Invalid --gpu-index: ' + GPU_INDEX_RAW);
    }
    gpuSelection = resolveGpuSelection(GPU_INDEX);
    console.log(
      '[AFFINITY] NVIDIA GPU ' + gpuSelection.index +
      ' → Vulkan index ' + gpuSelection.vulkanIndex +
      ' → ' + gpuSelection.name +
      ' | PCI ' + gpuSelection.busId
    );
  }
  console.log('Detected NVIDIA GPUs: ' + gpus.length);
  if (gpus.length > 1) {
    console.log('NOTE: Single-GPU mode enabled. Using the default/high-performance NVIDIA adapter only.');
  }
  console.log('Mode: ' + (DRY_RUN ? 'DRY RUN' : AUTO_SUBMIT ? 'AUTO-SUBMIT' : 'FIND ONLY'));

  const rpc = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, {staticNetwork:true});
  const network = await rpc.getNetwork();
  if (Number(network.chainId) !== CHAIN_ID) {
    die('Wrong RPC chainId ' + network.chainId + '; expected ' + CHAIN_ID);
  }

  let wallet;
  if (AUTO_SUBMIT) {
    if (!process.env.UNICRED_PRIVATE_KEY) die('For --submit, set UNICRED_PRIVATE_KEY.');
    wallet = new ethers.Wallet(validatePrivateKey(process.env.UNICRED_PRIVATE_KEY), rpc);
  } else if (process.env.UNICRED_PRIVATE_KEY) {
    wallet = new ethers.Wallet(validatePrivateKey(process.env.UNICRED_PRIVATE_KEY), rpc);
  } else {
    wallet = ethers.Wallet.createRandom(rpc);
    console.log('Dry-run wallet: ' + wallet.address);
  }

  console.log('Wallet: ' + wallet.address);
  if (AUTO_SUBMIT) {
    const balance = await rpc.getBalance(wallet.address);
    console.log('[MINT] Unichain balance: ' + ethers.formatEther(balance) + ' ETH');
    console.log('[MINT] Signer provider: attached to Unichain RPC');
  }

  const display = GPU_INDEX == null ? ':99' : ':' + (99 + GPU_INDEX);
  const xvfb = !HEADLESS ? startVirtualDisplay(display) : null;
  const browserEnv = {...process.env};
  if (gpuSelection) Object.assign(browserEnv, gpuSelection.env);
  console.log(
    'DISPLAY:', process.env.DISPLAY || 'unset',
    '| Chromium mode:', HEADLESS ? 'headless' : 'X11/virtual-display',
    '| worker:', WORKER_ID
  );

  const chromiumArgs = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--disable-software-rasterizer',
    '--force_high_performance_gpu',
    '--use-webgpu-power-preference=high-performance',
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,UseOzonePlatform',
    '--use-angle=vulkan',
    ...(HEADLESS ? [] : ['--ozone-platform=x11']),
    '--window-size=1440,900'
  ];

  const context = await chromium.launchPersistentContext('', {
    headless: HEADLESS,
    executablePath: chromium.executablePath(),
    viewport: {width:1440, height:900},
    args: chromiumArgs,
    env: browserEnv
  });

  const page = await context.newPage();

  await context.exposeFunction('__unicred_rpc', async (method, params) => {
    if (method === 'eth_chainId') return CHAIN_HEX;
    if (method === 'net_version') return String(CHAIN_ID);
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [wallet.address];
    if (method === 'eth_coinbase') return wallet.address;
    if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;

    if (method === 'eth_getBalance') {
      const balance = await rpc.getBalance(params?.[0] || wallet.address, params?.[1] || 'latest');
      return '0x' + balance.toString(16);
    }
    if (method === 'eth_blockNumber') return '0x' + (await rpc.getBlockNumber()).toString(16);

    if (method === 'eth_getBlockByNumber') {
      const tag = params?.[0] || 'latest';
      const block = await rpc.getBlock(tag === 'latest' ? 'latest' : Number(BigInt(tag)));
      if (!block) return null;
      return {
        number:'0x' + block.number.toString(16),
        hash:block.hash,
        timestamp:'0x' + block.timestamp.toString(16),
        parentHash:block.parentHash
      };
    }

    if (method === 'eth_call') {
      const tx = params?.[0] || {};
      return rpc.call({to:tx.to, data:tx.data, value:tx.value, from:tx.from}, params?.[1] || 'latest');
    }
    if (method === 'eth_estimateGas') {
      const tx = params?.[0] || {};
      return '0x' + (await rpc.estimateGas(tx)).toString(16);
    }
    if (method === 'eth_getTransactionCount') {
      return '0x' + (await rpc.getTransactionCount(params?.[0] || wallet.address, params?.[1] || 'latest')).toString(16);
    }
    if (method === 'eth_getCode') return rpc.getCode(params?.[0], params?.[1] || 'latest');

    if (method === 'eth_getTransactionByHash' || method === 'eth_getTransactionReceipt' || method === 'eth_feeHistory') {
      return rpc.send(method, params || []);
    }
    if (method === 'eth_gasPrice') {
      const fee = await rpc.getFeeData();
      return fee.gasPrice == null ? '0x0' : '0x' + fee.gasPrice.toString(16);
    }
    if (method === 'eth_maxPriorityFeePerGas') return '0x0';

    if (method === 'personal_sign') {
      if (DRY_RUN) throw new Error('personal_sign disabled in dry-run.');
      return wallet.signMessage(ethers.getBytes(params?.[0] || '0x'));
    }
    if (method === 'eth_sign') {
      if (DRY_RUN) throw new Error('eth_sign disabled in dry-run.');
      return wallet.signMessage(ethers.getBytes(params?.[1] || '0x'));
    }

    if (method === 'eth_sendTransaction') {
      if (!AUTO_SUBMIT || DRY_RUN) throw new Error('Transaction blocked. Use --submit to enable.');

      const tx = {...(params?.[0] || {})};
      delete tx.from;
      if (tx.gas) {
        tx.gasLimit = BigInt(tx.gas);
        delete tx.gas;
      }

      await assertAffordableMint(rpc, tx, wallet);

      const sent = await wallet.sendTransaction(tx);
      console.log('TX SENT: ' + sent.hash);

      // Keep the process/page informed about confirmation.
      try {
        const receipt = await sent.wait(1);
        console.log('[MINT] Confirmed in block ' + receipt.blockNumber + ' status=' + receipt.status);
      } catch (e) {
        console.log('[MINT] Receipt wait failed:', e.message);
      }

      return sent.hash;
    }

    if (method === 'eth_signTypedData_v4' || method === 'eth_signTypedData') {
      if (!AUTO_SUBMIT || DRY_RUN) throw new Error('Typed-data signing blocked. Use --submit to enable.');
      const p = params || [];
      const typed = typeof p[p.length - 1] === 'string'
        ? JSON.parse(p[p.length - 1])
        : p[p.length - 1];
      const domain = typed.domain || {};
      const types = {...typed.types};
      delete types.EIP712Domain;
      return wallet.signTypedData(domain, types, typed.message);
    }

    if (method === 'eth_sendRawTransaction') {
      if (!AUTO_SUBMIT || DRY_RUN) throw new Error('Raw transaction blocked. Use --submit to enable.');
      const txHash = await rpc.send(method, params || []);
      console.log('TX: ' + txHash);
      return txHash;
    }

    if (method.startsWith('eth_') || method.startsWith('net_') || method.startsWith('web3_')) {
      return rpc.send(method, params || []);
    }

    throw new Error('Unsupported RPC method: ' + method);
  });

  await page.addInitScript({content:providerScript()});
  if (INSPECT_KERNEL || PARTITIONED) {
    await page.addInitScript({content:webGpuInstrumentationScript()});
    console.log(
      '[DEBUG] WebGPU instrumentation enabled for worker ' + WORKER_ID +
      (PARTITIONED ? ' | partition ' + WORKER_INDEX + '/' + WORKER_COUNT : '')
    );
  }
  page.on('console', msg => {
    const text = msg.text();
    if (/hashrate|H\/s|GPU|error|mine|mint|wallet|unicorn|difficulty|target|partition/i.test(text)) {
      console.log('[page] ' + text);
    }
  });
  page.on('pageerror', error => console.log('[pageerror] ' + error.message));

  console.log('Chromium: ' + chromium.executablePath());
  console.log('Launching with hardware-GPU-only flags...');

  await page.goto(SITE, {waitUntil:'domcontentloaded', timeout:120000});

  const webgpu = await page.evaluate(async () => {
    if (!navigator.gpu) return {available:false, adapter:null};
    const adapter = await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
    return {
      available:true,
      adapter: adapter ? {
        vendor:adapter.info?.vendor || null,
        architecture:adapter.info?.architecture || null,
        device:adapter.info?.device || null,
        description:adapter.info?.description || null
      } : null
    };
  });

  console.log('WebGPU: ' + JSON.stringify(webgpu));

  const adapterText = JSON.stringify(webgpu.adapter || {}).toLowerCase();
  const software = /swiftshader|llvmpipe|software/.test(adapterText);
  const nvidia = /nvidia|geforce|10de/.test(adapterText);

  if (!webgpu.available || !webgpu.adapter) {
    die('WebGPU adapter unavailable. Check the Vast NVIDIA graphics/Vulkan stack.');
  }
  if (STRICT_GPU && (!nvidia || software)) {
    die('WebGPU is not using an NVIDIA hardware adapter. Refusing software rendering.');
  }

  if (gpuSelection) {
    console.log(
      '[AFFINITY] WebGPU adapter for worker ' + WORKER_ID + ': ' +
      JSON.stringify(webgpu.adapter)
    );
  }

  if (PROBE_ONLY) {
    console.log('[PROBE] WebGPU affinity probe passed for worker ' + WORKER_ID + '.');
    await context.close();
    if (xvfb) xvfb.kill('SIGTERM');
    process.exit(0);
  }

  await page.waitForTimeout(4000);

  const connect = page.getByRole('button', {name:/connect wallet/i}).first();
  if (await connect.isVisible().catch(()=>false)) await connect.click().catch(()=>{});
  await page.waitForTimeout(1500);

  if (FORCE_GPU_MODE) await selectGpuMode(page);

  const range = page.locator('input[type="range"]').first();
  if (await range.count()) await range.fill(String(USAGE)).catch(()=>{});

  const start = page.getByRole('button', {name:/start mining/i}).first();
  if (!(await start.isVisible().catch(()=>false))) {
    die('Start Mining button not found. Unicred UI/client changed or wallet connection did not initialize.');
  }

  await start.click();
  await page.waitForTimeout(2500);

  const startupBody = await page.locator('body').innerText().catch(() => '');
  if (FORCE_GPU_MODE && /Rig started on the CPU/i.test(startupBody)) {
    die('Unicred started CPU mining despite GPU selection. Refusing to waste the rented GPU.');
  }

  console.log('Mining started.');

  const startedAt = Date.now();
  const debugFile = (INSPECT_KERNEL || PARTITIONED)
    ? path.resolve(process.env.UNICRED_MULTI_GPU_LOG_DIR || '.multi-gpu-logs', WORKER_ID + '-debug.json')
    : null;
  if (debugFile) fs.mkdirSync(path.dirname(debugFile), {recursive:true});

  setInterval(async () => {
    try {
      const body = await page.locator('body').innerText().catch(()=>'');
      const lines = body.split(/\n/).map(s=>s.trim()).filter(Boolean);
      const metrics = await extractStats(page, body);
      const uptime = Math.floor((Date.now()-startedAt)/1000);
      const hh = String(Math.floor(uptime/3600)).padStart(2,'0');
      const mm = String(Math.floor((uptime%3600)/60)).padStart(2,'0');
      const ss = String(uptime%60).padStart(2,'0');

      console.log('\n[STATS] uptime ' + hh + ':' + mm + ':' + ss);
      console.log('[STATS] hashrate  ' + metrics.hashrate);
      console.log('[STATS] expected  ' + metrics.expected);
      console.log('[STATS] streak    ' + metrics.streak);
      console.log('[STATS] difficulty ' + metrics.difficulty);
      console.log('[STATS] WebGPU ' + (webgpu.adapter.description || webgpu.adapter.vendor || 'NVIDIA') + (GPU_INDEX != null ? ' | GPU ' + GPU_INDEX : ''));
      const gpuRowsNow = printGpuStats();
      if (gpuRowsNow.length === 1) {
        const g = gpuRowsNow[0];
        const util = Number(g.util);
        const power = Number(g.power);
        if (uptime >= 20 && (util < 20 || power < 100)) {
          console.log('[WARN] GPU load is low for a 5090: util=' + util + '% power=' + power + 'W. Check the actual mining mode/workload.');
        }
      }

      if (INSPECT_KERNEL || PARTITIONED) {
        try {
          const debug = await page.evaluate(() => window.__UNICRED_DEBUG || null);
          if (debugFile && debug) {
            fs.writeFileSync(debugFile, JSON.stringify(debug, null, 2));
          }
          if (PARTITIONED && uptime >= 10 && !(debug && debug.shaderPatched)) {
            die('Partition mode could not patch the Unicred mining shader. Refusing to run unpartitioned.');
          }
        } catch (error) {
          console.log('[DEBUG ERROR] ' + error.message);
        }
      }

      const statusLines = lines.filter(x =>
        /(?:found|won|mint|transaction|tx|error|race|streak|expected|difficulty)/i.test(x) &&
        x.length < 220
      );
      if (statusLines.length) {
        console.log('[UNICRED] ' + statusLines.slice(0,8).join(' | '));
      }
    } catch (error) {
      console.log('[STATS ERROR] ' + error.message);
    }
  }, STATS_MS);

  process.on('SIGINT', async () => {
    console.log('\nStopping miner...');
    await context.close();
    if (xvfb) xvfb.kill('SIGTERM');
    process.exit(0);
  });

  await new Promise(() => {});
}

main().catch(error => die(error.stack || error.message || String(error)));
