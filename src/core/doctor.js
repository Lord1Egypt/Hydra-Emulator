'use strict';
/**
 * Device adaptable / Autodiagnostic (zero configuration base))
 *
 * Target: no user is required to adjust any parameters on different machines.
 *  - ChooseProfile() based on physical memory, CPU, disk, acceleration state, emulator version decomposing startup parameters;
 *  - PlanVariants() to give a re-test "downgraded after start-up failure" (GPU → acceleration memory cold start);
 *  - diagnose() translates emulator ’s English stderr into implementable restoration recommendations;
 *  - ShortPath() Process Chinese/ Space Installing Path (QEMU is extremely sensitive to non-ASCII Paths).
 *
 * This module is pure function + read-only detection, no writing settings, no pulling up Android, easy to detect.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { memoryLimits } = require('./resources');

const ASCII = /^[\x20-\x7e]*$/;
const isAsciiPath = (p) => ASCII.test(String(p || ''));

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

/** Image of the machine (msec, read-only)) */
function hostInfo() {
  const totalMB = Math.round(os.totalmem() / 1048576);
  const freeMB = Math.round(os.freemem() / 1048576);
  const cores = Math.max(1, (os.cpus() || []).length || 2);
  const home = os.homedir();
  return {
    platform: process.platform,
    arch: process.arch,
    totalMB,
    freeMB,
    cores,
    home,
    homeAscii: isAsciiPath(home),
    tmp: os.tmpdir(),
    rdp: /RDP/i.test(String(process.env.SESSIONNAME || '')) || !!process.env.CLIENTNAME,
  };
}

/** Discable space (MB) for the directory; no return 0 can be retrieved */
function freeDiskMB(dir) {
  try {
    let d = path.resolve(dir || '.');
    for (let i = 0; i < 6 && !fs.existsSync(d); i += 1) d = path.dirname(d);
    const st = fs.statfsSync(d);
    return Math.floor((st.bavail * st.bsize) / 1048576);
  } catch (_) {
    return 0;
  }
}

