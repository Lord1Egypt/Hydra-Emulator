'use strict';
/**
 * This is a medical checkup + auto configuration.
 *
 * Hydra Emulator can’t run when he’s done, depending on four things that have nothing to do with the software. ——
 *   1. Whether the CPU virtualization (VT-x / AMD-V) is open in BIOS;
 *   Windows' Virtual Machine Monitor Program Platform / Hyper-V is open (WHPX relies on it);
 *   3. The extent to which a card can be maintained (manufacturer, visible, driver version, whether or not it can be rendered with hardware);
 *   4. Memory / disk enough to open an Android virtual machine 2-8GB.
 *
 * These used to be "start failed user read the log guess yourself." Now, check it out and change it directly.
 * (Memory, Core, Paint, Render Backend, a button must be given (open function / load drive)),
 * You can only do that in the BIOS and make sure you press which key, and change it to what.
 *
 * Layer:
 *   - Collect() - only for detection (Windows used PowerShell last time to take all information), with a downgrade path;
 *   - evaluate() - pure function: translates the detection results into “Services + Proposed Configuration“, which is detectable separately;
 *   - Apply actions on main.js (save settings/ adjust existing lift interfaces), this module does not touch permissions.
 *
 * Attention.: **Do not pretend to be able to open BIOS virtualize for users**...that’s the only way to change it, and we’re just going to judge and guide it.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

// ------- detection------------------------------------------------------------------------------------------------------------------------------------

/**
 * Run a quick script (Windows’ powershell.exe), pick up JSON; failed/ overtime returns null.
 *
 * Start + 2 CIM queries 1 - 2 seconds,
 * The synchronous run will jam the main process (i.e. the entire interface), and the user will think that the program is dead by a "medical examination".
 */
function psJson(script, timeout = 15000) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const { execFile } = require('child_process');
      execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
      ], { encoding: 'utf8', windowsHide: true, timeout }, (err, stdout) => {
        if (err) { resolve(null); return; }
        const t = String(stdout || '').trim();
        if (!t) { resolve(null); return; }
        try { resolve(JSON.parse(t)); } catch (_) { resolve(null); }
      });
    } catch (_) {
      resolve(null);
    }
  });
}

const HW_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue";',
  '$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 Name,NumberOfCores,NumberOfLogicalProcessors,VirtualizationFirmwareEnabled,VMMonitorModeExtensions,SecondLevelAddressTranslationExtensions;',
  '$cs = Get-CimInstance Win32_ComputerSystem | Select-Object -First 1 HypervisorPresent,TotalPhysicalMemory;',
  '$gpu = @(Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,DriverDate,AdapterRAM,VideoProcessor,Status);',
  // AdapterRAM will be cut to 4294967295 at > 4GB; the true value is in the registration form qwMemorySize (one thousand N sub-key per adaptor))
  '$vram = 0;',
  'Get-ChildItem "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}" -ErrorAction SilentlyContinue | ForEach-Object {',
  '  $v = (Get-ItemProperty $_.PSPath -Name "HardwareInformation.qwMemorySize" -ErrorAction SilentlyContinue)."HardwareInformation.qwMemorySize";',
  '  if ($v -and $v -gt $vram) { $vram = $v }',
  '};',
  '[pscustomobject]@{ cpu = $cpu; cs = $cs; gpu = $gpu; vram = $vram } | ConvertTo-Json -Depth 6 -Compress',
].join(' ');

const FEATURE_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue";',
  '$o = [ordered]@{};',
  'foreach ($n in @("HypervisorPlatform","VirtualMachinePlatform","Microsoft-Hyper-V-All")) {',
  '  try { $o[$n] = (Get-WindowsOptionalFeature -Online -FeatureName $n -ErrorAction Stop).State } catch { $o[$n] = "unknown" }',
  '}',
  '$o | ConvertTo-Json -Compress',
].join(' ');

/** API library / AEHD driver / virtual platform service to determine file existence (detecting HPX)) */
function fileExists(rel) {
  try {
    return fs.existsSync(path.join(process.env.SystemRoot || 'C:\\Windows', rel));
  } catch (_) {
    return false;
  }
}

function dateToISO(v) {
  if (!v) return '';
  // PowerShell’s DateTime → `/Date(1700000000000)/` Or ISO string
  const m = /\/Date\((\d+)\)\//.exec(String(v));
  if (m) {
    try { return new Date(Number(m[1])).toISOString().slice(0, 10); } catch (_) { return ''; }
  }
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}

