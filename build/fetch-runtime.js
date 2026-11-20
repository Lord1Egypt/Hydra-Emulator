'use strict';
/**
 * Build Full Version when inside running:
 *   Node build/fetch-runtie.js < Output Directory>
 * Output < Output Directory >/runtime/:
 *   emulator/ + platform-tools/ + aehd/ + system-images/android-34/google_apis_playstore/x86_64/
 * All downloads and verifications through the official channel of Provisioner are identical to the online version.
 */
const path = require('path');
const fs = require('fs');

const outRoot = path.resolve(process.argv[2] || '');
if (!outRoot) {
  console.error('usage: node build/fetch-runtime.js <output-runtime-dir>');
  process.exit(1);
}
fs.mkdirSync(outRoot, { recursive: true });

// Provisioner takes root directory from settings.runtime.dir:
// Point APPDATA to a separate directory to avoid contamination of the actual user configuration
process.env.APPDATA = path.join(outRoot, '_appdata');
const store = require('../src/core/store');
store.saveSettings({ runtime: { dir: outRoot } });

const { Provisioner } = require('../src/core/provision');
const prov = new Provisioner(path.resolve(__dirname, '..'));

const log = (p) => console.log(`[${p.stage}] ${p.message} ${p.percent != null ? p.percent + '%' : ''}`);

(async () => {
  await prov.installAehd(log);
  await prov.installAdb(log);
  await prov.installEmulator(log);
  await prov.installPlayImage(log);

  const ok =
    fs.existsSync(path.join(outRoot, 'emulator', 'emulator.exe')) &&
    fs.existsSync(path.join(outRoot, 'platform-tools', 'adb.exe')) &&
    fs.existsSync(path.join(outRoot, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'system.img'));
  if (!ok) throw new Error('Could not close temporary folder: %s');

  // Packaging streamlined: Only QEMUs of x86_64 and components necessary for headless operation are retained.
  // Non-qemu-system-*.exe (approximately 400MB), QtWebEngine, netsim e. g. -no-window is useless.
  const layers = require('../src/core/layers');
  const pruned = layers.prune(outRoot, { apply: true, aggressive: true });
  const before = layers.analyze(outRoot).total + pruned.saved;
  console.log(`slim: ${(pruned.saved / 1048576).toFixed(0)} MB removed, `
    + `${(before / 1073741824).toFixed(2)} GB -> ${(pruned.after / 1073741824).toFixed(2)} GB`);

  fs.rmSync(path.join(outRoot, '_appdata'), { recursive: true, force: true });
  fs.rmSync(path.join(outRoot, '_tmp'), { recursive: true, force: true });
  console.log('runtime-ready:', outRoot);
})().catch((e) => {
  console.error('fetch-runtime failed:', e.message);
  process.exit(1);
});
