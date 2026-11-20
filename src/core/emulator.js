'use strict';
/**
 * Emulator engine: Drives Google official Android Emulator running as Hydra Emulator.
 *
 * The biggest difference from the old version: "A set of parameters can run on all computers" is no longer assumed.
 *  Use doctor.chooseProfile() to automatically deduce parameters by memory/CPU/disk/acceleration/engine version;
 *  2. Automatic downscaling retry on startup failure (GPU backend → software simulation minimum memory freeze startup);
 *  3. Dynamic pick-up of idle ports, clear AVD locks, Chinese-language paths to short paths, automatic waste snapshots after mirror changes;
 *  Quickboot + small data partition, shared read-only floors with "like a container" and recovered.
 *
 * Probe returns are provided by Runtime to determine whether Android is really ready.
 */
const { spawn, spawnSync, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { Provisioner } = require('./provision');
const doctor = require('./doctor');
const drivers = require('./drivers');
const userdata = require('./userdata');

const AVD_NAME = 'hydra';
const SNAPSHOT_NAME = 'hydra';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Windows has translated emulator/ qemu’s exit code into a human voice.
 * 0xC00005(3221225477) is the most common one in a crash: access to conflict, multiple measurements.
 * A graphic card driver / Vulkan backend crashes at the start of a guest, and a rewrite can bypass it.
 */
function describeExitCode(code) {
  // When the signal ends, the code is null.),
  // It cannot be considered a "normal exit", but it is not unusual to talk about it, but to return to the empty string to show the caller as it is.
  if (code == null) return '';
  switch (Number(code)) {
    case 0: return 'Exit normal';
    case 1: return 'Error starting parameter or environment';
    case 3221225477: return '0xC0000005 access violation, possibly a renderer crash';
    case 3221225725: return '0xC00000FD stack overflow';
    // 0xC0000135 just states that "a dependency on DLL has not been loaded successfully," and cannot be concluded as VC++.
    // The same code is used when the store page is drawn from the WindowsApps directory.
    // Which DLL is, depending on the WER's FaultingModule Name, do not draw conclusions for users on UI.
    case 3221225781: return '0xC0000135: a DLL failed to load (cause unknown). See the user manual.';
    case 3221225506: return '0xC0000022 access denied (check driver or permissions)';
    case 3221225595: return '0xC000007B: wrong executable architecture or damaged DLL';
    default: return '';
  }
}

class EmulatorEngine {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.provisioner = new Provisioner(appRoot);
    this.proc = null;
    this._log = [];
    this.port = 5554;
    this.adbPort = Number(process.env.ANDROID_ADB_SERVER_PORT) || 5044;
    this.profile = null;
    this.attempts = [];
    this.lastDiagnosis = null;
    this.lastExitCode = null;
    /**
     * The driver (compatible patch) effect of this startup, and the list of the drivers in the target.
     * Filled by start() _resolveDrivers(); buildArgs/ env/ insureAvd read only it.
     */
    this._driverEffect = null;
    this._driversApplied = [];
    // A snapshot of Ram.bin ≈ assigned to the virtual machine memory (2-4GB).
    // Cold starters should not have given it a few GB disks, only to save it when it's really slow.
    this.snapshotWorthSaving = null;
  }

  log(line) {
    this._log.push({ t: Date.now(), line });
    if (this._log.length > 600) this._log.shift();
  }

  get settings() { return store.getSettings(); }

  /**
   * Put the last start down.
   * The old version is only in memory (this. attachments), and the user restarts the Hydra Emulator before exporting the diagnostic report.,
   * The report is about: [ ], bootLog: [ ] a blank, only to be looked in the log -- and that’s what it is.
   * The direct reason why #20/#25 "the report is attached but not seen why".
   */
  _persistFailure(extra = {}) {
    try {
      const dir = path.join(store.DATA_DIR, 'logs');
      fs.mkdirSync(dir, { recursive: true });
      const data = {
        at: new Date().toISOString(),
        exitCode: this.lastExitCode,
        exitMeaning: describeExitCode(this.lastExitCode),
        diagnosis: this.lastDiagnosis,
        attempts: this.attempts,
        ...extra,
      };
      fs.writeFileSync(path.join(dir, 'last-failure.json'), JSON.stringify(data, null, 2), 'utf8');
    } catch (_) { /* Failed to drop disk does not affect main process */ }
  }

  /** Read the previous failure record (diagnostic report / call before starting)) */
  lastFailure() {
    try {
      return JSON.parse(fs.readFileSync(path.join(store.DATA_DIR, 'logs', 'last-failure.json'), 'utf8'));
    } catch (_) { return null; }
  }

  _clearFailure() {
    try { fs.rmSync(path.join(store.DATA_DIR, 'logs', 'last-failure.json'), { force: true }); } catch (_) { /* ignore */ }
  }

  get serial() { return `emulator-${this.port}`; }

  /** Emulator.exe with system image Directory (Setwire Time Directory for Priority Users, Back to Repository engine/) */
  locate() {
    const p = this.provisioner.paths();
    const emuCandidates = [p.emulatorExe, path.join(this.appRoot, 'engine', 'emulator', 'emulator.exe')];
    const emulatorExe = emuCandidates.find((c) => fs.existsSync(c)) || '';
    const img = this.provisioner.systemImageInfo();
    return { emulatorExe, sysImgDir: img.dir, sysImgOk: img.ok, root: emulatorExe ? path.dirname(path.dirname(emulatorExe)) : p.root };
  }

  /** Mirror selection: API 34 Play uses it to stop the user from cutting "compatible mode" */
  imageChoice() {
    const play = this.provisioner.playImageInfo();
    const base = this.provisioner.systemImageInfo();
    if (play.ok) {
      return { compat: true, api: play.api, tag: play.tag, dir: play.dir, abi: 'x86_64' };
    }
    return { compat: false, api: base.api, tag: base.tag, dir: base.dir, abi: base.abi || this.provisioner.paths().sysAbi };
  }

  /**
   * Quickshot.
   * Snapshots save memory and disk mirrors at the same time, load new applications/clean up data and load old snapshots,
   * The user will see "a reboot of the app just installed and gone."
   */
  invalidateSnapshot() {
    this.cancelSnapshotSave();
    this._snapSaved = false;
    try {
      const snapDir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots');
      fs.rmSync(snapDir, { recursive: true, force: true });
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Clear the locks from the last unusual exit.
   * - Watch out, hardware-qemu.ini.lock yes.**Contents**Not a file, bsdtar ’rmSync(force) cannot delete it,
   * “Running multiple emulators with the same AVD“
   * (This is what happens when you’re killed by force. It has to be deleted.
   */
  clearLocks(avdDir) {
    try {
      for (const f of fs.readdirSync(avdDir)) {
        if (!/\.lock$/i.test(f)) continue;
        try {
          fs.rmSync(path.join(avdDir, f), { recursive: true, force: true });
        } catch (_) { /* If you’re occupied, skip it. We’ll clear it next time. */ }
      }
    } catch (_) { /* ignore */ }
  }

  /**
   * Do you really have a copy of the AVD directory?** Full**A quick shot.
   * It is not enough to judge that the directory is not empty: saving is interrupted with an empty shell with only 12 bytes snapshot.pb,
   * Emulator tries to load, fails to return cold start,
   * White for a few seconds. This is a file-size check, cleans the empty shell and the old version of the default_boot (single 3GB).
   */
  hasSnapshot() {
    const base = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots', SNAPSHOT_NAME);
    const size = (p) => { try { return fs.statSync(p).size; } catch (_) { return 0; } };
    const pb = size(path.join(base, 'snapshot.pb'));
    // The new version of emulator (37.x) is Ram.bin, the old version is Ram.img.
    // The consequences are very serious: the 3GB note was deleted as a shell.,
    // And so every time -- no-snapshot-load, always cold -- that's half the reason why it's "slow."
    const ram = Math.max(size(path.join(base, 'ram.bin')), size(path.join(base, 'ram.img')));
    if (pb > 1024 && ram > 1024 * 1024) return true;
    if (pb === 0 && ram === 0) return false;   // It's not even there. Don't delete it for nothing.
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    this._cleanLegacySnapshots();
    return false;
  }

  /** Clears old editions of left/ failed renames the left snapshot directory (ram.img can reach 3GB in default_boot)) */
  _cleanLegacySnapshots() {
    const dir = path.dirname(path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots', SNAPSHOT_NAME));
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    for (const name of names) {
      if (name === SNAPSHOT_NAME) continue;
      if (/^default_boot$|\.stale-\d+$/i.test(name)) {
        try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); } catch (_) { /* ignore */ }
      }
    }
  }

  /**
   * Clear the orphan simulator that holds the AVD lock.
   * Emulator.exe is just a starter, the real qemu was spawned),
   * So just kill the proc of your own hand that often leaves an orphan in possession of multi-agency.lock.,
   * FATAL "Running multiulators with the same AVD".
   * Quemu/ emulator, using “pid in AVD locks“+ “command with AVD name“ .
   */
  /**
   * The current AVD panel is horizontal or vertical.
   *
   * Why do you ask: screen?**It’s based on the physical panel.**Achieved —— `wm size` Just change the logic resolution, the image will
   * Lie down 90°;`adb emu rotate` Just turn the content, the system’s still up. The real thing is,
   * `hw.lcd.width/height` Exchange + restart. Config.ini is written on the setup at the start of each time.,
   * That's why you read it.**This one's running.**Which direction?
   *
   * @returns {boolean|♪ NIGHT ♪ TURE ♪ THROUGH, FALSE ♪ ♪ TRUE ♪
   */
  panelLandscape() {
    try {
      const avdDir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);
      const cfg = fs.readFileSync(path.join(avdDir, 'config.ini'), 'utf8');
      const w = Number((/^hw\.lcd\.width=(\d+)$/m.exec(cfg) || [])[1]);
      const h = Number((/^hw\.lcd\.height=(\d+)$/m.exec(cfg) || [])[1]);
      if (!w || !h) return null;
      return w > h;
    } catch (_) {
      return null;
    }
  }

  async killOrphanProcesses({ onLog = () => {} } = {}) {
    if (process.platform !== 'win32') return 0;
    const avdDir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);

    // Quick path.):
    //  - No .lock – there can’t be any alive emulator taking this AVD, directly returning;
    //  - There's lock, but nobody listens at the port.
    // Wmic (1-3 seconds, and eating CPU) used to run once in every situation, obviously slows down when cold starts.
    let locks = [];
    try { locks = fs.readdirSync(avdDir).filter((f) => /\.lock$/i.test(f)); } catch (_) { locks = []; }
    if (!locks.length) return 0;
    if (!(await this._anyEmulatorPortAlive())) {
      this.clearLocks(avdDir);
      return 0;
    }

    const pids = new Set();
    // 1) lock file emulator self-written pid (most reliable))
    try {
      const f = path.join(avdDir, 'hardware-qemu.ini.lock', 'pid');
      if (fs.existsSync(f) && fs.statSync(f).isFile()) {
        const pid = parseInt(fs.readFileSync(f, 'utf8').trim(), 10);
        if (pid) pids.add(pid);
      }
    } catch (_) { /* ignore */ }
    // 2) Bottom: Find a live qemu by process name + port (tasklist/netstat) faster than wmic)
    try {
      const [tl, ns] = await Promise.all([
        new Promise((res) => execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, o) => res(e ? '' : String(o || '')))),
        new Promise((res) => execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, o) => res(e ? '' : String(o || '')))),
      ]);
      const qemuPids = new Set();
      for (const line of tl.split('\n')) {
        const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
        if (m && /qemu|emulator/i.test(m[1])) qemuPids.add(m[2]);
      }
      for (const line of ns.split('\n')) {
        const m = /:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
        if (m && qemuPids.has(m[2])) pids.add(Number(m[2]));
      }
    } catch (_) { /* If you don’t get the process list, you just lock the file on the pid. */ }
    pids.delete(process.pid);
    if (!pids.size) {
      this.clearLocks(avdDir);
      return 0;
    }
    onLog(`Clean ${pids.size} A residual simulator process`);
    await Promise.all([...pids].map((pid) => new Promise((r) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => r());
    })));
    await sleep(1200);
    this.clearLocks(avdDir);
    return pids.size;
  }

  /** Do you have an emulator control port listening in 5554 ~ 5620 (retrieved connection will return immediately at minimal cost)) */
  async _anyEmulatorPortAlive() {
    const net = require('net');
    const probe = (port) => new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      let done = false;
      const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
      sock.setTimeout(120, () => fin(false));
      sock.once('connect', () => fin(true));
      sock.once('error', () => fin(false));
    });
    for (let port = 5554; port <= 5620; port += 2) {
      // eslint-disable-next-line no-await-in-loop
      if (await probe(port)) return true;
    }
    return false;
  }

  /**
   * Driver reports for interfaces/diagnostics: what’s on the switch, which are over, why.
   * @returns {{ applied:Array, effect:object|null, errors:Array, host:object|null }}
   */
  driverReport() {
    const pick = (d) => ({
      id: d.id, name: d.name, version: d.version, author: d.author || '',
      description: d.description || '', priority: d.priority, hits: d.hits || [],
      dir: d.dir || '', file: d.file || '',
    });
    return {
      applied: (this._driversApplied || []).map(pick),
      effect: this._driverEffect ? {
        gpuMode: this._driverEffect.gpuMode,
        forceTcg: this._driverEffect.forceTcg,
        notes: this._driverEffect.notes || [],
        ini: this._driverEffect.ini || {},
        env: this._driverEffect.env || {},
        args: (this._driverEffect.args || []).map((a) => (a.value ? `${a.flag}=${a.value}` : a.flag)),
      } : null,
      errors: this._driverErrors || [],
      host: this._driverHost || null,
    };
  }

  /**
   * Sets the config.ini overlays of the driver ’s statement to the default configuration.
   * The existing key is replaced locally (no duplication of lines), and the additions that do not exist are behind.
   * Only handles the keys in the list of divers.js, and illegal keys are rejected at the school examination stage.
   */
  _iniWithDrivers(text) {
    const over = (this._driverEffect && this._driverEffect.ini) || {};
    const keys = Object.keys(over);
    if (!keys.length) return text;
    const seen = new Set();
    const out = String(text).split('\n').map((line) => {
      const m = /^([A-Za-z0-9_.]+)=/.exec(line);
      if (!m || !(m[1] in over)) return line;
      seen.add(m[1]);
      return `${m[1]}=${over[m[1]]}`;
    });
    for (const k of keys) if (!seen.has(k)) out.push(`${k}=${over[k]}`);
    return out.join('\n');
  }

  /**
   * Read the drive directory, and pick out the effects of the device, the cost of the second switch.
   *
   * Directory order is priority: built-in example (read-only, default enabled:file) before, user driven behind,
   * As id the user directory covers the built-in -- the user changes the example to take effect directly and does not need to change the directory.
   *
   * @returns {{ applied:Array, skipped:Array, errors:Array } | null}
   */
  _resolveDrivers({ accel, emulatorVersion }) {
    const s = this.settings || {};
    const disabled = (s.drivers && s.drivers.disabled) || [];
    const state = (s.drivers && s.drivers.state) || {};
    let gpuName = '';
    let osBuild = 0;
    try {
      const release = require('os').release() || '';
      const m = /(\d+)\s*$/.exec(release);
      osBuild = m ? Number(m[1]) : 0;
    } catch (_) { /* If you do not get 0, the drive with osBuild in the matching condition will not work. */ }
    const host = drivers.hostContext({
      info: { ...doctor.hostInfo(), cpuVendor: (require('os').cpus() || [])[0]?.model || '' },
      gpuVendor: doctor.detectGpuVendor(),
      gpuName,
      osBuild,
      accel: accel && accel.ok ? (accel.kind || 'whpx') : 'none',
      emulatorVersion,
    });
    const loaded = drivers.loadAll([
      drivers.bundledDir(this.appRoot),
      drivers.userDir(store),
    ]);
    const r = drivers.resolve({ drivers: loaded.drivers, host, disabled, state });
    this._driverEffect = r.effect;
    this._driversApplied = r.applied;
    this._driverErrors = loaded.errors;
    this._driverHost = host;
    return { ...r, errors: loaded.errors, host };
  }

  /**
   * Prepare AVD: Write config.ini. Rewrite each start with the current automatic configuration, ensuring that the demotion re-try takes effect immediately.
   */
  ensureAvd({
    memoryMB = 2048, cores = 2, gpu = 'software', dataMB = 4096,
    heapMB = 256, accel = 'auto', snapshot = true, wipe = false, lcd = null,
  } = {}) {
    const p = this.provisioner.ensureDirs();
    const home = p.avdHome;
    const avdDir = path.join(home, `${AVD_NAME}.avd`);
    fs.mkdirSync(avdDir, { recursive: true });
    this.clearLocks(avdDir);

    // Screen resolution: 720x1280@320 with hardware acceleration with a clear image, with a weak text;
    // Pure software simulations fall to 540x960, with frame rates given priority (only 56% area, with eye differences much smaller than the flow gap).
    const screen = lcd || doctor.lcdFor({ accelOk: this.profile ? this.profile.accelOk : accel !== 'off' });

    const choice = this.imageChoice();
    const tag = choice.tag;
    const api = choice.api;
    const tagDisplay = choice.compat ? 'Google Play (ARM compatible))' : 'AOSP';

    fs.writeFileSync(
      path.join(home, `${AVD_NAME}.ini`),
      `avd.ini.encoding=UTF-8\npath=${avdDir.replace(/\\/g, '/')}\ntarget=android-${api}\n`,
    );

    const cfgPath = path.join(avdDir, 'config.ini');
    const wantImg = choice.dir
      ? `${choice.dir.replace(/\\/g, '/')}/`
      : `system-images/android-${api}/${tag}/${choice.abi}/`;
    this.wipePending = false;
    if (fs.existsSync(cfgPath)) {
      const prev = fs.readFileSync(cfgPath, 'utf8');
      const prevTag = /tag\.id=(.+)$/m.exec(prev);
      const prevImg = /image\.sysdir\.1=(.+)$/m.exec(prev);
      // Compare mirror identity instead of absolute path: same set of mirrors for disk/catalog does not replace mirrors,
      // Otherwise the user will be cleared of all installed applications as soon as it changes its running (see doctor.imageIdentity comment).
      const prevId = prevImg ? doctor.imageIdentity(prevImg[1].trim()) : '';
      const wantId = doctor.imageIdentity(wantImg);
      if ((prevTag && prevTag[1].trim() !== tag) || (prevId && prevId !== wantId)) {
        // Old userdata is incompatible with the new mirror (APEX guide loop), and must be rebuilt
        this.wipePending = true;
      }
    }

    // The configuration of the fingerprint changes the old Quickboot snapshot inevitably failed to load or created a black screen, voluntarily aborted.
    // Attention: this is a waste.**Quickshot**, There is no way to go --wipe-data -- the user data is the installed application and archive.
    const key = `${doctor.snapshotKey({
      dataMB, emulatorVersion: this._emuVersion || '', api, tag,
    }, choice.dir)}|${screen.w}x${screen.h}@${screen.dpi}`;
    const keyFile = path.join(avdDir, 'snapshot.key');
    let prevKey = '';
    try { prevKey = fs.readFileSync(keyFile, 'utf8').trim(); } catch (_) { /* First */ }
    const snapshotStale = !!(prevKey && prevKey !== key);
    if (this.wipePending || snapshotStale || wipe) {
      // Delete possible interceptions by system/security software (a few GBs are used in the snapshot catalogue).
      // If you fail, change the name to make emulator stop loading it, and never interrupt the start because of clean-up failure.
      const snapDir = path.join(avdDir, 'snapshots');
      try {
        fs.rmSync(snapDir, { recursive: true, force: true });
      } catch (_) {
        try { fs.renameSync(snapDir, `${snapDir}.stale-${Date.now()}`); } catch (__) { /* ignore */ }
      }
    }
    // Only "sysdir changes" -wipe-data: Old userdata with new mirrors
    // APEX is incompatible, and it’s not recreated and it’s stuck in the lead loop. Changed capacity. / Changed resolution / Change rendering backend does not count.
    fs.writeFileSync(keyFile, key, 'utf8');

    // hw.cpu.arch must be ABI per se (x86_64 not cut to x86))
    const cpuArch = choice.abi === 'arm64-v8a' ? 'arm64'
      : choice.abi === 'armeabi-v7a' ? 'arm' : choice.abi;

    const cfg = [
      `AvdId=${AVD_NAME}`,
      'avd.ini.displayname=Hydra Emulator',
      'avd.ini.encoding=UTF-8',
      `abi.type=${choice.abi}`,
      `hw.cpu.arch=${cpuArch}`,
      `hw.cpu.ncore=${cores}`,
      `hw.ramSize=${memoryMB}`,
      `vm.heapSize=${heapMB}`,
      `image.sysdir.1=${wantImg}`,
      `tag.id=${tag}`,
      `tag.display=${tagDisplay}`,
      // The old version dies 16G, produces huge files and slows off the first start in a small hard disk/quota environment
      `disk.dataPartition.size=${dataMB}M`,
      'hw.gpu.enabled=yes',
      `hw.gpu.mode=${gpu}`,
      'hw.keyboard=yes',
      // Virtual Wi-Fi has to open it up. API34’s Play Store image is walking online
      // Wlan0 (netsim virtual web card), not early eth0config.ini missing this line.,
      // The simulator doesn’t give wlan0 a link -- it’s shown to be no-carrier.,
      // `dumpsys connectivity` Display Active default network: none, application is
      // Always "Web Error, please try again later". Command line -netdelay/-netspeed/-dns-server
      // It’s all just the parameters of the QEMU user NET, not the fact that the inner guist’s Internet card has been pulled up.
      'hw.wifi=yes',
      'hw.lcd.width=' + screen.w,
      'hw.lcd.height=' + screen.h,
      'hw.lcd.density=' + screen.dpi,
      'hw.mainKeys=no',
      'ShowDeviceFrame=no',
      `PlayStore.enabled=${choice.compat}`,
      // The snapshot is entirely controlled by the command line-snapshot hydra: use a stand-alone name, never load by mistake
      // The old version of default_boot.
      'hw.sdCard=no',
      'hw.audioInput=none',
      'hw.camera.back=none',
      'hw.camera.front=none',
      'hw.gps=no',
      // Direction/acceleration sensors must be turned off: Once turned on, Android rotates automatically by the sensor, putting the screen on.
      // It’s turned to a horizontal one. The layout switch is now based on the image.
      // wm deness, do not need and do not allow the sensor to participate.
      'hw.sensors.orientation=no',
    ].join('\n') + '\n';
    fs.writeFileSync(cfgPath, this._iniWithDrivers(cfg));

    // /Data partition must be "realable" before it’s all for nothing.)
    const data = this.ensureDataPartition(avdDir, dataMB);

    return {
      home, avdDir, ini: path.join(home, `${AVD_NAME}.ini`), image: choice,
      wipePending: this.wipePending, screen, data,
    };
  }

  /**
   * Make sure that we have the userdata sector.**Real Available**Ext4 -- this is the foundation for the "point-open application 30 seconds into the desktop".
   *
   * Why do you have to do it yourself?):
   *  1. The userrdata.img in the system image package is 1MB in zero place, which is really formatted on avdmanager to SDK
   *     @mke2fs. Hydra Emulator writes config.ini pull emulator, skip that step /data zero →
   *     kernel "Invalid ext4 superblock on /dev/ black/vdc" →
   *     The top level’s been pinging, last 240s overtime.
   *  2. Emulator ’ s own e2fsck/resize2fs is cygwin version e2fsprogs 1.42.12, **No, encrypt
   *     Feature**, Take this one and it’s eight straight off the job, so the Extended Document System has to be in place before the replacement.
   *  The file system must ≥ partition size: APEX unpressure + dexopt to fill immediately for 64MB only,
   *     After that, all setxattr returns ENOSPC * Selinux labels that cannot be written * netd/media/tombstoned
   *     And then, exit 1 the switch card is starting the animation, adb over and offline.
   */
  ensureDataPartition(avdDir, dataMB = 4096) {
    const emulatorExe = this.locate().emulatorExe;
    if (!emulatorExe || !fs.existsSync(emulatorExe)) return { ok: false, reason: 'no-emulator' };
    try { fs.mkdirSync(avdDir, { recursive: true }); } catch (_) { /* ignore */ }
    const emuDir = path.dirname(emulatorExe);
    const img = path.join(avdDir, 'userdata-qemu.img');
    const wantBytes = Math.max(1024, Math.round(dataMB || 4096)) * 1024 * 1024;
    let size = 0;
    try { size = fs.statSync(img).size; } catch (_) { /* Does not exist */ }

    if (size > 0 && userdata.hasExt4Superblock(img)) {
      // The file is big enough + the file system is really big enough to be "do not move."
      // Just looking at the size of the document leaves out a real problem: qemu-img makes up the file, reese2fs fails.,
      // So the file 6GB, Android only had 64 MB -- the user saw "the game says space is insufficient."
      const fsBytes = userdata.fsBytes(img);
      const fsOk = fsBytes >= Math.min(size, wantBytes) * 0.95;
      if (size >= wantBytes && fsOk) return { ok: true, created: false, size, fsBytes };
      // Volume configurations have grown (or file systems are not in place):
      try {
        userdata.clearEncryptFlag(img);
        if (size < wantBytes) this._qemuImg('resize', img, wantBytes);
        this._resize2fs(img);
        userdata.setEncryptFlag(img);
        const grown = userdata.fsBytes(img);
        this.log(`%1 %1 ${size} → ${wantBytes}, File System ${fsBytes} → ${grown}`);
        return { ok: true, created: false, grown: true, size: wantBytes, fsBytes: grown };
      } catch (e) {
        this.log(`Expanding userdata failed (continue with existing partitions)): ${e.message}`);
        // The old partition is still available, but the caller must be told "not expanded this time," and the settings cannot be shown to be successful.
        return { ok: false, created: false, size, fsBytes, error: e.message };
      }
    }

    // First / Old version of fully zero biting / mirror damage: completely new one
    try {
      fs.rmSync(img, { force: true });
      fs.rmSync(`${img}.qcow2`, { force: true });
      // Not having encrypt bits (old e2fsck/ resize2fs) to work.)
      fs.writeFileSync(img, userdata.buildEmptyExt4({ sizeMB: 64, encrypt: false }));
      this._qemuImg('resize', img, wantBytes);
      this._resize2fs(img);
      userdata.setEncryptFlag(img);
      this.log(`Recreated userdata: ${(wantBytes / 1024 / 1024 / 1024).toFixed(1)} GB Ext4(4K block, support FBE)`);
      return { ok: true, created: true, size: wantBytes };
    } catch (e) {
      // Do your best: if the expansion fails, you have to fill the encrypt slot so that the FBE can be initialized.)
      try { userdata.setEncryptFlag(img); } catch (_) { /* ignore */ }
      this.log(`Failed to rebuild userdata: ${e.message}`);
      return { ok: false, created: true, error: e.message };
    }
  }

  /** Emulator self-carrying qemu-img.exe: stretching the original mirror file to target size (fragile, instantaneous completion))
   *  Note the order of parameters: `qemu-img < command> -f raw < document > < size >`.
   *  Unrecognited op. */
  _qemuImg(op, ...rest) {
    const exe = path.join(path.dirname(this.locate().emulatorExe), 'qemu-img.exe');
    const r = spawnSync(exe, [op, '-f', 'raw', ...rest], {
      cwd: path.dirname(exe), windowsHide: true, encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`qemu-img ${op}  Failed: ${(r.stderr || '').trim() || r.status}`);
  }

  /** Emulator carries a reize2fs.exe (cygwin version), must run under bin64 to find DLL) */
  _resize2fs(img) {
    const bin = path.join(path.dirname(this.locate().emulatorExe), 'bin64');
    const exe = path.join(bin, 'resize2fs.exe');
    if (!fs.existsSync(exe)) throw new Error('Missing resize2fs.exe');
    const r = spawnSync(exe, [img], {
      cwd: bin, windowsHide: true, encoding: 'utf8', timeout: 180000,
    });
    if (r.status !== 0) throw new Error(`Resize2fs Failed: ${(r.stderr || '').trim() || r.status}`);
  }

  /** Emulator locates SDK / AVD based on these environmental variables; Chinese path always turns 8.3 short path */
  env(root, plan = {}) {
    const safeRoot = doctor.shortPath(root);
    // The AVD directory must match the profile.paths(). avdHome: bindled running only (by EXE)
    // If there is no root/ avd, there is no root/ avd, and AVD is to be found in the user data directory.
    const avdHome = doctor.shortPath(this.provisioner.paths().avdHome);
    const adbPort = String(plan.adbPort || process.env.ANDROID_ADB_SERVER_PORT || '5044');
    return {
      ...process.env,
      ANDROID_SDK_ROOT: safeRoot,
      ANDROID_HOME: safeRoot,
      ANDROID_AVD_HOME: avdHome,
      ANDROID_EMULATOR_HOME: avdHome,
      ANDROID_ADB_SERVER_PORT: adbPort,
      ANDROID_EMULATOR_USE_SYSTEM_LIBS: '',
      ...(plan.accel === 'off' ? { ANDROID_I_WANT_MY_TCG: 'yes' } : {}),
      // Environmental variables driving the declaration: release only ANDROID_/QEMU_/LIBGL_/MESA_/EMUGL_ prefix (see Drivers.js))
      ...((this._driverEffect && this._driverEffect.env) || {}),
    };
  }

  guestLocale() {
    const locale = String(this.settings?.engine?.locale || 'en-US').trim();
    return /^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})+$/.test(locale) ? locale : '';
  }

  buildArgs({
    headless = true, accel = 'auto', port = 5554,
    gpu = 'software', memoryMB = 2048, cores = 2,
    snapshot = true, wipe = false, lcd = null,
  } = {}) {
    // Driver can fix the rendering backend / mandatory software simulation. Put it in front of gpu/ accel,
    // So all the logic behind it (-accel off, config.ini hw.gpu.mode) follows it.
    const eff = this._driverEffect || null;
    const drvGpu = eff ? drivers.gpuModeToArg(eff.gpuMode) : '';
    if (drvGpu) gpu = drvGpu;
    if (eff && eff.forceTcg) accel = 'off';
    const args = [
      '-avd', AVD_NAME,
      '-port', String(port),
      // Audio: Default to open (shows/video sound for Android’s application). / / Pass it only when the user is visiblely shut down in the settings -no-audio save a little CPU.
      ...(this.settings?.engine?.audio === false ? ['-no-audio'] : []),
      '-no-boot-anim',
      '-no-metrics',
      // Turn off the crash report: once a history crash has been reported, emulator will play the "Approval to Upload" model box.,
      // Main threads are stuck, never working.
      '-crash-report-mode', 'disabled',
      '-gpu', gpu,
      // AMD + emulator 37.x: The initialization of Vulkan on the back end of the host will fail and the process will start for more than a dozen seconds
      // And then straight exit 1, and it’s written as "host not available" and returned permanently to swangle (software rendering)),
      // Turn Vulkan off and let it go.
      // The software backend is not required for Vulkan, and with only one layer of uncertainty, it only works for the host.
      ...(gpu === 'host' && process.platform === 'win32' && doctor.detectGpuVendor() === 'amd'
        ? ['-feature', '-Vulkan'] : []),
      '-memory', String(memoryMB),
      '-cores', String(cores),
    ];
    // Network: AOSP emulator defaults to QEMU user NET (-netdev user), with Android side
    // 10.2.2.x virtual address, NET physical card to export direct re-entry host.
    // This mode [will] create any virtual network card/ virtual switch on Windows
    // (It has to happen-netdev tap or bridge, and we're not going to open it.
    // So Android’s application is "a device hanging behind the mainframe NET" and the mainframe’s network is still intact.,
    // There’s no need to load the drive, and there’s no more network adapters.
    // Apparent statement no speed limit: Default values are full, but some -gpu/ -net combinations will be brought with them.
    // Conservative configuration of the emulator, video class application (red fruit, shivering) will be a distinctly slow half-clap on the first screen.
    args.push('-netdelay', 'none', '-netspeed', 'full');
    // System Language: Default CREDIT Chinese.
    // Actual `-prop persist.sys.locale=zh-CN` Completely invalid - emulator intercepts persist.sys.*
    // Protected properties, r.product. locale is also covered by mirror build.prop;
    // None. Officially, it’s-change-locate: it really changes the system language and restarts the framwork.,
    // It’ll be written in /data, and it’ll be preserved from snapshot recovery.
    // Users can change the settings to another locale or switch them off (engine.locale=’off’).
    const locale = this.guestLocale();
    if (locale) args.push('-change-locale', locale);
    // DNS: Android defaults to 10.2.2.3 (transmitted to host DNS). Host takes VPN/ Corporate Network/ Selected Operators
    // At the time, a resolution can drag hundreds of milliseconds into a single analysis, in the form of "page spins start loading in half a day."
    // DNS, as a preferred option, returns when the system fails. Users can turn it off in the settings.
    if (this.settings?.engine?.fastDns !== false) {
      args.push('-dns-server', '1.1.1.1,8.8.8.8');
    }
    if (lcd) args.push('-skin', `${lcd.w}x${lcd.h}`);
    if (headless) {
      args.push('-no-window');
    } else {
      // Attention.: **- No-skin.**It'll cover the top-skin, get the panel size back.
      // Old value in config.ini -- it’s shown as "set with a screen cut, actually with a screen.",
      // And "The image is only one top left angle." The panel size must be determined by-skin.
      // The device shell would never have been painted (ShowDeviceFrame=no + the style parameters below).
      // Note: Not with-qt-side-window.**Not created at all.**Qt Window,
      // And the window agent is using SetParent to put this window in the application window to show the image. ——
      // After using it, probe never finds a window, and the user sees a black application window.
      // The window's hidden window has been replaced by the window's proxy permanent suppression (see QuietSweep of win/ agent.ps1).
    }
    // It’s only when the snapshot is real.,
    // qemu will wait for a non-existent memory, and the process will live but never turn on.——
    // The upper level only sees the "boot time" and then retrying the parameters instead of being blocked by AVD locks.
    // "Running multiple emulators with the same AVD".
    // So, just in case you look at the parameters, you decide, “The next time you start, is 8 seconds or 90 seconds?“ This is the second fatal point.:
    // "No-snapshot without a snapshot," and-no-snapshot was also banned.**Save on exit**,
    // So, the first cold start never comes up with a snapshot, and every time the user opens it, it's a full guide.
    // The right thing to do is-no-snapshot-load: this time, it's not on.),
    // But when you quit, you write your memory status down to hydra, and you’re gonna get it back.
    // A snapshot of about two to three GB’s of Ram.bin.)
    const wantSnapshot = this.settings?.engine?.keepSnapshot !== false;
    if (wipe) {
      // You can't load old snapshots when you reset the data, but...**New snapshots must be allowed to be saved**:
      // Renovation of the network is based on the link "The first time you've been reset has a net.",
      // The old writing is --no-snapshot, will turn off the memory together, and the snapshots will never be stored.
      args.push('-no-snapshot-load');
    } else if (!wantSnapshot) {
      args.push('-no-snapshot');
    } else if (snapshot !== false) {
      args.push('-snapshot', SNAPSHOT_NAME);
      // The network itself requires this cold start: the snapshot may have been stored during the “no web,“ but it’s still not online.
      if (!this.hasSnapshot() || this._coldBoot) args.push('-no-snapshot-load');
    } else {
      args.push('-no-snapshot');
    }
    if (wipe) args.push('-wipe-data');
    if (accel === 'off') args.push('-accel', 'off');
    // Other parameters that drive the declaration: -gpu/ -accel has been processed by the gpu/accel above, skipping here,
    // Avoid two occurrences of the same parameter (the behavior of emulator on repeat parameters is inconsistent with the different versions).
    for (const a of ((eff && eff.args) || [])) {
      if (a.flag === '-gpu' || a.flag === '-accel') continue;
      if (a.value === '') args.push(a.flag);
      else args.push(a.flag, a.value);
    }
    return args;
  }

  /** Pulling up individual processes (do not start, start in start() probe loops) */
  spawnOnce(plan, { headless, onLog, logFile }) {
    const loc = this.locate();
    const env = this.env(loc.root, plan);
    const args = this.buildArgs({
      headless, accel: plan.accel, port: plan.port, gpu: plan.gpu,
      memoryMB: plan.memoryMB, cores: plan.cores,
      snapshot: plan.snapshot, wipe: plan.wipe, lcd: plan.lcd,
    });
    this._logWrite(logFile, `\n--- ${new Date().toISOString()} ${plan.label} ---\n${loc.emulatorExe} ${args.join(' ')}\n`);

    const proc = spawn(loc.emulatorExe, args, {
      cwd: path.dirname(loc.emulatorExe),
      env,
      windowsHide: true,
      // Detached: Make emulator independent of Hydra Emulator.
      // Emactron exits and turns off the job object that he created and kills it with the process.——
      // It's called "Close Hydra Emulator and turn it on and start cold 20 seconds.",
      // Next time you start the direct takeover (see Runtime.adoptExisting), the second you start.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;
    try { proc.unref(); } catch (_) { /* ignore */ }

    const pipe = (stream) => {
      stream.setEncoding('utf8');
      let buf = '';
      stream.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const l of lines) {
          if (!l.trim()) continue;
          this.log(l.trim());
          this._logWrite(logFile, `${l.trim()}\n`);
        }
      });
    };
    pipe(proc.stdout);
    pipe(proc.stderr);
    proc.on('exit', (code) => {
      this.lastExitCode = code;
      const meaning = describeExitCode(code);
      this.log(`emulator exit ${code}${meaning ? `(${meaning})` : ''}`);
      this._logWrite(logFile, `emulator exit ${code}${meaning ? `(${meaning})` : ''}\n`);
      this.proc = null;
      onLog(`Exited at running (code=${code}${meaning ? `, ${meaning}` : ''})`);
    });
    proc.on('error', (e) => {
      this.log(`spawn error: ${e.message}`);
      this._logWrite(logFile, `spawn error: ${e.message}\n`);
      this.proc = null;
    });

    // qemu is the detached independence process, and when it really gets up, it lowers priorities.
    // 2-4 vCPU threads will be robbed with Normal priority and Windows desktop,
    // The most intuitive feeling of the user is that "As soon as the Hydra Emulator is opened, the mouse floats, the whole machine changes the card."
    const perf = this.settings?.engine?.priorityMode === 'performance';
    setTimeout(() => {
      this.setPriority(perf ? 'normal' : 'below').catch(() => {});
    }, 3500).unref?.();
    return { proc, args };
  }

  /** Write simulator logs: scroll with size to avoid long-term use of writing disks */
  _logWrite(file, text) {
    const limit = Math.max(2048, Number(this.settings?.engine?.logLimitKB || 2048) * 4);
    require('./logfile').append(file, text, limit);
  }

  /** Actual of the current/data mirror (set page display, can be retrieved without starting Android)) */
  dataInfo() {
    const dir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);
    const img = path.join(dir, 'userdata-qemu.img');
    let bytes = 0;
    try { bytes = fs.statSync(img).size; } catch (_) { /* Not yet. */ }
    let fsBytesNow = 0;
    try { fsBytesNow = userdata.fsBytes(img); } catch (_) { /* It's not built or damaged. */ }
    const configuredGB = Number(this.settings?.engine?.dataPartitionGB || 0);
    const fsGB = fsBytesNow ? Number((fsBytesNow / 1073741824).toFixed(1)) : 0;
    return {
      avdDir: dir,
      imageBytes: bytes,
      imageGB: bytes ? Number((bytes / 1073741824).toFixed(1)) : 0,
      // The actual size of the file system (silent mirror file size): the mirrors are expanded but the numbers will be different when the resoze2fs are not in place.
      fsGB,
      configuredGB,
      // Users set a target, but the file system hasn't reached the target yet.
      pendingGB: configuredGB && fsGB ? Math.max(0, configuredGB - fsGB) : 0,
      // Quickboot will build a layer of qcow2 coverage for usrdata, which is seen, not a mirror of the base.
      overlay: this._hasDataOverlay(img),
    };
  }

  /** Whether userdata is taken over by the qcow2 layer of Quickboot (it can only be reset, not in situ)) */
  _hasDataOverlay(img) {
    try { return fs.existsSync(`${img}.qcow2`); } catch (_) { return false; }
  }

  /**
   * Expand the/data partition immediately to the specified size (must make sure the simulator has stopped, otherwise the mirror is occupied).
   *
   * Two paths, the trade-off is real.:
   *  - No quickboot: qemu-img rezeze + reze 2fs, do not drop installed applications;
   *  - There's a cover layer: guest, the real mount is... `userdata-qemu.img.qcow2`, The base is extended to 8GB.,
   *    The filesystem also grows to 8GB, guest `df /data` It's still 5.7 GB.),
   *    And the file system in the layer has no root privileges to change. This time, it has to be returned to "reset.",
   *    Can't go back to success like before -- users will think it's been expanded, and the 50 GB game is still half way out.
   */
  resizeDataPartition(dataMB) {
    const dir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);
    const img = path.join(dir, 'userdata-qemu.img');
    const wantGB = Math.max(1, Math.round(Number(dataMB || 0) / 1024));
    if (this._hasDataOverlay(img)) {
      return {
        ok: false,
        needsReset: true,
        fsGB: this.dataInfo().fsGB,
        error: `Android's using a fast-started gap, and he can't change it. ${wantGB} GB).`
          + 'Recreated at new capacity after "reset Android data" -- installed applications and archives will be cleared, please confirm.',
      };
    }
    const r = this.ensureDataPartition(dir, dataMB);
    // InsureDataPartition returns the file system size once the rese2fs fail,
    // To prevent the "file is up, file system is running" from being considered successful.
    let fsAfter = 0;
    try { fsAfter = userdata.fsBytes(img); } catch (_) { /* ignore */ }
    const wantBytes = Math.max(1024, Math.round(Number(dataMB || 0))) * 1048576;
    if (r && r.ok && fsAfter < wantBytes * 0.95) {
      return {
        ok: false,
        ...r,
        fsGB: Number((fsAfter / 1073741824).toFixed(1)),
        error: `The mirror has been extended. ${wantGB} GB, but file system only arrives ${(fsAfter / 1073741824).toFixed(1)} GB (resize2fs failed).`
          + 'You can order "extended immediately" again, or try again after cleaning the disk.',
      };
    }
    return r;
  }

  /**
   * Adjust the priority of the qemu/ emulator process (only the process with the AVD name in the command line).
   * LEVEL: idle (container parking))| ♪ Below (apply to front desk))| No, no, no, no.
   */
  setPriority(level = 'below') {
    if (process.platform !== 'win32') return Promise.resolve(0);
    const script = path.join(__dirname, 'win', 'priority.ps1');
    if (!fs.existsSync(script)) return Promise.resolve(0);
    return new Promise((resolve) => {
      execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script, '-Avd', AVD_NAME, '-Level', level,
      ], { windowsHide: true, timeout: 15000 }, (_err, out) => {
        const m = /CHANGED=(\d+)/.exec(String(out || ''));
        resolve(m ? Number(m[1]) : 0);
      });
    });
  }

  /** Stretching the current attempt (including the qemu sub-process tree)) */
  async killAttempt() {
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try { proc.kill(); } catch (_) { /* ignore */ }
      if (process.platform === 'win32' && proc.pid) {
        try { spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (_) { /* ignore */ }
      }
    }
    await sleep(800);
    // Proc is often gone (emular.exe exits after startup, qemu is a detached independent process)),
    // If you don't go through it by process name, the next round will be blocked by AVD locks into FATAL.
    await this.killOrphanProcesses().catch(() => {});
  }

  /**
   * Rebuild this special port.
   *
   * Here’s the main target of two minutes to open the application, and history returns only to kill-server.:
   * Emulator goes to ANDROID_ANDB_SERVER_PORT at the start of the operation adb daemon,
   * It's not even going to work.**Never sign this device again.** —— You're either not in the adb devices, emulator-5554.,
   * “Unable to contract to adb damon on port: 5044“
   * So the upper level didn’t get sys.boot_completed, waiting three minutes to try again.,
   * Every retry is full cold start, and the snapshot is not stored because the device is not online, and it creates a death cycle.
   *
   * So you have to kill it before start, and wait until the port is actually listening.
   */
  /** For the upper level to start again voluntarily when the adb transfer is stuck (offline / unauthorized) */
  async resetAdbServer() {
    const port = Number(process.env.ANDROID_ADB_SERVER_PORT) || this.adbPort || 5044;
    return this._resetAdbServer(port);
  }

  async _resetAdbServer(adbPort) {
    let adb = 'adb';
    try { adb = this.provisioner.adbVersionPath() || 'adb'; } catch (_) { /* Use PATH */ }
    const env = { ...process.env, ANDROID_ADB_SERVER_PORT: String(adbPort) };
    const run = (args, timeout) => new Promise((resolve) => {
      try {
        execFile(adb, args, { timeout, windowsHide: true, env }, () => resolve());
      } catch (_) { resolve(); }
    });
    await run(['kill-server'], 6000);
    await run(['start-server'], 12000);
    // And the port doesn’t really listen.,
    // It’ll be here until it’s connected.
    const net = require('net');
    for (let i = 0; i < 25; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const alive = await new Promise((resolve) => {
        const sock = net.connect({ host: '127.0.0.1', port: Number(adbPort) });
        let done = false;
        const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
        sock.setTimeout(150, () => fin(false));
        sock.once('connect', () => fin(true));
        sock.once('error', () => fin(false));
      });
      if (alive) return true;
      // eslint-disable-next-line no-await-in-loop
      await sleep(120);
    }
    return false;
  }

  /**
   * Waiting for "spawn back soon".
   * Parameter error/DLL missing usually emulator returns within 1 sec; process is still in progress and returns immediately,
   * There’s no need to wait for 2.5 seconds -- enough time to run half the time when the snapshot is back.
   */
  _waitSpawnSettled(ms = 900) {
    const proc = this.proc;
    if (!proc) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const onExit = () => fin(true);
      const fin = (exited) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { proc.removeListener('exit', onExit); } catch (_) { /* ignore */ }
        resolve(exited);
      };
      const timer = setTimeout(() => fin(false), ms);
      proc.once('exit', onExit);
    });
  }

  /**
   * Let the next start force cold start (without a quick start snapshot).
   *
   * The snapshots are saved with the net cards: if the snapshots are stored in the “no web“ and every time they come back,
   * Keeping the net out. The network starts cold once when it heals, it can bypass this bad snapshot.
   */
  forceColdBootOnNextStart() { this._coldBoot = true; }

  /**
   * Let’s get the “Next Start“ tape --wipe-data (repair network only after multiple attempts fail).
   * Delete the userdata mirror file and emulator `-wipe-data` It’s not the same price, it’s the latter.
   */
  forceWipeOnNextStart() { this._forceWipe = true; }

  /**
   * Check if the virtual machine is really connected.
   *
   * Why do you need this step: the Wi-Fi configuration of the Android virtual machine exists / data, once it's written bad (typically, it's written)
   * `cmd wifi list-networks` The same AndroidWifi appears two, the network id crash.),
   * Wlan0 will be no-CARRIER, not getting IP. The "page that needs to be connected" is just one piece in the application.
   * Black screen -- this is what the user sees in the “black screen after the red bee“ -- has nothing to do with the GPU/Rendering.
   *
   * @param{string} [adbPath] visible designation adb executable (Runtime has more authoritative resolution))
   * @returns {Promise<{ok:boolean, reason:string, gateway?:string, ip?:string}>}
   */
  async checkNetwork(adbPath = '', { waitMs = 0, interval = 3000 } = {}) {
    const fs = require('fs');
    const path = require('path');
    // Same as repairWifi: Defensive the call error of "transmit function as path"
    let adb = typeof adbPath === 'function' ? adbPath() : (adbPath || '');
    if (!adb) {
      try { adb = this.provisioner.adbVersionPath() || ''; } catch (_) { adb = ''; }
    }
    if (!adb) {
      // (a) adbVersionPath() only search for “version files“ and many of the installed forms are empty;
      // Just go straight to the runtime root directory to find the flatform-tools.
      try { adb = path.join(this.locate().root, 'platform-tools', 'adb.exe'); } catch (_) { adb = ''; }
    }
    if (!adb || !fs.existsSync(adb)) adb = 'adb';
    const port = Number(process.env.ANDROID_ADB_SERVER_PORT) || this.adbPort || 5044;
    const env = { ...process.env, ANDROID_ADB_SERVER_PORT: String(port) };
    const sh = (cmd, timeout = 8000) => new Promise((resolve) => {
      try {
        execFile(adb, ['-s', this.serial, 'shell', cmd], { timeout, windowsHide: true, env }, (e, out) => {
          resolve(e ? '' : String(out || ''));
        });
      } catch (_) { resolve(''); }
    });
    // Android's multi-routine watch will let go. `ip route` The master list appears to be empty (default route in per-interface table)),
    // And the uid of the shell is not in the applicable network group, `ping` "Network is unfortunate",
    // Even if Wi-Fi is actually connected, the application can be connected to the Internet. So here only says, "Did you get an IPv4 address?",
    // And fold. `cmd wifi status` The connection state is cross-checked, no ping judgement.
    const addr = await sh('ip -o addr');
    const ips = [];
    const re = /inet ((?:\d{1,3}\.){3}\d{1,3})\//g;
    let m = re.exec(addr);
    while (m) {
      const ip = m[1];
      if (!/^127\./.test(ip)) ips.push(ip);
      m = re.exec(addr);
    }
    const wifi = await sh('cmd wifi status');
    const connected = /Wifi is connected/i.test(wifi);
    if (!ips.length) {
      // The Wi-Fi connection + DHCP is often done dozens of seconds later than the sys.boot_completed.
      // The caller gave the waiters to keep waiting, and don’t say "no network" at this moment.
      if (waitMs > 0) {
        const t0 = Date.now();
        while (Date.now() - t0 < waitMs) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, interval));
          // eslint-disable-next-line no-await-in-loop
          const again = await this.checkNetwork(adbPath, { waitMs: 0 });
          if (again.ok) return again;
        }
      }
      return { ok: false, reason: connected ? 'no-ip-address' : 'wifi-not-connected', addrs: ips };
    }
    const ip = ips[0];
    const gw = /^10\.0\.2\./.test(ip) ? '10.0.2.2' : ip.replace(/\.\d+$/, '.1');
    // There’s an IP that doesn’t have access to the Internet. It’s 10.2.2.16, but when DNS/ Route is strangled, the first page is still used.
    // "Network error," and the top level thinks the network's normal. This is a real HTTP search.
    // QEMU user NAT will stop ICMP, ping will be misreported.
    // Do it only on the “wait for network“ path (wait for network > 0), skipping fast-tracking -- otherwise every 3 seconds
    // It takes four seconds to detect, but it slows down the start. Put the conclusions in context, OK: IP first.
    // Let the application, once DNS shakes should not be stuck to the whole start.
    let reachable = null;
    if (waitMs > 0) {
      const probe = await sh(
        "echo -e 'GET /generate_204 HTTP/1.0\\r\\nHost: connectivitycheck.gstatic.com\\r\\n\\r\\n' "
        + "| nc -w 4 connectivitycheck.gstatic.com 80 2>/dev/null | head -1",
        7000,
      );
      reachable = /HTTP\/1\.[01]\s+204/.test(probe);
    }
    return { ok: true, reason: '', gateway: gw, ip, wifiConnected: connected, reachable };
  }

  /**
   * AndroidWifi, "saved but not automatically" connects it.
   *
   * It's a virtual hotspot that the simulator has on its own.
   * Two records (open+owe) on which the system is determined
   *   “Saved / Won't automatically connect”
   * So, when it started, wlan0 forever No-Carrier, applied consistently to report Internet errors.
   *
   * Trouble is, shell 2000 doesn’t have NETWORK_SETTENGS privileges.,
   * `cmd wifi connect-network` Security Exchange, so no orders.
   * Replace this with the Wi-Fi setup page, and point to the saved network -- just like the manual user point.
   *
   * @returns {Promise<boolean>Are you connected?
   */
  async repairWifi(adbPath = '') {
    const fs = require('fs');
    const path = require('path');
    // Defense: The caller may have misdirected the function itself (rt.adbPath is a method).
    let adb = typeof adbPath === 'function' ? adbPath() : (adbPath || '');
    if (!adb) {
      try { adb = path.join(this.locate().root, 'platform-tools', 'adb.exe'); } catch (_) { adb = ''; }
    }
    if (!adb || !fs.existsSync(adb)) adb = 'adb';
    const port = Number(process.env.ANDROID_ADB_SERVER_PORT) || this.adbPort || 5044;
    const env = { ...process.env, ANDROID_ADB_SERVER_PORT: String(port) };
    const sh = (cmd, timeout = 10000) => new Promise((resolve) => {
      try {
        execFile(adb, ['-s', this.serial, 'shell', cmd], { timeout, windowsHide: true, env }, (e, out) => {
          resolve(e ? '' : String(out || ''));
        });
      } catch (_) { resolve(''); }
    });
    // The company then switched the "network authentication" detection address to a nationally accessible location.
    // Android’s default is that he doesn’t have access to it in the country.gstatic.com.,
    // The system keeps tagging the network with “!“ (connected but unable to access the Internet).
    // Self-identify as offline, refuse to load content... replace with a domestic endpoint that returns 204.
    const tune = async () => {
      await sh('settings put global captive_portal_http_url http://connectivitycheck.gstatic.com/generate_204');
      await sh('settings put global captive_portal_https_url https://connectivitycheck.gstatic.com/generate_204');
      await sh('settings put global captive_portal_mode 0');
    };
    // We're connected. Don't mess with it.
    if (/Wifi is connected/i.test(await sh('cmd wifi status'))) {
      await tune();
      return true;
    }
    // When the switch is turned off (user slides before -svc wifi can)
    await sh('svc wifi enable');
    await new Promise((r) => setTimeout(r, 1500));

    // Open the Wi-Fi setup page, and use the uiautomator line to find AndroidWifi.
    // Stabilized by coordinates: Different resolutions/ coordinates under languages.
    await sh('am start -a android.settings.WIFI_SETTINGS');
    await new Promise((r) => setTimeout(r, 2500));
    await sh('uiautomator dump /sdcard/ui.xml');
    const xml = await new Promise((resolve) => {
      try {
        execFile(adb, ['-s', this.serial, 'shell', 'cat', '/sdcard/ui.xml'],
          { timeout: 10000, windowsHide: true, env, maxBuffer: 8 * 1024 * 1024 },
          (e, out) => resolve(e ? '' : String(out || '')));
      } catch (_) { resolve(''); }
    });
    // Node-like <node text="AndroidWifi" ... bounds="[x1,y1][x2,y2]" />
    const re = /<node[^>]*\btext="([^"]*)"[^>]*\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
    let m = re.exec(xml);
    while (m) {
      const label = m[1];
      if (/AndroidWifi/i.test(label)) {
        const cx = Math.round((Number(m[2]) + Number(m[4])) / 2);
        const cy = Math.round((Number(m[3]) + Number(m[5])) / 2);
        await sh(`input tap ${cx} ${cy}`);
        await new Promise((r) => setTimeout(r, 6000));
        if (/Wifi is connected/i.test(await sh('cmd wifi status'))) {
          await tune();
          return true;
        }
      }
      m = re.exec(xml);
    }
    // Look straight at it again.)
    await sh('svc wifi disable');
    await new Promise((r) => setTimeout(r, 1500));
    await sh('svc wifi enable');
    await new Promise((r) => setTimeout(r, 6000));
    const ok = /Wifi is connected/i.test(await sh('cmd wifi status'));
    if (ok) await tune();
    return ok;
  }

  /**
   * Start + Automatic Retry.
   * @param{Function} probe astrideback, returns 'ok' | 'pending' | 'fatal'
   */
  async start({ headless = false, onLog = () => {}, probe = null, maxAttempts = 4 } = {}) {
    if (this.proc && !this.proc.killed) {
      // Key: emulator.exe is just a starter, qemu exits, and this proc
      // The object will be kept as long as it's still true.
      // Alive -- reboot the panel and then step through the pit: start() returns directly
      // Reuse, caller to take a dead serial to the adb, report. `device not found`,
      // The expression is "App’s direct failure to switch to another direction."
      // So we have to confirm that there’s a real machine running on the terminal before we can re-use it.
      if (await this._consoleAlive()) {
        return { ok: true, reused: true, serial: this.serial, port: this.port };
      }
      onLog('The last simulator has exited, restarted.…');
      this.proc = null;
    }

    const loc = this.locate();
    if (!loc.emulatorExe) throw new Error('Do not install running-time engines. Please complete deployment on the “ running-time “ page first.');
    const choice = this.imageChoice();
    if (choice.compat ? !this.provisioner.playImageInfo().ok : !this.provisioner.systemImageInfo().ok) {
      throw new Error('system image not ready, download the Android system image on the runtime page first');
    }

    const s = this.settings;
    // Take a look at the disk before it starts: the emulator writes AVD (data partition + snapshots, several GBs)),
    // Only the balance of the disk in which it is located determines whether it can be activated; the directory at runtime only writes logs, which is much lower.
    // The balance of the two was previously minimized, and the result was that "Data directory has been moved to Disk D, with C Disk leaving only 400MB"
    // It’s misconstrued as a disk deficiency -- moving the disk is empty.
    const avdHome = this.provisioner.paths().avdHome;
    const avdFreeMB = doctor.freeDiskMB(avdHome);
    const diskMB = doctor.freeDiskMB(loc.root);
    const needMB = 2500;
    if (avdFreeMB && avdFreeMB < needMB) {
      const msg = `Disk space: Android Data Directory(${avdHome}) There’s only one disk left. ${(avdFreeMB / 1024).toFixed(1)} GB, `
        + `Run at least ${(needMB / 1024).toFixed(1)} GB Available. Please insert “Setup → System Integration“ in “Andrew Data Directory“`
        + 'Change it to a fully spaced disk (e.g. D:), or clean it up first. Your application and archiving will not be automatically deleted.';
      this.log(msg);
      onLog(msg);
      return { ok: false, error: msg, needsSpace: true, attempts: [] };
    }
    if (diskMB && diskMB < 300) {
      const msg = `Runtime Directory(${loc.root}) There’s only one disk left. ${(diskMB / 1024).toFixed(1)} GB, `
        + 'Not even a log or a temporary file can be written. Please clean the disk, or replace “runtime data directory“ with another disk.';
      this.log(msg);
      onLog(msg);
      return { ok: false, error: msg, needsSpace: true, attempts: [] };
    }
    const adbPort = await doctor.freeAdbPort(Number(process.env.ANDROID_ADB_SERVER_PORT) || 5044);
    // Let all adb calls and emulator in this process use the same server port
    process.env.ANDROID_ADB_SERVER_PORT = String(adbPort);
    this.adbPort = adbPort;

    // These four things are not dependent on each other, doing them in parallel: used to be the "Accelerating Check Version Survey Port Adb Server" series.,
    // Three to five seconds before cold start, just the time the user looks at the loading box.
    // The adbserver left behind from the last run may still have an old device record.),
    // So the clear server still has to do, just don't have to wait for it alone.
    const [accelInfo, verInfo, startPort] = await Promise.all([
      this.provisioner.emulatorAccel(),
      this.provisioner.emulatorVersion(),
      doctor.freePortPair(5554),
      this._resetAdbServer(adbPort),
    ]);
    const emuVersion = verInfo.version || '';
    this._emuVersion = emuVersion;

    // Driver (compatible patch): See what this machine looks like first, and see if anyone’s written it.
    // This step reads only JSON, does not execute any code; matches are empty effects, behavior is exactly the same as before.
    let drv = { applied: [], skipped: [], errors: [], effect: null };
    try {
      drv = this._resolveDrivers({ accel: accelInfo, emulatorVersion: emuVersion });
    } catch (e) {
      this.log(`Driver Load Failed: ${e.message}`);
      onLog(`Driver loading failed (neglected, started with default parameter)): ${e.message}`);
    }
    if (drv.applied.length) {
      onLog(`Applied Driver: ${drv.applied.map((d) => `${d.name} v${d.version}`).join(', ')}`);
      for (const n of (this._driverEffect.notes || []).slice(0, 4)) onLog(`· ${n}`);
    } else {
      onLog('No driver matched, start with default parameter');
    }
    if (drv.errors && drv.errors.length) {
      onLog(`Yeah. ${drv.errors.length} A driver file was not loaded successfully (setup → driver can see why))`);
    }

    // Share the same entry as the set page/ diagnostic report, making sure that "show" is "run-down."
    const profile = doctor.autoProfile({
      settings: s, accel: accelInfo, emulatorVersion: emuVersion, diskMB,
      port: startPort, adbPort,
    });
    this.profile = profile;
    let variants = doctor.planVariants(profile).slice(0, maxAttempts);
    // Driver specifies the render backend/ requires software simulations, each round presses it:
    // The purpose of the user-driven process is to "use only this part of the machine" and to continue to try to break down the back end for nothing.
    if (drv.applied.length && this._driverEffect) {
      const gpuFixed = drivers.gpuModeToArg(this._driverEffect.gpuMode);
      if (gpuFixed) {
        variants = variants.map((v) => ({ ...v, gpu: gpuFixed }));
        onLog(`Drives to fix the rendering backend as ${gpuFixed}`);
      }
      if (this._driverEffect.forceTcg) {
        variants = variants.map((v) => ({ ...v, accel: 'off', label: `${v.gpu} / Driver requires software simulations` }));
        onLog('Driver requires close hardware acceleration (walking software simulation))');
      }
    }

    // Remember the GPU backend of the last pull-up, next time we’re going to have it at the end.
    // Actual: AMD Radeon 780M `-gpu host` Can get through your own hardware check.,
    // But the VM is direct in a dozen seconds.),
    // You wait 20 seconds or so to bring the emulator version.key.,
    // Once the upgrade runs, it automatically gives it a chance.
    const badGpuKey = this.settings.engine.badGpu || '';
    const [badVer, badGpu] = badGpuKey.includes('|') ? badGpuKey.split('|') : ['', ''];
    // Turn off Vulkan after host has a chance to really use: try again for every emulator version,
    // So that the old record doesn’t permanently pin the user on the rehearsing of the software.
    const vulkanRetried = String(this.settings.engine.badGpuVulkanTried || '');
    const retryHostWithoutVulkan = badGpu === 'host' && badVer === emuVersion && vulkanRetried !== emuVersion;
    if (retryHostWithoutVulkan) {
      store.saveSettings({ engine: { badGpu: '', badGpuVulkanTried: emuVersion } });
      onLog('Last time the host rendering crash suspected Vulkan caused, this test hardware acceleration with-feature-Vulkan');
    } else if (badGpu && badVer === emuVersion) {
      const rank = (v) => (v.gpu === badGpu ? 1 : 0);
      variants.sort((a, b) => rank(a) - rank(b));
      if (variants[0] && variants[0].gpu === badGpu && variants.length > 1) {
        onLog(`Last time ${badGpu} Render backend start-up crashes, this time change ${variants[1].gpu} Let’s try first.`);
      }
    }

    const logFile = path.join(store.DATA_DIR, 'logs', 'emulator.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    this._logWrite(logFile, `\n\n=== ${new Date().toISOString()} START ${doctor.describeProfile(profile)} ===\n`);
    this._logWrite(logFile, `drivers: ${drv.applied.length ? drv.applied.map((d) => `${d.id}@${d.version}`).join(', ') : '(none)'}\n`);

    // The screen specifications are consistent throughout the start-up process, otherwise the resolution changes every time.
    // The resolution is from the doctor’s profile (in the settings you can change the “painting“), selected at an acceleration state when auto is selected.
    const screen = (profile && profile.lcd) || doctor.lcdFor({ accelOk: accelInfo.ok });
    this.attempts = [];
    this.lastDiagnosis = null;
    let lastError = '';

    // Quemu, left behind by the last operation, still holds the AVD lock.,
    // FATAL "Running multiulators with the same AVD".
    // eslint-disable-next-line no-await-in-loop
    await this.killOrphanProcesses({ onLog }).catch(() => {});

    for (let i = 0; i < variants.length; i += 1) {
      const base = variants[i];
      // Port occupancy can also lead to failure, re-detecting every time you try again.
      // eslint-disable-next-line no-await-in-loop
      const port = i === 0 ? startPort : await doctor.freePortPair(startPort + (i * 2));
      const plan = { ...base, port, adbPort, lcd: screen };
      this.port = port;
      // Reset exit code per round: last round 0xC00005 cannot be brought into next round of diagnosis
      this.lastExitCode = null;
      // Logs are also rounded down: memory logs are accumulated over wheels, and if the crash line of Round 1 remains at the end,,
      // Round 2 (for example, a back-end back-port conflict) will be misdiagnosed as the same crash.
      const logStart = this._log.length;
      onLog(`Start running (No. 1) ${i + 1}/${variants.length} Numbers: ${plan.label})…`);

      // eslint-disable-next-line no-await-in-loop
      const avd = this.ensureAvd({
        ...plan,
        // _forceWipe also participates in "Delete old snapshots": Reseting old snapshots will fail to load
        // (Failed to load snapshot and then back to cold start, must be cleared before reconstruction.
        wipe: plan.wipe || !!this.wipePending || !!this._forceWipe,
      });
      // Bury site: main with which it pulls up the simulator**Before**Open the black window and suppress it.
      // The control window comes out in a few dozen milliseconds after spawn, and then another scan comes out.,
      // So here we have to open it and pull up the process.
      if (this.onBeforeSpawn) {
        // eslint-disable-next-line no-await-in-loop
        try { await this.onBeforeSpawn(); } catch (_) { /* ignore */ }
      }
      // eslint-disable-next-line no-await-in-loop
      const forceWipe = !!this._forceWipe;
      this._forceWipe = false;
      // _coldBoot only works for this spinn, avoiding the subsequent decomposition and cold start-up of each start-up.
      this.spawnOnce({ ...plan, wipe: plan.wipe || avd.wipePending || forceWipe }, { headless, onLog, logFile });
      this._coldBoot = false;

      // Parameter error / DLL missing will exit immediately
      // eslint-disable-next-line no-await-in-loop
      const dead = await this._waitSpawnSettled(2200);
      if (dead || !this.proc) {
        const d = doctor.diagnose(this._attemptLines(logStart, 60));
        this.attempts.push({ plan: plan.label, diagnosis: d.code, exitCode: this.lastExitCode });
        this.lastDiagnosis = d;
        lastError = `${d.title}: ${d.hint}`;
        // Disk is not a question of “change parameters are good“: continuing to try again will only fail repeatedly.,
        // And the last set of parameters in history will erase the user data together.
        if (d.code === 'DISK_FULL') {
          onLog('The disk space is insufficient and the retry has been stopped.');
          this._persistFailure({ profile, why: 'disk-full' });
          return { ok: false, error: lastError, needsSpace: true, attempts: this.attempts, exitCode: this.lastExitCode };
        }
        // The acceleration/sphere conclusion may be old data in the cache, scrapped, re-detected next time.
        if (['ACCEL', 'GPU_INIT', 'GPU_MODE', 'IMAGE', 'DLL', 'ACCESS_VIOLATION'].includes(d.code)) {
          try { this.provisioner.invalidateEnvCache(); } catch (_) { /* ignore */ }
        }
        onLog(`${d.title}, Automatically retry a new set of parameters…`);
        this._noteGpuFailure(plan);
        continue;
      }

      if (!probe) {
        return { ok: true, serial: this.serial, port, accel: accelInfo, logFile, profile, attempts: this.attempts };
      }

      const started = Date.now();
      const timeout = plan.bootTimeoutMs || 240000;
      let ok = false;
      let fatal = false;
      let sawBooting = false;
      // A quick picture recovery often starts in a few seconds, fixed in three seconds once means an average of 1.5 seconds to "discover."
      // It’s ready. From 200ms to 1.2 seconds, it’s ready to be caught immediately.,
      // The long lead doesn’t spend CPU on a roundup.
      let interval = 200;
      let lastNotice = 0;
      // eslint-disable-next-line no-await-in-loop
      while (Date.now() - started < timeout) {
        if (!this.proc) { fatal = true; break; }
        let state = 'pending';
        try {
          // eslint-disable-next-line no-await-in-loop
          state = await probe({ serial: this.serial, port, adbPort });
        } catch (_) { state = 'pending'; }
        if (state === 'ok') { ok = true; break; }
        if (state === 'fatal') { fatal = true; break; }
        // As long as adb can execute shell, indicates that the kernel is already guided, the normal Vulkan/EGL information in the log is not a failure.
        if (state === 'booting') sawBooting = true;
        // 45 seconds is still completely unconnected, and the log has a definite fatal error.
        if (!sawBooting && Date.now() - started > 45000) {
          const d = doctor.diagnose(this._attemptLines(logStart, 80));
          if (['GPU_INIT', 'ACCEL', 'GPU_MODE', 'IMAGE', 'DLL', 'MEMORY', 'ACCESS_VIOLATION'].includes(d.code)) {
            this.lastDiagnosis = d;
            try { this.provisioner.invalidateEnvCache(); } catch (_) { /* ignore */ }
            fatal = true;
            break;
          }
        }
        // One progress per 15 seconds: used to use a “mocking“ to determine how to adapt to two or three times a time.
        if (Date.now() - lastNotice > 15000) {
          lastNotice = Date.now();
          onLog(`It's on.… ${Math.round((Date.now() - started) / 1000)}s`);
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(interval);
        interval = Math.min(1200, Math.round(interval * 1.6));
      }

      if (ok) {
        const bootMs = Date.now() - started;
        // This time it really gets up: clear the record of the last failure and avoid the "diagnostic" coming back.
        this._clearFailure();
        // Quickboot snapshot: Simulator process will end with Hydra Emulator exit.
        // The next time you open a snapshot, it's 25 seconds or 7 seconds.
        // Installer will be used as a waste of snapshots when the new apps are installed, to avoid the "reboot application disappearing."
        this.snapshotWorthSaving = true;
        onLog(`Run Ready(${Math.round(bootMs / 1000)}s, ${plan.label})`);
        // The switchboard is not a good thing: it’s a check-up network. When the virtual machine is off the grid, the page that needs to be connected will be blacked out.,
        // Users only say, "This application black screen," and it's hard to imagine the network.
        //
        // But it cannot be "checked and concluded": Wi-Fi association + DHCP is generally later than sys.boot_completed
        // 5-20 seconds, used to checkNetwork() only once, so...**Every cold start.**They'll fight.
        // “There is no network, please reset Android data,“ and the network is ready in 5 seconds -- the user will do it.
        // The light is loaded. Now give it 12 seconds to wait for the window.,
        // And no more destructive operations.
        let network = null;
        try {
          network = await this.checkNetwork('', { waitMs: 12000, interval: 3000 });
        } catch (_) { /* The failure of the medical examination is not a failure of the startup. */ }
        if (network && !network.ok) {
          onLog('Android is not yet connected to the network. Wait briefly or use the network repair in Diagnostics & Fixes.');
        }
        return {
          ok: true, serial: this.serial, port, accel: accelInfo, logFile,
          profile, attempts: this.attempts, bootMs, quickBoot: true, network,
        };
      }

      const attemptLines = this._attemptLines(logStart, 80);
      const d = fatal ? (this.lastDiagnosis || doctor.diagnose(attemptLines)) : doctor.diagnose(attemptLines);
      this.attempts.push({ plan: plan.label, diagnosis: d.code, timeout: !fatal, exitCode: this.lastExitCode });
      this.lastDiagnosis = d;
      lastError = fatal ? `${d.title}: ${d.hint}` : 'Overtime (perhaps for the first time, slow steering or hardware acceleration not effective))';
      onLog(`${lastError}, Automatically retry a new set of parameters…`);
      // The authorization dialogue box is not a problem with rendering backends, do not add the current GPU to the "start or drop" blacklist,
      // Otherwise, the next start will skip the back end of the user machine for no reason.
      if (d.code !== 'ADB_UNAUTHORIZED') this._noteGpuFailure(plan);
      // eslint-disable-next-line no-await-in-loop
      await this.killAttempt();
    }

    const d = this.lastDiagnosis || doctor.diagnose(this.recentLog(120));
    const report = doctor.writeReport({
      dataDir: store.DATA_DIR, profile, logLines: this.recentLog(300),
      extra: {
        attempts: this.attempts,
        diagnosis: d,
        image: choice,
        exitCode: this.lastExitCode,
        exitMeaning: describeExitCode(this.lastExitCode),
      },
    });
    const err = new Error(
      `Multiple attempts at running are still not started(${d.title}).\n${d.hint}\n\n`
      + `Attempted: ${this.attempts.map((a) => `${a.plan} → ${a.diagnosis}`).join('; ')}\n`
      + `Diagnosis report: ${report.file}`,
    );
    err.diagnosis = d;
    err.report = report.file;
    err.attempts = this.attempts;
    this._persistFailure({ profile, why: 'boot-failed', report: report.file });
    throw err;
  }

  running() { return !!(this.proc && !this.proc.killed); }

  /**
   * Save quickboot snapshots.
   *
   * The time is important: the previous realization was six seconds after the start of the operation, and it was just the right time to open the app grab disk I/O.
   * (The quick picture is one to three GBs, and the body is slower.
   * When the last application window closes; if it’s not ready before it’s off, it’s done again.
   */
  async saveSnapshotNow(adbPath, { timeout = 45000 } = {}) {
    if (!adbPath) return false;
    const ok = await this._saveViaAdb(adbPath, { timeout });
    // The emulator's Save command may be back on the drive. OK, check this again with the file integrity.,
    // Only snapshot.pb is counted for real failure (or next load will fail and wait for a few seconds).
    if (!ok) return false;
    return this.hasSnapshot();
  }

  /**
   * Set up a “save snapshots when free“.
   * Only once in a row; if the container is still in the front desk at the point, then it’s really free.
   */
  scheduleSnapshotSave(adbPath, { delay = 20000, isIdle = () => true } = {}) {
    if (!adbPath) return;
    if (this._snapTimer) clearTimeout(this._snapTimer);
    const arm = (ms) => {
      this._snapTimer = setTimeout(async () => {
        this._snapTimer = null;
        if (!this.running()) return;
        if (!isIdle()) { arm(15000); return; }
        // If the disk balance is not enough to write a snapshot (RAM size + 1 GB balance) then skips: hard writing only fills the disk,
        // And then the next time you're going to fail. The snapshot only affects the start-up speed, not the writing, not the data.
        const freeMB = require('./doctor').freeDiskMB(store.DATA_DIR);
        const needMB = Math.round(Number(this.profile?.memoryMB || 3072) * 1.15) + 1024;
        if (freeMB && freeMB < needMB) {
          this.log(`Skipshot Save: Disk Remains ${(freeMB / 1024).toFixed(1)}GB < Required ${(needMB / 1024).toFixed(1)}GB`);
          return;
        }
        await this.saveSnapshotNow(adbPath).catch(() => false);
        this._snapSaved = true;
      }, ms);
      if (this._snapTimer.unref) this._snapTimer.unref();
    };
    arm(delay);
  }

  cancelSnapshotSave() {
    if (this._snapTimer) clearTimeout(this._snapTimer);
    this._snapTimer = null;
  }

  /** Slow machine saves quickshots, takes the control table off, and then kills the process tree. */
  async stop({ adbPath } = {}) {
    if (!this.proc) {
      // There's no proc for the takeover, but there's a machine running at the port, and you can't just go back to True and leave.
      if (!(await this._anyEmulatorPortAlive())) return true;
    }
    this.cancelSnapshotSave();
    const serial = this.serial;
    // Find out whether the guest is healthy before turning off, and just ask in this one. adb:
    //  - Health – one snapshot (when the free path is not available, the next one will be in seconds);
    //  - Unhealthy (adb stuck in unauthorized / unstarted) - not stored, and**I’ll take a quick look after I’m out.**:
    //    `adb emu kill` It'll allow emulator to save a memory by pressing Quickboot. That's the same.
    //    Freezing the unauthorized status. Not clear here, and the next recovery is another drug snapshot of the "start time."
    const healthy = adbPath ? await this._adbGuestHealthy(adbPath) : false;
    if (adbPath && this.snapshotWorthSaving !== false && healthy) {
      // 3GB RAM will take a few seconds to twenty seconds, time out, and don’t let half the snapshots get killed.
      await this._saveViaAdb(adbPath, { timeout: 60000 });
    }
    if (!healthy && this.snapshotWorthSaving !== false) {
      this.log('When turned off, guest is not authorized/ not ready: will be used as a waste snapshot, re-inject debugging authorization next cold start');
    }
    if (adbPath) {
      await new Promise((resolve) => {
        execFile(adbPath, ['-s', serial, 'emu', 'kill'],
          { timeout: 10000, windowsHide: true }, () => resolve());
      });
    }
    // When it’s done with the drop-down and exit, it used to be six seconds away.,
    // Just cut the snapshot, leaving an empty shell with no snapshot.pb.
    //
    // This.proc: emularor.exe is just a starter, spawn after qemu is done, and he’s gone.,
    // Take it off, and when it's done, it'll enter the homicide branch. This is based on the port of the control.
    for (let i = 0; i < 100 && (await this._consoleAlive()); i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(300);
    }
    await this.killAttempt();
    // When it's clean, drop the trigger handle. Keep it to running () back forever.,
    // Start() thought it could be reused.
    this.proc = null;
    // The process has been withdrawn, and it will then be scraped and it may automatically be stored at the time of exit. The order is important: it has to be placed.
    // When the port closes, it will write back the snapshot that was just deleted.
    if (!healthy && this.snapshotWorthSaving !== false) {
      try { this.invalidateSnapshot(); } catch (_) { /* ignore */ }
    }
    return true;
  }

  /**
   * Write down the GPU backend for " Pull Up" and load it to the end next time.
   * Only for autu mode: user-obviously assigns backends with respect to user selection and does not change it secretly.
   */
  _noteGpuFailure(plan) {
    try {
      const gpu = plan && plan.gpu;
      if (!gpu) return;
      // Software Rendering is the bottom line, and it’s already the slowest/stabilityiest option, and there’s no worse alternative to retreat.
      if (/software|swiftshader|swangle/.test(gpu)) return;
      if ((this.settings.engine.gpuMode || 'auto') !== 'auto') return;
      store.saveSettings({ engine: { badGpu: `${this._emuVersion || ''}|${gpu}` } });
    } catch (_) { /* ignore */ }
  }

  /** Is there still a machine running on the control port of this example? */
  _consoleAlive() {
    const net = require('net');
    const port = this.port || 5554;
    return new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      let done = false;
      const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
      sock.setTimeout(200, () => fin(false));
      sock.once('connect', () => fin(true));
      sock.once('error', () => fin(false));
    });
  }

  /**
   * Whether the state of health of the guest is “safe to store snapshots“: adb accomplished + Boot complete.
   * If “Approve USB debugging?“ dialogue box is still hanging, state is unauthorized -- save at this point
   * Memory + disk, whose host does not exist, next recovery,
   * Every round of the shell drops out of the way, the 240s are misdiagnosed as a visible card/virtual problem.
   */
  async _adbGuestHealthy(adbPath) {
    if (!adbPath) return false;
    try {
      const { AdbClient } = require('./adb');
      const probe = new AdbClient({ adbPath, serial: this.serial });
      const state = await probe.deviceState();
      const out = await probe.shell('getprop sys.boot_completed', { timeout: 6000 }).catch(() => '');
      return state === 'device' && String(out).trim() === '1';
    } catch (_) {
      return false; // If you can’t read it, you’ll be treated unwell.
    }
  }

  /**
   * Trigger a snapshot save with adb (failure to return false, caller decides to try again).
   * Only when it’s healthy, it’s better to start the next cold 20 seconds, and not to save a "fail" of poison.
   */
  async _saveViaAdb(adbPath, { timeout = 45000 } = {}) {
    if (!adbPath) return false;
    if (!(await this._adbGuestHealthy(adbPath))) {
      this.log('Skip snapshot save: guest unauthorised or unactivated (avoids from depositing unauthorized drug snapshots))');
      return false;
    }
    return new Promise((resolve) => {
      execFile(adbPath, ['-s', this.serial, 'emu', 'avd', 'snapshot', 'save', SNAPSHOT_NAME],
        { timeout, windowsHide: true }, (err) => resolve(!err));
    });
  }

  recentLog(n = 40) { return this._log.slice(-n).map((x) => x.line); }

  /**
   * Only log lines generated by the Start-Up Attempt.
   * The memory logs are accumulated over the wheel (the diagnostic report will see all the attempts), but the diagnosis must be based only on the current round.:
   * Otherwise, the first round `emulator exit 3221225477` Any failure in Round 2 will be condemned to the same collapse.
   * When there’s no log in this round, back to the end, at least to a conclusion.
   */
  _attemptLines(from, max = 80) {
    const lines = this._log.slice(Math.max(0, from || 0)).map((x) => x.line);
    return lines.length ? lines.slice(-max) : this.recentLog(max);
  }

  /**
   * Read the last n line from the end of the emulator.log file (in memory buffers for empty hours).
   * When the user restarted the Hydra Emulator and re-exported the diagnostic report, this._log in the memory was empty.,
   * The old version of the report leaves only one sentence: the real cause of the crash is in the log file.
   */
  tailLogFile(n = 300) {
    try {
      const file = path.join(store.DATA_DIR, 'logs', 'emulator.log');
      const size = fs.statSync(file).size;
      const take = Math.min(size, 2 * 1024 * 1024);
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(take);
        fs.readSync(fd, buf, 0, take, size - take);
        const lines = buf.toString('utf8').split(/\r?\n/);
        // If you read it from the beginning, the first line might be cut off and you can throw it away.
        if (take < size) lines.shift();
        return lines.slice(-n);
      } finally { fs.closeSync(fd); }
    } catch (_) { return []; }
  }
}

module.exports = { EmulatorEngine, AVD_NAME, SNAPSHOT_NAME };
