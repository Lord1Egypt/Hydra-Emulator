'use strict';
/**
 * Hydra Emulator Master Process
 * Function: Window / Tray / Single Example / Command Line Distribution (double click apk, desktop shortcut startup) / IPC
 */
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, shell, nativeImage, screen, globalShortcut } = require('electron');
const fs = require('fs');
const path = require('path');

const store = require('./core/store');
const { Runtime } = require('./core/engine');
const { Installer } = require('./core/installer');
const { Sharer } = require('./core/sharer');
const { parseApk } = require('./core/apk');
const { drawAppIcon } = require('./core/png');
const orientation = require('./core/orientation');

// Brand Logo (build/render-logo.js generation); back to an old version of the program drawn icon when missing
const LOGO_DIR = path.join(__dirname, 'ui', 'assets');
const LOGO_FILE = path.join(LOGO_DIR, 'logo.png');
const APPICON_FILE = path.join(LOGO_DIR, 'appicon.ico');
function loadBrandIcon(size) {
  try {
    if (fs.existsSync(LOGO_FILE)) {
      const img = nativeImage.createFromPath(LOGO_FILE);
      return size ? img.resize({ width: size, height: size, quality: 'best' }) : img;
    }
  } catch (_) { /* Programmable Icon */ }
  return nativeImage.createFromBuffer(drawAppIcon(size || 256));
}

// Trays with “small size simplified sign“: shrinks the 512 main sign to 16px and makes a mess, with no text and no text.
function loadTrayIcon() {
  try {
    const p = path.join(LOGO_DIR, 'tray-16.png');
    if (fs.existsSync(p)) return nativeImage.createFromPath(p);
  } catch (_) { /* Back to the program icon */ }
  return nativeImage.createFromBuffer(drawAppIcon(16));
}
const assoc = require('./core/assoc');
const windowctl = require('./core/windowctl');
const display = require('./core/display');
const { WinAgent } = require('./core/agent');
const pointer = require('./core/pointer');
const { KeymapEngine } = require('./core/keymap-engine');
const { PRESETS: KEYMAP_PRESETS } = require('./core/keymap');
const { AppWindow, TITLEBAR_H } = require('./core/appwin');
const { NotifyBridge } = require('./core/notify');
const { AndroidSettings } = require('./core/android');
const { Updater, findUninstaller } = require('./core/updater');
const leftovers = require('./core/leftovers');
const manual = require('./core/manual');

// When Windows windows are blocked, capturePage will get the old frame, auto screens will have to disable shielding.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('lang', 'en-US');

/**
 * When the system is full, save chromium (Cache / GPUCache / Local Storage) …)
 * Move to the disk where the Android Data Directory is.
 * Default to write these caches in %APPDATA%\hydra Li--Cboard can fail even when hundreds of MB are left.,
 * And the users often moved Android data to another disk, but the cache was squeezed on the C-disk.
 * It must be set up before the app ready, then become invalid.
 */
function relocateUserDataIfCrowded() {
  try {
    const doctor = require('./core/doctor');
    const freeMB = doctor.freeDiskMB(store.DATA_DIR);
    const avd = String(store.getSettings().runtime.avdDir || '').trim();
    if (!avd) return;
    const avdFree = doctor.freeDiskMB(avd);
    if (freeMB >= 2048 || avdFree <= freeMB * 2) return;
    const target = path.join(avd, 'appdata');
    fs.mkdirSync(target, { recursive: true });
    app.setPath('userData', target);
  } catch (_) { /* If you can't put it in, you can keep the default. It doesn't affect the start. */ }
}
relocateUserDataIfCrowded();

// Apply the window to embed the simulator in SetParent as a subwindow. Chromium default
// DirectComposition Top-Transparent Layer (Intermediate D3D Windows) /
// WS_EX_NORDERATIONTIONBITMAP) to create web pages, which are synthesized by DWM at the window level,
// It'll just cover the embedded subwindows -- it'll be "black, but Android is running."
// The shell interface has only one 38px titlebar and start mask, and the software is completely uncomfortable,
// Chromium is drawn directly into HWND, and the subwindow level is only effective when the hardware is turned off.
// If you want to compare effects, set HYDRA_HWACELL=1 start.
if (process.env.HYDRA_HWACCEL !== '1') app.disableHardwareAcceleration();

const APP_ROOT = path.join(__dirname, '..');
const IS_DEV = process.argv.includes('--dev');

/**
 * Light file log: There is no control table after packing, and the user can send the app.log when a problem arises.
 * Just the key nodes and anomalies, the normal path won’t last thousands of miles.
 */
function appLog(line) {
  try {
    const dir = path.join(store.DATA_DIR, 'logs');
    const limit = store.getSettings().engine.logLimitKB || 2048;
    require('./core/logfile').append(path.join(dir, 'app.log'), `${new Date().toISOString()} ${line}`, limit);
  } catch (_) { /* Log failure cannot affect the main process */ }
}
process.on('uncaughtException', (e) => appLog(`UNCAUGHT ${e && (e.stack || e.message)}`));
process.on('unhandledRejection', (e) => appLog(`REJECT ${e && (e.stack || e.message || e)}`));
// Leave a line of exit code on exit: when silent exits (no collapse, no before-quit), distinguish between
// “Stand off normally“ by the task manager “was removed by the system shut down“.
process.on('exit', (code) => appLog(`process exit code=${code}`));

/**
 * Full version (inline running) automatically takes over:
 * In the distribution kit, Hydra Emulator.exe is accompanied by runtime/ (emulator + platform-tools + AEHD + ARM compatible mirror).
 * Directly point rantime.dir at the first start (settings. json does not exist) and open compatible mode,
 * The user does not need any downloads and settings, open the box and then the user can reset the online version in the settings.
 */
/**
 * runtime directory with the installation package (runtime/, Microsoft store MSIX next to full exe)
 * app\resources\runtime)..non-empty = Simulators and mirrors are all local: it’s not supposed to be in the drawings.
 * “Low,“ autoDeploy should not be connected.
 *
 * You must state before bootstrapBundledRuntime() that the function is performed immediately upon loading the module,
 * Use `let` Declares that it will hit TDZ behind it.
 */
let bundledRuntimeDir = null;

function bootstrapBundledRuntime() {
  try {
    const exeDir = path.dirname(process.execPath);
    // Portable to put runtimes next to exe; portable for eelectron-Builder will release resources
    // The process exexe and resources are at the same level, so look at several candidate positions.
    const candidates = [
      path.join(exeDir, 'runtime'),
      path.join(path.dirname(exeDir), 'runtime'),
      path.join(process.resourcesPath || '', 'runtime'),
      path.join(process.resourcesPath || '', 'app', 'runtime'),
    ];
    // When built-in, only "emulator+any complete system image" is required. Do not write API version:
    // Single file distribution may be accompanied by smaller AOSP mirrors, and API34 will misconstrue it as not running.
    const hasImage = (dir) => {
      const root = path.join(dir, 'system-images');
      let apis = [];
      try { apis = fs.readdirSync(root); } catch (_) { return false; }
      for (const api of apis) {
        let tags = [];
        try { tags = fs.readdirSync(path.join(root, api)); } catch (_) { continue; }
        for (const tag of tags) {
          let abis = [];
          try { abis = fs.readdirSync(path.join(root, api, tag)); } catch (_) { continue; }
          for (const abi of abis) {
            const d = path.join(root, api, tag, abi);
            // The mirror in the single file distribution is a compressed storage (system.img.xz/.gz), uncompressed at first start.
            // It’s only recognized that System.img will be sentenced to no copy of the picture in the bag, instead of downloading it online.
            const hasSys = ['system.img', 'system.img.xz', 'system.img.gz']
              .some((f) => fs.existsSync(path.join(d, f)));
            if (hasSys && fs.existsSync(path.join(d, 'kernel-ranchu'))) return true;
          }
        }
      }
      return false;
    };
    const bundled = candidates.find((dir) =>
      fs.existsSync(path.join(dir, 'emulator', 'emulator.exe')) && hasImage(dir));
    if (!bundled) return;

    const s = store.getSettings();
    // Old version only takes over when settings.json does not exist: users first load online and then release the full version.,
    // The deployment wizard is always “deficit components.“ Now, as long as there is no emulator in the directory at the time of the current operation, take over.
    const explicit = String(s.runtime.dir || '').trim();
    const current = explicit || path.join(store.DATA_DIR, 'runtime');
    // "runtime of another installation package": Path is < directory>/resources/runtime, but not in this EXE directory tree.
    // It’s probably from "repressing the new portable package, settings.json remembering the old package path."——
    // The results are hidden: the new package is activated, and the last version of the emulator/sphere/scenario is actually running.,
    // The user upgrade is still Carton, and the orientation parameters are old, and even the old bag will never rise.
    // Directory (D) selected by the user:\Hydra Emulator Runtime, etc.) will not be harmed by this rule.
    const looksForeignBundle = /[\\/]resources[\\/]runtime$/i.test(current)
      && !path.resolve(current).toLowerCase().startsWith(path.resolve(exeDir).toLowerCase());
    if (looksForeignBundle && fs.existsSync(path.join(bundled, 'emulator', 'emulator.exe'))) {
      store.saveSettings({ runtime: { dir: bundled } });
      bundledRuntimeDir = bundled;
      appLog(`Directory point to another installation package when running(${current}), When running inside the package instead ${bundled}`);
      return;
    }
    const currentExe = path.join(current, 'emulator', 'emulator.exe');
    // If portable versions are moved/upgraded (repress to new directory), the settings are still old.:
    // "Runtime under this EXE directory" has to be recognized, otherwise the components in the old bag will be used forever.
    // (Tested: old bag emulator missing emulator-check accelerated detection failed back to TCG software simulation.
    const sameTree = path.resolve(current).toLowerCase()
      .startsWith(path.resolve(exeDir).toLowerCase());
    const currentOk = fs.existsSync(currentExe) && sameTree;
    // The directory that the user chooses (not in the EXE directory tree, for example, D):\Hydra EmulatorRuntime or something)
    // He may be trying to save the C-disc space, or to share one of the portable versions.
    // The old version is covered here as an exe-negative bindled runtime, and it’s a performance.
    // "The running-time data directory has been modified in the settings, and the result goes down to the old directory / AppData" (issue #23).
    if (explicit && !sameTree && fs.existsSync(currentExe)) {
      if (s.engine.gpuMode === 'swiftshader_indirect' || s.engine.memoryMB === 4096) {
        store.saveSettings({ engine: { gpuMode: 'auto', autoMemory: true, memoryMB: 0, cores: 0 } });
      }
      return;
    }
    // AVD user data is under that directory and cannot be moved quietly.
    if (currentOk) {
      // Run at EXE directory tree = it's a packaged (full version / shop version))
      bundledRuntimeDir = current;
      // But the automatic parameters are still open, the hard code in the old configuration is 4G/4 nuclear/discard GPU mode cannot continue.
      if (s.engine.gpuMode === 'swiftshader_indirect' || s.engine.memoryMB === 4096) {
        store.saveSettings({ engine: { gpuMode: 'auto', autoMemory: true, memoryMB: 0, cores: 0 } });
      }
      return;
    }
    // The package contains Google Play mirrors in compatible mode; AOSP mirrors with original x86_64 library
    let playBundled = false;
    try {
      const root = path.join(bundled, 'system-images');
      for (const api of fs.readdirSync(root)) {
        for (const tag of fs.readdirSync(path.join(root, api))) {
          if (/playstore|google_apis/i.test(tag)) playBundled = true;
        }
      }
    } catch (_) { /* Ignore */ }
    store.saveSettings({
      runtime: { dir: bundled, compatImage: playBundled },
      engine: { gpuMode: 'auto', autoMemory: true },
    });
    bundledRuntimeDir = bundled;
  } catch (_) { /* Take over failed not to block startup, go online. */ }
}
bootstrapBundledRuntime();

// Skip registration forms in automated settings like smoke-smoking screenshots (avoid reliance on reg.exe))
const NO_SHELL_PROBE = process.argv.includes('--smoke') || process.env.HYDRA_NO_SHELL_PROBE === '1';
const ICON_PNG = loadBrandIcon().toPNG();

let mainWindow = null;
let tray = null;
let runtime = null;
// "What windows are ours" is assigned by whenReady (see angentScope). The module level is because
// RunLaunch / Preheat timers predate that code definition, and the configs in closed bags are not visible in their extraterritorial effects.
let armAgent = async () => ({ ok: false });
let installer = null;
let sharer = null;
let quitting = false;
let winAgent = null;
let appWin = null;
let notifier = null;
let androidSet = null;
let updater = null;
let updateBusy = false;
let updateInfo = null;

/**
 * The status of the window open is at the module level.
 *
 * It was written in an app. whenReady() return (cost splashWin/ splashDone), and
 * RunLaunch() / autoDeploy() Defines the field of action in the outer layer - among them
 * `typeof splashDone === 'function'` Always the false, so...:
 *   - Progress text is never updated (always shown as "Preparation...");
 *   - Splash never closes after it’s started, and 480x360’s alwaysOnTop window is nailed to
 *     The center of the screen, on the Android screen.
 * This is the "open application with multiple windows" from the user feedback: managing the window/splash/application window is present at the same time.
 * These calls will be effective only when they are upgraded to the module level.
 */
let splashWin = null;
let splashProgress = () => {};
let splashDone = () => {};

// ---------------------

function parseArgs(argv) {
  const args = argv.slice(IS_DEV ? 2 : 1).filter((a) => !a.startsWith('--allow-file-access'));
  const out = { apk: null, launch: null, silent: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--launch') {
      // Electron will plug its own switch and app path into an argv, recognizing only the name of a co. foo. bar.
      const v = args.slice(i + 1).find((x) => x && /^[a-zA-Z][\w]*(\.[\w]+)+$/.test(x));
      if (v) { out.launch = v; out.silent = true; }
    } else if (a === '--silent' || a === '--autostart') out.silent = true;
    else if (/\.(apk|xapk|apks)$/i.test(a) && !a.startsWith('--')) out.apk = a;
  }
  return out;
}

/** Chromium solves WebP, nativeImage cannot; converting the APK icon to PNG using hidden windows */
let decodeWindow = null;
async function decodeIcon(raw) {
  if (!decodeWindow || decodeWindow.isDestroyed()) {
    decodeWindow = new BrowserWindow({ show: false, width: 2, height: 2, skipTaskbar: true });
    await decodeWindow.loadURL('about:blank');
  }
  const mime = /^RIFF/.test(raw.toString('ascii', 0, 4)) ? 'image/webp' : 'image/png';
  const js = `(async () => {
    const img = new Image();
    img.src = 'data:${mime};base64,${raw.toString('base64')}';
    await img.decode();
    const s = Math.min(256, Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = s; c.height = s;
    c.getContext('2d').drawImage(img, 0, 0, s, s);
    return c.toDataURL('image/png');
  })()`;
  const url = await decodeWindow.webContents.executeJavaScript(js);
  return Buffer.from(String(url).split(',')[1] || '', 'base64');
}

/** Start auto: By default, no user needs to set the ticking. */
function applyAutoStart() {
  if (!app.isPackaged) return; // Do not write registration forms on development
  const on = !!store.getSettings().autoStart;
  try {
    // You have to show it to the name, otherwise the start-up in the registration form will be called "electron.app. Electron".
    app.setLoginItemSettings({
      openAtLogin: on,
      name: 'Hydra Emulator',
      path: process.execPath,
      args: ['--autostart'],
    });
    // Clear the old version of the text (no name sent) and avoid repeating it.
    app.setLoginItemSettings({ openAtLogin: false, name: 'electron.app.Electron' });
  } catch (_) { /* Ignore when group strategy is prohibited */ }
}

// --------- display mode: Fullscreen self-adaptable / Mountable window adjustable ----

function displaySettings() { return store.getSettings().display || {}; }

/**
 * Windows Taskbar / Notified Identity.
 *
 * Why do you want to switch to an application: each Android applied desktop shortcut has written its own AUMID
 * (`Hydra. Emulator.`, See installer.createShortcut) and fast.
 * Icon is**The one that uses your own icon.**...Windows only "run process AUMID = fast track"
 * When AUMID’s is used, the running window and the taskbar fixed items will be merged into the same button, and the shortcuts will be used.
 * icon. The identity does not match the "fix item is an application icon, but another Hydra Emulator icon is added to the taskbar".
 *
 * SetAppUserModelId official proposal to adjust only once; yes in practice**Create after**window is valid (VS Code, etc.)
 * This is how a process runs multiple applications of the shell. This is only done before opening the window. ——
 * If a Windows version ignores it, it simply degrades to an exe icon, without affecting functionality.
 */
const APP_AUMID = 'Hydra.Emulator';
function setAumid(id) {
  try { app.setAppUserModelId(String(id || APP_AUMID).slice(0, 128)); } catch (_) { /* Not Windows or old version ignored */ }
}

/**
 * Should the application be cross-screened or stand-up?
 *
 * The physical panel of the emulator (hw.lcd) is the "real shape" of the image, Android wouldn't do it.
 * An application that doesn’t fit the panel direction to rotate the whole panel -- it’s only going to apply one mailbox.
 * The middle narrow, black on both sides. So the only way to "paint the window" is: panel direction = application direction.
 *
 * Priority: Force mode in settings > manual overlaying of > APK lists peruse natural direction
 * > When frontboard direction (application of statement not reboot when following gravity)
 */
function wantLandscapeFor(pkg) {
  const ds = displaySettings();
  const app = pkg ? store.getApp(pkg) : null;
  return orientation.resolveLandscape({
    mode: ds.orientationMode || 'auto',
    orientation: app && app.orientation,
    orientationOverride: app && app.orientationOverride,
    panelLandscape: !!ds.landscape,
  });
}

/**
 * Rotate the current application 's unified entry: calculate the target direction → Write per-app overwrite restart panel.
 *
 * Previous titlebar buttons, Tray menus, Ctrl+R count the ’Next Direction’, the base is not consistent
 * (One to see the play.landscape, one to look at the appWin.state.landscape.,
 * Writing the coverage of apps.json and the true cutting past panel direction may be the opposite, next time start
 * And if you want LandscapeFor to turn it back -- that's the root of why the red beers don't come across.
 * Now you always want LandscapeFor(pkg) as the only benchmark, take the reverse and write overlay + cut.
 */
async function rotateCurrentApp() {
  const pkg = appWin && appWin.pkg;
  const current = pkg ? wantLandscapeFor(pkg) : !!displaySettings().landscape;
  const next = orientation.flipLandscape(current);
  if (pkg) {
    store.upsertApp({ package: pkg, orientationOverride: orientation.overrideValue(next) });
    appLog(`orientation override ${pkg} = ${orientation.overrideValue(next)}`);
  }
  // AppWin.rotate updates the titlebar status and alignment window; entering a uniform next as the target direction,
  // It calls from within to complete panel switching (restart only).
  if (appWin && appWin.isOpen) {
    await appWin.rotate((want) => restartForOrientation(want, { reloadApp: false }), next).catch(() => {});
  } else {
    await restartForOrientation(next, { reloadApp: false }).catch(() => {});
  }
  return { ok: true, landscape: next };
}

