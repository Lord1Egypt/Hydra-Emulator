'use strict';
/**
 * Running (Provisioning))
 *
 * Hydra Emulator does not rely on any third-party simulator: adb, QEMU, system mirrors are all downloaded/checked/managed by themselves.
 * All running files are on %APPDATA %\hydra\runtime Now, make sure you can write it at any installation.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn, execFile } = require('child_process');
const store = require('./store');
const doctor = require('./doctor');
const { download, downloadAny, downloadAnyParallel, downloadMulti, head, discardPartial } = require('./download');
const { ZipArchive, ZipFile, resolveZipEntry } = require('./zip');
const { Sources } = require('./sources');
const { cmpVer } = require('./version');

const IS_WIN = process.platform === 'win32';

const SOURCES = {
  adb: [
    'https://dl.google.com/android/repository/platform-tools-latest-windows.zip',
  ],
  qemuIndex: 'https://qemu.weilnetz.de/w64/',
  qemuFallback: [
    'https://qemu.weilnetz.de/w64/qemu-w64-setup-20260811.exe',
  ],
  // Google Official SDK Index: the real address of emulator and the mirror of the system is dynamically parsed from here, without writing the number of the dead version
  sdkIndex: 'https://dl.google.com/android/repository/repository2-3.xml',
  sysImgIndexes: [
    'https://dl.google.com/android/repository/sys-img/android/sys-img2-3.xml',
    'https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-3.xml',
  ],
  aehdFallback: 'https://dl.google.com/android/repository/aehd-windows_v2.2.zip',
  // Boop: Known version directly used when indexes are not available
  emulatorFallback: 'https://dl.google.com/android/repository/emulator-windows_x64-16847572.zip',
  sysimgFallback: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/x86_64-34_r14.zip',
  // ARM compatible mirror (Google Play version, built-in native Bridge))
  playImgIndex: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/sys-img2-3.xml',
  playImgFallback: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/x86_64-34_r14.zip',
  // Android-x86 9.0-r2 (x86_64): use only when the user has its own ISO
  iso: [
    'https://master.dl.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso?viasf=1',
    'https://nchc.dl.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso',
    'https://phoenixnap.dl.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso',
    'https://downloads.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso',
  ],
  isoSizeHint: 900 * 1024 * 1024,
  // Lighter version (without running) takes "runtime full package" from here:
  // Used to be a light version of the dl.google.com mirror of emularator/ system, often on the domestic network
  // If stuck in dozens of KB/s or even directly 404; replace with whole package + GitHub for this item, download source and update source
  // It’s the same place, and if there’s a problem, it’s just one place to fix it.
  ghReleaseApi: 'https://api.github.com/repos/Lord1Egypt/Hydra-Emulator/releases',
  ghReleasePage: 'https://github.com/Lord1Egypt/Hydra-Emulator/releases',
  // Once on both sides, whoever gives the "highest version of the whole package when running" first uses it.
};

/**
 * The SDK index. <url> It's a relative path. The base directory is different.:
 *   repository2-3.xml      → https://dl.google.com/android/repository/
 *   sys-img/android/*.xml  → https://dl.google.com/android/repository/sys-img/android/
 * So the base directory always takes the “Indices file itself“ . Before you take the file name as a URL, you throw it.
 */
const REPO_BASE = 'https://dl.google.com/android/repository/';

function baseOf(indexUrl) {
  const s = String(indexUrl || '');
  const i = s.lastIndexOf('/');
  return i > 0 ? s.slice(0, i + 1) : REPO_BASE;
}

function absUrl(u, base = REPO_BASE) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  return base + s.replace(/^\/+/, '');
}

/**
 * Only one “generally based mirror“ will be retained.
 * Old version default AOSP API30 + optional API34 Play compatible mirror, leading to:
 *   - The user's application of ARM, which is a national product, is bound to fail, as well as the manual cutting of mirrors (practical thresholds);
 *   - Two mirrors 0.6 ~ 3 GB each, running with a dozen GBs;
 *   - Switch mirrors to wope-data, all loaded toss.
 * Now unified to Android 14 Google Play x86_64:x86 application, ARM application, GMS can run,
 * Only one read-only base layer (container sharing) is stored on the full machine, which can be downloaded once as necessary.
 */
const PLAY_SYSIMG = { api: '34', tag: 'google_apis_playstore', abi: 'x86_64' };
const DEFAULT_SYSIMG = PLAY_SYSIMG;

const MIN_SIZE = {
  adb: 5 * 1024 * 1024,
  qemu: 60 * 1024 * 1024,
  iso: 400 * 1024 * 1024,
  disk: 1024 * 1024,
  emulator: 200 * 1024 * 1024,
  sysimg: 300 * 1024 * 1024,
  aeHD: 64 * 1024,
};

function run(cmd, args, { timeout = 60000, cwd, windowsHide = true } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, cwd, windowsHide, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err });
    });
  });
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch (_) { return 0; }
}

/**
 * Writeability detection of the directory (results in a directory cache).
 *
 * Why don’t you use fs. accessSync(dir, W_OK): Windows reads only “read-only“ file properties,
 * No ACL, yeah. C.:\Program Files\WindowsApps\...(MSIX Install Directory) gives the wrong idea.
 * "Writable" conclusion, and then... .img.xxz was half-opened before it failed. Here, write a search file and delete it.
 */
const _dirWritableCache = new Map();
function provisionDirWritable(dir) {
  if (_dirWritableCache.has(dir)) return _dirWritableCache.get(dir);
  let ok = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.hydra-wtest-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'x');
    fs.rmSync(probe, { force: true });
    ok = true;
  } catch (_) {
    ok = false;
  }
  _dirWritableCache.set(dir, ok);
  return ok;
}

/**
 * Completely downloaded integrity check. If not,**Delete this incomplete file.**.
 *
 * It used to be a mistake, and it didn’t delete the file, so tmp keeps one and a half of it forever.
 * Download() takes Range extension when you see an existing file - the bytes that follow if the server/ source changes
 * And the first half of it doesn’t work, and the first half fails, and the second half is left behind... and the user sees "always downloading again."
 */
function assertComplete(file, minBytes, label) {
  const size = fileSize(file);
  if (size >= minBytes) return size;
  discardPartial(file);
  throw new Error(`${label} Download incomplete(${(size / 1048576).toFixed(1)} MB, clean up, please try again`);
}

/**
 * The environmental detection results are in the crucible.
 *
 * `emulator -version` with `emulator -accel-check` A new emulator process is required every time,
 * 1 to 3 seconds on Windows; these two are constant when the engine/drivers remain unchanged.
 * It used to be a 30-second cache in memory, which is like a re-payment for every cold start, and it’s stuck right here.
 * The moment the user clicks on the application. This is based on "exe size+change time + AEHD driver + WHPX component"
 * Make fingerprints drop to %APPDATA%, automatically invalid as soon as the hardware and software change.
 */
const ENV_CACHE_TTL = 6 * 60 * 60 * 1000;
const ENV_CACHE_NEG_TTL = 10 * 60 * 1000; // Speeding up “not available“ for 10 minutes only: users may just have gone virtual.

function envCacheFile() {
  return path.join(store.DATA_DIR, 'cache', 'env.json');
}

function statKey(p) {
  try {
    const s = fs.statSync(p);
    return `${s.size}:${Math.round(s.mtimeMs)}`;
  } catch (_) { return ''; }
}

