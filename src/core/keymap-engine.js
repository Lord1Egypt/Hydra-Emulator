'use strict';
/**
 * Keymap runtime Engine
 *
 * When applying the front desk of the window, intercept keyboard events check the map of the current application and convert to adb input command.
 * Work with pointer.js: Mouse Qt Native + Right/ Roller Hook,
 * The keyboards go here. They don't interfere with each other.
 *
 * Design constraints:
 *  - Pure Node module, not dependent on Electric BrosseserWindow;
 *  - The adb command was injected. `execInput(cmd)` Recall send, decoupling AdbCliet;
 *  - Every order has a minimum interval (default 50ms) to prevent a fast chain of adb shell queuing;
 *  - Maps are stored by applying the name of the package, toggle the application automatically.
 */

const { lookup, toCommand } = require('./keymap');

class KeymapEngine {
  /**
   * @param {object} opts
   * @param{Function} opts. execInput (cmd)=>Promise - Send adb shell input command
   * @param{Function} opts.getSize() = {width, height} = Current LCD dimensions
   * @param{number} [opts.minInterval=50] The minimum distance between two commands (ms))
   */
  constructor({ execInput, getSize, minInterval = 50 } = {}) {
    this._exec = execInput || (() => Promise.resolve());
    this._getSize = getSize || (() => ({ width: 720, height: 1280 }));
    this._minInterval = minInterval;
    this._lastExec = 0;
    this._enabled = false;
    // pkg → mappings[]
    this._maps = new Map();
  }

  /** Set up a map of an application */
  setMap(pkg, mappings) {
    if (!pkg) return;
    if (!mappings || !mappings.length) { this._maps.delete(pkg); return; }
    this._maps.set(pkg, mappings);
  }

  /** Get a map of an application */
  getMap(pkg) { return this._maps.get(pkg) || []; }

  /** Enable/ Disable */
  enable(on) { this._enabled = !!on; }
  get enabled() { return this._enabled; }

  /**
   * Deal with a keyboard event.
   * @param {string} key Electron KeyboardEvent.key
   * @param{string} pkg Current front desk application package name
   * @returns {Promise<boolean>} Whether this key (true = mapd and sent) has been consumed)
   */
  async handleKey(key, pkg) {
    if (!this._enabled || !pkg) return false;
    const mappings = this._maps.get(pkg);
    if (!mappings || !mappings.length) return false;
    const hit = lookup(mappings, key);
    if (!hit) return false;
    const { width, height } = this._getSize();
    const cmd = toCommand(hit, width, height);
    if (!cmd) return false;
    // Stream limit: prevent fast line-up
    const now = Date.now();
    const wait = Math.max(0, this._minInterval - (now - this._lastExec));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this._lastExec = Date.now();
    try { await this._exec(cmd); } catch (_) { /* Input input failure does not affect the game */ }
    return true;
  }
}

module.exports = { KeymapEngine };
