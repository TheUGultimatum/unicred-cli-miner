#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
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
const HEADLESS = !has('--headed');
const USAGE = Math.max(1, Math.min(100, Number(arg('--usage', process.env.UNICRED_USAGE || '100'))));

function die(message) {
  console.error('\nERROR:', message);
  process.exit(1);
}

function gpuInfo() {
  const r = spawnSync(
    'nvidia-smi',
    ['--query-gpu=name,memory.total,driver_version,utilization.gpu', '--format=csv,noheader'],
    { encoding: 'utf8' }
  );
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : 'nvidia-smi not available';
}

function validatePrivateKey(pk) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    die('Invalid private key format.');
  }
  return pk;
}

function providerScript() {
  return String.raw`
(() => {
  const listeners = new Map();
  const rpc = (method, params) => window.__unicred_rpc(method, params || []);

  window.ethereum = {
    isMetaMask: true,
    isRabby: true,
    isUniCredCLI: true,

    request({ method, params }) {
      return rpc(method, params || []);
    },

    sendAsync(payload, callback) {
      const requests = Array.isArray(payload) ? payload : [payload];

      Promise.all(requests.map(x => rpc(x.method, x.params || [])))
        .then(results => {
          const response = Array.isArray(payload)
            ? results.map((result, i) => ({
                jsonrpc: '2.0',
                id: requests[i].id,
                result
              }))
            : {
                jsonrpc: '2.0',
                id: requests[0].id,
                result: results[0]
              };

          callback(null, response);
        })
        .catch(callback);
    },

    send(payload) {
      if (typeof payload === 'string') return rpc(payload, []);
      if (Array.isArray(payload)) {
        return Promise.all(payload.map(x => rpc(x.method, x.params || [])));
      }
      return rpc(payload.method, payload.params || []);
    },

    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return this;
    },

    removeListener(event, fn) {
      listeners.set(
        event,
        (listeners.get(event) || []).filter(x => x !== fn)
      );
      return this;
    }
  };

  window.dispatchEvent(new Event('ethereum#initialized'));
})();
`;
}