/**
 * Detection hardware and virtualization.
 *
 * Any undetectable returns null/0, **Never let a failure of detection drag the caller down.**:
 * The missing is "unknown," and the medical examination says "not readable," instead of making a conclusion.
 *
 * @param{object} o {accel} enter by provisioner. emulatorAccel() to avoid pulling up emulator
 * @returns {object} hw
 */
async function collect({ accel = null } = {}) {
  const [raw, feats] = process.platform === 'win32'
    ? await Promise.all([psJson(HW_SCRIPT), psJson(FEATURE_SCRIPT)])
    : [null, null];
  const cpu = (raw && raw.cpu) || {};
  const cs = (raw && raw.cs) || {};
  const gpus = Array.isArray(raw && raw.gpu) ? raw.gpu : (raw && raw.gpu ? [raw.gpu] : []);

  // Select "Main Screen": Priority is not Microsoft Basic Display / Non-virtual display adapter
  const usable = gpus.filter((g) => g && g.Name && !/microsoft basic|remote display|virtual display/i.test(g.Name));
  const gpu = (usable[0] || gpus[0]) || {};
  const name = String(gpu.Name || '');
  let vendor = 'unknown';
  if (/nvidia|geforce|rtx\s|gtx\s|quadro/i.test(name)) vendor = 'nvidia';
  else if (/(?<!virtual\s)(amd|radeon|rx\s\d)/i.test(name)) vendor = 'amd';
  else if (/intel|uhd\s|iris|arc\s/i.test(name)) vendor = 'intel';

  const ramBytes = Number(gpu.AdapterRAM) || 0;
  const qw = Number((raw && raw.vram) || 0);
  // Adapterram is 32 bits unsigned, >4GB will become 4095MB, and this value is not credible
  const vramMB = Math.round((qw > 0 ? qw : (ramBytes > 0 && ramBytes < 4096 * 1024 * 1024 ? ramBytes : 0)) / 1048576);

  const hypervisor = cs.HypervisorPresent === true;
  const accelOk = !!(accel && accel.ok);
  /**
   * Watch out for the WMI pits in both fields.):
   * Hyper-V/ VBS once VT is taken over, `VMMonitorModeExtensions` with
   * `SecondLevelAddressTranslationExtensions` Fallse returns -- but the machine can speed up the hardware.
   * So "False" can only be considered "unsupported" if it’s "no Hypervisor, no speed.",
   * If you don’t, you'll always be "unknown," and don’t misconstrue the machine that can be used to avoid virtualization.
   */
  const vmExt = cpu.VMMonitorModeExtensions;
  const slatRaw = cpu.SecondLevelAddressTranslationExtensions;
  let vtSupported = true;
  if (vmExt === false && !hypervisor && !accelOk) vtSupported = false;
  else if (vmExt !== true) vtSupported = 'unknown';
  const slat = slatRaw === true ? true : (slatRaw === false && !hypervisor && !accelOk ? false : 'unknown');
  // BIOS Side: Similarly, the Hypervisor field may not be trusted while running.
  let vtFirmware = null;
  if (cpu.VirtualizationFirmwareEnabled === true) vtFirmware = true;
  else if (cpu.VirtualizationFirmwareEnabled === false && !hypervisor && !accelOk) vtFirmware = false;
  const winHv = fileExists('System32\\WinHvPlatform.dll');
  const vmCompute = fileExists('System32\\vmcompute.exe');
  const aehd = fileExists('System32\\drivers\\aehd.sys');

  const state = (k) => {
    const v = feats && feats[k];
    return v ? String(v).toLowerCase() : 'unknown';
  };

  return {
    platform: process.platform,
    arch: process.arch,
    osBuild: (() => {
      const m = /(\d+)\s*$/.exec(os.release() || '');
      return m ? Number(m[1]) : 0;
    })(),
    cpu: {
      name: String(cpu.Name || '').trim(),
      cores: Number(cpu.NumberOfCores) || 0,
      threads: Number(cpu.NumberOfLogicalProcessors) || 0,
      vtSupported,
      vtFirmware,
      slat,
    },
    memory: {
      totalMB: Math.round((Number(cs.TotalPhysicalMemory) || os.totalmem()) / 1048576),
      freeMB: Math.round(os.freemem() / 1048576),
    },
    gpu: {
      name,
      vendor,
      vramMB,
      driverVersion: String(gpu.DriverVersion || ''),
      driverDate: dateToISO(gpu.DriverDate),
      status: String(gpu.Status || ''),
    },
    virtualization: {
      hypervisorPresent: hypervisor,
      hypervisorPlatform: state('HypervisorPlatform'),
      vmPlatform: state('VirtualMachinePlatform'),
      hyperV: state('Microsoft-Hyper-V-All'),
      winHvApi: winHv,
      vmCompute,
      aehdInstalled: aehd,
      accelOk,
      accelKind: accel && accel.ok ? String(accel.kind || 'whpx') : 'none',
    },
  };
}

