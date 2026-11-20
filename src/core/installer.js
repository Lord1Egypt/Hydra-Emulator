'use strict';
/**
 * Install / Start / Unmount Arrange Layer
 * Combine the “Parse APK → When Installed into Operations Drop Local Metadata Generate Desktop Shortcut“ into a current line.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const { parseApk } = require('./apk');
const { ZipFile } = require('./zip');
const { iconToIco, writeShortcut, removeShortcut, safeFileName, shortcutExt } = require('./shortcut');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** APK only ARM original library.) */
function isArmOnly(meta) {
  return !!(meta && meta.abis && meta.abis.length && !meta.abis.some((a) => /x86/i.test(a)));
}

/**
 * Whether the current "operational" Android has ARM translator capability.
 * The question is: is the mirror file on the disk (playImageInfo().ok) different from whether the current simulator has a translation layer?
 * Play mirrors are not available in abilist -- this time they’re installed.
 * ARM-only application must be INSTALL_FAILED_NO_MATCHING_ABIS. returns null to not detect, and handing over to installation failed
 * And then we’re going to try again, and we’re not going to block the installation because we can’t detect it.
 */
async function runningHasArm(client) {
  try {
    const out = String(await client.shell('getprop ro.product.cpu.abilist', { timeout: 6000 }).catch(() => ''));
    if (!out.trim()) return null;
    return /arm/i.test(out);
  } catch (_) {
    return null;
  }
}

/**
 * Split installation packages (.apks / . xapk): Dismantled pieces of APK to pure ASCII temporary directory.
 * Use file version ZIP Reader + Streamboard: Split package for 2GB+, whole package read memory fails.
 * returns {meta, files, cleanup}; meta from the base APK with AndroidManifest.
 */
async function parseBundle(filePath) {
  const zip = new ZipFile(filePath);
  const dir = path.join(os.tmpdir(), 'hydra-bundle', crypto.createHash('sha1')
    .update(filePath).digest('hex').slice(0, 12));
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ } };
  try {
    const apkNames = zip.names().filter((n) => /\.apk$/i.test(n));
    if (!apkNames.length) throw new Error('No split APKs were found in this bundle. Check that it is a valid .apks or .xapk file.');
    fs.mkdirSync(dir, { recursive: true });
    const files = [];
    for (let i = 0; i < apkNames.length; i++) {
      const target = path.join(dir, `split-${i}.apk`);
      // Individual fragments may also be hundreds of MB: current depressure without Buffer
      // eslint-disable-next-line no-await-in-loop
      await zip.pipeTo(apkNames[i], fs.createWriteStream(target));
      files.push(target);
    }
    let meta = null;
    for (const f of files) {
      try { meta = parseApk(f); break; } catch (_) { /* There's no list in the film. */ }
    }
    if (!meta) throw new Error('Failed to parse split bag base APK');
    return { meta, files, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  } finally {
    zip.close();
  }
}