/**
 * The real direction of the "learning" application during the run.
 *
 * Delineate AndroidManifest’s application to red nuts is enough.),
 * But some of the applications are declared to be sensor / fullSensor, and there’s no indication of bias in the list.
 * Ask Android for the system once after running.
 * The final value based on the application of the actual request. Write it in apps.json, and then start the next panel.
 */
async function learnAppOrientation(pkg) {
  const app = store.getApp(pkg);
  if (!app || app.orientation || app.orientationOverride) return null;
  let out = '';
  try {
    out = await runtime.client().shell(
      'dumpsys activity activities | grep -m1 requestedOrientation', { timeout: 8000 });
  } catch (_) { return null; }
  const s = String(out || '');
  let value = null;
  if (/requestedOrientation=SCREEN_ORIENTATION_(PORTRAIT|SENSOR_PORTRAIT|REVERSE_PORTRAIT|USER_PORTRAIT)/.test(s)) value = 'portrait';
  else if (/requestedOrientation=SCREEN_ORIENTATION_(LANDSCAPE|SENSOR_LANDSCAPE|REVERSE_LANDSCAPE|USER_LANDSCAPE)/.test(s)) value = 'landscape';
  if (!value) return null;
  store.upsertApp({ package: pkg, orientation: value });
  appLog(`learned orientation ${pkg} = ${value}`);
  return value;
}

function screenRect() {
  const d = screen.getPrimaryDisplay();
  const a = d.workArea || d.bounds;
  return { x: a.x || 0, y: a.y || 0, w: a.width || 1920, h: a.height || 1080 };
}

let currentAppPkg = null;
let wheelRouter = null;
const deviceSize = { value: null };

/** Wheels need to know the Android side resolution; cache once, disabled after turnback/restart */
async function getDeviceSize() {
  if (deviceSize.value) return deviceSize.value;
  try { deviceSize.value = await runtime.client().wmSize(); } catch (_) { /* He's not up yet. */ }
  if (!deviceSize.value || !deviceSize.value.width || !deviceSize.value.height) {
    const p = portraitSize();
    deviceSize.value = { width: p.w, height: p.h };
  }
  return deviceSize.value;
}

function portraitSize() {
  const d = displaySettings();
  return display.portraitSize(d.portrait || '540x960');
}

/** Set the page to change the mouse button and sync the hook configuration to the current window focus immediately */
function refreshPointerMapping() {
  if (appWin && appWin.isOpen) appWin.refreshPointer();
  else if (winAgent && winAgent.hooked) winAgent.setHook(false).catch(() => {});
}

/**
 * Rotation = change physical panel size and restart simulator.
 *
 * It's the only way to get a "right + full" screen.):
 *   - wm size: Just a logical resolution, physical LCD remains vertical - > 90 degrees, only one top left corner;
 *   - wm denity: frambuffer sizes constant -> image not full, maximizes a big space on the right side;
 *   - adb emu network: only image content, the system still stands up.
 * Qt opens a window on a horizontal panel only if hw.ld.width/ height is replaced with a screen and restarted.
 */
async function restartForOrientation(landscape, { reloadApp = true } = {}) {
  if (!appWin || !appWin.isOpen) return false;
  const pkg = appWin.pkg;
  store.saveSettings({ display: { landscape: !!landscape } });
  send('runtime:log', landscape ? 'Switch to screen: Restarting Android…' : 'Switching back screen: restarting Android…');
  try {
    // Reboot will destroy the simulator window and recreate it.,
    // In stand-alone window mode, let the shell window with a hint be exposed.
    try {
      appWin.showWaiting(landscape
        ? 'Switching to screen (reboot Android environment, about 40 seconds, just once))…'
        : 'Switching back screen (reboot Android environment, about 40 seconds, just once))…');
    } catch (_) { /* Window may just be closed */ }
    // Take the embedded window off first and avoid leaving a black window on the desktop during the restart.
    try { await appWin.agent.detach(); } catch (_) { /* ignore */ }
    await runtime.stop({ graceful: false }).catch(() => {});
    /**
     * When the adb side really doesn't see this device, pull it up again.
     *
     * There are hundreds of milliseconds between simulator process exit and adb side update:
     * `adb -s emulator-5554 get-state` Still "device".(),
     * It’ll go isOnline() directly determines "reused" and returns in seconds.,
     * But every last one of the adb orders is... `device 'emulator-5554' not found` ——
     * The whole trigger chain just broke when the panel was changed.
     */
    try {
      const c = runtime.client();
      for (let i = 0; i < 14; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const online = await c.isOnline().catch(() => false);
        if (!online) break;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 300));
      }
    } catch (_) { /* If you fail, you go straight ahead. There's still a way out. */ }
    appLog(`rotate -> landscape=${landscape} restarting runtime`);
    const rt = await runtime.ensure({
      onLog: (m) => { send('runtime:log', m); appLog(`  rt ${m}`); },
    });
    if (!rt || !rt.ok) { appWin.waitingForRestart = false; return false; }
    //  Here.**Not anymore.**Wait for network. The reboot of WiFi will be ready in 20 seconds or so, and the caller will be ready.
    // (I'm going to go back and forth.,
    // Two waiting periods are simply stacked: the first white one is full 25 seconds after the intuitive switch, the second one waits 23 seconds.,
    // One tow from 100 seconds to 125 seconds. Just one to keep the launch process uniform.
    if (reloadApp && pkg) {
      const app = store.getApp(pkg);
      if (app) {
        await rt.client.install(app.apkPath).catch(() => {});
        await rt.client.startApp(app.package, app.activity, {}).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 1500));
      await attachAppWindow();
      appWin.scheduleFit(6);
    }
    // Returns the new rt: beforeStart will replace the old (old clit has stopped))
    return rt;
  } catch (e) {
    appLog(`rotate restart failed: ${e && e.message}`);
    try { appWin.waitingForRestart = false; } catch (_) { /* Window destroyed */ }
    return false;
  }
}

/**
 * Put the Android image in front of the user. Two modes.:
 *   - Original window (default): Let the simulator open its own window, direction, scaling, input is all in its own hands.,
 *     There is no inherent black edge of the embedded method, the coordinates are mispositioned, the content is displeasureed, the frame is dropped;
 *   - Embedded: SetParent enters our own window, views the same, title bar with a rotation button.
 *   Control by setting display. windowEmbed (true is embedded).
 */
async function attachAppWindow() {
  if (!appWin) return false;
  const embedMode = displaySettings().windowEmbed === true;
  if (!embedMode) {
    /**
     * The primary window takes over and tries again.
     *
     * The time point when the simulator window appears in the system, and `am start` Returns time point not synchronized:
     * Cold start, snapshot recovery, just after changing the panel direction, the Qt window usually arrives hundreds of milliseconds late.
     * One or two seconds to see. Once, once, and after a failure, nothing -- the shell window "starting."
     * The user saw, "Initiating or your glamorous window.",
     * And it's never gonna get to the screen again.
     */
    for (let i = 0; i < 4; i += 1) {
      if (!appWin.isOpen) {
        appLog(`Attach detached: Shell window closed (No. 1) ${i + 1} Wheel)`);
        return false;
      }
      // eslint-disable-next-line no-await-in-loop
      const ok = await appWin.openDetached().catch((e) => {
        appWin.lastEmbedError = (e && e.message) || 'threw';
        return false;
      });
      if (ok) return true;
      appLog(`attach detached #${i + 1}  Failed: ${appWin.lastEmbedError || 'unknown'}`);
      // The window agent’s show/layout may just hit the window and recreate it.
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 400 + i * 600));
    }
    // No display of four rounds (remote desktop / visible card-driven anomaly / simulator has been activated --no-window):
    // Instead of keeping a screen black or a waiting page that’s going around forever, we’d better plug the image in.,
    // And clearly tell the user that this is the bottom of the line -- next time start with the original window still being prioritized.
    appLog('Standalone window could not be attached. Falling back to embedded mode.');
    const fallback = await appWin.embed().catch(() => false);
    if (fallback) {
      try {
        send('toast', { type: 'info', message: 'Simulator primary window failed to show. This temporary built-in window takes over the image' });
      } catch (_) { /* Main window may be closed */ }
    }
    return fallback;
  }
  const ok = await appWin.embed().catch(() => false);
  if (!ok) {
    setTimeout(() => { if (appWin.isOpen) appWin.embed().catch(() => {}); }, 1500);
    setTimeout(() => { if (appWin.isOpen) appWin.embed().catch(() => {}); }, 4000);
  }
  return ok;
}

/**
 * Open (or reuse) the "one applies a clean window".
 *
 * You have to put it first when you switch applications.**Previous**Apply the real switch off, or there'll be user feedback.
 * "Dot to open the second application, the first does not respond / ANR":
 *   - AppWin.open() used for old windows is close ({keepApp:true}) and it only takes windows.,
 *     **No, endApp**, So the old application process was neither used-stop nor left behind.
 *     _activeApps;
 *   - When new apps are available `first = _activeApps.size === 0` So the judgment was wrong.,
 *     Priority / snapshot logic is completely confused;
 *   - Two apps to grab the same simulator’s front desk.
 * So here's the rest of the old apps, and open a new window.
 */
async function openAppWindow(pkg, tip) {
  // Only "cut to another application" would need to be closed; repeat points are the same way to repeat, without interruption.
  if (currentAppPkg && currentAppPkg !== pkg && appWin && appWin.isOpen) {
    const prev = currentAppPkg;
    try {
      // Take off the image before stopping the process: the original simulator window in stand-alone window mode is the one the user is looking at.,
      // Park, hide it, and avoid leaving a black window on the desktop when the host is destroyed.
      await appWin.close({ keepApp: true });
      await runtime.endApp(prev, { onIdle: onContainerActive }).catch(() => {});
      appLog(`switch: closed ${prev} before launching ${pkg}`);
    } catch (e) {
      appLog(`switch close ${prev} failed: ${e && e.message}`);
    }
  } else if (currentAppPkg && currentAppPkg !== pkg) {
    // The window’s gone, but the process may still be in _activeapps, and it’s going to end.
    await runtime.endApp(currentAppPkg).catch(() => {});
  }
  const rec = store.getApp(pkg);
  const land = wantLandscapeFor(pkg);
  const p0 = portraitSize();
  const detached = displaySettings().windowEmbed === false;
  // The panel direction and application direction are not consistent, but before Start will reboot once (about 40 seconds).
  const willRestart = land !== !!displaySettings().landscape;
  // Separate window mode shell window not normally displayed, but**Period of waiting**You have to give the user a visible answer.:
  //   - Animated drawings are carried out when motor drawings are opened (first start);
  //   - You must show the shell window without animation (toggle application), otherwise you have 40 seconds to get nothing on the desktop.,
  //     Users will think the program is down.
  const splashVisible = !!(splashWin && !splashWin.isDestroyed());
  const label = (rec && rec.label) || pkg;
  // Cut the application’s identity first, then open the window: the taskbar will follow the shortcut icon.
  setAumid(`${APP_AUMID}.${pkg}`);
  appWin.open({
    pkg,
    label,
    iconPath: rec && rec.icoPath,
    // The window is opened in a horizontal scale when the screen is open, otherwise the vertical window will be filled with a large black side.
    portrait: land ? { w: p0.h, h: p0.w } : p0,
    // There are two paths to the full screen: the visible selection of the full screen mode, or the ticking of the automatic full screen on startup.
    // The latter used to be a dead switch.
    fullscreen: displaySettings().mode === 'fullscreen'
      || displaySettings().autoFullscreenOnLaunch === true,
    detached,
    showWhileWaiting: detached && !splashVisible,
  });
  // Start the application icon in the animation with the original PNG (iconPath, usually 192px+): ICO in Chromium
  // It's... <img> It’s only one size rendering, and it’s got a transparent margin, and the 64px container looks like it’s missing a piece.
  // The original window titlebar icon is only used in ICO (inopen() iconPath is still rec.icoPath, Win32 recognizes it).
  appWin.setIcon(rec && (rec.iconPath || rec.icoPath));
  // Initializes when open in saved direction (physical panel direction is determined in doctor.ldFor)
  appWin.setState({
    // When you need to reboot the panel, write "Why Slow" in the hint, and don't let the user guess at 40 seconds.
    tip: willRestart
      ? `Switching to ${land ? 'landscape' : 'portrait'} for ${label}. Android needs to restart…`
      : (tip || 'Starting Android…'),
    ready: false,
    landscape: land,
  });
  currentAppPkg = pkg;
}

async function toggleDisplayMode() {
  const next = store.saveSettings({
    display: { mode: displaySettings().mode === 'fullscreen' ? 'window' : 'fullscreen' },
  });
  const full = next.display.mode === 'fullscreen';
  if (appWin && appWin.isOpen) {
    // The image under stand-alone window mode is in the emulator's original window, the maximize shell window has no visual effect,
    // I’m going to have to put the simulator window back.
    if (displaySettings().windowEmbed === false) {
      appWin.toggleMaximize().catch(() => {});
    } else if (full) appWin.win.maximize();
    else appWin.win.unmaximize();
    appWin.scheduleFit(6);
    // Here.**Not anymore.**Cut the panel direction by hand.
    // Full screens and screens are two things: the panel direction is now determined by “a direction that applies its own declaration”.
    // (See wantLandscapeFor.
    // It’s stuck on the side of the screen, on the side of the black side, and the user thinks the full screen is not working.
  }
  return next.display.mode;
}

/** First run completes adb / emulator / system image at once, no more 1-5 moves */
let deploying = false;
async function autoDeploy({ force = false } = {}) {
  if (deploying || !store.getSettings().autoDeploy) return { ok: false, error: 'skipped' };
  // Download failed cooling: Previously, whenever checkEnv() was missing, Hydra Emulator would start again.
  // Pull the 1.5 GB runtime package, and the user sees "always over and over again."
  // Write a time stamp after failure, and do not try again automatically within 30 minutes; when the user "one key deployment" manually
  // Force=true can try again immediately. Success or human coercion clears the cooling.
  const COOLDOWN_MS = 30 * 60 * 1000;
  const lastFail = Number(store.getSettings().runtime.deployFailedAt || 0);
  if (!force && lastFail && Date.now() - lastFail < COOLDOWN_MS) {
    appLog(`AutoDeploy cooling (last failed in ${new Date(lastFail).toISOString()}), Skip Automatic Retry`);
    return { ok: false, error: 'cooldown', cooldown: true, until: lastFail + COOLDOWN_MS };
  }
  deploying = true;
  const progress = (p) => {
    send('provision:progress', { ...p, component: p.component || 'all' });
    // Synchronize push to open the mural window
    if (typeof splashProgress === 'function') splashProgress(p);
  };
  let succeeded = false;
  try {
    const env = await runtime.provisioner.checkEnv();
    const needEngine = !env.emulator.ok || !env.sysimg.ok;
    // Run with the package (full version of the package / Microsoft shop version)): **It's all offline.**.
    // The mirror is already in the bag (compressive form), and the first time it is started is by the engine.ensure() on the ground;
    // The next 1.5 GB here is a waste of time, and it’s the user’s complaint that it’s still in the mirror.
    if (bundledRuntimeDir && env.adb.ok && env.emulator.ok && env.sysimg.ok) {
      appLog(`AutoDeploy Skipped: Run with package inside(${bundledRuntimeDir}), No need to network.`
        + (env.needsExtract ? ', The mirror will be spread locally at the first start.' : ''));
      // This is...**Success**, It wasn’t a failure.
      // Failed to write deployFailedAt -- machine running every 30 minutes with a package
      // "Playing failed," the "last time failed..." in the log came from a normal skip.,
      // Users see the "retry deployment" of the setup page as a mist.
      succeeded = true;
      return { ok: true, source: 'bundled', needsExtract: !!env.needsExtract };
    }
    if (bundledRuntimeDir && !env.emulator.ok) {
      appLog(`AutoDeploy Skip Online Download: runtime directory with package(${bundledRuntimeDir}), Give it to the diagnostic process.`);
      // The return of the diagnostic process is also not a "download failure", so don’t cool it.
      succeeded = true;
      return { ok: false, error: 'bundled', bundled: true };
    }
    // The light version prioritizes "This item GitHub’s runtime package": a file handles emular + system mirrors,
    // The download and update source is harmonized on GitHub (more stable than dl.google.com).
    // The whole package is not available.
    if (needEngine && store.getSettings().runtime.preferGithubRuntime !== false) {
      try {
        progress({ message: 'Running from GitHub…' });
        await runtime.provisioner.installRuntimePack(progress);
        const afterPack = await runtime.provisioner.checkEnv();
        if (afterPack.emulator.ok && afterPack.sysimg.ok) {
          succeeded = true;
          return { ok: true, source: 'github' };
        }
        progress({ message: 'The whole package is incomplete when running, and it is filled by official sources…' });
      } catch (e) {
        progress({ message: `GitHub is not available when running(${e.message}), Change to official source…` });
      }
    }
    if (!env.adb.ok) {
      progress({ message: 'Preparing adb…' });
      await runtime.provisioner.installAdb(progress);
    }
    if (!env.emulator.ok) {
      progress({ message: 'Preparing Android for running…' });
      await runtime.provisioner.installEmulator(progress);
    }
    if (!env.sysimg.ok) {
      progress({ message: 'Preparing a mirror for Android system…' });
      await runtime.provisioner.installSystemImage(progress);
    }
    const after = await runtime.provisioner.checkEnv();
    succeeded = !!(after.adb.ok && after.emulator.ok && after.sysimg.ok);
    return { ok: succeeded };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    // Only "real failure" cools down; successful deployment clears old failures.
    try {
      store.saveSettings({ runtime: { deployFailedAt: succeeded ? 0 : Date.now() } });
    } catch (_) { /* The setting doesn’t affect the result. */ }
    deploying = false;
  }
}

function launcherInfo() {
  if (app.isPackaged) {
    return { target: process.execPath, args: '', cwd: path.dirname(process.execPath) };
  }
  return { target: process.execPath, args: `"${APP_ROOT}"`, cwd: APP_ROOT };
}

/** Recursive copy of directory contents ( Best-offort, without deleting the source; one-time move of old files when sharing directory rerouting)) */
function copyDirContents(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    try {
      if (entry.isDirectory()) copyDirContents(s, d);
      else fs.copyFileSync(s, d);
    } catch (_) { /* Failure of single file does not affect the rest */ }
  }
}

