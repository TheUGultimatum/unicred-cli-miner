#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const { ethers } = require('ethers');
const { chromium } = require('playwright');

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

function startVirtualDisplay() {
  if (process.env.DISPLAY || !USE_XVFB) return null;
  const xvfb = spawn('Xvfb', [':99', '-screen', '0', '1440x900x24', '-nolisten', 'tcp'], {
    stdio: 'ignore',
    detached: false
  });
  process.env.DISPLAY = ':99';
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

async function main() {
  console.clear();
  console.log('====================================================');
  console.log('              UNICRED VAST GPU MINER');
  console.log('====================================================');

  const gpus = printGpuStats();
  if (!gpus.length) die('No NVIDIA GPU detected.');
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

  const xvfb = !HEADLESS ? startVirtualDisplay() : null;
  console.log('DISPLAY:', process.env.DISPLAY || 'unset', '| Chromium mode:', HEADLESS ? 'headless' : 'X11/virtual-display');

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
    env: {...process.env, ...(process.env.DISPLAY ? {DISPLAY: process.env.DISPLAY} : {})}
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
  page.on('console', msg => {
    const text = msg.text();
    if (/hashrate|H\/s|GPU|error|mine|mint|wallet|unicorn|difficulty|target/i.test(text)) {
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
      console.log('[STATS] WebGPU ' + (webgpu.adapter.description || webgpu.adapter.vendor || 'NVIDIA'));
      const gpuRowsNow = printGpuStats();
      if (gpuRowsNow.length === 1) {
        const g = gpuRowsNow[0];
        const util = Number(g.util);
        const power = Number(g.power);
        if (uptime >= 20 && (util < 20 || power < 100)) {
          console.log('[WARN] GPU load is low for a 5090: util=' + util + '% power=' + power + 'W. Check the actual mining mode/workload.');
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
