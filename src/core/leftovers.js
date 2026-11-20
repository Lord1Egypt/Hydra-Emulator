'use strict';
/**
 * Clean up leftovers from old versions.
 *
 * Users upgrading Hydra Emulator often end up with "several versions installed, never fully uninstalled":
 * each portable version switch adds another Hydra Emulator-vX.Y.Z-win64-portable directory; an NSIS
 * installation may leave uninstall entries pointing at a deleted directory; and the update process
 * leaves a pile of temporary packages in the data directory.
 *
 * Here we only do cleanup that is **provably safe**:
 *   - Only old version directories that actually contain "Hydra Emulator.exe", and never the one currently running;
 *   - Only registry uninstall entries whose InstallLocation no longer exists (they were already dead entries);
 *   - Only temporary files in our own update cache and Start Menu/desktop shortcuts pointing at non-existent targets.
 * If anything is uncertain, skip it and report the reason honestly to the UI.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const EXE = 'Hydra Emulator.exe';

function dirSize(p) {
  let n = 0;
  const walk = (d) => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of list) {
      const f = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(f);
        else n += fs.statSync(f).size;
      } catch (_) { /* in use / no permission, skip */ }
    }
  };
  walk(p);
  return n;
}

function norm(p) {
  try { return path.resolve(p).toLowerCase(); } catch (_) { return String(p).toLowerCase(); }
}

/**
 * Find old version directories in several "places where the program might live".
 *
 * Previously it only scanned the current exe's parent directory + LOCALAPPDATA\Programs + ProgramFiles,
 * so if the user extracted the portable build elsewhere (E:\Downloads, the desktop, some project folder)
 * it was never found — that was exactly why "old versions in other folders cannot be cleaned up". Now
 * discovery is multi-pronged:
 *   - common install locations;
 *   - the shallow level under each disk root (many portable builds are dropped straight into D:\Hydra Emulator-…);
 *   - the real exe directory pointed to by existing desktop / Start Menu shortcuts (most accurate: if the user ever installed it, one exists).
 */
function candidateRoots(installDir) {
  const roots = new Set();
  const add = (p) => { if (p) roots.add(p); };
  add(path.dirname(installDir));
  const local = process.env.LOCALAPPDATA;
  if (local) add(path.join(local, 'Programs'));
  add(process.env.ProgramFiles);
  add(process.env['ProgramFiles(x86)']);
  // A few high-frequency locations under the user's home directory
  const home = os.homedir();
  if (home) {
    add(path.join(home, 'Downloads'));
    add(path.join(home, 'Desktop'));
    add(path.join(home, 'Documents'));
  }
  // Every local disk root (portable builds are often placed directly at the drive root)
  try {
    for (const drv of ['C:\\', 'D:\\', 'E:\\', 'F:\\', 'G:\\', 'H:\\']) {
      if (fs.existsSync(drv)) add(drv.replace(/\\+$/, ''));
    }
  } catch (_) { /* ignore */ }
  return [...roots];
}

/**
 * Resolve the real directory of Hydra Emulator.exe from shortcuts (.lnk / .desktop).
 * This is the most reliable discovery method: as long as the user once created a desktop icon or
 * Start Menu entry, the target path is in there, no matter which drive or deep folder it lives in.
 */
