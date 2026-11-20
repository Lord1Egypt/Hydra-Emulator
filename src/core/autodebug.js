'use strict';
/**
 * Automatically detect (automatic debug) kernels
 *
 * In two layers, deliberately separated.:
 *   1) Collection layer (src/core/autodebug-probe.js, main process): take the true state of the machine into a purely data snapshot of obs;
 *   2) Decision layer (this document, pure function): evaluate(obs) issues[].
 *
 * Fs/ Child_process/ electron, CI can require and single measure
 * (Lessons learned from memory 2026-11-17: the module that relies on eclectron on the top of the CI will be all red.
 * The only additional reliance is the same catalogue of manual.js (pure map), which points the problem directly to the built-in curriculum chapter.
 *
 * One iron law: the fields that are not in the obs are always "not known" and can’t be reported for failure of detection.
 * Misreporting is more damaging to the user than underreporting - the test results are false once the user discovers that the ejection is false.,
 * I'll never believe any of the conclusions of the auto-test.
 */

const manual = require('./manual');

/** Question Categorization (set pages in this order)) */
const CATEGORIES = [
  { id: 'runtime', name: 'Runtime', hint: 'Android boot, snapshots, processes, and lock files' },
  { id: 'device', name: 'Device connection', hint: 'ADB authorization and connectivity' },
  { id: 'storage', name: 'Storage', hint: 'Free space, data partition, and shared folder' },
  { id: 'settings', name: 'Settings', hint: 'Conflicting settings and disabled features' },
  { id: 'network', name: 'Network', hint: 'Android connectivity and download sources' },
  { id: 'logs', name: 'Logs', hint: 'Recent runtime errors' },
];

const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

/** Order of severity: The bigger the number, the worse. */
const SEVERITY_RANK = { error: 3, warn: 2, info: 1 };

/** One of the problems of statization, to make sure that the fields that UI gets are always complete. */
function normalise(raw) {
  if (!raw || !raw.code) return null;
  const severity = SEVERITY_RANK[raw.severity] ? raw.severity : 'info';
  const item = {
    code: String(raw.code),
    category: CATEGORY_IDS.includes(raw.category) ? raw.category : 'runtime',
    severity,
    title: String(raw.title || raw.code),
    hint: String(raw.hint || ''),
    // fix is the action name for " one key fix " , which is mapd from the rendering layer to the specific operation; leaving empty if not
    fix: raw.fix || '',
    // Decail is the supplementary information (paths, values, etc.) to be shown, not in the title
    detail: raw.detail === undefined || raw.detail === null ? '' : String(raw.detail),
  };
  // 0.6.2: Each problem has its own "school" goal, and the rendering layer does not need to copy a failure classification sheet.
  item.help = manual.topicForIssue(item);
  return item;
}

/**
 * Deciding: To turn observation snapshots into problem lists
 * @param{object} obs snapshots from the collector layer (fields are missing))
 * @returns {Array<object>}List of Questions After Normalization
 */
