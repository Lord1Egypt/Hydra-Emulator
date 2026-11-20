'use strict';
/**
 * App-level container (pure computation layer)
 *
 * Hydra Emulator is backed by a full-system QEMU VM, so it cannot do what WSA / Zhuoyitong do
 * and "load only the few system services a given App needs" — the Linux kernel, zygote, and
 * system_server must all be brought up as a whole. But the "heaviness" users actually feel does
 * not come from those always-on services; it comes from:
 *   1. Re-booting a full Android every time an App is opened (cold boot 40-142 seconds, CPU/disk saturated);
 *   2. Every App opened earlier staying in the background consuming memory, using the network, and holding wake locks;
 *   3. With no App in the foreground, qemu still competes with the desktop for CPU at Normal priority;
 *   4. File sync and notification polling keep running even when no App is open.
 *
 * Here the parts that can genuinely be trimmed become orchestrated, unit-testable commands:
 *   - The environment is booted only once; afterwards "open App" = am start + attach window (handled by Runtime.beginApp);
 *   - Opening a new App stops the processes of other user Apps, keeping only the runtime environment the current one needs;
 *   - Closing the last App puts Android into idle, clears background processes, and lowers qemu priority;
 *   - System packages are never touched by default (stopping GMS makes Apps that rely on push/login throw errors repeatedly);
 *     only when the user explicitly enables "deep trimming" is a small set of clearly useless background packages disabled.
 *
 * This file does not depend on adb / Electron; everything is pure functions, for easy regression testing.
 */

/** Never trim under any circumstances: touching these directly causes a black screen or app crashes */
const NEVER_TRIM = [
  'android',
  'com.android.systemui',
  'com.android.settings',
  'com.android.inputmethod.latin',
  'com.google.android.inputmethod.latin',
  'com.android.webview',
  'com.google.android.webview',
  'com.google.android.gms',
  'com.google.android.gsf',
  'com.android.providers.settings',
  'com.android.server.telecom',
];

/** Disabled only under "deep trimming": these packages only do background updates/wallpapers/printing; stopping them does not affect opening Apps */
const OPTIONAL_SYSTEM = [
  'com.android.vending',                    // Play Store (background update scanning)
  'com.google.android.setupwizard',         // First-run setup wizard
  'com.android.printspooler',               // Print service
  'com.android.wallpapercropper',
  'com.android.dreams.basic',               // Screensaver
  'com.android.providers.calendar',
  'com.android.providers.contacts',
  'com.android.managedprovisioning',
  'com.android.statementservice',
  'com.android.backupconfirm',
];

/** Packages that are clearly system/framework: skipped during session trimming to avoid killing them by mistake */
const SYSTEM_PREFIXES = [
  'android', 'com.android.', 'com.google.android.',
  'com.qualcomm.', 'com.qti.', 'vendor.', 'com.mediatek.',
];

/** Only legal Android package names may be interpolated into shell commands, preventing injection if the list is tampered with */
const SAFE_PKG = /^[A-Za-z][A-Za-z0-9_.]+$/;

function isSystemPackage(pkg) {
  const p = String(pkg || '').trim();
  if (!p) return true;
  if (!SAFE_PKG.test(p)) return true;
  return SYSTEM_PREFIXES.some((pre) => p === pre || p.startsWith(pre));
}

/**
 * Trim commands to run when launching an App.
 * @param {object} o
 * @param {string} o.pkg            Package about to be opened
 * @param {string[]} o.installed    User App packages installed on this machine (list from store)
 * @param {boolean} o.deep          Deep trimming (disable background system packages), default false
 * @param {boolean} o.killBackground Also clear background cached processes, default false
 *   (clearing background during launch may hurt an App that just entered the foreground; cleanup is handled by endApp's park command)
 * @returns {{commands:string[], stopped:string[], disabled:string[], kept:string[]}}
 */
function buildSessionCommands({
  pkg, installed = [], deep = false, killBackground = false,
} = {}) {
  const target = SAFE_PKG.test(String(pkg || '').trim()) ? String(pkg).trim() : '';
  const commands = [];
  const stopped = [];
  const disabled = [];
  const kept = [];

  for (const raw of installed) {
    const p = String(raw || '').trim();
    if (!p || p === target || isSystemPackage(p) || NEVER_TRIM.includes(p)) {
      if (p) kept.push(p);
      continue;
    }
    stopped.push(p);
    commands.push(`am force-stop ${p}`);
  }

  // Clear background processes of the system cache (excluding foreground and persistent services),
  // so "keep only the current App" is not just force-stopping the package name but actually returns memory.
  if (killBackground) commands.push('am kill-all 2>/dev/null || true');

  if (deep) {
    for (const p of OPTIONAL_SYSTEM) {
      if (NEVER_TRIM.includes(p)) continue;
      disabled.push(p);
      commands.push(`pm disable-user --user 0 ${p} 2>/dev/null || true`);
    }
    // Disable background data on metered networks, so the store/sync do not keep waking up in the background
    commands.push('settings put global restricted_background_data 1 2>/dev/null || true');
  }

  return { commands, stopped, disabled, kept };
}