// - - - - Evaluation (purely function) - - -

/** Hardware recommendation: Memory / Core / Painting. Rules are conservative, prefer to be less expensive. */
function recommendResources({ totalMB = 0, cores = 0, accelOk = false, vramMB = 0 } = {}) {
  const mem = Number(totalMB) || 0;
  const n = Number(cores) || 1;
  // The virtual machine eats up to half of the host and leaves one for Windows; it’s again in absolute areas.
  let memoryMB = 2048;
  if (mem >= 32768) memoryMB = 8192;
  else if (mem >= 16384) memoryMB = 6144;
  else if (mem >= 12288) memoryMB = 4096;
  else if (mem >= 8192) memoryMB = 3072;
  else memoryMB = 2048;
  if (mem && memoryMB > Math.floor(mem * 0.5 / 512) * 512) {
    memoryMB = Math.max(2048, Math.floor(mem * 0.5 / 512) * 512);
  }
  const wantCores = n >= 8 ? 4 : n >= 4 ? Math.max(2, n - 2) : 2;
  const c = Math.max(1, Math.min(wantCores, n - 1));
  // Software simulation + small memory: resolution down to 540p, frame rate preferred (only 56% of the image area))
  const renderSize = (!accelOk || (vramMB > 0 && vramMB < 512)) ? '540x960' : 'auto';
  return { memoryMB, cores: c, renderSize };
}

/** Rendering backend advice: By Vendor + Accelerator + To a "try this first" slot */
function recommendGpu({ vendor = 'unknown', accelOk = false, vramMB = 0 } = {}) {
  if (!accelOk) return { gpuMode: 'software', why: 'Software rendering will be used because hardware acceleration is unavailable' };
  if (vendor === 'unknown') return { gpuMode: 'auto', why: 'I can\’t read the video card. I\’ll give it to the automatic downlink chain.' };
  if (!vramMB || vramMB < 512) return { gpuMode: 'swangle', why: 'Very small (or unread), more steady with swangle' };
  if (vendor === 'nvidia') return { gpuMode: 'host', why: 'NVIDIA drives mature, host directly usually fastest' };
  if (vendor === 'amd') return { gpuMode: 'swangle', why: 'AMD nuclear/old-drive host may fall, swangle more steady' };
  if (vendor === 'intel') return { gpuMode: 'swangle', why: 'Intel Nuclear vs. GLES support variance, swangle' };
  return { gpuMode: 'auto', why: 'I can\’t read the video card. I\’ll give it to the automatic downlink chain.' };
}

/**
 * Translating detection results into medical reports.
 *
 * @param {object} o { hw, settings, edition } edition: 'store' | 'installer'
 * @returns {{ level:string, items:Array, patch:object|null, driver:object|null, summary:string }}
 */