function evaluate(obs) {
  const o = obs || {};
  const runtime = o.runtime || {};
  const device = o.device || {};
  const storage = o.storage || {};
  const settings = o.settings || {};
  const network = o.network || {};
  const logs = o.logs || {};
  const accel = o.accel || {};
  const out = [];

  const push = (raw) => {
    const it = normalise(raw);
    if (it) out.push(it);
  };

  /* --------------- */

  // Turn it on: just give the last real reason, and don't let the user guess.
  const bootError = runtime.error || (runtime.lastFailure && runtime.lastFailure.error) || '';
  if (bootError) {
    push({
      code: 'runtime.bootFailed',
      category: 'runtime',
      severity: 'error',
      title: 'The Android runtime failed to start',
      hint: 'See the reported error below or export the diagnostic report for the full log.',
      detail: bootError,
      fix: 'restartRuntime',
    });
  }

  // It's stuck in the lead, ready, mostly with a shot or a mirror.
  if (runtime.running && runtime.phase && runtime.phase !== 'ready' && runtime.bootMs > 150000) {
    push({
      code: 'runtime.stuckBoot',
      category: 'runtime',
      severity: 'warn',
      title: 'Android is stuck during startup',
      hint: 'Android has been starting for more than 90 seconds. Restarting the runtime can recover from an unusable Quick Boot snapshot.',
      detail: `Phase: ${runtime.phase}`,
      fix: 'restartRuntime',
    });
  }

  // Residue lock file: will allow the next start to be convicted as "AVD has been occupied" direct FATAL
  if (Number(runtime.locks) > 0) {
    push({
      code: 'runtime.staleLocks',
      category: 'runtime',
      severity: 'warn',
      title: `Stale lock files detected (${runtime.locks})`,
      hint: 'Stale AVD locks can block startup. Select Fix to clear them.',
      fix: 'lock',
    });
  }

  // Orphan process: emular.exe is just a starter, qemu is a detached independent process,
  // Killing only the trigger leaves orphans in possession.lock.
  if (Number(runtime.orphans) > 0) {
    push({
      code: 'runtime.orphanProcesses',
      category: 'runtime',
      severity: 'warn',
      title: `Orphaned emulator processes detected (${runtime.orphans})`,
      hint: 'Emulator processes left after shutdown may hold locks or use resources. Select Fix to stop them.',
      fix: 'orphans',
    });
  }

  // Clock shell: The file is in the file but is not verified, and each time the engine is started, "load failed to start cold again", it leaves a few GBs for nothing.
  if (runtime.snapshotStale) {
    push({
      code: 'runtime.staleSnapshot',
      category: 'runtime',
      severity: 'warn',
      title: 'Quick Boot snapshot is corrupted',
      hint: 'The snapshot failed validation. Remove it so Android can start normally.',
      fix: 'snapshots',
    });
  }

  /* ---------------------------------------------------------------------------------------------------------- */

  // Unauthorized: Android played "Will USB debugging be allowed?" but nobody did.)
  if (device.state === 'unauthorized') {
    push({
      code: 'device.unauthorized',
      category: 'device',
      severity: 'error',
      title: 'ADB debugging is not authorized',
      hint: 'Accept Allow USB debugging in the Android window. Restarting can bring the prompt back.',
      fix: 'restartRuntime',
    });
  } else if (device.state === 'offline') {
    push({
      code: 'device.offline',
      category: 'device',
      severity: 'warn',
      title: 'The Android device is offline in ADB',
      hint: 'Android may still be starting. Restart the runtime if ADB stays offline.',
      fix: 'restartRuntime',
    });
  } else if (runtime.running && device.checked && device.state === 'no-device') {
    push({
      code: 'device.missing',
      category: 'device',
      severity: 'warn',
      title: 'ADB cannot see the running Android device',
      hint: 'Check for a conflict on the ADB port or restart the runtime.',
      fix: 'restartRuntime',
    });
  }

  /* ----------------- */

  const freeMB = Number(storage.freeMB) || 0;
  if (freeMB > 0 && freeMB < 2048) {
    push({
      code: 'storage.diskCritical',
      category: 'storage',
      severity: 'error',
      title: 'The runtime disk is nearly full',
      hint: 'Less than 2 GB is free. Clear unused images, snapshots, and logs to make room for apps.',
      detail: `Remaining ${freeMB} MB`,
      fix: 'disk',
    });
  } else if (freeMB > 0 && freeMB < 8192) {
    push({
      code: 'storage.diskLow',
      category: 'storage',
      severity: 'warn',
      title: 'The runtime disk is low on space',
      hint: 'Less than 8 GB is free. Clear unused files to make room for images and snapshots.',
      detail: `Remaining ${freeMB} MB`,
      fix: 'disk',
    });
  }

  // Game with a data partition with a smaller actual capacity than configuration will alert “inadequate storage space“
  if (storage.needsReset) {
    push({
      code: 'storage.dataNeedsReset',
      category: 'storage',
      severity: 'warn',
      title: 'Android data partition expansion did not apply',
      hint: 'A Quick Boot overlay is using the previous capacity. Reset Android data to rebuild at the selected size. This clears installed apps and their data.',
      detail: `Configured ${storage.configuredGB} GB · Actual ${storage.actualGB} GB`,
      fix: 'dataReset',
    });
  } else if (Number(storage.configuredGB) > 0 && Number(storage.actualGB) > 0
    && Number(storage.configuredGB) > Number(storage.actualGB)) {
    push({
      code: 'storage.dataMismatch',
      category: 'storage',
      severity: 'error',
      title: 'The Android data partition is smaller than configured',
      hint: 'Large apps may run out of space. Review the configured partition size and actual capacity.',
      detail: `Configured ${storage.configuredGB} GB · Actual ${storage.actualGB} GB`,
      fix: 'dataReset',
    });
  }

  if (storage.sharedOk === false) {
    push({
      code: 'storage.sharedBroken',
      category: 'storage',
      severity: 'warn',
      title: 'Shared folder is unavailable',
      hint: 'The shared folder is missing or cannot be written to. Choose a writable folder to resume sync.',
      detail: storage.sharedPath || '',
      fix: 'shared',
    });
  }

  /* ------- settings------------------------------------------------------------------------------------------------------------------------------------ */

  // Android gave only a narrow image of the middle of the application (memory 2026-11-18).)
  const mode = String(settings.orientationMode || 'auto');
  if (mode === 'portrait' && settings.landscape === true) {
    push({
      code: 'settings.orientationConflict',
      category: 'settings',
      severity: 'warn',
      title: 'Screen orientation conflicts with the virtual display',
      hint: 'The app is set to portrait while the virtual display is in landscape. This can leave black bars.',
      fix: 'orientation',
    });
  } else if (mode === 'landscape' && settings.landscape === false) {
    push({
      code: 'settings.orientationConflict',
      category: 'settings',
      severity: 'warn',
      title: 'Screen orientation conflicts with the virtual display',
      hint: 'The app is set to landscape while the virtual display is in portrait. This can leave black bars.',
      fix: 'orientation',
    });
  }

  if (settings.windowEmbed === false && settings.autoFullscreen) {
    push({
      code: 'settings.detachedFullscreen',
      category: 'settings',
      severity: 'info',
      title: 'Automatic fullscreen is unavailable in standalone window mode',
      hint: 'Press F11 to switch display modes, or choose embedded window mode in Settings.',
    });
  }

  if (settings.keepSnapshot === false && freeMB > 0 && freeMB < 4096) {
    push({
      code: 'settings.snapshotOffLowDisk',
      category: 'settings',
      severity: 'info',
      title: 'Quick Boot is disabled and disk space is low',
      hint: 'Apps will start with a cold boot. Free up disk space before enabling Quick Boot snapshots.',
      fix: 'settings',
    });
  }

  /* -------------------- */

  // 0.6.2 Add: When user feedback is “Applications without sound”, the first reaction is often a system volume problem,
  // The most common thing is that engine switches have been shut down (-no-audio) or Windows Audio services have been shut down.
  const audio = o.audio || {};
  if (audio.checked && audio.enabled === false) {
    push({
      code: 'audio.disabled',
      category: 'settings',
      severity: 'warn',
      title: 'Android audio is disabled',
      hint: 'Enable Audio Emulation and restart the Android runtime to hear app audio.',
      fix: 'audio',
    });
  }
  if (audio.checked && audio.serviceRunning === false) {
    push({
      code: 'audio.windowsServiceStopped',
      category: 'settings',
      severity: 'warn',
      title: 'The Windows Audio service (Audiosrv) is stopped',
      hint: 'Start Windows Audio in services.msc, or use the repair action and confirm the Windows prompt.',
      fix: 'audioService',
    });
  }

  /* Networks - - - - */

  if (network.ok === false) {
    push({
      code: 'network.guestDown',
      category: 'network',
      severity: 'warn',
      title: 'Android is offline',
      hint: 'Restart the runtime or use the guest network repair if apps cannot connect.',
      detail: network.reason || '',
      fix: 'repairNetwork',
    });
  }

  const badSources = Array.isArray(network.sources) ? network.sources.filter((s) => s && s.ok === false) : [];
  if (badSources.length) {
    push({
      code: 'network.sourcesDown',
      category: 'network',
      severity: 'warn',
      title: `Download sources unavailable (${badSources.length})`,
      hint: 'Check your connection and any proxy or mirror settings, then try again.',
      detail: badSources.map((s) => s.name).join(', '),
      fix: 'settings',
    });
  }

  /* --------------- */

  const errLines = Array.isArray(logs.errors) ? logs.errors.filter(Boolean) : [];
  if (errLines.length) {
    push({
      code: 'logs.errors',
      category: 'logs',
      severity: 'warn',
      title: `Runtime log errors (${errLines.length})`,
      hint: 'Export the diagnostic report to see the surrounding log entries.',
      detail: errLines.slice(-1)[0],
      fix: 'report',
    });
  }

  /* - - - - Accelerating - - */

  if (accel.checked && accel.ok === false) {
    push({
      code: 'accel.softwareEmulation',
      category: 'runtime',
      severity: 'warn',
      title: 'Hardware acceleration is unavailable',
      hint: 'Hydra is using software emulation. Enable Windows Hypervisor Platform and restart Windows to try hardware acceleration.',
      detail: accel.note || '',
      fix: 'virtualization',
    });
  }

  return dedupe(out);
}

