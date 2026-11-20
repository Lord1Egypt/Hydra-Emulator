'use strict';
/**
 * Run as engine/ can be distributed with package:/
 *
 * The key step is the compression of system. img. AOSP system. img is a rare mirror of 3.1 GB.,
 * The vast majority of them are zero, gzip and then only ~580 MB. Single document distributions are almost all over here.
 * Plus emulator + Electric + Platform-tools, full package = 1.0~1.1GB.
 * The distribution should be 1.4 GB or more if it’s not compressed.
 * The cost is the first time the start-up cost 1 to 2 minutes to expand it to the user directory (only once).),
 * Develop logic in src/ core/provision.js ’materializeImages().
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'engine');
const OUT = path.join(ROOT, 'build', 'runtime');
const MARK = path.join(OUT, '.prepared');
// Prearranged / data initial template (formatized ext4, xz compression). See comment below userdata. img.
const SEED_USERDATA = path.join(__dirname, 'seed', 'userdata.img.gz');

function sizeOf(p) {
  try { return fs.statSync(p).size; } catch (_) { return 0; }
}

async function gzipFile(src, dest) {
  await pipeline(
    fs.createReadStream(src),
    zlib.createGzip({ level: 6 }),
    fs.createWriteStream(dest),
  );
}

/** Large mirror XZ (LZMA2): ~25% more than gzip-6 (system.img 1.5GB→1.1GB).
 *  Default 9e limit; CI double-approved XZ_PRESET=6 to press time to 1/3 (volume + 3%).
 *
 *  Realization description (pumped pits)):
 *   - lzma with python (one-line, stable). @napi-rs/ lzma ’s createcompressstream in some
 *     The environment will be dead by 0 bytes (actually, 18 minutes without output), only when the bottom of the field is closed and time is taken.
 *   - [CI] The root file must be pipe to the sub-process stdin, and close after reading.
 *     Python, on the side. `shutil.copyfileobj(sys.stdin.buffer, z)`, If you don't get EOF, you'll always wait for input.,
 *     stdout without a byte, the process never quits. Only p. stdout, local because there is already .xxz
 *     “Jumping over double compression“ got lost, and the new CI catalogue was bound to be used.
 *   - Plus door dog: the compressor will kill and drop into gzip, and never let the packing chain hang indefinitely.
 *   - No python / compression failed → gzip-9 (slightly large but never dead)),
 *     When running, matrializeImages select the pressurer by extension, both products.
 */
