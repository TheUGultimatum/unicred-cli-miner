#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ethers } = require('ethers');
const { chromium } = require('playwright-core');

const SITE='https://unicred.fun/';
const RPC_URL=process.env.UNICRED_RPC_URL||'https://mainnet.unichain.org';
const CHAIN_ID=130;
const CHAIN_HEX='0x82';
const CHROMIUM=process.env.CHROMIUM_PATH||'/usr/bin/chromium';

function has(x){return process.argv.includes(x)}
function arg(x,d=null){const i=process.argv.indexOf(x);return i>=0?(process.argv[i+1]??d):d}
const DRY_RUN=has('--dry-run')||process.env.UNICRED_DRY_RUN==='1';
const AUTO_SUBMIT=has('--submit')||process.env.UNICRED_AUTO_SUBMIT==='1';
const HEADLESS=!has('--headed');
const USAGE=Math.max(1,Math.min(100,Number(arg('--usage',process.env.UNICRED_USAGE||'100'))));

function die(m){console.error('\nERROR:',m);process.exit(1)}
function gpuInfo(){
  const r=spawnSync('nvidia-smi',['--query-gpu=name,memory.total,driver_version','--format=csv,noheader'],{encoding:'utf8'});
  return r.status===0&&r.stdout.trim()?r.stdout.trim():'nvidia-smi not available';
}
function chromiumPath(){
  for(const p of [CHROMIUM,'/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome','/usr/bin/google-chrome-stable']) if(fs.existsSync(p)) return p;
  return null;
}
function hiddenInput(prompt){
  return new Promise((resolve,reject)=>{
    if(!process.stdin.isTTY) return reject(new Error('Set UNICRED_PRIVATE_KEY in the environment.'));
    const s=process.stdin; s.resume(); s.setRawMode(true); process.stdout.write(prompt); let v='';
    const on=(b)=>{const c=b.toString('utf8'); if(c==='\u0003'){s.setRawMode(false);s.pause();s.off('data',on);process.stdout.write('\n');return reject(new Error('Cancelled.'))}
      if(c==='\r'||c==='\n'){s.setRawMode(false);s.pause();s.off('data',on);process.stdout.write('\n');return resolve(v.trim())}
      if(c==='\u007f') v=v.slice(0,-1); else if(c.length===1)v+=c};
    s.on('data',on);
  })
}
async function getKey(){return (process.env.UNICRED_PRIVATE_KEY||await hiddenInput('Private key (hidden): ')).trim()}
function normalize(pk){if(!/^0x[0-9a-fA-F]{64}$/.test(pk))die('Invalid private key format.');return pk}

function providerScript(){return `(()=>{const listeners=new Map();const rpc=(m,p)=>window.__unicred_rpc(m,p||[]);const emit=(e,v)=>(listeners.get(e)||[]).forEach(f=>{try{f(v)}catch(_){}});window.__unicred_emit=emit;window.ethereum={isMetaMask:true,isRabby:true,isUniCredCLI:true,request:({method,params})=>rpc(method,params||[]),sendAsync(p,cb){const a=Array.isArray(p)?p:[p];Promise.all(a.map(x=>rpc(x.method,x.params||[]))).then(r=>cb(null,Array.isArray(p)?r.map((z,i)=>({jsonrpc:'2.0',id:a[i].id,result:z}):{jsonrpc:'2.0',id:a[0].id,result:r[0]})).catch(e=>cb(e))},send(p){if(typeof p==='string')return rpc(p,[]);if(Array.isArray(p))return Promise.all(p.map(x=>rpc(x.method,x.params||[])));return rpc(p.method,p.params||[])},on(e,f){if(!listeners.has(e))listeners.set(e,[]);listeners.get(e).push(f);return this},removeListener(e,f){listeners.set(e,(listeners.get(e)||[]).filter(x=>x!==f));return this}};window.dispatchEvent(new Event('ethereum#initialized'));})();`}

