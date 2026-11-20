'use strict';
/**
 * Automatic detection . Collection layer (only running in main process))
 *
 * Duty: take the true state of the machine into one.**Pure Data**The snapshots, to the src/core/autodebug.js.
 * The collectors allow failure -- leave space if they cannot, so that the judges "do not know," never make up their conclusions.
 *
 * Collection and time-consuming budget (total amount of 2-5 seconds at once)):
 *   - runtime status (engine status: environment + adb online))
 *   - adb device authorization status
 *   - disk balance, data partition capacity, shared directory writeability
 *   - AVD residual lock, flash shell, orphan simulation process
 *   - The wrong line in the recent journal.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { AVD_NAME, SNAPSHOT_NAME } = require('./emulator');

/** Lead time: the first time I saw a run but not ready. */
let bootingSince = 0;

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => { setTimeout(() => resolve(fallback), ms); }),
  ]);
}

/** Number of leftovers in AVD directory. Lock (files or directories count)) */
function countLocks(avdDir) {
  try {
    return fs.readdirSync(avdDir).filter((f) => /\.lock$/i.test(f)).length;
  } catch (_) {
    return 0;
  }
}

/**
 * Snipshot is not empty shell: snapshot.pb is missing or too small.
 * This snapshot starts with "loading failed to start cold again", which is like white GB disks.
 * Read-only judgment, not delete here -- delete to user to confirm or repair action.
 */
function inspectSnapshot(avdHome, avdName, snapshotName) {
  const base = path.join(avdHome, `${avdName}.avd`, 'snapshots', snapshotName);
  const size = (p) => { try { return fs.statSync(p).size; } catch (_) { return 0; } };
  const pb = size(path.join(base, 'snapshot.pb'));
  const ram = Math.max(size(path.join(base, 'ram.bin')), size(path.join(base, 'ram.img')));
  if (pb === 0 && ram === 0) return { present: false, stale: false, mb: 0 };
  const mb = Math.round((pb + ram) / 1048576);
  const stale = !(pb > 1024 && ram > 1024 * 1024);
  return { present: true, stale, mb };
}

