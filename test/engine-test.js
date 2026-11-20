'use strict';
/**
 * Engine & Self-Movement Link Test (not dependent on the real QEMU / adb / Android)
 * Overwrite: Downloader (continuing with breakpoint), ZIP unpressure, environmental check, QEMU start parameters, monitor protocol
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');

// Dissociate test data directories to avoid contamination of the real user configuration
const TMP = path.join(os.tmpdir(), `hydra-test-${Date.now()}`);
process.env.APPDATA = TMP;
fs.mkdirSync(path.join(TMP, 'hydra'), { recursive: true });

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; results.push(`  ✓ ${name}`); })
    .catch((e) => { failed++; results.push(`  ✗ ${name}\n    ${e.message}`); });
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'Accusations failed.'); }

(async () => {
  console.log('\n[download.js]');
  const { download, downloadParallel, head, sha256File } = require('../src/core/download');

  // Local HTTP service simulation download source (including Range extensions))
  const payload = Buffer.alloc(300 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;

  const server = http.createServer((req, res) => {
    if (req.url === '/big.bin') {
      const range = req.headers.range;
      if (range) {
        const start = Number(/bytes=(\d+)-/.exec(range)[1]);
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}`,
          'Content-Length': payload.length - start,
        });
        return res.end(payload.subarray(start));
      }
      res.writeHead(200, { 'Content-Length': payload.length });
      return res.end(payload);
    }
    // Range (for parallel block testing) for full start-end support)
    if (req.url === '/ranged.bin') {
      server.rangeHits = (server.rangeHits || 0) + 1;
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
      if (!range) {
        res.writeHead(200, { 'Content-Length': payload.length, 'Accept-Ranges': 'bytes' });
        return res.end(payload);
      }
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), payload.length - 1);
      res.writeHead(206, {
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${payload.length}`,
        'Content-Length': end - start + 1,
      });
      return res.end(payload.subarray(start, end + 1));
    }
    // Not in support of Lange
    if (req.url === '/norange.bin') {
      res.writeHead(200, { 'Content-Length': payload.length, 'Accept-Ranges': 'none' });
      return res.end(payload);
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/big.bin' });
      return res.end();
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  await test('Full Download + Follow Redirection', async () => {
    const dest = path.join(TMP, 'dl1.bin');
    await download(`http://127.0.0.1:${port}/redirect`, dest);
    assert(fs.statSync(dest).size === payload.length, 'Size does not match');
  });

  await test('Breakpoints (half of files already available))', async () => {
    const dest = path.join(TMP, 'dl2.bin');
    fs.writeFileSync(dest, payload.subarray(0, 100000));
    let lastPercent = 0;
    await download(`http://127.0.0.1:${port}/big.bin`, dest, {
      onProgress: (p) => { lastPercent = p.percent; },
    });
    assert(fs.statSync(dest).size === payload.length, `Resize ${fs.statSync(dest).size}`);
    assert(fs.readFileSync(dest).equals(payload), 'Extensions are inconsistent');
    assert(lastPercent > 50, 'No progress reported');
  });

  await test('HEAD detection + SHA256', async () => {
    const h = await head(`http://127.0.0.1:${port}/big.bin`);
    assert(h.size === payload.length, 'HEAD size does not match');
    const sum = await sha256File(path.join(TMP, 'dl1.bin'));
    assert(/^[0-9a-f]{64}$/.test(sum), 'sha256 Format Aberration');
  });

  await test('SHA256 Failed validation cleans files', async () => {
    const dest = path.join(TMP, 'dl3.bin');
    let threw = false;
    try {
      await download(`http://127.0.0.1:${port}/big.bin`, dest, { expectSha256: 'deadbeef'.repeat(8) });
    } catch (_) { threw = true; }
    assert(threw, 'You should make a mistake.');
    assert(!fs.existsSync(dest), 'Validation failed to delete file');
  });

  await test('Parallel section download: multiple connections spell identical content', async () => {
    const dest = path.join(TMP, 'dl4.bin');
    server.rangeHits = 0;
    let maxPercent = 0;
    const r = await downloadParallel(`http://127.0.0.1:${port}/ranged.bin`, dest, {
      connections: 8,
      minChunk: 32 * 1024,
      onProgress: (p) => { maxPercent = Math.max(maxPercent, p.percent); },
    });
    assert(fs.readFileSync(dest).equals(payload), 'Unsymmetry after blocking');
    assert(r.parallel > 1, `No parallel enabled: ${r.parallel}`);
    assert(server.rangeHits >= r.parallel, `Small number of block requests: ${server.rangeHits}`);
    assert(maxPercent > 0, 'No progress reported');
  });

  await test('The source doesn’t support Range automatically returns the single stream', async () => {
    const dest = path.join(TMP, 'dl5.bin');
    const r = await downloadParallel(`http://127.0.0.1:${port}/norange.bin`, dest, {
      connections: 8,
      minChunk: 32 * 1024,
    });
    assert(fs.readFileSync(dest).equals(payload), 'Backwards are inconsistent.');
    assert(!r.parallel, 'There’s no parallels.');
  });

  server.close();

  console.log('\n[provision.js]');
  const { Provisioner } = require('../src/core/provision');
  const store = require('../src/core/store');

  await test('The directory when running by default is located under the data directory', async () => {
    const p = new Provisioner('C:/fake/app');
    assert(p.paths().root.startsWith(store.DATA_DIR), `Path abnormal: ${p.paths().root}`);
    assert(p.paths().qemuExe.endsWith('qemu-system-x86_64.exe'), 'qemu Path Unusual');
    assert(p.paths().adbExe.endsWith('adb.exe'), 'Adb Path Abnormal');
  });

  await test('Air environment check: adb not ready, component structure complete', async () => {
    const p = new Provisioner(path.join(TMP, 'nonexistent'));
    const env = await p.checkEnv();
    assert(env.adb.ok === false, 'I don’t think we should be ready.');
    // QEMU may have been installed at the system level (e. g. winget to Programme Fields) and should have been discovered at this time
    if (env.qemu.ok) assert(env.qemu.version, 'qemu qemu must be ready with version number');
    assert(env.ready === false, 'I\'m not ready.');
    assert(typeof env.hypervisor.whpx === 'boolean', 'Lack of information on superblasts');
  });

  await test('Built ZIP release available', async () => {
    const { ZipArchive } = require('../src/core/zip');
    // Construct the smallest zip of a stored mode
    const name = Buffer.from('platform-tools/adb.exe');
    const data = Buffer.from('fake-adb-binary');
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(0, 8);
    loc.writeUInt32LE(data.length, 18);
    loc.writeUInt32LE(data.length, 14);
    loc.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt32LE(data.length, 20);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(46 + name.length, 12);
    eocd.writeUInt32LE(30 + name.length + data.length, 16);
    const zipPath = path.join(TMP, 'pt.zip');
    fs.writeFileSync(zipPath, Buffer.concat([loc, name, data, cen, name, eocd]));

    const out = path.join(TMP, 'unzip');
    const p = new Provisioner(TMP);
    await p.extractZip(zipPath, out);
    assert(fs.readFileSync(path.join(out, 'platform-tools', 'adb.exe')).toString() === 'fake-adb-binary', 'Decompress content does not match');
    assert(new ZipArchive(fs.readFileSync(zipPath)).has('platform-tools/adb.exe'), 'Zip Read Abnormal');
  });

  await test('The relative url in the SDK index will be filled to absolute address', async () => {
    const { absUrl, baseOf, SOURCES } = require('../src/core/provision');
    // Repository2-3.xml (emulator) relative to warehouse root
    assert(absUrl('emulator-windows_x64-16847572.zip') === `${baseOf(SOURCES.sdkIndex)}emulator-windows_x64-16847572.zip`,
      'Emulator relative path not completed');
    // sys-img index relative to sys-img/android/, cannot be misspelled to warehouse root
    const sysBase = baseOf(SOURCES.sysImgIndexes[0]);
    assert(sysBase.endsWith('/sys-img/android/'), `sys-img base directory anomaly: ${sysBase}`);
    assert(absUrl('x86_64-30_r11.zip', sysBase) === 'https://dl.google.com/android/repository/sys-img/android/x86_64-30_r11.zip',
      'sys-img relative path completion error');
    // Absolute address returns as
    assert(absUrl('https://example.com/a.zip') === 'https://example.com/a.zip', 'Absolute address rewrite');
  });

  await test('Parsed emulator/ system image Address is an absolute downloadable URL', async () => {
    const p = new Provisioner(TMP);
    const emuUrl = await p.resolveEmulatorUrl();
    const imgUrl = await p.resolveSysimgUrl();
    for (const u of [emuUrl, imgUrl]) {
      assert(/^https?:\/\//i.test(u), `Not absolute URL: ${u}`);
      assert(/\.zip$/i.test(u), `No. Zip bag.: ${u}`);
    }
    assert(/windows_x64/i.test(emuUrl), `Emulator, the package is not right.: ${emuUrl}`);
  });

  await test('AVD configuration using 64 bit architecture (x86_64) cannot be intercepted to x86)', async () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(TMP);
    const r = emu.ensureAvd({ memoryMB: 2048, cores: 2 });
    const cfg = fs.readFileSync(path.join(r.avdDir, 'config.ini'), 'utf8');
    assert(/^hw\.cpu\.arch=x86_64$/m.test(cfg), `hw.cpu.arch should read x86_64, actual: ${cfg.match(/^hw\.cpu\.arch=.*$/m)}`);
    assert(/^abi\.type=x86_64$/m.test(cfg), 'For ab.type read x86_64');
    assert(/^image\.sysdir\.1=\S*system-images\//m.test(cfg), 'missing.sysdir.1');
  });

  await test('Could not close temporary folder: %s %s', async () => {
    const { friendlyInstallError } = require('../src/core/adb');
    const out = friendlyInstallError(
      'Performing Streamed Install\nadb.exe: failed to install x.apk: '
      + 'Failure [INSTALL_FAILED_NO_MATCHING_ABIS: Failed to extract native libraries, res=-113]',
    );
    assert(/ARM native libraries/i.test(out), `The ARM primary bank issue should be explained: ${out}`);
    assert(out.includes('INSTALL_FAILED_NO_MATCHING_ABIS'), 'The original error code should be retained');
    const other = friendlyInstallError('Failure [INSTALL_FAILED_INVALID_APK: x]');
    assert(/damaged|incomplete|invalid/i.test(other), `Unknown error should also be readable: ${other}`);
  });

  await test('Mirror verification: Distinguishing valid ISO9660/ Damaged / Unfinished', async () => {
    const p = new Provisioner(TMP);
    const mk = (file, size, writeMagic) => {
      const fd = fs.openSync(file, 'w');
      fs.ftruncateSync(fd, size);
      if (writeMagic) {
        fs.writeSync(fd, Buffer.from([1]), 0, 1, 0x8000);
        fs.writeSync(fd, Buffer.from('CD001', 'latin1'), 0, 5, 0x8001);
      }
      fs.closeSync(fd);
      return file;
    };

    const good = mk(path.join(TMP, 'good.iso'), 450 * 1024 * 1024, true);
    const a = p.inspectIso(good);
    assert(a.ok && a.iso9660, `Valid ISO found invalid: ${a.reason}`);

    const broken = mk(path.join(TMP, 'broken.iso'), 450 * 1024 * 1024, false);
    const b = p.inspectIso(broken);
    assert(!b.ok && /ISO9660/.test(b.reason), `The damaged mirror was not intercepted.: ${JSON.stringify(b)}`);

    const partial = mk(path.join(TMP, 'partial.iso'), 2 * 1024 * 1024, true);
    const c = p.inspectIso(partial);
    assert(!c.ok && /incomplete|unfinished|not finished/i.test(c.reason), `The undefeated mirrors were not intercepted.: ${JSON.stringify(c)}`);

    for (const f of [good, broken, partial]) fs.rmSync(f, { force: true });
  });

  await test('Remote stat list parsing (real mtime, avoid unlimited retransmission))', async () => {
    const { parseStatList } = require('../src/core/adb');
    const rows = parseStatList('1794309868|1234|./a.txt\n1794309900|99|./sub/b.png');
    assert(rows && rows.length === 2, `Parsing Number Unusual: ${JSON.stringify(rows)}`);
    assert(rows[0].rel === 'a.txt' && rows[0].size === 1234, 'First Line Field Error');
    assert(rows[1].rel === 'sub/b.png', 'Subdirectorate relative path error');
    assert(rows[1].mtime === 1794309900000, 'mtime not converted to ms');
    assert(parseStatList('ls: /nope: No such file') === null, 'Non-stat output should return null to return');
    assert(Array.isArray(parseStatList('')) && parseStatList('').length === 0, 'An empty directory should return to an empty array');
  });

  console.log('\n[engine.js]');
  const { Runtime } = require('../src/core/engine');

  await test('QEMU startup parameter: Install mode mount ISO and start with light drive', async () => {
    const rt = new Runtime(TMP);
    rt._hv = { whpx: true };
    store.saveSettings({
      runtime: { isoPath: 'C:/img/android.iso', diskPath: 'C:/img/disk.qcow2' },
      engine: { memoryMB: 4096, cores: 4 },
    });
    const args = rt.buildArgs({ install: true }).join(' ');
    assert(args.includes('-cdrom C:/img/android.iso'), 'Missing -cdrom');
    assert(/order=d/.test(args), 'Start from light');
    assert(/accel=whpx/.test(args), 'WHPX should be used');
    assert(/-cpu host/.test(args), 'WFPX should use host CPU');
    assert(/hostfwd=tcp:127\.0\.0\.1:5555-:5555/.test(args), 'Missing adb port forwarding');
    assert(args.includes('-monitor tcp:127.0.0.1:5556'), 'Missing monitor');
    assert(/-m 4096/.test(args), 'Memory parameter error');
  });

  await test('QEMU Start Argument: Normal start-up from disk', async () => {
    const rt = new Runtime(TMP);
    rt._hv = { whpx: false };
    const args = rt.buildArgs({ install: false }).join(' ');
    assert(!args.includes('-cdrom'), 'ISO should not be mounted');
    assert(/order=c/.test(args), 'Start with hard drive');
    assert(/accel=tcg/.test(args), 'None WFPX should return TCMG');
    assert(/-cpu max/.test(args), 'TPG should use max CPU');
    assert(args.includes('if=virtio,format=qcow2'), 'Disk Arguments Error');
  });

  await test('Headless Mode Hide Virtual Machine Window', async () => {
    const rt = new Runtime(TMP);
    rt._hv = { whpx: false };
    const args = rt.buildArgs({ headless: true }).join(' ');
    assert(args.includes('-display none'), 'Should No Window');
  });

  await test('QEMU protocol: shake hands and give orders', async () => {
    // Simulate QEMU monitor: Company up and back "(qemu) " , and back when command is received
    const srv = net.createServer((sock) => {
      sock.write('QEMU 8.2.0 monitor - type \'help\' for more information\r\n(qemu) ');
      sock.on('data', (d) => {
        srv.lastCmd = d.toString().trim();
        sock.write('ok\r\n(qemu) ');
      });
    });
    await new Promise((r) => srv.listen(5556, '127.0.0.1', r));

    const rt = new Runtime(TMP);
    await rt.monitorCmd('system_powerdown');
    assert(srv.lastCmd === 'system_powerdown', `Actual receipt: ${srv.lastCmd}`);
    await new Promise((r) => srv.close(r));
  });

  await test('Returns needsSetup when the system is not installed', async () => {
    store.saveSettings({ runtime: { installed: false }, engine: { mode: 'builtin' } });
    const rt = new Runtime(TMP);
    // A fake adb guarantee isOnline is a quick failure
    const r = await rt.ensure({ onLog: () => {} });
    assert(r.ok === false, 'I\'m not ready.');
    assert(['provision', 'install'].includes(r.needsSetup), `needsSetup=${r.needsSetup}`);
  });

  await test('Preheat and click in parallel only once running (scoffs, etc.) without repeating the machine)', async () => {
    const rt = new Runtime(TMP);
    rt.provisioner.checkEnv = async () => ({ adb: { ok: true }, emulator: { ok: true }, sysimg: { ok: true } });
    rt.emulator.setPriority = async () => 0;
    let calls = 0;
    rt._ensureInner = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 60));
      return { ok: true, engine: 'emulator' };
    };
    // Preheat (start 4 seconds to run automatically) will occur simultaneously with the user-point start-up application
    const [a, b] = await Promise.all([rt.prewarm({}), rt.ensure({})]);
    assert(calls === 1, `We've got the bottom switch trigger. ${calls} Next time, only one simulator should be pulled up.`);
    assert(a && a.ok && b && b.ok, 'Both routes should be ready.');
  });

  await test('Start ready determination: must wait for the Boot_completed + Package Manager', async () => {
    const rt = new Runtime(TMP);
    const calls = [];
    const fake = {
      isOnline: async () => true,
      connect: async () => true,
      shell: async (cmd) => {
        calls.push(cmd);
        if (cmd.includes('sys.boot_completed')) return '1';
        if (cmd.includes('pm path android')) return 'package:/system/framework/framework-res.apk';
        return '';
      },
    };
    const r = await rt.waitAndroidReady(fake, 5000, () => {});
    assert(r.ok, 'Should be considered ready');
    assert(calls.some((c) => c.includes('sys.boot_completed')), 'Not checked Boot_completed');
    assert(calls.some((c) => c.includes('pm path android')), 'Package Manager Not Checked');
  });

  await test('Return phase (kernel) when the system is not started)', async () => {
    const rt = new Runtime(TMP);
    const fake = { isOnline: async () => true, connect: async () => true, shell: async () => '0' };
    const r = await rt.waitAndroidReady(fake, 1200, () => {});
    assert(!r.ok && r.stage === 'kernel', `Should stop at the Kernel stage: ${JSON.stringify(r)}`);
  });

  console.log('\n[Profile.js compatible mirror / full version]');

  await test('PlayImageInfo Verify API 34 Compatible Mirror Integrity', async () => {
    const dir = path.join(TMP, 'hydra', 'runtime', 'system-images', 'android-34', 'google_apis_playstore', 'x86_64');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'kernel-ranchu'), 'k');
    const prov = new Provisioner(path.join(__dirname, '..'));
    fs.writeFileSync(path.join(dir, 'system.img'), Buffer.alloc(64));
    assert(!prov.playImageInfo().ok, 'A mirror that’s too small should not be judged ready.');
    fs.writeFileSync(path.join(dir, 'system.img'), Buffer.alloc(301 * 1024 * 1024));
    const info = prov.playImageInfo();
    assert(info.ok && info.api === '34' && info.tag === 'google_apis_playstore', `API 34 compatible mirrors ready to be determined: ${JSON.stringify(info)}`);
  });

  await test('Hydra branding and manual links are present in About', () => {
    const root = path.join(__dirname, '..');
    const ui = path.join(root, 'src', 'ui');
    assert(fs.existsSync(path.join(ui, 'assets', 'logo.png')), 'Missing main logo');
    assert(fs.existsSync(path.join(ui, 'assets', 'appicon.ico')), 'Missing Windows icon');
    assert(fs.existsSync(path.join(root, 'build', 'fetch-runtime.js')), 'Missing runtime packaging script');
    const html = fs.readFileSync(path.join(ui, 'index.html'), 'utf8');
    assert(html.includes('id="aboutGroup"') && html.includes('id="btnOpenManual"'), 'Missing About or manual link');
    assert(!/douyin|wechat|powered by/i.test(html), 'Found old credits in the About view');
  });

  console.log(results.join('\n'));
  console.log(`\n Result: ${passed} Through, ${failed}  Failed \n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