async function main(){
  console.log('\nUNICRED CLI MINER');
  console.log('GPU:',gpuInfo());
  console.log('Mode:',DRY_RUN?'DRY RUN':AUTO_SUBMIT?'AUTO-SUBMIT':'FIND ONLY');

  const cp=chromiumPath(); if(!cp)die('Chromium not found. Run ./install.sh');
  const pk=normalize(await getKey());
  const wallet=new ethers.Wallet(pk);
  const rpc=new ethers.JsonRpcProvider(RPC_URL,CHAIN_ID,{staticNetwork:true});
  const network=await rpc.getNetwork();
  if(Number(network.chainId)!==CHAIN_ID)die(`Wrong RPC chainId ${network.chainId}; expected ${CHAIN_ID}`);
  console.log('Wallet:',wallet.address);

  const context=await chromium.launchPersistentContext('',{
    executablePath:cp,
    headless:HEADLESS,
    args:['--headless=new','--no-sandbox','--disable-dev-shm-usage','--enable-gpu','--ignore-gpu-blocklist','--enable-unsafe-webgpu','--enable-features=Vulkan','--use-angle=vulkan','--window-size=1440,900'],
    viewport:{width:1440,height:900}
  });
  const page=await context.newPage();

  await context.exposeFunction('__unicred_rpc',async(method,params)=>{
    if(method==='eth_chainId')return CHAIN_HEX;
    if(method==='net_version')return String(CHAIN_ID);
    if(method==='eth_accounts'||method==='eth_requestAccounts')return [wallet.address];
    if(method==='eth_coinbase')return wallet.address;
    if(method==='wallet_switchEthereumChain'||method==='wallet_addEthereumChain')return null;
    if(method==='eth_getBalance')return '0x'+(await rpc.getBalance(params?.[0]||wallet.address,params?.[1]||'latest')).toString(16);
    if(method==='eth_blockNumber')return '0x'+(await rpc.getBlockNumber()).toString(16);
    if(method==='eth_getBlockByNumber'){const tag=params?.[0]||'latest';const b=await rpc.getBlock(tag==='latest'?'latest':Number(BigInt(tag)));return b?{number:'0x'+b.number.toString(16),hash:b.hash,timestamp:'0x'+b.timestamp.toString(16),parentHash:b.parentHash,nonce:b.nonce}:null}
    if(method==='eth_call'){const t=params[0]||{};return rpc.call({to:t.to,data:t.data,value:t.value,from:t.from},params[1]||'latest')}
    if(method==='eth_estimateGas'){const t=params[0]||{};return '0x'+(await rpc.estimateGas(t)).toString(16)}
    if(method==='eth_getTransactionCount')return '0x'+(await rpc.getTransactionCount(params?.[0]||wallet.address,params?.[1]||'latest')).toString(16);
    if(method==='eth_getCode')return rpc.getCode(params?.[0],params?.[1]||'latest');
    if(method==='eth_getTransactionByHash'||method==='eth_getTransactionReceipt'||method==='eth_feeHistory')return rpc.send(method,params||[]);
    if(method==='eth_gasPrice')return '0x'+(await rpc.getFeeData()).gasPrice.toString(16);
    if(method==='eth_maxPriorityFeePerGas')return '0x0';
    if(method==='personal_sign'){if(DRY_RUN)throw new Error('personal_sign disabled in dry-run');return wallet.signMessage(ethers.getBytes(params?.[0]||'0x'))}
    if(method==='eth_sign'){if(DRY_RUN)throw new Error('eth_sign disabled in dry-run');return wallet.signMessage(ethers.getBytes(params?.[1]||'0x'))}
    if(method==='eth_sendTransaction'){
      if(!AUTO_SUBMIT||DRY_RUN)throw new Error('Transaction blocked. Use --submit to enable.');
      const t={...(params?.[0]||{})};delete t.from;if(t.gas){t.gasLimit=BigInt(t.gas);delete t.gas}
      const sent=await wallet.sendTransaction(t);console.log('TX:',sent.hash);return sent.hash
    }
    if(method==='eth_sendRawTransaction'){
      if(!AUTO_SUBMIT||DRY_RUN)throw new Error('Raw transaction blocked. Use --submit to enable.');
      const sent=await rpc.send(method,params||[]);console.log('TX:',sent);return sent
    }
    if(method.startsWith('eth_')||method.startsWith('net_')||method.startsWith('web3_'))return rpc.send(method,params||[]);
    throw new Error(`Unsupported RPC method: ${method}`)
  });

  await page.addInitScript({content:providerScript()});
  page.on('console',m=>{const t=m.text();if(/hashrate|H\/s|GPU|error|mine|mint|wallet|unicorn|difficulty|target/i.test(t))console.log('[page]',t)});
  page.on('pageerror',e=>console.log('[pageerror]',e.message));
  await page.goto(SITE,{waitUntil:'domcontentloaded',timeout:120000});
  await page.waitForTimeout(4000);

  const connect=page.getByRole('button',{name:/connect wallet/i}).first();
  if(await connect.isVisible().catch(()=>false))await connect.click().catch(()=>{});
  await page.waitForTimeout(1500);

  const gpu=page.getByRole('button',{name:/^GPU$/i}).first();
  if(await gpu.isVisible().catch(()=>false))await gpu.click().catch(()=>{});
  const range=page.locator('input[type="range"]').first();
  if(await range.count())await range.fill(String(USAGE)).catch(()=>{});

  const start=page.getByRole('button',{name:/start mining/i}).first();
  if(!(await start.isVisible().catch(()=>false)))die('Start Mining button not found. Unicred UI/client changed; inspect current site and update adapter.');
  console.log('Starting mining...');
  await start.click();

  setInterval(async()=>{
    const t=await page.locator('body').innerText().catch(()=> '');
    const lines=t.split(/\n/).map(s=>s.trim()).filter(Boolean).filter(x=>/HASHRATE|H\/s|EXPECTED|STREAK|DIFFICULTY|GPU|CPU|LIVE RACE|WIN|MINT|TX|ERROR/i.test(x));
    if(lines.length)console.log(lines.slice(0,15).join(' | '));
  },15000);

  process.on('SIGINT',async()=>{await context.close();process.exit(0)});
  await new Promise(()=>{});
}

main().catch(e=>die(e.stack||e.message||String(e)));
