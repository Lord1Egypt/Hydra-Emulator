'use strict';
/**
 * Portable packages: output dist/ydra Emulator-win64-portable/
 *   Hydra Emulator.exe (electron.exe rename + Write Icon/ Version Resource) + Resources/app (this application source))
 * No need to install a device, unpressure it.
 *
 * --full output (or HYDRA_PANK_FULL=1):
 *   Extra copy of build/runtime into resources/runtime, decompress as you want, first start without downloading anything.
 *   The output directory defaults dot/ydra Emulator-v<version>-win64-full, does not overwrite the light version.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { assertStandalone } = require('./guard-standalone');

const ROOT = path.join(__dirname, '..');
const PKG = require(path.join(ROOT, 'package.json'));
const FULL = process.argv.includes('--full') || process.env.HYDRA_PACK_FULL === '1';
// Allows the specified output directory to be constructed elsewhere before being replaced when the destination directory is occupied by an active case)
let OUT = process.env.HYDRA_PACK_OUT
  ? path.resolve(process.env.HYDRA_PACK_OUT)
  : path.join(ROOT, 'dist', FULL ? `Hydra Emulator-v${PKG.version}-win64-full` : 'Hydra Emulator-win64-portable');
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');

// The directory tree of Windows that reproduces the "Small of Small Files + Large Mirrors" will have occasional hair.
// EINPROGRESS (Node wrongly reported "not enough space on the disk", with hundreds of Gs remaining.
// Change to a simple file-by-document copyfileSync: Slow down, but each file is separate syscalll,
// It’s not interrupted by a catalog of trees, nor is it hanging under the tube shell like Robocopy.
function copy(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copy(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

console.log(FULL ? 'Pack the complete version (including when running))→' : 'Portable packaged →', OUT);
// The target is not removed from the tree when it exists: some environments intercept batch removal and the middle of the packing failure is lost.
// Replace the last available version with the old directory to be renamed first, and then completely new; the directory to be automatically changed in occupied.
if (fs.existsSync(OUT)) {
  try {
    const backup = `${OUT}.prev-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(OUT, backup);
    console.log('Old version retained →', backup);
  } catch (_) {
    // Some environments (soft / search index / resource manager) hold directory handles for long periods of time,
    // The whole catalogue has to be changed to EBUSY; then back to the directory with the version number, the product is as available and no longer renameable.
    OUT = path.join(ROOT, 'dist', `Hydra Emulator-v${require(path.join(ROOT, 'package.json')).version}-win64-portable`);
    console.log('Old directory is occupied, re-exported to →', OUT);
  }
}
fs.mkdirSync(path.join(OUT, 'resources', 'app'), { recursive: true });

// 1. Electric runtime
console.log('Copy Elementron when running…');
copy(ELECTRON_DIST, OUT);
fs.rmSync(path.join(OUT, 'resources', 'default_app.asar'), { force: true });

// 1.1 Language bag: Electron carries 55 languages, total 41MB, we only use Chinese interfaces.
//     Only zh-CN / zh-TW / en-US, delete the rest (-39MB, 15% small package).
const KEEP_LOCALES = new Set(['en-US.pak']);
let localeSaved = 0;
try {
  const locDir = path.join(OUT, 'locales');
  for (const f of fs.readdirSync(locDir)) {
    if (KEEP_LOCALES.has(f)) continue;
    localeSaved += (() => { try { return fs.statSync(path.join(locDir, f)).size; } catch (_) { return 0; } })();
    fs.rmSync(path.join(locDir, f), { force: true });
  }
} catch (_) { /* No, locales, and the directories don't matter. */ }

// 1.2 No one will light files: Update logs, debugger symbols, partially useless paks (0.1~9MB each))
for (const rel of ['LICENSES.chromium.html.bak', 'vk_swiftshader_icd.json.bak']) {
  fs.rmSync(path.join(OUT, rel), { force: true });
}

// 1.3 Saved Operating Banks:
//     d3dcompiler_47.dll compiles the HISL for ANGLE into GPU commands, but Windows 8.1
//     System 32 has its own name DLL, LoadLibrary, and it’s a natural system that’s not in the bag.
//     Measured after deletion of interface/ icon/ font rendering fully normal (-smoke screen contrast no difference). Pressure tight 2.1MB.
//     Note: vk_swiftshader.dll / vulkan-1.dll cannot be deleted - Chromium when the GPU driver is not available
//     It’s a software tool, and it’s a white screen.
let pruneSaved = 0;
for (const rel of ['d3dcompiler_47.dll']) {
  const p = path.join(OUT, rel);
  try {
    pruneSaved += fs.statSync(p).size;
    fs.rmSync(p, { force: true });
  } catch (_) { /* Not at all. */ }
}

