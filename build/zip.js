'use strict';
/**
 * #Windows Zip #
 *
 * Why don't you use PowerShell? `Compress-Archive`:
 * It’s gone. NET’s self-carried deflate (equivalent to zlib 6), and the same 225 MB directory is pressed out by
 * 105,213,775 bytes;deflate of 7-Zip(`-mx=9`) Just 99,616,541 bytes -- 5.6 MB.
 * The maximum number of release mirrors distribution attachments is 100MB (actually 104,800,000 byte energy uploads successfully),
 * 105, 213,775 were torn apart into part 1/part 2 so the user could not unplug it.,
 * The result is, "Doesn’t have a home-grown user that can unpressure it, or has to have two."
 *
 * So it’s fixed with 7-Zip pressure; 7-Zip not found to return to Compress-Arcive (and a loud tip).
 *
 * Usage:
 *   Node build/zip.js < Source Directory > < Output.zip> [-Limit-mb 100]]
 * Exit code: 0 / 1 failed / 2 exceeded the size cap (cI pressing failed), and do not send a secret subpack)
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MIB = 1024 * 1024;

/** Find 7-Zip independent executables (7z.exe or 7za.exe) in common locations) */
function find7z() {
  const explicit = process.env.HYDRA_7Z;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const direct = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    path.join(__dirname, '..', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'),
  ];
  for (const p of direct) if (fs.existsSync(p)) return p;

  // PATH viewers-latest self-port 7-Zip and on PATH)
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const exe of ['7z.exe', '7za.exe']) {
      const p = path.join(dir, exe);
      try { if (fs.existsSync(p)) return p; } catch (_) { /* ignore */ }
    }
  }

  // 7zip cache downloaded by electron-Builder (common for local developers))
  const cache = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache');
  try {
    for (const d of fs.readdirSync(cache)) {
      if (!/^7zip/i.test(d)) continue;
      const base = path.join(cache, d);
      for (const sub of fs.readdirSync(base)) {
        const p = path.join(base, sub, 'bin', '7za.exe');
        if (fs.existsSync(p)) return p;
      }
    }
  } catch (_) { /* No cache directory */ }
  return '';
}

function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const it of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) walk(p);
      else { files += 1; bytes += fs.statSync(p).size; }
    }
  };
  walk(dir);
  return { files, bytes };
}

/** Set a source directory with 7-Zip pressure Zip: cwd to match the path inside the package without layered directory name */
function zipWith7z(exe, srcDir, outZip, level = 9) {
  const r = spawnSync(exe, ['a', '-tzip', '-mm=Deflate', `-mx=${level}`, '-bso0', '-bsp0', '-y', outZip, '*'], {
    cwd: srcDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (r.status !== 0) {
    throw new Error(`7-Zip compression failed(${r.status}): ${String(r.stderr || r.stdout || '').slice(0, 400)}`);
  }
}

/** Bottom: PowerShell Compress-Archive (5% size, used only when not loaded 7-Zip) */
function zipWithPowershell(srcDir, outZip) {
  const ps = `Compress-Archive -Path '${path.join(srcDir, '*')}' -DestinationPath '${outZip}' -CompressionLevel Optimal -Force`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (r.status !== 0) {
    throw new Error(`Compress-Archive failed: ${String(r.stderr || '').slice(0, 400)}`);
  }
}

/** Compressed result self-check: Read it with your own zip parser, confirming that the number of entries corresponds to the total decompressive bytes */
function verify(zipPath, expect) {
  const { ZipFile } = require('../src/core/zip');
  const zip = new ZipFile(zipPath);
  try {
    const names = zip.names().filter((n) => !n.endsWith('/'));
    let bytes = 0;
    for (const n of names) bytes += zip.entries.get(n).uncompSize;
    if (names.length !== expect.files) {
      throw new Error(`The number of entries does not match: inside the package ${names.length}, Source Directory ${expect.files}`);
    }
    if (bytes !== expect.bytes) {
      throw new Error(`Unpressure total byte does not match: inside the package ${bytes}, Source Directory ${expect.bytes}`);
    }
    return names.length;
  } finally {
    zip.close();
  }
}

function main() {
  const srcDir = path.resolve(process.argv[2] || '');
  const outZip = path.resolve(process.argv[3] || '');
  const limArg = process.argv.indexOf('--limit-mb');
  const limitMiB = limArg > 0 ? Number(process.argv[limArg + 1]) : 100;
  if (!srcDir || !fs.existsSync(srcDir) || !outZip) {
    console.error('Usage: nonee build/zip.js< Source Directory> < Output.zip> [-Limit-mb100]]');
    process.exit(1);
  }

  const stats = dirStats(srcDir);
  console.log(`Compression ${srcDir}(${stats.files} File, ${(stats.bytes / MIB).toFixed(1)} MB)`);
  fs.rmSync(outZip, { force: true });

  const exe = find7z();
  if (exe) {
    console.log('Compressor: ', exe);
    zipWith7z(exe, srcDir, outZip);
  } else {
    console.warn('No 7-Zip, return Compress-Archive -- the product will be about 5% larger, and may not fit the release mirrors single file limit.');
    zipWithPowershell(srcDir, outZip);
  }

  const size = fs.statSync(outZip).size;
  const entries = verify(outZip, stats);
  console.log(`Completed: ${outZip}`);
  console.log(`  ${entries}  Entry, ${size} Bytes(${(size / MIB).toFixed(2)} MiB, compression rate ${(size / stats.bytes * 100).toFixed(1)}%`);

  if (size > limitMiB * MIB) {
    console.error(`More than ${limitMiB} MiB ceiling (release mirrors annex file cap 100MB).`);
    process.exit(2);
  }
  console.log(`  Zilong. ${limitMiB} Within MiB (residual) ${((limitMiB * MIB - size) / MIB).toFixed(2)} MiB)`);
}

if (require.main === module) main();

module.exports = { find7z, dirStats, verify };
