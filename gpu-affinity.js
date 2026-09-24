#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');

function execOutput(command, args, env = process.env) {
  const r = spawnSync(command, args, {
    encoding: 'utf8',
    env,
    maxBuffer: 32 * 1024 * 1024
  });
  return r.status === 0 ? r.stdout.trim() : '';
}

function cleanVulkanEnv(env = process.env) {
  const clean = {...env};
  delete clean.ENABLE_DEVICE_CHOOSER_LAYER;
  delete clean.VULKAN_DEVICE_INDEX;
  delete clean.DISABLE_DEVICE_CHOOSER_LAYER;
  delete clean.VK_ADD_LAYER_PATH;
  delete clean.UNICRED_VKDEVICECHOOSER;
  return clean;
}

function nvidiaGpus(env = process.env) {
  const out = execOutput('nvidia-smi', [
    '--query-gpu=index,name,pci.bus_id,uuid',
    '--format=csv,noheader'
  ], env);
  if (!out) return [];

  return out.split(/\r?\n/).filter(Boolean).map(line => {
    const [index, name, busId, uuid] = line.split(',').map(s => s.trim());
    return { index: Number(index), name, busId, uuid };
  });
}

function parseBusId(busId) {
  const m = String(busId || '').match(/^(?:0x)?([0-9a-fA-F]+):([0-9a-fA-F]{2}):([0-9a-fA-F]{2})\.([0-7])$/);
  if (!m) return null;
  return {
    domain: parseInt(m[1], 16),
    bus: parseInt(m[2], 16),
    device: parseInt(m[3], 16),
    func: Number(m[4])
  };
}

function parseVulkanDevices(env = process.env) {
  const out = execOutput('vulkaninfo', ['--summary'], env);
  if (!out) return [];

  const devices = [];
  const starts = [...out.matchAll(/^\s*GPU(\d+):\s*$/gm)];

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i].index;
    const end = i + 1 < starts.length ? starts[i + 1].index : out.length;
    const block = out.slice(start, end);

    const get = (key) => {
      const escaped = key.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
      const re = new RegExp('(?:^|\\n)\\s*' + escaped + '\\s*=\\s*([^\\n\\r]+)');
      const m = block.match(re);
      return m ? m[1].trim() : null;
    };

    devices.push({
      vulkanIndex: Number(starts[i][1]),
      name: get('deviceName'),
      vendorId: get('vendorID'),
      deviceId: get('deviceID'),
      uuid: get('deviceUUID')
    });
  }

  return devices.filter(d => d.name);
}

function getVulkanNvidiaDevices(env = process.env) {
  return parseVulkanDevices(env)
    .filter(d => /^0x10de$/i.test(String(d.vendorId || '')))
    .sort((a, b) => a.vulkanIndex - b.vulkanIndex);
}
function samePci(a, b) {
  return a && b &&
    Number(a.domain) === Number(b.domain) &&
    Number(a.bus) === Number(b.bus) &&
    Number(a.device) === Number(b.device) &&
    Number(a.func) === Number(b.func);
}

function getGpuMap(env = process.env) {
  const cleanEnv = cleanVulkanEnv(env);
  const ng = nvidiaGpus(cleanEnv);
  const vg = getVulkanNvidiaDevices(cleanEnv);

  return ng.map((n, i) => {
    const pci = parseBusId(n.busId);
    const match = vg[i] || null;
    return {
      ...n,
      pci,
      vulkanIndex: match ? match.vulkanIndex : null,
      vulkanName: match ? match.name : null,
      vulkanUuid: match ? match.uuid : null,
      mappingMethod: match ? 'vulkan-nvidia-order' : null
    };
  });
}

function resolveGpuSelection(nvidiaIndex) {
  const map = getGpuMap(process.env);
  const entry = map.find(g => g.index === Number(nvidiaIndex));
  if (!entry) {
    throw new Error('NVIDIA GPU index not found: ' + nvidiaIndex);
  }
  if (entry.vulkanIndex == null) {
    throw new Error(
      'Could not map NVIDIA GPU ' + nvidiaIndex +
      ' (' + entry.name + ', ' + entry.busId + ')' +
      ' to a Vulkan physical device. Run: vulkaninfo'
    );
  }

  return {
    ...entry,
    env: {
      ENABLE_DEVICE_CHOOSER_LAYER: '1',
      VULKAN_DEVICE_INDEX: String(entry.vulkanIndex),
      CUDA_VISIBLE_DEVICES: String(entry.index),
      VK_ADD_LAYER_PATH: '/opt/unicred-vkdevicechooser/share/vulkan/implicit_layer.d',
      LD_LIBRARY_PATH: '/opt/unicred-vkdevicechooser/lib/x86_64-linux-gnu:/opt/unicred-vkdevicechooser/lib:' + (process.env.LD_LIBRARY_PATH || '')
    }
  };
}

function selectedVulkanDevices(env) {
  const out = execOutput('vulkaninfo', ['--summary'], env);
  if (!out) return [];

  const devices = [];
  const re = /^\s*([^\n]+?)\s+\(ID:\s*(\d+)\)\s*$/gm;
  let m;
  while ((m = re.exec(out))) {
    devices.push({
      name: m[1].trim(),
      id: Number(m[2])
    });
  }

  if (devices.length) return devices;

  const alt = out.match(/deviceName\s*=\s*([^\n\r]+)/g) || [];
  return alt.map((line, i) => ({
    name: line.split('=').slice(1).join('=').trim(),
    id: i
  }));
}

module.exports = {
  nvidiaGpus,
  parseVulkanDevices,
  getGpuMap,
  resolveGpuSelection,
  selectedVulkanDevices,
  getVulkanNvidiaDevices
};