function findPython() {
  const { spawnSync } = require('child_process');
  for (const cmd of ['python', 'python3', 'py']) {
    try {
      const r = spawnSync(cmd, ['-c', 'import lzma;print("ok")'], {
        encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (r.status === 0 && /ok/.test(String(r.stdout))) return cmd;
    } catch (_) { /* Try next. */ }
  }
  return null;
}

async function xzFile(src, dest) {
  const preset = Math.max(0, Math.min(9, Number(process.env.XZ_PRESET || 9)));
  const extreme = preset >= 9 && process.env.XZ_NO_EXTREME !== '1';
  const pyPreset = extreme ? '9|lzma.PRESET_EXTREME' : String(preset);
  const dictSize = preset >= 9 ? (1 << 27) : preset >= 6 ? (1 << 26) : (1 << 23);
  // Default 2 hours (3GB / 2 core / preset 6 live measurements ~ 40min); kill and drop gzip on timeout.
  const timeoutMs = Math.max(5000, Number(process.env.XZ_TIMEOUT_MS || 2 * 60 * 60 * 1000));
  const py = findPython();
  if (py) {
    const { spawn } = require('child_process');
    const p = spawn(py, ['-c', [
      'import lzma,sys,shutil',
      `flt=[{"id":lzma.FILTER_LZMA2,"preset":${pyPreset},"dict_size":${dictSize}}]`,
      'z=lzma.LZMAFile(sys.stdout.buffer,mode="wb",format=lzma.FORMAT_XZ,filters=flt)',
      'shutil.copyfileobj(sys.stdin.buffer,z); z.close()',
    ].join(';')], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });

    // Hang up the wire, avoid the sub-process having left the close event before we left it.
    const exited = new Promise((resolve) => {
      p.on('close', resolve);
      p.on('error', () => resolve(-1));
    });
    const watchdog = setTimeout(() => {
      console.log(`  (xz condensed more than ${Math.round(timeoutMs / 60000)} Minutes, abort and switch to gzip-9)`);
      try { p.kill(); } catch (_) { /* Quit */ }
    }, timeoutMs);

    let ok = false;
    try {
      // Key: stdin is the input of the compressor. Pipeline finishes src end (p. stdin)),
      // Python received EOF only to fly XZ tail and exit normally.
      const streams = [
        pipeline(fs.createReadStream(src), p.stdin),
        pipeline(p.stdout, fs.createWriteStream(dest)),
      ];
      // Any road anomaly (EPIPE/ Writing board failure) immediately terminate the sub-process, and don’t wait for the guard dog.
      streams.forEach((s) => s.catch(() => { try { p.kill(); } catch (_) { /* noop */ } }));
      const settled = await Promise.allSettled(streams);
      const code = await exited;
      ok = code === 0 && settled.every((r) => r.status === 'fulfilled') && sizeOf(dest) > 0;
    } catch (_) {
      ok = false;
    } finally {
      clearTimeout(watchdog);
    }
    if (ok) return;
    // Half. Xz. Keeps the contaminated product, has to be deleted before you go for it.
    try { fs.rmSync(dest, { force: true }); } catch (_) { /* ignore */ }
    console.log(`  (${py} Compression failed, switch to gzip-9)`);
  } else {
    console.log('  (Python not found, switch to gzip-9 (slightly large but reliable)))');
  }
  // Underground: gzip-9 (not xz, at runtime)
  await pipeline(
    fs.createReadStream(src),
    zlib.createGzip({ level: 9 }),
    fs.createWriteStream(dest.replace(/\.xz$/i, '.gz')),
  );
}

async function main() {
  const force = process.argv.includes('--force');
  if (fs.existsSync(MARK) && !force) {
    console.log('Build/runtime is the latest (plus --force reconstruction))');
    return;
  }
  if (!fs.existsSync(SRC)) {
    console.error('Lack of engine/ directory, unable to prepare for running');
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });

  // 1. Direct copy of emulator / platform-tools (excluding historical products))
  for (const dir of ['emulator', 'platform-tools']) {
    const s = path.join(SRC, dir);
    if (!fs.existsSync(s)) continue;
    console.log(` Copy ${dir}…`);
    fs.cpSync(s, path.join(OUT, dir), { recursive: true });
  }

  // 1.5 Thin: Remove files that will never be loaded under fixed start parameters (approximately -400MB))
  if (!process.argv.includes('--no-slim')) {
    console.log('Thin Runs…');
    const { slim } = require('./slim-runtime');
    slim(OUT, { aggressive: !process.argv.includes('--safe-slim') });
  }

  // 2. system image: Large mirroring .xx (metaalizeImages current at running), remaining sample
  const imgRoot = path.join(SRC, 'system-images');
  let compressed = 0;
  if (fs.existsSync(imgRoot)) {
    for (const api of fs.readdirSync(imgRoot)) {
      for (const tag of fs.readdirSync(path.join(imgRoot, api))) {
        for (const abi of fs.readdirSync(path.join(imgRoot, api, tag))) {
          const from = path.join(imgRoot, api, tag, abi);
          const to = path.join(OUT, 'system-images', api, tag, abi);
          fs.mkdirSync(to, { recursive: true });
          for (const f of fs.readdirSync(from)) {
            const src = path.join(from, f);
            if (!fs.statSync(src).isFile()) continue;
            // NOTICE.txt is a GMS licensed text (~20MB), not required to run
            if (/^NOTICE\.txt$/i.test(f)) continue;
            // userrdata.img uses preset ext4 template from the warehouse (seed)):
            // The official sys-img is 1MB zero, e2fsck when emulator expands,
            // The partition stops at 1MB involid magic /data read-only — all new installation will never turn on.
            // Templates are generated only once during the build period (mke2fs), followed by the code, and the CI does not need an extra tool chain.
            if (/^userdata\.img$/i.test(f) && fs.existsSync(SEED_USERDATA)) {
              fs.copyFileSync(SEED_USERDATA, path.join(to, 'userdata.img.gz'));
              console.log('Userdata.img uses preset ext4 templates (build/seed))');
              compressed += 1;
              continue;
            }
            if (/^(system|vendor|cache|userdata)\.img$/i.test(f) && sizeOf(src) > 32 * 1024 * 1024) {
              // A big mirror presses one, the original is not packaged; already compressed products (and of reasonable size) skip double compression
              const xz = path.join(to, `${f}.xz`);
              const gz = path.join(to, `${f}.gz`);
              // Gzip’s bottom path output is .gz, and you must admit it, otherwise every reconstruction will crush the 3GB.
              // Threshold >1MB instead of compression ratio: vendor.img.gz only ~21MB, userdata.img,
              // A fixed threshold or a "compressive ratio" will misconstrue these legitimate products to null and void and stress.
              const existing = [xz, gz].find((p) => sizeOf(p) > 1024 * 1024);
              if (existing) {
                console.log(`Skip ${f}(Existing ${path.extname(existing)} ${(sizeOf(existing) / 1048576).toFixed(1)} MB)`);
                compressed += 1;
                continue;
              }
              console.log(`Compression ${f}(${(sizeOf(src) / 1073741824).toFixed(2)} XZ9e (lower, one-time))…`);
              // eslint-disable-next-line no-await-in-loop
              await xzFile(src, xz);
              compressed += 1;
            } else {
              fs.copyFileSync(src, path.join(to, f));
            }
          }
        }
      }
    }
  }

  fs.writeFileSync(MARK, new Date().toISOString());
  const gzCount = compressed;
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else total += sizeOf(p);
    }
  };
  walk(OUT);
  console.log(`_Other Organiser(${(total / 1073741824).toFixed(2)} GB, compressed. ${gzCount} A big mirror.)`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
// Package preparation process for direct call for regression testing (without triggering main))
module.exports = { xzFile, gzipFile, findPython };
