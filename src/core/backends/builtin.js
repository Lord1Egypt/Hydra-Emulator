'use strict';
/**
 * Base: Self-carried Google Android Emulator (QEMU))
 *
 * This is the default base of Hydra Emulator, and the only one with "full self-control".:
 * Add / emulator / System mirrors are downloaded and managed by Hydra Emulator and are not dependent on the user machine
 * There's already some simulator.
 *
 * Real realization in core/engine.js and core/emulator.js,
 * This document is a thin one, and the translation costs of their interfaces are agreed, so the upper floor doesn’t need to know.
 * How complicated is the self-study?
 *
 * Note: This backend relies on the Runtime example, which is built through deps.runtime.
 */
const fs = require('fs');
const path = require('path');
const { Backend, CAPS } = require('./base');
const { freeDiskMB } = require('../doctor');
const { diskRequiredMB, diskVerdict, hostProfile, memoryLimits, memVerdict, diskLimits } = require('../resources');

class BuiltinBackend extends Backend {
  static get id() { return 'builtin'; }

  static get label() { return 'QEMU (Android Emulator+QEMU))'; }

  static get summary() {
    return 'Zero third-party dependence: hydra downloads and manages Android 14 mirrors, ARM applications the mirror self-carried translation layer.'
      + 'Start about 25 seconds for the first time, and then clickboard.';
  }

  static get embedCapable() { return true; }

  constructor(appRoot, deps = {}) {
    super(appRoot, deps);
    this.rt = deps.runtime || null;
  }

  get caps() {
    return new Set([
      CAPS.provision, CAPS.snapshot, CAPS.resizeData,
      CAPS.resetData, CAPS.rotatePanel, CAPS.priority, CAPS.shutdown,
    ]);
  }

  // Real uses writeable fields instead of getting: base-class construction functions `this.serial = ''`,
  // If you define the getter here, the value will be thrown directly to TypeError.
  // When a real-time value is required, it is written by the insure() on its own initiative from Runtime.
  syncSerial() {
    if (this.rt) this.serial = this.rt.emuSerial || '';
    return this.serial;
  }

  running() { return !!(this.rt && this.rt.emuRunning); }

  async probe() {
    if (!this.rt) return { ok: false, found: false, detail: 'Uninitialised at Run' };
    const p = this.rt.provisioner.paths();
    const found = fs.existsSync(p.emulatorExe) || fs.existsSync(p.adbExe);
    return { ok: true, found, path: p.emulatorExe, detail: p.root };
  }

  async check() {
    if (!this.rt) return { ok: false, reason: 'Uninitialised at Run' };
    const env = await this.rt.provisioner.checkEnv().catch(() => null);
    if (!env) return { ok: false, reason: 'Failed to detect while running' };
    if (!env.adb.ok) return { ok: false, reason: 'Deficit adb', needs: 'adb' };
    if (!env.emulator.ok) return { ok: false, reason: 'Android Emulator', needs: 'emulator' };
    if (!env.sysimg.ok) return { ok: false, reason: 'Short-system Mirroring', needs: 'sysimg' };
    return { ok: true, env };
  }

  async resolveAdb() { return this.rt ? this.rt.adbPath() : ''; }