/** Enable a Windows optional function with administrator privileges (e. g. VirtualMachinePlatform/ HypervisorPlatform)) */
/**
 * The right to raise a Windows option.
 *
 * returns {ok, cancelled, code, feed}:
 *   Cancelled uses 1223 (ERROR_CANCELLED) to distinguish between "if the user points in UAC" and "real failure"——
 *   Both used to be ok:false, UI can only say "not open," and the user has no idea that he has called it off.
 */
function enableWindowsFeature(feature) {
  return new Promise((resolve) => {
    const inner = `Enable-WindowsOptionalFeature -Online -FeatureName '${feature}' -NoRestart -All`;
    const ps = `try { $p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru `
      + `-ArgumentList @('-NoProfile','-NonInteractive','-Command',${JSON.stringify(inner)}); exit $p.ExitCode } `
      + 'catch { exit 1223 }';
    const { spawn } = require('child_process');
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.on('exit', (code) => resolve({
      ok: code === 0, cancelled: code === 1223, restart: true, code, feature,
    }));
    proc.on('error', () => resolve({ ok: false, feature, error: 'Could not start PowerShell' }));
  });
}

/**
 * The WHPX that activates the system itself.
 *
 * Note: really let the Android emulator use the WHPX function
 * **“Windows Virtual Machine Monitor Program Platform“ (HypervisorPlatform))**;
 * Virtual MachinePlatform is used by WSL2 and is still not available for WHPX.
 * Both of them, covering the differences between the different machines.
 *
 * The DLL is in modern Windows.
 * (The live feeder WinHvPlatform.dll exists, but running is AEHD -- using it to judge if you can drive a WHPX.
 * It'll just keep the machine that really needs to be opened out the door.
 */
async function enableWhpxFeatures() {
  const steps = [];
  for (const f of ['HypervisorPlatform', 'VirtualMachinePlatform']) {
    // eslint-disable-next-line no-await-in-loop
    steps.push(await enableWindowsFeature(f));
  }
  return { ok: steps.some((s) => s.ok), cancelled: steps.every((s) => s.cancelled), steps };
}

/** Manual guide for shop editions: MSIX bag fix mediumIL, which is usually not available */
const MSIX_ACCEL_HINT = 'The Store build cannot request elevation. Open Windows Features, enable Windows Hypervisor Platform, and restart Windows.';

// - - - - Main window - - -

function createWindow({ show = true } = {}) {
  mainWindow = new BrowserWindow({
    width: Number(process.env.HYDRA_WIN_W) || 1140,
    height: Number(process.env.HYDRA_WIN_H) || 740,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: '#f7f8fa',
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#f7f8fa', symbolColor: '#2b3138', height: 44 },
    icon: nativeImage.createFromBuffer(ICON_PNG),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  if (show) mainWindow.once('ready-to-show', () => mainWindow.show());

  // Smoking tests hit the stdout: interface blank and the button clicked to no reaction,
  // In 10 cases, an id in an app.js changed and dropped an anomaly, which was not visible to the normal running.
  if (process.argv.includes('--smoke')) {
    mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
      if (level >= 2) console.log(`[renderer] ${message} (${String(source).split('/').pop()}:${line})`);
    });
  }

  // The outer chain is always given to the system browser (public/ GitHub etc.) and the application window is never steered.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file://')) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  mainWindow.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWindow.hide();
    notify('Hydra Emulator is still running backstage.', 'Click a tray icon to open again; right key tray to exit.');
  });

  if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  return mainWindow;
}

function showWindow() {
  // Back to Management Window = Back to Hydra Emulator’s own identity (or the taskbar will follow the previous application’s icon))
  setAumid(APP_AUMID);
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// --------------------------------------------------------------------------------------------------------------------------------------

let manualWindow = null;
const manualAutoAt = new Map();

/**
 * Open the built-in manual. Payload only describes which faults, and the specific chapter is decided by the core/manual.js:
 * Rendering layers to share / install error / topic id, return to the directory page if you cannot get it.
 * Reason='fix-failed' gets heavy: 60 seconds of the same chapter, only once automatically, to avoid patch restoration.
 * Or flood the user into the manual window when mass installation fails.
 */
function openManual(payload = {}) {
  const target = manual.resolve(payload);
  const now = Date.now();
  const last = manualAutoAt.get(target.id) || 0;
  if (target.reason === 'fix-failed' && now - last < 60000) {
    if (manualWindow && !manualWindow.isDestroyed()) {
      manualWindow.show();
      manualWindow.focus();
    }
    return target;
  }
  manualAutoAt.set(target.id, now);

  try {
    if (!manualWindow || manualWindow.isDestroyed()) {
      manualWindow = new BrowserWindow({
        width: 1080,
        height: 780,
        minWidth: 720,
        minHeight: 520,
        show: false,
        backgroundColor: '#ffffff',
        autoHideMenuBar: true,
        icon: nativeImage.createFromBuffer(ICON_PNG),
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: false,
          spellcheck: false,
        },
      });
      manualWindow.on('closed', () => { manualWindow = null; });
      // Let the system browser handle external links.
      manualWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
        return { action: 'deny' };
      });
      manualWindow.webContents.on('will-navigate', (e, url) => {
        if (url.startsWith('file://')) return;
        e.preventDefault();
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      });
    }
    manualWindow.setTitle(`Hydra Emulator Use Manual · ${target.title}`);
    manualWindow.loadFile(path.join(__dirname, 'ui', 'manual.html'), { hash: target.anchor });
    manualWindow.once('ready-to-show', () => {
      if (!manualWindow || manualWindow.isDestroyed()) return;
      manualWindow.show();
      manualWindow.focus();
    });
    // Show already displayed window no retrigger ready-to-show
    if (manualWindow.isVisible()) manualWindow.focus();
    appLog(`manual open ${target.id}#${target.anchor} reason=${target.reason || 'manual'}`);
  } catch (e) {
    appLog(`manual open failed: ${e && e.message}`);
    // The manual cannot be opened, nor can it affect the restoration process: at least give us an online address.
    shell.openExternal('https://github.com/Lord1Egypt/Hydra-Emulator#readme').catch(() => {});
  }
  return target;
}