/**
 * After closing the last App, make the container "idle without consuming resources".
 * Do not shut down or destroy the AVD: the next open is still instant, but CPU/memory are first given back to Windows.
 */
function buildIdleCommands({ deep = false } = {}) {
  const commands = [
    'am kill-all 2>/dev/null || true',
    'dumpsys deviceidle force-idle 2>/dev/null || true',
  ];
  if (deep) commands.push('settings put global restricted_background_data 1 2>/dev/null || true');
  return commands;
}

/** Restore from deep trimming (called when the user turns the switch off, ensuring it can be reverted) */
function buildRestoreCommands() {
  return [
    ...OPTIONAL_SYSTEM.map((p) => `pm enable ${p} 2>/dev/null || true`),
    'settings put global restricted_background_data 0 2>/dev/null || true',
  ];
}

/**
 * Session state machine: decide what state the container should be in after a launch/close.
 * Pure function, handy for verifying edges like "switching between multiple windows" and "last window closed".
 */
function nextSessionState(active, event, pkg) {
  const set = new Set(active || []);
  if (event === 'open') set.add(pkg);
  else if (event === 'close') set.delete(pkg);
  return {
    active: [...set],
    hasApp: set.size > 0,
    foreground: event === 'open' ? pkg : (set.size ? [...set][set.size - 1] : null),
    idle: set.size === 0,
  };
}

/** One-line summary for logs/diagnostics */
function describeSession(state, plan) {
  const n = state.active.length;
  if (!n) return 'Container idle (Android resident but deprioritized, 0 app processes)';
  return `Container active: ${n} app window(s)${plan && plan.stopped && plan.stopped.length
    ? `, stopped ${plan.stopped.length} background app(s)` : ''}`;
}

/**
 * Session state machine under multi-window (option B).
 *
 * Unlike the single-window nextSessionState: here active may contain multiple apps, and we must distinguish
 * "the one being viewed in the foreground" from "the ones parked in the background". Background apps are the main memory cost,
 * so a tombstone strategy is introduced:
 *   - foreground: the one with a visible window that the user is interacting with;
 *   - background: still considered "open" but has no window; after a grace period it should be force-stopped (tombstoned),
 *     and reopening it goes through warm start recovery at the cost of reloading the page once, without losing login state/data.
 *
 * @param {string[]} active        All currently active app package names
 * @param {string} foreground      Current foreground package (may be null)
 * @returns {{foreground:string|null, background:string[], count:number}}
 */
function sessionRoles(active = [], foreground = null) {
  const set = (active || []).filter(Boolean);
  const fg = foreground && set.includes(foreground) ? foreground : (set.length ? set[set.length - 1] : null);
  return {
    foreground: fg,
    background: set.filter((p) => p !== fg),
    count: set.length,
  };
}

/**
 * Decide which background apps should be tombstoned (force-stopped to reclaim memory).
 *
 * Rules (conservative: better to kill too few than to hurt something in use):
 *   - Only handle background, never touch foreground;
 *   - Always skip system packages / NEVER_TRIM;
 *   - Keep the most recent N background apps (default 1) for quick switching without losing login state, tombstone the rest;
 *   - tombstoneLimit<=0 means "keep no background", tombstone everything (maximum memory savings).
 *
 * @param {object} o { background, installedSystem?, keepRecent?, tombstone? }
 * @returns {{tombstone:string[], keep:string[]}}
 */
function planTombstones({ background = [], keepRecent = 1 } = {}) {
  const bg = (background || []).filter((p) => p && !isSystemPackage(p) && !NEVER_TRIM.includes(p));
  // The end of background is the most recent; keep the last keepRecent, tombstone the rest
  const keepCount = Math.max(0, Number(keepRecent) || 0);
  const keep = bg.slice(Math.max(0, bg.length - keepCount));
  const tombstone = bg.filter((p) => !keep.includes(p));
  return { tombstone, keep };
}

/** Generate tombstone commands: force-stop the given background packages, reclaiming memory while keeping data/login state */
function buildTombstoneCommands(pkgs = []) {
  return pkgs.filter((p) => SAFE_PKG.test(String(p))).map((p) => `am force-stop ${p}`);
}

module.exports = {
  NEVER_TRIM, OPTIONAL_SYSTEM, SYSTEM_PREFIXES,
  isSystemPackage, buildSessionCommands, buildIdleCommands,
  buildRestoreCommands, nextSessionState, describeSession,
  sessionRoles, planTombstones, buildTombstoneCommands,
};
