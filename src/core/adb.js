'use strict';
/**
 * ADB client wrapper.
 * Only the parts hydra needs: install / launch / stop / uninstall / file sync / screenshot.
 */
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const { autoRotateSetting } = require('./orientation');

/**
 * Value written into the guest for the image's "auto-rotate" switch ('1' on / '0' off).
 * Panel orientation is not decided by it -- the `wm user-rotation lock 0` +
 * `wm set-ignore-orientation-request` that follow in setOrientation /
 * resetDisplayOverrides are what actually control orientation. This only makes the
 * switch in system settings read as "on", matching what apps expect from that setting.
 */
function guestAutoRotate() {
  try { return autoRotateSetting(store.getSettings()); } catch (_) { return '1'; }
}

/**
 * Logical density for tablet layout.
 * 720 wide / (190/160) = 606dp >= 600dp, just past Android's tablet breakpoint;
 * 320dpi (the image default) gives only 360dp, which is phone layout.
 */
const TABLET_DENSITY = 190;
function tabletDensity() {
  try {
    return (store.getSettings().display || {}).tabletMode !== false ? String(TABLET_DENSITY) : 'reset';
  } catch (_) {
    return String(TABLET_DENSITY);
  }
}

/**
 * Known locations of adb on the system. **Deliberately limited to the Android SDK and
 * common manual install dirs**: the adb bundled with third-party emulators (MuMu /
 * LDPlayer / BlueStacks) is not listed -- using it drags along someone else's server
 * state (port, authorization, offline flapping), which conflicts with "run standalone".
 * Our own adb lives in the runtime directory and always takes priority (see engine.adbPath).
 */
const COMMON_ADB_PATHS = [
  path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
  'C:/Android/platform-tools/adb.exe',
  'C:/adb/adb.exe',
];

/**
 * Turn raw pm install failures into messages the user can understand.
 * The original error code is kept at the end to make searching easier.
 */
function friendlyInstallError(raw) {
  const code = /INSTALL_[A-Z_]+/.exec(raw);
  const tag = code ? code[0] : '';
  const table = {
    INSTALL_FAILED_NO_MATCHING_ABIS:
      'Install failed: this app only ships ARM native libraries (common for many apps), '
      + 'and the current system image has no ARM translation layer. Hydra Emulator will '
      + 'switch to a compatible image with the newer built-in translation layer and retry.',
    INSTALL_FAILED_OLDER_SDK:
      'Install failed: the app requires a newer Android version than this runtime provides (needs a newer system image).',
    INSTALL_PARSE_FAILED_NO_CERTIFICATES:
      'Install failed: the APK has no valid signature and cannot be installed.',
    INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES:
      'Install failed: the signature does not match the installed version; uninstall the old version first.',
    INSTALL_FAILED_VERSION_DOWNGRADE:
      'Install failed: a newer version is already installed; downgrading is not allowed.',
    INSTALL_FAILED_INSUFFICIENT_STORAGE:
      'Install failed: the runtime is out of disk space; free some space and try again.',
    INSTALL_FAILED_INVALID_APK:
      'Install failed: the APK is corrupt or incomplete (possibly an interrupted download); fetch it again.',
    INSTALL_FAILED_INVALID_URI: 'Install failed: the APK path contains special characters; move the file to a plain ASCII path and retry.',
    INSTALL_FAILED_ALREADY_EXISTS: 'Install failed: an app with the same name exists with a different signature; uninstall it first.',
    INSTALL_FAILED_UPDATE_INCOMPATIBLE: 'Install failed: the signature does not match the installed version; uninstall the old version first.',
    INSTALL_FAILED_DEPRECATED_SDK_VERSION:
      'Install failed: this app targets a very old Android version (targetSdk too low), '
      + 'which Android 14 blocks by default. Hydra Emulator will retry with the official bypass flag.',
    INSTALL_FAILED_TEST_ONLY: 'Install failed: this is a test-only package; retrying with the test-package flag.',
    INSTALL_FAILED_MISSING_SHARED_LIBRARY: 'Install failed: a device feature the app depends on (such as a vendor library) is missing from this runtime.',
    INSTALL_FAILED_USER_RESTRICTION: 'Install failed: the system restricts installs; restart the runtime and retry.',
    INSTALL_FAILED_CONFLICTING_PROVIDER: 'Install failed: ContentProvider conflict with an existing app; uninstall the conflicting app.',
    INSTALL_FAILED_INTERNAL_ERROR: 'Install failed: internal system error (often low storage or an unfinished boot); restart the runtime and retry.',
  };
  const msg = table[tag];
  return msg ? `${msg} (${tag})` : `Install failed: ${raw}`;
}