  async ensure({ onLog = () => {} } = {}) {
    if (!this.rt) return { ok: false, error: 'Uninitialised at Run' };
    const r = await this.rt.ensure({ onLog });
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'Android didn’t start when running.' };
    // Serial Synchronize with writeable fields (see syncSerial notes), after successful
    this.syncSerial();
    this.adbPath = this.rt.adbPath();
    return {
      ok: true, serial: this.serial, adbPath: this.adbPath, reused: !!r.reused, client: r.client, engine: 'emulator',
    };
  }

  /**
   * The image window with its own emulator does not give the candidate a final handle: it is used by WinAgent as process directory.
   * Find Emulator() (see core/win/agent.ps1), so that even if the window title changes, it will not be wrong.
   */
  async windowTargets() { return []; }

  /**
   * Whether the image window is embedded in the host.
   * isEmbededed by WinAgent (question whether the parent window of the current _emu is host)),
   * Retrieval conservatively when not injected: Take the base all the way to the old road, without the need for this door block.
   */
  async windowReady({ isEmbedded } = {}) {
    if (typeof isEmbedded !== 'function') return { ok: true };
    return { ok: !!isEmbedded };
  }

  async stop({ graceful = true } = {}) {
    if (!this.rt) return { ok: false, error: 'Uninitialised at Run' };
    const ok = await this.rt.stop({ graceful }).catch((e) => ({ error: e.message }));
    return { ok: ok !== false };
  }

  async install(component, onProgress = () => {}) {
    if (!this.rt) return { ok: false, error: 'Uninitialised at Run' };
    const prov = this.rt.provisioner;
    switch (component) {
      case 'runtime': return prov.installRuntimePack(onProgress);
      case 'adb': return prov.installAdb(onProgress);
      case 'emulator': return prov.installEmulator(onProgress);
      case 'sysimg': return prov.installSystemImage(onProgress);
      case 'playimg': return prov.installPlayImage(onProgress);
      case 'aehd': return prov.installAehd(onProgress);
      case 'qemu': return prov.installQemu(onProgress);
      default: return { ok: false, error: `Unknown Component ${component}` };
    }
  }

  usage() { return this.rt ? this.rt.usage() : { total: 0, items: [] }; }

  dataInfo() { return this.rt ? this.rt.emulator.dataInfo() : { ok: false }; }

  /**
   * Sets the page display with: host cap + current allocation.
   * The memory/ CPU of the self-carrying operation is written into the qemu command line and changed to the next Adrill effective;
   * Data partitions can expand (resizeData) in situ, without discarding installed applications.
   */
  resources() {
    const info = this.dataInfo() || {};
    const host = hostProfile();
    const eng = (this.rt && this.rt.settings && this.rt.settings.engine) || {};
    const freeMB = info.avdDir ? freeDiskMB(info.avdDir) : 0;
    const memMB = Number(eng.memoryMB) || 0;
    return {
      backend: 'builtin',
      host,
      limits: { ...memoryLimits(host.totalMB), ...diskLimits(freeMB) },
      wanted: { memoryGB: memMB ? Math.round((memMB / 1024) * 2) / 2 : 0, cores: Number(eng.cores) || 0 },
      current: {
        memoryGB: memMB ? Math.round((memMB / 1024) * 2) / 2 : 0,
        cores: Number(eng.cores) || 0,
        dataGB: Number(info.configuredGB) || 0,
        imageGB: Number(info.imageGB) || 0,
      },
      freeMB,
      pending: false,
      verdict: memVerdict(memMB, host.totalMB),
      note: 'The RAM/ CPU from running; next time to launch Android; data partitioning is changed to the rear point “immediate extension”——'
        + 'Android is using the Quick Start Disk to alert you to reset and re-establish with new capacity.',
    };
  }

  /**
   * Big package pre-screening: Besides the physical disk, it depends on whether the/data partition itself is enough.
   * The most common reason why 50GB class games cannot be loaded is not because download failed, but because the userdata mirror or
   * Default 6/8GB - Install_INSUFFIENT_STORAGE.
   */
  checkDiskFor(bytes) {
    const info = this.dataInfo() || {};
    const need = diskRequiredMB(bytes);
    const phys = diskVerdict(info.avdDir ? freeDiskMB(info.avdDir) : 0, need);
    if (!phys.ok) return phys;
    const capGB = Number(info.configuredGB) || 0;
    if (capGB && capGB * 1024 < need) {
      return {
        ok: false,
        message: `Endor Data Division is inadequate: Current ${capGB} GB, this game suggests at least ${Math.ceil(need / 1024)} GB.`
          + 'Please reboot Android when the “data partition capacity“ is increased in the settings engine.',
      };
    }
    return { ok: true, requiredMB: need };
  }

  async resizeData(mb) { return this.rt ? this.rt.emulator.resizeDataPartition(mb) : { ok: false }; }

  async resetData() { return this.rt ? this.rt.resetAndroidData() : { ok: false }; }

  dispose() {
    // Hand over to Runtime.dispose(): it will keep the qemu process, and the next start will take over directly.
  }

  diagnose() {
    const p = this.rt ? this.rt.provisioner.paths() : {};
    return {
      backend: 'builtin',
      serial: this.serial,
      root: p.root || '',
      emulator: p.emulatorExe || '',
      running: this.running(),
    };
  }
}

module.exports = { BuiltinBackend, BACKEND_ROOT: path.dirname(__dirname) };