function versionNumbers(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

/**
 * Test GPU manufacturers (NVIDIA / AMD / Intel) to adjust the rendering backend priority.
 * Only on Windows; other platforms return 'unknown'.
 * The result is a cache of 10 minutes, avoiding every ChooseProfile spawn wmic.
 */
let _gpuVendorCache = { vendor: 'unknown', at: 0 };
function detectGpuVendor() {
  if (process.platform !== 'win32') return 'unknown';
  if (Date.now() - _gpuVendorCache.at < 600000) return _gpuVendorCache.vendor;
  try {
    const { execFileSync } = require('child_process');
    // wmic on Win11 24H2+ has been removed and changed to PowerShell Get-CimInstance
    let names = '';
    try {
      names = execFileSync('powershell.exe', [
        '-NoProfile', '-Command',
        '(Get-CimInstance Win32_VideoController).Name -join "|"',
      ], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    } catch (_) {
      // Back to wmic (old system still available))
      try {
        names = execFileSync('wmic', ['path', 'win32_videocontroller', 'get', 'name', '/format:list'],
          { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      } catch (__) { /* ignore */ }
    }
    const lower = String(names).toLowerCase();
    let vendor = 'unknown';
    // Priority matches NVIDIA/AMD, virtual display adapter in the back
    if (/nvidia|geforce|rtx\s|gtx\s/.test(lower)) vendor = 'nvidia';
    else if (/(?<!virtual\s)(amd|radeon|rx\s\d)/.test(lower)) vendor = 'amd';
    else if (/intel|uhd\s|iris|arc\s/.test(lower)) vendor = 'intel';
    _gpuVendorCache = { vendor, at: Date.now() };
    return vendor;
  } catch (_) {
    _gpuVendorCache = { vendor: 'unknown', at: Date.now() };
    return 'unknown';
  }
}

/**
 * Emulator 36.4.9 Mark the swiftshader_indirect as discarded, and add -gpu software.
 * 37.x Uploading swiftshader_indirect will result in GL initialization failure/direct exit (equipment varies significantly).
 * So we have to pick out candidates by version, and each candidate has a way out.
 *
 * Use GPU vendor fine-tuning priority:
 *   NVIDIA: host is almost always the best (drive maturity), swangle
 *   AMD: host will collapse (especially old) with partial drive, swangle refers to second priority
 *   Intel: host is usually OK, but when the concentration is weak, swangle is more stable
 *   unknown: Keep default order
 */
function gpuCandidates(emulatorVersion) {
  const [major, minor, patch] = versionNumbers(emulatorVersion);
  const modern = major > 36 || (major === 36 && (minor > 4 || (minor === 4 && patch >= 9)));
  const base = modern
    ? ['host', 'swangle', 'software', 'swiftshader']
    : ['host', 'swiftshader_indirect', 'swiftshader'];
  const vendor = detectGpuVendor();
  if (vendor === 'amd' && modern) {
    // The AMD driver in some versions has failed to initialize GL, bringing swangle up front
    return ['swangle', 'host', 'software', 'swiftshader'];
  }
  return base;
}

/** Windows 8.3 Short Path: Emulator will not find a file when Chinese username / Chinese install directory */
/**
 * Screen Specification. Landscape=true gives a real cross-screen panel (1280x720).
 *
 * Why must the panel be resized instead of running when wm size: LCD of the emulator is "Physics Panel".,
 * Qt Opens a window in panel size and pastes the image to the top left corner. Wm size changes only to Android’s.
 * Logical resolution, the physical panel is still vertical -- and it turns out the image is 90 degrees, just one top left corner.,
 * Big black edges around, clicking coordinates. Only hw.lcd.width/height is really replaced with a screen and reboot.,
 * Choose defaults based on the host hardware.
 */
function lcdFor({ accelOk = true, crisp = true, landscape = false } = {}) {
  const base = accelOk && crisp ? { w: 720, h: 1280, dpi: 320 } : { w: 540, h: 960, dpi: 240 };
  return landscape ? { w: base.h, h: base.w, dpi: base.dpi } : base;
}

function shortPath(p) {
  if (process.platform !== 'win32' || !p || isAsciiPath(p)) return p;
  try {
    const out = execFileSync('cmd.exe', ['/d', '/s', '/c', `for %I in ("${p}") do @echo %~sI`], {
      encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
    if (line && isAsciiPath(line) && fs.existsSync(line)) return line;
  } catch (_) { /* 8.3 Maintain the same path when closed */ }
  return p;
}

/**
 * Deduce zero configuration startup parameters.
 * If the user settings are displayed to engine.moryMB/ cores/ gpuMode, the cap/ overwrite,
 * But no more 4G/4 cores for "no settings" hard coded down the little memory machine.
 */
/**
 * "Light packaging" quota: only the number of vCPUs that most affect the host sense.
 *
 * The old logic gives 16 nuclear machines 4 nuclear, 4 vCPU threads in qemu to fill the physical core for a long time,
 * Windows desktop, mouse, browser only takes the rest of the time clips, which is shown as "cards as soon as opened."
 * The actual Android App 2 vCPUs are more than enough to slow down the mainframe.
 *
 * Memory, resolution deliberately: RAM caps are 2-3G, and drop resolution allows Quickboot
 * The flash print changes, every cut starts cold again, it's worth it.
 *
 * Pure function, returns null when settings are null (stay the old caller/single behaviour unchanged).
 */
function liteProfile({ host = hostInfo(), engine = {} } = {}) {
  if (engine && engine.liteMode === false) return null;
  const cores = engine && engine.resourceMode === 'save'
    ? 2
    // The old logic is: floor, then 2~3 --8 nuclear machines for only 2 vCPUs, software decoded videos.
    // (For red nuts/twisps like this read direct slides. Replace "50 Physics Nuclear, Maximum 4":
    // 8 for 4, 4 for 2, and the desktop still has a leftover core, and the video is enough.
    : clamp(Math.floor((host.cores || 2) / 2), 2, 4);
  return { cores, priority: 'below' };
}

function chooseProfile({
  host = hostInfo(), accel, emulatorVersion = '', diskMB = 0,
  port = 5554, adbPort = 5044, overrides = {}, settings = null,
} = {}) {
  const accelOk = !!(accel && accel.ok);
  // 3GB sufficient Android 14 with mainstream application; further heights only magnify memory occupancy and quick-scaling volume
  let memoryMB = clamp(Math.floor((host.totalMB * 0.22) / 256) * 256, 2048, 3072);
  // "Provincial Resources" mode: brushing videos/studies without a 3G light load, pressing the ceiling to 2G.
  // The direct effect is qemu’s permanent memory is about 1 GB, Quickboot, and the snapshot is also about 1 GB.
  // Only when the user does not specify the memory manually, the manual value is always given priority.
  const rmode = settings && settings.engine && settings.engine.resourceMode;
  if (rmode === 'save' && !overrides.memoryMB) {
    memoryMB = clamp(memoryMB, 2048, 2048);
  }
  // When physical memory is not enough; Android 14 lowest 2G, below this is only a TCG jog
  if (host.freeMB && host.freeMB < memoryMB + 1024) {
    memoryMB = Math.max(2048, Math.floor((host.freeMB * 0.5) / 256) * 256);
  }
  if (overrides.memoryMB) {
    // The upper limit follows the host: 8192 was written dead earlier, and the 32 GB machine has a maximum of 8 GB.,
    // The big game (especially with a high-resolution resource kit) is often retraced, in the form of Carton/Blackscreen.
    const lim = memoryLimits(host.totalMB);
    memoryMB = clamp(Number(overrides.memoryMB) || memoryMB, 1536, lim.maxMB);
  }

  let cores = clamp(Math.floor(host.cores / 2), 2, 4);
  if (overrides.cores) {
    // Also follow host: leave at least 1 for Windows, and the single-nuclear machine still has 1 nuclear.
    const maxCores = Math.max(1, (host.cores || 1) - 1);
    cores = clamp(Number(overrides.cores) || cores, 1, maxCores);
  }
  // The user will not be able to absorb the number of nucles manually, but only in light mode. Manual values will always be given priority.
  const lite = settings ? liteProfile({ host, engine: settings.engine || {} }) : null;
  if (lite && !overrides.cores) cores = Math.min(cores, lite.cores);

  const disk = diskMB || freeDiskMB(host.tmp);
  // /Data capacity: Apply the body, game resource packs and their "updating packages" all take up here, 4GBs too easily
  // (This is shown by the application of the in-depth update to the "insufficiency of disk space". By default, 6/8GB by disk balance.,
  // Users can also specify directly in the settings (the next time they start the system, no data will be lost).
  const wantGB = Number((settings && settings.engine && settings.engine.dataPartitionGB) || 0);
  // Automatic values also go with disk balances: 50 GB game unpackage close to 90 GB, with the remaining large machines starting with 16 GB,
  // So that the first big game can be filled and we can call it "space shortage."
  const autoDataMB = disk && disk < 12288 ? 4096 : (disk && disk > 262144 ? 16384 : 6144);
  // The user specifies the "80% of the disk on which it is located" top: fills in 128 GB but only 20 GB in the disk, only half of it fails.
  const dataMaxMB = disk ? Math.max(2048, Math.floor((disk * 0.8) / 1024) * 1024) : 262144;
  const dataMB = wantGB > 0
    ? clamp(Math.round(wantGB * 1024), 2048, Math.min(262144, dataMaxMB))
    : autoDataMB;

  const gpus = gpuCandidates(emulatorVersion);
  const gpu = overrides.gpuMode && gpus.includes(overrides.gpuMode) ? overrides.gpuMode : gpus[0];

  // Render resolution: select at accelerator status at autu (software simulation down to 540x960 smooth flow)
  // Crossscreen priority: The screen is determined by the "physical panel size" and must be written into AVD and restarted to be effective,
  // So we're going to set directions. Display.
  const wantLandscape = !!(settings && settings.display && settings.display.landscape);
  const wantLcd = String((settings && settings.engine && settings.engine.renderSize) || 'auto');
  const lcd = /^\d{3,4}x\d{3,4}$/.test(wantLcd)
    ? (() => {
      const [w0, h0] = wantLcd.split('x').map(Number);
      // If the user's resolution is not in line with the current direction, correct it by direction (panel wide side))
      const long = Math.max(w0, h0);
      const short = Math.min(w0, h0);
      const w = wantLandscape ? long : short;
      const h = wantLandscape ? short : long;
      return { w, h, dpi: short <= 540 ? 240 : (short <= 720 ? 320 : 420) };
    })()
    : lcdFor({ accelOk, landscape: wantLandscape });

  return {
    memoryMB,
    cores,
    heapMB: memoryMB >= 3072 ? 384 : 256,
    dataMB,
    lcd,
    gpu,
    gpuCandidates: gpus,
    accel: accelOk ? 'auto' : 'off',
    accelOk,
    port,
    adbPort,
    snapshot: true,
    lite: !!lite,
    // Pure software simulations without acceleration do rise on Windows, but Android 14 cold start could be 5-10 minutes
    bootTimeoutMs: accelOk ? 240000 : 600000,
    emulatorVersion,
    host,
  };
}

/**
 * Convert user settings in Advanced Parameters into overrides.
 * 0 / auto / Unset is always considered as "no overwrite" and still automatically leads;
 * Only the user can turn off the automatic memory and fill out a specific value.
 */
function overridesFromSettings(engine = {}) {
  const e = engine || {};
  const manual = e.autoMemory === false;
  return {
    memoryMB: manual ? Number(e.memoryMB) || 0 : 0,
    cores: manual ? Number(e.cores) || 0 : 0,
    gpuMode: e.gpuMode && e.gpuMode !== 'auto' ? e.gpuMode : '',
  };
}

/**
 * A uniform entry for display/ diagnosis: The Android can also calculate parameters that match the actual switch without starting.
 * Preset chooseProfile() (without version and acceleration status) on the 37.x machine
 * Wrong display of abandoned swiftshader_indirect/ software simulations, not match with the running parameters.
 */
function autoProfile({ settings = {}, accel, emulatorVersion = '', diskMB = 0, port = 5554, adbPort = 5044, host = null } = {}) {
  return chooseProfile({
    // Host can inject: single measurements/diagnostics to recreate "4 nuclear mini-machines" do not really change machines.
    // If you don’t, it’s based on the actual situation.
    host: host || hostInfo(),
    accel, emulatorVersion, diskMB, port, adbPort, settings,
    overrides: overridesFromSettings(settings && settings.engine),
  });
}

/**
 * Failed to retry the matrix: from Best to Most Conservative, up to four times.
 * Change GPU backend → Close hardware acceleration Drop memory and force cold to start a snapshot.
 */
function planVariants(profile) {
  const out = [];
  const gpus = profile.gpuCandidates || [];
  const firstGpu = profile.gpu || gpus[0] || 'software';
  const safeGpu = gpus.find((g) => /software|swiftshader/.test(g)) || firstGpu;
  const ordered = [firstGpu, ...gpus.filter((g) => g !== firstGpu && /swiftshader|swangle/.test(g))].slice(0, 2);
  for (const gpu of ordered) {
    out.push({ ...profile, gpu, label: `${gpu} / ${profile.accel === 'auto' ? 'hardware acceleration' : 'Software emulation'}`, wipe: false, snapshot: true });
  }
  out.push({
    ...profile,
    gpu: safeGpu,
    accel: 'off',
    label: 'Turn off accelerated software simulations (slow, but compatibility is best))',
    wipe: false,
    snapshot: false,
  });
  out.push({
    ...profile,
    gpu: safeGpu,
    accel: 'off',
    memoryMB: 2048,
    cores: 2,
    dataMB: Math.min(profile.dataMB, 2048),
    label: 'Conservative cold start (minimum memory + clean snapshot))',
    //  Here.**Absolutely not.** wipe: It used to be wipe:true, and every attempt on a disk full of it will fail.,
    // So you re-try the user’s installed applications and file together with "Caseshot + Clear Data" ——
    // "The disk’s full, and it’s open to Hydra Emulator." That’s how it happened.
    // Rebuild userdata when it needs to be judged by the insureDataPartion itself (it only recreates when mirrors are damaged)),
    // -wipe-data.
    wipe: false,
    snapshot: false,
    lastResort: true,
  });
  // Deweight (same gpu/ acceel/wipe combination does not repeat) - but the last one must be retained:
  // It's the only "no snapshot" solution, and the little memory machine may be exactly the same as the previous parameter.
  const seen = new Set();
  return out.filter((v) => {
    const k = `${v.gpu}|${v.accel}|${!!v.wipe}|${v.memoryMB}|${v.snapshot !== false ? 'snap' : 'nosnap'}|${v.lastResort ? 'last' : ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Check an empty port (emulator console + adb registered port must be adjacent even/ odd)) */
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function freePortPair(start = 5554) {
  for (let p = start; p <= start + 40; p += 2) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(p) && await isPortFree(p + 1)) return p;
  }
  return start;
}

/**
 * Port adbserver: Fixed no-reuse detection.
 * It used to be, "Look up at an empty port from 5044," but the adb server itself was a permanent process, holding the port.,
 * So every time you start Hydra Emulator, you get one more adb server.),
 * And the port’s always changing, and the next time you start trying to take over the simulator, it doesn’t match the number.
 * 5044 is a special Hydra Emulator port (user 's own adb at 5037), directly fixed.
 */
async function freeAdbPort(start = 5044) {
  return Number(process.env.HYDRA_ADB_PORT) || start;
}

/**
 * Configure fingerprints: Only "Side/ Data partition/ Engine Version" changes will be used for scrapshots.
 * Deliberately does not include GPU, accelerator, memory -- those are parameters that are automatically retryed to switch frequently,
 * If included, it triggers every retry-wipe-data, emptys the application that the user has installed.
 */
/**
 * Quickspot: Only these changes render old snapshots ineffective (black screens after loading/cannot rise).
 *
 * I mean it.**_Other Organiser**: The old snapshots will be used when the data partitions are larger (qemu will be based on the new partition size)
 * Remount) and the effect of adding it to the fingerprint is, "Users just want to expand their face, and the snapshot is disabled + cold start +
 * The data was deleted -- it was measured once, at the expense of the whole application.
 */
function snapshotKey(plan, imageDir) {
  return crypto.createHash('sha1').update([
    imageIdentity(imageDir), plan.emulatorVersion || '', plan.api || '', plan.tag || '',
  ].join('|')).digest('hex').slice(0, 16);
}

/**
 * “Identity“ of system mirrors: only retained `system-images/...` After that part.
 *
 * It doesn't matter which one of these mirrors is on, and a new directory of the same mirror should not be considered a "change of mirror"——
 * Otherwise the user moves running from C to D.,
 * The sysdir in AVD is not consistent with the new path -wipe-data fully loaded.
 * The pit actually stepped on it in the field, so both places had to be identified instead of an absolute path.
 */
function imageIdentity(dir) {
  const p = String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const i = p.indexOf('system-images/');
  if (i >= 0) return p.slice(i);
  return p.split('/').slice(-3).join('/');
}

const RULES = [
  {
    code: 'ACCESS_VIOLATION',
    // Windows emular/ qemu exited at 0xC00005 (Dec):
    // Most of the measurements are found in "Cmapcard Drive / Vulkan Backend crashes when guest is about to start.",
    // Neither the CPU, the memory, nor the mirror.
    // The crash logs are usually preceded by the rendering of initial information, which is more accurate.
    re: /emulator exit 3221225477|exit code 3221225477|0xC0000005|STATUS_ACCESS_VIOLATION/i,
    title: 'Renderer crash (0xC0000005 access violation)',
    hint: 'It’s been automatically re-tryed with a more conservative rendering backend, and remember that this backend will not be tried again.'
      + 'If repeated, update the card drive; or lower the quality of the painting in the setting of → performances and resources, close the remote desktop/virtual graphics and try again.',
  },
  {
    code: 'GPU_INIT',
    // Only matches the "failure" context: Vulkan/EGL/ANGLE will also appear in the normal log and cannot be misjudged as fatal.
    re: /Failed to initialize GL emulation|Could not initialize (OpenGL|emulated framebuffer)|Failed to create .*GLES|EGL_(BAD|NOT_INITIALIZED|CONTEXT_LOST)|Failed to (load|initialize) .*vulkan|vulkan.*(failed|error)|ANGLE.*(fail|error)/i,
    title: 'Failed to initialize backend for graphic card rendering',
    hint: 'Automatically switch software to retry. If still failed, update the card drive or close the remote desktop/virtual visual card and try again.',
  },
  {
    code: 'GPU_MODE',
    re: /Unknown option|invalid .*-gpu|Unrecognized .*gpu|Unsupported gpu/i,
    title: 'This GPU mode is not accepted while currently running',
    hint: 'The available GPU mode has been automatically selected for retry (old version with swiftshader_indirect, new version with software).',
  },
  {
    code: 'ACCEL',
    re: /x86_64 emulation currently requires hardware acceleration|acceleration.*not (installed|available|supported)|WHPX.*(not|failed)|AEHD.*(not|failed)|ERROR_ACCESS_DENIED|\u52a0\u901f.*\u4e0d\u53ef\u7528/i,
    title: 'Hardware acceleration is not available',
    hint: 'Automatically retreated software simulations (first start will be significantly slower). To be freely available, restart after the Windows function is ticked the Virtual Machine Platform or AEHD driver is installed.',
  },
  {
    code: 'MEMORY',
    re: /Cannot allocate memory|not enough memory|commit charge|Failed to allocate|out of memory|\u5185\u5b58\u4e0d\u8db3/i,
    title: 'Memory distribution failed',
    hint: 'The memory and core number assigned to Android has been automatically downgraded. Please try again after closing the memory.',
  },
  {
    code: 'PORT_BUSY',
    re: /port.*(in use|busy)|Address already in use|bind.*failed|Failed to (setup|bind) .*console/i,
    title: 'Simulator port occupied',
    hint: 'Automatically replaced with an empty port. If repeated, please exit the emulators Yagami/Mumu/Blue Collapse, or restart the computer.',
  },
  {
    code: 'AVD_LOCK',
    re: /already running|lock file|\.lock|AVD is in use|emulator is running/i,
    title: 'Last run left a lock on the file.',
    hint: 'Automatically clean AVD lock files and pull them up again.',
  },
  {
    code: 'IMAGE',
    re: /system\.img.*(missing|not found|corrupt)|kernel-ranchu.*(missing|not found)|invalid magic|Failed to open .*\.img|APEX.*(fail|error|loop)|boot loop|verity.*fail/i,
    title: 'system image missing or damaged / incompatible with old user data',
    hint: 'Automatically reboot with clean user data. If still failed, download the mirror after it is deleted in "runtime " .',
  },
  {
    code: 'DLL',
    re: /0xc0000135|STATUS_DLL_NOT_FOUND|missing DLL|Qt6.*not found|MSVCP140|VCRUNTIME|\u65e0\u6cd5\u542f\u52a8\u6b64\u7a0b\u5e8f|The code execution cannot proceed/i,
    // 0xC0000135 just means "some DLL didn’t load successfully," often for more than one reason.:
    // DLL search from WindowsApps when reading directory-only pull-up process is rewrited by the container,
    // The VC++ operating library is missing, and the poison isolated the files during the operation, all three of which are possible.
    // "Destination deleted / Missing VC++" is a static exit code guess that misleads the user to reload.
    // The real DLL missing is based on WER’s FaultingModuleName; it is listed here as "to be".
    title: 'A runtime DLL failed to load (cause unknown)',
    hint: 'Common reason: store-based version of path limits from reading-only directory start-up subprocess, VC++ running library missing, poison-segregated files while running.'
      + 'Please open the built-in manual 6.8 step by step; do not reload the running library with this rule alone.',
  },
  {
    code: 'DISK_FULL',
    re: /No space left|disk full|not enough space|\u78c1\u76d8\u7a7a\u95f4\u4e0d\u8db3/i,
    title: 'Disk space is insufficient to activate Android.',
    hint: 'Please change the running-time directory (setup system integration running-time data directory) to a space-sufficient disk, '
      + 'Or switch off “Retention of Quick Start Snapshot“/Modified Data Division. Android data will not be automatically cleared.',
  },
  {
    code: 'NON_ASCII',
    re: /Unicode|non-ASCII|\u8def\u5f84.*(\u65e0\u6548|\u627e\u4e0d\u5230)|cannot find the path/i,
    title: 'Install path with Chinese or special characters',
    hint: 'Automatically changed to Windows short path. If still failed, move Hydra Emulator to a plain English directory (e. g. C):\\Hydra Emulator).',
  },
  {
    // The AVD directory will leave a hardware-qemu.ini.lock / multi-standard.lock,
    // The simulator refuses to start, but it says it is easy to misread the CPU problem. It must be in front of the CPU rules.
    code: 'AVD_LOCK',
    re: /Running multiple emulators with the same AVD|AVD .*is already running|hardware-qemu\.ini\.lock/i,
    title: 'Last run didn\'t exit properly, left a locked file.',
    hint: 'Hydra Emulator will automatically clear the residue locks and try again; if repeated, check if there are any other simulators running with the same set.',
  },
  {
    code: 'CPU_FEATURE',
    re: /host doesn't support requested feature|CPUID.*not supported|unsupported CPU|missing.*(AVX|SSE4|xsave)/i,
    title: 'CPU missing the command set required when running',
    hint: 'This kind of tip is just a warning on some old CPU, and it still turns on; if it doesn’t come up, please update the engine in "runtime" to an older compatible version, or replace a computer that supports VT-x/AVX.',
  },

  {
    code: 'SNAPSHOT',
    re: /snapshot|Quick Boot|ram\.img|Saving state/i,
    title: 'Quick start snapshot damage',
    hint: 'The old snapshot has been discarded automatically and started coldly; the next normal exit will regenerate the snapshot.',
  },
];

/** Translating logs into {code,title,hint} for UI display and auto-test decision-making */
function diagnose(lines) {
  const text = (Array.isArray(lines) ? lines.join('\n') : String(lines || '')).slice(-24000);
  for (const r of RULES) {
    if (r.re.test(text)) return { code: r.code, title: r.title, hint: r.hint };
  }
  return {
    code: 'UNKNOWN',
    title: 'Could not close temporary folder: %s %s',
    hint: 'Automatically retryed with multiple parameters. The “ Export Diagnosis Report“ can point the log to the author for location.',
  };
}

/** A human readable line summary, placed on the setup page, lets senior users know what they’re going to choose. */
function describeProfile(p) {
  return `Auto: ${(p.memoryMB / 1024).toFixed(1)} GB RAM · ${p.cores} Nuclear · ${p.gpu} Render · `
    + `${p.accelOk ? 'hardware acceleration' : 'Software emulation'} · ${p.snapshot ? 'Snapshots as required' : 'Cold Start'}`
    + `${p.lite ? ' · Lite container' : ''} · Port ${p.port}`;
}

/** Export diagnostic report (pure text, easy to send mail/ paste assuue)) */
function writeReport({ dataDir, profile, logLines = [], extra = {} }) {
  const dir = path.join(dataDir, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `diagnostic-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
  const d = diagnose(logLines);
  const body = [
    'Hydra Emulator Diagnosis Report',
    `Generating time: ${new Date().toLocaleString()}`,
    '',
    '== Hydra Emulator diagnostics ==',
    JSON.stringify(hostInfo(), null, 2),
    '',
    '= Auto Configuration =',
    JSON.stringify(profile || {}, null, 2),
    describeProfile(profile || chooseProfile()),
    '',
    '== Runtime profile ==',
    `${d.code}: ${d.title}`,
    d.hint,
    '',
    '= Additional information=',
    JSON.stringify(extra, null, 2),
    '',
    '= runtime log (end 300 line) =',
    ...(Array.isArray(logLines) ? logLines.slice(-300) : String(logLines || '').split('\n')),
  ].join('\n');
  fs.writeFileSync(file, body, 'utf8');
  return { file, diagnosis: d };
}

/**
 * Test whether Microsoft VC++ 2015-2022 x64 runs library is installed.
 * Qt6 and qemu rely on it; it’s missing and it’s not going to rise directly on "other computers."
 * (Report 0xc000135 / MSVCP140 missing. Installed version of vc_redist.x64.exe,
 * This is only a test, so that you can give a clear hint and a key to the installation entrance before you start.
 */
function vcRedistOk() {
  if (process.platform !== 'win32') return true;
  // DLL: msvcp140 / vcruntime140 is two files on which Qt6 and qemu really rely.
  // Use files to judge that no reg.exe is used, that some security software will stop, and that the self-censorship per 60s will be delayed.),
  // In a post titled “The Unloaded“ (“The Uninstalled“ ) the registration forms were deleted from the cleanup tool.
  const sys = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32');
  try {
    if (fs.existsSync(path.join(sys, 'msvcp140.dll'))
      && fs.existsSync(path.join(sys, 'vcruntime140.dll'))) return true;
  } catch (_) { /* I’ll go to the bottom of the registration form. */ }

  const key = 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64';
  for (const k of [key, key.replace('SOFTWARE\\', 'SOFTWARE\\WOW6432Node\\')]) {
    try {
      const out = execFileSync('reg', ['query', k, '/v', 'Installed'],
        { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      if (/Installed\s+REG_DWORD\s+0x1/i.test(out)) return true;
    } catch (_) { /* Key does not exist = Not loaded */ }
  }
  return false;
}

module.exports = {
  hostInfo, freeDiskMB, isAsciiPath, shortPath, lcdFor, liteProfile,
  versionNumbers, gpuCandidates, detectGpuVendor, chooseProfile, planVariants,
  overridesFromSettings, autoProfile,
  freePortPair, freeAdbPort, snapshotKey, imageIdentity,
  diagnose, describeProfile, writeReport, vcRedistOk,
};
