'use strict';
/**
 * Generate incremental update asset: a list + a code layer zip.
 *
 * Portable 99MB, with a large head of Element (exe / dll / locales), only upgrades to Electric
 * The real change in each release is the JS/ Resource/ node_modules.
 * Sets the app layer as a small package here, and lists the sha256 for each file, the client’s home page.
 * When the version is consistent, only these two little files are available, and the upgrade can be completed by overlaying the resources/app.
 *
 * Product (write to --out directory, default current directory)):
 *   Hydra Emulator-v-V-V-V-V-Manifest.json
 *   Hydra Emulator-v <version>-app.zip
 *
 * Usage: nonee build/incorporate.js < Portable Directory > <tag> [--out of the directory.]
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { sha256File } = require('../src/core/download');
const { find7z } = require('./zip');

const ROOT = path.dirname(__dirname);

/** The Elementron version used for this build: The client uses it to determine if it can only change the code layer. */
function electronVersion(root = ROOT) {
  const candidates = [
    path.join(root, 'node_modules', 'electron', 'package.json'),
    path.join(root, 'package.json'),
  ];
  for (const p of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j.name === 'electron' && j.version) return String(j.version);
    } catch (_) { /* Next. */ }
  }
  try {
    const ep = path.join(root, 'package.json');
    const dev = (JSON.parse(fs.readFileSync(ep, 'utf8')).devDependencies || {}).electron;
    if (dev) return String(dev).replace(/^[^\d]*/, '');
  } catch (_) { /* ignore */ }
  return '';
}

/** Recursively list the relative path of all files under the directory (slash)) */
function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(abs, base));
    else if (e.isFile()) out.push(path.relative(base, abs).replace(/\\/g, '/'));
  }
  return out;
}

function zipApp(exe, srcDir, outZip, rootDir) {
  // cwd set as portable root directory, leaving the inside path with prefixes/app/...
  const r = spawnSync(exe, ['a', '-tzip', '-mm=Deflate', '-mx=9', '-bso0', '-bsp0', '-y', outZip, 'resources\\app'], {
    cwd: rootDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  if (r.status !== 0) {
    throw new Error(`Scrap compression failed(${r.status}): ${String(r.stderr || r.stdout || '').slice(0, 400)}`);
  }
  if (!fs.existsSync(srcDir)) throw new Error(`Could not find a layer directory: ${srcDir}`);
}

async function build(portableDir, tag, outDir = process.cwd()) {
  const portable = path.resolve(portableDir);
  const appDir = path.join(portable, 'resources', 'app');
  if (!fs.existsSync(path.join(portable, 'Hydra Emulator.exe'))) throw new Error('Missing Portable Directory Hydra Emulator.exe');
  if (!fs.existsSync(path.join(appDir, 'package.json'))) throw new Error('Portable directory missing');

  const version = String(tag || '').replace(/^v/i, '');
  if (!version) throw new Error('Missing version number / tag');

  fs.mkdirSync(outDir, { recursive: true });
  const appName = `Hydra-Emulator-v${version}-app.zip`;
  const manifestName = `Hydra-Emulator-v${version}-manifest.json`;
  const appZip = path.join(outDir, appName);
  const manifestPath = path.join(outDir, manifestName);

  fs.rmSync(appZip, { force: true });
  const exe = find7z();
  if (!exe) throw new Error('7-Zip not found, unable to generate a code package (CI \'s window-latest self-band))');
  zipApp(exe, appDir, appZip, portable);

  const files = {};
  const rels = walk(appDir).sort();
  for (const rel of rels) {
    const abs = path.join(appDir, ...rel.split('/'));
    files[`resources/app/${rel}`] = {
      size: fs.statSync(abs).size,
      sha256: await sha256File(abs),
    };
  }
  const packHash = await sha256File(appZip);
  const manifest = {
    schema: 1,
    version,
    tag: tag.startsWith('v') ? tag : `v${tag}`,
    electronVersion: electronVersion(ROOT),
    generatedAt: new Date().toISOString(),
    app: {
      asset: appName,
      sha256: packHash,
      size: fs.statSync(appZip).size,
      files,
    },
    full: { asset: `Hydra-Emulator-v${version}-win64-portable.zip` },
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(`List: ${manifestPath}`);
  console.log(`Package: ${appZip}(${(fs.statSync(appZip).size / 1024 / 1024).toFixed(2)} MB, ${rels.length} File)`);
  console.log(`Electron: ${manifest.electronVersion || '(Unknown)'}`);
  return { manifestPath, appZip, manifest };
}

if (require.main === module) {
  const dir = process.argv[2];
  const tag = process.argv[3];
  const oi = process.argv.indexOf('--out');
  const out = oi > 0 ? process.argv[oi + 1] : process.cwd();
  if (!dir || !tag) {
    console.error('Usage: nonee build/incorporate.js < Portable Directory > <tag> [--out of the directory.]');
    process.exit(1);
  }
  build(dir, tag, out).catch((e) => { console.error('Failed to generate incremental assets: ', e.message); process.exit(1); });
}

module.exports = { build, electronVersion, walk };
