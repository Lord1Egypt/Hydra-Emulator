'use strict';
/**
 * runtime engine: Hydra Emulator's own QEMU+Android-x86 virtual machine
 *
 * Design principles:
 *  - Default full proprietor (builtin): adb / QEMU/ System mirrors are managed by Hydra Emulator without relying on any third-party simulator
 *  - All operations on Android go together, adb, so the engine can be replaced.
 *  - Virtual machine activated as required, free autorecycling; permanent re-use after start-up, installation/opening applications almost zero waiting
 */
const { spawn, execFile } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { AdbClient, isUnauthorizedError } = require('./adb');
const store = require('./store');
const { Provisioner } = require('./provision');
const { EmulatorEngine } = require('./emulator');
const doctor = require('./doctor');
const container = require('./container');
const backends = require('./backends');

const LOG_DIR = path.join(store.DATA_DIR, 'logs');
const MONITOR_PORT = 5556;
const EMU_PORT = 5554;
const EMU_SERIAL = `emulator-${EMU_PORT}`;

/** TCP Port is bugged.) */
function portAlive(port, timeout = 150) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (_) { /* ignore */ }
      resolve(v);
    };
    sock.setTimeout(timeout, () => fin(false));
    sock.once('connect', () => fin(true));
    sock.once('error', () => fin(false));
  });
}

class Runtime {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.provisioner = new Provisioner(appRoot);
    this.emulator = new EmulatorEngine(appRoot);
    this.vmProc = null;
    this.vmStarting = false;
    this.installing = false;
    this.lastActivity = Date.now();
    this._watchdog = null;
    this._freeformReady = false;
    this._client = null;
    this._bootLog = [];
    this._activeApps = new Set();  // Packaging session: Application window currently open
    // Backstage application for gravestoneization (force-stop but data retention) in multiwindow mode; next point for heat recovery.
    this._tombstoned = new Set();
    // The last web checker. Status column shows "Web Normal/Not Connected", but it’s a high-frequency roundup.,
    // You can’t run through the guest every time, shell; there’s only a cache of conclusions, and it’s out of date.
    this._lastNetwork = null;
    this.emuSerial = EMU_SERIAL;   // The port is dynamic, serial.
    /**
     * The back end is the right level: "Where does Android come from" out of this class.
     *
     * 0.5.6 Up here.**There's only one realization.**: Buildtin (with self-imulator+system image).
     * There are no more mumu / fydeos / atatach branches -- any machine, any settings, any residual configuration
     * It's all about running the belt, making sure that Hydra Emulator is running on his own forever, not with a third-party simulator.
     */
    this._backend = null;
    this._backendId = '';
    store.ensureDirs();
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  /**
   * Current backend example (one: bultin).
   * @returns {import('./backends/base').Backend}
   */
  get backend() {
    if (!this._backend) {
      const made = backends.create({
        appRoot: this.appRoot, settings: this.settings, runtime: this, store, log: (l) => this.log(l),
      });
      this._backend = made.backend;
      this._backendId = made.id;
    }
    return this._backend;
  }

  /**
   * Do you have any of the base phones you want?
   *
   * Now it’s only running on its own, and it’s always available.
   * This is a way to keep the top-of-the-line call.
   */
  async backendAvailable() {
    return { ok: true, id: 'builtin' };
  }

  /** Backend id, always 'builtin '; interface and log */
  get backendId() { return this.backend.id; }

  /** Discard old connections and port assumptions (change running-time directory, reset data after calling)) */
  resetBackend() {
    if (this._backend && this._backend.dispose) {
      try { this._backend.dispose(); } catch (_) { /* ignore */ }
    }
    this._backend = null;
    this._backendId = '';
  }

  get settings() { return store.getSettings(); }

  /** Whether the emulator engine is running */
  get emuRunning() { return this.emulator.running(); }

  // - - - - - Foundation - - -

  adbPath() {
    const s = this.settings;
    const p = this.provisioner.paths();
    // Take the adb forever first: the same device recognizes only one adb state and no extralines will appear repeatedly.
    if (fs.existsSync(p.adbExe)) return p.adbExe;
    if (s.adbPath && fs.existsSync(s.adbPath)) return s.adbPath;
    const local = path.join(this.appRoot, 'tools', 'platform-tools', 'adb.exe');
    if (fs.existsSync(local)) return local;
    return AdbClient.resolveAdb('', this.appRoot);
  }

  client(serial) {
    const useSerial = serial || this.emuSerial;
    const adbPath = this.adbPath();
    if (!this._client || this._client.serial !== useSerial || this._client.adbPath !== adbPath) {
      // Keep the old adb shell from holding the connection backstage when changing port/ adb
      if (this._client && this._client.disposeInput) this._client.disposeInput();
      this._client = new AdbClient({ adbPath, serial: useSerial });
    }
    return this._client;
  }

  touch() { this.lastActivity = Date.now(); }

  log(line) {
    this._bootLog.push({ t: Date.now(), line });
    if (this._bootLog.length > 300) this._bootLog.shift();
  }

  // -------------

  /**
   * Web snapshot for the status bar (resumed last medical examination).
   * More than five minutes later, it doesn’t believe: it may be out of the net, but it’s better to show "unknown" and not lie to the user.
   */
  _networkSnapshot() {
    const n = this._lastNetwork;
    if (!n) return null;
    if (Date.now() - n.at > 5 * 60 * 1000) return null;
    return { ok: n.ok, ip: n.ip, reason: n.reason };
  }

  /**
   * A cyber check-up from backstage (no obstruction of status return).
   * The status bar shows the network status, but the status() is a high-frequency rounder, and it is not always possible to run a shell in a guest.
   * So the first time (or after expiry) runs in the backstage, the conclusions are cached into _lastNetwork, and the next round of questioning will show.
   */
  _probeNetworkInBackground() {
    if (this._netProbing) return;
    const n = this._lastNetwork;
    if (n && Date.now() - n.at < 60000) return;  // Just checked in in a minute. Don't repeat it.
    this._netProbing = true;
    this.emulator.checkNetwork(this.adbPath())
      .then((r) => {
        this._lastNetwork = { ok: !!(r && r.ok), ip: (r && r.ip) || '', reason: (r && r.reason) || '', at: Date.now() };
      })
      .catch(() => { /* If you can't find it, just stay the same. Try again next round. */ })
      .finally(() => { this._netProbing = false; });
  }

  async status() {
    const backend = this.backend;
    const env = await this.provisioner.checkEnv();
    const s = this.settings;
    const client = this.client();
    const result = {
      mode: s.engine.mode,
      backend: backend.id,
      backendLabel: backend.label,
      installed: !!s.runtime.installed,
      env,
      engineKind: env.engine,
      emulatorOk: env.emulator.ok,
      emulatorVersion: env.emulator.version,
      sysimgOk: env.sysimg.ok,
      sysimgNote: env.sysimg.note,
      accel: env.accel,
      vmRunning: this.emulator.running() || !!(this.vmProc && !this.vmProc.killed),
      vmStarting: this.vmStarting,
      installing: this.installing,
      adbOk: env.adb.ok,
      adbVersion: env.adb.version,
      qemuOk: env.qemu.ok,
      qemuVersion: env.qemu.version,
      deviceOnline: false,
      android: '',
      sdk: 0,
      freeform: false,
      ready: false,
      needsSetup: null,
      error: '',
      serial: this.emuSerial,
      network: this._networkSnapshot(),
      autoProfile: this.emulator.profile ? doctor.describeProfile(this.emulator.profile) : '',
      diagnosis: this.emulator.lastDiagnosis || null,
      attempts: this.emulator.attempts || [],
      // "Why didn’t you get up last time?" The memory doesn’t fall back to the downboard record, and all the pages/diagnostics show the real reason.
      lastFailure: (this.emulator.lastFailure ? this.emulator.lastFailure() : null),
    };

    if (!env.adb.ok) {
      result.needsSetup = 'adb';
      result.error = 'Missing adb: Automatic download by clicking on "Key Deployment"';
      return result;
    }

    try {
      result.deviceOnline = await client.isOnline();
      if (result.deviceOnline) {
        const [android, sdk, ff] = await Promise.all([
          client.androidVersion().catch(() => ''),
          client.sdkInt().catch(() => 0),
          client.shell('settings get global enable_freeform_support').catch(() => '0'),
        ]);
        result.android = android;
        result.sdk = sdk;
        result.freeform = String(ff).trim() === '1' || this._freeformReady;
        this._probeNetworkInBackground();
      }
    } catch (e) {
      result.error = e.message;
    }

    if (result.deviceOnline) result.ready = true;
    else if (!env.emulator.ok) result.needsSetup = 'emulator';
    else if (!env.sysimg.ok) result.needsSetup = 'sysimg';
    // Doctor automatically returns software simulations without hardware acceleration,
    // and then try again with the GPU/accelerated/instant combination when the startup fails.
    else result.needsSetup = 'boot';

    result.phase = result.deviceOnline
      ? 'ready'
      : this.installing
        ? 'installing'
        : result.vmRunning
          ? 'booting'
          : 'idle';

    return result;
  }

