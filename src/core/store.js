'use strict';
/**
 * Local sustainability: Apply List+Setup
 * Data directory: %APPDATA%\hydra(MSIX/ Shop version available below in STORE_BULD instructions)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { safeFilePart } = require('./pkgname');

/**
 * Is Microsoft Store (MSIX/ APPX) packing?
 *
 * Full-trust application for MSIX `%APPDATA%` / `%LOCALAPPDATA%` Down**Write**
 * Redirect to `%LOCALAPPDATA%\Packages\<PackageFamilyName>\LocalCache\...`,
 * But the environment variable and API are still returning the "real path" before being redirected. This could cause two types of accidents.:
 *   1. From %APDATA %\hydra If you don’t have an ID, you will be able to use it.,
 *      The search for files by real path “does not exist“
 *   The user point “open data directory“ sees an empty directory.
 * So the store page puts the data catalogue directly to AppData. **Outside**(%USERPROFILE%\Hydra Emulator),
 * The father-son process sees the same real document.
 *
 * Process. WindowsStore is injected by Electric in the MSIX/APPX environment (general node undefined).
 */
const STORE_BUILD = (() => {
  try { return !!require('electron').app?.isPackaged && !!process.windowsStore; } catch (_) { return false; }
})();

const DATA_DIR = STORE_BUILD
  ? path.join(os.homedir(), 'Hydra Emulator', 'data')
  : path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'hydra');