/** Same code only leaves the last one (last test covers the previous one)) */
function dedupe(issues) {
  const map = new Map();
  for (const raw of issues || []) {
    const it = normalise(raw);
    if (!it) continue;
    map.set(it.code, it);
  }
  return Array.from(map.values());
}

/** High to low by severity. */
function bySeverity(a, b) {
  const d = (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0);
  if (d) return d;
  return String(a.code).localeCompare(String(b.code));
}

/** Summary: Count the status bar and set the page break */
function summarize(issues) {
  const list = dedupe(issues).sort(bySeverity);
  const errors = list.filter((i) => i.severity === 'error').length;
  const warns = list.filter((i) => i.severity === 'warn').length;
  const infos = list.filter((i) => i.severity === 'info').length;
  const byCategory = CATEGORIES.map((c) => {
    const items = list.filter((i) => i.category === c.id);
    return {
      id: c.id,
      name: c.name,
      count: items.length,
      errors: items.filter((i) => i.severity === 'error').length,
    };
  });
  return {
    total: list.length,
    errors,
    warns,
    infos,
    byCategory,
    // It’s clear at first glance, "Is there a problem that has to be addressed immediately?"
    health: errors ? 'error' : (warns ? 'warn' : (infos ? 'info' : 'ok')),
  };
}

/** Group by category to set the page categories for rendering */
function groupByCategory(issues) {
  const list = dedupe(issues).sort(bySeverity);
  return CATEGORIES.map((c) => ({
    ...c,
    items: list.filter((i) => i.category === c.id),
  })).filter((g) => g.items.length);
}

/**
 * Compare the results of two tests: finding "new" and "disappeared" problems.
 * Automatically only reminds users when new problems arise that those that have disappeared are kept silent. ——
 * Every time you play "recovered 3" it turns into noise.
 */
function diff(prevIssues, nextIssues) {
  const prev = new Map((prevIssues || []).map((i) => [i.code, i]));
  const next = new Map((nextIssues || []).map((i) => [i.code, i]));
  const added = [];
  const resolved = [];
  for (const [code, it] of next) {
    const before = prev.get(code);
    if (!before || before.severity !== it.severity) added.push(it);
  }
  for (const [code, it] of prev) {
    if (!next.has(code)) resolved.push(it);
  }
  return { added, resolved };
}

module.exports = {
  CATEGORIES,
  CATEGORY_IDS,
  SEVERITY_RANK,
  normalise,
  evaluate,
  dedupe,
  summarize,
  groupByCategory,
  diff,
  bySeverity,
};