function evaluate({ hw = {}, settings = {}, edition = 'installer' } = {}) {
  const v = hw.virtualization || {};
  const cpu = hw.cpu || {};
  const gpu = hw.gpu || {};
  const mem = hw.memory || {};
  const items = [];

  const add = (item) => items.push(item);

  // - 1. CPU Virtualization (BIOS) -
  if (cpu.vtSupported === false) {
    add({
      key: 'vt-unsupported',
      level: 'bad',
      title: 'This CPU doesn\'t support hardware virtualization.',
      detail: 'You can only run software simulations, which are 5-10 times slow. Light applications work, big games don’t recommend.',
      action: null,
    });
  } else if (cpu.vtFirmware === false) {
    add({
      key: 'vt-bios-off',
      level: 'bad',
      title: 'CPU virtualization is not on the BIOS.',
      detail: 'Reboot BIOS/UEFI, set Intel VT-x (Intel) or SVM Mode (AMD) as Enabled, save it and return for re-examination.'
        + 'In the case of Advanced – CPU Confuture, the branding machine may be called Virtualization Technology.',
      action: { kind: 'manual', id: 'bios', label: 'Reboot BIOS required, cannot be done automatically' },
    });
  } else if (cpu.vtFirmware === true) {
    add({
      key: 'vt-ok',
      level: 'ok',
      title: 'CPU virtualization has been started in BIOS',
      detail: cpu.name ? `${cpu.name} · ${cpu.cores || '?'} Nuclear / ${cpu.threads || '?'} Thread` : '',
      action: null,
    });
  } else {
    add({
      key: 'vt-unknown',
      level: 'warn',
      title: 'Can not get folder: %s: %s',
      detail: 'May be the master board/limitation. If no hardware acceleration is suggested at startup, please manually enter BIOS to confirm that VT-x/ SVM is active.',
      action: { kind: 'manual', id: 'bios', label: 'Manual confirmation' },
    });
  }

  // - 2. Windows Side: WFPX / Hyper-V -
  const hp = String(v.hypervisorPlatform || 'unknown');
  const hpxOn = hp === 'enabled' || (hp === 'unknown' && v.winHvApi && v.hypervisorPresent);
  if (hpxOn) {
    add({
      key: 'whpx-ok',
      level: 'ok',
      title: 'Windows Virtual Machine Monitor Program platform is enabled',
      detail: v.hypervisorPresent
        ? 'Hypervisor running, WHPX available.'
        : 'The function is enabled; if the acceleration is not available, restart to get Hypervisor up.',
      action: null,
    });
  } else if (edition === 'store') {
    add({
      key: 'whpx-off',
      level: 'bad',
      title: 'Virtual machine monitor program platform not enabled',
      detail: 'Shop layouts cannot be modified on their own. Press Win+R ~ Enter Openfeatures ~ Tick “Windows Virtual Machine Monitor Program Platform“'
        + '(HypervisorPlatform and Virtual Machine Platform confirmed → restart.',
      action: { kind: 'elevate', id: 'virtualization', label: 'Open Windows Features' },
    });
  } else {
    add({
      key: 'whpx-off',
      level: 'bad',
      title: 'Virtual machine monitor program platform not enabled',
      detail: 'The button below the point will automatically turn on HydrovisorPlatform + VirtualMachinePlatform (required by administrator) and restart the computer after completion.',
      action: { kind: 'elevate', id: 'virtualization', label: 'Enable (administrator required)' },
    });
  }

  // - 3. Is hardware acceleration currently really available -
  if (v.accelOk) {
    add({
      key: 'accel-ok',
      level: 'ok',
      title: `Hardware acceleration available(${v.accelKind === 'aehd' ? 'AEHD' : 'WHPX'})`,
      detail: 'The start-up will speed up the hardware; the following configuration is recommended on the machine\'s visible card and memory.',
      action: null,
    });
  } else {
    add({
      key: 'accel-off',
      level: 'warn',
      title: 'Hardware acceleration unavailable',
      detail: edition === 'installer' && v.vtFirmware !== false
        ? 'It can be installed as an AEHD driver (a manager is required), or restarted after opening the Virtual Machine Monitor Program platform; neither can be used only for software simulations.'
        : 'It’s a software simulation to make it run; it’s 5-10 times faster than hardware.',
      action: edition === 'installer' && v.vtFirmware !== false
        ? { kind: 'elevate', id: 'accel', label: 'Install AEHD driver (required administrator))' }
        : null,
    });
  }

  // - 4. Visible cards -
  if (!gpu.name) {
    add({
      key: 'gpu-unknown',
      level: 'warn',
      title: 'Can not open message',
      detail: 'Could be a remote desktop / virtual machine / driver anomaly. Rendering backend to automatic downlink.',
      action: null,
    });
  } else {
    const integrated = /radeon\s+(graphics|vega)|uhd|iris|hd\s+graphics|vega/i.test(gpu.name);
    const vram = gpu.vramMB
      ? `${(gpu.vramMB / 1024).toFixed(1)} Gbs visible ${integrated ? '(NUMB, the rest of the shares)' : ''}`
      : 'Visible Unknown';
    add({
      key: 'gpu-info',
      level: 'ok',
      title: `${gpu.name}`,
      detail: `${vram}${gpu.driverVersion ? ` · Driver ${gpu.driverVersion}` : ''}${gpu.driverDate ? `(${gpu.driverDate})` : ''}`,
      action: null,
    });
    const old = /^(19|20)\d{2}-\d{2}-\d{2}$/.test(gpu.driverDate || '')
      ? (Date.now() - new Date(gpu.driverDate).getTime()) / 31536000000 : 0;
    if (old > 3) {
      add({
        key: 'gpu-driver-old',
        level: 'warn',
        title: 'The card drive is older.',
        detail: `Driver Date ${gpu.driverDate}(- I’m sorry. ${Math.floor(old)} The old drive was the common reason for the "Black/ Flower Screen Up" and suggested to go to the factory office to update it.`,
        action: null,
      });
    }
  }

  // -5. Memory / Disk / System Version -
  const total = Number(mem.totalMB) || 0;
  if (!total) {
    add({ key: 'mem-unknown', level: 'warn', title: 'Could not read physical memory', detail: '', action: null });
  } else if (total < 6144) {
    add({
      key: 'mem-low',
      level: 'warn',
      title: `Small Memory(${(total / 1024).toFixed(1)} GB)`,
      detail: 'Android’s virtual machine has a maximum of 2 GB, 2 nucleics, and it’s reduced to 540 x 960, and it’s recommended that the browser tabs be turned off and then applied.',
      action: null,
    });
  } else {
    add({
      key: 'mem-ok',
      level: 'ok',
      title: `Physical Memory ${(total / 1024).toFixed(0)} GB`,
      detail: '',
      action: null,
    });
  }

  const build = Number(hw.osBuild) || 0;
  if (build && build < 19041) {
    add({
      key: 'os-old',
      level: 'warn',
      title: `Windows version older (build) ${build})`,
      detail: 'Hydra Emulator minimum support Windows 10 2004 (buld 19041). Emulator may be out of the old system.',
      action: null,
    });
  }

  // - Proposed configuration -
  const rec = recommendResources({ totalMB: total, cores: cpu.threads || cpu.cores, accelOk: !!v.accelOk, vramMB: gpu.vramMB });
  const gpuRec = recommendGpu({ vendor: gpu.vendor, accelOk: !!v.accelOk, vramMB: gpu.vramMB });
  const patch = {
    engine: {
      autoMemory: false,
      memoryMB: rec.memoryMB,
      cores: rec.cores,
      renderSize: rec.renderSize,
      // Accelerating is not available → directly locking software simulations, saving two rounds of white etc.; return auto to work on the downlink chain
      gpuMode: v.accelOk ? 'auto' : 'software',
      forceTcg: !v.accelOk,
    },
  };

  // To create a driver for this machine: each time you turn on it, you don't have to repeat the checkup.
  const vendor = gpu.vendor && gpu.vendor !== 'unknown' ? gpu.vendor : 'unknown';
  const driver = {
    format: 'hydra-driver/1',
    id: `auto-${vendor}-${build || 'x'}`.toLowerCase().replace(/[^a-z0-9._-]/g, '-'),
    name: `Autoconfig(${gpu.name || vendor})`,
    version: '1.0.0',
    author: 'Hydra Emulator, medical examination.',
    description: `Generated by "auto-configuration": ${gpuRec.why}.${v.accelOk ? 'Hardware acceleration available.' : 'There’s no hardware acceleration at the moment.'}`,
    priority: 5,
    match: {
      platform: [hw.platform || process.platform],
      arch: [hw.arch || process.arch],
      ...(vendor !== 'unknown' ? { gpuVendor: [vendor] } : {}),
      ...(build ? { osBuild: { min: build - 2000, max: build + 2000 } } : {}),
    },
    effect: {
      gpuMode: gpuRec.gpuMode,
      ...(v.accelOk ? {} : { forceTcg: true }),
      notes: [gpuRec.why],
    },
  };

  const bad = items.filter((i) => i.level === 'bad').length;
  const warn = items.filter((i) => i.level === 'warn').length;
  const level = bad ? 'bad' : warn ? 'warn' : 'good';
  const summary = bad
    ? `Found ${bad} We have to deal with this first.(${items.filter((i) => i.level === 'bad').map((i) => i.title).join(', ')})`
    : warn
      ? `Yeah. ${warn} Recommendation optimization(${items.filter((i) => i.level === 'warn').map((i) => i.title).join(', ')})`
      : 'This machine can run the hardware faster, and it\'s already the best configuration.';

  return {
    level,
    items,
    patch,
    driver,
    recommended: { ...rec, ...gpuRec },
    summary,
  };
}

module.exports = {
  collect,
  evaluate,
  recommendResources,
  recommendGpu,
  psJson,
};