function notify(title, body) {
  if (store.getSettings().notifyOnInstall === false) return;
  try {
    const { Notification } = require('electron');
    if (Notification.isSupported()) new Notification({ title, body, icon: nativeImage.createFromBuffer(ICON_PNG) }).show();
  } catch (_) { /* ignore */ }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ----------Automated testing (automatic debug)--------------------------------------------------------------------------------------------------------------------------

/**
 * Auto-detect = Timed to take the machine’s true state and push the list of questions to the interface.
 *
 * Three principles.):
 *  1) Collection and separation from determination: Collection in src/core/autodebug-probe.js),
 *     Determines on src/core/autodebug.js (pure function, single measure).
 *  2) Discovery failed ≠ Problems: if you don’t get the status, leave it empty, and the decision level is "not known",
 *     Never make it up for "there’s something to tell." One misreporting, the user won’t believe it.
 *  3) Disturbing users only when “new problems arise”: Old questions have been raised,
 *     Every round is a noise; it’s back and it’s just a silent bookkeeping.
 */
let autodebugState = { issues: [], summary: null, at: 0, running: false };
let autodebugTimer = null;
let autodebugBusy = false;

function autodebugConfig() {
  const d = (store.getSettings() || {}).debug || {};
  const intervalMin = Number(d.intervalMin);
  return {
    auto: d.auto !== false,
    intervalMin: [1, 5, 10, 30, 60].includes(intervalMin) ? intervalMin : 10,
    notify: d.notify !== false,
  };
}

async function runAutodebug({ force = false } = {}) {
  if (autodebugBusy) return autodebugState;
  const cfg = autodebugConfig();
  if (!force && !cfg.auto) return autodebugState;
  autodebugBusy = true;
  send('autodebug:state', { ...autodebugState, running: true });
  try {
    const autodebug = require('./core/autodebug');
    const probe = require('./core/autodebug-probe');
    const obs = await probe.collect({ runtime, store, doctor: require('./core/doctor') });
    const issues = autodebug.evaluate(obs);
    const summary = autodebug.summarize(issues);
    const { added } = autodebug.diff(autodebugState.issues, issues);
    autodebugState = { issues, summary, at: Date.now(), running: false };
    send('autodebug:state', autodebugState);
    if (cfg.notify) {
      // Only "new error" reminds: warn/ info leaves it to the setup page to see for itself, without interrupting the user.
      const fresh = added.filter((i) => i.severity === 'error');
      if (fresh.length) {
        const text = fresh.map((i) => i.title).join('; ');
        send('toast', { type: 'error', message: `Automatically detect new problems: ${text}(Setup Diagnosis and Restoration)` });
        notify('Automatically detect new problems', `${text}... that opens Hydra Emulator’s’S Settings — Diagnosis and Repair’ can be handled by one key.`);
        appLog(`autodebug new issues: ${fresh.map((i) => i.code).join(',')}`);
      }
    }
    return autodebugState;
  } catch (e) {
    // The failure of the detection itself does not affect the main process: take a log, try again in the next round.
    appLog(`autodebug failed: ${e && e.message}`);
    autodebugState = { ...autodebugState, running: false, error: String((e && e.message) || e) };
    send('autodebug:state', autodebugState);
    return autodebugState;
  } finally {
    autodebugBusy = false;
  }
}

function scheduleAutodebug() {
  if (autodebugTimer) {
    clearInterval(autodebugTimer);
    autodebugTimer = null;
  }
  const cfg = autodebugConfig();
  if (!cfg.auto) return;
  autodebugTimer = setInterval(() => {
    runAutodebug().catch(() => {});
  }, cfg.intervalMin * 60 * 1000);
  if (autodebugTimer.unref) autodebugTimer.unref();
}

// - - - - Tray - - -

function buildTray() {
  const icon = loadTrayIcon();
  try {
    tray = new Tray(icon);
  } catch (_) {
    return;
  }
  const refresh = () => {
    const apps = store.getApps().slice(0, 8);
    // The separate window mode main interface is hidden, and the tray becomes the only accessible entry. ——
    // "Close the current application" has to be here, otherwise the user can't turn off the running application.
    // Find out whether or not to run, and see both currentapppkg and runtimeapps:
    // EndApp will remove the name from the activeApps, so turn it off and change this place automatically.
    // But the current AppPkg may still point to the last application, so double judgment.
    const hasRunning = currentAppPkg && runtime && runtime.activeApps
      ? runtime.activeApps.includes(currentAppPkg)
      : false;
    const runningLabel = currentAppPkg
      ? ((store.getApp(currentAppPkg) || {}).label || currentAppPkg)
      : '';
    const menu = Menu.buildFromTemplate([
      { label: 'Open Hydra Emulator', click: () => showWindow() },
      { label: 'Use manual', click: () => openManual({ topic: 'overview', reason: 'tray' }) },
      { type: 'separator' },
      ...(apps.length
        ? apps.map((a) => ({ label: a.label, click: () => runLaunch(a.package) }))
        : [{ label: 'Application not installed', enabled: false }]),
      { type: 'separator' },
      {
        label: hasRunning ? `Closes the current application(${runningLabel})` : 'Closes the current application',
        enabled: !!hasRunning,
        click: () => {
          const pkg = currentAppPkg;
          if (!pkg) return;
          // Reuse the same path for app:stop, not write the same logic in two places
          stopApp(pkg).then(() => refresh());
        },
      },
      {
        label: wantLandscapeFor(currentAppPkg) ? 'Cut back to the screen (when running again is required))' : 'Toggle screen (when running again is required))',
        enabled: !!currentAppPkg,
        click: () => { rotateCurrentApp().catch(() => {}); },
      },
      {
        label: displaySettings().mode === 'fullscreen' ? 'Cut back to the screen window' : 'Full Screen (According to Screen))',
        click: () => { toggleDisplayMode(); },
      },
      { label: 'Recreate desktop/start menu shortcut', click: () => { installer.ensureShortcuts().catch(() => {}); } },
      { label: 'Sync shared directory', click: () => sharer.sync() },
      { label: 'Settings', click: () => { showWindow(); send('ui:navigate', 'settings'); } },
      {
        label: updateInfo && updateInfo.hasUpdate ? `New Version Found ${updateInfo.tag}` : 'Check Updates',
        click: async () => {
          showWindow();
          send('ui:navigate', 'settings');
          const info = await updater.check().catch(() => null);
          if (info) { updateInfo = info; send('update:state', info); }
          if (info && info.hasUpdate && info.asset) {
            const r = await dialog.showMessageBox(mainWindow || undefined, {
              type: 'question',
              title: 'New Version Found',
              message: `Hydra Emulator ${info.tag} Published, current version v ${app.getVersion()}...is it updated now?`,
              detail: (info.notes || '').slice(0, 600),
              buttons: ['Update now', 'Later.'],
              defaultId: 0,
              cancelId: 1,
            });
            if (r.response === 0) runUpdate();
          } else if (info && !info.hasUpdate) {
            notify('You have the latest version', `Hydra Emulator v${app.getVersion()}`);
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Exit',
        click: async () => {
          try { appWin.close({ keepApp: true }); } catch (_) { /* ignore */ }
          quitting = true;
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(menu);
  };
  tray.setToolTip('Hydra Emulator');
  // Windows Trays are used to click and open the main window (double click, of course).
  // Only double-click was tied, and the user clicked unresponsive and thought the tray icon was broken.
  // Right-click the menu, so click here directly ShowWindow does not conflict with the menu.
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
  refresh();
  setInterval(refresh, 5000).unref?.();
}

// - - - - - Core actions - - - -

let installBusy = null;   // Installed file path: double-click APK to walk second-instance, cannot be loaded together
let lastInstallErr = { msg: '', at: 0 };

async function runInstall(filePath) {
  showWindow();
  // The same bag is being loaded.
  if (installBusy) {
    if (installBusy === filePath) {
      send('toast', { type: 'info', message: 'This APK is being installed. Please wait.…' });
      return { ok: false, error: 'Installing' };
    }
    send('toast', { type: 'info', message: 'The installation is in progress, please wait until it’s finished.' });
    return { ok: false, error: 'Another installation is in progress' };
  }
  installBusy = filePath;
  send('install:start', { file: filePath });
  try {
    const result = await installer.install(filePath, (p) => send('install:progress', p));
    send('install:done', result);
    // New desktop icon to refresh resource manager immediately, otherwise the user will think "no shortcut created."
    windowctl.refreshShell().catch(() => {});
    notify('Install complete', `${result.app.label}  Installed ${result.app.shortcutPath ? ', Desktop shortcut created' : ''}`);
    return result;
  } catch (e) {
    send('install:error', { message: e.message, file: filePath });
    if (e.needsSetup) send('ui:navigate', 'setup');
    // The same error only played a system notification within 8 seconds: no screen brushing at the lower right corner when retrying continuously
    const now = Date.now();
    if (e.message !== lastInstallErr.msg || now - lastInstallErr.at > 8000) {
      lastInstallErr = { msg: e.message, at: now };
      // The user has seen the interface when the window is on the front desk, and no more system alerts are required.
      if (!mainWindow || !mainWindow.isVisible() || mainWindow.isMinimized()) {
        notify('Installation failed', e.message.slice(0, 120));
      }
    }
    throw e;
  } finally {
    installBusy = null;
  }
}

/**
 * Download and install a new version, and then take over "Restart + Replace" by the update-apply script.
 * The interface shares this path with the tray menu.
 */
async function runUpdate() {
  if (updateBusy) return { ok: false, error: 'Updating' };
  // Store (MSIX) version cannot be updated: Install Directory C:\Program Files\WindowsApps It's read only.,
  // Overwrite exe not only fails, but may render the package integrity check ineffective, and the application simply fails to rise.
  // Update Microsoft Store (ms-windows-store: protocol).
  if (store.STORE_BUILD) {
    shell.openExternal('ms-windows-store://downloadsandupdates').catch(() => {});
    return { ok: false, error: 'Shop update is run by Microsoft Store, and the shop’s Download and Update is open', manual: true };
  }
  updateBusy = true;
  const sendProgress = (p) => send('update:progress', p);
  try {
    const info = updateInfo && updateInfo.hasUpdate ? updateInfo : await updater.check();
    updateInfo = info;
    if (!info.hasUpdate) return { ok: false, error: 'It\'s the latest version.' };
    if (!info.asset) {
      shell.openExternal(info.htmlUrl || Updater.repoUrl()).catch(() => {});
      return { ok: false, error: 'This version does not have a package that can be installed directly, and the GitHub release page is open', manual: true };
    }
    sendProgress({ stage: 'download', percent: 0, message: 'Ready to download.…' });
    const job = await updater.prepare(info);
    sendProgress({ stage: 'apply', percent: 100, message: 'Replacing program and restarting…' });
    updater.apply(job);
    // Give the interface a little time to show "restarting soon" and then take the normal exit process (before-quit hides the simulator window).)
    setTimeout(() => { quitting = true; app.quit(); }, 900);
    return { ok: true, version: info.version, mode: job.mode };
  } catch (e) {
    sendProgress({ stage: 'error', percent: 0, message: e.message });
    return { ok: false, error: e.message };
  } finally {
    updateBusy = false;
  }
}

/**
 * Activate stringification.
 *
 * A startup takes up to 80 seconds. A user may have another application during this period.,
 * Or double-click the same icon twice, or click it in the tray menu -- before, it was real and run twice.:
 * OpenAppWindow will turn off the active application (close+endApp), and the virtual machine is restarting.,
 * And then both sides failed. `cmd: Can't find service: activity` / `device not found`,
 * The user sees "no reaction, and then bounces back to the main interface."
 *
 * Now: the same application the one that is being directly reused (the point of connection equals one time); the application is waiting for the previous time.
 * And then we’ll finish it and start it, instead of taking it away while it’s running.
 */
let launchInFlight = null;
// “Soft Sim“ reminds each process to play only once, avoiding a system notification for each cut application.
let accelWarned = false;

async function runLaunch(pkg) {
  if (launchInFlight) {
    if (launchInFlight.pkg === pkg) {
      appLog(`launch reused in-flight ${pkg}`);
      return launchInFlight.promise;
    }
    appLog(`launch queued ${pkg}(Wait. ${launchInFlight.pkg} Start complete.)`);
    await launchInFlight.promise.catch(() => {});
  }
  const entry = { pkg };
  entry.promise = launchOne(pkg).finally(() => {
    if (launchInFlight === entry) launchInFlight = null;
  });
  launchInFlight = entry;
  return entry.promise;
}

async function launchOne(pkg) {
  const t0 = Date.now();
  const mark = (s) => appLog(`launch ${pkg} ${s} +${Date.now() - t0}ms`);
  // The state of the "precedence": the process will be picked up as soon as it appears, but eventually it will be known when it returns.
  // Places it in the function field for the final determination.
  let attachDoneEarly = false;
  let earlyAttachOk = false;
  // Activating animation unified end: The early splash window plus the application window ’s Boot mask fades out.
  // X-ray (onappUp header determination / launch end / time fuse can be used)
  // Boot mask is only collected when "Application Draws the First Frame", never disappears early in the White Bottom Splash phase -- this is exactly what it is.
  // The user asked for animated to the end of Android's system.
  let bootAnimDone = false;
  let bootFuse = null;
  const finishBootAnimation = () => {
    if (bootAnimDone) return;
    bootAnimDone = true;
    if (bootFuse) { clearTimeout(bootFuse); bootFuse = null; }
    if (appWin && appWin.isOpen) appWin.setState({ ready: true, tip: '' });
    if (typeof splashDone === 'function') splashDone();
  };
  // Total fuse: waitForAppFirstFrame for a maximum of 20 seconds, with 4 seconds left. Any path (first frame determination)
  // By mistake, on AppUp, untriggered, launch returned early.,
  // The user must not be stuck forever in the activation of the animation.
  bootFuse = setTimeout(finishBootAnimation, 24000);
  bootFuse.unref?.();
  appLog(`launch start ${pkg}`);
  try {
    // (0) Put the management window away and open the application window.
    // Order is important: used to be openAppWindow() after anarmAgent()(),
    // And anarmAgent wants to wait for the window agent to start (300~600ms), in this paragraph "Managing window +"
    // Applying window (+Map Open) "is on the screen at the same time -- the user sees multiple windows flying.
    if (mainWindow && mainWindow.isVisible() && !IS_DEV) mainWindow.hide();
    // 1) Open the Application Window again to show the start-up animation: the Android desktop is not visible throughout the process, nor is the simulator window visible
    await openAppWindow(pkg, 'Starting Android…');
    /**
     * Native window mode: **As soon as possible, repeatedly**Put the simulator's own window out. Don't let the user face it first.
     * Our “starting“ shell window is dry.
     *
     * When nothing was done here, the shell window became the first screen the user saw.,
     * And the original window will wait until it is met by am start -- cold start/ change panel direction is 30 seconds or more.
     * Users feel "started or your glamorous window."
     *
     * Qt window created when running when cold startup starts, and a single attempt will fail, so this is done.
     * Queries: Try every 1.5 seconds, successful is stopped (up to 30 seconds).,
     * The old window disappears as it runs, and the new window gets picked up here.
     */
    if (displaySettings().windowEmbed === false && appWin && appWin.isOpen) {
      let tries = 0;
      let rounds = 0;
      const preAttach = async () => {
        if (!appWin || !appWin.isOpen) return;
        rounds += 1;
        // Hard ceiling: either way out or fail, 45 wheels at most (approximately 1 minute) will be stopped,
        // Avoiding a change of direction and a failure of this timer to hang on to the sky.
        if (rounds > 45) return;
        // Changing the panel direction, preparing to reboot: this is when you pick up the screen and you’ll just light it up.
        // Waiting for the window to hide, there's nothing on the screen. Make way, when the reboot is over.
        if (appWin.waitingForRestart) {
          setTimeout(preAttach, 1500);
          return;
        }
        tries += 1;
        // eslint-disable-next-line no-await-in-loop
        const ok = await appWin.openDetached().catch(() => false);
        if (ok) { appLog(`I’m sorry, I’m sorry. ${tries} Numbers)`); return; }
        if (tries < 20) setTimeout(preAttach, 1500);
      };
      preAttach();
    }
    // Hide the main window of the simulator + qemu / netsimd from the black window on the control table during the start-up phase, and avoid any flashes.
    // Repression is permanent. (Embed will automatically skip the embedded window, see appwin.embed).
    // It must be here before the suppression comes into effect, and the black window will come out as soon as it starts.
    if (winAgent) { try { await armAgent(winAgent); } catch (_) { /* ignore */ } }

    const r = await installer.launch(pkg, {
      onLog: (m) => {
        send('runtime:log', m); appLog(`  rt ${m}`);
        // Synchronize to open the animation
        if (typeof splashProgress === 'function') splashProgress({ message: m });
      },
      onMark: mark,
      // Once the application process is in place, it’s going to take the image up, not until the four-second "Certificate" observation period.
      // That 4 seconds means stability, but the user sees “no reaction at the point,“ and first lets him see the application being loaded.,
      // There’s a big difference in perception.
      // There’s no point in taking the picture and finding the living, and no one gets done first.
      onAppUp: () => {
        attachDoneEarly = true;
        mark('App up (in advance))');
        attachAppWindow()
          .then(async (ok) => {
            earlyAttachOk = ok;
            mark(`early attach=${ok}`);
            if (!ok) return;
            // On the screen, the first frame is drawn: Android 12+, the first screen will be displayed before the first frame of Activity.
            // System Splash (Application Icon + White Bottom). If the animation is faded at this time, the user will see
            // A white base map, thought it was stuck.,
            // The time spent is always the same (not to keep the user permanently in animated by the failure of the determination).
            let painted = true;
            try {
              const c = runtime.client();
              if (c && typeof c.waitForAppFirstFrame === 'function') {
                // The weight application of red nuts may be more than 15 seconds from am start to the actual drawing of the first frame.,
              // In 12 seconds, we’ll drop the motors, and we’ll have the white bottom icon for the Splash system.
              // 20 seconds to spare; it's just a little bit longer to draw, and it's not stuck.
              painted = await c.waitForAppFirstFrame(pkg, { timeoutMs: 20000 });
              }
            } catch (_) { /* The determination failed is processed as ready. */ }
            mark(`first frame=${painted}`);
            // The first frame (or 20 seconds of a roundup) is used to capture animations: from an early splash window and application window
            // Boot masks are collected together, and do not let the start-up animations with the application icons disappear before the bottom of the white.
            finishBootAnimation();
          })
          .catch(() => { earlyAttachOk = false; finishBootAnimation(); });
        // Applying it when it's just coming up is still being re-established, and it's going to turn again in the direction it says.,
        // Overlaying just the locked direction -- that’s "the picture is always 90 degrees lying under the tablet/screen mode."
        // When it stabilizes, it heals itself.
        setTimeout(() => {
          runtime._healOrientation?.().catch(() => {});
          // Write down the real direction of this application.)
          learnAppOrientation(pkg).catch(() => {});
        }, 1800);
      },
      // Align the panel direction to the one that set the requirements before starting.
      // The screen can only be rebooted by the physical panel (hw.ld.width/ height swap) + and this one is
      // Write config.ini on startup. If the user has changed the setup of the screen, the virtual machine will also put the screen panel up.
      // Running, just wm size/ wm user-rotation will only make the scene lie down.
      // So we're going to reboot it once, and reload App=false let the application start as usual.
      beforeStart: async (rt) => {
        mark('engine ready');
        // The panel direction must be consistent with its own declaration, otherwise Android will only give a mailbox.
        // Narrow Bar (full black on both sides). WantLandscapeFor overwrites the "compulsory mode/ single application in settings" /
        // APK List delineates the direction “. See function comment.
        const wantLand = wantLandscapeFor(pkg);
        const cur = runtime.emulator && typeof runtime.emulator.panelLandscape === 'function'
          ? runtime.emulator.panelLandscape()
          : null;
        if (cur !== null && cur !== wantLand) {
          mark(`orientation mismatch (panel=${cur ? 'landscape' : 'portrait'}, want=${wantLand}) Reboot correction`);
          appWin.setState({ tip: wantLand ? 'Switching to screen…' : 'Switching to the screen…' });
          // RestartForOrganization returns a new rt (old clit is disabled).
          // Return it to installer.launch, follow-up Display Overrides/ startapp
          // With a new client, or all of them will fail silently.
          const newRt = await restartForOrientation(wantLand, { reloadApp: false }).catch(() => null);
          mark('orientation fixed');
          if (newRt && newRt.ok) return newRt;
        }
        appWin.setState({ tip: 'Opening application…' });
        // & & Close Animation + Close Lockscreen: only once, and then every start comes in seconds
        await rt.client.prepareForeground().catch(() => {});
        mark('foreground ready');
        // returns null without restarting (installer with old rt))
        return null;
      },
    });
    mark('app started');

    // 2) Applying to live to bring the image to the user (or the user will see flashing desktop/break page))
    // But if on AppUp already connects the image, there's only one confirmation here, no repeat. ——
    // Repeating in stand-alone window mode will hide/show the window just installed again, and the picture will flash.
    let embedded;
    if (attachDoneEarly) {
      embedded = !!earlyAttachOk;
      mark(`early attached already (${embedded})`);
    } else {
      embedded = await attachAppWindow();
    }
    // Log language is to distinguish two modes: under stand-alone window mode, ebeded=true means
    // "The image is already in front of the user" instead of "into our window."
    // Otherwise the people who read the logs will think the setting isn’t working.
    const attachMode = displaySettings().windowEmbed === false ? 'detached' : 'embed';
    if (!embedded) appLog(`attach failed (${attachMode}): ${appWin.lastEmbedError || 'unknown'}`);
    mark(`${attachMode}=${embedded}`);
    // When embedded, lift the window out of the other window. Otherwise, the top window (browser, etc.) will cover Android’s image.,
    // Users see "Black screen / image not filled" and the mouse does not point to application (all eaten by the top window).
    // Short tophost and then immediately withdraw, and lift the Z order to the top only once, without taking over the top for a long time.
    // Independent window mode skips: then the image is in the simulator's own window, showing the empty shell window will only block it.
    const detachedMode = displaySettings().windowEmbed === false;
    if (appWin.isOpen && !detachedMode) {
      try {
        appWin.win.show();
        appWin.win.setAlwaysOnTop(true);
        appWin.win.moveTop();
        appWin.win.focus();
        setTimeout(() => {
          if (appWin.isOpen) {
            try { appWin.win.setAlwaysOnTop(false); } catch (_) { /* Window closed */ }
          }
        }, 700);
      } catch (_) { /* Window may just be closed */ }
    }
    // Only the path to "not coming forward" is here to get the animation. On AppUp.,
    // The first frame is still going on an anecdotal course, and it’s going to the finishBootAimation (first frame complete/timeout/fine)),
    // Otherwise, the boot mask will be removed from the White Bottom Splash phase, and the white icon of the Splash system will be revealed.
    if (!attachDoneEarly) finishBootAnimation();
    // Packaging session: Environment ready, only "Applicable Crop + Open Backstage Rounding",
    // Do not re-guid this App. Android. Mouse-bit hook by window Focus event
    // By setting, the missing focal is uninstalled.
    deviceSize.value = null;
    appWin.refreshPointer();
    await runtime.beginApp(pkg, { onActive: onContainerActive }).catch(() => {});
    // Game/low-delay mode: use window proxy down-scanning to reduce the full-desk Carton caused by EnumWindows
    if (winAgent) {
      const game = store.getSettings().engine?.priorityMode === 'game';
      winAgent.setPerformanceMode(game).catch(() => {});
    }
    send('app:launched', { package: pkg, engine: r.engine });
    appLog(`launch ok ${pkg} ${attachMode}=${embedded}`);
    // This is when the user has already started to wait, banners/self-checks.
    // It’s all in the setup, probably not at all. The system notification is the most effective point of communication.
    if (!accelWarned) {
      runtime.provisioner.emulatorAccel().then((a) => {
        if (!a || a.ok) return;
        accelWarned = true;
        notify('Hydra is using software emulation', store.STORE_BUILD
          ? MSIX_ACCEL_HINT
          : 'Open Settings → Diagnostics & Fixes to check hardware acceleration.');
      }).catch(() => {});
    }
    // If only atatach didn't trigger (e.g. embedded mode), one more time here.
    finishBootAnimation();
    return { ok: true, embedded };
  } catch (e) {
    appLog(`launch failed ${pkg}: ${e && (e.stack || e.message)}`);
    try { appWin.close({ keepApp: true }); } catch (_) { /* ignore */ }
    // The start-up failure also keeps the simulator window under pressure (don’t let it be exposed as a stand-alone simulator window).),
    // The next dot will be used to follow the same path that hides ebed.
    if (winAgent) armAgent(winAgent).catch(() => {});
    showWindow();
    send('toast', { type: 'error', message: `Startup failed: ${e.message}` });
    return { ok: false, error: e.message };
  }
}

/**
 * Back-office task switch when the container has/does not apply a window.
 * The file is synchronized every 8 seconds to go over the shared directory and walk adb find/stat, and the notification bridge is also on the line;
 * Previously, from Hydra Emulator, he ran unconditionally, without even opening an Android application.
 * Now only when there’s a real application in the container, close the last window and stop immediately.
 */
function onContainerActive(on) {
  if (on) {
    sharer?.start(8000);
    startNotifier();
  } else {
    sharer?.stop();
    notifier?.stop();
  }
}

/**
 * Turn off a running Android application -- the tray menu and the right-key menu share this path.
 *
 * Three things.:
 *  1. The stop logic of the forceStop application (endApp) is also behind this step)
 *  2. Disable image: Embedded mode closes the shell window; stand-alone hides the simulator window before closing the shell
 *     (The sequence is important: destroy the shell window first and make the simulator window flash on the desktop before being park)
 *  Clear CurrentAppPkg, so that the "Close the current application" of the tray menu becomes ash immediately
 *
 * @param{string} pkg application package name to close
 * @param{object} [opts] {keepWindow} keepWindow=true
 * @returns {Promise<{ok:boolean, pkg?:string, error?:string}>}
 */
async function stopApp(pkg, opts = {}) {
  const target = pkg || currentAppPkg;
  if (!target) return { ok: false, error: 'No running application' };
  const detached = displaySettings().windowEmbed === false;
  try {
    await runtime.endApp(target, { onIdle: (idle) => onContainerActive(idle) }).catch(() => {});
    appLog(`stop ${target}`);

    if (!opts.keepWindow) {
      // Separate window mode: hide the simulator window first, close the shell window.
      // And then it leaves a flashing and disappearing simulator window on the table.
      if (detached && appWin && appWin.isOpen) {
        try { await appWin.agent.hide(); } catch (_) { /* ignore */ }
      }
      if (appWin && appWin.isOpen) {
        appWin.close({ keepApp: true });
      }
    }

    // Clears the current application tag: Tray menu, and "Close application" on the right button menu is dusted accordingly
    if (currentAppPkg === target) currentAppPkg = null;

    try { send('apps:changed'); } catch (_) { /* ignore */ }
    return { ok: true, pkg: target };
  } catch (e) {
    appLog(`stop failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/** Notification bridge: Queries only when application windows are available, closes the windows and stops, avoids empty rotations */
function startNotifier() {
  if (!notifier) {
    notifier = new NotifyBridge({
      getClient: () => runtime.client(),
      getAppLabel: (pkg) => (store.getApp(pkg) || {}).label || pkg,
      getAppIcon: (pkg) => (store.getApp(pkg) || {}).icoPath || '',
      onOpen: (pkg) => {
        if (appWin && appWin.isOpen && appWin.pkg === pkg) {
          appWin.win.show();
          appWin.win.focus();
        } else {
          runLaunch(pkg).catch(() => {});
        }
      },
    });
  }
  notifier.start();
}

// ---------------- IPC ----------------

function registerIpc() {
  ipcMain.handle('app:info', () => ({    version: app.getVersion(),
    isDev: IS_DEV,
    dataDir: store.DATA_DIR,
    runtimeDir: runtime.provisioner.paths().root,
    diskFreeMB: (() => {
      try { return require('./core/doctor').freeDiskMB(runtime.provisioner.paths().root); } catch (_) { return 0; }
    })(),
    exe: process.execPath,
    packaged: app.isPackaged,
  }));

  // Start with mode (start/ double click on): welcome card to decide whether to eject automatically
  ipcMain.handle('app:startupInfo', () => {
    const a = parseArgs(process.argv);
    return {
      autostart: process.argv.includes('--autostart') || !!a.silent,
      launch: a.launch || null,
      smoke: process.argv.includes('--smoke'),
      version: app.getVersion(),
      isPackaged: app.isPackaged,
    };
  });

  // Select Folder (to move running hours/spheres/installed applications to non-system disks))
  ipcMain.handle('dialog:openDir', async (_e, defaultPath) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Data Repository',
      defaultPath: defaultPath || store.DATA_DIR,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
    return r.filePaths[0];
  });

  ipcMain.handle('apps:list', async () => {
    const apps = store.getApps();
    const settings = store.getSettings();
    let running = [];
    try {
      const c = runtime.client();
      if (await c.isOnline()) running = await c.runningPackages();
    } catch (_) { /* Ignore when running without starting */ }
    return apps
      .map((a) => ({
        ...a,
        running: running.includes(a.package),
        iconUrl: a.iconPath && fs.existsSync(a.iconPath)
          ? `file:///${a.iconPath.replace(/\\/g, '/').replace(/ /g, '%20')}`
          : null,
        shortcutExists: a.shortcutPath ? fs.existsSync(a.shortcutPath) : false,
      }))
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.lastLaunchAt || 0) - (a.lastLaunchAt || 0) || a.label.localeCompare(b.label, 'zh'));
  });

  ipcMain.handle('apk:pick', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Select the APK to install',
      filters: [{ name: 'Android application', extensions: ['apk', 'apks', 'xapk'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (r.canceled) return [];
    return r.filePaths;
  });

  ipcMain.handle('apk:parse', async (_e, filePath) => parseApk(filePath));

  ipcMain.handle('apk:install', async (_e, filePath) => {
    const r = await runInstall(filePath);
    return { ok: true, app: r.app, warnings: r.warnings };
  });

  ipcMain.handle('app:launch', async (_e, pkg) => runLaunch(pkg));

  /**
   * Turn off a running Android app.
   *
   * There was no such entry: endApp only triggers when the application window is closed, and in stand-alone window mode
   * That window is hidden, and it’s never closed, so once it’s applied, it’s not closed.,
   * Users can only retreat to the tray and exit the entire Hydra Emulator.
   */
  ipcMain.handle('app:stop', async (_e, pkg, opts = {}) => stopApp(pkg, opts));

  ipcMain.handle('app:uninstall', async (_e, pkg) => {
    await installer.uninstall(pkg);
    return { ok: true };
  });

  ipcMain.handle('app:shortcut', async (_e, pkg) => {
    const appRecord = store.getApp(pkg);
    if (!appRecord) throw new Error('Application does not exist');
    const p = installer.createShortcut(appRecord);
    store.upsertApp({ package: pkg, shortcutPath: p });
    return { ok: true, path: p };
  });

  ipcMain.handle('app:clearData', async (_e, pkg) => {
    const rt = await runtime.ensure();
    if (!rt.ok) throw new Error(rt.error);
    await rt.client.clearData(pkg);
    return { ok: true };
  });

  ipcMain.handle('app:pin', async (_e, { pkg, pinned }) => {
    store.upsertApp({ package: pkg, pinned: !!pinned });
    return { ok: true };
  });

  /**
   * Individual application of horizontal screen overlay (apply card right-key menu).
   * Write application. json's application override, not restarting here ——
   * Next time you turn on the application, you wantLandscapeFor to read it and cut the panel in the opposite direction.
   * Pass null means clear the overlay, back to the natural direction of the APK list.
   */
  ipcMain.handle('app:setOrientation', async (_e, { pkg, orientation: value }) => {
    if (!pkg) return { ok: false, error: 'Missing package name' };
    const next = value === 'landscape' || value === 'portrait' ? value : null;
    store.upsertApp({ package: pkg, orientationOverride: next });
    appLog(`orientation override ${pkg} = ${next || '(Follow app)'}`);
    // Main interface list to display new directions immediately
    send('apps:changed');
    return { ok: true, orientation: next, landscape: wantLandscapeFor(pkg) };
  });

  ipcMain.handle('app:revealApk', async (_e, pkg) => {
    const a = store.getApp(pkg);
    if (a?.apkPath && fs.existsSync(a.apkPath)) shell.showItemInFolder(a.apkPath);
  });

  ipcMain.handle('apk:reveal', async () => {
    fs.mkdirSync(store.APK_DIR, { recursive: true });
    shell.openPath(store.APK_DIR);
  });

  /**
   * Memory / CPU / Data Divisions directly determine how the virtual machine works and how big a game it can play.,
   * Once before saving: hand-made settings.json, the spectroscopy from the old version is pulled back here.,
   * qemu is not going to turn on because-mory 32 exits directly, or because the partitions are bigger than disks.
   */
  const sanitizeResourcePatch = (patch) => {
    if (!patch || !patch.engine) return patch;
    const res = require('./core/resources');
    const host = res.hostProfile();
    const eng = { ...patch.engine };
    if ('memoryMB' in eng) {
      const c = res.clampMemoryMB(eng.memoryMB, host.totalMB);
      eng.memoryMB = c.mb;
      if (c.mb > 0) eng.autoMemory = false;
    }
    if ('cores' in eng) eng.cores = res.clampCores(eng.cores, host.cores).cores;
    if ('dataPartitionGB' in eng) {
      eng.dataPartitionGB = Math.max(0, Math.min(256, Number(eng.dataPartitionGB) || 0));
    }
    return { ...patch, engine: eng };
  };

  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:set', (_e, rawPatch) => {
    const patch = sanitizeResourcePatch(rawPatch);
    const localeChanged = patch?.engine?.locale !== undefined
      && patch.engine.locale !== store.getSettings().engine.locale;
    const next = store.saveSettings(patch);
    if (localeChanged) runtime.emulator.forceColdBootOnNextStart();
    if (patch && patch.autoStart !== undefined) applyAutoStart();
    if (patch && patch.display && appWin && appWin.isOpen) {
      // The frame size of the screen has changed: only the size of the window opened later, without interrupting the running application
      appWin.portrait = portraitSize();
    }
    // Make it up when you open the menu shortcut, without waiting for the next installation.
    if (patch && (patch.createStartMenuShortcut === true || patch.createShortcutOnInstall === true)) {
      installer.ensureShortcuts().catch(() => {});
    }
    // Mouse key position changed: Reload/unmount hooks at the current focus immediately, without waiting for the next window cut
    if (patch && patch.engine && (
      'mouseRightBack' in patch.engine || 'mouseWheelMode' in patch.engine || 'mouseSideButtons' in patch.engine
    )) {
      refreshPointerMapping();
    }
    // Changed source/ mirror prefix/ package address: The previous set of "who's fastest" conclusions is no longer valid, clearing the speed detection cache;
    // The address of the complete package / engine / mirror while running is still in the profiler. _cache, without knowing that it will start again.
    if (patch && patch.runtime && (
      'mirrorPrefix' in patch.runtime
      || 'autoMirror' in patch.runtime || 'runtimePackUrl' in patch.runtime
      || 'emulatorUrl' in patch.runtime || 'sysimgUrl' in patch.runtime
    )) {
      try {
        updater?.sources?.reset();
        runtime?.provisioner?.sources?.reset();
        runtime?.provisioner?.invalidateEnvCache?.();
      } catch (_) { /* ignore */ }
    }
    return next;
  });

  /**
   * Modify the server share directory: move existing files in the old directory to a new directory (best-offort, do not delete old files)),
   * Save the settings. Stere.getSettings().sharedDir, effective without restarting.
   */
  ipcMain.handle('settings:setSharedDir', async (_e, dir) => {
    if (!dir || !dir.trim()) return { ok: false, error: 'Directory cannot be empty' };
    const newDir = dir.trim();
    const oldDir = store.getSettings().sharedDir;
    try {
      if (oldDir && oldDir !== newDir) copyDirContents(oldDir, newDir);
      fs.mkdirSync(newDir, { recursive: true });
      store.saveSettings({ sharedDir: newDir });
      return { ok: true, oldDir, newDir };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ----------- show mode / shortcut / one-key deployment--------------------------------------------------------------------------------------------------------

  ipcMain.handle('display:state', () => ({
    ...displaySettings(),
    screen: screenRect(),
    current: currentAppPkg,
  }));

  ipcMain.handle('display:set', async (_e, patch) => {
    const next = store.saveSettings({ display: patch || {} });
    if (appWin && appWin.isOpen) {
      appWin.portrait = portraitSize();
      const full = next.display.mode === 'fullscreen';
      if (full && !appWin.win.isMaximized()) appWin.win.maximize();
      if (!full && appWin.win.isMaximized()) appWin.win.unmaximize();
      // Full screen = flat screen horizontal layout (see toggleDisplayMode description))
      appWin.setLandscape(full).catch(() => {});
      appWin.scheduleFit();
    }
    return next.display;
  });

  ipcMain.handle('display:toggle', () => toggleDisplayMode());

  ipcMain.handle('shortcut:rebuild', async () => ({ ok: true, fixed: await installer.ensureShortcuts() }));
  // Force retrying on the manual "one-key deployment" and bypassing failure cooling
  ipcMain.handle('runtime:autoDeploy', (_e, opts = {}) => autoDeploy({ force: !!opts.force }));
  // Restore pmdisable-user when closing the depth crop
  ipcMain.handle('settings:restoreSystem', async () => runtime.restoreSystemApps());
  // Mouse key position change: Only sync configurations, no more unconditional unmounting (right key returns/rollers may still need a hook))
  ipcMain.handle('settings:refreshPointer', async () => { refreshPointerMapping(); return true; });
  // Compatibility with the old interface: semantic has been changed to "Sync with settings"
  ipcMain.handle('settings:unhook', async () => { refreshPointerMapping(); return true; });

  // --------------------------------------------------------------------------------------------------
  // The detection can be done automatically (in memory, core, paint, rendering back end);
  // Buttons that have to manage the Windows function; only BIOS is allowed to clarify how to change it.

  ipcMain.handle('preflight:run', async () => {
    const preflight = require('./core/preflight');
    let accel = { ok: false, kind: 'none' };
    try { accel = await runtime.provisioner.emulatorAccel(); } catch (_) { /* Not deployed at the time of the operation. */ }
    const hw = await preflight.collect({ accel });
    const edition = store.STORE_BUILD ? 'store' : 'installer';
    const report = preflight.evaluate({ hw, settings: store.getSettings(), edition });
    return { ok: true, hw, report, edition };
  });

  /**
   * Applying medical recommendation: Write settings + drop the machine’s patch into a drive.
   * Write only a few security items (RAM/ / core/ paint quality / rendering backend / lock software simulation) that are clearly listed.
   */
  ipcMain.handle('preflight:apply', async () => {
    const preflight = require('./core/preflight');
    const drv = require('./core/drivers');
    let accel = { ok: false, kind: 'none' };
    try { accel = await runtime.provisioner.emulatorAccel(); } catch (_) { /* ignore */ }
    const hw = await preflight.collect({ accel });
    const edition = store.STORE_BUILD ? 'store' : 'installer';
    const report = preflight.evaluate({ hw, settings: store.getSettings(), edition });
    const patch = sanitizeResourcePatch(report.patch);
    const next = store.saveSettings(patch);

    // The machine’s parameters are solidified into a drive: every time you turn on it, you don’t have to repeat the checkup.
    // Verifying again and again -- the medical examination also produces content that cannot be bypassed by the white list.
    let driverFile = '';
    let driverError = '';
    try {
      const v = drv.validateDriver(report.driver);
      if (!v.ok) throw new Error(v.errors.join('; '));
      const dir = drv.userDir(store);
      fs.mkdirSync(dir, { recursive: true });
      driverFile = path.join(dir, `${v.driver.id}.json`);
      fs.writeFileSync(driverFile, `${JSON.stringify(report.driver, null, 2)}\n`, 'utf8');
      const prev = (next.drivers && next.drivers.state) || {};
      store.saveSettings({ drivers: { state: { ...prev, [v.driver.id]: true } } });
    } catch (e) {
      driverError = e.message;
    }

    appLog(`Auto-configuration of medical examinations: ${JSON.stringify(patch.engine)} driver=${driverFile || '(Not written)'}`);
    return {
      ok: true,
      settings: store.getSettings(),
      driverFile,
      driverError,
      summary: report.summary,
      recommended: report.recommended,
    };
  });

  // - - - - drive (compatible patches) - -
  // One of the drivers is a JSON: a statement that "matched to which machine" plus "what start parameter to change after hit."
  // This only does "read directory/ check/ match/ import/ export template/ switch" and does not execute any code.

  /** Builds the current machine image + all drivers + matches (for setting pages)) */
  async function driverOverview() {
    const drv = require('./core/drivers');
    const doctor = require('./core/doctor');
    const os = require('os');
    const s = store.getSettings();
    const disabled = (s.drivers && s.drivers.disabled) || [];
    const state = (s.drivers && s.drivers.state) || {};
    let accel = { ok: false, kind: 'none' };
    try { accel = await runtime.provisioner.emulatorAccel(); } catch (_) { /* When not loaded */ }
    let emulatorVersion = '';
    try { emulatorVersion = (await runtime.provisioner.emulatorVersion()).version || ''; } catch (_) { /* ignore */ }
    let osBuild = 0;
    try {
      const m = /(\d+)\s*$/.exec(os.release() || '');
      osBuild = m ? Number(m[1]) : 0;
    } catch (_) { /* ignore */ }
    const host = drv.hostContext({
      info: { ...doctor.hostInfo(), cpuVendor: (os.cpus() || [])[0]?.model || '' },
      gpuVendor: doctor.detectGpuVendor(),
      osBuild,
      accel: accel && accel.ok ? (accel.kind || 'whpx') : 'none',
      emulatorVersion,
    });
    const dirs = { user: drv.userDir(store), bundled: drv.bundledDir(APP_ROOT) };
    const loaded = drv.loadAll([dirs.bundled, dirs.user]);
    const resolved = drv.resolve({ drivers: loaded.drivers, host, state, disabled });
    const hit = new Map(resolved.applied.map((d) => [d.id, d]));
    return {
      host,
      dirs,
      errors: loaded.errors,
      effect: resolved.effect,
      drivers: loaded.drivers.map((d) => {
        const forced = typeof state[d.id] === 'boolean' ? state[d.id] : null;
        return {
          id: d.id,
          name: d.name,
          version: d.version,
          author: d.author,
          description: d.description,
          priority: d.priority,
          builtin: d.dir === dirs.bundled,
          file: d.file,
          enabled: forced !== null ? forced : d.enabled !== false,
          matched: hit.has(d.id),
          hits: (hit.get(d.id) || {}).hits || [],
        };
      }),
    };
  }

  ipcMain.handle('drivers:list', () => driverOverview());

  ipcMain.handle('drivers:openFolder', async () => {
    const dir = require('./core/drivers').userDir(store);
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
    return { ok: true, dir };
  });

  ipcMain.handle('drivers:import', async () => {
    const drv = require('./core/drivers');
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Driver (. json))',
      filters: [{ name: 'Driver JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    const out = drv.importDriver(r.filePaths[0], drv.userDir(store));
    if (out.ok) {
      // Import is enabled: User-intentioned patches, default should take effect immediately
      const s = store.getSettings();
      store.saveSettings({ drivers: { state: { ...(s.drivers.state || {}), [out.driver.id]: true } } });
      send('runtime:log', `Imported driver: ${out.driver.name} v${out.driver.version}`);
    }
    return { ...out, overview: await driverOverview() };
  });

  ipcMain.handle('drivers:exportTemplate', async () => {
    const drv = require('./core/drivers');
    const overview = await driverOverview();
    const tpl = drv.templateFromHost(overview.host);
    const r = await dialog.showSaveDialog(mainWindow, {
      title: 'Export your home driver template',
      defaultPath: path.join(drv.userDir(store), `${tpl.id}.json`),
      filters: [{ name: 'Driver JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.mkdirSync(path.dirname(r.filePath), { recursive: true });
    fs.writeFileSync(r.filePath, `${JSON.stringify(tpl, null, 2)}\n`, 'utf8');
    return { ok: true, file: r.filePath, template: tpl };
  });

  ipcMain.handle('drivers:setEnabled', async (_e, { id, enabled } = {}) => {
    const did = String(id || '');
    if (!did) return { ok: false, error: 'Missing driver id' };
    const s = store.getSettings();
    const prev = (s.drivers && s.drivers.state) || {};
    store.saveSettings({ drivers: { state: { ...prev, [did]: !!enabled } } });
    return { ok: true, overview: await driverOverview() };
  });

  ipcMain.handle('runtime:status', async () => runtime.status());
  ipcMain.handle('runtime:probe', async () => runtime.probe());
  ipcMain.handle('runtime:start', async () => {
    const r = await runtime.ensure({ onLog: (m) => send('runtime:log', m) });
    return r.ok ? { ok: true, engine: r.engine } : { ok: false, error: r.error, needsSetup: r.needsSetup };
  });
  ipcMain.handle('runtime:stop', async () => {
    await runtime.stop();
    return { ok: true };
  });
  ipcMain.handle('runtime:log', () => runtime.bootLog);

  // ---------------------------------------------------------------------------------------------------------------------

  ipcMain.handle('doctor:profile', async () => {
    const doctor = require('./core/doctor');
    // Use the live-run parameter when it’s on; if it’s not on, it’s also based on "real engine version + real acceleration state",
    // Otherwise, the setup page will show the discarded swiftshader_indirect/ software simulation, which is inconsistent with running.
    let p = runtime.emulator.profile;
    if (!p) {
      const env = await runtime.provisioner.checkEnv();
      p = doctor.autoProfile({
        settings: store.getSettings(),
        accel: env.accel,
        emulatorVersion: env.emulator.version || '',
        diskMB: doctor.freeDiskMB(store.DATA_DIR),
      });
    }
    return { profile: p, text: doctor.describeProfile(p) };
  });

  ipcMain.handle('doctor:report', async () => {
    const r = await runtime.diagnostics();
    shell.showItemInFolder(r.file);
    return r;
  });

  /**
   * System question auto-check: The root causes of auto-checking often lead to "no load, no rise" before start/run,
   * and give operational fixes (show in the first page banner + set panel, fix by question one).
   */
  ipcMain.handle('doctor:selfCheck', async () => {
    const doctor = require('./core/doctor');
    const issues = [];
    // Both values are assigned in the try, return outside the try, must be declared extraterritorially.
    let accel = { ok: false };
    let free = 0;
    try {
      if (!doctor.vcRedistOk()) {
        issues.push({
          code: 'vcRedist', severity: 'error', title: 'VC++ Run library missing (x64))',
          // This is a check that the dll file does not exist, but it is credible.
          // There must be a VC++ — the shop page from WindowsApps will be identical to the startup process.
          // Get up, press the built-in 6.8 to continue positioning, and don’t reload the running library.
          hint: 'The system lacks Microsoft VC++ 2015-2022 (x64), and Android relies on it for running.'
            + 'One key can be installed; 0xC0000135, see built-in manual 6.8 - shop version may still be a sub-process DLL path problem.', fix: 'vcRedist',
        });
      }
      accel = await runtime.provisioner.emulatorAccel().catch(() => ({ ok: false }));
      if (!accel.ok) {
        // The store and installation paths are completely different. The hint must be written separately.:
        //   - The store (MSIX) version cannot be kernel-driven, and usually does not get a manager’s authorization.
        //     Check "Windows virtual machine monitor program platforms" in the Windows functionality.
        //   - Installed/portable version can be turned on by a key at a boost (failure to back down AEHD drive).
        // The previous two versions used to share a sentence, and the store user saw "suggest to install AED driver."——
        // And the shop board doesn’t have a drive, it means it’s a dead end.
        issues.push(store.STORE_BUILD
          ? {
            code: 'accel',
            severity: 'error',
            title: 'Need to open Windows Virtual Machine Monitor Program platform',
            hint: 'Without it, we’re running a pure software simulation, and we’re running a few minutes late.'
              + MSIX_ACCEL_HINT
              + '(The shop board won’t be able to take your place, it needs you to do it manually, and then it’s back on.)',
            fix: 'virtualization',
          }
          : {
            code: 'accel',
            severity: 'warn',
            title: 'Hardware acceleration not enabled',
            hint: `${accel.note || 'It’s going back to the software simulation.'}`
              + 'The right-hand "repair" of the dot will be automatically opened (required by the administrator, possibly restarted);'
              + 'AEHD drive will automatically be modified if failure occurs.',
            fix: 'virtualization',
          });
      }
      free = doctor.freeDiskMB(runtime.provisioner.paths().root);
      if (free && free < 8192) {
        issues.push({
          code: 'disk', severity: free < 2048 ? 'error' : 'warn', title: 'Disk space tight while running',
          hint: `“${runtime.provisioner.paths().root}“The disk is left. ${free} MB, running with mirrors could pop the hard drive.`, fix: 'disk',
        });
      }
      const rtDir = runtime.provisioner.paths().root;
      if (!doctor.isAsciiPath(rtDir)) {
        issues.push({
          code: 'pathRuntime', severity: 'warn', title: 'Directory with Chinese/Special Characters at Runtime',
          hint: 'Partially running components are sensitive to Chinese-language paths, which may trigger a failure to start. It is suggested to change to a purely English directory.', fix: 'path',
        });
      }
      const env = await runtime.provisioner.checkEnv().catch(() => ({}));
      if (!env.adb || !env.adb.ok) {
        issues.push({ code: 'adb', severity: 'error', title: 'Adb Tool Chain Missing', hint: 'Could not close temporary folder: %s %s', fix: 'deploy' });
      }
      if (!env.emulator || !env.emulator.ok) {
        issues.push({ code: 'emulator', severity: 'error', title: 'Engine not installed while running', hint: 'We need to deploy the running engine first (approximately 440 MB).', fix: 'deploy' });
      }
      if (!env.sysimg || !env.sysimg.ok) {
        issues.push({ code: 'sysimg', severity: 'warn', title: 'system image not ready', hint: 'Reload the Android system image (approximately 1.5 GB).', fix: 'deploy' });
      }
      // Residue lock file: will allow the next start to be convicted as "AVD has been occupied" and FATAL
      const avdHome = runtime.provisioner.paths().avdHome;
      let locked = false;
      try { for (const f of fs.readdirSync(avdHome)) { if (/\.lock$/i.test(f)) { locked = true; break; } } } catch (_) { /* ignore */ }
      if (locked) {
        issues.push({ code: 'lock', severity: 'warn', title: 'Last remaining lock file detected', hint: 'This may lead to a conviction that the next start is "AVD has been occupied."', fix: 'lock' });
      }
    } catch (_) { /* Self-censorship failure does not interrupt use */ }
    return { issues, accel, free };
  });

  // ----------Automated testing (automatic debug)--------------------------------------------------------------------------------------------------------------------------

  /** Run the test immediately (set page "Survey Now" button / Timed Tasks This way) */
  ipcMain.handle('autodebug:run', () => runAutodebug({ force: true }));

  /** Take the last result (rew old when opening the settings page, don’t leave the interface empty and wait)) */
  ipcMain.handle('autodebug:state', () => autodebugState);

  /** Switches and Spacing */
  ipcMain.handle('autodebug:config', (_e, patch = {}) => {
    const cur = autodebugConfig();
    const next = {
      auto: patch.auto === undefined ? cur.auto : !!patch.auto,
      intervalMin: patch.intervalMin === undefined ? cur.intervalMin : Number(patch.intervalMin) || cur.intervalMin,
      notify: patch.notify === undefined ? cur.notify : !!patch.notify,
    };
    store.saveSettings({ debug: next });
    scheduleAutodebug();
    if (next.auto) runAutodebug().catch(() => {});
    return next;
  });

  /** The residual orphan simulator process (emulator.exe) is only the starter, qemu is detached) */
  ipcMain.handle('app:clearOrphans', async () => {
    try {
      const r = await runtime.killOrphanEmulators({ onLog: (m) => appLog(`orphan: ${m}`) });
      return { ok: true, note: r && r.note };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /** We’re going to have a quick start-up snapshot. (The snapshot is broken, and every time we start, we wait for a cold start.)) */
  ipcMain.handle('app:clearSnapshot', async () => {
    try {
      const ok = runtime.emulator.invalidateSnapshot();
      return { ok: !!ok };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /** Start running again: self-repair unauthorized / lead card dead / orphan lock preferred action */
  ipcMain.handle('runtime:restart', async () => {
    try {
      await runtime.stop({ onLog: (m) => appLog(`restart-stop: ${m}`) }).catch(() => {});
      const r = await runtime.ensure({ onLog: (m) => send('runtime:log', m) });
      return { ok: true, ready: !!r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Microsoft VC++ 2015-2022 x64 running library: Qt6 and qmu rely on it.
  // The missing "other computers" will not rise directly (0xc000135 / MSVCP140 missing).
  function vcRedistInstaller() {
    const p = runtime.provisioner.paths();
    const cands = [
      path.join(p.root, 'vc_redist.x64.exe'),
      path.join(process.resourcesPath || '', 'runtime', 'vc_redist.x64.exe'),
    ];
    return cands.find((c) => c && fs.existsSync(c)) || null;
  }
  ipcMain.handle('runtime:vcRedist', () => {
    const doctor = require('./core/doctor');
    return { ok: doctor.vcRedistOk(), path: vcRedistInstaller() };
  });
  ipcMain.handle('runtime:installVcRedist', async () => {
    const file = vcRedistInstaller();
    if (!file) return { ok: false, reason: 'no-installer' };
    const { spawn } = require('child_process');
    await new Promise((resolve) => {
      // Install with RunAs at the right level (VC++ is a system-level component requiring a administrator); /quiet silent/norestart does not restart
      const ps = spawn('powershell.exe', ['-NoProfile', '-Command',
        `Start-Process -FilePath "${file}" -ArgumentList '/quiet','/norestart' -Verb RunAs -Wait`],
      { windowsHide: true, stdio: 'ignore' });
      ps.on('exit', () => resolve());
      ps.on('error', () => resolve());
    });
    const doctor = require('./core/doctor');
    return { ok: doctor.vcRedistOk() };
  });

  ipcMain.handle('runtime:usage', () => runtime.usage());

  // Universal confirmation box (reflexing layers are united here, avoiding the use of the dialog scripts everywhere.)
  ipcMain.handle('app:confirm', async (_e, opts = {}) => {
    const { response } = await dialog.showMessageBox(mainWindow || undefined, {
      type: opts.type || 'question',
      title: opts.title || 'Confirm',
      message: opts.message || '',
      detail: opts.detail || '',
      buttons: ['Cancel', opts.okLabel || 'Yes.'],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    });
    return { response };
  });

  /**
   * Overview of resource allocation: Host ceiling, current distribution, data disk balance.
   * Answer by running your own resources(), interface only recognizes this structure.
   */
  ipcMain.handle('engine:resources', async () => {
    try {
      const backend = runtime.backend;
      if (backend && typeof backend.resources === 'function') return await backend.resources();
      return { backend: backend ? backend.id : '', ok: false, note: 'Unable to run and cannot read resource allocation for now' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /**
   * This one when the local extension is not possible: recreated by target capacity /data.
   * It will empty the installed applications and archive -- the caller must have been clearly identified by the user.
   */
  ipcMain.handle('runtime:resetAndResize', async (_e, gb) => {
    const res = require('./core/resources');
    const doctor = require('./core/doctor');
    const freeMB = doctor.freeDiskMB(runtime.provisioner.paths().root);
    const want = res.clampDataGB(gb, freeMB).gb;
    if (!want) return { ok: false, error: 'Target capacity is not legal.' };
    store.saveSettings({ engine: { dataPartitionGB: want } });
    await runtime.stop().catch(() => {});
    const r = await runtime.resetAndroidData().catch((e) => ({ ok: false, error: e.message }));
    appLog(`reset+resize -> ${want}GB: ${JSON.stringify(r)}`);
    return { ok: !!(r && r.ok), wantGB: want, ...r };
  });

  // Data partition (/data) capacity: Apply, games and their updates are here.
  // "The game update space is not enough" is almost all too small, and the expansion is done on the ground, without the data being lost.
  ipcMain.handle('runtime:dataInfo', () => {
    const doctor = require('./core/doctor');
    const b = runtime.backend;
    const info = (b && typeof b.dataInfo === 'function') ? (b.dataInfo() || {}) : {};
    const freeDiskMB = Number(info.freeMB) || Number(info.freeDiskMB)
      || doctor.freeDiskMB(runtime.provisioner.paths().root);
    return { ...info, freeDiskMB };
  });

  ipcMain.handle('runtime:setDataSize', async (_e, gb) => {
    const res = require('./core/resources');
    const doctor = require('./core/doctor');
    const freeMB = doctor.freeDiskMB(runtime.provisioner.paths().root);
    const clamped = res.clampDataGB(gb, freeMB);
    const want = clamped.gb;
    store.saveSettings({ engine: { dataPartitionGB: want } });
    if (!want) {
      const info = runtime.emulator.dataInfo();
      return { ok: true, auto: true, ...info };
    }
    const mb = Math.round(want * 1024);
    // The mirror is being held by qemu and cannot be changed. Stop the container.)
    let stopped = false;
    try {
      const online = await runtime.client().isOnline().catch(() => false);
      if (runtime.emulator.running() || online) {
        await runtime.stop().catch(() => {});
        stopped = true;
      }
    } catch (_) { /* ignore */ }
    try {
      const r = runtime.emulator.resizeDataPartition(mb);
      appLog(`data partition -> ${want}GB: ${JSON.stringify(r)}`);
      if (r && r.ok) notify('Data partition adjusted', `Android's space is available. ${want} GB${stopped ? '(Started when running)' : ''}`);
      return { ok: !!(r && r.ok), stopped, ...r, ...runtime.emulator.dataInfo() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('runtime:cleanup', async (_e, opts = {}) => {
    // Clear double confirmation: give the list first and user confirm before actually deleting it; and clean up only Hydra Emulator's own running-time directory
    const pass = { apply: false, aggressive: !!opts.aggressive, includeSnapshots: !!opts.includeSnapshots };
    if (!opts.apply) return runtime.cleanup(pass);
    const preview = await runtime.cleanup(pass);
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', `Clean ${preview.candidates.length} Item`],
      defaultId: 0,
      cancelId: 0,
      title: 'Confirm Cache on Cleanup Operation',
      message: `Will release the contract. ${(preview.candidates.reduce((n, c) => n + c.size, 0) / 1048576).toFixed(0)} MB`,
      detail: (opts.includeSnapshots
        ? 'Will first stop running, then delete the old mirror, the current AVD quick start snapshot, lock the file and the inactive AVD cache. The installed application itself will be retained (only the snapshot is clear).), '
        : 'Only remove old mirrors, old snapshots, lock files and inactive AVD caches, installed applications will be retained.')
        + 'This operation is irrevocable, and it is recommended that the diagnostic report be exported first.',
    });
    if (response !== 1) return { ...preview, cancelled: true };
    return runtime.cleanup({ apply: true, aggressive: !!opts.aggressive, includeSnapshots: !!opts.includeSnapshots });
  });

  // Completely reset Android data: empty /data user partition + loaded application + quick start snapshot,
  // AVD resets the clean state of the "just installed system." It actually removes the GB data, and UI has to confirm it twice.
  ipcMain.handle('runtime:resetData', async () => {
    try {
      const r = await runtime.resetAndroidData();
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, reclaimed: r.reclaimed, reclaimedMB: Math.round(r.reclaimed / 1048576) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Rehabilitate virtual network: Reset / Data (Preserve application list, click start application automatically reload).
  // Typical scene: All the Internet pages in Android have been black, actually wlan0, not up, no default route.
  ipcMain.handle('runtime:repairNetwork', async () => {
    try {
      const r = await runtime.repairNetwork({
        onLog: (m) => send('toast', { message: m, kind: 'info', timeout: 6000 }),
      });
      return r;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Only network checkups, no data (set pages to show current status))
  ipcMain.handle('runtime:checkNetwork', async () => {
    try {
      const network = await runtime.emulator.checkNetwork(runtime.adbPath());
      return { ok: !!network.ok, network };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ------------------

  /** Scan only, not delete: first give the "what can be found" to the interface, for the user to decide */
  ipcMain.handle('leftovers:scan', () => {
    try {
      const installDir = path.dirname(app.getPath('exe'));
      const dataDir = store.DATA_DIR;
      let avdHome = '';
      try { avdHome = runtime.provisioner.paths().avdHome; } catch (_) { avdHome = ''; }
      return { ok: true, ...leftovers.scan({ installDir, dataDir, avdHome }) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('leftovers:clean', (_e, items) => {
    try {
      const installDir = path.dirname(app.getPath('exe'));
      const r = leftovers.clean(Array.isArray(items) ? items : [], { installDir });
      appLog(`leftovers cleaned: ${r.removed.length} removed, ${r.failed.length} failed`);
      return { ok: true, ...r, freedMB: Math.round(r.freedBytes / 1048576) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // --------------------------------------------------------------------------------------------------------------------------------------------

  ipcMain.handle('provision:installEmulator', async () => {
    try {
      const r = await runtime.provisioner.installEmulator(
        (p) => send('provision:progress', { ...p, component: 'emulator' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installSysimg', async () => {
    try {
      const r = await runtime.provisioner.installSystemImage(
        (p) => send('provision:progress', { ...p, component: 'sysimg' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installPlayImage', async () => {
    try {
      const r = await runtime.provisioner.installPlayImage(
        (p) => send('provision:progress', { ...p, component: 'playimg' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installAehd', async () => {
    try {
      const r = await runtime.provisioner.installAehd(
        (p) => send('provision:progress', { ...p, component: 'aehd' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /** AEHD driver: Eject UAC, install silently after user confirmation */
  ipcMain.handle('provision:enableAccel', async () => {
    try {
      const p = runtime.provisioner.paths();
      const bat = path.join(p.aehdDir, 'silent_install.bat');
      if (!fs.existsSync(bat)) {
        const r = await runtime.provisioner.installAehd(
          (x) => send('provision:progress', { ...x, component: 'aehd' }),
        );
        if (!fs.existsSync(bat)) throw new Error(r.error || 'AEHD driver package not ready');
      }

      await new Promise((resolve, reject) => {
        const { spawn: sp } = require('child_process');
        const esc = bat.replace(/'/g, "''");
        const ps = `try { $p = Start-Process -FilePath '${esc}' -WorkingDirectory '${path.dirname(bat).replace(/'/g, "''")}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { exit 2 }`;
        const proc = sp('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
          windowsHide: true,
        });
        proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(
          code === 2 ? 'Manager ’ s authorization was cancelled (point " yes " is required to install driver))' : `Driver installation failed (exit code) ${code})`,
        ))));
        proc.on('error', (e) => reject(e));
      });

      const accel = await runtime.provisioner.emulatorAccel();
      return { ok: accel.ok, accel, error: accel.ok ? '' : accel.note };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /**
   * Auto-start virtualization: Users do not need to manually go to the Windows function panel.
   * Priority is given to the system ’s own “virtual platform“ (WHPX); if the DLL does not exist (old system)),
   * Back up and install and enable Google’s AEHD driver. Both ways require administrator authority.
   */
  ipcMain.handle('provision:enableVirtualization', async () => {
    try {
      const accel = await runtime.provisioner.emulatorAccel();
      if (accel.ok) return { ok: true, already: true, accel, note: 'Hardware acceleration is available, no extra operation required' };

      // – - - MSIX version: WHPX -- - - – – – – – – – – – – – – – – – – – – – – – – — — — — — — — — — — — — — — — — — — — — — — — — — — —
      // MSIX bag pulled up from the AppX deployment model, fixed mediumIL, which can’t be kernel-driven (AEHD)),
      // Nor do they usually get a manager’s authorization. So just try the HPX here, back to the manual.
      // The previous implementation directly uses Start-Process-Verb Runas, shop user points
      // It’s doomed to fail, and the "unactivated hardware acceleration" on the banner will never be eliminated.
      if (store.STORE_BUILD) {
        const whpx = await enableWhpxFeatures();
        runtime.provisioner.invalidateEnvCache?.();
        if (whpx.ok) {
          return {
            ok: true, restartNeeded: true, steps: whpx.steps,
            accel: await runtime.provisioner.emulatorAccel().catch(() => accel),
            note: 'The Windows virtual machine monitor program has been requested to be activated, and the hardware will not be activated until the computer is restarted.',
          };
        }
        return {
          ok: false,
          manual: true,
          settingsUri: 'ms-settings:optionalfeatures',
          steps: whpx.steps,
          accel,
          note: MSIX_ACCEL_HINT,
        };
      }

      // - - - - - Installed / Portable - -
      // Try the WHPX (systems are taped without downloading); fail (user clicks no/ system is not supported) before retreating from the AEHD driver.
      // AEHD needs to network to get the driver package, so put it back.
      const whpx = await enableWhpxFeatures();
      runtime.provisioner.invalidateEnvCache?.();
      if (whpx.ok) {
        return {
          ok: true, restartNeeded: true, steps: whpx.steps,
          accel: await runtime.provisioner.emulatorAccel().catch(() => accel),
          note: whpx.steps.some((s) => s.cancelled)
            ? 'The Windows Virtual Machine Monitor Program platform has been activated and will be effective after restarting the computer'
            : 'The Windows Virtual Machine Monitor Program platform has been activated and will be effective after restarting the computer',
        };
      }
      if (whpx.cancelled) {
        return {
          ok: false,
          cancelled: true,
          error: 'You\’ve revoked the administrator\’s authorization, the hardware acceleration remains unchanged. You can order "repair" again, or you can manually open the "Windows Virtual Machine Monitor Program Platform".',
        };
      }

      // WHPX cannot be started: switch to Google AEHD driver (installed and ready, no restart required))
      const ae = await runtime.provisioner.installAehd(
        (x) => send('provision:progress', { ...x, component: 'aehd' }),
      ).catch((e) => ({ ok: false, error: e.message }));
      if (!ae.ok) return { ok: false, error: ae.error || 'AEHD Drive Package Preparation Failed' };
      const bat = path.join(runtime.provisioner.paths().aehdDir, 'silent_install.bat');
      await new Promise((resolve, reject) => {
        const { spawn: sp } = require('child_process');
        const esc = bat.replace(/'/g, "''");
        const ps = `try { $p = Start-Process -FilePath '${esc}' -WorkingDirectory '${path.dirname(bat).replace(/'/g, "''")}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { exit 2 }`;
        const proc = sp('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
        proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(
          code === 2 ? 'Manager ’ s authorization was cancelled (point " yes " is required to install driver))' : `Driver installation failed (exit code) ${code})`,
        ))));
        proc.on('error', (e) => reject(e));
      });
      runtime.provisioner.invalidateEnvCache?.();
      const after = await runtime.provisioner.emulatorAccel();
      return { ok: after.ok, accel: after, note: after.ok ? 'AEHD hardware acceleration enabled' : after.note };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installAdb', async () => {
    try {
      const r = await runtime.provisioner.installAdb((p) => send('provision:progress', { ...p, component: 'adb' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installQemu', async () => {
    try {
      const r = await runtime.provisioner.installQemu((p) => send('provision:progress', { ...p, component: 'qemu' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:downloadIso', async () => {
    try {
      const r = await runtime.provisioner.downloadIso((p) => send('provision:progress', { ...p, component: 'iso' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:createDisk', async (_e, sizeGB) => {
    try {
      const r = await runtime.provisioner.createDisk(sizeGB || store.getSettings().runtime.diskSizeGB || 24,
        (p) => send('provision:progress', { ...p, component: 'disk' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:importIso', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Select a mirror for Android-x86 / Bliss OS',
      filters: [{ name: 'System image', extensions: ['iso', 'img'] }],
      properties: ['openFile'],
    });
    if (r.canceled) return { ok: false, canceled: true };
    try {
      return { ok: true, ...runtime.provisioner.importIso(r.filePaths[0]) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:importDisk', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Select a virtual disk with Android installed',
      filters: [{ name: 'Virtual Disk', extensions: ['qcow2', 'img', 'vmdk', 'raw'] }],
      properties: ['openFile'],
    });
    if (r.canceled) return { ok: false, canceled: true };
    try {
      const info = runtime.provisioner.importDisk(r.filePaths[0]);
      store.saveSettings({ runtime: { installed: true } });
      return { ok: true, ...info };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:check', async () => runtime.provisioner.checkEnv());
  ipcMain.handle('provision:probeSources', async () => runtime.provisioner.probeSources());

  ipcMain.handle('runtime:startInstaller', async () => {
    try {
      await runtime.startInstaller({ onLog: (m) => send('runtime:log', m) });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('runtime:markInstalled', async () => {
    await runtime.markInstalled();
    return { ok: true };
  });

  ipcMain.handle('runtime:resetInstall', async () => {
    store.saveSettings({ runtime: { installed: false } });
    return { ok: true };
  });

  ipcMain.handle('assoc:status', () => {
    // Smoking/no shell environment: no detectable registration form (reg.exe) may be intercepted by strategy)
    if (NO_SHELL_PROBE) return { registered: false, skipped: true };
    const { execFileSync } = require('child_process');
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Software\\Classes\\.apk', '/ve'], { windowsHide: true, encoding: 'utf8' });
      return { registered: out.includes(assoc.PROGID) };
    } catch (_) {
      return { registered: false };
    }
  });

  ipcMain.handle('assoc:register', () => {
    const l = launcherInfo();
    const icoPath = path.join(store.ICON_DIR, 'hydra.ico');
    if (!fs.existsSync(icoPath)) {
      // Prefer multi-sized ICOs distributed with packages, from Logo PNG when missing
      if (fs.existsSync(APPICON_FILE)) fs.copyFileSync(APPICON_FILE, icoPath);
      else {
        const { pngToIco } = require('./core/shortcut');
        const ico = pngToIco(ICON_PNG);
        if (ico) fs.writeFileSync(icoPath, ico);
      }
    }
    return assoc.registerAssociation(l.target, icoPath, l.args);
  });

  ipcMain.handle('assoc:unregister', () => assoc.unregisterAssociation());

  ipcMain.handle('share:sync', async () => sharer.sync({ onLog: (m) => send('runtime:log', m) }));
  ipcMain.handle('share:open', async () => {
    const dir = store.getSettings().sharedDir;
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  });

  /** Clearing the last AVD lock file: will allow the next start to be misconstrued as "AVD has been occupied" and FATAL */
  ipcMain.handle('app:clearLocks', async () => {
    try {
      const avdHome = runtime.provisioner.paths().avdHome;
      let removed = 0;
      for (const f of fs.readdirSync(avdHome)) {
        if (/\.lock$/i.test(f)) {
          try { fs.rmSync(path.join(avdHome, f), { force: true }); removed++; } catch (_) { /* ignore */ }
        }
      }
      return { ok: true, removed };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /**
   * Unloading Hydra Emulator Body with one key:
   * 1) Cancel .apk file association first (avoid double click on APK pointing to deleted program)
   * 2) Installed version: Start the NSIS unmounting program (which will request the administrator/confirm itself) and then withdraw from the program
   * 3) Portable (byload / free): no uninstaler.exe, returns the hint that the user manually removes the program and the data directory
   */
  ipcMain.handle('app:removeSelf', async () => {
    try {
      try { await assoc.unregisterAssociation(); } catch (_) { /* Unconnecting failed without unmounting */ }
      const exeDir = path.dirname(process.execPath);
      // and updater.flavoor using the same set of identification rules: electron-Builder
      // "Uninstall Hydra Emulator.exe," old code only for "uninstaller.exe.",
      // This led to a misconstrued portable version of the installation point "Live one key off", which was only not actually offloaded by a bullet tip.
      const unName = findUninstaller(exeDir);
      if (!unName) {
        return { ok: true, portable: true, dataDir: store.DATA_DIR, exeDir };
      }
      const uninstaller = path.join(exeDir, unName);
      const { spawn } = require('child_process');
      // Quemu will lock down resources\runtime /dll,
      // NSIS will leave half of the installed directory unretrieved. This is only for "really unloading" and will not affect daily exit.
      try { await runtime?.emulator?.killOrphanProcesses(); } catch (_) { /* ignore */ }
      // We’re going to have to get this program out of here, and we’re going to have a two-second delay in pulling up the unloader.:
      // Running exe locks the files in the installed directory, pulls the unloader directly and it’s easy to delete.
      const cmd = `ping 127.0.0.1 -n 3 >nul & start "" "${uninstaller}"`;
      spawn('cmd.exe', ['/c', cmd], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      setTimeout(() => app.quit(), 300);
      return { ok: true, portable: false };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('shell:open', (_e, url) => shell.openExternal(url));
  // Built Manual: Rendering Layers only says "what faults/what subjects?" Main processes interpret into trusted local chapters
  ipcMain.handle('manual:open', (_e, payload) => openManual(payload || {}));

  /**
   * Opens the Windows Function dialogue box.
   *
   * Why don’t you use ms-settings:optionalfeatures: Win11, which page is an optional list,
   * Inside.**Nothing.**“Windows Virtual Machine Monitor Program Platform“, users will search for a circle of classic dialogue boxes for nothing.
   * It’s the only thing that exists.exe.
   * Open it without admin privileges.
   */
  ipcMain.handle('provision:openWindowsFeatures', () => {
    try {
      const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'optionalfeatures.exe');
      const { spawn } = require('child_process');
      spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true };
    } catch (e) {
      // Very rare: Blocked by group strategy / File missing. Back to the setup page, at least one entry for the user
      shell.openExternal('ms-settings:optionalfeatures').catch(() => {});
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle('window:close', () => mainWindow?.close());
  ipcMain.handle('window:hide', () => mainWindow?.hide());

  // --------------Applying windows (only rotation / minimization / maximization / closure)---------

  const winOf = (e) => BrowserWindow.fromWebContents(e.sender);

  ipcMain.handle('shell:state', () => ({ ...appWin.state, iconUrl: appWin.iconUrl || '' }));
  // The image below the stand-alone window mode is in the emulator’s original window, the shell window is hidden -- the button must function to the real one
  // Visible one. Uniformly hand over to the appWin judgment mode, avoiding hidden windows
  ipcMain.handle('shell:minimize', () => appWin.minimize());
  ipcMain.handle('shell:maximize', () => appWin.toggleMaximize());
  // Close must go: it will remove the simulator window from the host and stop the Android application.
  // The old realization is straight through the end -- the window is gone, but the Android side process is still running.,
  // It’s what the user says, "Dot closes and doesn’t turn off applications."
  ipcMain.handle('shell:close', () => {
    if (appWin && appWin.isOpen) { appWin.close(); return { ok: true }; }
    return { ok: false };
  });
  // Rotation button for the titlebar = "This application I want to apply across/inverted."
  // RotateCurrentApp: using the wantLandscapeFor(pkg) as the only baseline to calculate the target direction,
  // When you calculate next, write per-app overlay + the physical cut panel. Used to be here and appWin.rotate
  // Each one of them. The two values.
  // On the contrary, it’s called, "Standing around, overwrite into a screen, overwrite, overcut the panel, cut back to the screen, and then flipped back to the screen next time.",
  // The red nuts don't fit in.
  ipcMain.handle('shell:rotate', () => rotateCurrentApp());

  ipcMain.handle('shell:back', async () => { await runtime.client().keyBack(); });
  ipcMain.handle('shell:forward', async () => { await runtime.client().keyForward(); });

  // --------------------------------------------------------------------------------------------------------------------------------------------

  ipcMain.handle('android:status', async () => {
    try { return { ok: true, ...(await androidSet.status()) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:set', async (_e, { key, value }) => {
    try {
      switch (key) {
        case 'wifi': return { ok: true, ...(await androidSet.setWifi(!!value)) };
        case 'airplane': return { ok: true, ...(await androidSet.setAirplane(!!value)) };
        case 'volume': return { ok: true, ...(await androidSet.setVolume(value)) };
        case 'animations': return { ok: true, ...(await androidSet.setAnimations(!!value)) };
        case 'fontScale': return { ok: true, ...(await androidSet.setFontScale(value)) };
        case 'density': return { ok: true, ...(await androidSet.setDensity(value)) };
        default: return { ok: false, error: `Unknown Settings ${key}` };
      }
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:open', async (_e, action) => {
    try { return { ok: true, ...(await androidSet.open(action)) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:tune', async (_e, pkg) => {
    try { return { ok: true, ...(await androidSet.tune({ pkg })) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:permissions', async (_e, pkg) => {
    try { return { ok: true, rows: await androidSet.permissions(pkg) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:grantAll', async (_e, pkg) => {
    try { return { ok: true, ...(await androidSet.grantAll(pkg)) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('app:foreground', () => {
    if (appWin && appWin.isOpen) { appWin.win.show(); appWin.win.focus(); return true; }
    return false;
  });

  // - KeyMap -
  ipcMain.handle('shell:keyEvent', async (_e, key) => {
    if (!keymapEngine || !keymapEngine.enabled) return false;
    const pkg = currentAppPkg;
    if (!pkg) return false;
    return keymapEngine.handleKey(key, pkg);
  });
  ipcMain.handle('keymap:getPresets', () => {
    return Object.entries(KEYMAP_PRESETS).map(([id, p]) => ({ id, label: p.label, desc: p.desc }));
  });
  ipcMain.handle('keymap:getMap', (_e, pkg) => keymapEngine ? keymapEngine.getMap(pkg) : []);
  ipcMain.handle('keymap:setMap', (_e, pkg, mappings) => {
    if (!keymapEngine) return { ok: false };
    keymapEngine.setMap(pkg, mappings);
    // Persistence to Settings
    const maps = { ...(store.getSettings().engine.keymaps || {}) };
    if (mappings && mappings.length) maps[pkg] = mappings;
    else delete maps[pkg];
    store.saveSettings({ engine: { keymaps: maps } });
    return { ok: true };
  });
  ipcMain.handle('keymap:setEnabled', (_e, on) => {
    if (keymapEngine) keymapEngine.enable(!!on);
    store.saveSettings({ engine: { keymapEnabled: !!on } });
    return { ok: true };
  });
  ipcMain.handle('keymap:isEnabled', () => keymapEngine ? keymapEngine.enabled : false);
  ipcMain.handle('keymap:applyPreset', (_e, pkg, presetId) => {
    if (!keymapEngine || !KEYMAP_PRESETS[presetId]) return { ok: false };
    const mappings = KEYMAP_PRESETS[presetId].mappings;
    keymapEngine.setMap(pkg, mappings);
    const maps = { ...(store.getSettings().engine.keymaps || {}) };
    maps[pkg] = mappings;
    store.saveSettings({ engine: { keymaps: maps } });
    return { ok: true, mappings };
  });

  // - - - - Online update - - - - -

  ipcMain.handle('app:updateCheck', async (_e, opts = {}) => {
    try {
      // User active "check for updates" skips the cache and must ask again two sources
      const info = await updater.check({ force: opts.force !== false });
      updateInfo = info;
      return { ok: true, ...info };
    } catch (e) {
      return { ok: false, error: e.message, current: app.getVersion() };
    }
  });

  ipcMain.handle('app:updateOpen', (_e, url) => {
    // Allow the release page to open when the update check fails.
    // Let the user download manually, just let the github.com keep the domestic user out of the door.
    const raw = String(url || '');
    const ok = /^https:\/\/(github\.com)\//i.test(raw);
    const target = ok ? raw : Updater.repoUrl();
    shell.openExternal(target).catch(() => {});
    return { ok: true, target };
  });

  ipcMain.handle('app:updateApply', () => runUpdate());

  ipcMain.handle('app:updateCancel', () => { updateBusy = false; return { ok: true }; });

  ipcMain.handle('app:restart', () => {
    setTimeout(() => { quitting = true; app.quit(); }, 200);
    return { ok: true };
  });
}

// - - - - life cycle - - -

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_evt, argv) => {
    const args = parseArgs(argv);
    if (args.launch) { runLaunch(args.launch); return; }
    if (args.apk) { runInstall(args.apk).catch(() => {}); return; }
    showWindow();
  });

  app.whenReady().then(async () => {
    store.ensureDirs();
    /**
     * Write down "Who’s running the show?"
     *
     * Use to see releaseRuntime(): The user points the application and does not react again, when the old example
     * Quiting (single instance lock released), new example taking over the simulator and starting application;
     * The end is the same, rantime.dispose(), so the new example is taken. `device 'emulator-5554' not found`.
     * This is shown by the "Application is never open after two points." The new example covers this file as soon as it is started.,
     * The old example ends with a pid that doesn’t skip running out on itself.
     */
    try { fs.writeFileSync(path.join(store.DATA_DIR, 'owner.pid'), String(process.pid)); } catch (_) { /* ignore */ }
    // Windows Taskbar Identity (AppUSerModelID))
    // Windows can only guess identity by ex-path: taskbar fixed, jump list, notify source
    // All of them fall on the "Electron" -- what users see is "the icon/name is the one that's the default."
    // Note that this is the status of the current process, and when you cut to some Android application, you switch to one that applies to yourself.
    // AUMID (see openAppWindow), otherwise the taskbar fixes and the running window does not match,
    // The fixed item is also an icon for Hydra Emulator.
    setAumid(APP_AUMID);
    runtime = new Runtime(APP_ROOT);
    // Starts with a line of traces: the user sends the app.log to see the version and the data directory.
    appLog(`start v${app.getVersion()} data=${store.DATA_DIR} pid=${process.pid}`);

    // - Open the mural window -
    // Motion DSH style: Logo gradually shows + progress bar + status text.
    // Shows an additional description of the configuration steps when first installed; not the first display only of streamlined animations.
    // Android environment cools off when ready, applies seconds to enter.
    const isFirstRun = !store.getSettings().runtime.installed;
    // Splash Shortest Stay: A very simple animation of the fadeUp at the latest.95s starts, continues.85s, approximately 1.8s is finished.
    // Remember when the real show comes out, splashDone is satisfied when it's not enough, and avoid "spilling" it.
    // The cold start deployment is > 1.8s, no sense.
    let splashShownAt = Date.now();
    try {
      // Center Screen
      const { screen: electronScreen } = require('electron');
      const disp = electronScreen.getPrimaryDisplay();
      const sw = disp.workAreaSize.width;
      const sh = disp.workAreaSize.height;
      const splashW = 480, splashH = 360;
      splashWin = new BrowserWindow({
        width: splashW, height: splashH,
        x: Math.round((sw - splashW) / 2),
        y: Math.round((sh - splashH) / 2),
        frame: false, transparent: false, resizable: false,
        alwaysOnTop: true, skipTaskbar: true,
        backgroundColor: '#0b0c0e',
        show: false,
        webPreferences: {
          preload: path.join(__dirname, 'splash-preload.js'),
          contextIsolation: true, nodeIntegration: false, sandbox: false,
        },
      });
      // Make sure that the screen-saver level is not covered by the emulator window (previously always OnTop default level)
      // SetForegroundWindow grab z-order, causing splash to be held up behind)
      splashWin.setAlwaysOnTop(true, 'screen-saver');
      splashWin.loadFile(path.join(__dirname, 'ui', 'splash.html'));
      splashWin.once('ready-to-show', () => { splashShownAt = Date.now(); splashWin.show(); });
      // IPC: Version number, first running tag, off
      ipcMain.handle('splash:version', () => app.getVersion());
      ipcMain.handle('splash:isFirstRun', () => isFirstRun);
      // Whether the components will be carried with their own packages: to open the animations and exchange the notes, do not say "downloading" to users who already have a built-in image.
      ipcMain.handle('splash:bundled', () => !!bundledRuntimeDir);
      ipcMain.on('splash:close', () => {
        if (splashWin && !splashWin.isDestroyed()) splashWin.close();
        splashWin = null;
      });
    } catch (e) {
      appLog(`splash window failed: ${e.message}`);
      splashWin = null;
    }
    // Send progress/ finish signal to splash (module-level variables, see top of file description))
    splashProgress = (p) => {
      if (splashWin && !splashWin.isDestroyed()) splashWin.webContents.send('splash:progress', p);
    };
    // The signal fades only once; and a fuse hangs: splash itself in 2.5 seconds.
    // (Rendering process stuck / IPC lost) is strongly shut down by the main process, never leaving the startup image on the desktop.
    let splashDoneSent = false;
    let splashDoneScheduled = false;
    const SPLASH_MIN_MS = 1800;   // The shortest time required for the complete presentation of the extremely simple animation
    const doSplashDone = () => {
      if (splashDoneSent) return;
      splashDoneSent = true;
      if (!splashWin || splashWin.isDestroyed()) return;
      try { splashWin.webContents.send('splash:done'); } catch (_) { /* ignore */ }
      setTimeout(() => {
        try {
          if (splashWin && !splashWin.isDestroyed()) splashWin.close();
        } catch (_) { /* ignore */ }
        splashWin = null;
      }, 2500).unref?.();
    };
    splashDone = () => {
      if (splashDoneSent || splashDoneScheduled) return;
      const waited = Date.now() - splashShownAt;
      if (waited < SPLASH_MIN_MS) {
        // Fill the shortest stay: let the fadeUp sequence out before it fades, and don't flash over.
        // Just one call, take the first call, and avoid repeating the call to push the fade out later.
        splashDoneScheduled = true;
        setTimeout(doSplashDone, SPLASH_MIN_MS - waited).unref?.();
      } else {
        doSplashDone();
      }
    };
    // Overtime: no path triggers splashDone (e.g., start failed to jam) will be removed.,
    // Otherwise, splash will be stuck in the center of the screen -- this is the most miraculous scene of multiple windows.
    setTimeout(() => { if (!splashDoneSent) splashDone(); }, 180000).unref?.();

    const l = launcherInfo();
    installer = new Installer(runtime, {
      launcherTarget: l.target,
      launcherArgs: l.args,
      cwd: l.cwd,
      isDev: IS_DEV,
      desktopDir: app.getPath('desktop'),
      // Windows search indexes are in the start menu. Ink, only the desktop will be "unable to find application";
      // Linux corresponds to the menu directory for freedesktop.
      startMenuDir: process.platform === 'win32'
        ? path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
        : path.join(process.env.HOME || app.getPath('home'), '.local', 'share', 'applications'),
      decodeIcon,
    });
    sharer = new Sharer(runtime);
    androidSet = new AndroidSettings(runtime);

    // - KeyMap Engine -
    const keymapEngine = new KeymapEngine({
      execInput: (cmd) => runtime.client().shell(cmd, { timeout: 4000 }),
      getSize: () => {
        // Use current panel size (1280x720 / erect 720x1280 on screen))
        const land = !!(store.getSettings().display || {}).landscape;
        return land ? { width: 1280, height: 720 } : { width: 720, height: 1280 };
      },
    });
    // Load maps of each application from the settings
    const savedMaps = (store.getSettings().engine || {}).keymaps || {};
    for (const [pkg, mappings] of Object.entries(savedMaps)) {
      if (Array.isArray(mappings) && mappings.length) keymapEngine.setMap(pkg, mappings);
    }
    // Default Enable (User can close in settings))
    keymapEngine.enable(store.getSettings().engine.keymapEnabled !== false);

    updater = new Updater({
      currentVersion: app.getVersion(),
      exePath: process.execPath,
      isPackaged: app.isPackaged,
      dataDir: store.DATA_DIR,
      // Prerequisite for incremental updating: This machine, the Electric version, is identical to the release, and only changes the code layer.
      electronVersion: process.versions.electron,
      // Read the current download preferences.
      settings: () => store.getSettings(),
      onProgress: (p) => send('update:progress', p),
    });

    // Roller Merger: input slide, adb shell.
    wheelRouter = new pointer.WheelRouter({
      getSize: getDeviceSize,
      inject: (cmd) => runtime.client().input(cmd),
    });

    // Window agent: Only the embedded emulator window. The global mouse hook is installed only on configuration when applying the front desk of the window.
    winAgent = new WinAgent();
    appWin = new AppWindow({
      agent: winAgent,
      // Rotate to change the logical resolution of Android, to be done by adb client
      setOrientation: async (landscape) => {
        deviceSize.value = null;
        return runtime.client().setOrientation(landscape);
      },
      // Send getter: Setup Pages Changed Keys, Next Window Focus/ Refresh will take effect without restarting
      pointerConfig: () => pointer.pointerOptions(store.getSettings()),
      // The window is to be found by the window proxy by the process field.)
      windowTargets: () => null,
    });
    appWin.onCloseApp((pkg) => {
      // Close window = stop this application; container parking when the last window is closed (down priority, stop the rounding)),
      // But Android’s environment is kept, and the next point is a second and not a cold start.
      runtime?.endApp(pkg, { onIdle: onContainerActive }).catch(() => {});
      // External close (Alt+F4/ Taskbar close) also clears the current application tags, otherwise the tray menu
      // Also shows "Close current application (xx)" but no response (application stopped).
      if (currentAppPkg === pkg) currentAppPkg = null;
      try { send('apps:changed'); } catch (_) { /* ignore */ }
    });

    // "What windows are ours" = running-time directory + packaged engine directory.
    // Window agent only allows to touch the windows created by these processes - other Qt applications (micro-Fifty 4.x is Qt6,
    // Window class name is identical to the simulator.
    const agentScope = () => {
      const dirs = [];
      try { dirs.push(runtime.provisioner.root); } catch (_) { /* ignore */ }
      try { dirs.push(path.join(APP_ROOT, 'engine')); } catch (_) { /* ignore */ }
      return dirs.filter(Boolean);
    };
    // There's a memory of the proxy process, and the agent's reconstruction is gone -- so it's sent again every time it's off.
    armAgent = async (agent) => {
      if (!agent) return { ok: false };
      const dirs = agentScope();
      // The second parameter is this process pid: the agent refuses to embed the window into the "Not Our" window.
      await agent.scope(dirs, process.pid).catch(() => null);
      if (!dirs.length) appLog('Anent shop is empty: do not suppress any windows (avoid other software from being injured by error))');
      return agent.bootHide().catch(() => ({ ok: false }));
    };

    // The proxy process will be re-established when the adroit is unexpectedly withdrawn, and the event tap will have to be re-retraced together.
    // Right-click back and roller, in the form of "no reaction for a while."
    const attachAgentEvents = (agent) => {
      agent.on('back', () => { runtime.client().keyBack().catch(() => {}); });
      agent.on('forward', () => { runtime.client().keyForward().catch(() => {}); });
      agent.on('wheel', (m) => {
        if (pointer.pointerOptions(store.getSettings()).wheel === 'smooth') wheelRouter.push(m);
      });
      agent.on('exit', () => {
        const next = new WinAgent();
        winAgent = next;
        appWin.agent = next;
        attachAgentEvents(next);
        // The new agent doesn't have a range. He won't touch a window without this.
        armAgent(next).catch(() => {});
      });
    };
    attachAgentEvents(winAgent);

    // The "gate" that is ordered to be suppressed by the window must be opened before the simulator process is created.
    // The old realization was "Wait for Hydra Emulator to get up and hide in four seconds," and the simulator had already put it before that.
    // The qemu control window was created -- the user saw a flash of black boxes.
    runtime.emulator.onBeforeSpawn = async () => {
      if (!winAgent) return;
      await armAgent(winAgent);
    };
    // The window agent is a PowerShell resident process, cold start about 300-600ms.
    // Pull up early, don't wait until the moment you really want to hide the window.
    winAgent.ensure().then(() => armAgent(winAgent)).catch(() => {});

    registerIpc();
    createWindow({ show: !parseArgs(process.argv).silent });
    buildTray();
    applyAutoStart();

    // Auto-detection: schedule task first, start 25 seconds before running the first round.
    // The delay is due to the fact that the snapshots are still in place when the engine is starting.,
    // The situation that was taken at that time was the most susceptible to miscalculation (for example, "seen the device" was just not finished).
    scheduleAutodebug();
    setTimeout(() => { runAutodebug().catch(() => {}); }, 25000).unref?.();

    // The old version of installation has no application field.
    // If you don't, follow applications back to the current panel direction.
    // It’s still black on both sides of the crossscreen panel. This is filled with a package of offline APK lists.,
    // + AndroidManifest, hundreds of milliseconds and only one run.
    try {
      const { parseApk } = require('./core/apk');
      const filled = [];
      for (const app of store.getApps()) {
        if (app.orientation || !app.apkPath) continue;
        if (!fs.existsSync(app.apkPath)) continue;
        try {
          const meta = parseApk(app.apkPath);
          if (meta.orientation) {
            store.upsertApp({ package: app.package, orientation: meta.orientation });
            filled.push(`${app.label}=${meta.orientation}`);
          }
        } catch (_) { /* Parsing failed application skipping, does not affect startup */ }
      }
      if (filled.length) appLog(`orientation backfill: ${filled.join(', ')}`);
    } catch (_) { /* ignore */ }

    // Disk Balance: Android never gets up when it’s less than 3GB.
    // Instead of making the user look "can’t open," it’s not clear, so let’s open the door and tell him where to go.
    {
      const doctor = require('./core/doctor');
      const freeMB = doctor.freeDiskMB(store.DATA_DIR);
      if (freeMB && freeMB < 3072) {
        appLog(`LOW_DISK free=${freeMB}MB dir=${store.DATA_DIR}`);
        setTimeout(() => {
          notify('Disk space is insufficient', `There’s only one left. ${(freeMB / 1024).toFixed(1)} GB. Please go to Setup → System Integration and change the Android Data Directory/runtime directory to another disk, or clean the disk first.`);
          send('toast', { type: 'error', message: `The disk’s all we have. ${(freeMB / 1024).toFixed(1)} GB, Android may not be able to start (set up → system integration to replace disks))` });
        }, 3000).unref?.();
      }
    }

    // The old version only builds desktop shortcuts / icons are null: start-up is automatically completed without user-operated
    installer.ensureShortcuts().then((fixed) => {
      if (fixed && fixed.length) {
        windowctl.refreshShell().catch(() => {});
        notify('Shortcut completed', fixed.join(', '));
      }
    }).catch(() => {});

    // F11 Full Screen / Window Switch; Global Shortcut only valid while Hydra Emulator is alive
    try {
      globalShortcut.register('F11', () => { toggleDisplayMode(); });
    } catch (_) { /* ignore */ }
    // Rotate Shortcut: Original window mode shell window is hidden, Ctrl+R in the title bar does not receive focus,
    // So register another global combination key. Use Ctrl+Alt+R instead of Ctrl+R -- the latter will add
    // The browser/editor ’s “ refresher “ key grabs, and the global register directly cancels the user ’ s other programs.
    try {
      globalShortcut.register('CommandOrControl+Alt+R', () => {
        if (currentAppPkg) rotateCurrentApp().catch(() => {});
      });
    } catch (_) { /* ignore */ }

    const args = parseArgs(process.argv);
    if (args.apk) runInstall(args.apk).catch(() => {});
    else if (args.launch) await runLaunch(args.launch);
    else {
      // No direct start application: splash after main window ready
      if (typeof splashDone === 'function') {
        setTimeout(() => splashDone(), 800);
      }
    }

    // Preheat: Residentize Android environment like the WSA/APP.
    // When you open Hydra Emulator, you guide it backstage.
    // Only "Applications already loaded + When Available" are preheated to avoid the first use/pure management of the scenes to capture memory.
    const prewarmEnabled = store.getSettings().engine.prewarm !== false;
    if (prewarmEnabled && !args.launch && store.getApps().length > 0) {
      // 1.2 seconds is enough to finish the first frame of the window. 4 seconds ago, the user had already ordered the application.,
      // And it turns out that the AVD lock is the same as the AVD lock, but it's slower.
      setTimeout(async () => {
        try {
          const env = await runtime.provisioner.checkEnv();
          if (!(env.adb.ok && env.emulator.ok && env.sysimg.ok)) {
            appLog(`prewarm skipped: not ready (adb=${env.adb.ok} emu=${env.emulator.ok} img=${env.sysimg.ok})`);
            return;
          }
          // Hide the simulator window with the qemu control during the start-up phase. Users should not see any windows.
          // When it comes to effect, the black window will come out.
          if (winAgent) { try { await armAgent(winAgent); } catch (_) { /* ignore */ } }
          const t0 = Date.now();
          appLog('prewarm start');
          const r = await runtime.prewarm({ onLog: (m) => appLog(`prewarm ${m}`) });
          if (r && r.ok) appLog(`prewarm ready in ${Date.now() - t0}ms`);
          else {
            appLog(`prewarm failed: ${r && (r.error || r.skipped)}`);
            // Preheat failure also continues to crush the simulator window: it may just be slow, but it’ll be up in a while.,
            // Users should not see a simulator on the desktop for "preheat failure".
            if (winAgent) armAgent(winAgent).catch(() => {});
          }
        } catch (e) { appLog(`prewarm error: ${e && e.message}`); /* Preheat failure does not affect subsequent normal openings */ }
      }, 1200).unref?.();
    } else {
      appLog(`prewarm off (enabled=${prewarmEnabled} launch=${!!args.launch} apps=${store.getApps().length})`);
    }

    // The first operating component deployment delayed 20 seconds: the time the cold start disk/CPU was full,
    // Reloading and downloading will only make the desktop more cardable. The application will be ready when it is open.
    setTimeout(() => {
      autoDeploy().then((r) => {
        if (r && r.ok) send('toast', { type: 'ok', message: 'Run automatically ready for completion' });
      }).catch(() => {});
    }, 20000).unref?.();

    // Starts eight seconds to silently check the new version. New version found only hints.,
    // Never download automatically -- updates are what user points do when they "renew immediately."
    // MSIX version skipping: Install directories are read-only WindowsApps, self-renewing without writing
    // Compliance, update and harmonization is done by Microsoft Store.
    if (app.isPackaged && !store.STORE_BUILD) {
      // Que #98: Check "Last download unpressure, but replacement/reboot update of landfall".
      // The hit is directly replaced by local load reloading + reboot, never going down again -- it’s the solution to the renewal of the death cycle.
      // Avoids resumable and a new check-checking progress bar before checking on the new version.
      let resuming = false;
      try {
        const job = updater.findResumableJob();
        if (job) {
          resuming = true;
          appLog(`resuming pending update ${job.version} from cached payload`);
          send('update:progress', { stage: 'apply', percent: 100, message: 'Last outstanding update is being completed…' });
          updater.apply(job);
          setTimeout(() => { quitting = true; app.quit(); }, 900);
        }
      } catch (e) { appLog(`resume check failed: ${e.message}`); }
      // If you continue, you will not launch a new version in parallel; but you cannot jump out of the full startback with the return.
      if (!resuming) setTimeout(() => {
        updater.check().then((info) => {
          updateInfo = info;
          send('update:state', info);
          if (info.hasUpdate) {
            appLog(`update available ${info.tag} (current v${app.getVersion()}, asset=${info.asset ? info.asset.name : 'none'})`);
            // No more separate system notification: alarms at start-up receive the welcome card in the application,
            // To avoid a right-hand lower bubble when the engine starts.
          }
        }).catch((e) => appLog(`update check failed: ${e.message}`));
      }, 8000).unref?.();
    }

    // Synchronise file/ notify the rounding is no longer unconditional: only running when the application window is actually available in the container
    // (See on ContainerActive.

    // Smoking test: exits after a screenshot, used to automate the normal rendering of the interface
    if (process.argv.includes('--smoke') && mainWindow) {
      const out = process.argv[process.argv.indexOf('--smoke') + 1] || 'smoke.png';
      mainWindow.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          try {
            if (process.argv.includes('--setup')) {
              // The running-time panel has been merged into settings: --setup and --setings equal, directly open the setup screenshot
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('btnSettings').click(); true;",
              );
              await new Promise((r) => setTimeout(r, 2500));
            }
            if (process.argv.includes('--settings')) {
              const opened = await mainWindow.webContents.executeJavaScript(`
                (async () => {
                  document.getElementById('btnSettings').click();
                  for (let i = 0; i < 50; i++) {
                    await new Promise((r) => setTimeout(r, 100));
                    if (document.getElementById('settingsMask').classList.contains('on')) return true;
                  }
                  return false;
                })()
              `);
              console.log('[smoke] settings opened =', opened);
              await new Promise((r) => setTimeout(r, 600));
              const dbg = await mainWindow.webContents.executeJavaScript(
                "JSON.stringify({ on: document.getElementById('settingsMask').classList.contains('on'), qr: !!document.querySelector('#aboutGroup img'), qrH: (document.querySelector('#aboutGroup img')||{}).naturalHeight, ver: (document.getElementById('aboutVer')||{}).textContent, note: (document.getElementById('setupNote')||{}).textContent })",
              );
              console.log('[smoke] dom =', dbg);
            }
            // The window may be blocked and the old frame will be taken: forced to redecorate + to take two frames in a row to take the second frame
            const snap = async (file) => {
              mainWindow.webContents.invalidate();
              await mainWindow.webContents.capturePage().catch(() => null);
              await new Promise((r) => setTimeout(r, 400));
              const im = await mainWindow.webContents.capturePage();
              fs.writeFileSync(file, im.toPNG());
              console.log('[smoke] saved', file);
            };
            await snap(out);
            if (process.argv.includes('--perf')) {
              // Take a picture of the " performance and resource occupancy" area (set the largest control in the page))
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('perfGroup').scrollIntoView({ block: 'start' }); true;",
              );
              await snap(out.replace(/\.png$/i, '-perf.png'));
            }
            if (process.argv.includes('--download')) {
              // Take a Download and Update Source section
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('downloadGroup').scrollIntoView({ block: 'start' }); true;",
              );
              await snap(out.replace(/\.png$/i, '-download.png'));
            }
            if (process.argv.includes('--settings')) {
              // Capture the About panel.
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('aboutGroup').scrollIntoView({ block: 'center' }); true;",
              );
              await snap(out.replace(/\.png$/i, '-about.png'));
            }
          } catch (e) {
            console.error('[screenshot failed', e);
          }
          quitting = true;
          app.quit();
        }, 6500);
      });
    }

    app.on('activate', () => showWindow());
  });

  app.on('window-all-closed', () => {
    // Only hidden to tray (close event intercepted) when the window is normally closed),
    // And coming here is a sign that you really want to quit, you have to let it go, or the process will be left behind and hold the list of examples locked.
    // Remember one line: when the application window is open, and Hydra Emulator is gone, it's direct.
    // Distinguishing between "all windows are cleared" and "processes are killed outside".
    appLog(`window-all-closed quitting=${quitting}`);
    if (quitting) app.exit(0);
  });

  // When the Rendering / GPU process collapses, the Elementron defaults only to whiteen the window and does not necessarily exit the main process;
  // But it's the most common reason for "sudden loss of image," and it has to be left in the log.
  app.on('child-process-gone', (_e, d) => {
    try {
      appLog(`child-process-gone type=${d && d.type} reason=${d && d.reason} exit=${d && d.exitCode}`);
    } catch (_) { /* It doesn't matter if the log doesn't go in. */ }
  });

  let quitReady = false;
  /**
   * It only stops when I’m running.
   *
   * The double-extract is the real scene: the user point application doesn’t react.
   * A single case lock has been released, but it’s not yet clean, and the new example has taken over the simulator and started;
   * The old example is then executed by dispose() to kill the simulator that is being used for the new example. ——
   * The log is "code=0" right after "device 'emulator-5554' not found".
   * The owner.pid is covered by every startup, so whoever last starts it is the owner.
   */
  const releaseRuntime = () => {
    let mine = true;
    try {
      const owner = Number(String(fs.readFileSync(path.join(store.DATA_DIR, 'owner.pid'), 'utf8')).trim());
      mine = !owner || owner === process.pid;
    } catch (_) { mine = true; }
    if (mine) {
      runtime?.dispose();
    } else {
      appLog('Another example has been taken over, skipping the stop (or it will kill its simulator by mistake).)');
    }
  };
  app.on('before-quit', (e) => {
    quitting = true;
    appLog(`before-quit ready=${quitReady}`);
    // The window agent must take the simulator window off + hide it before exiting. This step is a step forward.
    // (So the first time before-quit stops and finishes and actually quits.
    // Without this step, the host window will be destroyed, and Windows will re-engineer the simulator window to the desktop and show it.——
    // It was shown by the fact that, "When the Hydra Emulator is turned off, there’s still a dark window on the desktop of Android Emulator."
    if (!quitReady) {
      e.preventDefault();
      quitReady = true;
      sharer?.stop();
      notifier?.stop();
      try { appWin?.close({ keepApp: true }); } catch (_) { /* ignore */ }
      const finish = () => {
        try { winAgent?.dispose(); } catch (_) { /* ignore */ }
        try { wheelRouter?.dispose(); } catch (_) { /* ignore */ }
        releaseRuntime();
        // A hidden icon decoding window is also a window, and failure to turn it off will never trigger
        try { if (decodeWindow && !decodeWindow.isDestroyed()) decodeWindow.destroy(); } catch (_) { /* ignore */ }
        app.quit();
      };
      setTimeout(finish, 400);
      return;
    }
    try { winAgent?.dispose(); } catch (_) { /* ignore */ }
    try { wheelRouter?.dispose(); } catch (_) { /* ignore */ }
    releaseRuntime();
    try { if (decodeWindow && !decodeWindow.isDestroyed()) decodeWindow.destroy(); } catch (_) { /* ignore */ }
  });
}