const ICON_DIR = path.join(DATA_DIR, 'icons');
const APK_DIR = path.join(DATA_DIR, 'apks');
const APPS_FILE = path.join(DATA_DIR, 'apps.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
  adbPath: '',
  device: '127.0.0.1:5555',
  /**
   * Driver (compatible patch) extension: The JSON patch written by the user is placed below the data directory.
   * Only "id turned off by the user" -- the default is all on, and it’s broken to a key off, without deleting the file.
   */
  drivers: { state: {}, disabled: [] },
  engine: {
    // Only running hours: self-stamping (bultin). Fields are reserved to accommodate old settings. json merges,
    // Read the settings to be forced back to 'Builtin'.
    mode: 'builtin',
    qemuPath: '',
    systemImage: '',
    memoryMB: 0,             // 0 = automatically determined by doctor by machine memory
    cores: 0,                // 0 = Auto
    autoMemory: true,        // Zero Configuration: Auto-promotion memory/core/disk/reflex parameters
    idleShutdownMinutes: 15,
    startVisible: true,
    // The window must be brought: No headless Flinger doesn’t show VSYNC, application is alive but nothing is on the screen.
    // The simulator with the window is the original 60fps + the original mouse keyboard, and Hydra Emulator is only responsible for dressing it up as an application window.
    headless: false,
    gpuMode: 'auto',         // auto = automatically pick backend and downgrade with emulator version
    // Render Backend for Last Pull Up `<emulator version > <gpu>`);auto next time to the end,
    // So you can’t wait 20 seconds to rewrite every time you’re on. It’s automatically disabled when you’re running.
    badGpu: '',
    forceTcg: false,         // reserved for advanced discharge; normal paths have been automatically returned by doctor
    audio: true,             // Android’s Applied Voice (Hip/Video). Close it. Save it a little.
    // - Light packaging (default full provincial resources, user-by-user turn off) -
    liteMode: true,          // Reconcile vCPU quotas, avoid qemu filling the physical nuclear slows down Windows
    // One sentence strategy: save (saving resources)/ Balanced (balanced)/ smooth (flux, video-playing priority).
    // Only this option is exposed on the interface, automatically translated when saving,
    // The bottom still keeps a fine switch for advanced users.
    resourceMode: 'balanced',
    // Data partition capacity (GB): Apply, game caches and their updates are here.
    // 0 = Auto (to 6/8GB on disk). Changed after next time when Android is open.**I’m going to build up.**, Don’t drop the loaded application.
    dataPartitionGB: 0,
    // Render resolution: The lower the flow flow, the less power; auto = 720x1280 / 540x960 by acceleration state
    renderSize: 'auto',
    // Network Accelerator: Designating a national public DNS. Android default 10.2.2.3 to host DNS,
    // VPN/ Corporate Network / some operators parse to hundreds of milliseconds, video-type applications first screens will send a clear release card.
    fastDns: true,
    locale: 'en-US',
    // Clipshot: Quickspot memory snapshots allow secondary start-up only for a few seconds, at the cost of an extra 2-3GB on disk
    // Ram.bin. Disk can be turned off when it’s tight (only affects start-up speed and not application data).
    keepSnapshot: true,
    // Log cap (KB): More than rolling a copy to avoid long-term use of full disks
    logLimitKB: 2048,
    // Mouse button: Left key is mapd from the emulator as "Acknowledging/Clicking", without switch.
    // Right key returns to smooth wheels require low-level hooks, but only apply front-stage fashion to the window, and the focal is uninstalled.
    mouseRightBack: true,    // Right key = Android returns (stop the default Qt ’s right key should also be clicked on))
    mouseWheelMode: 'smooth', // smooth = a slide when merged | Qt | off = Not processed
    mouseSideButtons: false, // Side key returns/gos forward: Default closes, open only to install an additional map
    deepTrim: false,         // Deep Cut System Backboard Package (Play Shop/Guide, etc.), default to remain on the system
    // ♪ Balanced= Out of the front desk ♪ | performance=qemu Normal | game=qemu High+ Low Delay Input
  priorityMode: 'balanced',
    // Preheat: Start Hydra Emulator and lead the Android environment backstage. First dot apps hardly have to wait.
    // The price is a permanent memory of about 1GB (same trade-off as the WSA/ APP), which can be shut off at any time.
    prewarm: true,
    // Multi-Windows (Project B): Allow multiple applications to be opened simultaneously, with separate windows. Default closes,
    // Keeping single windows open for "new and old"; Reclamation backstage after opening by the gravestone mechanism, resource-controlled.
    multiWindow: false,
    // Keep a few recent backstage applications for non-grave markers while multiple windows are in place.
    // 0 = minimum memory (only for front desk), default 1.
    keepBackground: 1,
    // Keymap (play keyboard touchscreen): By default, the user can turn it off in settings
    keymapEnabled: true,
    // Keymap table for each application: {com.example.game]: [{key:'w', action:'tap', x:0.15, y:0.75},}
    keymaps: {},
  },
  runtime: {
    dir: '',                 // Empty = %APPDATA %\hydra\runtime
    qemuUrl: '',             // Specify QEMU Installer Address Manually
    isoUrl: '',              // Manually specify a mirror address for the system
    isoPath: '',             // system image (ISO) path
    diskPath: '',            // Virtual disk to install the system
    diskSizeGB: 24,
    headless: false,         // Do not show virtual machine windows (debug only))
    installMode: 'guided',   // guided (guiding manual installation)) | Autu (experimental auto-installation))
    emulatorUrl: '',         // Manually specify the emulator package address (empty = automatically parsing the latest version from the SDK index))
    sysimgUrl: '',           // Manually specify the address of the system image bag
    compatImage: false,      // ARM Compatibility Mode: Switch to Google Play mirror (inline native ridge, ARM-only application))
    deployFailedAt: 0,       // Last time stamp for automatic deployment failed (0 = no failure). No automatic re-entry in 30 minutes after failure.
    // Full package for light copy running: Default download from this item GitHub Release (same source as Software Update)),
    // If you can’t get it back automatically, you can download the dl.google.com groupware. You can replace it with a self-made mirror address.
    preferGithubRuntime: true,
    runtimePackUrl: '',
    // GitHub Accelerator Prefix (optional). GitHub Releases, a direct link within the country, is often only a few dozen kB/s,
    // Fill in https://ghfast.top/ The mirror prefix can turn down requests.
    // Leave empty = straight.
    mirrorPrefix: '',
    // Downloads and distributions: Number of connections to be downloaded in blocks. Default 8, weak net/facilities can be moved to 16.
    downloadConnections: 8,
    // Third-party GitHub mirrors are opt-in.
    autoMirror: false,
  },
  sharedDir: path.join(os.homedir(), 'HydraShared'),
  deviceSharedDir: '/sdcard/HydraShared',
  autoConnect: true,
  createShortcutOnInstall: true,
  createStartMenuShortcut: true, // Start menu shortcut = allow Windows search to find application
  shortcutDir: '',           // Empty = Desktop
  freeform: false,           // Share a running window, no more Android freeform windows
  hideAfterLaunch: false,    // The main process has to be permanent, or the first time you quit, you kill Android while running.
  notifyOnInstall: true,
  autoStart: true,           // Start self-start, default start, user does not need setting
  autoDeploy: true,          // All deployments are automatically completed for the first run, and no further points of 1-5 moves are given
  // Start Welcome Card: LastDate Records the date of the last automatic ejection (up to one day when manually opened)),
  // Could not close temporary folder: %s
  welcome: { lastDate: '', disabled: false },
  /**
   * Autodetect (automatic debug): Timely take the machine state and push the list of questions to the interface.
   * Autu = running when no; intervalmin = interval (minutes);
   * Notify = notification of the system when a “new serious problem” arises (old problem does not repeat).
   */
  debug: { auto: true, intervalMin: 10, notify: true },
  display: {
    mode: 'window',          // Windows (Stamp Window, Free Stretch)) | FullScreen (auto-suited screen))
    portrait: '900x1600',    // The vertical resolution of window mode, which can be resized in settings
    density: 0,              // 0 = automatically deduced by resolution
    rememberBounds: true,    // Remember the window position/size of each application
    autoFullscreenOnLaunch: false,
    // = Change AVD physical panel to 1280x720 and restart (only way to get solid + full).
    // Lasts here, restarts Hydra Emulator and continues in this direction.
    landscape: false,
    // Screen Orientation Policy:
    //   Autu = automatic change of physical panel in the direction that you apply your own declaration (recommended, only to fill the window with this image))
    //   Landscape = Force crossscreen panel
    //   portrait = mandatory screenpad
    // The landscape field above is degraded to the fact that it is "the actual direction of the current panel" in autu mode.,
    // Written by restartForOrganization, no longer preferred to overwrite the direction of the application.
    orientationMode: 'auto',
    // Flatboard layout: overwrite the logical density of the guest to 190dpi (720 width sw606dp ~ 600dp),
    // Over Android's tablet breakpoint.,
    // It's also a "plate mode" that users want. Turn it off and go back to mirror default density.
    tabletMode: true,
    // Window load method: false = let simulator open its own raw window (Qt direct rendering, direction/scaling/input)
    // It’s all in its own hands, frame rates and drags.
    // True = Staple the Android image with SetParent into the shell window of Hydra Emulator (sense unity, title bar)
    // Rotation/Minimization/Maximization/Closing buttons)
    // 0.6.0 Start default primary window: Embedded mode to re-configurate another person's window to its own client area,
    // In scaling, rotation, the frame drops when switching applications, often accompanied by black edge/coordinate misposition/painting ——
    // These problems cannot be addressed in embedded ways, and the original window is bypassed from the root.
    // Both models can still be selected in the settings (display.windowEmbed).
    windowEmbed: false,
    // Auto rotation switch in mirror: open by default (accelerometer_rotation=1 for write)),
    // The panel direction is still determined by wm user-rotation lock + set-ignore-orientation-request,
    // It won't get twisted by the sensors. Turn it off and go back to the old mandatory locking.
    autoRotate: true,
  },
};