// Application body
console.log('Copy Application…');
const appDir = path.join(OUT, 'resources', 'app');
for (const item of ['package.json', 'src', 'LICENSE']) {
  const src = path.join(ROOT, item);
  if (fs.existsSync(src)) copy(src, path.join(appDir, item));
}

// 2.1 Production dependence (original module): It is not enough to copy src/ -- npm dependency on running has to be carried.
// Typical victim: @napi-rs/lzma depressurizing system.img.xxz / vendor.img.xxz,
// It’s in package.json’s dependencies, and the old version doesn’t copy node_modules.
// The result is "Putting Point Application In No Response": the mirror is rolled out with Cannot find picture '@napi-rs/lzma',
// And that’s how all four parameters are combined with a lethal return of 0.5.9.
// The role area package (@scope/name) is copied with the whole shop because it is originally binary
// Usually hangs under the same scope as an optional Dependency (e. g. @napi-rs/lzma-win32-x64-msvc).
const prodDeps = Object.keys((require(path.join(ROOT, 'package.json')).dependencies) || {});
if (prodDeps.length) {
  console.log(`Reproduction production dependence(${prodDeps.length}): ${prodDeps.join(', ')}`);
  const destModules = path.join(appDir, 'node_modules');
  for (const dep of prodDeps) {
    if (dep.startsWith('@')) {
      const scope = dep.split('/')[0];
      const scopeSrc = path.join(ROOT, 'node_modules', scope);
      if (fs.existsSync(scopeSrc)) copy(scopeSrc, path.join(destModules, scope));
    } else {
      const depSrc = path.join(ROOT, 'node_modules', dep);
      if (fs.existsSync(depSrc)) copy(depSrc, path.join(destModules, dep));
    }
  }
}

// 3. Optional catalogues
// engine/ Only document class contents are distributed with packages; components (emulator, system-images) when largely running,
// Platform-tools, avd) downloads automatically from official sources on first start of application, not into installation packages.
// It’s a self-checking script for the development period (black window live, speed), which the user cannot use, and no longer distributes with the package.
const ENGINE_SKIP = new Set(['emulator', 'system-images', 'platform-tools', 'avd', 'aehd', '_dl', 'qemu']);
for (const opt of ['engine']) {
  const src = path.join(ROOT, opt);
  if (!fs.existsSync(src)) continue;
  const dest = path.join(appDir, opt);
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (opt === 'engine' && ENGINE_SKIP.has(entry.name)) continue;
    copy(path.join(src, entry.name), path.join(dest, entry.name));
  }
}

// 3.5 Full version: Put in the running hours (Emulator + Platform-tools + System Mirrors)
if (FULL) {
  const runtime = path.join(ROOT, 'build', 'runtime');
  const runtimeExe = path.join(runtime, 'emulator', 'emulator.exe');
  if (!fs.existsSync(runtimeExe)) {
    console.error('\n[_ [Unable to find _ _]');
    console.error('    When running node build/prepare-runtime.js (npm runrun runtime) and then type the full version.\n');
    process.exit(1);
  }
  console.log('Built run time (approximately 1 GB, takes a while))…');
  // Waste that may be left behind in the running directory: userrdata.img.broken (from last failed startup)),
  // *.part (dismantling), *.new (temporary documents under stress). These are both large and useless.,
  // And even bring a bad mirror into the distribution package -- skip directly, don't copy it.
  // Check the .img.xxz complete before packing: Interrupted xz does not blow until half the pressure is decompressed.
  // ("failed to fill whole buffer," and the user was already running the software -- that was the way it was.
  // "Atttached but unwieldy application." 0.5.9 is a cut-off stem.img.xxz pit.
  // (495 MB excrete only 1366MB/ should 2958MB. xz must have root at the end of the current,
  // At the end of the eight bytes, you can find "YZ"; if you can't find it, it's not finished.
  const walkXz = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walkXz(p); continue; }
      if (!/\.img\.xz$/i.test(e.name)) continue;
      const size = fs.statSync(p).size;
      const fd = fs.openSync(p, 'r');
      let tail;
      try {
        const n = Math.min(8, size);
        tail = Buffer.alloc(n);
        fs.readSync(fd, tail, 0, n, size - n);
      } finally { fs.closeSync(fd); }
      if (!tail.includes(Buffer.from('YZ'))) {
        console.error(`\n[The mirror is incomplete (lack of xz footer, most of which downloads are cut off).): ${p}`);
        console.error(`     Size ${(size / 1048576).toFixed(1)} MB. Please retrace the mirror and pack it.\n`);
        process.exit(1);
      }
    }
  };
  walkXz(runtime);
  // Note that . pynew is a python version of the pressure temporary file, which must be excluded as much as . new.
  const JUNK = /(\.broken|\.part|\.new|\.pynew|\.tmp|\.bak)$/i;
  const copyRuntime = (src, dest) => {
    const st = fs.statSync(src);
    if (st.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      for (const entry of fs.readdirSync(src)) {
        if (JUNK.test(entry)) continue;
        copyRuntime(path.join(src, entry), path.join(dest, entry));
      }
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  };
  copyRuntime(runtime, path.join(OUT, 'resources', 'runtime'));
}

