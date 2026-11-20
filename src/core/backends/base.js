'use strict';
/**
 * Backend appropriate layer -- pulls the “Where Andres“ thing out of Runtime.
 *
 * Background: Hydra Emulator originally had only one base (with Google Android Emulator/ QEMU)),
 * The life cycle of the engine (opening, snapshots, free recycling, mirror downloads) is all written down in core/engine.js.
 * But this part of the experience is "double click APK, double click icon open, each application a clean window",
 * There are only three demands on the base.:
 *
 *   1. There is an adb device that connects to it (package/ start/ input/ screenshot);
 *   2. There is a window that can access HWND ’s Android image (into our own window with SetParent);
 *   3. Enables the device to be activated/stopped.
 *
 * 0.5.6 Retain only one achievement: bultin (with self-imulator+system image).
 * This level of interface is kept to keep the whole “Where's Android from“ thing in the engine.js.,
 * It is also easier not to start the main engine process when there is a real need to replace it in the future.
 * But...**No more support for third-party simulators/ system-level running**(Mumu / Thunder / Blue Collapse / WSA Not Answered)
 *
 * Agreement (all realizations must be respected)):
 *  - All methods can be called together, and it’s done in a manner that makes sense; repeat it cannot start two.
 *  - Do not throw an anomaly at the upper level (for hints only) if any of the steps fail.
 *  - Don’t assume you own it.
 */

/** Base Position: Top determines which menus/backbacks to show or skip */
const CAPS = {
  /** Can download/position run by itself (sphere, emulator, adb)) */
  provision: 'provision',
  /** Saves a quick start snapshot.) */
  snapshot: 'snapshot',
  /** Resize Data Split */
  resizeData: 'resizeData',
  /** A complete reset of Android data (/data)) */
  resetData: 'resetData',
  /** We can change the physical panel direction (real screen, by restarting)) */
  rotatePanel: 'rotatePanel',
  /** It’s a process priority (selling virtual machines to front desk applications)) */
  priority: 'priority',
  /** Can shut down completely (unmounting/departing call)) */
  shutdown: 'shutdown',
  /** The image window is created by third-party software and cannot be used too much to “learn” its window (to avoid taking the user's own simulator).) */
  sharedHost: 'sharedHost',
};

class Backend {
  /**
   * @param{object} approot root directory (resources/app after packing))
   * @param{object} deps shared dependency: {store, log}
   */
  constructor(appRoot, deps = {}) {
    this.appRoot = appRoot || '';
    this.deps = deps || {};
    /** adb material (e.g. emulator 5554 / 127.0.0.1:16384)) */
    this.serial = '';
    /** Absolute path of adb.exe */
    this.adbPath = '';
    /** Last Error for Diagnosis */
    this.lastError = '';
  }

  /** id (writing settings, cannot be changed at will)) */
  static get id() { return 'base'; }

  /** Name displayed on interface */
  static get label() { return 'Unnamed Backend'; }

  /** In one sentence, set the page to explain what the base is. */
  static get summary() { return ''; }

  /** Whether this base meets the requirements of the Embedded Window (not to be met only for anatach)) */
  static get embedCapable() { return false; }

  get id() { return this.constructor.id; }

  get label() { return this.constructor.label; }

  /** Capabilities Pool, see CAPS */
  get caps() {
    return new Set();
  }

  has(cap) { return this.caps.has(cap); }

  /** Whether the current base is already running (not required to connect adb)) */
  running() { return false; }

  /**
   * There’s no such base on the machine.
   * For "Auto pick a usable base", it must be fast (<1.5s) and not have side effects.
   * @returns {Promise<{ok:boolean, found:boolean, path?:string, detail?:string}>}
   */
  // eslint-disable-next-line class-methods-use-this
  async probe() { return { ok: true, found: false }; }

  /**
   * Ready to check: can the user use it to install the application now?
   * @returns {Promise<{ok:boolean, reason?:string, needs?:string}>}
   */
  // eslint-disable-next-line class-methods-use-this
  async check() { return { ok: false, reason: 'Not achieved' }; }

  /** Parsing available adb paths (priority, second base, last system PATH)) */
  async resolveAdb() { return ''; }

  /**
   * Make sure it’s working when it’s running: switch off when it’s not on, connect.
   * @param {object} o { onLog }
   * @returns {Promise<{ok:boolean, serial?:string, adbPath?:string, reused?:boolean, error?:string}>}
   */
  // eslint-disable-next-line class-methods-use-this
  async ensure(o = {}) { return { ok: false, error: 'Not achieved' }; }

  /**
   * The candidate for the Android view window HWND (hexadecimal or decimal string array, sorted in priority).
   * When WinAgent gets it, try SetParent one by one, the first to be built will be successfully embedded.
   * @returns {Promise<string[]>}
   */
  // eslint-disable-next-line class-methods-use-this
  async windowTargets() { return []; }

  /**
   * Whether the image window is ready (can stop hiding/start embedding).
   * Default: Take the candidate window and be ready. We pulled up the window with the emulator.,
   * The default realization is enough; the hook is kept for the future to have a place to wait when it’s running.
   *
   * @param {object} o { isEmbedded?: () => boolean }
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async windowReady(o = {}) { // eslint-disable-line no-unused-vars
    const targets = await this.windowTargets().catch(() => []);
    return targets.length ? { ok: true } : { ok: false, reason: 'no-window' };
  }

  /**
   * Hide the screen window (open/ preheat phase, users shouldn’t see simulators).
   * I’m going back quietly when I don’t get the window.
   * @returns {Promise<string|null>Hided HWND
   */
  async hideWindow() { return null; }

  /** Stop runtime */
  // eslint-disable-next-line class-methods-use-this
  async stop(o = {}) { return { ok: false, error: 'Not achieved' }; }

  /** Downloading/deployment of missing components (only base with CAPS.provision needs to be achieved)) */
  // eslint-disable-next-line class-methods-use-this
  async install(component, onProgress) { return { ok: false, error: 'The backend does not support automatic deployment' }; }

  /** Statistical occupancy (set page " runtime occupancy " )) */
  // eslint-disable-next-line class-methods-use-this
  usage() { return { total: 0, items: [] }; }

  /** Data partition information */
  // eslint-disable-next-line class-methods-use-this
  dataInfo() { return { ok: false }; }

  /** Adjust Data Division */
  // eslint-disable-next-line class-methods-use-this
  async resizeData(mb) { return { ok: false, error: 'The backend does not support adjusting data partitions' }; }

  /** Reset Andres data completely */
  // eslint-disable-next-line class-methods-use-this
  async resetData() { return { ok: false, error: 'The backend does not support data replacement' }; }

  /** Release resources (Hydra Emulator calls when quit; defaults to do nothing)) */
  // eslint-disable-next-line class-methods-use-this
  dispose() {}

  /** Diagnostic information (writing problem report)) */
  // eslint-disable-next-line class-methods-use-this
  diagnose() { return {}; }
}

module.exports = { Backend, CAPS };