async function main() {
  console.log('\nUNICRED CLI MINER');
  console.log('GPU:', gpuInfo());
  console.log('Mode:', DRY_RUN ? 'DRY RUN' : AUTO_SUBMIT ? 'AUTO-SUBMIT' : 'FIND ONLY');

  let wallet;

  if (AUTO_SUBMIT) {
    const raw = process.env.UNICRED_PRIVATE_KEY;
    if (!raw) die('For --submit, set UNICRED_PRIVATE_KEY in the environment.');
    wallet = new ethers.Wallet(validatePrivateKey(raw));
  } else if (process.env.UNICRED_PRIVATE_KEY) {
    wallet = new ethers.Wallet(validatePrivateKey(process.env.UNICRED_PRIVATE_KEY));
  } else {
    wallet = ethers.Wallet.createRandom();
    console.log('Dry-run wallet:', wallet.address);
  }

  const rpc = new ethers.JsonRpcProvider(
    RPC_URL,
    CHAIN_ID,
    { staticNetwork: true }
  );

  const network = await rpc.getNetwork();
  if (Number(network.chainId) !== CHAIN_ID) {
    die(`Wrong RPC chainId ${network.chainId}; expected ${CHAIN_ID}`);
  }

  console.log('Wallet:', wallet.address);

  const context = await chromium.launchPersistentContext('', {
    headless: HEADLESS,
    executablePath: chromium.executablePath(),
    viewport: { width: 1440, height: 900 },
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
      '--use-angle=vulkan',
      '--window-size=1440,900'
    ]
  });

  const page = await context.newPage();

  await context.exposeFunction('__unicred_rpc', async (method, params) => {
    if (method === 'eth_chainId') return CHAIN_HEX;
    if (method === 'net_version') return String(CHAIN_ID);

    if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
      return [wallet.address];
    }

    if (method === 'eth_coinbase') return wallet.address;

    if (
      method === 'wallet_switchEthereumChain' ||
      method === 'wallet_addEthereumChain'
    ) {
      return null;
    }

    if (method === 'eth_getBalance') {
      const balance = await rpc.getBalance(
        params?.[0] || wallet.address,
        params?.[1] || 'latest'
      );
      return '0x' + balance.toString(16);
    }

    if (method === 'eth_blockNumber') {
      return '0x' + (await rpc.getBlockNumber()).toString(16);
    }

    if (method === 'eth_getBlockByNumber') {
      const tag = params?.[0] || 'latest';
      const block = await rpc.getBlock(
        tag === 'latest' ? 'latest' : Number(BigInt(tag))
      );

      if (!block) return null;

      return {
        number: '0x' + block.number.toString(16),
        hash: block.hash,
        timestamp: '0x' + block.timestamp.toString(16),
        parentHash: block.parentHash
      };
    }

    if (method === 'eth_call') {
      const tx = params?.[0] || {};
      return rpc.call(
        {
          to: tx.to,
          data: tx.data,
          value: tx.value,
          from: tx.from
        },
        params?.[1] || 'latest'
      );
    }

    if (method === 'eth_estimateGas') {
      const tx = params?.[0] || {};
      return '0x' + (await rpc.estimateGas(tx)).toString(16);
    }

    if (method === 'eth_getTransactionCount') {
      return '0x' + (
        await rpc.getTransactionCount(
          params?.[0] || wallet.address,
          params?.[1] || 'latest'
        )
      ).toString(16);
    }

    if (method === 'eth_getCode') {
      return rpc.getCode(params?.[0], params?.[1] || 'latest');
    }

    if (
      method === 'eth_getTransactionByHash' ||
      method === 'eth_getTransactionReceipt' ||
      method === 'eth_feeHistory'
    ) {
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
      if (!AUTO_SUBMIT || DRY_RUN) {
        throw new Error('Transaction blocked. Use --submit to enable.');
      }

      const tx = { ...(params?.[0] || {}) };
      delete tx.from;

      if (tx.gas) {
        tx.gasLimit = BigInt(tx.gas);
        delete tx.gas;
      }

      const sent = await wallet.sendTransaction(tx);
      console.log('TX:', sent.hash);
      return sent.hash;
    }

    if (method === 'eth_sendRawTransaction') {
      if (!AUTO_SUBMIT || DRY_RUN) {
        throw new Error('Raw transaction blocked. Use --submit to enable.');
      }

      const txHash = await rpc.send(method, params || []);
      console.log('TX:', txHash);
      return txHash;
    }

    if (
      method.startsWith('eth_') ||
      method.startsWith('net_') ||
      method.startsWith('web3_')
    ) {
      return rpc.send(method, params || []);
    }

    throw new Error(`Unsupported RPC method: ${method}`);
  });

  await page.addInitScript({ content: providerScript() });

  page.on('console', msg => {
    const text = msg.text();
    if (/hashrate|H\/s|GPU|error|mine|mint|wallet|unicorn|difficulty|target/i.test(text)) {
      console.log('[page]', text);
    }
  });

  page.on('pageerror', error => {
    console.log('[pageerror]', error.message);
  });

  console.log('Chromium:', chromium.executablePath());

  await page.goto(SITE, {
    waitUntil: 'domcontentloaded',
    timeout: 120000
  });

  const webgpu = await page.evaluate(async () => {
    if (!navigator.gpu) return { available: false, adapter: null };

    const adapter = await navigator.gpu.requestAdapter();

    return {
      available: true,
      adapter: adapter
        ? {
            vendor: adapter.info?.vendor || null,
            architecture: adapter.info?.architecture || null,
            device: adapter.info?.device || null,
            description: adapter.info?.description || null
          }
        : null
    };
  });

  console.log('WebGPU:', JSON.stringify(webgpu));

  if (!webgpu.available || !webgpu.adapter) {
    die('WebGPU adapter unavailable. Fix the VPS/Chromium GPU configuration before mining.');
  }

  await page.waitForTimeout(4000);

  const connect = page.getByRole('button', { name: /connect wallet/i }).first();
  if (await connect.isVisible().catch(() => false)) {
    await connect.click().catch(() => {});
  }

  await page.waitForTimeout(1500);

  const gpu = page.getByRole('button', { name: /^GPU$/i }).first();
  if (await gpu.isVisible().catch(() => false)) {
    await gpu.click().catch(() => {});
  }

  const range = page.locator('input[type="range"]').first();
  if (await range.count()) {
    await range.fill(String(USAGE)).catch(() => {});
  }

  const start = page.getByRole('button', { name: /start mining/i }).first();

  if (!(await start.isVisible().catch(() => false))) {
    die('Start Mining button not found. Unicred UI/client changed or wallet connection did not initialize.');
  }

  console.log('Starting mining...');
  await start.click();

  setInterval(async () => {
    const body = await page.locator('body').innerText().catch(() => '');
    const lines = body
      .split(/\n/)
      .map(s => s.trim())
      .filter(Boolean)
      .filter(x => /HASHRATE|H\/s|EXPECTED|STREAK|DIFFICULTY|GPU|CPU|LIVE RACE|WIN|MINT|TX|ERROR/i.test(x));

    if (lines.length) {
      console.log(lines.slice(0, 15).join(' | '));
    }
  }, 15000);

  process.on('SIGINT', async () => {
    await context.close();
    process.exit(0);
  });

  await new Promise(() => {});
}

main().catch(error => die(error.stack || error.message || String(error)));