function accentOf(pkg) {
  let h = 0;
  for (let i = 0; i < pkg.length; i++) h = (h * 31 + pkg.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 62% 52%)`;
}

class Installer {
  constructor(runtime, ctx) {
    this.runtime = runtime;
    this.ctx = ctx; // { launcherTarget, launcherArgs, cwd, isDev, desktopDir }
  }

  shortcutTarget() {
    const { launcherTarget, launcherArgs } = this.ctx;
    return { target: launcherTarget, baseArgs: launcherArgs || '' };
  }

  iconFile(pkg) { return store.iconPath(pkg); }

  icoFile(pkg) { return path.join(store.ICON_DIR, `${pkg}.ico`); }

  shortcutPath(app) {
    const s = store.getSettings();
    const dir = s.shortcutDir && s.shortcutDir.trim() ? s.shortcutDir : this.ctx.desktopDir;
    return path.join(dir, `${safeFileName(app.label)}${shortcutExt()}`);
  }

  /**
   * Desktop + Start two menus.
   * Windows search index is "Start Menu" \ . Ink, only the desktop will not be searched;
   * Some machines have their desktops reoriented by OneDrive, and the start menu is a guarantee that the entrance will not be lost.
   *
   * Linux corresponds to freedesktop. desktop.:
   * Desktop one, application menu ~/. local/share/applications one.
   */
  shortcutPaths(app) {
    const out = [this.shortcutPath(app)];
    if (this.ctx.startMenuDir && store.getSettings().createStartMenuShortcut !== false) {
      // In a separate subdirectories: both Windows can be indexed and do not overwrite the shortcuts applied by third parties with the same name
      // (Testing that the Redfruit Free Short Play was occupied by another desktop assistant on the startup menu)
      out.push(path.join(this.ctx.startMenuDir, 'Hydra Emulator', `${safeFileName(app.label)}${shortcutExt()}`));
    }
    return [...new Set(out)];
  }

  /** Compatible mirrors are downloaded as required by ARM applications first encountered, and the shared read-only base layer is only next */
  async ensureCompatImage(onProgress) {
    const prov = this.runtime.provisioner;
    if (prov.playImageInfo().ok) return true;
    onProgress({ stage: 'runtime', message: 'ARM application: Downloading compatible images (approximately 1.5 GB, just once))…' });
    await prov.installPlayImage((p) => onProgress({ stage: 'runtime', message: p.message, percent: p.percent }));
    if (!prov.playImageInfo().ok) throw new Error('Failed to download compatible mirrors, please check the network and try again');
    return true;
  }

  /** Toggle mirrors must restart when running; reloading installed from local APK backup */
  async switchToCompat(onProgress) {
    const apps = store.getApps();
    store.saveSettings({ runtime: { compatImage: true } });
    onProgress({ stage: 'runtime', message: 'Switching to compatible mirror and restarting…' });
    try { await this.runtime.stop(); } catch (_) { /* ignore */ }
    // When old devices disappear from the adb list, avoid being used as an insure() instance for reuse
    for (let i = 0; i < 12; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const ds = await this.runtime.client().devices().catch(() => []);
      if (!ds.some((d) => /^emulator-\d+$/.test(d.serial))) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(1000);
    }
    // Key: Must be used and used. The snapshot contains memory and disk status when there is no translation.,
    // If you don't know, it's going to come back directly from the snapshot -- mirrors are changed to the translation floor and they're not working.,
    // So reloading is no_MATCHING_ABIS, and users see "Change or not."
    try { this.runtime.emulator?.invalidateSnapshot(); } catch (_) { /* ignore */ }
    const rt = await this.runtime.ensure({ onLog: (m) => onProgress({ stage: 'runtime', message: m }) });
    if (!rt.ok) {
      const err = new Error(rt.error || 'Unable to run after switching compatible images');
      err.needsSetup = rt.needsSetup || 'provision';
      throw err;
    }
    for (const app of apps) {
      if (!app.apkPath || !fs.existsSync(app.apkPath)) continue;
      try {
        if (app.bundle) {
          // eslint-disable-next-line no-await-in-loop
          const b = await parseBundle(app.apkPath);
          // eslint-disable-next-line no-await-in-loop
          await rt.client.installMultiple(b.files);
          b.cleanup();
        } else {
          // eslint-disable-next-line no-await-in-loop
          await rt.client.install(app.apkPath);
        }
        onProgress({ stage: 'runtime', message: `Recovering installed application ${app.label}…` });
      } catch (_) { /* Individual application recovery failed without block */ }
    }
    return rt;
  }

  async install(filePath, onProgress = () => {}) {
    onProgress({ stage: 'parse', message: 'Parsing APK…' });
    let meta;
    let bundle = null;
    if (/\.(apks|xapk)$/i.test(filePath)) {
      bundle = await parseBundle(filePath);
      meta = bundle.meta;
    } else {
      meta = parseApk(filePath);
    }
    onProgress({
      stage: 'parse-done',
      message: `Recognized ${meta.label}(${meta.package})`,
      meta: { label: meta.label, package: meta.package, versionName: meta.versionName },
    });

    // 50GB game: check the remaining space on the simulator data drive first, not half until it’s loaded
    // INSTALL_INSUFFICIENT_STORAGE (user sees "installed and failed for a long time."
    try {
      const backend = this.runtime && this.runtime.backend;
      if (backend && typeof backend.checkDiskFor === 'function') {
        let bytes = 0;
        if (bundle && bundle.files) {
          for (const f of bundle.files) {
            try { bytes += fs.statSync(f).size; } catch (_) { /* Ignore temporary files */ }
          }
        } else {
          try { bytes = fs.statSync(filePath).size; } catch (_) { /* Use 0 for the bottom */ }
        }
        const verdict = backend.checkDiskFor(bytes);
        if (!verdict.ok) {
          onProgress({ stage: 'error', message: verdict.message });
          const err = new Error(verdict.message);
          err.needsSetup = 'disk';
          throw err;
        }
      }
    } catch (e) {
      if (e && e.needsSetup === 'disk') throw e;
      // Capacity detection failed to block installation.
    }

    try {
      onProgress({ stage: 'runtime', message: 'Preparing for Android to run.…' });
      let rt = await this.runtime.ensure({ onLog: (m) => onProgress({ stage: 'runtime', message: m }) });
      if (!rt.ok) {
        const err = new Error(rt.error || 'Not available when running');
        err.needsSetup = rt.needsSetup || 'provision';
        throw err;
      }

      // Zero Configuration ARM Compatibility: See if the "current running" has translation capability, rather than whether mirror files are on disk.
      // Play ImageInfo().ok is also true when old versions/old snapshots are pulled up, no translator is open,
      // It’s the only thing that’s missing, so it’s half way to report No_MATCHING_ABIS. Cut it in one time, save the white part.
      if (isArmOnly(meta) && await runningHasArm(rt.client) === false) {
        onProgress({ stage: 'runtime', message: 'This application is only ARM library, switching to compatible mirrors…' });
        await this.ensureCompatImage(onProgress);
        rt = await this.switchToCompat(onProgress);
      }
      return await this.finishInstall(rt, meta, filePath, bundle, onProgress);
    } finally {
      if (bundle) bundle.cleanup();
    }
  }

  /** Install body + falling disk metadata + shortcut; with autorepair retry when failed */
  async finishInstall(rt, meta, filePath, bundle, onProgress) {
    const client = rt.client;
    const existing = store.getApp(meta.package);
    // When it’s loaded, the old Quickboot flash disk status expires, and keeping it will lead to, “The reboot of the installed application is gone.“
    try { this.runtime.emulator?.invalidateSnapshot(); } catch (_) { /* ignore */ }
    onProgress({ stage: 'install', message: existing ? 'Updating application…' : 'Installing application…' });
    try {
      if (bundle) await client.installMultiple(bundle.files);
      else await client.install(filePath);
    } catch (e) {
      // ABI does not match this step, which is the proof that "there is no ARM translation when running" -- no need.
      // And guess what you’re doing with PlayImageInfo. `!playImageInfo().ok` When the switch is on, the mirror file is on disk.
      // But when you’re using an old emulator without translation, you’re skipped, you’re thrown in the wrong, but the interface is still showing the same thing.
      // "Retrying after automatic switching of compatible mirrors," so there’s something strange about "red installation failure + text saying retrying".
      // Now, one time, unconditionally: mistakes are in themselves reasons to try again.
      if (e.code === 'NO_MATCHING_ABIS') {
        onProgress({ stage: 'runtime', message: 'This application is only available in the ARM library and is being switched to compatible mirrors and reloaded…' });
        await this.ensureCompatImage(onProgress);
        const rt2 = await this.switchToCompat(onProgress);
        onProgress({ stage: 'install', message: 'Toggled compatible mirrors, reinstallation is ongoing…' });
        try {
          if (bundle) await rt2.client.installMultiple(bundle.files);
          else await rt2.client.install(filePath);
        } catch (e2) {
          // It's been cut to the compatible mirrors that have failed: this time it has to be honest, not "retrying."
          const raw2 = (e2 && e2.message) || String(e2 || '');
          const err = new Error(
            `Hydra switched to the Android 14 compatible image, but ${meta.label} still failed to install: ${raw2}. `
            + 'For help, export a diagnostic report under Settings → Diagnostics & Fixes.',
          );
          err.code = e2 && e2.code ? e2.code : 'NO_MATCHING_ABIS';
          err.abiRetried = true;
          throw err;
        }
      } else {
        throw e;
      }
    }
    this.runtime.touch();

    // Icons Dropboard. APK icons are a lot of WebP, nativeImage that can’t solve, leaving the rendering process decoding +
    // The branding map is the bottom of the puzzle, and I promise. Ink must have the icon.
    // iconFallback records "The Real Icon cannot be solved, the Bitmap is used" -- this is to be a soft warning to users,
    // Otherwise, there’s only one green triangle on the desktop, and users will think it’s Hydra Emulator who’s got the wrong icon.
    let iconPath = null;
    let icoPath = null;
    let iconFallback = '';
    if (meta.iconPng) {
      try {
        iconPath = store.iconPath(meta.package);
        fs.writeFileSync(iconPath, meta.iconPng);
      } catch (_) { /* ignore */ }
      try {
        const ico = await iconToIco(meta.iconPng, {
          decode: this.ctx.decodeIcon,
          onFallback: (why) => { iconFallback = why; },
        });
        if (ico) {
          icoPath = this.icoFile(meta.package);
          fs.writeFileSync(icoPath, ico);
        }
      } catch (_) { /* Failed icon does not affect installation */ }
    }

    // Backup APK, easy to reload/recover
    let apkCopy = null;
    try {
      apkCopy = store.apkPath(meta.package, meta.versionCode.toString(36));
      fs.copyFileSync(filePath, apkCopy);
    } catch (_) { /* ignore */ }

    // The start-up entrance is based on the system’s resolution: the “Main Activity“ is often not the one from the APK.
    // The real LAUNCHER entrance, using it directly to start over the application’s initial page, causes flashing.
    let launchActivity = meta.launchActivity;
    try {
      client.clearLauncherCache?.(meta.package);
      const resolved = await client.resolveLauncher(meta.package);
      if (resolved) launchActivity = resolved;
    } catch (_) { /* Keep APK parsing results */ }

    const app = {
      package: meta.package,
      label: meta.label,
      versionName: meta.versionName,
      versionCode: meta.versionCode,
      activity: launchActivity,
      abis: meta.abis,
      minSdk: meta.minSdk,
      sizeBytes: meta.sizeBytes,
      iconPath,
      icoPath,
      apkPath: apkCopy,
      bundle: !!bundle,
      accent: existing ? existing.accent : accentOf(meta.package),
      installedAt: existing ? existing.installedAt : Date.now(),
      updatedAt: Date.now(),
      launchCount: existing ? existing.launchCount || 0 : 0,
      lastLaunchAt: existing ? existing.lastLaunchAt || 0 : 0,
      shortcutPath: existing ? existing.shortcutPath || null : null,
      bounds: existing ? existing.bounds || null : null,
      // Apply natural cross-screens (offline from the APK list)):
      // To decide which direction the simulator's physical panel should take, the same direction is to fill the window with no black edge.
      // The user has manually set the value of the orientation Override, which is only the default value.
      orientation: meta.orientation || (existing ? existing.orientation || null : null),
      pinned: existing ? !!existing.pinned : false,
      // Reload = The list of rights may be reset, clear the "granted" cache, start again next time
      permGranted: false,
    };

    store.upsertApp(app);

    const settings = store.getSettings();
    if (settings.createShortcutOnInstall) {
      onProgress({ stage: 'shortcut', message: 'Creating desktop shortcuts…' });
      try {
        app.shortcutPath = this.createShortcut(app);
        store.upsertApp({ package: app.package, shortcutPath: app.shortcutPath });
      } catch (e) {
        onProgress({ stage: 'shortcut-warn', message: `Shortcut creation failed: ${e.message}` });
      }
    }

    // Compatibility hint: only ARM primary library, x86 running with translation layer
    const warnings = [];
    if (meta.minSdk && meta.minSdk > 34) {
      warnings.push(`This application request, Android ${meta.minSdk}+, higher than currently running, may not be running properly.`);
    }
    if (iconFallback === 'placeholder') {
      warnings.push('Applying icons cannot be parsed (possibly in a special format for self-adapted icons), the shortcuts are temporarily used as placeholders.');
    } else if (iconFallback === 'webp-decode-failed') {
      warnings.push('Applying the WebP decoding failed, the shortcut temporarily uses the placeholder icon.');
    }
    client.batteryOptimizeOff(meta.package).catch(() => {});
    // When you’re free, you save the "new application" state.,
    // Otherwise, the next time you turn on, it's gonna be cold again.
    try { this.runtime.scheduleSnapshotSave?.(12000); } catch (_) { /* ignore */ }

    onProgress({ stage: 'done', message: `${app.label} Install complete`, app });
    return { app, warnings, engine: rt.engine };
  }

  createShortcut(app) {
    const { target, baseArgs } = this.shortcutTarget();
    const args = `${baseArgs ? baseArgs + ' ' : ''}--launch "${app.package}"`.trim();
    const ico = app.icoPath && fs.existsSync(app.icoPath) ? app.icoPath : undefined;
    // Linux’s. desktop only recognizes PNG/ SVG absolute path, ICO invalid --so both paths pass on.,
    // Picked by writeShortcut on the platform.)
    const png = app.iconPath && fs.existsSync(app.iconPath) ? app.iconPath : undefined;
    const paths = this.shortcutPaths(app);

    const write = (shortcutPath) => writeShortcut({
      shortcutPath,
      target,
      args,
      iconIcoPath: ico,
      iconPngPath: png,
      description: `${app.label} — Run by Hydra Emulator`,
      cwd: this.ctx.cwd,
      // Apply an AUMID: The taskbar presses the application group and does not squeeze all into Hydra Emulator
      appUserModelId: `Hydra.Emulator.${app.package}`.slice(0, 128),
    });

    let first = null;
    let startMenuPath = null;
    const errors = [];
    paths.forEach((p, i) => {
      try {
        write(p);
        if (!first) first = p;
        if (i === 1) startMenuPath = p;
      } catch (e) {
        errors.push(`${p}: ${e.message}`);
      }
    });

    // Main path all failed (defined shortcut directory not to write / intercepted by security software)):
    // Go back to the desktop and try again -- there are icons on the desktop before the user can find the application.
    if (!first) {
      const fallback = path.join(this.ctx.desktopDir, `${safeFileName(app.label)}${shortcutExt()}`);
      try {
        write(fallback);
        first = fallback;
      } catch (e) {
        errors.push(`${fallback}: ${e.message}`);
      }
    }
    if (!first) throw new Error(errors.join('; ') || 'Could not create the shortcut');
    // The path to start the menu is also saved and deleted when unloading
    if (startMenuPath || first) {
      store.upsertApp({ package: app.package, startMenuPath });
    }
    return first;
  }

  /** Complete missing shortcuts and icons: The old version only built the desktop and the WebP icon failed at the time */
  async ensureShortcuts() {
    const made = [];
    // User explicitly shuts off "auto-create after installation" and does not want to fill this application when there is no access.,
    // Otherwise, the switch is off and it can’t be rebuilt when it starts.
    const auto = store.getSettings().createShortcutOnInstall !== false;
    for (const app of store.getApps()) {
      if (!auto && !app.shortcutPath && !app.startMenuPath) continue;
      let dirty = false;
      if ((!app.icoPath || !fs.existsSync(app.icoPath)) && app.iconPath && fs.existsSync(app.iconPath)) {
        try {
          const ico = await iconToIco(fs.readFileSync(app.iconPath), { decode: this.ctx.decodeIcon });
          if (ico) {
            const p = this.icoFile(app.package);
            fs.writeFileSync(p, ico);
            store.upsertApp({ package: app.package, icoPath: p });
            app.icoPath = p;
            dirty = true;
          }
        } catch (_) { /* icon completion failed without affecting the entrance */ }
      }
      const missing = this.shortcutPaths(app).filter((p) => !fs.existsSync(p));
      if (!missing.length && !dirty) continue;
      try {
        // When icons are filled, even if. Ink exists, they should be rebuilt so that the shortcuts can be replaced with real applications.
        const madePath = this.createShortcut(app);
        store.upsertApp({ package: app.package, shortcutPath: madePath });
        made.push(app.label);
      } catch (_) { /* Individual failure does not block startup */ }
    }
    return made;
  }

  async uninstall(pkg, { removeShortcut: rm = true } = {}) {
    const app = store.getApp(pkg);
    const rt = await this.runtime.ensure();
    if (rt.ok) await rt.client.uninstall(pkg).catch(() => {});
    if (app && rm) {
      removeShortcut(app.shortcutPath);
      removeShortcut(app.startMenuPath);
    }
    if (app) {
      try { if (app.iconPath && fs.existsSync(app.iconPath)) fs.unlinkSync(app.iconPath); } catch (_) {}
      try { if (app.icoPath && fs.existsSync(app.icoPath)) fs.unlinkSync(app.icoPath); } catch (_) {}
      try { if (app.apkPath && fs.existsSync(app.apkPath)) fs.unlinkSync(app.apkPath); } catch (_) {}
    }
    store.removeApp(pkg);
    return true;
  }

  async launch(pkg, { onLog = () => {}, beforeStart = null, onMark = () => {}, onAppUp = null } = {}) {
    const app = store.getApp(pkg);
    // Use let: beforeStart to restart the operation as a result of "dissipated panel direction and application direction".
    // returns a new rt (old client has expired with stop). This used to be a const, once it was true.
    // "Assignment to restart service." ——
    let rt = await this.runtime.ensure({ onLog });
    onMark('ensure done');
    if (!rt.ok) {
      const err = new Error(rt.error || 'Not available when running');
      err.needsSetup = rt.needsSetup;
      throw err;
    }
    // Resolution must be modified before pulling up the application to avoid wm size triggering configuration changes to re-establish a startup active
    if (beforeStart) {
      const replaced = await beforeStart(rt).catch((e) => { onLog(`Show fit to skip: ${e.message}`); return null; });
      // beforeStart returns a new rt (old clit is disabled after restarting running)),
      // We’ll use all the new ones. We’ll use the originals if we don’t return.
      if (replaced && replaced.client) rt = replaced;
    }
    // Clearing the old version may be left in /data wm size / devision overlay and auto rotation settings.
    // The coverage is permanent, and every startup will be turned 90 degrees down, leaving the dark side.,
    // Mouse clicks are also not matched (Rotting Black Edge / Unfilled / Dot Dots do not agree) by user feedback.
    await rt.client.resetDisplayOverrides(!!(store.getSettings().display || {}).landscape).catch(() => {});
    // I had a cyber checkup on the cold startup: without the Internet, it was clear. Otherwise, the user would only see "this application is always black.",
    // It's a virtual machine that doesn't even exist.
    // Critical fixes: Wi-Fi links are often dozens of seconds later than sys.boot_completed, and the red beetle goes in and pulls the header data.,
    // And the fact that the first page of the Internet is not available is a whole black bottom -- that's the real reason why the "point of consent" continues to be black.
    // So wait for the network to be ready before pulling up the application (up to 90 seconds) and rather than give the user a black screen for a few seconds.
    // Look at the network before you pull it up.: **Just wait, don't restart**.
    // This is where the network is “stops the virtual machine and cools off.“,
    // As a result, the adb device disappeared during the installation and became "the red fruit cannot be broken."
    // There’s no way to do this destructive thing on the startup path, start it before it waits, it’s not a big deal to load the page temporarily.
    if (rt.engine === 'emulator' || rt.engine === 'builtin') {
      let net = await this.runtime.waitForNetwork({ onLog, timeoutMs: 20000 }).catch(() => null);
      if (net && net.ok) {
        onLog(`Virtual network ready(${net.ip || ''})`);
      } else {
        // When you can't wait for the Internet, do it once.**Non-destructive**Remediation: "Saved but not automatically connected"
        // AndroidWifi points. It doesn’t restart the virtual machine, doesn’t touch the user data, just pulls up the setup page.
        // Point a saved hot spot, so it's safe to put it on the start-up path.
        // The vast majority of "virtual computers are not online" on the real machine is the reason.
        onLog('Virtual machine not connected to Wi-Fi, trying to reconnect…');
        try {
          // Note: repairWifi on engine (this. rantime), not on rt.
          // rt is the return object of the insure() {ok, clit, engine,}, with only clit;
          // Write rt. repair Wifi will be undefined, and the TypeError will be swallowed by catch,
          // It's called, "The log is reconnecting, but in 1 millisecond it says it's not online."
          const fixed = await this.runtime.repairWifi().catch(() => false);
          if (fixed) {
            net = await this.runtime.waitForNetwork({ onLog, timeoutMs: 15000 }).catch(() => null);
            if (net && net.ok) {
              onLog(`Virtual network restored.(${net.ip || ''})`);
              // Key: Put the state of the Internet online in the snapshot immediately.
              // If you don’t save it, the next time you start it, it’ll take a dozen seconds to reconnect.
              // Use forceSnapshotSave because it's about to start the application, and it's never gonna be free.
              try { this.runtime.forceSnapshotSave?.(3000); } catch (_) { /* It doesn't affect the start. */ }
            }
          }
        } catch (e) {
          // Do not swallow the anomaly in silence: this log is the only evidence of "showing and not running."
          onLog(`Auto Reconnect Wi-Fi Failed: ${e.message}`);
        }
        if (!net || !net.ok) {
          onLog('Virtual network is not ready to start the application. (Web page may be loaded later.))');
        }
      }
    }
    const settings = store.getSettings();
    const start = () => rt.client.startApp(app ? app.package : pkg, app ? app.activity : null, {
      freeform: settings.freeform,
      bounds: app ? app.bounds : null,
    });
    // Apply may not be installed at current runtime (rebuild/ clear data/ first time), direct up session
    // “Invalid packageName“. Load it in the local cache and start it, so that the “point-opening application“ can always enter.,
    // There’s no need to do it manually -- this is the experience that “clicking on installed applications to enter the system directly“ wants.
    // Key: isInstalled() (pm path + checking the APK file for real) instead of
    // `pm list packages`. BackageManager still reported installed=true,
    // But the / data/ app file has been rolled back -- when am start fails. If the document is not checked, reload.
    if (app && app.apkPath && fs.existsSync(app.apkPath)) {
      let installed = false;
      try { installed = await rt.client.isInstalled(pkg); } catch (_) { /* Consider it uninstalled, walk reloaded */ }
      if (!installed) {
        onLog('Applying missing files (sclips are not consistent with data), autoreloading with local backup…');
        // Reload as waste snapshot: Otherwise the old snapshots pickages.xml still says "installed," and next time it's wrong.
        try { this.runtime.emulator?.invalidateSnapshot(); } catch (_) { /* ignore */ }
        await rt.client.install(app.apkPath).catch((e) => onLog(`Auto-installation failed: ${e.message}`));
      }
    }
    // Twenty-five seconds of observation and five consecutive seconds of survival are required to be successful.
    // The process "not up" and "not up" have to be seen separately.,
    // So the large application (the first start of the red fruit takes more than 10 seconds) was rebooted for once-stop.,
    // The user senses that it's "one minute to wait."
    const staysAlive = async () => {
      const t0 = Date.now();
      let aliveSince = 0;
      let seen = false;
      while (Date.now() - t0 < 25000) {
        // The heat starts in a permanent container, and you can see the process in a second.,
        // Sleep 1 second is a second to slow down the fastest path.
        // eslint-disable-next-line no-await-in-loop
        const pid = await rt.client.shell(`pidof ${pkg}`, { timeout: 6000 }).catch(() => '');
        if (!String(pid).trim()) {
          if (seen) return false; // == sync, corrected by elderman ==
        } else {
          if (!seen && typeof onAppUp === 'function') {
            // It’s just a process that’s got to take the picture up.
            // The four seconds are waiting for “a confirmation that it won't crash immediately,“ but what users see is “no reaction at the point.“
            // First let him see the application being loaded, it's much better to see than to hide it for four seconds.
            // The answer is fire-and-forget: it fails and does not affect the survival of the post.
            try { onAppUp(); } catch (_) { /* ignore */ }
          }
          seen = true;
          if (!aliveSince) aliveSince = Date.now();
          if (Date.now() - aliveSince >= 4000) return true;
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(700);
      }
      return seen; // I've never seen the process before.
    };
    try {
      // Make sure you have access when running: -g at installation may fail after data is cleared.,
      // The application is blocked by the system's permission box when permission is not available, and the user sees "no response/no opening".
      await rt.client.grantRuntimePermissions(pkg).catch(() => {});
      onMark('permissions granted');
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
        if (attempt > 1) {
          // eslint-disable-next-line no-await-in-loop
          await rt.client.forceStop(pkg).catch(() => {});
          // When the authorization box is in the front, the application appears to be “can't open“; first the authorization is replenished and then the window is closed.
          // eslint-disable-next-line no-await-in-loop
          await rt.client.grantRuntimePermissions(pkg).catch(() => {});
          // eslint-disable-next-line no-await-in-loop
          await rt.client.dismissPermissionDialog().catch(() => {});
          // eslint-disable-next-line no-await-in-loop
          await sleep(600 * attempt);
        }
        let started = true;
        try {
          // eslint-disable-next-line no-await-in-loop
          await start();
        } catch (e) {
          // There’s a clear crash log to hand to the outer layer (possibly compatible mirrors); most of the evidence is slow to start, and just try again.
          if (e.code === 'APP_CRASHED' && e.crash) throw e;
          started = false;
        }
        onMark(`am start #${attempt} ${started ? 'ok' : 'fail'}`);
        // Activity locks it up as soon as you get up. It’s here because the application startup process itself triggers it.
        // Configure Changes (Accessity Rebuilding), the user-rotation that started before could be reset to 0 by the system ——
        // Once back to zero, the screen screen will lie down 90 degrees.
        if (started) {
          // eslint-disable-next-line no-await-in-loop
          await rt.client.setOrientation(!!(store.getSettings().display || {}).landscape).catch(() => {});
        }
        // eslint-disable-next-line no-await-in-loop
        ok = started ? await staysAlive() : false;
        onMark(`alive #${attempt} ${ok}`);
        if (!ok && attempt < 3) onLog(`Apply exit after startup ${attempt} (T times) Retrying automatically…`);
      }
      if (!ok) {
        // In the end, an abnormal exit leaves "half-initialization" data, which leads to every subsequent crash.
        // Clearing the application data and pulling it up, with the highest success rate (users don’t have to set their own caches).
        onLog('Applying continuous exit, retrying after resetting application data…');
        await rt.client.shell(`pm clear ${pkg}`, { timeout: 20000 }).catch(() => '');
        await sleep(800);
        // pm clear will clear the running hours and must be re-entitled, otherwise it will be stuck in the system authorization box.
        await rt.client.grantRuntimePermissions(pkg).catch(() => {});
        await start().catch((e) => {
          if (e.code === 'APP_CRASHED' && e.crash) throw e;
        });
        ok = await staysAlive();
        if (!ok) await rt.client.dismissPermissionDialog().catch(() => {});
      }
      if (!ok) {
        const err = new Error('Exiting immediately after application startup, automatically re-tested and reset application data still unsuccessful');
        err.code = 'APP_UNSTABLE';
        throw err;
      }
    } catch (e) {
      if (e.code === 'APP_CRASHED' && !this.runtime.provisioner.playImageInfo().ok) {
        // Collapse from ARM Translation Layer: Auto-cut mirror, heavy-equipment APK, start again
        onLog('ARM translation layer collapse detected, automatically switching compatible mirrors…');
        await this.ensureCompatImage(onLog ? (m) => onLog(m.message || '') : () => {});
        const rt2 = await this.switchToCompat((m) => onLog(m.message || ''));
        if (app && app.apkPath && fs.existsSync(app.apkPath)) {
          try { await rt2.client.install(app.apkPath); } catch (_) { /* Keep the original package */ }
        }
        await rt2.client.startApp(app ? app.package : pkg, app ? app.activity : null, {
          freeform: settings.freeform,
          bounds: app ? app.bounds : null,
        });
      } else {
        throw e;
      }
    }
    this.runtime.touch();
    if (app) {
      store.upsertApp({
        package: app.package,
        launchCount: (app.launchCount || 0) + 1,
        lastLaunchAt: Date.now(),
      });
    }
    return { ok: true, engine: rt.engine };
  }
}

module.exports = { Installer, accentOf, parseBundle };