/** Turn post-launch crash logs into understandable causes */
function friendlyLaunchError(raw, pkg) {
  const t = String(raw || '');
  if (/DoBadTrampoline|libndk_translation|houdini|SIGABRT.*arm/i.test(t)) {
    return `${pkg || 'the app'} crashed after launch: the ARM translation layer is incompatible with this app's signal handling. `
      + 'Hydra Emulator will switch to an Android 14 compatible image and retry.';
  }
  if (/UnsatisfiedLinkError|dlopen failed|couldn't find "lib|\.so.*not found/i.test(t)) {
    return `${pkg || 'the app'} crashed after launch: missing native device library (the app may only ship an ARM build). `
      + 'Switching to a compatible image with the ARM translation layer and retrying.';
  }
  if (/ClassNotFoundException|NoClassDefFoundError|AndroidRuntime/i.test(t)) {
    return `${pkg || 'the app'} crashes immediately on launch (an internal app error, possibly related to the emulator environment or missing Google services).`;
  }
  if (/java\.lang\.SecurityException|Permission Denial/i.test(t)) {
    return `${pkg || 'the app'} failed to start: the system rejected the launch request (permission or signature problem).`;
  }
  return `${pkg || 'the app'} did not start${t ? `: ${t.slice(0, 240)}` : ' (process is not alive)'}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Parse the state column of a serial in `adb devices`.
 * Key point: an unauthorized device still reports 'device' from `get-state`; only the
 * state column of the devices list distinguishes authorized / unauthorized / offline --
 * boot probing relies on this to self-heal quickly.
 */
function parseDeviceState(text, serial) {
  const lines = String(text || '').split(/\r?\n/).slice(1);
  for (const line of lines) {
    const m = /^(\S+)\s+(unauthorized|offline|recovery|sideload|no\s+permissions|device)\b/i.exec(line.trim());
    if (!m) continue;
    if (serial && m[1] !== serial) continue;
    const st = m[2].toLowerCase().replace(/\s+/g, '');
    if (st === 'device') return 'device';
    if (st === 'unauthorized' || st === 'nopermissions') return 'unauthorized';
    return st; // offline / recovery / sideload
  }
  return 'no-device';
}

/** Recognize unauthorized from the shell error caused by an unconfirmed "Allow USB debugging" dialog */
function isUnauthorizedError(raw) {
  return /\bunauthorized\b|no permissions|confirm.*(allow|debug)/i.test(String(raw || ''));
}

/** Extract the real path of each APK from the output of `pm path <pkg>` */
function parsePmPaths(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim())
    .filter((l) => /^package:/.test(l)).map((l) => l.slice(8).trim()).filter(Boolean);
}

/** Resolved launch entries (adbPath|pkg -> activity), valid for 10 minutes */
const LAUNCHER_CACHE = new Map();

/**
 * Windows adb handles non-ASCII paths unreliably (non-ASCII usernames and download
 * folders are common). Before installing, copy the APK into a pure-ASCII temp
 * directory and delete it once the install finishes.
 */
function stageApk(apkPath) {
  const p = String(apkPath || '');
  if (/^[\x20-\x7e]*$/.test(p) && p.length < 200) return { path: p, staged: false };
  const dir = path.join(os.tmpdir(), 'hydra-install');
  fs.mkdirSync(dir, { recursive: true });
  const name = `${crypto.createHash('sha1').update(p).digest('hex').slice(0, 12)}.apk`;
  const target = path.join(dir, name);
  fs.copyFileSync(p, target);
  return { path: target, staged: true };
}

function unstage(staged) {
  if (!staged) return;
  try { fs.rmSync(staged, { force: true }); } catch (_) { /* ignore */ }
}

/**
 * Build the full component that am start -n expects from an "Activity".
 * Both forms must be supported:
 *   - Bare class name (what older apps.json stored): `MainActivity` / `.MainActivity` -> `<pkg>/<activity>`
 *   - Full component (output of `cmd package resolve-activity`): `com.a.b/.Main` -> used as-is
 * The old implementation unconditionally built `${pkg}/${activity}`, so a full
 * component became `pkg/pkg/class`; am start cancelled it (result code=-92) and the
 * symptom was "tapping the icon only shows the Android home screen".
 */
function componentArg(pkg, activity) {
  const a = String(activity || '').trim();
  if (!a) return '';
  if (a.includes('/')) return a;
  return `${pkg}/${a}`;
}

/** Extract the component belonging to pkg from `cmd package resolve-activity --brief` output (tolerates trailing blank/priority lines) */
function parseResolvedActivity(pkg, out) {
  const lines = String(out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = /^([\w.]+)\/([.\w$]+)$/.exec(lines[i]);
    if (m && m[1] === pkg) return `${m[1]}/${m[2]}`;
  }
  return '';
}

/**
 * The adb install timeout used to be a fixed 240s, but a 2GB+ package on a slow disk
 * easily exceeds 4 minutes for "push + install + dexopt": a timeout is treated as a
 * failed install, and what the user sees is "big app just hangs / fails". Scale it by
 * package size here, capped at 20 minutes.
 */
function installTimeoutMs(bytes) {
  const mb = Math.max(1, Number(bytes || 0) / 1048576);
  return Math.min(1200000, Math.max(240000, Math.round(60000 + mb * 120)));
}

class AdbError extends Error {
  constructor(message, stderr, code) {
    super(message);
    this.stderr = stderr;
    this.code = code;
  }
}

/**
 * Parse the output of `find -exec stat -c '%Y|%s|%n'`.
 * Returning null means the output does not look like stat results (device does not support it).
 */
function parseStatList(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const rows = [];
  for (const l of lines) {
    const m = /^(\d{9,})\|(\d+)\|(.+)$/.exec(l);
    if (!m) continue;
    const rel = m[3].replace(/^\.\//, '');
    if (!rel || rel.endsWith('/')) continue;
    rows.push({ rel, size: Number(m[2]), mtime: Number(m[1]) * 1000 });
  }
  // Output exists but not a single line parsed -> not in stat format
  if (!rows.length) return null;
  return rows;
}

class AdbClient {
  constructor({ adbPath, serial }) {
    this.adbPath = adbPath || 'adb';
    this.serial = serial || '';
    this._input = null;        // persistent `adb shell` process
    this._inputSeq = 0;
    this._waiters = new Map(); // id -> { resolve, reject, timer, token }
  }

  static resolveAdb(explicit, appRoot) {
    const candidates = [
      explicit,
      appRoot && path.join(appRoot, 'tools', 'platform-tools', 'adb.exe'),
      ...COMMON_ADB_PATHS,
    ].filter(Boolean);
    for (const c of candidates) {
      try { if (fs.existsSync(c)) return c; } catch (_) { /* ignore */ }
    }
    return 'adb'; // let PATH resolve it
  }

  _args(args, withSerial = true) {
    const a = [];
    if (withSerial && this.serial) a.push('-s', this.serial);
    return a.concat(args);
  }

  _adbEnv() {
    const env = { ...process.env, ANDROID_ADB_SERVER_PORT: process.env.ANDROID_ADB_SERVER_PORT || '5044' };
    // Play Store images enforce ADB authorization: the host adb server and the guest
    // adbd must use the same adbkey. The official setup has adb and emulator share
    // %USERPROFILE%\.android\adbkey{,.pub}, and the emulator bakes adbkey.pub into the
    // guest's /data/misc/adb/adb_keys at boot. Tell the adb server explicitly where to
    // look for the public key: in some setups ANDROID_SDK_HOME / portable runtimes make
    // adb look elsewhere, so every cold boot pops "Allow USB debugging" -> device unauthorized.
    if (!env.ADB_VENDOR_KEYS) {
      const home = process.env.USERPROFILE || process.env.HOME || '';
      const keyDir = path.join(home, '.android');
      try { if (home && fs.existsSync(keyDir)) env.ADB_VENDOR_KEYS = keyDir; } catch (_) { /* ignore */ }
    }
    return env;
  }

  exec(args, { timeout = 30000, withSerial = true, binary = false } = {}) {
    return new Promise((resolve, reject) => {
      const finalArgs = this._args(args, withSerial);
      execFile(this.adbPath, finalArgs, {
        timeout,
        maxBuffer: 64 * 1024 * 1024,
        encoding: binary ? 'buffer' : 'utf8',
        windowsHide: true,
        // Share a dedicated adb server port with the runtime emulator (default 5044),
        // isolated from WSA / third-party emulator adb on 5037, so our registration is
        // not repeatedly kicked off and the device does not go offline
        env: this._adbEnv(),
      }, (err, stdout, stderr) => {
        if (err) {
          // adb install writes the failure reason to stdout with a non-zero exit code;
          // the old version only read stderr, so the user always saw a vague "failed".
          const text = [stdout, stderr, err.message].filter(Boolean).join('\n').trim();
          const e = new AdbError(`adb ${finalArgs.join(' ')} failed: ${text}`, stderr, err.code);
          e.stdout = stdout;
          e.raw = text;
          return reject(e);
        }
        resolve({ stdout, stderr });
      });
    });
  }

  async shell(cmd, opts = {}) {
    const { stdout } = await this.exec(['shell', cmd], opts);
    return typeof stdout === 'string' ? stdout.trim() : stdout;
  }

  /**
   * Persistent input channel.
   * Wheel/back are high-frequency inputs: running execFile for adb on every wheel tick
   * spawns piles of processes and noticeably stutters the desktop. Reuse one
   * `adb shell`, one command per line, and echo a completion marker at the end -- this
   * tells us when a command really finished and naturally applies backpressure, so
   * scroll commands do not pile up in a long queue inside the shell.
   */
  _inputSession() {
    const old = this._input;
    if (old && old.exitCode === null && !old.killed && old.stdin && old.stdin.writable) return old;
    if (old) this.disposeInput();

    const p = spawn(this.adbPath, this._args(['shell'], true), {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this._adbEnv(),
    });
    this._input = p;
    let buf = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        for (const [id, w] of this._waiters) {
          // The whole line must equal the token: some shells echo the entire command
          // line, and a contains check would mistake "just written" for "finished", so
          // scrolls would pile up.
          if (line === w.token) {
            this._waiters.delete(id);
            clearTimeout(w.timer);
            w.resolve(true);
            break;
          }
        }
      }
    });
    p.stderr.on('data', () => { /* ignore: the caller handles things like the device going offline */ });
    p.stdin.on('error', () => { /* cleanup on disconnect is handled by exit */ });
    p.on('error', () => { this._failWaiters(new Error('failed to start adb shell')); });
    p.on('exit', () => {
      if (this._input === p) this._input = null;
      this._failWaiters(new Error('adb shell has exited'));
    });
    return p;
  }

  _failWaiters(err) {
    for (const [, w] of this._waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this._waiters.clear();
  }

  /** Run one allowlisted input command; on failure the session is reclaimed and the caller can fall back to one-shot adb */
  async input(cmd, { timeout = 4000 } = {}) {
    const { isInputCommand } = require('./pointer');
    if (!isInputCommand(cmd)) throw new Error('Invalid input command');
    const p = this._inputSession();
    const id = ++this._inputSeq;
    const token = `__HYDRA_${id}__`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiters.delete(id);
        this.disposeInput();
        reject(new Error('input command timed out'));
      }, timeout);
      this._waiters.set(id, { resolve, reject, timer, token });
      try {
        p.stdin.write(`${cmd}; echo ${token}\n`);
      } catch (e) {
        this._waiters.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  disposeInput() {
    const p = this._input;
    this._input = null;
    for (const [, w] of this._waiters) {
      clearTimeout(w.timer);
      w.reject(new Error('input channel is closed'));
    }
    this._waiters.clear();
    if (p) {
      try { p.stdin.end(); } catch (_) { /* ignore */ }
      try { p.kill(); } catch (_) { /* ignore */ }
    }
  }

  async version() {
    const { stdout } = await this.exec(['version'], { withSerial: false });
    const m = /version\s+([\d.]+)/i.exec(stdout);
    return m ? m[1] : stdout.trim();
  }

  async connect() {
    if (!this.serial.includes(':')) return true;
    try {
      await this.exec(['connect', this.serial], { withSerial: false, timeout: 15000 });
    } catch (_) { /* may already be connected */ }
    return this.isOnline();
  }

  async isOnline() {
    try {
      const { stdout } = await this.exec(['get-state'], { timeout: 8000 });
      return stdout.trim() === 'device';
    } catch (_) {
      // get-state is unusable without a serial; fall back to the devices list
      try {
        const { stdout } = await this.exec(['devices'], { withSerial: false, timeout: 8000 });
        return stdout.split('\n').some((l) => l.startsWith(this.serial) && l.includes('device'));
      } catch (_) {
        return false;
      }
    }
  }

  /**
   * Read the real state of this serial in `adb devices`: device / unauthorized / offline / no-device.
   * The get-state call used by isOnline() cannot distinguish authorized from unauthorized
   * (both report 'device'); boot probing uses this method to detect a stuck authorization
   * dialog and self-heal quickly.
   */
  async deviceState() {
    try {
      const { stdout } = await this.exec(['devices'], { withSerial: false, timeout: 8000 });
      return parseDeviceState(stdout, this.serial);
    } catch (_) {
      return 'no-device';
    }
  }

  async devices() {
    const { stdout } = await this.exec(['devices', '-l'], { withSerial: false });
    return stdout.split('\n').slice(1)
      .map((l) => l.trim())
      .filter((l) => l && l.includes('device') && !l.startsWith('*'))
      .map((l) => {
        const parts = l.split(/\s+/);
        return { serial: parts[0], state: parts[1], model: (l.match(/model:(\S+)/) || [])[1] || '' };
      })
      .filter((d) => d.state === 'device');
  }

  /**
   * Install a single APK with automatic fallback:
   *  - -g is dropped by default (auto-granting all permissions crashes PermissionController on some images);
   *  - --bypass-low-target-sdk-block is passed, so Android 14 stops rejecting old targetSdk apps;
   *  - retries with a different form when adb does not know the flag / non-ASCII path / transfer errors;
   *  - NO_MATCHING_ABIS throws an error carrying a code so the caller can switch to a compatible image.
   */
  async install(apkPath) {
    if (!fs.existsSync(apkPath)) throw new Error(`APK does not exist: ${apkPath}`);
    const staged = stageApk(apkPath);
    const file = staged.path;
    const variants = [
      // -g auto-grants runtime permissions and skips in-app permission dialogs; dropped automatically if an image does not support it
      ['install', '-r', '-t', '-g', '--bypass-low-target-sdk-block', file],
      ['install', '-r', '-t', '--bypass-low-target-sdk-block', file],
      ['install', '-r', '-t', file],
      ['install', '-r', file],
    ];
    let last = '';
    let timeout = 240000;
    try { timeout = installTimeoutMs(fs.statSync(file).size); } catch (_) { /* use the default when size is unavailable */ }
    try {
      for (const args of variants) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const { stdout } = await this.exec(args, { timeout });
          if (/Failure|Error/i.test(stdout) && !/Success/i.test(stdout)) {
            throw new Error(String(stdout).trim());
          }
          return stdout.trim();
        } catch (e) {
          const raw = String(e.raw || e.stdout || e.message || '');
          last = raw;
          const tag = (/INSTALL_[A-Z_]+/.exec(raw) || [])[0] || '';

          if (tag === 'INSTALL_FAILED_NO_MATCHING_ABIS') {
            const err = new Error(friendlyInstallError(raw));
            err.code = 'NO_MATCHING_ABIS';
            err.raw = raw;
            throw err;
          }
          // old adb does not know the new flag / test-package tag -> try another form
          if (/Unknown option|unrecognized option|Unknown command/i.test(raw)) continue;
          if (tag === 'INSTALL_FAILED_TEST_ONLY' || tag === 'INSTALL_FAILED_DEPRECATED_SDK_VERSION') continue;
          // transfer-class errors (device dropped, adb server restarted): retry once
          if (/device (not found|offline)|closed|protocol fault|no devices/i.test(raw)) {
            // eslint-disable-next-line no-await-in-loop
            await sleep(1500);
            continue;
          }
          if (tag) {
            const err = new Error(friendlyInstallError(raw));
            err.code = tag;
            err.raw = raw;
            throw err;
          }
          // no clear error code: try the last form
        }
      }
      const err = new Error(friendlyInstallError(last || 'install failed without a clear reason'));
      err.code = (/INSTALL_[A-Z_]+/.exec(last) || [])[0] || 'INSTALL_UNKNOWN';
      err.raw = last;
      throw err;
    } finally {
      unstage(staged.staged ? file : null);
    }
  }

  /** Split APKs (multiple slices extracted from .apks / .xapk) go through install-multiple */
  async installMultiple(apkPaths) {
    if (!apkPaths || !apkPaths.length) throw new Error('no split APKs to install');
    const staged = apkPaths.map((p) => stageApk(p));
    const files = staged.map((s) => s.path);
    const totalBytes = staged.reduce((n, s) => n + (fs.existsSync(s.path) ? fs.statSync(s.path).size : 0), 0);
    const timeout = installTimeoutMs(totalBytes);
    try {
      for (const extra of [['-r', '-t', '--bypass-low-target-sdk-block'], ['-r', '-t']]) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const { stdout } = await this.exec(['install-multiple', ...extra, ...files], { timeout });
          if (/Failure|Error/i.test(stdout) && !/Success/i.test(stdout)) throw new Error(stdout);
          return stdout.trim();
        } catch (e) {
          const raw = String(e.raw || e.stdout || e.message || '');
          if (/Unknown option|unrecognized option/i.test(raw)) continue;
          if (/INSTALL_FAILED_NO_MATCHING_ABIS/.test(raw)) {
            const err = new Error(friendlyInstallError(raw));
            err.code = 'NO_MATCHING_ABIS';
            throw err;
          }
          throw new Error(friendlyInstallError(raw));
        }
      }
      throw new Error('split APK install failed');
    } finally {
      staged.forEach((s) => unstage(s.staged ? s.path : null));
    }
  }

  async uninstall(pkg) {
    try {
      await this.exec(['uninstall', pkg], { timeout: 60000 });
    } catch (e) {
      // some devices need an explicit user
      await this.exec(['shell', 'pm', 'uninstall', '--user', '0', pkg], { timeout: 60000 });
    }
  }

  /**
   * Whether the app is really installed -- do not take PackageManager's word for it.
   *
   * When the snapshot and the data partition disagree, `pm path` still returns
   * `package:/data/app/.../base.apk` (installed=true) because a record remains in
   * packages.xml, while the APK file itself has already been rolled back. Continuing
   * with `am start` only fails. So verify each path pm reports with `test -f/-s`; if the
   * file is missing (or empty), treat it as "not really installed" and let the caller
   * reinstall automatically.
   *
   * @returns {Promise<boolean>}
   */
  async isInstalled(pkg) {
    const out = await this.shell(`pm path ${pkg}`);
    const paths = parsePmPaths(out);
    if (!paths.length) return false;
    // Every split APK must be present; losing any one makes the app unlaunchable. Combine into one shell command to save an adb round trip.
    const checks = paths.map((p) => `[ -s "${p}" ]`).join(' && ');
    const probe = await this.shell(`${checks} && echo __HYDRA_PRESENT__`, { timeout: 10000 }).catch(() => '');
    return /__HYDRA_PRESENT__/.test(String(probe));
  }

  async listPackages() {
    const out = await this.shell('pm list packages -3');
    return out.split('\n').map((l) => l.replace('package:', '').trim()).filter(Boolean);
  }

  /** Resolve the real launch Activity from the system (fallback when the manifest does not yield one) */
  /** The entry point can change after an app update; drop the package from the cache before resolving */
  clearLauncherCache(pkg) {
    if (!pkg) { LAUNCHER_CACHE.clear(); return; }
    LAUNCHER_CACHE.delete(`${this.adbPath}|${pkg}`);
  }

  async resolveLauncher(pkg) {
    // Resolving the launch Activity costs one adb round trip (~200-400ms) and it does not
    // change within a launch session. Cache it so tapping the same app again skips it;
    // entries expire after 10 minutes, and a reinstall will not reuse a wrong entry.
    const key = `${this.adbPath}|${pkg}`;
    const hit = LAUNCHER_CACHE.get(key);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
    try {
      const out = await this.shell(
        `cmd package resolve-activity --brief ${pkg}`, { timeout: 10000 },
      );
      const comp = parseResolvedActivity(pkg, out);
      if (comp) {
        LAUNCHER_CACHE.set(key, { value: comp, at: Date.now() });
        return comp;
      }
    } catch (_) { /* fall through to monkey */ }
    return null;
  }

  /** Whether the app is really alive: am start returning success does not mean the process did not crash */
  async waitAppAlive(pkg, timeoutMs = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // eslint-disable-next-line no-await-in-loop
      const pid = await this.shell(`pidof ${pkg}`, { timeout: 6000 }).catch(() => '');
      if (String(pid).trim()) return { ok: true };
      // 350ms polling (was 1000ms): detect a live process sooner and let the launch flow
      // continue. pidof is a lightweight shell; polling more often is barely noticeable and
      // directly shortens "tap to first frame".
      // eslint-disable-next-line no-await-in-loop
      await sleep(350);
    }
    let crash = '';
    try {
      crash = await this.shell(
        `logcat -d -t 250 -v brief AndroidRuntime:E DEBUG:E libc:E 2>/dev/null | `
        + `grep -i -E '${pkg}|FATAL|ndk_translation|SIGABRT|SIGSEGV|UnsatisfiedLink' | tail -n 30`,
        { timeout: 12000 },
      );
    } catch (_) { /* ignore */ }
    const text = String(crash || '').trim();
    // Without crash logs we must not declare failure: some large apps take 20-40s on first launch
    return { ok: false, crash: text, uncertain: !text };
  }

  /**
   * Start the app with three levels of fallback:
   *   freeform window -> regular fullscreen -> monkey as last resort;
   * always verify the process is alive, and on a crash capture logcat and throw an error
   * carrying a code so the caller can switch images automatically.
   */
  async startApp(pkg, activity, { freeform = true, bounds = null, forceStop = false } = {}) {
    if (forceStop) await this.forceStop(pkg);
    // The LAUNCHER entry resolved by the system must be used, not just the main Activity
    // from the APK: many apps do real initialization in their splash page, and jumping
    // straight to the main Activity throws "had you called RpcService.init" -- the app
    // flashes and disappears when opened.
    const resolved = (await this.resolveLauncher(pkg).catch(() => '')) || activity;
    // resolved may be a full component (pkg/class) or just a class name (old apps.json);
    // normalize it to the full component am start -n wants, so the system does not cancel pkg/pkg/class.
    const comp = componentArg(pkg, resolved);
    const intent = comp
      ? ['-n', comp]
      : ['-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-p', pkg];
    const modes = freeform
      ? [['--windowingMode', '5'], []]
      : [[]];
    let lastError = '';

    for (const mode of modes) {
      const parts = ['am', 'start', ...mode, '--activity-clear-top', ...intent];
      let out = '';
      try {
        // eslint-disable-next-line no-await-in-loop
        out = await this.shell(parts.join(' '), { timeout: 20000 });
      } catch (e) {
        lastError = String(e.message || e);
        continue;
      }
      if (/Error|Exception/i.test(out)) { lastError = out; continue; }

      if (bounds) this.resizeTaskOfPackage(pkg, bounds).catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      const alive = await this.waitAppAlive(pkg, 6000);
      if (alive.ok) return out;
      if (alive.uncertain) return `${out}\n(app is still loading)`;
      lastError = alive.crash || lastError;
      // When crash logs clearly point at the ARM translation layer, stop retrying and let the caller switch images
      if (/DoBadTrampoline|libndk_translation|UnsatisfiedLinkError|dlopen failed/i.test(alive.crash || '')) {
        const err = new Error(friendlyLaunchError(alive.crash, pkg));
        err.code = 'APP_CRASHED';
        err.crash = alive.crash;
        throw err;
      }
    }

    // monkey fallback: on some images am start -a/-c/-p cannot resolve the launcher
    try {
      const out = await this.shell(
        `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`, { timeout: 20000 },
      );
      const alive = await this.waitAppAlive(pkg, 12000);
      if (alive.ok || alive.uncertain) return out;
      lastError = alive.crash || lastError;
    } catch (e) {
      // Prefer a clear crash message when there is one; otherwise keep the original launch error
      if (!lastError) lastError = String(e.message || e);
    }

    if (!lastError) return 'started';
    const err = new Error(friendlyLaunchError(lastError, pkg));
    err.code = 'APP_CRASHED';
    err.crash = lastError;
    throw err;
  }

  async forceStop(pkg) {
    try { await this.shell(`am force-stop ${pkg}`); } catch (_) { /* ignore */ }
  }

  async runningPackages() {
    try {
      const out = await this.shell('dumpsys activity activities | grep -E "mResumedActivity|ResumedActivity"');
      const pkgs = [...out.matchAll(/([a-zA-Z][\w.]+\/[.\w$]+)/g)].map((m) => m[1].split('/')[0]);
      return [...new Set(pkgs)];
    } catch (_) {
      return [];
    }
  }

  async taskIdOfPackage(pkg) {
    try {
      const out = await this.shell('dumpsys activity recents');
      const blocks = out.split('Recent #');
      for (const b of blocks) {
        if (!b.includes(pkg)) continue;
        const m = /taskId=(\d+)/.exec(b) || /^\d+/.exec(b);
        if (m) return Number(m[1] || m[0]);
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  async resizeTaskOfPackage(pkg, bounds) {
    const id = await this.taskIdOfPackage(pkg);
    if (!id) return false;
    await this.shell(`am task resize ${id} ${bounds.left} ${bounds.top} ${bounds.right} ${bounds.bottom}`);
    return true;
  }

  /** Enable freeform (standalone window) support; failure does not affect the main flow */
  async ensureFreeform() {
    // Combine into one adb shell: 4 separate execFile calls take 600ms+ on Windows,
    // and this sits right in the "open the app" wait.
    const out = await this.shell(
      'settings put global enable_freeform_support 1 ; '
      + 'settings put global force_resizable_activities 1 ; '
      + 'settings put global development_settings_enabled 1 ; '
      + 'settings get global enable_freeform_support',
      { timeout: 12000 },
    ).catch(() => '0');
    return String(out).trim().split(/\r?\n/).pop().trim() === '1';
  }

  async wmSize() {
    const out = await this.shell('wm size');
    const m = /(\d+)x(\d+)/.exec(out.split('\n').pop() || out);
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
  }

  async androidVersion() {
    return (await this.shell('getprop ro.build.version.release').catch(() => '')).trim();
  }

  async sdkInt() {
    const v = await this.shell('getprop ro.build.version.sdk').catch(() => '0');
    return Number(v.trim()) || 0;
  }

  async screenshot() {
    const { stdout } = await this.exec(['exec-out', 'screencap', '-p'], { binary: true, timeout: 20000 });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  }

  async push(local, remote) {
    await this.exec(['push', local, remote], { timeout: 180000 });
  }

  async pull(remote, local) {
    await this.exec(['pull', remote, local], { timeout: 180000 });
  }

  async shellMkdir(remote) {
    await this.shell(`mkdir -p "${remote}"`);
  }

  async listRemote(remote) {
    const out = await this.shell(`ls -l "${remote}" 2>/dev/null`);
    return String(out).split('\n').map((line) => {
      const l = line.trim();
      if (!l || l.startsWith('total ')) return null;
      // Android's ls -l has "with group" and "without group" formats, and the date may be
      // "2026-11-12 18:52" or "Nov 12 18:52"; a fixed regex parses none of them.
      // The second number after the permission bits is the file size, and the last part is the name.
      const parts = l.split(/\s+/);
      if (parts.length < 6 || !/^[\-dl]/.test(parts[0])) return null;
      const sizeIdx = parts.findIndex((p, i) => i >= 2 && /^\d+$/.test(p)
        && /(\d{4}-\d{2}-\d{2}|^[A-Za-z]{3}$)/.test(parts[i + 1] || ''));
      if (sizeIdx < 0) return null;
      const size = Number(parts[sizeIdx]);
      // The file name follows the "hh:mm" token (the date part is 2-3 tokens, not fixed)
      const timeIdx = parts.findIndex((p, i) => i > sizeIdx && /^\d{1,2}:\d{2}(:\d{2})?$/.test(p));
      const name = parts.slice((timeIdx >= 0 ? timeIdx : sizeIdx + 2) + 1).join(' ');
      return name ? { isDir: parts[0][0] === 'd', size, name } : null;
    }).filter(Boolean);
  }

  /**
   * Remote listing with real mtimes (toybox stat).
   * ls -l dates are "month day hh:mm" and cannot be converted reliably, which makes sync
   * wrongly conclude "everything changed every time". Returning null means the device does
   * not support stat and the caller should fall back to listRemote.
   */
  async listRemoteStat(remote) {
    let out = '';
    try {
      out = await this.shell(`cd "${remote}" 2>/dev/null && find . -type f -exec stat -c '%Y|%s|%n' {} + 2>/dev/null`);
    } catch (_) {
      return null;
    }
    const rows = parseStatList(out);
    if (!rows) return null;
    return rows;
  }

  /** Clear app data */
  async clearData(pkg) {
    await this.shell(`pm clear ${pkg}`);
    // Clearing data also drops permissions, so the next launch must re-grant instead of hitting the permGranted cache
    try { store.upsertApp({ package: pkg, permGranted: false }); } catch (_) { /* ignore */ }
  }

  /** Export app data (run-as works on Windows/userdebug builds; otherwise fall back to adb backup) */
  async exportAppData(pkg, localTarPath) {
    const remote = `/sdcard/hydra-tmp-${pkg}.tar`;
    const cmd = `run-as ${pkg} tar -cf ${remote} . 2>/dev/null || (cd /data/data/${pkg} && tar -cf ${remote} .)`;
    await this.shell(cmd);
    await this.pull(remote, localTarPath);
    await this.shell(`rm -f ${remote}`).catch(() => {});
    return localTarPath;
  }

  async batteryOptimizeOff(pkg) {
    try { await this.shell(`dumpsys deviceidle whitelist +${pkg}`); } catch (_) { /* ignore */ }
  }

  /**
   * Grant all runtime permissions the app requested in one go.
   * Not granting them has two consequences: (1) the first launch shows a system
   * permission dialog and the user thinks "the app did not open"; (2) after clearing
   * data (pm clear) the permissions are gone and the app gets stuck on the permission page.
   *
   * Performance: `dumpsys package` starts an app_process in the guest (measured 1-3s), and
   * every `pm grant` / `cmd appops set` starts another. For an app with a dozen permissions
   * this alone eats 20+ seconds (logs show permissions granted going from +18s to +42s).
   * Granted permissions persist unless the app is reinstalled or pm clear runs, so record a
   * note in apps.json after granting and skip it on later launches; clear the flag on
   * data clear / reinstall.
   */
  async grantRuntimePermissions(pkg) {
    try {
      const rec = store.getApp(pkg);
      if (rec && rec.permGranted === true) return [];
    } catch (_) { /* no record read means treat as not granted */ }
    let dump = '';
    try {
      dump = await this.shell(`dumpsys package ${pkg}`, { timeout: 20000 });
    } catch (_) {
      return [];
    }
    const lines = String(dump).split(/\r?\n/);
    let inRuntime = false;
    const denied = [];
    for (const line of lines) {
      if (/^\s*runtime permissions:/.test(line)) { inRuntime = true; continue; }
      if (!inRuntime) continue;
      if (/^\s{0,6}\S/.test(line)) break; // left the runtime permissions section
      const m = /^\s+([A-Za-z0-9_.]+):\s*granted=(\w+)/.exec(line);
      if (m && m[2] === 'false') denied.push(m[1]);
    }
    const granted = [];
    // Send all grants at once: each pm grant process costs 150ms+ on Windows, so four or
    // five permissions add a second, and these commands have no dependencies between them.
    const cmds = [];
    for (const p of denied) cmds.push(`pm grant ${pkg} ${p}`);
    // Special permissions go through appops, otherwise dialogs still appear
    const ops = ['MANAGE_EXTERNAL_STORAGE', 'SYSTEM_ALERT_WINDOW', 'REQUEST_INSTALL_PACKAGES', 'WRITE_SETTINGS'];
    for (const op of ops) cmds.push(`cmd appops set ${pkg} ${op} allow`);
    if (cmds.length) {
      await this.shell(cmds.join(' ; '), { timeout: 20000 }).catch(() => '');
      granted.push(...denied);
    }
    // Only record the flag once the commands really ran: a mid-way failure retries next time and never leaves a false "already granted" state
    try { store.upsertApp({ package: pkg, permGranted: true }); } catch (_) { /* ignore */ }
    return granted;
  }

  /**
   * Get into "this app is the whole point" state:
   *  - dismiss the keyguard so a boot does not stop at the lock screen;
   *  - hide the status bar (keep the bottom navigation keys so back/home still work
   *    when the mouse is out of reach);
   *  - turn off system animations, a huge difference on low-end machines.
   * All settings-level commands, a few hundred milliseconds, harmless to repeat.
   */
  async prepareForeground() {
    // Formerly 7 commands were sent serially, each spawning a new adb process (150-250ms
    // on Windows), 1-1.7s total, all inside the "open the app" wait. One combined shell
    // leaves only a single round trip.
    const cmds = [
      'wm dismiss-keyguard',
      'settings put global policy_control immersive.status=*',
      'settings put secure immersive_mode_confirmations confirmed',
      'settings put global window_animation_scale 0',
      'settings put global transition_animation_scale 0',
      'settings put global animator_duration_scale 0',
      'settings put system screen_off_timeout 2147483647',
      // Large-screen taskbar: at tablet density Pixel Launcher keeps a Taskbar at the
      // bottom that covers app content and squeezes the keys into the bottom-left corner
      // (the "misplaced keys" users reported). See disableLauncherTaskbar(): applied again
      // on every launch, idempotent and just one extra round trip.
      'settings put global enable_taskbar 0',
      // Restore the image's standard connectivity-check endpoint on launch.
      'settings put global captive_portal_http_url http://connectivitycheck.gstatic.com/generate_204',
      'settings put global captive_portal_https_url https://connectivitycheck.gstatic.com/generate_204',
      'settings put global captive_portal_mode 0',
      // Note: do not write wm user-rotation / accelerometer_rotation here.
      // Orientation is decided uniformly by setOrientation / resetDisplayOverrides based
      // on the current landscape/portrait state; hard-coding lock 0 here would override
      // landscape back to portrait (image lying on its side).
    ];
    await this.shell(cmds.join(' ; '), { timeout: 15000 }).catch(() => {});
    return true;
  }

  /** Right mouse button / side buttons / hotkey mapping: goes through the persistent input channel, so right-click back no longer has 100ms-class latency */
  async _key(code) {
    try {
      await this.input(`input keyevent ${code}`);
    } catch (_) {
      // When the runtime just restarted and the persistent shell is not connected yet, fall back to one-shot adb instead of dropping the click
      await this.shell(`input keyevent ${code}`, { timeout: 6000 }).catch(() => {});
    }
  }

  async keyBack() { return this._key(4); }
  async keyForward() { return this._key(125); }

  /**
   * Switch between "phone layout / tablet layout".
   *
   * Key: **never change wm size**. Changing wm size alters the guest framebuffer's
   * physical size (720x1280 -> 1280x720) while the embedded Qt window keeps its old
   * size/orientation, so the image is squashed or lies on its side by 90 degrees and the
   * mouse coordinate mapping breaks too. Worse, a wm size override persists in /data and
   * survives reboots -- this is the root cause of the "black bars / not filled / clicks do
   * nothing" users kept seeing.
   *
   * Now only the logical density changes (wm density), and the framebuffer stays 720x1280
   * upright:
   *   - 320dpi -> smallestWidth 360dp -> phone layout
   *   - 190dpi -> smallestWidth 606dp (>=600dp) -> tablet / split layout
   * Size, orientation and click mapping are all unchanged, so nothing lies sideways, no
   * black bars appear, and clicks always land where they should.
   */
  async setOrientation(landscape) {
    try {
      // The auto-rotate switch is on by default (0.5.9): write accelerometer_rotation=1
      // into the guest so that switch reads as "on" in system settings. Orientation itself
      // is decided by `wm user-rotation lock 0` + set-ignore-orientation-request below and
      // is not affected by the sensor, so it will not spin. Users can turn it off under
      // Settings -> "Image auto-rotate" to get the old locked-at-0 behavior back.
      await this.shell(`settings put system accelerometer_rotation ${guestAutoRotate()}; wm size reset`, { timeout: 15000 });
      // Orientation lock **0** (not 1). The physical panel orientation is already decided
      // by hw.lcd.width/height (see doctor.lcdFor); locking 1 here would turn the landscape
      // panel into portrait logical space and the image would lie on its side by 90 degrees
      // -- exactly why "landscape never worked".
      await this.shell('wm user-rotation lock 0', { timeout: 15000 });
      // Key step: apps that declare portrait themselves get their way, so the
      // init=1280x720 landscape panel turns into cur=720x1280 portrait logical space and
      // the image lies down again. Enable "ignore app orientation requests" so the system
      // lays out by panel orientation. In portrait mode it must be explicitly disabled,
      // otherwise a leftover true from the previous landscape session shows a landscape
      // layout in the portrait panel. This command does not exist on API < 31; ignore failures.
      await this.shell(`wm set-ignore-orientation-request ${landscape ? 'true' : 'false'}`, { timeout: 15000 });
      // After enabling freeform / ignoring orientation requests, Android shows a one-time
      // "See and do more" coach mark ("Double-tap outside an app to reposition it..."). It
      // covers the app and users think the program is broken. Mark it as confirmed up front
      // and press back once as a fallback.
      await this.shell('settings put secure freeform_mode_confirmations confirmed', { timeout: 10000 });
      if (landscape) await this.shell('input keyevent KEYCODE_BACK', { timeout: 8000 });
      await this.shell(`wm density ${tabletDensity()}`, { timeout: 15000 });
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Disable the large-screen taskbar (the Taskbar from Android 12L+).
   *
   * Why it is needed: tablet layout pushes density down to 190dpi, which at 720 wide gives
   * sw606dp, past Android's 600dp large-screen breakpoint. Pixel Launcher then keeps a
   * NAVIGATION_BAR_PANEL taskbar at the bottom of the screen: translucent, covering app
   * content, with the back/home/recents keys squeezed into the bottom-left corner -- the
   * "misplaced keys" in user screenshots.
   *
   * It is not the system navigation bar (the gestural overlay one), so policy_control
   * immersive does not hide it; only global enable_taskbar does. And Launcher reads it only
   * at startup, so if it is already running it must be restarted. Both launcher package
   * names are poked to cover the Play and AOSP variants.
   */
  async disableLauncherTaskbar() {
    try {
      await this.shell('settings put global enable_taskbar 0', { timeout: 10000 });
      // grep -c exits with 1 when it matches 0 lines; append || true so it is not treated as failure
      const out = await this.shell(
        'dumpsys window windows | grep -c "Window #.*Taskbar" || true',
        { timeout: 12000 },
      ).catch(() => '0');
      const alive = parseInt(String(out).trim(), 10) || 0;
      if (alive > 0) {
        await this.shell(
          'am force-stop com.google.android.apps.nexuslauncher; am force-stop com.android.launcher3',
          { timeout: 12000 },
        ).catch(() => '');
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Wait until the app really paints its first frame.
   *
   * "The window is attached" and "the user can see the picture" are two different things:
   * after the Application process starts, Android 12+ shows a system Splash screen (app
   * icon on white) and only removes it once the Activity has drawn its first frame. If the
   * boot animation fades out before that, the user sees a white screen and thinks it froze
   * -- so the boot animation must stay until the system Splash window disappears.
   *
   * Decision: no "Splash Screen" record in the window list and focus is on the target
   * package. Returns false on timeout and the caller dismisses the animation anyway (never
   * trap the user in the animation because the check failed).
   */
  async waitForAppFirstFrame(pkg, { timeoutMs = 12000, intervalMs = 350 } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      // Must use `dumpsys window` (the full WINDOW MANAGER dump), not
      // `dumpsys window windows`: the latter only lists windows and has **no
      // mCurrentFocus line**, so focusOnApp is always false and the check always times out
      // -- the app has visibly painted but the boot animation stays pinned for the full 12s.
      const out = await this.shell(
        'dumpsys window | grep -E "Splash Screen|mCurrentFocus" | head -8',
        { timeout: 8000 },
      ).catch(() => '');
      const s = String(out);
      if (s.trim()) {
        const splashAlive = /Splash Screen/.test(s);
        const focusOnApp = s.indexOf(pkg) >= 0;
        if (!splashAlive && focusOnApp) return true;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
  }

  /** Clear wm size / density overrides left by older versions on startup (they persist in /data and keep the image sideways) */
  async resetDisplayOverrides(landscape = false) {
    try {
      // density must be set **before the app starts**.
      // This used to unconditionally run `wm density reset` and then have _healOrientation
      // (1.8s after the app started / every 60s) restore 190 -- a configuration change
      // while the app was running. Apps that cache DisplayMetrics (such as Modu) recompute
      // dp with the old density and the picture shrinks into the top-left corner with a
      // big blank area to the right -- the "Modu does not fill the window" users reported.
      // Now it is reset together with size here, so the launch path never changes density midway.
      await this.shell(`wm size reset; wm density ${tabletDensity()}`, { timeout: 15000 });
      await this.shell(`settings put system accelerometer_rotation ${guestAutoRotate()}`, { timeout: 15000 });
      // Keep consistent with setOrientation: the panel orientation decides, logical orientation locks at 0.
      await this.shell('wm user-rotation lock 0', { timeout: 15000 });
      await this.shell(`wm set-ignore-orientation-request ${landscape ? 'true' : 'false'}`, { timeout: 15000 });
      // Setting tablet density brings Launcher's taskbar up (sw>=600dp). It reads
      // enable_taskbar only at startup, so besides writing the switch, restart it if it is running.
      await this.disableLauncherTaskbar();
      return true;
    } catch (_) {
      return false;
    }
  }

  /** Current logical resolution (the window computes its aspect ratio from it after an orientation switch) */
  async displaySize() {
    try {
      const out = await this.shell('wm size', { timeout: 8000 });
      const o = /Override size:\s*(\d+)x(\d+)/.exec(out);
      if (o) return { w: Number(o[1]), h: Number(o[2]) };
      const p = /Physical size:\s*(\d+)x(\d+)/.exec(out);
      if (p) return { w: Number(p[1]), h: Number(p[2]) };
    } catch (_) { /* ignore */ }
    return null;
  }

  /** When the permission dialog is still on top (self-heal even if the user is away), press back to dismiss it */
  async dismissPermissionDialog() {    try {
      const top = await this.shell('dumpsys activity activities', { timeout: 12000 });
      if (/GrantPermissionsActivity|permissioncontroller/i.test(String(top))) {
        await this.shell('input keyevent 4', { timeout: 6000 }).catch(() => {});
        return true;
      }
    } catch (_) { /* ignore */ }
    return false;
  }

  /**
   * Display fit: in fullscreen, set the Android resolution to the monitor size (content
   * fills automatically); in window mode, restore the portrait preset. wm commands take
   * effect at runtime; no Android restart needed.
   */
  async setDisplaySize(width, height, density) {
    const w = Math.max(320, Math.round(Number(width) || 0));
    const h = Math.max(480, Math.round(Number(height) || 0));
    await this.shell(`wm size ${w}x${h}`);
    if (density) await this.shell(`wm density ${Math.max(120, Math.min(640, Math.round(density)))}`);
    return { w, h };
  }

  async resetDisplaySize() {
    await this.shell('wm size reset').catch(() => {});
    await this.shell('wm density reset').catch(() => {});
  }
}

module.exports = {
  AdbClient, AdbError, parseStatList, friendlyInstallError, friendlyLaunchError,
  componentArg, parseResolvedActivity, parseDeviceState, isUnauthorizedError, parsePmPaths,
};
