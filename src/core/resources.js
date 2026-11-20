'use strict';
/**
 * Pure logic for resource allocation (memory / CPU / storage).
 *
 * Why a separate layer: "how much memory to give Android" ultimately ends up in the
 * QEMU command line (-memory / -cores) and takes effect on the next boot; but the rules
 * for "how much the user may enter" and "what happens if they overdo it" are pure
 * functions, extracted so they don't depend on electron and can be required directly
 * in CI for unit tests.
 *
 * Three hard constraints (all learned from real testing):
 *   1. Memory must not saturate the host: Windows + foreground apps need at least 25%
 *      left over, otherwise the whole machine starts paging and Android shows a long
 *      black screen with frozen animations, looking like "the emulator is broken".
 *   2. Storage should be estimated as "installer package × 1.8 + 2GB": a 50GB online game
 *      often expands to 80-90GB, so allowing only the package size guarantees a failure
 *      halfway through installation.
 *   3. Every automatic value must be computable: if host information is unavailable, fall
 *      back to a conservative default and never return NaN.
 */

const DEFAULT_STEP_MB = 512;
const MIN_MEM_MB = 1024;
/** Share reserved for the host (Windows + foreground apps) */
const HOST_RESERVE_RATIO = 0.25;
/** Below this ratio, warn that it is "tight" */
const TIGHT_RATIO = 0.8;
/** Absolute lower bound below which nothing works (even the system cannot run) */
const ABSOLUTE_MIN_MB = 768;

function toInt(v, fallback = 0) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Host capabilities. Parameters are injectable for testing; when omitted, read the local machine.
 * @returns {{ totalMB:number, cores:number }}
 */
function hostProfile(sys) {
  let totalMB = 0;
  let cores = 0;
  const src = sys || {};
  if (Number(src.totalMB) > 0) {
    totalMB = toInt(src.totalMB);
  } else if (Number(src.totalmem) > 0) {
    totalMB = Math.round(Number(src.totalmem) / 1048576);
  } else {
    try {
      // require('os') inside the function: avoid touching the host environment at module load time
      const os = require('os');
      totalMB = Math.round(os.totalmem() / 1048576);
      cores = os.cpus() ? os.cpus().length : 0;
    } catch (_) { totalMB = 0; }
  }
  if (Number(src.cores) > 0) cores = toInt(src.cores);
  return { totalMB, cores: Math.max(1, cores || 1) };
}

/**
 * Valid memory range. When host memory cannot be read, use a conservative cap so the UI never shows 0.
 * @returns {{ minMB:number, maxMB:number, stepMB:number, totalMB:number }}
 */
function memoryLimits(totalMB) {
  const total = toInt(totalMB);
  if (total <= 0) return { minMB: MIN_MEM_MB, maxMB: 8192, stepMB: DEFAULT_STEP_MB, totalMB: 0 };
  const usable = Math.floor((total * (1 - HOST_RESERVE_RATIO)) / DEFAULT_STEP_MB) * DEFAULT_STEP_MB;
  const maxMB = Math.max(MIN_MEM_MB, Math.min(usable, 65536));
  return { minMB: MIN_MEM_MB, maxMB, stepMB: DEFAULT_STEP_MB, totalMB: total };
}

/**
 * Clamp the user-entered memory to a legal value. 0 = automatic, returned as 0 (each backend derives its own value).
 * @returns {{ mb:number, capped:boolean, reason:string }}
 */
function clampMemoryMB(mb, totalMB) {
  const want = toInt(mb);
  if (want <= 0) return { mb: 0, capped: false, reason: 'auto' };
  const lim = memoryLimits(totalMB);
  const rounded = Math.round(want / lim.stepMB) * lim.stepMB;
  if (rounded > lim.maxMB) {
    return {
      mb: lim.maxMB,
      capped: true,
      reason: `Host has ${Math.round(lim.totalMB / 1024)} GB of memory, at most ${Math.round(lim.maxMB / 1024)} GB can be allocated (25% must be left for Windows)`,
    };
  }
  if (rounded < lim.minMB) return { mb: lim.minMB, capped: true, reason: `Android needs at least ${lim.minMB} MB to boot` };
  return { mb: rounded, capped: rounded !== want, reason: rounded !== want ? 'Aligned to 512 MB' : '' };
}

/**
 * Clamp the CPU core count. 0 = automatic.
 * The cap is "physical cores - 1", leaving at least 1 core for the host; single-core machines get 1 core.
 */
function clampCores(n, hostCores) {
  const want = toInt(n);
  const total = Math.max(1, toInt(hostCores) || 1);
  const max = total > 1 ? total - 1 : 1;
  if (want <= 0) return { cores: 0, capped: false, reason: 'auto' };
  if (want > max) {
    return { cores: max, capped: true, reason: `This machine has ${total} cores, at most ${max} can be allocated (1 core left for Windows)` };
  }
  return { cores: Math.max(1, want), capped: false, reason: '' };
}

/**
 * Whether the memory allocation is reasonable (for UI hints + warnings before installing large packages).
 * @returns {{ level:'ok'|'tight'|'insufficient'|'unknown', ratio:number, note:string }}
 */