function ensureDirs() {
  for (const d of [DATA_DIR, ICON_DIR, APK_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    // When you remove a possible UTF-8 BOM. and bring BOM, JSON.parse would just throw the whole configuration in the wrong direction.
    // The silent returns to the default -- the user will see "all the settings are lost", but has no idea why.
    // This file will be set pages, synchronize tools, even hand-edited by users, and must be tolerated.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDirs();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Resource strategy Specific switch.
 *   Save: 2 vCPU + low priority + 540x960, old notebook / hang-up;
 *   Balanced: vCPU takes half (2~4)+ out of the front desk + 720x1280;
 *   smooth: No limit to vCPU + priority with front desk + 720x1280, video and game priority.
 * 1080p:Quickboot quick-tied fingerprints tied to it, one time it’s cold again, and 720p
 * There’s no difference in the window of the cellular ratio, but it’s not working.
 */
function resourcePreset(mode) {
  switch (String(mode || '')) {
    case 'save':
      return { resourceMode: 'save', liteMode: true, priorityMode: 'balanced', renderSize: '540x960' };
    case 'smooth':
      return { resourceMode: 'smooth', liteMode: false, priorityMode: 'game', renderSize: '720x1280' };
    case 'balanced':
    default:
      return { resourceMode: 'balanced', liteMode: true, priorityMode: 'balanced', renderSize: 'auto' };
  }
}

const store = {
  DATA_DIR, ICON_DIR, APK_DIR,
  // Stores (MSIX) wrapping tags: main.js turn off self-renewed and skip kernel-driven installation that requires administrator privileges
  STORE_BUILD,

  getSettings() {
    const s = deepMerge(DEFAULT_SETTINGS, readJson(SETTINGS_FILE, {}));
    /**
     * 0.5.6 No third-party base in place: mode=mumu / fydeos / anatach in old configuration,
     * Or any other value that the hand changes, it’s always built up to handle and delete the remaining third-party fields.
     *
     * Change objects in memory only when reading, not immediately write back to disk: set file to user, next time.
     * Saves the settings to fall naturally; so "Open Hydra Emulator Once" changes his settings.json will not happen.
     */
    s.engine.mode = 'builtin';
    for (const k of ['mumuPath', 'mumuIndex', 'mumuRenderProfile', 'mumuMemoryGB', 'mumuCores', 'fydeosHost']) {
      delete s.engine[k];
    }
    // The old version defaults to run headless: the application process can get up but there is no window on the screen, the equivalent being "cannot open".
    // Move unconditionally to the window mode and no longer allow it to be turned off through the old configuration.
    s.engine.headless = false;
    // When the old version exits the shell, it kills the entire Android running, causing the desktop icon to flash away.
    s.hideAfterLaunch = false;
    // The old version uses Android freeform windows, and now the entire emulator window is the application window.,
    // The application must be filled with this screen, otherwise there will be another window in the window.
    s.freeform = false;

    /**
     * Final award for window-carrying mode: **The default must be the emulator’s original window**.
     *
     * 0.5.9 Forced relocation of all persons to embedded mode, resulting in embedded mode (SetParent+ repeatedly)
     * SetWindowPos rehearsing another's window) drops the frame when scaling/rotating/ cutting is applied, with the black edge,
     * The coordinates are misallocated, the disgruntled, is the type of problem that the user feedback is most focused on. The original window is simulator-owned.
     * Rendering and routing, these problems do not exist, so defaulting to revert to it.
     *
     * There's no more “movemarks“ here: just users.**No active selection on the settings page**
     * (WindowsEmbedChosen, written by the setup page), read values are always corrected to their originals and stored on disks.
     * The previous writings just went through the window EmbedMigrated2 is already true, so let it go, so it’s in the configuration.
     * The window Embed: True will be in effect all the time -- the window of the shell that the user started to see after the upgrade.,
     * But they think that the default settings are not changed. The baseline is based on whether or not it has been selected, and all the other marks are not counted.
     */
    try {
      const raw = readJson(SETTINGS_FILE, {});
      const d = (raw && raw.display) || {};
      if (d.windowEmbedChosen !== true && d.windowEmbed !== false) {
        s.display.windowEmbed = false;
        s.display.windowEmbedMigrated2 = true;
        // Rewrite immediately, ensure that the configuration file itself is returned to its original origin; keep the other fields as they are.
        writeJson(SETTINGS_FILE, {
          ...raw,
          display: { ...d, windowEmbed: false, windowEmbedMigrated2: true },
        });
      }
    } catch (_) { /* Relocation failure does not affect start, keeping the read value */ }

    return s;
  },

  saveSettings(patch) {
    const next = deepMerge(this.getSettings(), patch);
    // When only the Resource Strategy was changed, it was translated into three specific switches, avoiding two sets of configurations talking.
    if (patch && patch.engine && patch.engine.resourceMode) {
      Object.assign(next.engine, resourcePreset(next.engine.resourceMode));
    }
    writeJson(SETTINGS_FILE, next);
    return next;
  },

  getApps() {
    const data = readJson(APPS_FILE, { apps: [] });
    return Array.isArray(data.apps) ? data.apps : [];
  },

  saveApps(apps) {
    writeJson(APPS_FILE, { apps });
  },

  upsertApp(app) {
    const apps = this.getApps();
    const i = apps.findIndex((a) => a.package === app.package);
    if (i >= 0) apps[i] = { ...apps[i], ...app };
    else apps.push(app);
    this.saveApps(apps);
    return app;
  },

  removeApp(pkg) {
    const apps = this.getApps().filter((a) => a.package !== pkg);
    this.saveApps(apps);
  },

  getApp(pkg) {
    return this.getApps().find((a) => a.package === pkg) || null;
  },

  iconPath(pkg) {
    // Second defense: pkg from an external parse APK/ apps.json, must be locked in the data directory.
    // Even if there are bad records from an old version, it cannot be spelled out as a path (issue #2 P0-1) outside of ICON_DIR.
    return path.join(ICON_DIR, `${safeFilePart(pkg)}.png`);
  },

  apkPath(pkg, version = 'cur') {
    const v = /^[A-Za-z0-9_-]+$/.test(String(version)) ? version : 'cur';
    return path.join(APK_DIR, `${safeFilePart(pkg)}-${v}.apk`);
  },

  ensureDirs,
  DEFAULT_SETTINGS,
};

module.exports = store;