class Provisioner {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this._hypervisor = null;
    this._cache = { adbVersion: '', qemuVersion: '' };
    this._sources = new Sources(() => store.getSettings());
  }

  /** A single entry for double source/sphere (speed cache is also here, with multiple components sharing one)) */
  get sources() {
    return this._sources;
  }

  /** Cache Fingerprint: Switch any changes to engine files and acceleration drivers */
  _envKey(exe) {
    const aehd = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'aehd.sys');
    return [
      String(exe || '').replace(/\\/g, '/').toLowerCase(),
      statKey(exe),
      statKey(aehd),
      fs.existsSync('C:\\Windows\\System32\\WinHvPlatform.dll') ? '1' : '0',
    ].join('|');
  }

  envCacheGet(exe) {
    try {
      const j = JSON.parse(fs.readFileSync(envCacheFile(), 'utf8'));
      if (!j || j.key !== this._envKey(exe)) return null;
      return j;
    } catch (_) { return null; }
  }

  envCacheSet(exe, patch) {
    try {
      const key = this._envKey(exe);
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(envCacheFile(), 'utf8')) || {}; } catch (_) { /* First */ }
      const base = cur.key === key ? cur : { key, version: null, accel: null, accelAt: 0 };
      const next = { ...base, ...patch, key, at: Date.now() };
      fs.mkdirSync(path.dirname(envCacheFile()), { recursive: true });
      fs.writeFileSync(envCacheFile(), JSON.stringify(next));
    } catch (_) { /* Cache write-off does not affect the main process */ }
  }

  /** Call when startup fails (accelebrator/sphere problems): Next time redetect, avoid always misusing conclusions */
  invalidateEnvCache() {
    this._cache = { adbVersion: '', qemuVersion: '' };
    try { fs.rmSync(envCacheFile(), { force: true }); } catch (_) { /* ignore */ }
  }

  // - - - - The path - - - -

  get root() {
    const r = store.getSettings().runtime.dir;
    return r && r.trim() ? r : path.join(store.DATA_DIR, 'runtime');
  }

  paths() {
    const root = this.root;
    const sysTag = DEFAULT_SYSIMG.tag;
    const sysApi = DEFAULT_SYSIMG.api;
    const sysAbi = DEFAULT_SYSIMG.abi;
    // Can you write a directory while running?
    // Store (MSIX) version puts emulator / platform-tools / system-images directly in the installation package
    // (C):\Program Files\WindowsApps\...), The directory is read-only.:
    //   - Expanding .img.xz, building _tmp, building qemu/ will fail;
    //   - But the executable is allowed to run from the bag (and that’s how you have the package, %APDATA% virtualization)
    //     The view is the same as the parent process.
    // So the executables and writeables are separated: the executable paths continue to point to the data in the package, and the writing is possible.
    // (Mirror Open Directory / AVD/ Temporary Directory) all to user data directory.
    const rootWritable = provisionDirWritable(root);
    // AVD (with user data, installed application, quickshot) must be in a place where it can be written and will not be cleared.
    // The single file release is run with a package that is down to the temporary directory, and putting AVD in is like throwing it out every time you quit.
    // As long as the directory is not in %APPDATA% at runtime, fix AVD to the user data directory.
    // Also: Allow separate "Andrea Data Catalogs" in settings -- it's where the plate is actually eaten.
    // (6~24GB data partition + 2~3GB snapshot), only when running, and without it, the C-disk will be full.
    const explicitAvd = String(store.getSettings().runtime.avdDir || '').trim();
    const writable = explicitAvd || path.join(store.DATA_DIR, 'avd');
    const insideData = root.toLowerCase().startsWith(store.DATA_DIR.toLowerCase());
    // Where's the mirror on the system?: **Directory priority when running**.
    // The previous order was "User Data Directory First", with the consequence that the user changed the runtime directory to D Disk C Disk Space,
    // After the 1.4GB package is delivered to Disk D, the machinealizeImages expand the 3.3GB system. img back
    // C://Users//.../AppData//Roaming//hydra//system-images, C plated ate, and
    // The same set of mirrors is stored in two separate places (assay 1.2GB + 3.3GB exists).
    // Now: there are system-images in the runtime directory that are already used;
    // Not back to the user data directory (old version, single file distributions are all in this layout).
    const rootImg = path.join(root, 'system-images');
    const dataImg = path.join(store.DATA_DIR, 'system-images');
    // Three scenarios.:
    //  1) there are mirrors (products of complete unpressure) in the running-time directory, using them;
    //  2) The old user/single file distributions place mirrors in the user data directory where they are used;
    //  3) Full new installation (none of them) landed in the running-time directory, because the user data directory might have been used
    //     Redirected temporary directory (as is the case when the CI is assembled and running, and writing is a failure to directly verify).
    //  4) runtime directory read-only (in MSIX package) → must be dropped to the user data directory, otherwise .img.xxz cannot be opened.
    //
    // In addition (0.6.0 repairs): Select the "Agrigated Mirror" to be preferred.
    // There’s system-images (even if only. img.xx), and there’s a copy in the user’s data directory.
    // 3.1GB available system.img, but also every time a compressed package is removed - once the compressed package is cut (0.5.9 is the first time that the compressed package is removed)
    // And so, untying inevitably fails, in the form of "no application can be opened."
    // Now, whoever can use it directly, choose the drop point for downloading/repressure when it’s incomplete.
    const expandedImgDir = (base) => path.join(base, `android-${sysApi}`, sysTag, sysAbi, 'system.img');
    const hasExpanded = (base) => {
      try { return fs.statSync(expandedImgDir(base)).size > 100 * 1024 * 1024; } catch (_) { return false; }
    };
    let sysRoot;
    if (!rootWritable) sysRoot = dataImg;
    else if (hasExpanded(rootImg)) sysRoot = rootImg;
    else if (hasExpanded(dataImg)) sysRoot = dataImg;
    else if (fs.existsSync(rootImg)) sysRoot = rootImg;
    else if (fs.existsSync(dataImg)) sysRoot = dataImg;
    else sysRoot = rootImg;
    return {
      root,
      // Put temporary directory/ help directory below root only when possible, otherwise change to data directory
      writeRoot: rootWritable ? root : path.join(store.DATA_DIR, 'runtime'),
      qemuDir: path.join(root, 'qemu'),
      qemuExe: path.join(root, 'qemu', 'qemu-system-x86_64.exe'),
      qemuImg: path.join(root, 'qemu', 'qemu-img.exe'),
      adbDir: path.join(root, 'platform-tools'),
      adbExe: path.join(root, 'platform-tools', 'adb.exe'),
      // Emulator run (Google Official): root also acts as ANDROID_SDK_ROOT
      emulatorDir: path.join(root, 'emulator'),
      emulatorExe: path.join(root, 'emulator', 'emulator.exe'),
      sysImgRoot: sysRoot,
      sysImgDir: path.join(sysRoot, `android-${sysApi}`, sysTag, sysAbi),
      avdHome: insideData ? path.join(root, 'avd') : writable,
      aehdDir: path.join(rootWritable ? root : path.join(store.DATA_DIR, 'runtime'), 'aehd'),
      imagesDir: path.join(rootWritable ? root : path.join(store.DATA_DIR, 'runtime'), 'images'),
      iso: path.join(root, 'images', 'android-x86.iso'),
      disk: path.join(root, 'images', 'android.qcow2'),
      tmp: path.join(rootWritable ? root : path.join(store.DATA_DIR, 'runtime'), '_tmp'),
      rootWritable,
      sysTag, sysApi, sysAbi,
    };
  }

  ensureDirs() {
    const p = this.paths();
    for (const d of [p.root, p.qemuDir, p.adbDir, p.imagesDir, p.tmp, p.avdHome]) {
      // P.root, store-by-store, in a read-only installation package, it’s normal not to be built.,
      // Writeable directories have been rerouted to user data directories (see paths()).
      // Let the whole starting path go wrong.
      try { fs.mkdirSync(d, { recursive: true }); } catch (_) { /* Read-only/occupated */ }
    }
    return p;
  }

  /**
   * Disk Guard: before downloading / decompressing a mass component, confirm that the target plate has enough space to use.
   * Otherwise, the system will fail in half, or the decompression phase will fail.
   * 1GB buffer: Simulator/scopic decomposition with snapshots, user data partitions will continue to expand.
   * @param{string} component component name (deciding space requirements estimate))
   * @param{string} targetDir Write Directory (based on which to locate the disk))
   */
  async guardDisk(component, targetDir) {
    const need = {
      adb: 64, emulator: 600, sysimg: 1800, playimg: 1800, qemu: 320, iso: 1100, aehd: 64,
      // Full package when running: 1.5 GB compression package + ~3.3 GB mirrors after expansion, peaks exist at the same time
      runtime: 5000,
    }[component] || 512; // MB
    const buf = 1024; // Additional reserve 1GB (sclip/ data partition / decompress middle file))
    const dir = targetDir || this.root;
    const free = doctor.freeDiskMB(dir);
    if (free && free < need + buf) {
      throw new Error(
        `Target disk space is insufficient: the component is required ${need + buf} MB, but,${dir}“The disk is left. ${free} MB.\n`
        + 'Proposal: Change "runtime data directory" to a more space-based disk (setup → system integration running-time data directory browse)), '
        + 'Or clean the disk / unmount the non-used application before trying it.',
      );
    }
    return free;
  }

  // - - - - Environmental inspection - - -

  async hypervisor() {
    if (this._hypervisor !== null) return this._hypervisor;
    if (!IS_WIN) { this._hypervisor = { whpx: false, note: 'Non Windows Platform' }; return this._hypervisor; }
    // Only millisecond file checking. The true "WHPX is available" gives the authoritative answer by emulator-accel-check.,
    // Avoid pulling PowerShell here to slow down every state round.
    const dll = fs.existsSync('C:\\Windows\\System32\\WinHvPlatform.dll');
    this._hypervisor = {
      whpx: false,          // Overwrite by emulatorAcccle() to the real value
      dll,
      hypervisorPresent: false,
      note: dll
        ? 'Virtual platform component exists (availability is tested by running-time engines))'
        : 'Windows Hydrovisor Platform component not detected: restarted after ticking “virtual machine platforms“ in “Enable or Close Windows Function“',
    };
    return this._hypervisor;
  }

  async adbVersion() {
    // 30s Cache, avoid frequent rounding of external processes
    if (this._adbCache && Date.now() - this._adbCache.at < 30000) return this._adbCache.value;
    const { adbExe, adbDir } = this.paths();
    const candidates = [adbExe, path.join(this.appRoot, 'tools', 'platform-tools', 'adb.exe')];
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      const r = await run(c, ['version'], { timeout: 10000 });
      if (r.ok) {
        const m = /version\s+([\d.]+)/i.exec(r.stdout);
        const v = { ok: true, path: c, version: m ? m[1] : r.stdout.split('\n')[0].trim() };
        this._adbCache = { at: Date.now(), value: v };
        return v;
      }
    }
    this._adbCache = { at: Date.now(), value: { ok: false, path: '', version: '' } };
    return this._adbCache.value;
  }

  async qemuVersion() {
    if (this._qemuCache && Date.now() - this._qemuCache.at < 30000) return this._qemuCache.value;
    const p = this.paths();
    const candidates = [
      p.qemuExe,
      store.getSettings().runtime.qemuPath,
      'C:\\Program Files\\qemu\\qemu-system-x86_64.exe',   // Winget Default Installing Location
      path.join(this.appRoot, 'engine', 'qemu', 'qemu-system-x86_64.exe'),
    ].filter(Boolean);
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      const r = await run(c, ['--version'], { timeout: 15000 });
      if (r.ok || r.stdout) {
        const m = /QEMU emulator version\s+(\S+)/i.exec(r.stdout);
        const v = { ok: true, path: c, version: m ? m[1] : (r.stdout || '').split('\n')[0].trim() };
        this._qemuCache = { at: Date.now(), value: v };
        return v;
      }
    }
    this._qemuCache = { at: Date.now(), value: { ok: false, path: '', version: '' } };
    return this._qemuCache.value;
  }

  /** Verify ISO9660 host volume descriptors (CD001 at 0x8001, offset), prevent the mirroring of wrong pages/half-sections */
  inspectIso(file) {
    const size = fileSize(file);
    if (!size) return { ok: false, iso9660: false, size: 0, reason: 'Not Downloaded' };
    let magic = '';
    try {
      const fd = fs.openSync(file, 'r');
      const b = Buffer.alloc(5);
      fs.readSync(fd, b, 0, 5, 0x8001);
      fs.closeSync(fd);
      magic = b.toString('latin1');
    } catch (_) { /* ignore */ }

    const iso9660 = magic === 'CD001';
    // User-imported raw/ loaded disk mirrors without ISO-guided areas, release by size
    const rawImage = !iso9660 && /\.(img|raw|qcow2)$/i.test(file) && size > MIN_SIZE.iso;
    const ok = size > MIN_SIZE.iso && (iso9660 || rawImage);

    let reason = '';
    if (!ok) {
      reason = size <= MIN_SIZE.iso
        ? `File Only ${(size / 1048576).toFixed(1)} MB, download not finished`
        : 'File is not valid ISO9660 mirror (possibly downloaded to the wrong page or the file is corrupted))';
    }
    return { ok, iso9660, rawImage, size, reason, magic };
  }

  async checkEnv() {
    const p = this.ensureDirs();
    const s = store.getSettings();
    const [adb, qemu, hv, emulator, accel] = await Promise.all([
      this.adbVersion(), this.qemuVersion(), this.hypervisor(),
      this.emulatorVersion(), this.emulatorAccel(),
    ]);

    const isoPath = s.runtime.isoPath || p.iso;
    const diskPath = s.runtime.diskPath || p.disk;
    const iso = this.inspectIso(isoPath);
    const diskSize = fileSize(diskPath);
    const sysimg = this.systemImageInfo();

    // The full version (inline runtime) is only one API 34 Google Play mirror, which is both the main and compatible mirror;
    // No longer relying on the compatImage switch, avoids "the mirror is there, but it’s not ready because it’s not open."
    const playImage = this.playImageInfo();
    const compatReady = playImage.ok;
    const emulatorReady = emulator.ok && (sysimg.ok || compatReady);
    const qemuReady = qemu.ok && diskSize > MIN_SIZE.disk;
    // What’s in the package is that the mirror is "in," but it’s just not yet expansed.
    // "You want to download online" -- you never download a mirror, you just roll it.
    const needsExtract = !!(sysimg.compressed || (compatReady && playImage.compressed));

    return {
      adb: { ...adb, required: true },
      emulator: { ...emulator, required: true, note: emulator.ok ? emulator.version : 'Not installed' },
      sysimg: {
        ok: sysimg.ok || compatReady,
        dir: sysimg.dir,
        size: sysimg.ok ? sysimg.size : (compatReady ? playImage.size : 0),
        api: sysimg.ok ? sysimg.api : (compatReady ? PLAY_SYSIMG.api : sysimg.api),
        compressed: needsExtract,
        required: false,
        note: sysimg.ok
          ? `Android ${sysimg.api}(${(sysimg.size / 1073741824).toFixed(2)} GB${sysimg.compressed ? ', Inline compressed version of the package, first time starting automatic expansion' : ''})`
          : (compatReady
            ? `Android ${PLAY_SYSIMG.api}(${playImage.compressed ? 'Inline compressed version of the package, first time starting automatic expansion' : 'ARM compatible mirror'})`
            : (sysimg.note || 'Not Downloaded')),
      },
      // True = mirror is local (in the package), just one time; upper layer based**Ban**Any Networked Downloads
      needsExtract,
      playImage,
      accel,
      qemu: { ...qemu, required: false },
      iso: {
        ok: iso.ok,
        path: isoPath,
        size: iso.size,
        iso9660: iso.iso9660,
        required: false,
        note: iso.size ? `${(iso.size / 1073741824).toFixed(2)} GB` : 'Not Downloaded',
        reason: iso.reason,
      },
      disk: {
        ok: diskSize > MIN_SIZE.disk,
        path: diskPath,
        size: diskSize,
        required: false,
        note: diskSize ? `${(diskSize / 1073741824).toFixed(2)} GB` : 'Not created',
      },
      hypervisor: hv,
      ready: !!(adb.ok && (emulatorReady || qemuReady)),
      engine: emulatorReady ? 'emulator' : (qemuReady ? 'qemu' : 'none'),
      paths: p,
    };
  }

  // ---------------- adb ----------------

  async installAdb(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('adb', p.root);
    const zipPath = path.join(p.tmp, 'platform-tools.zip');
    onProgress({ stage: 'download', message: 'Download Android platform-tools (approximately 8MB))…', percent: 2 });

    await downloadAny(SOURCES.adb, zipPath, {
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Download adb… ${(pr.got / 1048576).toFixed(1)}MB / ${(pr.total / 1048576).toFixed(1)}MB`,
        percent: pr.percent,
        speed: pr.speed,
      }),
    });

    assertComplete(zipPath, MIN_SIZE.adb, 'adb install package');

    onProgress({ stage: 'extract', message: 'Unpressurize adb…', percent: 92 });
    await this.extractZip(zipPath, p.root);

    const v = await this.adbVersion();
    if (!v.ok) throw new Error('The adb unrun after decompression, please check if the poison software intercepts');

    fs.rmSync(zipPath, { force: true });
    store.saveSettings({ adbPath: v.path });
    this._cache.adbVersion = v.version;
    onProgress({ stage: 'done', message: `adb ${v.version} Ready`, percent: 100 });
    return v;
  }

  /**
   * Use self-carried ZIP parser to unpressure (avoid reliance on system depressure tool))
   * Large entries (GB-level system.img) flow-through, small entries read in pieces, avoid crashing Node’s single Buffer cap.
   */
  // - - - - - - The whole package (light version) when this project GitHub is running - -

  async _fetchJson(url) {
    const text = await this._fetchText(url).catch(() => '');
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  /**
   * Parsing the “runtime whole“ download address.
   * Asset name engagement: Hydra Emulator-runtime-<tag>.Zip (by .github/workflows/release.yml),
   * This is the set of building/runtimes: emulator/ + platform-tools/ + aehd/ +system-images/).
   * Select the newest runtime archive published on GitHub.
   * Google official groupware downloads.
   */
  async resolveRuntimePack() {
    const custom = String(store.getSettings().runtime.runtimePackUrl || '').trim();
    if (custom) return { url: absUrl(custom), name: path.basename(custom.split('?')[0]), size: 0, tag: 'custom' };
    if (this._cache.pack) return this._cache.pack;

    const releases = await this._fetchJson(`${SOURCES.ghReleaseApi}?per_page=15`);
    if (!Array.isArray(releases)) throw new Error('Could not reach GitHub releases.');
    const cands = [];
    for (const release of releases) {
      if (!release || release.draft) continue;
      const asset = (release.assets || []).find((item) => /^Hydra[ -]Emulator-runtime-.*\.zip$/i.test(item.name || ''));
      if (!asset) continue;
      cands.push({
        url: asset.browser_download_url || asset.url,
        name: asset.name,
        size: asset.size || 0,
        tag: String(release.tag_name || release.name || '').replace(/^v/i, ''),
        page: release.html_url || SOURCES.ghReleasePage,
        from: 'GitHub',
      });
    }
    if (!cands.length) throw new Error('No Hydra runtime archive has been published yet.');
    cands.sort((a, b) => cmpVer(b.tag, a.tag));
    this._cache.pack = cands[0];
    return this._cache.pack;
  }

  /**
   * Lightly version one-key deployment: load and unpressure from this project, GitHub, while running.
   * System mirrors in the package are .xxz, which was first turned on by the matrializeImages() (only once).
   */
  async installRuntimePack(onProgress = () => {}) {
    const p = this.ensureDirs();
    // Give me a progress first: find a version + speed check with no bytes, and the user of the reminder will think “crack dead.“
    onProgress({ stage: 'download', message: 'Fetching running-time version information…', percent: 1 });
    const pack = await this.resolveRuntimePack();
    await this.guardDisk('runtime', p.root);
    const zip = path.join(p.tmp, 'runtime-pack.zip');
    const total = pack.size || 0;
    const s = store.getSettings().runtime || {};
    const conn = Math.max(1, Math.min(16, Number(s.downloadConnections) || 8));

    onProgress({ stage: 'download', message: `Selecting the fastest download source(${pack.from || 'GitHub'} · ${pack.tag})…`, percent: 1 });
    // Candidate = Source + Mirror Prefix. Next 128KB each, to determine which speed to use.:
    // "Assuming by domain name" is often wrong in the field -- the same address is 30 kB/s, 5 MB/s.
    const urls = await this.sources
      .rank(this._downloadUrls(pack.url), { onProgress: (pp) => onProgress({ stage: 'download', message: pp.message, percent: 1 }) })
      .catch(() => this._downloadUrls(pack.url));

    onProgress({ stage: 'download', message: `Download run (approximately 1.5 GB, just once), ${conn} Thread)…`, percent: 2 });
    // The blocks are parallel (8 threads) much faster than the single stream: GitHub limits the speed of a single connection are common and only single flow is measured.
    // One or two hundred KB/s, eight threads can run across the area. Breaking through will return to one-way transmission.
    await downloadMulti(urls, zip, {
      connections: conn,
      onProgress: (pr) => {
        const pct = pr.percent != null ? pr.percent : (total ? Math.round((pr.got / total) * 100) : 0);
        const mb = `${(pr.got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`;
        const sp = Number(pr.speed) > 0 ? ` · ${(pr.speed / 1048576).toFixed(2)} MB/s` : '';
        const eta = Number(pr.eta) > 0 ? ` · Remaining treaties ${Math.ceil(pr.eta / 60)} min` : '';
        onProgress({
          stage: 'download',
          message: `Download when running ${mb}${sp}${eta}`,
          percent: Math.max(1, Math.min(90, Math.round(pct * 0.9))),
          speed: pr.speed,
        });
      },
    });
    assertComplete(zip, 200 * 1024 * 1024, 'Pack when running');

    onProgress({ stage: 'extract', message: 'Release run (approximately 1 minute))…', percent: 91 });
    await this.extractZip(zip, p.root, {
      onEntry: (name, done, all) => {
        if (done % 50 === 0) {
          onProgress({ stage: 'extract', percent: Math.min(99, 91 + Math.round((done / all) * 8)), message: `Unpressure. ${done}/${all}` });
        }
      },
    });
    try {
      fs.writeFileSync(path.join(p.root, '.runtime-pack.json'), JSON.stringify({
        name: pack.name, tag: pack.tag, at: new Date().toISOString(), from: pack.url,
      }));
      fs.rmSync(zip, { force: true });
    } catch (_) { /* It's not gonna work if the mark doesn't go in. */ }

    // The system. img in the whole package is .xxz compressed (consistent with the full layout installation package). This is immediately opened.,
    // Otherwise, checkEnv() will think "no mirrors of the system" and go to Google's next 1.4 GB.
    // The rollout failed to allow deployment to fail with reason: the old version here catch 0, the user sees progress
    // Stopped at 99% and then jumped back to "Return to Official Source" and went to the next 1.4GB.
    onProgress({ stage: 'extract', message: 'Expand system mirrors (about 1 minute, just once))…', percent: 99 });
    await this.materializeImages((m) => onProgress({ stage: 'extract', message: m, percent: 99 }));

    onProgress({ stage: 'done', message: 'Runtime ready', percent: 100 });
    return { ok: true, name: pack.name, tag: pack.tag };
  }

  /**
   * Downloading address candidate: direct priority, second mirror prefix.
   * Sources is treated uniformly, with the benefit of “hfast/ gh-proxy“ and user custom prefixes
   * Only one place to maintain it, and to share a single speed measure cache with a multi-twice download.
   */
  _downloadUrls(url) {
    return this.sources.candidates(url);
  }

  async extractZip(zipPath, destDir, opts = {}) {
    // Large package (emulator/ system image) takes the file version: do not read the whole package of 1.5 GB Zip into memory,
    // Low memory machines can stabilize the pressure; small bags are in memory, faster.
    const big = fileSize(zipPath) > 64 * 1024 * 1024;
    const zip = big ? new ZipFile(zipPath) : new ZipArchive(fs.readFileSync(zipPath));
    const STREAM_THRESHOLD = 64 * 1024 * 1024;
    const total = zip.names().length;
    let done = 0;

    try {
      for (const name of zip.names()) {
        // Zip-slip Guard (issue #2 P0-4): Run time packages from network, entry name not credible.
        // Directory entries and file entries must be legitimate relative paths within destDir.
        const target = resolveZipEntry(destDir, name);
        if (!target) {
          if (opts.onUnsafeEntry) opts.onUnsafeEntry(name);
          continue;
        }
        if (name.endsWith('/')) {
          fs.mkdirSync(target, { recursive: true });
          continue;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const e = zip.entries.get(name);
        if (e.uncompSize > STREAM_THRESHOLD) {
          // eslint-disable-next-line no-await-in-loop
          await zip.pipeTo(name, fs.createWriteStream(target));
        } else {
          fs.writeFileSync(target, zip.read(name));
        }
        done += 1;
        if (opts.onEntry) opts.onEntry(name, done, total);
      }
    } finally {
      if (zip.close) zip.close();
    }
    return destDir;
  }

  // ----------Emulator (Google official operating hours) ----------------------------------------------------------------------------------------------------------------------

  /** Grab a XML text (with a maximum size, index file approximately 400KB)) */
  async _fetchText(url, limit = 2 * 1024 * 1024) {
    const { openStream } = require('./download');
    const res = await openStream(url);
    // #2 P1-1: Extroy() neither 'end' nor “overtaken“,
    // This Promise never setle, deployment wizard permanently stuck in the "disabling index."
    // With a single setle + hard time, any path is settled only once.
    return new Promise((resolve) => {
      let d = '';
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(d);
      };
      const timer = setTimeout(() => { try { res.destroy(); } catch (_) {} finish(); }, 30000);
      res.on('data', (c) => {
        if (done) return;
        d += c;
        if (d.length > limit) {
          d = '';                       // Nothing beyond the upper limit. Don't take half an index.
          try { res.destroy(); } catch (_) {}
          finish();
        }
      });
      res.on('end', finish);
      res.on('close', finish);
      res.on('error', finish);
    });
  }

  /** Dynamicly parsing the latest Windows emulator package address from the SDK index */
  async resolveEmulatorUrl() {
    const cached = store.getSettings().runtime.emulatorUrl;
    if (cached && cached.trim()) return absUrl(cached);
    if (this._cache.emulatorUrl) return this._cache.emulatorUrl;
    try {
      const xml = await this._fetchText(SOURCES.sdkIndex);
      const block = /<remotePackage path="emulator"[\s\S]*?<\/remotePackage>/.exec(xml);
      if (block) {
        const base = baseOf(SOURCES.sdkIndex);
        const urls = [...block[0].matchAll(/<url>([^<]+)<\/url>/g)].map((m) => absUrl(m[1], base));
        const win = urls.find((u) => /windows_x64.*\.zip$/i.test(u));
        if (win) {
          this._cache.emulatorUrl = win;
          return win;
        }
      }
    } catch (_) { /* I’m gonna get you out of here. */ }
    this._cache.emulatorUrl = SOURCES.emulatorFallback;
    return SOURCES.emulatorFallback;
  }

  /** parsing default AOSP system image addresses from sys-img index */
  async resolveSysimgUrl() {
    const cached = store.getSettings().runtime.sysimgUrl;
    if (cached && cached.trim()) return absUrl(cached, baseOf(SOURCES.sysImgIndexes[0]));
    if (this._cache.sysimgUrl) return this._cache.sysimgUrl;
    const want = `system-images;android-${DEFAULT_SYSIMG.api};${DEFAULT_SYSIMG.tag};${DEFAULT_SYSIMG.abi}`;
    for (const idx of [SOURCES.playImgIndex, ...SOURCES.sysImgIndexes]) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const xml = await this._fetchText(idx);
        const re = new RegExp(`<remotePackage path="${want.replace(/[;]/g, ';')}"[\\s\\S]*?</remotePackage>`);
        const block = re.exec(xml);
        if (block) {
          const base = baseOf(idx);
          const urls = [...block[0].matchAll(/<url>([^<]+)<\/url>/g)].map((m) => absUrl(m[1], base))
            .filter((u) => /x86_64.*\.zip$/i.test(u));
          if (urls.length) {
            this._cache.sysimgUrl = urls[urls.length - 1];
            return this._cache.sysimgUrl;
          }
        }
      } catch (_) { /* Change Index */ }
    }
    this._cache.sysimgUrl = SOURCES.sysimgFallback;
    return SOURCES.sysimgFallback;
  }

  async emulatorVersion() {
    if (this._cache.emulatorVersion && this._cache.emulatorVerAt && Date.now() - this._cache.emulatorVerAt < 30000) {
      return this._cache.emulatorVersion;
    }
    const p = this.paths();
    const candidates = [p.emulatorExe, path.join(this.appRoot, 'engine', 'emulator', 'emulator.exe')];
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      // Last session was detected and engine files remain unchanged: Pull up directly with the fallboard result (save the 1s+ process once).)
      const cached = this.envCacheGet(c);
      if (cached && cached.version && cached.version.ok && Date.now() - (cached.at || 0) < ENV_CACHE_TTL) {
        this._cache.emulatorVersion = cached.version;
        this._cache.emulatorVerAt = Date.now();
        return cached.version;
      }
      // eslint-disable-next-line no-await-in-loop
      const r = await run(c, ['-version'], { timeout: 20000 });
      const text = `${r.stdout}${r.stderr}`;
      const m = /Android emulator version\s+([\d.]+)/i.exec(text);
      if (m) {
        this._cache.emulatorVersion = { ok: true, path: c, version: m[1] };
        this._cache.emulatorVerAt = Date.now();
        this.envCacheSet(c, { version: this._cache.emulatorVersion });
        return this._cache.emulatorVersion;
      }
    }
    return { ok: false, path: '', version: '' };
  }

  /**
   * The first time a compressed image brought with the package is activated to the user directory (only once).
   * The single file distribution system. img is .gz (3.1GB ~ 580 MB around), which cannot be used without simulators.
   * Expand to %APPDATA% instead of the package: Portable running-time directories are new temporary directories every time they are started,
   * Put it in there is like every time you start it, recompress it.
   */
  async materializeImages(onLog = () => {}) {
    const srcRoot = path.join(this.root, 'system-images');
    // The target must be carried out with the same set of rules as the paths().sysImgRoot, otherwise it will happen.
    // "Pack to D Disk, mirrored back to C Disk APPDATA" duplicate occupancy (live 1.2GB + 3.3GB).
    const destRoot = this.paths().sysImgRoot;
    const jobs = [];
    const copies = []; // Files other than compressed mirrors (kernel-ranchu / Ramdisk / uncompressed .img etc.) must be dropped to the active directory
    const found = new Map(); // dest->job (same mirror as .xx/.gz with priority .xxz)
    const walk = (dir, rel = '') => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p, path.join(rel, e.name)); continue; }
        // Support .img.xz (LZMA2, smaller than .gz ~ 25%) and old .img.gz
        if (/\.img\.(xz|gz)$/i.test(e.name)) {
          const dest = path.join(destRoot, rel, e.name.replace(/\.img\.(xz|gz)$/i, '.img'));
          const job = { src: p, dest, xz: /\.xz$/i.test(e.name) };
          const prev = found.get(dest);
          if (!prev || (job.xz && !prev.xz)) found.set(dest, job);
        } else {
          copies.push({ src: p, dest: path.join(destRoot, rel, e.name) });
        }
      }
    };
    walk(srcRoot);
    jobs.push(...found.values());
    if (!jobs.length && !copies.length) return 0;

    // Completing non-recording files first (simulator uses position/guiding like kennel-ranchhu, missing "deflection to the system")
    for (const c of copies) {
      try {
        if (path.resolve(c.src) === path.resolve(c.dest)) continue;   // Expand in situ, without copying
        const have = fileSize(c.dest);
        if (have > 0 && have === fileSize(c.src)) continue;
        fs.mkdirSync(path.dirname(c.dest), { recursive: true });
        fs.copyFileSync(c.src, c.dest);
      } catch (e) { onLog(`Failed to copy mirror component: ${e.message}`); }
    }

    let done = 0;
    const failures = [];
    for (const j of jobs) {
      const have = fileSize(j.dest);
      // "It’s already been expanded" cannot be read only 32MB: no part of the old version, may be left after interruption
      // Hundreds of MB’s semi-sections, the threshold is considered complete as soon as they are, and they blow up on the system’s mirror.
      // Real mirrors must be bigger than compressed bags after decompression, so "less than compressed bags" = definitely not done.
      const srcSize = fileSize(j.src);
      if (have > 32 * 1024 * 1024 && (srcSize <= 0 || have >= srcSize)) continue;
      // Solve . part first, change name after success: Interrupt midway (off/ out) / disk full)
      // There’s no half-stem.img left to look like it’s finished, or it’s gonna skip the roll next time.,
      // When you turn on, you die of mirror damage, and you can only delete the data and come back.
      const part = `${j.dest}.part`;
      try { fs.rmSync(part, { force: true }); } catch (_) { /* ignore */ }
      fs.mkdirSync(path.dirname(j.dest), { recursive: true });
      onLog(`Started for the first time: System mirroring is being rolled out ${path.basename(j.dest)}(About a minute, just once.)`);
      try {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve, reject) => {
          const { pipeline, Readable } = require('stream');
          if (j.xz) {
            // LZMA2 Depressure: must be directly tied to the original.
            // The package’s default entry will be internal. js/ xz.js),
            // Node 20 of Electron does not support require (ESM) to make a mistake; and exportes do not allow
            // Write ’@napi-rs/lzma/index.js’ directly, so use require.resolve to locate the directory and quote it by file path.
            const path0 = require('path');
            let lzmaDir;
            try {
              lzmaDir = path0.dirname(require.resolve('@napi-rs/lzma'));
            } catch (_) {
              // When you’re packing, node_modules/@napi-rs will come to this place.
              // "Cannot find motore '@napi-rs/lzma'" + long string require track,
              // Users don’t understand it at all, but they just think, “No application can open.“
              // Tell him clearly that it’s not a complete installation package, not his computer.
              const e2 = new Error('The installation package is incomplete: @napi-rs/lzma is missing, the system image cannot be expanded. Please re-download the full version or change to the shop version.');
              e2.code = 'LZMA_MISSING';
              throw e2;
            }
            const { xz } = require(path0.join(lzmaDir, 'index.js'));
            const webIn = Readable.toWeb(fs.createReadStream(j.src));
            const webOut = xz.decompressStream(webIn);
            pipeline(Readable.fromWeb(webOut), fs.createWriteStream(part), (err) => (err ? reject(err) : resolve()));
          } else {
            pipeline(
              fs.createReadStream(j.src),
              zlib.createGunzip(),
              fs.createWriteStream(part),
              (err) => (err ? reject(err) : resolve()),
            );
          }
        });
        fs.renameSync(part, j.dest);
        done += 1;
      } catch (e) {
        try { fs.rmSync(part, { force: true }); } catch (_) { /* ignore */ }
        // Can’t swallow silently anymore: Caller must know that the mirror is not working.,
        // Otherwise, it would be “a further 1.4 GB“ or a failure to directly start.
        failures.push(`${path.basename(j.dest)}: ${e.message}`);
        onLog(`Failed to expand mirror: ${e.message}`);
      }
    }
    if (failures.length) {
      const err = new Error(`System mirroring failed(${failures.join('; ')})`);
      err.code = 'MATERIALIZE_FAILED';
      err.failed = failures;
      throw err;
    }
    return done;
  }

  /**
   * The system image is complete.
   *
   * There are two forms of "complete":
   *   1. Existing `system.img`(Local cache / user ’s running-time directory specified in the settings;
   *   2. **It's in the bag. `system.img.xz` / `.gz`** —— Store (MSIX) and full version installation packages
   *      It's all in this form, and the first time it's started is by the matrializeImages() on the ground.
   *
   * The second one must count as ok, otherwise checkEnv(). read will be false, autoDeploy
   * "The user hasn’t been shot yet." Pulls a 1.5 GB online -- this is exactly what it is.,
   * The root of the download. Returning the value’s commressed tag indicates that "it also needs to be expanded once."
   */
  systemImageInfo() {
    const p = this.paths();
    const roots = [p.sysImgRoot, path.join(this.root, 'system-images'), path.join(this.appRoot, 'engine', 'system-images')];
    // Find it in the default position (API34 Play) and back to "any mirror."
    // Single file distribution may only have a smaller AOSP mirror, API34 will cause
    // The mirror was in the bag, but it was “not downloaded,“ and users were forced to download a new set online.
    const preferred = [p.sysImgDir,
      path.join(this.appRoot, 'engine', 'system-images',
        `android-${DEFAULT_SYSIMG.api}`, DEFAULT_SYSIMG.tag, DEFAULT_SYSIMG.abi)];
    const candidates = [...preferred];
    for (const root of roots) {
      let apis = [];
      try { apis = fs.readdirSync(root).filter((d) => /^android-\d+$/.test(d)); } catch (_) { continue; }
      apis.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
      for (const api of apis) {
        let tags = [];
        try { tags = fs.readdirSync(path.join(root, api)); } catch (_) { continue; }
        for (const tag of tags) {
          let abis = [];
          try { abis = fs.readdirSync(path.join(root, api, tag)); } catch (_) { continue; }
          for (const abi of abis) candidates.push(path.join(root, api, tag, abi));
        }
      }
    }
    let missing = null;
    let packed = null;   // Only the compressed package: yes, but to be expanded
    for (const dir of candidates) {
      const kernel = path.join(dir, 'kernel-ranchu');
      const m = /system-images[\\/]android-(\d+)[\\/]([^\\/]+)[\\/]([^\\/]+)$/.exec(dir);
      const api = m ? Number(m[1]) : DEFAULT_SYSIMG.api;
      const tag = m ? m[2] : DEFAULT_SYSIMG.tag;
      const abi = m ? m[3] : DEFAULT_SYSIMG.abi;
      // Enrolled priority
      const size = fileSize(path.join(dir, 'system.img'));
      if (size > MIN_SIZE.sysimg && fs.existsSync(kernel)) {
        return { ok: true, dir, size, api, tag, abi, compressed: false };
      }
      // Re-recognition of the compressed package (the normal pattern of the inside image))
      if (fs.existsSync(kernel)) {
        for (const name of ['system.img.xz', 'system.img.gz']) {
          const cs = fileSize(path.join(dir, name));
          if (cs > MIN_SIZE.sysimg) {
            if (!packed) packed = { ok: true, dir, size: cs, api, tag, abi, compressed: true, file: name };
            break;
          }
        }
      }
      if (!missing && fs.existsSync(dir)) {
        missing = { ok: false, dir, size, api, tag, abi, note: size ? 'Mirror incomplete' : 'Missing system.img' };
      }
    }
    // There’s a compressor package and use it: it needs to be expanded, but...**There’s no need for mirrors.**, There's no way to trigger a download online.
    if (packed) return packed;
    if (missing) return missing;
    return { ok: false, dir: p.sysImgDir, size: 0, api: DEFAULT_SYSIMG.api, tag: DEFAULT_SYSIMG.tag, note: 'Not Downloaded' };
  }

  /**
   * Hardware acceleration.
   * Emulator supports two kinds of accelerations on Windows: WHPX (system function, need to restart) and AEHD (Google home-driven, full and ready).
   */
  async emulatorAccel() {
    // The status round is done every few seconds, and -accel-check, to pull up an emulator process, must be cached
    if (this._cache.accel && this._cache.accelAt && Date.now() - this._cache.accelAt < 30000) {
      return this._cache.accel;
    }
    const p = this.paths();
    const exe = fs.existsSync(p.emulatorExe) ? p.emulatorExe
      : path.join(this.appRoot, 'engine', 'emulator', 'emulator.exe');
    if (!fs.existsSync(exe)) return { ok: false, kind: 'none', note: 'Uninstalled emulator' };

    // Dropboard Cache: No longer pulls up the emulator process at cold startup.
    // Unable to use only 10 minutes -- the user may have gone to virtualize/installation AEHD, to be able to reflect immediately.
    const cached = this.envCacheGet(exe);
    if (cached && cached.accel) {
      const ttl = cached.accel.ok ? ENV_CACHE_TTL : ENV_CACHE_NEG_TTL;
      if (Date.now() - (cached.accelAt || 0) < ttl) {
        this._cache.accel = cached.accel;
        this._cache.accelAt = Date.now();
        return cached.accel;
      }
    }

    const aehdSys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'aehd.sys');
    const hasAehdFile = fs.existsSync(aehdSys) || fs.existsSync(path.join(p.aehdDir, 'aehd.sys'));
    const hv = await this.hypervisor();

    const r = await run(exe, ['-accel-check'], { timeout: 30000 });
    const text = `${r.stdout}${r.stderr}`;
    const usable = /accel:\s*\n?0\b/.test(text) && !/ERROR_ACCESS_DENIED|not installed/i.test(text);

    let result;
    if (usable) {
      const kind = hasAehdFile && /aehd/i.test(text) ? 'aehd' : 'whpx';
      result = { ok: true, kind, note: kind === 'whpx' ? 'WHPX hardware acceleration enabled' : 'AEHD hardware acceleration enabled' };
    } else if (/can't find the emulator-check|corrupted tools installation/i.test(text) && hasAehdFile) {
      // Partially streamlined runtime packages leave out emular-check.exe, causing -accel-check to fail to draw conclusions.
      // At this point, as long as the AEHD driver is installed, press " Available" for processing: at startup emulator will mount the driver itself,
      // To avoid being misconstrued to be forced without acceleration - accel off.
      result = { ok: true, kind: 'aehd', note: 'AEHD hardware acceleration enabled (emulator-check missing, determined by driver))' };
    } else if (hasAehdFile && /aehd/i.test(text) && !/ERROR_ACCESS_DENIED/i.test(text)) {
      result = { ok: true, kind: 'aehd', note: 'AEHD hardware acceleration enabled' };
    } else if (hv.dll && /whpx/i.test(text) && !/error|denied/i.test(text)) {
      result = { ok: true, kind: 'whpx', note: 'WHPX hardware acceleration enabled' };
    } else {
      result = {
        ok: false,
        kind: 'none',
        whpx: hv.whpx,
        aehdInstalled: hasAehdFile,
        viaTcg: true,
        note: 'Hardware acceleration not enabled: Simulate the regression software (runable but slow). It is recommended that AEHD drive or open the Virtual Machine Platform',
      };
    }
    this._cache.accel = result;
    this._cache.accelAt = Date.now();
    this.envCacheSet(exe, { accel: result, accelAt: Date.now() });
    return result;
  }

  /** Download and install emulator (zip top is emulator/, directly to SDK root) */
  async installEmulator(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('emulator', p.root);
    const url = await this.resolveEmulatorUrl();
    const zip = path.join(p.tmp, 'emulator.zip');
    onProgress({ stage: 'download', message: 'Download running engine (approximately 440MB, go Google official source))…', percent: 1 });

    await downloadAnyParallel(this._downloadUrls(url), zip, {
      connections: 8,
      minChunk: 4 * 1024 * 1024,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Download running engine ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? `(${(pr.speed / 1048576).toFixed(1)} MB/s)` : ''),
        percent: Math.round(pr.percent * 0.85),
        canResume: true,
      }),
    });
    assertComplete(zip, MIN_SIZE.emulator, 'runtime engine');

    onProgress({ stage: 'extract', message: 'Decompress running engine…', percent: 88 });
    await this.extractZip(zip, p.root);
    fs.rmSync(zip, { force: true });

    // SDK root must also have platform-tools, otherwise emulator refuses to start
    this.ensurePlatformTools();

    const v = await this.emulatorVersion();
    if (!v.ok) throw new Error('Unable to run after emulator depressure, check if you are killed to intercept the poison software');
    this._cache.emulatorVersion = v.version;
    onProgress({ stage: 'done', message: `runtime engine ${v.version} Ready`, percent: 100 });
    return v;
  }

  /** Emulator requests a platform-tools directory under SDK root, otherwise it is direct FATAL */
  ensurePlatformTools() {
    const p = this.paths();
    fs.mkdirSync(p.adbDir, { recursive: true });
    if (fs.existsSync(p.adbExe)) return true;
    const src = [
      path.join(this.appRoot, 'engine', 'platform-tools'),
      path.join(this.appRoot, 'tools', 'platform-tools'),
      path.dirname(this.adbVersionPath() || ''),
    ].find((d) => d && fs.existsSync(path.join(d, 'adb.exe')));
    if (!src) return false;
    for (const f of ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll']) {
      const from = path.join(src, f);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(p.adbDir, f));
    }
    return fs.existsSync(p.adbExe);
  }

  adbVersionPath() {
    try {
      const s = store.getSettings();
      if (s.adbPath && fs.existsSync(s.adbPath)) return s.adbPath;
    } catch (_) { /* ignore */ }
    return '';
  }

  /** Download only one general base mirror (Android 14 Play x86_64), no longer available "general/compatible" */
  async installSystemImage(onProgress = () => {}) {
    if (this.playImageInfo().ok) return this.playImageInfo();
    return this.installPlayImage(onProgress);
  }

  /** ARM compatible mirror (Google Play version) in place */
  playImageInfo() {
    const p = this.paths();
    const rel = `android-${PLAY_SYSIMG.api}/${PLAY_SYSIMG.tag}/${PLAY_SYSIMG.abi}`;
    // Look at both: Expanding the target (writable data catalogue) and the original location in the package.
    // The store/ full version of the installation package is system.img.xxz, which is only started when the first switch is on -- this must be here.
    // InstallSystemImage / autoDeploy will go online and reset it.
    const dirs = [path.join(p.sysImgRoot, rel), path.join(this.root, 'system-images', rel)];
    let packed = null;
    for (const dir of dirs) {
      if (!fs.existsSync(path.join(dir, 'kernel-ranchu'))) continue;
      const size = fileSize(path.join(dir, 'system.img'));
      if (size > MIN_SIZE.sysimg) {
        return { ok: true, dir, size, api: PLAY_SYSIMG.api, tag: PLAY_SYSIMG.tag, compressed: false };
      }
      if (!packed) {
        for (const name of ['system.img.xz', 'system.img.gz']) {
          const cs = fileSize(path.join(dir, name));
          if (cs > MIN_SIZE.sysimg) {
            packed = { ok: true, dir, size: cs, api: PLAY_SYSIMG.api, tag: PLAY_SYSIMG.tag, compressed: true, file: name };
            break;
          }
        }
      }
    }
    if (packed) return packed;
    const size = fileSize(path.join(dirs[0], 'system.img'));
    return { ok: false, dir: dirs[0], size, note: size ? 'Mirror incomplete' : 'Not Downloaded' };
  }

  /** Parsing Google Play mirror addresses(<url> Relative index file directory) */
  async resolvePlayUrl() {
    if (this._cache.playUrl) return this._cache.playUrl;
    try {
      const xml = await this._fetchText(SOURCES.playImgIndex);
      const want = `system-images;android-${PLAY_SYSIMG.api};${PLAY_SYSIMG.tag};${PLAY_SYSIMG.abi}`;
      const block = new RegExp(`<remotePackage path="${want}"[\\s\\S]*?</remotePackage>`).exec(xml);
      if (block) {
        const base = baseOf(SOURCES.playImgIndex);
        const urls = [...block[0].matchAll(/<url>([^<]+)<\/url>/g)].map((m) => absUrl(m[1], base))
          .filter((u) => /x86_64.*\.zip$/i.test(u));
        if (urls.length) {
          this._cache.playUrl = urls[urls.length - 1];
          return this._cache.playUrl;
        }
      }
    } catch (_) { /* I’m gonna get you out of here. */ }
    this._cache.playUrl = SOURCES.playImgFallback;
    return this._cache.playUrl;
  }

  /** Download and install ARM compatible mirrors (Google Play version, about 1.5 GB)) */
  async installPlayImage(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('playimg', p.sysImgRoot);
    const url = await this.resolvePlayUrl();
    const zip = path.join(p.tmp, 'play-sysimg.zip');
    onProgress({ stage: 'download', message: 'Download ARM compatible mirrors (Android 14, approximately 1.5 GB))…', percent: 1 });
    await downloadAnyParallel(this._downloadUrls(url), zip, {
      connections: 8,
      minChunk: 4 * 1024 * 1024,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Download compatible mirrors ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? `(${(pr.speed / 1048576).toFixed(1)} MB/s)` : ''),
        percent: Math.round(pr.percent * 0.8),
        canResume: true,
      }),
    });
    assertComplete(zip, MIN_SIZE.sysimg, 'compatible image');

    const dest = path.join(p.sysImgRoot, `android-${PLAY_SYSIMG.api}`, PLAY_SYSIMG.tag);
    fs.mkdirSync(dest, { recursive: true });
    onProgress({ stage: 'extract', message: 'Discharge compatible mirror (3GB, more than 10 seconds))…', percent: 82 });
    await this.extractZip(zip, dest, {
      onEntry: (_n, i, total) => onProgress({
        stage: 'extract',
        message: `Uncompress compatible image ${i}/${total}`,
        percent: 82 + Math.round((i / Math.max(1, total)) * 15),
      }),
    });
    fs.rmSync(zip, { force: true });

    const info = this.playImageInfo();
    if (!info.ok) throw new Error('Compatible mirror depressure failed to verify');
    // Old version (API 30) compatible mirrors are no longer in use, successfully installed and cleaned up
    for (const old of ['android-30']) {
      const legacy = path.join(p.sysImgRoot, old, 'google_apis_playstore');
      if (fs.existsSync(legacy)) fs.rmSync(legacy, { recursive: true, force: true });
    }
    onProgress({ stage: 'done', message: 'ARM compatible mirror ready, effective when restarted', percent: 100 });
    return info;
  }

  /** Download AEHD drivers (small files); installation requires administrator privileges and gives direction to the process */
  async installAehd(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('aehd', p.aehdDir);
    const zip = path.join(p.tmp, 'aehd.zip');
    onProgress({ stage: 'download', message: 'Download AEHD Driver…', percent: 10 });
    await downloadAnyParallel(this._downloadUrls(SOURCES.aehdFallback), zip, { connections: 2 });
    fs.mkdirSync(p.aehdDir, { recursive: true });
    await this.extractZip(zip, p.aehdDir);
    fs.rmSync(zip, { force: true });
    const has = fs.existsSync(path.join(p.aehdDir, 'aehd.Sys')) || fs.existsSync(path.join(p.aehdDir, 'aehd.sys'));
    if (!has) throw new Error('AEHD Drive Package Uncomfort');
    this._cache.accel = null;
    this._cache.accelAt = 0;
    onProgress({ stage: 'done', message: 'AEHD driver ready for installation with administrator permissions', percent: 100 });
    return { ok: true, dir: p.aehdDir, installer: path.join(p.aehdDir, 'silent_install.bat') };
  }

  // ---------------- QEMU ----------------

  /** Fetch the latest installable file name in the official directory (no dead version number)) */
  async resolveQemuUrl() {
    const configured = store.getSettings().runtime.qemuUrl;
    if (configured && configured.trim()) return configured.trim();
    try {
      const { openStream } = require('./download');
      const res = await openStream(SOURCES.qemuIndex);
      const html = await new Promise((resolve, reject) => {
        let d = '';
        res.on('data', (c) => { d += c; if (d.length > 512 * 1024) res.destroy(); });
        res.on('end', () => resolve(d));
        res.on('error', reject);
      });
      const files = [...html.matchAll(/href="([^"]*qemu-w64-setup-(\d+)\.exe)"/g)]
        .map((m) => ({ file: m[1], ver: Number(m[2]) }))
        .sort((a, b) => b.ver - a.ver);
      if (files.length) {
        const f = files[0].file.replace(/^.*\//, '');
        return new URL(f, SOURCES.qemuIndex).href;
      }
    } catch (_) { /* Falling into backup source */ }
    return SOURCES.qemuFallback[0];
  }

  async installQemu(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('qemu', p.root);
    const setup = path.join(p.tmp, 'qemu-setup.exe');

    onProgress({ stage: 'resolve', message: 'Find the latest QEMU version…', percent: 1 });
    const url = await this.resolveQemuUrl();
    onProgress({ stage: 'download', message: `Download QEMU (approximately 200MB))…`, percent: 2, url });

    await download(url, setup, {
      resume: true,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Download QEMU… ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? `(${(pr.speed / 1024).toFixed(0)} KB/s)` : ''),
        percent: pr.percent,
        canResume: true,
      }),
    });
    assertComplete(setup, MIN_SIZE.qemu, 'QEMU Installer');

    onProgress({ stage: 'install', message: 'Installing QEMU (Silent))…', percent: 96 });
    // qemu-w64-setup is a NSIS installer: / S silent, /D specified directory (must be final and without quotes))
    const target = p.qemuDir;
    fs.mkdirSync(target, { recursive: true });
    await new Promise((resolve) => {
      const proc = spawn(setup, ['/S', `/D=${target}`], { windowsHide: true, stdio: 'ignore' });
      proc.on('exit', () => resolve());
      proc.on('error', () => resolve());
      setTimeout(() => { try { proc.kill(); } catch (_) {} resolve(); }, 600000);
    });

    const v = await this.qemuVersion();
    if (!v.ok) {
      throw new Error('QEMU installed but not found qemu-system-x86_64.exe: QEMU can be downloaded manually and pressured to engine/qemu/');
    }
    fs.rmSync(setup, { force: true });
    this._cache.qemuVersion = v.version;
    onProgress({ stage: 'done', message: `QEMU ${v.version} Ready`, percent: 100 });
    return v;
  }

  // -------------------------------------------------------------------------------------------------------

  async downloadIso(onProgress = () => {}) {
    const p = this.ensureDirs();
    const s = store.getSettings();
    const dest = s.runtime.isoPath || p.iso;
    await this.guardDisk('iso', path.dirname(dest));
    const custom = s.runtime.isoUrl && s.runtime.isoUrl.trim();
    const urls = custom ? [custom, ...SOURCES.iso] : SOURCES.iso;

    onProgress({ stage: 'download', message: 'Download Android-x86 9.0-r2 (approx. 900MB, 8 Threads))…', percent: 1 });
    const r = await downloadAnyParallel(urls, dest, {
      connections: 8,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Download System Mirrors… ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? `(${(pr.speed / 1024).toFixed(0)} KB/s)` : ''),
        percent: pr.percent,
        canResume: true,
      }),
    });

    const info = this.inspectIso(dest);
    if (!info.ok) {
      throw new Error(`system image not available: ${info.reason}${info.size && info.size < MIN_SIZE.iso ? ', You can click again and continue to pass.' : ''}`);
    }

    store.saveSettings({ runtime: { isoPath: dest } });
    onProgress({ stage: 'done', message: `system image ready(${(info.size / 1073741824).toFixed(2)} GB)`, percent: 100, path: dest });
    return { ...r, ...info };
  }

  /** Verify user-imported mirror/ISO */
  inspectImage(file) {
    const size = fileSize(file);
    if (!size) throw new Error('File does not exist or is empty');
    const fd = fs.openSync(file, 'r');
    const head4 = Buffer.alloc(4);
    fs.readSync(fd, head4, 0, 4, 0);
    fs.closeSync(fd);
    const magic = head4.toString('hex');
    let kind = 'unknown';
    if (magic === '514649fb') kind = 'qcow2';
    else if (head4.toString('ascii', 0, 4) === 'KDMV') kind = 'vmdk';
    else if (size > 400 * 1024 * 1024 && magic !== '00000000') kind = 'raw-or-iso';
    return { kind, size, path: file };
  }

  importIso(file) {
    const info = this.inspectIso(file);
    if (!info.ok) {
      const e = new Error(info.reason || 'Mirror File Not Available');
      e.invalidIso = true;
      throw e;
    }
    store.saveSettings({ runtime: { isoPath: file } });
    return { ok: true, ...info };
  }

  importDisk(file) {
    const info = this.inspectImage(file);
    store.saveSettings({ runtime: { diskPath: file } });
    return { ok: true, ...info };
  }

  // --------- Virtual diskette--------------------------------------------------------------------------------------------------------------------------------

  async createDisk(sizeGB = 24, onProgress = () => {}) {
    const p = this.ensureDirs();
    const s = store.getSettings();
    const dest = s.runtime.diskPath || p.disk;
    if (fileSize(dest) > MIN_SIZE.disk) return { ok: true, path: dest, existed: true };

    onProgress({ stage: 'disk', message: `Create ${sizeGB} GB Virtual Disk…`, percent: 40 });
    const qemuImg = fs.existsSync(p.qemuImg)
      ? p.qemuImg
      : path.join(path.dirname(store.getSettings().runtime.qemuPath || ''), 'qemu-img.exe');

    const tool = fs.existsSync(qemuImg) ? qemuImg : null;
    if (tool) {
      const r = await run(tool, ['create', '-f', 'qcow2', dest, `${sizeGB}G`], { timeout: 120000 });
      if (!r.ok) throw new Error(`Failed to create virtual disk for qemu-img: ${r.stderr || r.stdout}`);
    } else {
      throw new Error('qemu-img.exe not found, please install QEMU');
    }
    store.saveSettings({ runtime: { diskPath: dest } });
    onProgress({ stage: 'done', message: 'Virtual Disk created', percent: 100, path: dest });
    return { ok: true, path: dest, size: fileSize(dest) };
  }

  // --------------------------------------------------------------------------------------------------------------------------------------------

  async probeSources() {
    const [adb, qemu, iso] = await Promise.all([
      head(SOURCES.adb[0]),
      head(SOURCES.qemuFallback[0]),
      head(SOURCES.iso[0]),
    ]);
    return { adb, qemu, iso };
  }
}

module.exports = { Provisioner, SOURCES, MIN_SIZE, absUrl, baseOf };