function memVerdict(allocMB, hostMB) {
  const alloc = toInt(allocMB);
  const host = toInt(hostMB);
  if (!alloc || !host) return { level: 'unknown', ratio: 0, note: '' };
  if (alloc < ABSOLUTE_MIN_MB) {
    return { level: 'insufficient', ratio: alloc / host, note: `Only ${alloc} MB allocated, Android may fail to start` };
  }
  const ratio = alloc / host;
  if (ratio > 1 - HOST_RESERVE_RATIO) {
    return {
      level: 'insufficient',
      ratio,
      note: `Using ${Math.round(ratio * 100)}% of host memory, Windows will start paging and the emulator becomes slower`,
    };
  }
  if (ratio > TIGHT_RATIO * (1 - HOST_RESERVE_RATIO)) {
    return { level: 'tight', ratio, note: `Using ${Math.round(ratio * 100)}% of host memory, consider closing browser tabs as well` };
  }
  return { level: 'ok', ratio, note: '' };
}

/** Actual data partition space needed to install a package (including extraction and update package overhead) */
function diskRequiredMB(packageBytes, ratio = 1.8, reserveMB = 2048) {
  const bytes = Math.max(0, Number(packageBytes) || 0);
  if (!bytes) return reserveMB;
  return Math.ceil((bytes / 1048576) * ratio) + reserveMB;
}

/**
 * Upper limit for the data partition. When disk space is low, do not let the user enter 64GB and then fail halfway.
 * @returns {{ maxGB:number, warnGB:number, freeMB:number }}
 */
function diskLimits(freeMB) {
  const free = Math.max(0, toInt(freeMB));
  // The partition image itself also takes host space (dynamic images grow to nearly the partition size), keep a 20% buffer
  const maxGB = Math.max(0, Math.floor((free / 1024) * 0.8));
  return { maxGB, warnGB: Math.max(0, maxGB - 8), freeMB: free };
}

/**
 * Clamp the user-entered data partition size (GB). 0 = automatic.
 * @returns {{ gb:number, capped:boolean, reason:string }}
 */
function clampDataGB(gb, freeMB) {
  const want = toInt(gb);
  if (want <= 0) return { gb: 0, capped: false, reason: 'auto' };
  const lim = diskLimits(freeMB);
  if (!lim.freeMB) return { gb: want, capped: false, reason: '' };
  if (want > lim.maxGB) {
    return {
      gb: Math.max(0, lim.maxGB),
      capped: true,
      reason: `Only ${(lim.freeMB / 1024).toFixed(1)} GB left on that disk, at most ${lim.maxGB} GB can be allocated`,
    };
  }
  return { gb: want, capped: false, reason: '' };
}

/**
 * Whether there is enough storage to install this package.
 * @returns {{ ok:boolean, needMB:number, freeMB:number, shortMB:number, note:string }}
 */
function storageVerdict(freeMB, packageBytes) {
  const need = diskRequiredMB(packageBytes);
  const free = Math.max(0, toInt(freeMB));
  if (!free) return { ok: true, needMB: need, freeMB: 0, shortMB: 0, note: 'Cannot read free disk space, skipping pre-check' };
  if (free >= need) return { ok: true, needMB: need, freeMB: free, shortMB: 0, note: '' };
  const short = need - free;
  return {
    ok: false,
    needMB: need,
    freeMB: free,
    shortMB: short,
    note: `About ${(need / 1024).toFixed(1)} GB needed, only ${(free / 1024).toFixed(1)} GB free, short by ${(short / 1024).toFixed(1)} GB`,
  };
}

/**
 * Whether disk space is enough for this package (the most common failure point for 50GB-class games).
 * Difference from storageVerdict: this one only checks "enough or not", and its text is meant
 * to block installation before it starts.
 * @returns {{ ok:boolean, unknown?:boolean, freeMB:number, requiredMB:number, message:string }}
 */
function diskVerdict(freeMB, requiredMB) {
  const free = Math.max(0, toInt(freeMB));
  const need = Math.max(0, toInt(requiredMB));
  if (!free) return { ok: true, unknown: true, freeMB: 0, requiredMB: need, message: '' };
  if (free >= need) return { ok: true, freeMB: free, requiredMB: need, message: '' };
  return {
    ok: false,
    freeMB: free,
    requiredMB: need,
    message: `Not enough disk space: about ${Math.ceil(need / 1024)} GB more is needed, but the disk holding the Hydra Emulator runtime has only ${(free / 1024).toFixed(1)} GB left.`
      + ' Move the runtime directory to a partition with more space in Settings, or free up space and try again.',
  };
}

module.exports = {
  DEFAULT_STEP_MB,
  MIN_MEM_MB,
  HOST_RESERVE_RATIO,
  hostProfile,
  memoryLimits,
  clampMemoryMB,
  clampCores,
  memVerdict,
  diskRequiredMB,
  diskVerdict,
  diskLimits,
  clampDataGB,
  storageVerdict,
};