/** Number of living simulator orphan processes (emular.exe /qemu-system*.exe)) */
function countOrphanProcesses() {
  return new Promise((resolve) => {
    let out = '';
    try {
      execFile('tasklist.exe', ['/NH', '/FO', 'CSV'], { timeout: 8000, windowsHide: true }, (err, stdout) => {
        if (err) { resolve(null); return; }
        out = String(stdout || '');
        const lines = out.split(/\r?\n/).filter((l) => /emulator\.exe|qemu-system/i.test(l));
        resolve(lines.length);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

/**
 * Windows Audio (Audiosrv) isn’t running.
 * only when the output of sc query is clearly obtained,
 * The decision level is "not known", and it is not "no audio services have been stopped" because of a failure of the query.
 */
function queryWindowsAudioService() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve(null); return; }
    try {
      execFile('sc.exe', ['query', 'Audiosrv'], { timeout: 8000, windowsHide: true }, (err, stdout) => {
        if (err) { resolve(null); return; }
        const text = String(stdout || '');
        if (!/SERVICE_NAME:\s*Audiosrv/i.test(text)) { resolve(null); return; }
        const m = text.match(/STATE\s*:\s*\d+\s+([A-Z_]+)/i);
        if (!m) { resolve(null); return; }
        resolve(/^RUNNING$/i.test(m[1]));
      });
    } catch (_) {
      resolve(null);
    }
  });
}

/** Read error lines in recent log files (up to 300 lines)) */
function recentLogErrors(files, max = 300) {
  const out = [];
  for (const file of files) {
    let text = '';
    try {
      const size = fs.statSync(file).size;
      const take = Math.min(size, 512 * 1024);
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(take);
        fs.readSync(fd, buf, 0, take, size - take);
        text = buf.toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch (_) { continue; }
    const lines = text.split(/\r?\n/).slice(-max);
    for (const line of lines) {
      if (/\b(ERROR|FATAL|FATAL ERROR|Exception|FATAL:|panic:)\b/i.test(line)) {
        out.push(line.trim().slice(0, 240));
      }
    }
  }
  return out.slice(-20);
}

/**
 * Take a snapshot.
 * @param {object} ctx { runtime, store, doctor }
 * @returns {Promise<object>} obs
 */
async function collect(ctx) {
  const { runtime, store, doctor } = ctx;
  const obs = {
    at: Date.now(),
    runtime: {},
    device: { checked: false },
    storage: {},
    settings: {},
    network: {},
    logs: {},
    accel: { checked: false },
    audio: { checked: false, enabled: null, serviceRunning: null },
  };

  // - Set (most cheap, first to pick) -
  let settings = {};
  try { settings = store.getSettings() || {}; } catch (_) { settings = {}; }
  obs.settings = {
    orientationMode: (settings.display && settings.display.orientationMode) || 'auto',
    landscape: !!(settings.display && settings.display.landscape),
    // 0.6.0 Default primary window: only obvious true is embedded mode
    windowEmbed: !!(settings.display && settings.display.windowEmbed === true),
    autoFullscreen: !!(settings.display && settings.display.autoFullscreenOnLaunch),
    keepSnapshot: !(settings.engine && settings.engine.keepSnapshot === false),
    resourceMode: (settings.engine && settings.engine.resourceMode) || '',
  };

  // - Sound -
  // Audio = false will start the simulator belt - no-audio, which is the number one reason for “only Hydra Emulator has no voice.“
  // Windows Audio’s services are disabled and the rest of the system is silent. Both are automatically tested in 0.6.2.
  obs.audio = {
    checked: true,
    enabled: !(settings.engine && settings.engine.audio === false),
    serviceRunning: await withTimeout(queryWindowsAudioService(), 9000, null),
  };

  // - runtime status -
  let status = null;
  try {
    status = await withTimeout(runtime.status(), 20000, null);
  } catch (_) { status = null; }

  let paths = null;
  try { paths = runtime.provisioner.paths(); } catch (_) { paths = null; }

  const running = !!(status && status.vmRunning)
    || (() => { try { return !!(runtime.emulator && runtime.emulator.running()); } catch (_) { return false; } })();

  const phase = status ? (status.phase || '') : '';
  const ready = !!(status && status.ready);
  if (running && !ready) {
    if (!bootingSince) bootingSince = Date.now();
  } else {
    bootingSince = 0;
  }

  const lastFailure = status ? status.lastFailure : null;
  obs.runtime = {
    running,
    phase,
    ready,
    bootMs: bootingSince ? Date.now() - bootingSince : 0,
    error: (status && status.error && !/ADB (?:is )?(?:missing|not found)|missing ADB|\u7f3a\u5c11 adb/i.test(status.error)) ? status.error : '',
    lastFailure: lastFailure ? { error: lastFailure.error || lastFailure.reason || '' } : null,
    locks: paths ? countLocks(paths.avdHome) : 0,
    orphans: null,
    snapshotStale: false,
  };

  // -adb Device Authorization Status -
  try {
    const client = runtime.client();
    if (client && typeof client.deviceState === 'function') {
      const state = await withTimeout(client.deviceState(), 10000, null);
      if (state) {
        obs.device = { checked: true, state };
      }
    }
  } catch (_) { /* Leave undetected checked:false */ }

  // - Storage -
  try {
    const root = paths ? paths.root : null;
    if (root) {
      const freeMB = doctor.freeDiskMB(root);
      obs.storage.freeMB = Number(freeMB) || 0;
    }
  } catch (_) { /* ignore */ }

  try {
    const backend = runtime.backend;
    const info = (backend && typeof backend.dataInfo === 'function') ? (backend.dataInfo() || {}) : {};
    obs.storage.configuredGB = Number(info.configuredGB) || 0;
    obs.storage.actualGB = Number(info.actualGB) || 0;
    obs.storage.needsReset = !!(info.pendingGB || info.needsReset);
  } catch (_) { /* ignore */ }

  try {
    const shared = String(settings.sharedDir || '').trim();
    if (shared) {
      let ok = true;
      try {
        fs.accessSync(shared, fs.constants.W_OK);
      } catch (_) { ok = false; }
      obs.storage.sharedOk = ok;
      obs.storage.sharedPath = shared;
    }
  } catch (_) { /* ignore */ }

  // - snapshot/ lock/ orphan -
  try {
    if (paths) {
      const snap = inspectSnapshot(paths.avdHome, AVD_NAME, SNAPSHOT_NAME);
      obs.runtime.snapshotStale = snap.stale;
      obs.runtime.snapshotMB = snap.mb;
    }
  } catch (_) { /* ignore */ }

  const orphans = await countOrphanProcesses();
  if (orphans !== null) {
    // The one that’s running is a process of two processes, not a residual.
    const expected = running ? 2 : 0;
    obs.runtime.orphans = Math.max(0, orphans - expected);
  }

  // - Network -
  try {
    const snap = typeof runtime._networkSnapshot === 'function' ? runtime._networkSnapshot() : null;
    if (snap) obs.network = { ok: !!snap.ok, reason: snap.reason || '', ip: snap.ip || '' };
  } catch (_) { /* ignore */ }

  // - Accelerating -
  try {
    if (status && status.accel) {
      obs.accel = { checked: true, ok: !!status.accel.ok, note: status.accel.note || '' };
    }
  } catch (_) { /* ignore */ }

  // - Log -
  try {
    const dir = path.join(store.DATA_DIR, 'logs');
    const files = [path.join(store.DATA_DIR, 'app.log'), path.join(dir, 'emulator.log')];
    const errors = recentLogErrors(files);
    obs.logs = { errors, count: errors.length };
  } catch (_) { /* ignore */ }

  return obs;
}

module.exports = { collect, inspectSnapshot, countLocks, recentLogErrors, countOrphanProcesses };