  /**
   * List of equipment connected (for diagnostic purposes only).
   *
   * 0.5.6 No more "connect with running hours" mode: no active connect port here,
   * Only a list of the devices that adb currently sees, and to make sure that when it’s easy to discharge, "is our emulator-5554."
   */
  async probe() {
    try {
      const devices = await this.client().devices();
      return devices
        .filter((d) => d.state === 'device')
        .map((d) => ({ name: d.serial, serial: d.serial }));
    } catch (_) {
      return [];
    }
  }

  // ----------start/stop the virtual machine----------------------------------------------------------------------------------------------------------------------------

  buildArgs({ install = false, headless = false } = {}) {
    const s = this.settings;
    const p = this.provisioner.paths();
    const hv = this._hv || { whpx: false };
    const disk = s.runtime.diskPath || p.disk;
    const iso = s.runtime.isoPath || p.iso;
    const accel = hv.whpx ? 'whpx' : 'tcg';

    const args = [
      '-name', 'Hydra Emulator Runtime',
      '-machine', `q35,accel=${accel}`,
      '-cpu', hv.whpx ? 'host' : 'max',
      '-smp', String(Math.max(2, s.engine.cores || 4)),
      '-m', String(s.engine.memoryMB || 4096),
      '-rtc', 'base=localtime',
      '-netdev', 'user,id=net0,hostfwd=tcp:127.0.0.1:5555-:5555',
      '-device', 'virtio-net-pci,netdev=net0',
      '-vga', 'std',
      '-usb', '-device', 'usb-tablet',
      '-monitor', `tcp:127.0.0.1:${MONITOR_PORT},server,nowait`,
    ];

    if (headless || s.runtime.headless) args.push('-display', 'none');

    if (install) {
      args.push('-boot', 'order=d');
      args.push('-cdrom', iso);
    } else {
      args.push('-boot', 'order=c');
    }
    args.push('-drive', `file=${disk},if=virtio,format=qcow2,cache=writeback`);
    return args;
  }

  async boot({ install = false, onLog = () => {} } = {}) {
    const env = await this.provisioner.checkEnv();
    this._hv = env.hypervisor;

    // Prefer: Official emulator (with self-portfolio models and GPU translations, best experience))
    if (env.emulator.ok && env.sysimg.ok) {
      return this.bootEmulator({ env, onLog });
    }

    return this.bootQemu({ install, env, onLog });
  }