// 3.6 Independent operation guards: No third-party simulators such as Mumu/ Thunderbolt/ Blue Collapse are allowed to appear in the product.
// And it’s just that it makes the building fail -- it’s a problem that’s only exposed on "other people’s computers," and it’s never gonna happen locally.
assertStandalone(path.join(OUT, 'resources'), { label: 'Portable' });

// 4. Change of name master procedure
const exePath = path.join(OUT, 'Hydra Emulator.exe');
fs.renameSync(path.join(OUT, 'electron.exe'), exePath);

/**
 * Write icons and version resources to Hydra Emulator.exe.
 *
 * Why do you have to do this? ——
 * FileDescription=Electron, ProductName=Electron, CompanyName=GitHub, Inc.,
 * Version 33.4.11, icon is also from Electric. So resource manager, taskbar fixed item,
 * Shortcut Properties, displaying the whole "Electron" and the default icon in the Soft/System Info,
 * Users see "The icon is by default".
 *
 * rcedit is the same tool used by electron-Builder/ electron-winstaller,
 * It’s the spot in node_modules, no need to network.
 */
function embedExeMeta(exe) {
  const rcedit = [
    path.join(ROOT, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe'),
    path.join(ROOT, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe'),
  ].find((p) => fs.existsSync(p));
  if (!rcedit) {
    console.warn('Could not find rcedit.exe. The executable will use Electron metadata.');
    return false;
  }
  const ico = path.join(ROOT, 'src', 'ui', 'assets', 'appicon.ico');
  if (!fs.existsSync(ico)) {
    console.warn(`  [I can't find it. ${ico}, Skip icon writing`);
    return false;
  }
  const args = [
    exe,
    '--set-icon', ico,
    // Four-part version of the file (same calibre as MSIX) and three-part version of the product
    '--set-file-version', `${PKG.version}.0`,
    '--set-product-version', PKG.version,
    '--set-version-string', 'ProductName', 'Hydra Emulator',
    '--set-version-string', 'FileDescription', 'Hydra Emulator for Windows',
    '--set-version-string', 'CompanyName', PKG.author || PKG.productName,
    '--set-version-string', 'LegalCopyright', 'Copyright (c) 2026 Hydra Emulator',
    '--set-version-string', 'OriginalFilename', 'Hydra Emulator.exe',
    '--set-version-string', 'InternalName', 'Hydra Emulator',
  ];
  try {
    execFileSync(rcedit, args, { stdio: 'pipe', windowsHide: true });
    console.log(`  exe icon/version written(${PKG.version}, FileDescription=Hydra Emulator for Windows)`);
    return true;
  } catch (e) {
    console.warn(`  [_Other Organiser: ${e.message}`);
    return false;
  }
}
embedExeMeta(exePath);

// Version Information
const pkg = PKG;
const fullNote = FULL ? 'Full version (inline run, unconnected after loading))' : 'Lighter version (when first download starts running))';
fs.writeFileSync(path.join(OUT, 'VERSION.txt'),
  `Hydra Emulator ${pkg.version}\n${fullNote}\n Build Time: ${new Date().toLocaleString('zh-CN')}\n`);

// 6. Volume report: Every pack is printed, and avoids becoming fatter again.
function dirSize(dir) {
  let n = 0;
  try {
    for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, it.name);
      n += it.isDirectory() ? dirSize(p) : fs.statSync(p).size;
    }
  } catch (_) { /* ignore */ }
  return n;
}
const totalMB = dirSize(OUT) / 1048576;
console.log(
  `Done. Whole package. ${totalMB.toFixed(0)} MB. ${(localeSaved / 1048576).toFixed(0)} MB, `
  + `Redundant running of the library has been saved. ${(pruneSaved / 1048576).toFixed(1)} MB).`,
);
console.log('Compression: nonee build/zip.js ' + path.relative(ROOT, OUT) + ' <output.zip>');
console.log(`Run ${path.join(OUT, 'Hydra Emulator.exe')} It’s ready for use.`);
if (!FULL) console.log('Wants a full version of "One Download, Unconnected": node build/pack.js-full');