function rootsFromShortcuts() {
  const dirs = new Set();
  const homes = [os.homedir(), process.env.APPDATA, process.env.LOCALAPPDATA]
    .filter(Boolean);
  const linkDirs = [];
  for (const h of homes) {
    linkDirs.push(path.join(h, 'Desktop'));
    linkDirs.push(path.join(h, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
    linkDirs.push(path.join(h, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Hydra Emulator'));
  }
  for (const d of linkDirs) {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of list) {
      if (!/\.(lnk|desktop)$/i.test(e.name)) continue;
      const full = path.join(d, e.name);
      try {
        if (/\.desktop$/i.test(e.name)) {
          const txt = fs.readFileSync(full, 'utf8');
          const m = /^Exec=(.+)$/m.exec(txt);
          if (m) {
            const exePath = m[1].trim().replace(/^"|"$/g, '').split(/\s+/)[0];
            if (exePath && /[\\/]Hydra Emulator(\.exe)?$/i.test(exePath)) dirs.add(path.dirname(exePath));
          }
        } else {
          // .lnk is binary, but the target path is embedded in readable form; scan the bytes for Hydra Emulator*.exe
          const buf = fs.readFileSync(full);
          const s = buf.toString('latin1');
          const re = /[A-Za-z]:\\[^\x00\x01-\x1f]*?Hydra Emulator(?:-[^\x00\x01-\x1f]*)?[\\/]?Hydra Emulator\.exe|[A-Za-z]:\\[^\x00\x01-\x1f]*?Hydra Emulator\.exe/gi;
          let mm;
          while ((mm = re.exec(s))) {
            dirs.add(path.dirname(mm[0].replace(/\x00.*$/, '')));
          }
        }
      } catch (_) { /* skip if it cannot be read */ }
    }
  }
  return [...dirs];
}

/** Old version program directory: named Hydra Emulator*, containing Hydra Emulator.exe, and not the current install directory */
function scanDirs(installDir) {
  const out = [];
  const seen = new Set();
  const cur = norm(installDir);
  const consider = (full) => {
    const key = norm(full);
    if (seen.has(key)) return;
    seen.add(key);
    if (key === cur) return;
    // It must be a directory that really is "Hydra Emulator", to avoid deleting a same-named folder by mistake
    if (!fs.existsSync(path.join(full, EXE))) return;
    out.push({
      kind: 'dir',
      path: full,
      size: dirSize(full),
      note: 'Old version program directory (contains ' + EXE + ')',
    });
  };
  for (const root of candidateRoots(installDir)) {
    let list = [];
    try { list = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of list) {
      if (!e.isDirectory()) continue;
      if (!/^Hydra Emulator/i.test(e.name)) continue;
      consider(path.join(root, e.name));
    }
  }
  // Directories found via shortcuts: may themselves be old version directories, or their parent/sibling may be
  for (const d of rootsFromShortcuts()) {
    if (/^Hydra Emulator/i.test(path.basename(d))) consider(d);
    // Also look at siblings (several version directories often sit side by side under dist)
    const parent = path.dirname(d);
    let sib = [];
    try { sib = fs.readdirSync(parent, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of sib) {
      if (e.isDirectory() && /^Hydra Emulator/i.test(e.name)) consider(path.join(parent, e.name));
    }
  }
  return out;
}

/** Registry uninstall entries pointing at directories that no longer exist */
function scanRegistry() {
  const out = [];
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const root of roots) {
    let text = '';
    try {
      text = execFileSync('reg', ['query', root, '/s', '/f', 'Hydra Emulator', '/t', 'REG_SZ'],
        { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    } catch (_) { continue; }
    // reg query output is chunked "key → values"; split by chunk here
    const blocks = String(text).split(/\r?\n\r?\n/);
    for (const b of blocks) {
      const key = (/^(HKEY_[^\r\n]+)$/m.exec(b) || [])[1];
      if (!key) continue;
      if (!/\\Hydra Emulator/i.test(key)) continue;
      const loc = (/InstallLocation\s+REG_\w+\s+(.+)/i.exec(b) || [])[1];
      const disp = (/DisplayName\s+REG_\w+\s+(.+)/i.exec(b) || [])[1];
      const unins = (/UninstallString\s+REG_\w+\s+(.+)/i.exec(b) || [])[1];
      const install = (loc || '').trim().replace(/^"|"$/g, '');
      const uninsPath = (unins || '').trim().replace(/^"|"$/g, '');
      const installMissing = install ? !fs.existsSync(install) : false;
      // Only handle dead entries that are "clearly no longer installed but still listed in the apps list"
      const deadUninstaller = uninsPath && !fs.existsSync(uninsPath.split('"')[0]);
      if (!installMissing && !deadUninstaller) continue;
      out.push({
        kind: 'registry',
        path: key,
        size: 0,
        note: `Broken uninstall entry${disp ? `: ${String(disp).trim()}` : ''}`,
      });
    }
  }
  return out;
}

/** Update cache / temporary packages */
function scanTemp(dataDir) {
  const out = [];
  const dirs = [path.join(dataDir, 'update'), os.tmpdir()];
  for (const d of dirs) {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of list) {
      const name = e.name;
      const isOurs = /^Hydra Emulator.*\.(zip|exe|part\d*|tmp)$/i.test(name)
        || /^Hydra Emulator-.*\.part\d+$/i.test(name);
      if (!isOurs) continue;
      const full = path.join(d, name);
      let size = 0;
      try { size = e.isDirectory() ? dirSize(full) : fs.statSync(full).size; } catch (_) { /* ignore */ }
      out.push({ kind: 'temp', path: full, size, note: 'Temporary file from an update download' });
    }
  }
  return out;
}

/** Old/obsolete quick boot snapshots: default_boot is left over from early versions (one ram.img is ~3GB),
 *  *.stale-* are residues from "rename instead of delete". The current snapshot is named hydra; never touch it. */
function scanSnapshots(avdHome) {
  const out = [];
  if (!avdHome) return out;
  const snapDir = path.join(avdHome, 'hydra.avd', 'snapshots');
  let list = [];
  try { list = fs.readdirSync(snapDir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of list) {
    if (!e.isDirectory()) continue;
    if (e.name === 'hydra') continue;   // snapshot currently in use
    const full = path.join(snapDir, e.name);
    out.push({
      kind: 'dir',
      path: full,
      size: dirSize(full),
      note: e.name.startsWith('default_boot') ? 'Quick boot snapshot left over from an old version' : 'Obsolete snapshot residue',
    });
  }
  return out;
}

function scan({ installDir, dataDir, avdHome }) {
  const items = [];
  const push = (list) => { for (const x of list) items.push(x); };
  push(scanDirs(installDir));
  push(scanRegistry());
  push(scanTemp(dataDir));
  push(scanSnapshots(avdHome));
  const total = items.reduce((n, x) => n + (x.size || 0), 0);
  return { items, totalBytes: total };
}

function rm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch (_) { return false; }
}

function clean(items, { installDir }) {
  const cur = norm(installDir);
  let freed = 0;
  const removed = [];
  const failed = [];
  for (const it of items || []) {
    try {
      if (it.kind === 'dir') {
        // Double protection: never delete the directory currently running
        if (norm(it.path) === cur) { failed.push({ path: it.path, reason: 'This is the currently running version' }); continue; }
        if (!fs.existsSync(path.join(it.path, EXE))) { failed.push({ path: it.path, reason: 'Directory does not contain ' + EXE }); continue; }
        if (rm(it.path)) { freed += it.size || 0; removed.push(it.path); }
        else failed.push({ path: it.path, reason: 'Files are in use (a window may still be open)' });
      } else if (it.kind === 'registry') {
        const r = execFileSync('reg', ['delete', it.path, '/f'], { windowsHide: true, timeout: 10000 });
        void r;
        removed.push(it.path);
      } else if (it.kind === 'temp') {
        if (rm(it.path)) { freed += it.size || 0; removed.push(it.path); }
        else failed.push({ path: it.path, reason: 'File is in use' });
      } else if (it.kind === 'shortcut') {
        if (rm(it.path)) removed.push(it.path);
        else failed.push({ path: it.path, reason: 'Delete failed' });
      }
    } catch (e) {
      failed.push({ path: it.path, reason: e.message });
    }
  }
  return { removed, failed, freedBytes: freed };
}

module.exports = { scan, clean };