  /**
   * Start Android with official emulator.
   * Unlike QEMU+ISO, there's no "installation" here: mirrors themselves are systems, start and start.
   */
  async bootEmulator({ env, onLog = () => {} } = {}) {
    if (this.vmStarting) {
      const started = Date.now();
      while (this.vmStarting && Date.now() - started < 300000) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 500));
      }
      const c = this.client();
      if (await c.isOnline()) {
        await this.prepare(c);
        return { ok: true, client: c, reused: true };
      }
    }

    const accel = env && env.accel ? env.accel : await this.provisioner.emulatorAccel();
    if (!accel.ok) {
      onLog('Hardware acceleration not detected: Simulate autoback software (first opening is significantly slower without manual settings))');
    }

    this.vmStarting = true;
    try {
      // Probe to EmulatorEngine for start-up loop: it retrys with a new set of parameters when process exits/lethal logs
      // Adb command: get-state + getprop + pm path three times,
      // The flash shot is 300-500 ms short, stuck in the sense of the "point-opening application."
      let probeStart = Date.now();
      let errStreak = 0;
      let lastHeal = 0;
      let authHealed = false;  // This start() has been activated as a “unauthorized“ snapshot
      const diagUnauthorized = () => ({
        code: 'ADB_UNAUTHORIZED',
        title: 'Ancha debug authorization not completed (need to order "permit" once))',
        // Old text case to delete %USERSPROFILE%\.android\adbkey —— It's a real thing.**Reverse operations**:
        // After changing the new key, the old public key that was stored in the system is still in effect, and it’s not the same, but it’s never authorized.
        // (Android only writes a new public key when adb_keys do not exist. The correct course is in the emulator window.
        // One time “permissive“ or emptying Android data to allow the system to rebuild the authorization form.
        hint: 'The emulator stops in the “ Allow USB debugging? “ dialogue box. Please click “ Allow“ in the emulator window.——'
          + 'Check "All are allowed to use this computer for debugging" more and no more.'
          + 'If the window do not move or never appear: Set → Run → Clear Android data and try again'
          + '(It’ll clear the installed applications, re-installed them, and it won’t affect the APK files.',
      });
      const probe = async ({ serial }) => {
        if (!this.emulator.running()) return 'fatal';
        if (!this._probeClient || this._probeClient.serial !== serial) {
          this._probeClient = new AdbClient({ adbPath: this.adbPath(), serial });
        }
        const c = this._probeClient;
        try {
          const out = String(await c.shell('getprop sys.boot_completed; pm path android', { timeout: 8000 }));
          const lines = out.split(/\r?\n/).map((l) => l.trim());
          const booted = lines[0] === '1' || /^1$/.test(lines[0] || '');
          const pmReady = lines.some((l) => /^package:/.test(l));
          errStreak = 0;
          if (booted && pmReady) return 'ok';
          return booted ? 'pending' : 'booting';
        } catch (e) {
          errStreak += 1;
          // Key branch: adb shell may be "not started yet" or "cuffed in the authorized dialogue box".
          // The latter throws an anomaly in every shell round, and the old realization only continues when normal offline: reboot server
          // 240sx4 sets of parameters for drying up, and finally "unable to turn on at run time", lets the user think it’s a visual card/virtualization.
          // Press the wrong text here, then the state column of the devices (get-state confused))
          // Double confirmation unauthorized, hits used snapshot cold + accurate diagnosis, no longer empty etc.
          const raw = String((e && (e.raw || e.stdout || e.message)) || '');
          let unauthorized = isUnauthorizedError(raw);
          if (!unauthorized) {
            const st = await c.deviceState().catch(() => '');
            unauthorized = st === 'unauthorized';
          }
          if (unauthorized) {
            this.emulator.lastDiagnosis = diagUnauthorized();
            if (!authHealed) {
              authHealed = true;
              onLog('Add card in the “Appropriate USB debug“ authorization dialogue is running a used snapshot and cold start to re-inject the public key…');
              try { this.emulator.invalidateSnapshot(); } catch (_) { /* ignore */ }
              this.emulator._coldBoot = true; // Force cold start next round to re-inject emulator with adb public key
              await this.emulator.resetAdbServer().catch(() => {});
              this._probeClient = null;
            }
            // Give start() to retry a new set of parameters; the problem of dialylog disappears after cold starts
            return 'fatal';
          }
          // Other adb transfer anomaly: use the original restartserver to heal
          const now = Date.now();
          if (errStreak >= 6 && now - probeStart > 25000 && now - lastHeal > 30000) {
            lastHeal = now;
            onLog('Adb connection anomaly, resume adb server and wait…');
            await this.emulator.resetAdbServer().catch(() => {});
            this._probeClient = null;
          }
          return 'pending';
        }
      };

      const st = await this.emulator.start({
        headless: this.settings.engine.headless !== false,
        onLog,
        probe,
      });
      // start() fails with “return {ok:false}“ instead of dropping an anomaly (insufficiency of disk, repeated attempts but failure etc.).
      // The old realization does not look at this field, returns directly from the ok: True up -- the upper level considers “ready.“,
      // And then, adb, device not found, the user saw a "no reaction" rather than a real reason.
      if (!st || st.ok === false) {
        return {
          ok: false,
          error: (st && st.error) || 'Android didn’t start when running.',
          needsSpace: !!(st && st.needsSpace),
          attempts: (st && st.attempts) || [],
          diagnosis: this.emulator.lastDiagnosis,
          exitCode: st && st.exitCode,
        };
      }
      this.lastActivity = Date.now();
      this.emuSerial = st.serial || this.emulator.serial;
      const client = this.client(this.emuSerial);
      await this.prepare(client);
      // The snapshot should read "Repository when free": save 1-3GB immediately, and I/O will use the app grab disk that the user just clicks on.
      this._armSnapshotSave(20000);
      return { ok: true, client, engine: 'emulator', serial: this.emuSerial, profile: st.profile, network: st.network || null };
    } catch (e) {
      // Toss the automatic retest/diagnosis to UI to avoid a further vague "start failure"
      return { ok: false, error: e.message, diagnosis: e.diagnosis, report: e.report, attempts: e.attempts };
    } finally {
      this.vmStarting = false;
    }
  }

  // --------------------------------------------------------------------------------------------------------------------------------------------

  /** Save quickboot snapshot when free: only write disks when no window is applied, avoid and apply start-up robbery I/O */
  _armSnapshotSave(delay = 20000) {
    if (!this.emulator.running()) return;
    this.emulator.scheduleSnapshotSave(this.adbPath(), {
      delay,
      isIdle: () => this._activeApps.size === 0,
    });
  }

  /** For external calls such as the installer: re-store a snapshot after the application, and the next start is a second. */
  scheduleSnapshotSave(delay = 12000) { this._armSnapshotSave(delay); }

  /**
   * Force a snapshot, **♪ Waiting for free ♪**.
   *
   * When it’s needed: when it’s fixed, when it’s about to start running.
   * ScheduleSnapshotSave only writes the disk without applying the window, and applying it together will never be free.,
   * So the "net is connected" status never survived -- the next time it’s started, it’s back from the old snapshot.
   * Disconnected state, every time it’s repeated. This is an obvious way around idle judgment, and it’s a time-and-a time-out.
   */
  forceSnapshotSave(delay = 3000) {
    if (!this.emulator.running()) return;
    this.emulator.scheduleSnapshotSave(this.adbPath(), { delay, isIdle: () => true });
  }

  /**
   * Preheat: before the user clicks, direct the Android environment backstage.
   * WA/ APP is this idea -- environment is permanent, only once at the point of the icon.
   *  - Full silence: no windows, no mistakes, failure does not affect the normal opening of applications;
   *  Reuse the same Promise when it’s on or ready, and do not repeat the second one;
   *  Quemu is down to the lowest priority when it’s done.
   */
  prewarm({ onLog = () => {} } = {}) {
    if (this._prewarmPromise) return this._prewarmPromise;
    if (this._activeApps.size > 0) return Promise.resolve({ ok: true, skipped: 'busy' });
    const t0 = Date.now();
    const p = (async () => {
      try {
        const env = await this.provisioner.checkEnv();
        if (!(env.adb.ok && env.emulator.ok && env.sysimg.ok)) return { ok: false, skipped: 'not-ready' };
        const r = await this.ensure({ onLog: (m) => onLog(`Preheat: ${m}`) });
        if (r && r.ok) {
          // The user may have started the application during the preheat: it cannot be pushed to the idle priority.
          if (this._activeApps.size === 0) await this.emulator.setPriority('idle').catch(() => {});
          const ms = Date.now() - t0;
          this.log(`Preheat complete.(${Math.round(ms / 1000)}s)`);
          return { ok: true, bootMs: ms };
        }
        return { ok: false, error: r && r.error };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    })();
    this._prewarmPromise = p;
    const clear = () => { if (this._prewarmPromise === p) this._prewarmPromise = null; };
    p.then(clear, clear);
    return p;
  }

  async bootQemu({ install = false, env, onLog = () => {} } = {}) {
    if (!env.qemu.ok) throw new Error('QEMU not installed, please deploy when running first');
    if (install && !env.iso.ok) throw new Error('system image (ISO) not ready');

    const p = this.provisioner.paths();
    const disk = this.settings.runtime.diskPath || p.disk;
    if (!install && !fs.existsSync(disk)) throw new Error('The Android system to virtual disk has not yet been installed');

    this.vmStarting = true;
    const args = this.buildArgs({ install });
    const logFile = path.join(LOG_DIR, install ? 'qemu-install.log' : 'qemu.log');
    const out = fs.openSync(logFile, 'a');
    fs.writeSync(out, `\n\n=== ${new Date().toISOString()} ${install ? 'INSTALL' : 'BOOT'} ===\n${env.qemu.path} ${args.join(' ')}\n`);

    onLog(`Start running on(${env.hypervisor.whpx ? 'WhPX Hardware Acceleration' : 'Pure Software Simulation'})…`);
    if (!env.hypervisor.whpx) onLog(env.hypervisor.note);

    const proc = spawn(env.qemu.path, args, {
      cwd: path.dirname(env.qemu.path),
      windowsHide: true,
      stdio: ['ignore', out, out],
    });
    this.vmProc = proc;
    this.installing = install;
    this.lastActivity = Date.now();

    proc.on('error', (e) => {
      this.log(`spawn error: ${e.message}`);
      onLog(`Startup failed: ${e.message}`);
      this.vmProc = null;
      this.vmStarting = false;
    });
    proc.on('exit', (code) => {
      this.log(`qemu exit ${code}`);
      onLog(`Exited at running (code=${code})`);
      this.vmProc = null;
      this.vmStarting = false;
      this.installing = false;
    });

    await new Promise((r) => setTimeout(r, 1500));
    this.vmStarting = false;
    if (!this.vmProc) throw new Error(`QEMU startup failed, see log for details: ${logFile}`);

    // Load mode: ISO is a Linux installer, no adb, cannot be processed with "wait adb"
    if (install) {
      onLog('The installation program has been started. Please complete the installation with guidance in the virtual machine window');
      return { ok: true, install: true, needsManualInstall: true };
    }

    const client = this.client('127.0.0.1:5555');
    const timeout = env.hypervisor.whpx ? 180000 : 900000;
    const linked = await this.waitAdb(client, timeout, onLog);
    if (!linked) {
      return {
        ok: false,
        error: 'Virtual machine started, but adb failed to connect: Please try again after the "Developer Options →ADB over network" in virtual machine',
      };
    }
    const ready = await this.waitAndroidReady(client, Math.max(60000, timeout / 2), onLog);
    if (!ready.ok) {
      return {
        ok: false,
        error: ready.stage === 'kernel'
          ? 'The Android kernel has not been guided. Please see the runtime log (possibly mirrored or acceleration not effective))'
          : 'Android guided but system service not ready (possibly parked on the first setup interface, please complete the wizard in the virtual window))',
      };
    }
    await this.prepare(client);
    return { ok: true, client };
  }

  /**
   * Waiting for Android to be really available: adb online ≠ system available.
   * You have to wait until the sys.boot_completed=1 and the package manager can respond, or else an start will simply fail.
   */
  async waitAndroidReady(client, timeoutMs, onLog = () => {}) {
    const start = Date.now();
    let bootCompleted = false;
    let lastNotice = 0;
    while (Date.now() - start < timeoutMs) {
      /* eslint-disable no-await-in-loop */
      const online = await client.isOnline();
      if (!online) {
        await client.connect().catch(() => false);
      } else {
        if (!bootCompleted) {
          const v = await client.shell('getprop sys.boot_completed').catch(() => '');
          if (String(v).trim() === '1') {
            bootCompleted = true;
            onLog(`The Android kernel has been activated, awaiting system service ready.…(${Math.round((Date.now() - start) / 1000)}s)`);
          }
        }
        if (bootCompleted) {
          const pm = await client.shell('pm path android').catch(() => '');
          if (/package:/.test(pm)) {
            onLog(`Android ready.(${Math.round((Date.now() - start) / 1000)}s)`);
            return { ok: true, ms: Date.now() - start };
          }
        }
      }
      if (Date.now() - lastNotice > 15000) {
        lastNotice = Date.now();
        onLog(bootCompleted
          ? `Waiting for system service… ${Math.round((Date.now() - start) / 1000)}s`
          : `Starting Android… ${Math.round((Date.now() - start) / 1000)}s`);
      }
      /* eslint-enable no-await-in-loop */
      await new Promise((r) => setTimeout(r, 2000));
    }
    return { ok: false, stage: bootCompleted ? 'services' : 'kernel', ms: Date.now() - start };
  }

  async waitAdb(client, timeoutMs, onLog = () => {}) {
    const start = Date.now();
    let lastNotice = 0;
    const needConnect = String(client.serial || '').includes(':')
      && !/^emulator-/.test(client.serial);
    while (Date.now() - start < timeoutMs) {
      // Emulator 5554 is registered by emulator, no need adb condition
      if (needConnect) {
        // eslint-disable-next-line no-await-in-loop
        await client.connect().catch(() => false);
      }
      // eslint-disable-next-line no-await-in-loop
      if (await client.isOnline()) return true;
      if (Date.now() - lastNotice > 20000) {
        lastNotice = Date.now();
        onLog(`Waiting for Android to start… ${Math.round((Date.now() - start) / 1000)}s`);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  }

  async prepare(client) {
    if (!this._freeformReady) {
      try { this._freeformReady = await client.ensureFreeform(); } catch (_) { /* ignore */ }
    }
    await this._ensureSystemLocale(client);
    this.startWatchdog();
  }

  /**
   * Quick Boot restores the locale saved in the snapshot. If it differs
   * from the configured locale, schedule one cold boot to apply it.
   */
  async _ensureSystemLocale(client) {
    const want = this.emulator.guestLocale();
    if (!want || this._localeCorrection === want || !this.settings.engine.keepSnapshot) return;
    const current = await client.shell('settings get system system_locales', { timeout: 8000 }).catch(() => '');
    const primary = String(current).trim().split(',')[0];
    if (!primary || primary === 'null') return;
    if (primary.toLowerCase() === want.toLowerCase()) {
      this._localeCorrection = null;
      return;
    }
    this._localeCorrection = want;
    this.emulator.invalidateSnapshot();
    this.emulator.forceColdBootOnNextStart();
    this.log(`Android is using ${primary}. The next cold boot will apply ${want}.`);
  }

  /** Elegance stop: emulator go to the Console and QEMU go monitor */
  async stop({ graceful = true } = {}) {
    // When running at a stop, the previously cached guest network conclusion is invalidated. Otherwise the new machine rotates/ restarts
    // Not yet connected, waitForNetwork returns directly because of 8 seconds cache, ok, application black screen.
    this._lastNetwork = null;
    const adbPath = this.adbPath();
    if (this.emulator.running()) {
      await this.emulator.stop({ adbPath });
      return true;
    }
    // The assumed emulator (adoptExisting) has no proc handle in this process, the old logic will be direct.
    // Retrieval page -- it’s never shut off without a guard dog, and the container keeps holding the CPU/ memory.
    // This path is switched off with adb control, and then hit the bottom if necessary.
    //
    // Note: emulator.exe is just a starter, spawn qemu backs up, so "you pull yourself up."
    // Machines often fall into this branch.,
    // Users start with full cold at every point (25 seconds vs 8 seconds difference).
    let online = false;
    try { online = await this.client().isOnline(); } catch (_) { /* ignore */ }
    if (online && this.emuSerial) {
      if (adbPath && this.emulator.snapshotWorthSaving !== false) {
        await this.emulator.saveSnapshotNow(adbPath, { timeout: 60000 }).catch(() => false);
      }
      await this.client().exec(['emu', 'kill'], { timeout: 8000 }).catch(() => {});
      for (let i = 0; i < 10; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 400));
        // eslint-disable-next-line no-await-in-loop
        const still = await this.client().isOnline().catch(() => false);
        if (!still) break;
      }
      const still = await this.client().isOnline().catch(() => false);
      if (still) {
        const m = /:(\d+)$/.exec(this.emuSerial);
        const port = m ? Number(m[1]) - 1 : this.emulator.port;
        const pid = await this.pidOnPort(port);
        if (pid) {
          await new Promise((resolve) => {
            execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
          });
        }
      }
      this._activeApps.clear();
      return true;
    }
    if (!this.vmProc) return false;
    if (graceful) {
      try { await this.monitorCmd('system_powerdown'); } catch (_) { /* ignore */ }
      for (let i = 0; i < 16; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 500));
        if (!this.vmProc) return true;
      }
      try { await this.monitorCmd('quit'); } catch (_) { /* ignore */ }
      await new Promise((r) => setTimeout(r, 800));
    }
    if (this.vmProc) {
      try { this.vmProc.kill(); } catch (_) { /* ignore */ }
      this.vmProc = null;
    }
    return true;
  }

  // ---------------- QEMU monitor ----------------

  monitorCmd(cmd, { timeout = 4000 } = {}) {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: MONITOR_PORT });
      let buf = '';
      let sent = false;
      const done = (err, data) => {
        try { sock.destroy(); } catch (_) { /* ignore */ }
        if (err) reject(err); else resolve(data);
      };
      sock.setTimeout(timeout, () => done(new Error('monitor timeout')));
      sock.on('error', (e) => {
        // QEMU Quant and other commands will break the connection (ECONRESET/EPIPE), which is normal
        if (sent && /ECONNRESET|EPIPE/i.test(e.code || String(e))) done(null, buf);
        else done(e);
      });
      sock.on('data', (c) => {
        buf += c.toString();
        if (!sent && buf.includes('(qemu)')) {
          sent = true;
          sock.write(`${cmd}\n`);
          setTimeout(() => done(null, buf), 300);
        }
      });
      sock.on('connect', () => {
        if (!cmd) setTimeout(() => done(null, buf), 250);
      });
    });
  }

  async sendKey(keys, delay = 140) {
    for (const k of keys) {
      // eslint-disable-next-line no-await-in-loop
      await this.monitorCmd(`sendkey ${k}`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // - - - - installation of the system to virtual diskettes - - -

  async startInstaller({ onLog = () => {} } = {}) {
    const env = await this.provisioner.checkEnv();
    if (!env.iso.ok) {
      throw new Error(env.iso.reason || 'Please download/import the mirror of the Android system (ISO))');
    }
    if (!env.disk.ok) await this.provisioner.createDisk(this.settings.runtime.diskSizeGB || 24, () => {});
    this.installing = true;
    const r = await this.boot({ install: true, onLog });
    if (!r.ok) throw new Error(r.error || 'Failed to install environment startup');
    return r;
  }

  /** After installation is complete: Turn off the installation program → Write tag → Start directly from disk */
  async markInstalled() {
    if (this.installing) {
      try { await this.stop({ graceful: true }); } catch (_) { /* ignore */ }
    }
    store.saveSettings({ runtime: { installed: true } });
    this.installing = false;
    return true;
  }

  // ---------------- ensure ----------------

  /**
   * Take over the simulator that was left in the last run.
   * Each simulator has its own control table port (5554/5556...), adb port is +1.
   * The port can be connected and system has been boot_completed, just as we run it.,
   * So "Close Hydra Emulator" is a second entry, not a cold one.
   */
  /**
   * Find all remaining simulator control ports.
   * Can’t try from 5554 in sequence: Ports drift upwards with multiple startups (55545556 55558)…),
   * When there’s always a break in the fixed range, you’ll open a new machine.
   * Find all TCP ports that qemu listen to, and none will be leaked.
   */
  async emulatorPorts() {
    const run = (cmd, args) => new Promise((resolve) => {
      const { execFile } = require('child_process');
      execFile(cmd, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
        resolve(err ? '' : String(out || ''));
      });
    });
    const ports = new Set();
    try {
      const tl = await run('tasklist', ['/FO', 'CSV', '/NH']);
      const pids = new Set();
      for (const line of tl.split('\n')) {
        const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
        if (m && /qemu|emulator/i.test(m[1])) pids.add(m[2]);
      }
      if (!pids.size) return [];
      const ns = await run('netstat', ['-ano', '-p', 'TCP']);
      for (const line of ns.split('\n')) {
        const m = /:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
        if (m && pids.has(m[2])) ports.add(Number(m[1]));
      }
    } catch (_) { /* Back to port. */ }

    if (ports.size) {
      // Ports (even) and adb (+1) will be bugged, except for the control port.
      const all = [...ports].sort((a, b) => a - b);
      const consoles = all.filter((p) => ports.has(p + 1));
      return consoles.length ? consoles : all;
    }
    // Underground: Direct detection without qemu process information (connection denied will return immediately at minimal cost))
    const found = [];
    for (let port = 5554; port <= 5620; port += 2) {
      // eslint-disable-next-line no-await-in-loop
      if (await portAlive(port, 120)) found.push(port);
    }
    return found;
  }

  async adoptExisting({ onLog = () => {} } = {}) {
    const alive = await this.emulatorPorts();
    if (!alive.length) {
      onLog('When no last run is found, prepare for cold start.');
      return null;
    }
    onLog(`Found ${alive.length} Desktop Residues when running (port) ${alive.join(', ')}), Try to take over.`);

    // The adbserver may have kept the last process offline (a simulator reboots the adbd).),
    // Get-state back to offline forever, and it’ll be “no ready“ to kill a good machine.
    await this.client().exec(['kill-server'], { withSerial: false, timeout: 8000 }).catch(() => {});

    for (const port of alive) {
      const serial = `127.0.0.1:${port + 1}`;
      const c = this.client(serial);
      let booted = '';
      for (let i = 0; i < 6 && booted !== '1'; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await c.connect().catch(() => false);
        // eslint-disable-next-line no-await-in-loop
        const state = (await c.exec(['get-state'], { timeout: 5000 }).then((r) => r.stdout).catch(() => '')).trim();
        if (state === 'device') {
          // eslint-disable-next-line no-await-in-loop
          booted = (await c.shell('getprop sys.boot_completed', { timeout: 6000 }).catch(() => '')).trim();
        }
        if (booted !== '1') await new Promise((r) => setTimeout(r, 700));
      }
      if (booted !== '1') {
        onLog(`Found Last Run(${serial})But it's not ready. Turn it off and turn it back on.`);
        // The AVD directory has a lock: keeping this one will get the new case out of the way, in the form of "Why can't it work."
        // The adb won’t be connected, but it’s a process that can only be found at the port of the control table.
        const pid = await this.pidOnPort(port);
        if (pid) {
          await new Promise((resolve) => {
            const { execFile } = require('child_process');
            execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
          });
        }
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      this.emuSerial = serial;
      this.emulator.port = port;
      store.saveSettings({ device: serial });
      onLog(`_Other Organiser(${serial})`);
      // eslint-disable-next-line no-await-in-loop
      await this.prepare(c);
      return { ok: true, client: c, engine: 'emulator', reused: true };
    }
    return null;
  }

  /** What process is a TCP port listening to?) */
  async pidOnPort(port) {
    return new Promise((resolve) => {
      const { execFile } = require('child_process');
      execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true }, (err, stdout) => {
        if (err || !stdout) return resolve(0);
        const line = stdout.split('\n').find((l) => new RegExp(`:${port}\\s`).test(l) && /LISTENING/i.test(l));
        const m = line && /(\d+)\s*$/.exec(line.trim());
        return resolve(m ? Number(m[1]) : 0);
      });
    });
  }

  /**
   * Cleaning up the orphan simulator that was left behind from the last operation without being taken over.
   * When Hydra Emulator is turned off, emulator is detached and qemu will survive; it still holds the AVD lock at the next start.,
   * FATAL "Running multiple emulators with the same AVD".
   * The same logic is used to try again the path (killAttempt) to achieve a condensed EmularEngine.
   */
  async killOrphanEmulators({ onLog = () => {} } = {}) {
    return this.emulator.killOrphanProcesses({ onLog });
  }

  /**
   * Preheat may occur simultaneously with user clicks, sharing a Promise,
   * Avoiding one simulator from each side after "no online" (AVD lock conflict + double memory).
   */
  async ensure({ onLog = () => {} } = {}) {
    if (this._ensurePromise) return this._ensurePromise;
    const p = this._ensureInner({ onLog });
    this._ensurePromise = p;
    const clear = () => { if (this._ensurePromise === p) this._ensurePromise = null; };
    p.then(clear, clear);
    return p;
  }

  async _ensureInner({ onLog = () => {} } = {}) {
    const client = this.client();
    if (await client.isOnline()) {
      /**
       * "Online" is not "workable."
       *
       * The simulator process just exited, or the hundreds of milliseconds that are being rebooted, adb yes.
       * `-s emulator-5554 get-state` Still. `device`...the old logic is straight on this.
       * Returned used, the panel-oriented start-up chain is to get a dead client. ——
       * Every order in the back. `device 'emulator-5554' not found`(Actual
       * 0.2 seconds to "ready", application start-up all over the place.
       *
       * Add a true command here: you can execute the getprop before the device is actually in.
       * Switch on, that's normal, re-use and wait;,
       * Keep going down to the pull-up.
       */
      const probe = await client.shell('getprop sys.boot_completed', { timeout: 5000 })
        .then((v) => String(v == null ? '' : v).trim())
        .catch(() => null);
      if (probe !== null) {
        await this.prepare(client);
        return { ok: true, client, engine: 'builtin', reused: true };
      }
      onLog('Adb reports the device online but the command is not working (simulator may be restarting), pulling back when running…');
    }

    // Last time, Hydra Emulator left the simulator, but it wasn’t in the new process.
    // Word, adb server may be rebooted -- isOnline() alone will be judged as "unrunt-time.",
    // And then a new one. And here we take over the live simulator, and we're not gonna open the machine and eat the memory.
    const adopted = await this.adoptExisting({ onLog });
    if (adopted) return adopted;

    // The rest of the session is left to the rest of the process.
    try {
      const devices = await client.devices();
      const running = devices.find((d) => /^emulator-\d+$/.test(d.serial) && d.state === 'device');
      if (running) {
        this.emuSerial = running.serial;
        const m = /(\d+)$/.exec(running.serial);
        if (m) this.emulator.port = Number(m[1]);
        const c2 = this.client(running.serial);
        await this.prepare(c2);
        return { ok: true, client: c2, engine: 'emulator', reused: true };
      }
    } catch (_) { /* If you don’t find it, you’ll be able to pull up. */ }

    // The process is still under way, but the device is offline (most of it is in the lead):
    if (this.emulator.running()) {
      onLog('Restarting when stuck running detected…');
      await this.emulator.stop({ adbPath: this.adbPath() });
    }

    const s = this.settings;

    // Unique Path: Run with Self-Tracker
    // Single file distribution mirrors are compressed, first expanded (spanned by seconds).
    // Do not swallow the error if it fails: otherwise checkEnv() in the back will only say "less mirror of the system.",
    // Users will think it’s not downloading, not decompression failure (disk full/ file damaged).
    await this.provisioner.materializeImages(onLog).catch((e) => {
      onLog(`System mirroring failed: ${e.message}`);
      this.log(`materialize failed: ${e.message}`);
    });
    const env = await this.provisioner.checkEnv();

    // Path to emulator: mirroring is the system, not the step of "installation to disk"
    if (env.emulator.ok && env.sysimg.ok) {
      // Turn off the qemu of Hydra Emulator, which may have left behind the untaken emulator, which is still alive.),
      // FATAL "Running multiimulators with the same AVD".
      // When the takeover fails, the orphans are cleared and then turned on, making sure that the “turn off and open“ will get up.
      await this.killOrphanEmulators({ onLog }).catch(() => {});
      try {
        const r = await this.boot({ onLog });
        if (r.ok) return { ok: true, client: r.client, engine: 'emulator', profile: r.profile, network: r.network || null };
        return {
          ok: false, error: r.error, env,
          diagnosis: r.diagnosis, report: r.report, attempts: r.attempts, exitCode: r.exitCode,
        };
      } catch (e) {
        return { ok: false, error: e.message, env };
      }
    }

    // QEMU Path (user-owned ISO and installed on virtual disk))
    if (!s.runtime.installed) {
      return {
        ok: false,
        needsSetup: env.emulator.ok ? 'sysimg' : 'provision',
        error: env.emulator.ok
          ? 'The system image: "Down-down-system image" is fine.'
          : 'Component not yet deployed at operational time',
        env,
      };
    }

    try {
      const r = await this.boot({ onLog });
      if (r.ok) return { ok: true, client: r.client, engine: 'builtin' };
      return { ok: false, error: r.error };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ----------------------------------------------------------------------------------------------------------------------------------------

  /**
   * Realization of "open like a container":
   * Android environment only leads once and permanently (quickboot snapshot + taking over)),
   * And every time you open App, it's just a am start + to hang the existing window in and not run the whole system again.
   * Three more things to lower the pressure on the system.:
   *   - Stop the process of other app users so that the environment runs only what is needed by App;
   *   - Give qemu a qemu priority for the front desk when there is a window;
   *   - Only when a window is available to start file sync/ notify rotation (onActive return to UI level).
   */
  async beginApp(pkg, { onActive = () => {} } = {}) {
    const first = this._activeApps.size === 0;
    this._activeApps.add(pkg);
    this.touch();
    const s = this.settings;
    const mode = (s.engine && s.engine.priorityMode) || 'balanced';
    // A schedule level applied to the front desk. Balanced with nooral (not below)):
    // Below will make qemu hungry at a busy time in the system, in the form of a video decoding of the frame, and the click will take a while to respond. ——
    // That’s the main reason for the “click without the hand.“ Noormal is just in the same room as the desktop, not extra CPU/RAM/GPU.
    const level = mode === 'game' ? 'game' : 'normal';

    if (first) {
      // The app’s going to open: delay the free memory snapshot, and don’t grab the disk while the application’s active.
      this.emulator.cancelSnapshotSave();
    }
    // Every time you open/cut a response, make sure that priority is in place: endApp drops free qemu to idle,
    // If it doesn’t come back again, it stops at a low priority.,
    // It’s the target time. It’s the script. It’s very low cost.
    await this.emulator.setPriority(level).catch(() => {});
    if (first) {
      try { onActive(true); } catch (_) { /* Failed to start query without opening application */ }
    }

    // Multi-window mode (project B): New application**Not anymore.** Force-stop other applications, otherwise they're not open.
    // Instead of recovering the “backstage” from the gravestone strategy, which allows multiple co-existences, the memory will not be out of control.
    // Turn off the multiWindow and return to the old “just leave the current“ behavior, and promise to retreat.
    if (s.engine && s.engine.multiWindow) {
      const roles = container.sessionRoles([...this._activeApps], pkg);
      const { tombstone } = container.planTombstones({
        background: roles.background,
        keepRecent: Number(s.engine.keepBackground) >= 0 ? Number(s.engine.keepBackground) : 1,
      });
      const cmds = container.buildTombstoneCommands(tombstone);
      if (cmds.length) {
        await this.client().shell(cmds.join(' ; '), { timeout: 20000 }).catch(() => '');
        for (const p of tombstone) this._tombstoned.add(p);   // Write down the hanged ones. Next time the heat's back on.
        this.log(`Multi-Window: Front desk ${pkg}, Keep Backstage ${roles.background.length - tombstone.length} One, gravestone. ${tombstone.length} One.`);
      } else {
        this.log(`Multiple windows: ${roles.count} Accompaniment, no recovery required`);
      }
      return { ...roles, plan: { commands: cmds, stopped: tombstone } };
    }

    const installed = store.getApps().map((a) => a && a.package).filter(Boolean);
    const state = container.nextSessionState([...this._activeApps], 'open', pkg);
    const plan = container.buildSessionCommands({
      pkg,
      installed,
      deep: !!(s.engine && s.engine.deepTrim),
      // App just finished am start, which may be the result of an error on the backstage at this point; clean it up to endApp
      killBackground: false,
    });
    if (plan.commands.length) {
      await this.client().shell(plan.commands.join(' ; '), { timeout: 20000 }).catch(() => '');
    }
    this.log(container.describeSession(state, plan));
    return { ...state, plan };
  }

  /**
   * Turn off an application window: stop its process; if the last window, let the container enter
   * The "resident but hardly resource-consuming" status (deprived from the clean-up platform + Android idle + qemu).
   * No, no AVD -- next time it’s open or in seconds.
   */
  async endApp(pkg, { onIdle = () => {} } = {}) {
    this._activeApps.delete(pkg);
    await this.client().forceStop(pkg).catch(() => {});
    const state = container.nextSessionState([...this._activeApps], 'close', pkg);
    if (state.idle) {
      const s = this.settings;
      const cmds = container.buildIdleCommands({ deep: !!(s.engine && s.engine.deepTrim) });
      await this.client().shell(cmds.join(' ; '), { timeout: 15000 }).catch(() => '');
      // game to maintain high priority even if the window is not applied for the time being,
      // If you don’t start at the next point, you’ll have a significant delay in the first input.
      const keepHigh = (s.engine && s.engine.priorityMode) === 'game';
      await this.emulator.setPriority(keepHigh ? 'normal' : 'idle').catch(() => {});
      // Now the most freest: put your memory in a snapshot, and the next time you’re going to go back to work instead of cold.
      this._armSnapshotSave(8000);
      try { onIdle(true); } catch (_) { /* ignore */ }
      this.log('Packaging stopped (Android resident, 0 application processes, qemu minimum priority))');
    }
    return state;
  }

  get activeApps() { return [...this._activeApps]; }
  get containerIdle() { return this._activeApps.size === 0; }

  /** Resume disabled packages when setting pages to switch to “ Deep Crops “ */
  async restoreSystemApps() {
    const cmds = container.buildRestoreCommands();
    await this.client().shell(cmds.join(' ; '), { timeout: 20000 }).catch(() => '');
    return true;
  }

  setGuestPriority(level) { return this.emulator.setPriority(level); }

  // --------------------------------------------------------------------------------------------------------------------------------------------

  /**
   * Reverse: Ensure that the “logical display space“ and the “physical panel“ are in the same direction.
   *
   * Jurisprudence (actual)):
   *   Init=1280x720... cur=1280x720 Normal (cross-screen panel + screen logic))
   *   Init=1280x720... cur=720x1280
   * When you see the cur in contrast to the init’s width order, it means there’s an application/system that’s turned back.,
   * Re-locking and ignoring the application's directional request at this point will correct without reopening the virtual machine.
   *
   * Writes only when there is a genuine inconsistency, normally only read-only once every 60 seconds.
   */
  async _healOrientation() {
    if (!this.emulator || !this.emulator.running()) return;
    const wantLand = !!this.settings.display.landscape;
    const panelLand = typeof this.emulator.panelLandscape === 'function'
      ? this.emulator.panelLandscape() : null;
    // ♪ The reboot, not here to fix it (runLaunch.beforeStart will handle))
    if (panelLand !== null && panelLand !== wantLand) return;
    const c = this.client();
    const out = await c.shell('dumpsys window displays', { timeout: 12000 }).catch(() => '');
    const init = /init=(\d+)x(\d+)/.exec(out);
    const cur = /cur=(\d+)x(\d+)/.exec(out);
    if (!init || !cur) return;
    const initLand = Number(init[1]) > Number(init[2]);
    const curLand = Number(cur[1]) > Number(cur[2]);
    if (initLand !== curLand) {
      // Relock course + Ignore application direction request + Restore direction
      this.log(`Init=${init[1]}x${init[2]} cur=${cur[1]}x${cur[2]} Lie down, re-concentrate`);
      await c.resetDisplayOverrides(wantLand).catch(() => {});
      await c.setOrientation(wantLand).catch(() => {});
      return;
    }
    // If you don't lie down, you're in a state.:
    //   - mSetIgnoreOrganizationRequest (screen time must be true, otherwise the panel will be misdirected))
    //   - wm denity over 190 (720 wide sw606dp ~600dp))
    // If these two are lost, they’re going back to the cell phone pattern -- it’s what the flatbed is all about.
    // A light check here, which one is missing.
    const densityWanted = (this.settings.display || {}).tabletMode !== false ? 190 : null;
    let ignoreOk = true;
    if (wantLand) {
      const win = await c.shell('dumpsys window | grep -oE "mSetIgnoreOrientationRequest=(true|false)"', { timeout: 8000 }).catch(() => '');
      ignoreOk = /mSetIgnoreOrientationRequest=true/.test(String(win));
    }
    let densityOk = true;
    if (densityWanted) {
      const dens = await c.shell('wm density', { timeout: 6000 }).catch(() => '');
      // "Override denity: N" line exists and equals the target value
      const m = /Override density:\s*(\d+)/.exec(String(dens));
      densityOk = !!m && Number(m[1]) === densityWanted;
    }
    if (!ignoreOk || !densityOk) {
      this.log(`Show state concentration: ignore-orientation=${ignoreOk} density=${densityOk} → Completing`);
      if (!ignoreOk) await c.shell('wm set-ignore-orientation-request true', { timeout: 8000 }).catch(() => {});
      //  Only**Not applied to front desk**It's only a matter of time.
      // Redensity triggers configuration changes +Access to recreate and caches the DisplayMetrics application
      // (Ink readings. They’ll recalculate dp according to the old density, and the image will shrink to a small piece of the upper left corner, full of blanks on the right. ——
      // The user sees the ink readings not filled with windows. The application is reserved for the next start-up path when running.,
      // ResetDisplay Overrides will be set before an start.
      if (!densityOk) {
        if (this._activeApps.size === 0) {
          await c.shell(`wm density ${densityWanted}`, { timeout: 8000 }).catch(() => {});
        } else {
          this.log(`density=${densityWanted} Missing but applied to front desk: Skip, set on next start (avoiding image shrinks))`);
        }
      }
    }
  }

  startWatchdog() {
    if (this._watchdog) return;
    this._watchdog = setInterval(async () => {
      const s = this.settings;
      // Self-correction: Apply / Activity Rebuild / System Window may have user-rotation or
      // “Ignoring application request“ is changed back. Once it’s changed back, the screen screen will lie 90 degrees.
      // (The user says, "Plate mode software is always 90 degrees lie." Here, read the real state every round.,
      //  Only**It's not the same.**It's only right when it's done, and the normal situation is zero.
      await this._healOrientation().catch(() => {});
      const limit = (s.engine.idleShutdownMinutes || 0) * 60000;
      if (!limit) return;
      // The assumed emulator has no local proc suffix, vmRunning will be false:
      // It used to be directly retruded here, which led to the container never being recycled.
      if (!this.vmRunning) {
        const online = await this.client().isOnline().catch(() => false);
        if (!online) return;
      }
      if (this._activeApps.size > 0 || Date.now() - this.lastActivity < limit) return;
      try {
        const running = await this.client().runningPackages();
        const alive = running.filter((p) => !/launcher|systemui|settings|inputmethod|android\.systemui/i.test(p));
        if (alive.length === 0) await this.stop();
        else this.lastActivity = Date.now();
      } catch (_) { /* ignore */ }
    }, 60000);
    if (this._watchdog.unref) this._watchdog.unref();
  }

  get vmRunning() { return this.emulator.running() || !!(this.vmProc && !this.vmProc.killed); }

  // -----------diagnosis / thinner (for UI calls) -------------------------------------------------------------------------------------------------------------------

  async diagnostics() {
    const env = this.provisioner.paths();
    const checked = await this.provisioner.checkEnv();
    const profile = this.emulator.profile || doctor.autoProfile({
      settings: this.settings,
      accel: checked.accel,
      emulatorVersion: checked.emulator.version || '',
      diskMB: doctor.freeDiskMB(store.DATA_DIR),
    });
    // The attachments in the memory are only valid for this session; it is empty when the user resets and returns the report.
    // This time we’ll use the failure of the last fall, and we’ll bring the end of emulator.log -- otherwise we’ll report.
    // There's only one thing that UNKNOWN can't see the real reason.
    const persisted = this.emulator.lastFailure ? this.emulator.lastFailure() : null;
    const liveAttempts = this.emulator.attempts || [];
    const attempts = liveAttempts.length ? liveAttempts : ((persisted && persisted.attempts) || []);
    const diagnosis = this.emulator.lastDiagnosis || (persisted && persisted.diagnosis) || null;
    const exitCode = this.emulator.lastExitCode != null ? this.emulator.lastExitCode
      : (persisted ? persisted.exitCode : null);
    let logLines = this.emulator.recentLog(300);
    if (!logLines.length && this.emulator.tailLogFile) logLines = this.emulator.tailLogFile(300);
    return doctor.writeReport({
      dataDir: store.DATA_DIR,
      profile,
      logLines,
      extra: {
        attempts,
        diagnosis,
        exitCode,
        exitMeaning: persisted && persisted.exitMeaning ? persisted.exitMeaning : '',
        lastFailure: persisted,
        runtimeDir: env.root,
        serial: this.emuSerial,
        bootLog: this.bootLog,
      },
    });
  }

  usage() { return require('./layers').summary(this.provisioner.paths().root); }

  /**
   * Recovery of old image/ old AVD/ lock file/ snapshot when running.
   * The root of the previous "point cleaner": keepSnapshots on the current AVD while running
   * Quick start snapshots (mam. img) were removed, and there was little clarity in the AVD environment alone.
   * Now the caller can be visible includeSnapshots: when you stop running, you can actually recycle a snapshot.
   */
  async cleanup({ apply = false, aggressive = false, includeSnapshots = false } = {}) {
    let stoppedVm = false;
    if (includeSnapshots && this.vmRunning) {
      await this.stop().catch(() => {});
      stoppedVm = true;
    }
    const report = require('./layers').prune(this.provisioner.paths().root, {
      apply, aggressive, keepSnapshots: !includeSnapshots && this.vmRunning,
    });
    // If the preview phase stops, give the user a hint: clear to restart manually
    return { ...report, apply, stoppedVm };
  }

  /**
   * Completely reset Android data (empty /data user partition + Installed application + Quick Start snapshot),
   * Revert AVD to "just installed system, no third party app" clean state.
   * This item actually removes the user data mirror from 8-16GB, has to be confirmed twice (UI responsible) and only moves.
   * Current activity AVD(hydra.avd), no read-only image, no other AVD.
   * Keep config.ini / hardware-qemu.ini, AVD still in force, and the next point startup will re-cold the startup data.
   * @returns {{ok:boolean, reclaimed:number, avdDir:string, error?:string}}
   */
  async resetAndroidData() {
    const fs = require('fs');
    const path = require('path');
    try {
      if (this.vmRunning) await this.stop().catch(() => {});
      const avdDir = path.join(this.provisioner.paths().avdHome, 'hydra.avd');
      let reclaimed = 0;
      if (fs.existsSync(avdDir)) {
        for (const e of fs.readdirSync(avdDir, { withFileTypes: true })) {
          const p = path.join(avdDir, e.name);
          // Delete: User Data Mirror (with qcow2 variance + base), Quick Start Screenshot, Residue Lock File/ Lock Directory.
          // Reservation: config.ini / hardware-qemu.ini / AVD.conf / cache.img / encryptionkey* / intrd /
          //       *.ini/*.txt/*.cache - these are AVD identities and infrastructure,
          //       Delete AVD direct failure or next start-up anomaly. Next time the app is open, the simulator will be recreated using -wipe-data semantic /data.
          const isUserdata = /^userdata(-qemu)?(-[0-9]+)?\.img(\.qcow2)?$/.test(e.name)
            || /^userdata\.img(\.qcow2)?\.\d+$/.test(e.name);
          const isSnapshot = /^snapshots(\.stale-\d+)?$/.test(e.name);
          const isLock = /\.lock$/.test(e.name);
          if (!e.isDirectory() && !isUserdata && !isLock) continue;
          if (e.isDirectory() && !isSnapshot && !isLock) continue;
          try {
            if (e.isDirectory()) {
              const s = require('./layers').dirSize(p);
              fs.rmSync(p, { recursive: true, force: true });
              reclaimed += s;
            } else {
              const s = fs.statSync(p).size;
              fs.rmSync(p, { force: true });
              reclaimed += s;
            }
          } catch (_) { /* We're on hold. We'll clear it next time. */ }
        }
      }
      // After user data mirrors have been deleted, the user side "installed" records should also be cleared,
      // Otherwise the desktop/ starter shows that there is no longer a real one.
      try { store.saveApps([]); } catch (_) { /* ignore */ }
      return { ok: true, reclaimed, avdDir };
    } catch (e) {
      return { ok: false, reclaimed: 0, avdDir: '', error: e.message };
    }
  }

  /**
   * AndroidWifi is connected to the "saved but not automatically" (non-destructive, non-restarting, unclear data).
   * For practical reasons, see emularator.repairWifi.
   *
   * @returns {Promise<boolean>Are you connected?
   */
  async repairWifi(adbPath = '') {
    const adb = adbPath || (typeof this.adbPath === 'function' ? this.adbPath() : '');
    return this.emulator.repairWifi(adb).catch(() => false);
  }

  /**
   * Waiting for virtual network.
   *
   * Actual: `sys.boot_completed` Just the system is up, Wi-Fi connections + DHCP will have to wait.
   * Ten seconds till more than a minute before we get the data on the front page as soon as we go in.,
   * Pages are rendered into a whole black bottom when no web is available. (Personal window is local, so it is displayed normally)),
   * Users see "dot consent and continue to blackscreen." So wait for the network to be ready before pulling up.
   *
   * @returns {Promise<{ok:boolean,reason:string,ip?:string,gateway?:string}>}
   */
  async waitForNetwork({ timeoutMs = 90000, onLog = () => {}, adbPath = '' } = {}) {
    const done = (r) => {
      this._lastNetwork = { ok: !!(r && r.ok), ip: (r && r.ip) || '', reason: (r && r.reason) || '', at: Date.now() };
      return r;
    };
    // Speed optimization: After heat start / rotation restart, this function will be called continuously on the starting path
    // (One more time, installer. Launch.
    // The network is stable, and immediately confirmed in eight seconds, saves the whole round of adb traffic.
    // (It’s Online + checkNetwork twice, hundreds of milliseconds to one second.
    // Window takes 8 seconds: enough to cover continuous calls and not to cheat users for long after a genuine break.
    // Note that stop() will clear _lastNetwork, so reboot without misusing the old state before shutdown.
    const cached = this._lastNetwork;
    if (cached && cached.ok && Date.now() - cached.at < 8000) return cached;
    const t0 = Date.now();
    let last = null;
    let lastNotice = 0;
    let offlineSince = 0;
    let notConnectedStreak = 0;
    while (Date.now() - t0 < timeoutMs) {
      const online = await this.client().isOnline().catch(() => false);
      if (!online) {
        // The virtual opportunity to reboot has been a while before the adb is online, and you can't just drop off the offline.
        // (This was the case before: to reset the data and return to the device-offline immediately, and to find that the “repair failed“.
        if (!offlineSince) offlineSince = Date.now();
        if (Date.now() - offlineSince > 45000) return done({ ok: false, reason: 'device-offline' });
      } else {
        offlineSince = 0;
        // eslint-disable-next-line no-await-in-loop
        last = await this.emulator.checkNetwork(adbPath || this.adbPath()).catch(() => null);
        if (last && last.ok) return done(last);
        // `wifi-not-connected` It’s "Wi-Fi’s not connected," it’s not "We’re still waiting for DHCP."
        // It's a waste of time to die in this state:
        // It’s always “saved but not automatically connected.“ That’s why we’re done early.,
        // Let’s get the caller on a really effective reconnect, and don’t spend 20 seconds on the ground.
        // Three times instead of two: Wi-Fi was supposed to be associated for a few seconds when it started.,
        // Too early to go to the setup page, but rather to interrupt its own connection.
        if (last && last.reason === 'wifi-not-connected') {
          notConnectedStreak += 1;
          if (notConnectedStreak >= 3) return done(last);
        } else {
          notConnectedStreak = 0;
        }
      }
      if (Date.now() - lastNotice > 10000) {
        lastNotice = Date.now();
        onLog(`Waiting for Android’s virtual network.… ${Math.round((Date.now() - t0) / 1000)}s`);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 3000));
    }
    return done(last || { ok: false, reason: 'timeout' });
  }

  /**
   * Refurbishing the "Andrea virtual machine has no network."
   * Most of the time, it's just that Wi-Fi's going to be a little slower than it's going to be.,
   * **I don't need it.**Clears user data; prompts users to "replace Android data" only after waiting for time to run.
   *
   * @returns {Promise<{ok:boolean, network?:object, boot?:boolean, error?:string}>}
   */
  /**
   * Make sure the virtual machine is connected: wait, wait until you get cold start.
   * It’s a cure for "black screen after the red bean dot agrees": applications have to be activated before the network is ready.
   *
   * @returns {Promise<{ok:boolean,reason?:string,ip?:string,gateway?:string}>}
   */
  async ensureNetwork({ onLog = () => {}, firstWaitMs = 25000, secondWaitMs = 90000 } = {}) {
    let net = await this.waitForNetwork({ onLog, timeoutMs: firstWaitMs });
    if (net && net.ok) return net;
    // Try the cheapest way to do it: put on the Android Wifi, which is "saved but not automatically".
    // This step starts colder, smaller in magnitude than clear data -- no reboot of virtual machines, no user data.
    // That’s the real reason why most of the "virtual machines don’t have access" on the live machine.
    if (!this._wifiRepairTried) {
      this._wifiRepairTried = true;
      onLog('Virtual machine not connected to Wi-Fi, trying to reconnect…');
      try {
        const fixed = await this.emulator.repairWifi(this.adbPath());
        if (fixed) {
          net = await this.waitForNetwork({ onLog, timeoutMs: 15000 });
          if (net && net.ok) {
            onLog(`Network restored.(${net.ip || ''}), Saves serviceable status, just next time.`);
            try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
            return net;
          }
        }
      } catch (_) { /* If you fail to fix it, you take the heavy path below. */ }
    }
    // Cold start is expensive, and one process is done only once: otherwise, every dot starts again.,
    // What users feel is that "dotting must wait a few minutes."
    if (this._netColdBootTried) return net;
    this._netColdBootTried = true;
    onLog('The network is still not in place and is being re-tested once the virtual machine is activated in cold.…');
    try {
      await this.stop({ graceful: false }).catch(() => {});
      this.emulator.forceColdBootOnNextStart();
      const boot = await this.ensure({ onLog });
      if (!boot || !boot.ok) return { ok: false, reason: 'boot-failed' };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
    net = await this.waitForNetwork({ onLog, timeoutMs: secondWaitMs });
    if (net && net.ok) {
      // I want a snapshot of the network as soon as it’s normal, and I want the card back together when it’s restored.
      try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
    }
    return net;
  }

  /**
   * Refurbishing the "Andrea virtual machine has no network."
   * Order: Cold start (no data) network → data can’t be reset (to be discarded).
   *
   * @returns {Promise<{ok:boolean, network?:object, boot?:boolean, wiped?:boolean, error?:string}>}
   */
  async repairNetwork({ onLog = () => {} } = {}) {
    try {
      // Staircase repair, from the cheapest point of view, never lose data without losing it.:
      //   1) Reconnect Wi-Fi (no restart, no data))
      //   2) Cold start (no snapshots, still no data)
      //   3) Last reset data
      onLog('Rehabilitating virtual network: trying to reconnect Wi-Fi first (without affecting installed applications))…');
      if (!this.vmRunning) {
        const boot0 = await this.ensure({ onLog });
        if (!boot0 || !boot0.ok) {
          return { ok: false, error: (boot0 && boot0.error) || 'The virtual machine didn\'t start.', boot: false };
        }
      }
      this._wifiRepairTried = true;
      let fixed = false;
      try { fixed = await this.emulator.repairWifi(this.adbPath()); } catch (_) { fixed = false; }
      if (fixed) {
        const net1 = await this.waitForNetwork({ onLog, timeoutMs: 30000 });
        if (net1 && net1.ok) {
          try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
          onLog(`Network restored.(${net1.ip || ''}), A snapshot is available.`);
          return { ok: true, network: net1, boot: true, wiped: false };
        }
      }
      // Step 2: Cold start, bypass a possible "netless" snapshot
      onLog('Reconnecting failed, starting a virtual machine cold (no snapshot, data retention))…');
      await this.stop({ graceful: false }).catch(() => {});
      await new Promise((r) => setTimeout(r, 2500));
      this.emulator.forceColdBootOnNextStart();
      const boot = await this.ensure({ onLog });
      if (!boot || !boot.ok) {
        return { ok: false, error: (boot && boot.error) || 'The virtual machine didn\'t start.', boot: false };
      }
      let network = await this.waitForNetwork({ onLog, timeoutMs: 90000 });
      if (network && network.ok) {
        try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
        onLog(`Network restored.(${network.ip || ''}), A snapshot is available.`);
        return { ok: true, network, boot: true, wiped: false };
      }
      // Step 3: No web, only reset the data.)
      onLog('Still no network, reset Android data and reboot (application list will be maintained, automatically reloaded when clicked))…');
      if (this.vmRunning) await this.stop({ graceful: false }).catch(() => {});
      // Give the last qemu / netsimd a little time to clear, or-wipe-data will crash AVD locks.
      await new Promise((r) => setTimeout(r, 2500));
      this.emulator.forceWipeOnNextStart();
      const boot2 = await this.ensure({ onLog });
      if (!boot2 || !boot2.ok) {
        return { ok: false, error: (boot2 && boot2.error) || 'The virtual machine didn\'t start.', boot: false, wiped: true };
      }
      network = await this.waitForNetwork({ onLog, timeoutMs: 240000 });
      if (network && network.ok) {
        // Now, put the "Network Normal" status in a snapshot: the next time you restore it, the netcard status will be restored together.,
        // Turn it off or it'll go back to non-net status.
        try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
        onLog(`Network restored.(${network.ip || ''} Gateway ${network.gateway || 'Katar'}), A snapshot is available.`);
      } else {
        onLog('The reset is still unconnected. Check if the network/firewall intercepts the simulator (netsimd walk back to the ring port).');
      }
      return { ok: !!(network && network.ok), network, boot: true, wiped: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  dispose() {
    if (this._watchdog) clearInterval(this._watchdog);
    if (this._client && this._client.disposeInput) this._client.disposeInput();
    // Backend fittings only run when they’re self-carried; dispose only does its own cleanup and does not move any external simulators.
    if (this._backend && this._backend.dispose) {
      try { this._backend.dispose(); } catch (_) { /* ignore */ }
    }
    this.emulator.cancelSnapshotSave();
    // Qemu!:
    //  1) Strength cuts off quickshots of Quickboot, leaving only a few GBs of ram.img shell,
    //     The next time you start the plane, it fails to start completely cold, which is the direct reason why "it takes two minutes to open every time."
    //  2) Keep it, next time open Hydra Emulator, you can take over directly, and use the WSA/ appliance computer again.
    // If you unmount, take another route.
    if (this.vmProc) {
      try { this.vmProc.kill(); } catch (_) { /* ignore */ }
      this.vmProc = null;
    }
  }

  get bootLog() { return this._bootLog.slice(-60); }
}

module.exports = { Runtime, MONITOR_PORT };
