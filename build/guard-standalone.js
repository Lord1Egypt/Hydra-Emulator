'use strict';
/**
 * Stand-alone guard: install the bag.**Not allowed**Any files with third-party simulators.
 *
 * Why do you need to build the period together?:
 *   Hydra Emulator's installation package (NSIS / Portable / / MSIX) must be open-and-in-box - bring self emular +
 *   Platform-tools+ system mirrors, run after loading, do not require users to install Mumu/ Thunder/ Blue Collapse.
 *   0.5.6 Further: **There's no third-party base in the code.**, The installation is not "Small Run + Selectable",
 *   It’s "only running on its own." So it’s not just binary, it’s also the appliance code of the third-party base.
 *   (Backs/mumu.js/ backs/fydeos.js/ mumu-compat.js) - once someone brings them back,
 *   The construction failed directly, avoiding "a path left in the code that would take over the simulator."
 *
 *   This restraint can be easily compromised: for example, one time, a Mumu directory was handcuffed to build/runtime when running.,
 *   Or you can put a simulator catalogue locally in the resources and then pack it.,
 *   The user has "install another simulator" -- the problem is exposed only on other people’s computers.
 *   So, after cleaning the file name before packing, the hit makes the building fail.
 */

const fs = require('fs');
const path = require('path');

/**
 * Once these names appear in the package, it means "other people's simulators" are plugged in.
 * Only matches each emulator's own feature filename, without broad /android/ or something, to avoid misreporting.
 */
const BANNED = [
  { re: /^mumu/i, vendor: 'Mumu emulator' },          // MuMuManager.exe / MuMuPlayer.exe / MuMuVMMVbox
  { re: /\.nemu$/i, vendor: 'Mumu emulator' },        // Example Description File MuMuPlayer-12.0-0.nemu
  { re: /^nemu$/i, vendor: 'Mumu emulator' },         // Nemu directory for Mumu
  { re: /^nx_main$/i, vendor: 'Mumu emulator' },      // Nx_main / nx_device directory for Mumu
  { re: /^nx_device$/i, vendor: 'Mumu emulator' },
  { re: /^ldplayer/i, vendor: 'Thunder Simulator' },
  { re: /^dnplayer/i, vendor: 'Thunder Simulator' },
  { re: /^bluestacks/i, vendor: 'Blue Collapse Simulator' },
  { re: /^hd-player/i, vendor: 'Blue Collapse Simulator' },
  { re: /^mgalaxy/i, vendor: 'Memu Emulator' },
];

/** Only these extensions are "simulator body" ; .js/.md/.json, these are source and configurations, not in interceptive range. */
const BINARY_EXT = /\.(exe|dll|sys|nemu|vdi|vmdk|vbox|iso|msi|bin|dat|db|img)$/i;

/**
 * Recursive search for hit files/dirs.
 * @param{string} dir root directory to scan (usually packaged resources/runtime or app directory))
 * @param{object} [opts] {litit} Stops as many hits as possible (default 20, enough to give a hint))
 * @returns {Array<{path: string, name: string, vendor: string}>}
 */
function findBundled(dir, { limit = 20 } = {}) {
  const hits = [];
  const walk = (d) => {
    if (hits.length >= limit) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (_) {
      return; // No permissions / does not exist: Consider nothing
    }
    for (const e of entries) {
      if (hits.length >= limit) return;
      const hit = BANNED.find((b) => b.re.test(e.name));
      // directory directly; files must be binary (or they will misjudge the MUMU body from the source code))
      if (hit && (e.isDirectory() || BINARY_EXT.test(e.name))) {
        hits.push({ path: path.join(d, e.name), name: e.name, vendor: hit.vendor });
        continue; // If you don't get a hit list, you're not going to be able to drill it.
      }
      if (e.isDirectory()) walk(path.join(d, e.name));
    }
  };
  walk(dir);
  return hits;
}

/**
 * The third-party base adaptor source code.
 * These are... js, not in BINARY_EXT, so stand alone.
 */
const BANNED_SOURCE = [
  { re: /^mumu\.js$/i, what: 'Mumu Bases adaptor' },
  { re: /^fydeos\.js$/i, what: 'FydeOS Bases adapter' },
  { re: /^mumu-compat\.js$/i, what: 'Mumu Compatibility Policy' },
  { re: /^frame\.js$/i, what: 'Mumu Frame checkup' },
];

/**
 * Find the third-party base code in the package.
 * Only "backends/xx.js" or those filenames directly under src/ core to avoid other injuries.
 * @param {string} dir
 * @returns {Array<{path: string, name: string, vendor: string}>}
 */
function findForbiddenSource(dir) {
  const hits = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (_) {
      return;
    }
    const dirName = path.basename(d);
    for (const e of entries) {
      if (e.isDirectory()) { walk(path.join(d, e.name)); continue; }
      const hit = BANNED_SOURCE.find((b) => b.re.test(e.name));
      if (!hit) continue;
      // Only these clear drop points: backends/ mumu|Fydeos, core/ mamu-compat/ frame.
      // The same name files (e.g., the coatings) are not stopped, and they avoid injury.
      const suspicious = dirName === 'backends' || (dirName === 'core' && !/^builtin\.js$/i.test(e.name));
      if (suspicious) hits.push({ path: path.join(d, e.name), name: e.name, vendor: hit.what });
    }
  };
  walk(dir);
  return hits;
}

/**
 * Accusating that there’s no third-party simulator in the directory.
 * @param {string} dir
 * @param{object} [opts] {label, exit} label for tips; exit=false only returns the result without killing the process
 * @returns {{ok: boolean, skipped?: boolean, hits: Array}}
 */
function assertStandalone(dir, { label = 'Pack the product.', exit = true } = {}) {
  if (!dir || !fs.existsSync(dir)) return { ok: true, skipped: true, hits: [] };
  const hits = findBundled(dir).concat(findForbiddenSource(dir));
  if (!hits.length) return { ok: true, hits: [] };

  const vendors = [...new Set(hits.map((h) => h.vendor))].join(' / ');
  console.error(`\n[ Guards.] ${label} It's mixed into the third-party simulator.(${vendors}): `);
  for (const h of hits) console.error(`  - ${h.path}`);
  console.error('');
  console.error('Hydra Emulator\'s installation package must run on its own and run independently: cannot depend on, cannot bind another simulator, ');
  console.error('Nor is it allowed to bring back the appliance code of the “take over someone else’s emulator.“');
  console.error('Please delete these paths from the packing directory and try again.\n');
  if (exit) process.exit(4);
  return { ok: false, hits };
}

module.exports = { BANNED, BANNED_SOURCE, findBundled, findForbiddenSource, assertStandalone };
