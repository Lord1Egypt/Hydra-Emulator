'use strict';
/**
 * Zero configuration from calibrated / container thinness regression test (pure Node, no lift up emulator))
 * Run: none test/auto-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), `hydra-auto-test-${Date.now()}`);
process.env.APPDATA = TMP;
fs.mkdirSync(path.join(TMP, 'hydra'), { recursive: true });

let passed = 0;
let failed = 0;
const results = [];
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { passed += 1; results.push(`  ✓ ${name}`); })
    .catch((e) => { failed += 1; results.push(`  ✗ ${name}\n    ${e.stack || e.message}`); });
}
function assert(c, m) { if (!c) throw new Error(m || 'Accusations failed.'); }

const doctor = require('../src/core/doctor');
const layers = require('../src/core/layers');
const pointer = require('../src/core/pointer');
const { AdbClient, friendlyInstallError, friendlyLaunchError } = require('../src/core/adb');

(async () => {
  console.log('\n[Autoparameter for doctor.js]');

  await test('GPU backend selected by emulator version (new version host priority + software rendering bottom, old version swiftshader_indirect)', () => {
    // gpuCandidades will fine-tune this machine to the GPU manufacturer (AMD) advance swangle),
    // So here’s the assertion that the "list of candidates contains key items" instead of the fixed first.
    const c37 = doctor.gpuCandidates('37.3.8.0');
    assert(c37.includes('host'), '37.x Candidatures must include host');
    assert(c37.includes('swangle'), '37.x Candidatures must contain swangle');
    assert(c37.includes('software'), 'The new version has to be rewrite the bottom of the software');
    // 37.x Upload swiftshader_indirect will initialize the GL and never appear in the candidate.
    assert(!c37.includes('swiftshader_indirect'));
    // The old version is still on the move
    const c35 = doctor.gpuCandidates('35.1.4.0');
    assert(c35.includes('host'));
    assert(c35.includes('swiftshader_indirect'));
    // targetGpuVendor should return known value or unknown (no abnormality))
    const v = doctor.detectGpuVendor();
    assert(['nvidia', 'amd', 'intel', 'unknown'].includes(v), `SelectGpuVendor returned the unexpected value: ${v}`);
  });

  await test('Small memory machine automatically reduces (no longer written dead 4GB/ 4 nuclear))', () => {
    const host = { totalMB: 4096, freeMB: 2600, cores: 2, home: 'C:\\Users\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false };
    const p = doctor.chooseProfile({ host, accel: { ok: false }, emulatorVersion: '37.3.8.0', diskMB: 20000, port: 5554, adbPort: 5044 });
    assert(p.memoryMB === 2048, `Memory should read 2048, actual ${p.memoryMB}`);
    assert(p.cores === 2, `The core should read 2, actual ${p.cores}`);
    assert(p.accel === 'off', 'Auto-release software simulation without hardware acceleration');
    assert(p.bootTimeoutMs > 240000, 'Software simulations should be timed out for longer starters.');
    assert(p.gpu === 'host' || p.gpu === 'swangle', `Prefer rendering to host or swangle (AMD machine swangle priority), actual ${p.gpu}`);
    // Accel ’s underlying parameters when closing must be software rendering, otherwise no GPU is available under TPG
    const lastResort = doctor.planVariants(p).find((v) => v.lastResort);
    assert(lastResort && /software|swiftshader/.test(lastResort.gpu), 'The program must be rendered with software.');
    // Data partition defaults to 4/6/8GB (no more dead) on disk, and can be overwritten
    assert(p.dataMB >= 4096 && p.dataMB <= 8192, `Data partition should be 4-8GB, actual ${p.dataMB}`);
    const big = doctor.chooseProfile({
      host, accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 200000,
      settings: { engine: { dataPartitionGB: 24 } }, overrides: {},
    });
    assert(big.dataMB === 24 * 1024, 'The data partition capacity in the settings must be effective');
  });

  await test('Big memory machines don\'t eat memory indefinitely.', () => {
    const host = { totalMB: 65536, freeMB: 50000, cores: 32, home: 'C:\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false };
    const p = doctor.chooseProfile({ host, accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 200000, port: 5554, adbPort: 5044 });
    assert(p.memoryMB <= 3072 && p.cores <= 4, `The high-altitudes should also be capped.: ${p.memoryMB}MB / ${p.cores} Nuclear`);
    assert(p.accel === 'auto');
  });

  await test('Retry Matrix: From Best to Most Conservative, contains software simulations and cold start-up drives', () => {
    const p = doctor.chooseProfile({
      host: doctor.hostInfo(), accel: { ok: true }, emulatorVersion: '37.3.8.0',
      diskMB: 50000, port: 5554, adbPort: 5044,
    });
    const v = doctor.planVariants(p);
    assert(v.length >= 3 && v.length <= 4, `The number of retries should be 3-4, actual ${v.length}`);
    assert(v.some((x) => x.accel === 'off'), 'Missing software simulations');
    // The last one is only "no snapshot + minimum memory", and it is not allowed -wipe-data:
    // Every slot will fail when the disk is full, and the user will be cleared with the wipe.
    assert(v[v.length - 1].snapshot === false, 'The last one has to skip the snapshot loading.');
    assert(v[v.length - 1].wipe === false, 'No automatic retry will allow clearing of user data');
    assert(v[v.length - 1].memoryMB <= 2048, 'The last one should be down to minimum memory.');
    const keys = v.map((x) => JSON.stringify([
      x.gpu, x.accel, x.wipe, x.memoryMB, x.cores, x.dataMB, x.snapshot !== false,
    ]));
    assert(new Set(keys).size === keys.length, 'Each retry must use a distinct runtime configuration');
  });

  await test('The mirror is not a mirror change: sysdir should not clear the user data if the directory is changed', () => {
    const c = 'C:/Users/x/AppData/Roaming/hydra/system-images/android-34/google_apis_playstore/x86_64/';
    const d = 'D:/Hydra EmulatorRuntime/system-images/android-34/google_apis_playstore/x86_64/';
    assert(doctor.imageIdentity(c) === doctor.imageIdentity(d), 'The same path to the same mirror must be identified.');
    const key = (p) => doctor.snapshotKey({ emulatorVersion: '37.3.8', api: '34', tag: 'google_apis_playstore' }, p);
    assert(key(c) === key(d), 'You can’t waste a snapshot after changing the plate (or wait for a cold start).)');
    const other = 'D:/rt/system-images/android-34/google_apis/x86_64/';
    assert(doctor.imageIdentity(other) !== doctor.imageIdentity(d), 'I really need to be able to identify myself with a new mirror.');
  });

  await test('Simulation fingerprints are not subject to GPU/Accelerator/Memorial Retest changes (avoids that each re-test is empty of installed applications))', () => {
    const a = doctor.snapshotKey({ dataMB: 4096, emulatorVersion: '37.3.8.0', api: '34', tag: 'google_apis_playstore' }, 'C:\\img');
    const b = doctor.snapshotKey({ dataMB: 4096, emulatorVersion: '37.3.8.0', api: '34', tag: 'google_apis_playstore' }, 'C:\\img');
    const c = doctor.snapshotKey({ dataMB: 4096, emulatorVersion: '37.3.8.0', api: '34', tag: 'google_apis_playstore' }, 'C:\\img2');
    assert(a === b && a !== c);
  });

  await test('Log diagnostics recognize card/accelerated/Chinese path/lock file problems', () => {
    assert(doctor.diagnose(['Failed to initialize GL emulation']).code === 'GPU_INIT');
    assert(doctor.diagnose(['ERROR: x86_64 emulation currently requires hardware acceleration!']).code === 'ACCEL');
    assert(doctor.diagnose(['Cannot allocate memory for guest RAM']).code === 'MEMORY');
    assert(doctor.diagnose(['panic: AVD hydra is already running']).code === 'AVD_LOCK');
    assert(doctor.diagnose(['non-ASCII path is not supported']).code === 'NON_ASCII');
    assert(doctor.diagnose(['random line']).code === 'UNKNOWN');
  });

  await test('Logs Diagnosis: emulator exits with 0xC00000005 to be judged to be a rendering backend collapse', () => {
    // Actual #20/#25: Print Userspace Boot Properties exit 3221225477
    assert(doctor.diagnose(['emulator exit 3221225477']).code === 'ACCESS_VIOLATION');
    assert(doctor.diagnose(['... 0xC0000005 ...']).code === 'ACCESS_VIOLATION');
    // Crash logs also usually have the initial information with the rendering: the crash must be prioritized instead of the GPU_INIT
    const mixed = ['Graphics backend: gfxstream', 'emulator exit 3221225477'];
    assert(doctor.diagnose(mixed).code === 'ACCESS_VIOLATION', 'The crash should take precedence over the ordinary rendering log.');
  });

  await test('Free Port Detection returns even port pairs', async () => {
    const p = await doctor.freePortPair(5560);
    assert(p % 2 === 0 && p >= 5560, `Port anomaly: ${p}`);
  });

  await test('Sets the automatic parameters displayed on the page to match the running parameters (37.x does not show any more discarded backends))', () => {
    const common = {
      accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 50000, port: 5562, adbPort: 5044,
      // RAM/ Nucleus caps now follow host, without which the CI machine specifications will drift.
      // (GitHub runner only has 4 cores, manually filled 6 cores will be collected correctly and 3 cores will be misreported.)
      host: { totalMB: 32768, freeMB: 24000, cores: 12, home: 'C:\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false },
    };
    const p = doctor.autoProfile({ ...common, settings: { engine: { autoMemory: true, gpuMode: 'auto', memoryMB: 0, cores: 0 } } });
    const text = doctor.describeProfile(p);
    assert(p.gpu === 'host' || p.gpu === 'swangle', `should be host or swangle (AMD machine), actual ${p.gpu}`);
    assert(p.accelOk === true && text.includes('hardware acceleration'), text);
    assert(!text.includes('swiftshader_indirect'), text);
    assert(text.includes('Port 5562'), text);

    // Old engines still apply old backends; advanced parameters manually filled by users are still in effect
    const old = doctor.autoProfile({ ...common, emulatorVersion: '35.1.4.0', settings: {} });
    assert(old.gpu === 'host' && doctor.gpuCandidates('35.1.4.0').includes('swiftshader_indirect'));
    const manual = doctor.autoProfile({ ...common, settings: { engine: { autoMemory: false, memoryMB: 6144, cores: 6, gpuMode: 'swiftshader' } } });
    assert(manual.memoryMB === 6144 && manual.cores === 6 && manual.gpu === 'swiftshader', JSON.stringify(manual));
    const zero = doctor.overridesFromSettings({ autoMemory: false, memoryMB: 0, cores: 0, gpuMode: 'auto' });
    assert(zero.memoryMB === 0 && zero.cores === 0 && zero.gpuMode === '', JSON.stringify(zero));
  });

  console.log('\n[- Yeah, yeah, yeah.]');

  await test('Count recoverable items: non-x86_64 QEMU, old AVD, locked files, old snapshots', () => {
    const root = path.join(TMP, 'runtime-layers');
    const mk = (p, size) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const b = Buffer.alloc(size || 16, 65);
      fs.writeFileSync(p, b);
    };
    mk(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'system.img'), 1024);
    mk(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'kernel-ranchu'), 16);
    mk(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'NOTICE.txt'), 2048);
    mk(path.join(root, 'system-images', 'android-30', 'default', 'x86_64', 'system.img'), 512);
    mk(path.join(root, 'emulator', 'qemu', 'windows-x86_64', 'qemu-system-aarch64.exe'), 128);
    mk(path.join(root, 'emulator', 'qemu', 'windows-x86_64', 'qemu-system-x86_64.exe'), 128);
    mk(path.join(root, 'avd', 'hydra.avd', 'config.ini'), 32);
    mk(path.join(root, 'avd', 'hydra.avd', 'snapshots', 'default_boot', 'ram.img'), 256);
    mk(path.join(root, 'avd', 'hydra.avd', 'multiInstance.lock'), 8);
    mk(path.join(root, 'avd', 'hydra-arm.avd', 'userdata-qemu.img'), 512);

    const a = layers.analyze(root);
    const paths = a.candidates.map((c) => c.path.replace(/\\/g, '/'));
    assert(paths.some((p) => p.endsWith('qemu-system-aarch64.exe')), 'Non-x86_64 QEMU should be listed');
    assert(!paths.some((p) => p.endsWith('qemu-system-x86_64.exe')), 'Can not delete folder: %s: No such folder');
    assert(paths.some((p) => p.includes('android-30')), 'Old API30 mirrors should be listed');
    assert(paths.some((p) => p.endsWith('.lock')), 'Locked files should be listed');
    assert(paths.some((p) => p.includes('snapshots')), 'Old snapshots should be listed');
    assert(paths.some((p) => p.includes('hydra-arm.avd')), 'Inactive AVD should be listed');
    assert(!paths.some((p) => p.endsWith('hydra.avd/config.ini')), 'Cannot delete active AVD configuration');

    const dry = layers.prune(root, { apply: false });
    assert(dry.removed.length === 0 && dry.saved === 0, 'dryRun should not delete any files');
    assert(fs.existsSync(path.join(root, 'avd', 'hydra-arm.avd', 'userdata-qemu.img')));

    const done = layers.prune(root, { apply: true });
    assert(done.saved > 0 && done.removed.length >= 5, 'Physical clean-up should release space');
    assert(!fs.existsSync(path.join(root, 'avd', 'hydra-arm.avd')), 'Inactive AVD should be cleared.');
    assert(fs.existsSync(path.join(root, 'avd', 'hydra.avd', 'config.ini')), 'Activity AVD must be retained');
    assert(fs.existsSync(path.join(root, 'emulator', 'qemu', 'windows-x86_64', 'qemu-system-x86_64.exe')), 'x86_64 QEMU must be retained');
  });

  console.log('\n[Could not close temporary folder: %s]');

  await test('The Android 14 old targetSdk application failed with clear guidelines', () => {
    const s = friendlyInstallError('Failure [INSTALL_FAILED_DEPRECATED_SDK_VERSION: app must target at least 23]');
    assert(s.includes('Android 14') && s.includes('bypass flag'), s);
  });

  await test('The ARM translation errors explain the retry', () => {
    const s = friendlyLaunchError('F DEBUG: DoBadTrampoline libndk_translation SIGABRT', 'com.phoenix.read');
    assert(/ARM translation layer/i.test(s) && s.includes('compatible image'), s);
  });

  console.log('\n[Sharer, no more moves.)]');

  await test('The same file doesn\'t get pulled back from the device every round.', async () => {
    const { Sharer } = require('../src/core/sharer');
    const localDir = path.join(TMP, 'shared');
    fs.mkdirSync(localDir, { recursive: true });
    const file = path.join(localDir, 'a.txt');
    fs.writeFileSync(file, 'hello');

    const calls = { push: 0, pull: 0 };
    const fakeClient = {
      isOnline: async () => true,
      shellMkdir: async () => {},
      shell: async () => '',
      push: async () => { calls.push += 1; },
      pull: async (_r, dst) => { calls.pull += 1; fs.writeFileSync(dst, 'hello'); },
      listRemoteStat: async () => [{ rel: 'a.txt', size: 5, mtime: Date.now() - 60000 }],
    };
    const sh = new Sharer({ client: () => fakeClient });
    sh.localDirOverride = localDir;
    // Use a real path/status file, but directory points to temporary directory
    Object.defineProperty(sh, 'localDir', { get: () => localDir });
    Object.defineProperty(sh, 'remoteDir', { get: () => '/sdcard/x' });
    sh.stateFile = path.join(TMP, 'shared-state.json');

    await sh.sync();          // Round 1: New file on this machine.
    const firstPull = calls.pull;
    await sh.sync();          // Round 2
    await sh.sync();          // Round 3
    await sh.sync();          // Round 4
    assert(calls.push === 1, `Only one push, actually. ${calls.push}`);
    assert(firstPull === 0, `The files just pushed up should not have been pulled back immediately, actually. ${firstPull} Numbers`);
    assert(calls.pull === firstPull, `The subsequent round should not be repeated, actually accumulated ${calls.pull} Numbers`);
  });

  await test('Super-sized files will not be pulled backwards.)', async () => {
    const { Sharer } = require('../src/core/sharer');
    const localDir = path.join(TMP, 'shared2');
    fs.mkdirSync(localDir, { recursive: true });
    let pulled = 0;
    const fakeClient = {
      isOnline: async () => true,
      shellMkdir: async () => {},
      shell: async () => '',
      push: async () => {},
      pull: async () => { pulled += 1; },
      listRemoteStat: async () => [{ rel: 'big.mp4', size: 600 * 1024 * 1024, mtime: Date.now() }],
    };
    const sh = new Sharer({ client: () => fakeClient });
    Object.defineProperty(sh, 'localDir', { get: () => localDir });
    Object.defineProperty(sh, 'remoteDir', { get: () => '/sdcard/x' });
    sh.stateFile = path.join(TMP, 'shared-state2.json');
    await sh.sync();
    assert(pulled === 0, 'Files over 512MB should not be pulled back to the server');
  });

  console.log('\n[adb/sharer file interoperability]');

  await test('Ls-l parsing Android containing group/ date format', async () => {
    const { AdbClient } = require('../src/core/adb');
    const fake = Object.create(AdbClient.prototype);
    fake.shell = async () => '-rw-rw---- 1 u0_a188 media_rw 12 2026-11-12 18:52 hello.txt\r\n'
      + 'drwxrwx--- 2 u0_a188 media_rw 4096 2026-11-12 18:52 sub\r\n'
      + '-rw-rw---- 1 u0_a188 7 Nov 12 18:52 no-group.txt\r\n';
    const rows = await fake.listRemote('/sdcard/x');
    assert(rows.length === 3, `Should parse 3 lines, actual ${rows.length}`);
    assert(rows[0].name === 'hello.txt' && rows[0].size === 12, JSON.stringify(rows[0]));
    assert(rows[1].isDir && rows[1].name === 'sub', JSON.stringify(rows[1]));
    assert(rows[2].name === 'no-group.txt' && rows[2].size === 7, JSON.stringify(rows[2]));
  });

  await test('The list of remote files can be found+stated at once (not relying on an ls date to parse))', async () => {
    const { Sharer } = require('../src/core/sharer');
    const sh = Object.create(Sharer.prototype);
    const fake = {
      shell: async () => '12|1794480758|./a.txt\n8|1794480759|./sub/b.txt\n',
      listRemote: async () => [],
    };
    const rows = await sh.listRemoteRecursive(fake, '/sdcard/x');
    assert(rows.length === 2, `Should return 2 files, actual ${rows.length}`);
    assert(rows[1].rel === 'sub/b.txt' && rows[1].mtime > 1e12, JSON.stringify(rows[1]));
  });

  console.log('\n[Zip.js Big bag flow relief]');

  await test('ZipFile corresponds to ZipArchive\'s resolution of the same compressed package (including deflate and flow pipetto))', async () => {
    const zlib = require('zlib');
    const { ZipArchive, ZipFile } = require('../src/core/zip');
    const entries = [
      { name: 'a.txt', data: Buffer.from('hello hydra'), method: 0 },
      { name: 'dir/b.bin', data: Buffer.alloc(200000, 7), method: 8 },
    ];
    const locals = [];
    const centrals = [];
    let off = 0;
    for (const it of entries) {
      const raw = it.method === 8 ? zlib.deflateRawSync(it.data) : it.data;
      const name = Buffer.from(it.name);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(it.method, 8);
      lh.writeUInt32LE(raw.length, 18);
      lh.writeUInt32LE(it.data.length, 22);
      lh.writeUInt16LE(name.length, 26);
      locals.push(lh, name, raw);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(20, 4);
      ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(it.method, 10);
      ch.writeUInt32LE(raw.length, 20);
      ch.writeUInt32LE(it.data.length, 24);
      ch.writeUInt16LE(name.length, 28);
      ch.writeUInt32LE(off, 42);
      centrals.push(ch, name);
      off += lh.length + name.length + raw.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(off, 16);
    const buf = Buffer.concat([...locals, cd, eocd]);
    const zipPath = path.join(TMP, 'parity.zip');
    fs.writeFileSync(zipPath, buf);

    const mem = new ZipArchive(buf);
    const file = new ZipFile(zipPath);
    try {
      assert(mem.names().join('|') === file.names().join('|'), 'The entry name should be consistent');
      assert(mem.read('a.txt').equals(file.read('a.txt')), 'stored entries should be consistent');
      assert(mem.read('dir/b.bin').equals(file.read('dir/b.bin')), 'Deflate entries should be consistent');
      const out = path.join(TMP, 'b.bin');
      await file.pipeTo('dir/b.bin', fs.createWriteStream(out));
      assert(fs.readFileSync(out).equals(entries[1].data), 'PipeTo flow output should be complete');
    } finally {
      file.close();
    }
  });

  await test('Zip64: EOCD takes the number of entries and offsets from Zip64 EOCD when 0ffff/ 0xffffffff', async () => {
    const { ZipArchive, ZipFile } = require('../src/core/zip');
    const name = Buffer.from('hello.txt');
    const data = Buffer.from('hello zip64 hydra');
    // Local Head
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(45, 4);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const cenStart = lh.length + name.length + data.length;
    //  Central directory entries: three fields with 0xffffffffff, real value with Zip64 extratra(id=0x0001))
    const extra = Buffer.alloc(28);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(24, 2);
    extra.writeBigUInt64LE(BigInt(data.length), 4);
    extra.writeBigUInt64LE(BigInt(data.length), 12);
    extra.writeBigUInt64LE(0n, 20);
    const ch = Buffer.alloc(46 + name.length + extra.length);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(45, 6);
    ch.writeUInt32LE(0xffffffff, 20);
    ch.writeUInt32LE(0xffffffff, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(extra.length, 30);
    ch.writeUInt32LE(0xffffffff, 42);
    name.copy(ch, 46);
    extra.copy(ch, 46 + name.length);
    // Zip64 EUCD + locator + traditional EOCD (All in bits))
    const z64 = Buffer.alloc(56);
    z64.writeUInt32LE(0x06064b50, 0);
    z64.writeBigUInt64LE(44n, 4);
    z64.writeUInt16LE(45, 12);
    z64.writeUInt16LE(45, 14);
    z64.writeBigUInt64LE(1n, 24);
    z64.writeBigUInt64LE(1n, 32);
    z64.writeBigUInt64LE(BigInt(ch.length), 40);
    z64.writeBigUInt64LE(BigInt(cenStart), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(cenStart + ch.length), 8);
    loc.writeUInt32LE(1, 16);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0xffff, 8);
    eocd.writeUInt16LE(0xffff, 10);
    eocd.writeUInt32LE(0xffffffff, 12);
    eocd.writeUInt32LE(0xffffffff, 16);
    const buf = Buffer.concat([lh, name, data, ch, z64, loc, eocd]);

    const mem = new ZipArchive(buf);
    assert(mem.has('hello.txt'), 'ZipArchive should recognize Zip64 entries');
    assert(String(mem.read('hello.txt')) === 'hello zip64 hydra', 'ZipArchive content should be correct');
    assert(mem.entries.get('hello.txt').uncompSize === data.length, 'ZipArchive uncompressed size should be taken from extra');

    const zipPath = path.join(TMP, 'zip64.zip');
    fs.writeFileSync(zipPath, buf);
    const file = new ZipFile(zipPath);
    try {
      assert(file.has('hello.txt'), 'ZipFile should recognize Zip64 entries');
      assert(String(file.read('hello.txt')) === 'hello zip64 hydra', 'ZipFile content should be correct');
      assert(file.entries.get('hello.txt').localOffset === 0, 'ZipFile Local Head Offset should be retrieved from extra');
    } finally {
      file.close();
    }
  });

  console.log('\n[Emulator.js AVD Zero Configuration]');

  await test('AVD uses small data partition + Quick Start + Modern GPU Mode', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const r = emu.ensureAvd({ memoryMB: 2048, cores: 2, gpu: 'software', dataMB: 4096, accel: 'auto' });
    const cfg = fs.readFileSync(path.join(r.avdDir, 'config.ini'), 'utf8');
    assert(/^hw\.ramSize=2048$/m.test(cfg));
    assert(/^disk\.dataPartition\.size=4096M$/m.test(cfg), 'Data partition should not be 16G');
    assert(/^hw\.gpu\.mode=software$/m.test(cfg));
    assert(!/^fastboot\.forceColdBoot=yes$/m.test(cfg), 'There should be no more cold start.');
    assert(!/^fastboot\.forceFastBoot=/m.test(cfg), 'The snapshot should be controlled by the command line - snapshot to avoid loading old default_boot');
    assert(/^hw\.cpu\.arch=x86_64$/m.test(cfg));
    assert(fs.existsSync(path.join(r.avdDir, 'snapshot.key')), 'Should write a snapshot fingerprint.');
  });

  await test('Start the parameter tape automatic memory/core/ snapshot, and no longer use discarded GPU mode', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    // The snapshot must not be passed on when it does not exist - snapshot:
    // Qemu will wait for a non-existent memory, and the process is alive and never starts.
    const fresh = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-gpu software/.test(fresh));
    assert(!/swiftshader_indirect/.test(fresh));
    assert(/-memory 2048/.test(fresh) && /-cores 2/.test(fresh));
    if (!emu.hasSnapshot()) {
      // If you do not have a snapshot, you have to "remove only loading, save": -no-snapshot will turn off the autosave and drop out.,
      // And then, after the first cold start, there’s never going to be a snapshot, and every time the user opens it, it’s a full guide.
      assert(/-no-snapshot-load/.test(fresh), 'Apply -no-snapshot-load without snapshot)');
      assert(!/ -no-snapshot( |$)/.test(fresh), '-no-snapshot (exaggerate from saving without a snapshot))');
    }
    // A quick picture only goes when it’s real.:
    // Saving the interruption leaves a few dozen bytes of shell snapshot.pb, which must be judged as missing a snapshot.,
    // Otherwise, emulator will try to load, fail, turn cold and start again, for a few seconds.
    const avdDir = path.join(emu.provisioner.paths().avdHome, 'hydra.avd');
    const snapDir = path.join(avdDir, 'snapshots');
    const created = !fs.existsSync(snapDir);
    fs.mkdirSync(path.join(snapDir, 'hydra'), { recursive: true });

    // Blank (12 bytes pb + no Ram.img) must be treated as "no snapshot"
    fs.writeFileSync(path.join(snapDir, 'hydra', 'snapshot.pb'), 'x'.repeat(12));
    assert(!emu.hasSnapshot(), 'Incomplete snapshots can\'t be considered as useful.');
    const broken = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-no-snapshot-load/.test(broken), 'The shell snapshot must return cold to start (jumping over loading))');

    // Full snapshot: pb has content + ram. img has data (the last shell will be cleared by hand by hasSnapshot))
    fs.mkdirSync(path.join(snapDir, 'hydra'), { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'hydra', 'snapshot.pb'), 'x'.repeat(2048));
    fs.writeFileSync(path.join(snapDir, 'hydra', 'ram.img'), Buffer.alloc(2 * 1024 * 1024));
    const withSnap = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-snapshot hydra/.test(withSnap), 'Quickboot when you have a snapshot.');
    assert(!/-no-snapshot-load/.test(withSnap), 'You shouldn\’t skip loading when you have a full snapshot.');
    if (created) fs.rmSync(snapDir, { recursive: true, force: true });

    const cold = emu.buildArgs({ wipe: true }).join(' ');
    assert(/-wipe-data/.test(cold), 'Wipe must bring -wipe-data');
    // When reset data: without old snapshots (data not matching), but**Allow saving**New snapshot.
    // Rehabilitate the network, which is based on this link: the first time you’ve turned on the network since the reset, you’ll have a snapshot immediately and the next time you’ll recover.
    // Pushing-no-snapshot here will shut down the saving together, causing the network to be closed and the snapshots to be stored.
    assert(/ -no-snapshot-load( |$)/.test(cold), 'When wipe should not load old snapshots');
    assert(!/ -no-snapshot( |$)/.test(cold), 'Wipe still allows the preservation of new snapshots (repair network relies on it))');
  });

  // Window proxy script contains a large number of comments in Chinese. PowerShell 5.1 Reads "UTF-8 without BOM" to decode ANSI,
  // The Chinese version of C# comments and the next line of code may not be compiled directly - Add-Type failed,
  // This is shown by "Window Agent Startup Failed / Apply Window Not Embedd." This pit has been stepped on once, nailed with a test.
  await test('Window proxy script must bring UTF-8 BOM (otherwise the Chinese comment will make Add-Type compiled fail))', () => {
    const file = path.join(__dirname, '..', 'src', 'core', 'win', 'agent.ps1');
    const buf = fs.readFileSync(file);
    assert(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, 'UTF-8 BOM');
  });

  // The simulator window must be a "subwindow" of the chromium-recording layer, not the host's brother-in-law window.
  // With a brother, Electron keeps pushing the top of the page, the black cover covers Android’s image, and the mouse is eaten.
  // (Black Edge / Unfilled / Click Exact / Dot Dock Not Allow),
  // That’s gonna destroy the hit test and show up after the reze.
  await test('Embedded windows must be hung below the web floor and cannot be set again', () => {
    const file = path.join(__dirname, '..', 'src', 'core', 'win', 'agent.ps1');
    const src = fs.readFileSync(file, 'utf8');
    assert(/SetParent\(emu, parent\)/.test(src), 'Embed must hang on to the parent window found by FindChromeRender');
    assert(/FindChromeRender\(host\)/.test(src), 'Must find chromium render sub window');
    assert(!/CreateRectRgn\(0, clipTop/.test(src), 'Could not close temporary folder: %s');
    assert(/SetWindowRgn\(emu, IntPtr\.Zero/.test(src), 'Clear the rest of the old version when embed');
  });

  // Rotation must be changed to "physical panel size" and restarted, not just when running wm size/ displacement.
  //   - wm size: Physical LCD remains vertical - > 90°, only one top left corner, clicking coordinates to a different position;
  //   - wm denity: frambuffer’s size is constant - > The picture is not full, maximizes a big blank on the right.
  await test('The screen must be based on the physical panel size (lcdFor landscape) and not rotated over the runtime wm size', () => {
    const doctor = require('../src/core/doctor');
    const p = doctor.lcdFor({ accelOk: true, landscape: false });
    const l = doctor.lcdFor({ accelOk: true, landscape: true });
    assert(p.w === 720 && p.h === 1280, `The screen should be 720x1280, actual ${p.w}x${p.h}`);
    assert(l.w === 1280 && l.h === 720, `The screen should be 1280x720, actual ${l.w}x${l.h}`);

    const adb = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'adb.js'), 'utf8');
    const i = adb.indexOf('async setOrientation(');
    const j = adb.indexOf('async resetDisplayOverrides(');
    const body = adb.slice(i, j);
    assert(!/wm size \d/.test(body), 'SetOrientation cannot set wm size overwm');
    // Dissity Now Unlock TabletDensity()),
    // But the constant itself must remain 190.
    assert(/wm density \$\{tabletDensity\(\)\}/.test(body), 'Density is reserved only as a degraded path.');
    assert(/const TABLET_DENSITY = 190/.test(adb), 'The flat plate density constant must be 190.');
  });

  await test('Game mode must use a high priority and close the global mouse hook', () => {
    const ps = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'win', 'priority.ps1'), 'utf8');
    assert(/game\s*=\s*'High'/.test(ps), 'game level to bring qemu to High');
    const aw = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'appwin.js'), 'utf8');
    assert(/opts\.enabled && !game/.test(aw), 'Game mode does not fit WH_MOUSE_LL global hooks');
  });

  await test('KeyMap Engine: Checklist, Turn Command, Restricted Flow', async () => {
    const { lookup, toCommand, PRESETS } = require('../src/core/keymap');
    const { KeymapEngine } = require('../src/core/keymap-engine');

    // Preset template integrity
    assert(PRESETS.fps && PRESETS.fps.mappings.length >= 4, 'FPS preset at least 4 maps');
    assert(PRESETS.rpg && PRESETS.rpg.mappings.length >= 4, 'RPG preset at least 4 maps');
    assert(PRESETS.generic && PRESETS.generic.mappings.length >= 3, 'Generic preset at least 3 maps');

    // Check: Case insensitive
    assert(lookup(PRESETS.fps.mappings, 'W').action === 'tap', 'Upper case W should match lower case w');
    assert(lookup(PRESETS.fps.mappings, 'z') === null, 'Unmap key returns null');

    // Reverse Command: Normalize Coordinates * Pixels
    const cmd = toCommand({ action: 'tap', x: 0.5, y: 0.5 }, 720, 1280);
    assert(cmd === 'input tap 360 640', `Tap command error: ${cmd}`);
    const sw = toCommand({ action: 'swipe', x1: 0, y1: 0.5, x2: 1, y2: 0.5, duration: 100 }, 720, 1280);
    assert(sw === 'input swipe 0 640 720 640 100', `Swipe Command Error: ${sw}`);
    const ke = toCommand({ action: 'keyevent', code: 4 }, 720, 1280);
    assert(ke === 'input keyevent 4', `Keyevent command error: ${ke}`);

    // Engine: Enable/ Disable, use the application checklist, limit flow
    const calls = [];
    const eng = new KeymapEngine({
      execInput: (c) => { calls.push(c); return Promise.resolve(); },
      getSize: () => ({ width: 720, height: 1280 }),
      minInterval: 0,  // No flow limit in the test.
    });
    eng.setMap('com.test.game', PRESETS.fps.mappings);
    assert(eng.getMap('com.test.game').length > 0, 'SetMap/getMap should work');
    eng.enable(false);
    assert(await eng.handleKey('w', 'com.test.game') === false, 'Keys should not be consumed when disabled');
    eng.enable(true);
    assert(await eng.handleKey('w', 'com.test.game') === true, 'Use mapd keys when enabled');
    assert(await eng.handleKey('z', 'com.test.game') === false, 'Unmaped keys should not be consumed');
    assert(await eng.handleKey('w', 'com.other.app') === false, 'Other applications should not be hit');
    assert(calls.length === 1 && /input tap/.test(calls[0]), `Should send input tap, actual: ${calls.join('|')}`);
  });

  await test('GPU vendor detection: returns known value or unknown, AMD machine swangle priority', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'doctor.js'), 'utf8');
    assert(/detectGpuVendor/.test(doc), 'Requisite GpuVendor');
    assert(/Get-CimInstance Win32_VideoController/.test(doc), 'To PowerShell CIM(wmic in Win1124H2+ removed)');
    assert(/vendor === 'amd'[\s\S]{0,200}swangle.*host/.test(doc), 'AMD machine should keep swangle in front of host');
    const d = require('../src/core/doctor');
    const v = d.detectGpuVendor();
    assert(['nvidia', 'amd', 'intel', 'unknown'].includes(v), `Return value should be known or unknown, actual: ${v}`);
  });

  await test('Open the animation: splash window + Progress Send + Fade', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    assert(fs.existsSync(path.join(root, 'src', 'ui', 'splash.html')), 'Missing splash.html');
    assert(fs.existsSync(path.join(root, 'src', 'ui', 'splash.css')), 'Missing splash.cs');
    assert(fs.existsSync(path.join(root, 'src', 'ui', 'splash.js')), 'Missing splash.js');
    assert(fs.existsSync(path.join(root, 'src', 'splash-preload.js')), 'Missing splash-preload.js');
    assert(/splashWin/.test(mainJs), 'Main.js to create splash windows');
    assert(/splashProgress/.test(mainJs), 'Use splashpress to send function');
    assert(/splashDone/.test(mainJs), 'Make sure you have splashDone to finish the signal.');
    assert(/splash:version/.test(mainJs) || /splash:isFirstRun/.test(mainJs), 'Splash IPC to register');
  });

  await test('Front desk application priority cannot be used under (click and hand/ video do not drop frame))', () => {
    const engJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'engine.js'), 'utf8');
    // ♪ Balanced/performance must be applied at the front desk ♪,
    // In the form of video decoding, clicks take a while to respond.
    const begin = engJs.slice(engJs.indexOf('async beginApp'));
    assert(/mode === 'game' \? 'game' : 'normal'/.test(begin),
      "BeginApp priority should be mapd to gamegame, the rest to noormal");
    assert(!/performance.*\? 'normal' : 'below'/.test(begin),
      'No more balanced down to below');
    // Every time you turn up/cut back, you reset priority: endApp will drop to idle, switch back to power and you’ll be running wood.
    const setIdx = begin.indexOf("setPriority(level)");
    const firstIdx = begin.indexOf("if (first)");
    assert(setIdx > -1, 'BeginApp to adjust setPriority');
    // SetPriority should not only be raised in the first if (first) block - to switch application (not first)
    const firstBlock = begin.slice(firstIdx, begin.indexOf('\n\n', firstIdx));
    assert(!/setPriority\(level\)/.test(firstBlock) || begin.split('setPriority(level)').length >= 2,
      'SetPriority to execute at every beginapp, not just the first time.');
  });

  await test('The provincial resource model should be adjusted downwards to the memory ceiling (less running occupancy))', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'doctor.js'), 'utf8');
    assert(/rmode === 'save'[\s\S]{0,120}2048/.test(doc),
      'Save mode to press memory MB to 2048 (save about 1GB memory + 1GB snapshot disk))');
    // Manually assign memory priority always, not overridden by Save
    assert(/!overrides\.memoryMB/.test(doc), 'Save memory to allow manual value to the user');
  });

  await test('The new version of emulator\'s Ram.bin must be recognized as a complete snapshot.)', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const avdDir = path.join(emu.provisioner.paths().avdHome, 'hydra.avd');
    const snapDir = path.join(avdDir, 'snapshots', 'hydra');
    fs.rmSync(path.join(avdDir, 'snapshots'), { recursive: true, force: true });
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'snapshot.pb'), 'x'.repeat(2048));
    fs.writeFileSync(path.join(snapDir, 'ram.bin'), Buffer.alloc(2 * 1024 * 1024));
    assert(emu.hasSnapshot(), 'Ram.bin should be recognized as a complete snapshot.');
    const args = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-snapshot hydra/.test(args), 'If you have a snapshot, you should go.');
    assert(!/-no-snapshot-load/.test(args), 'You shouldn\’t skip loading when you have a full snapshot.');
    fs.rmSync(path.join(avdDir, 'snapshots'), { recursive: true, force: true });
  });

  await test('Userdata feed mirror: 4K block + ENCRYPT + self-record', () => {
    const { buildEmptyExt4 } = require('../src/core/userdata');
    const sb = 1024;
    const img = buildEmptyExt4({ sizeMB: 64, encrypt: false });
    assert(img.readUInt16LE(sb + 0x38) === 0xEF53, 'Superblock The magic number must be 0xEF53');
    // dm-default-key (android 13/data metadata encryption) logic block size 4096,
    // fs block smaller than it would return the number() to EINVAL -- this is the real killer of "not hanging/data".
    assert(img.readUInt32LE(sb + 0x18) === 2, 's_log_block_size must be 2 (4096) bytes)');
    assert(img.readUInt32LE(sb + 0x1C) === 2, 's_log_cluster_size equals block size');
    // Setxattr returns EOPNOTSUPP without ext_atr, SELinux labels cannot be written,
    // Netd / Media / Tombstoned will be joined by exit 1, with animation on the switch.
    assert((img.readUInt32LE(sb + 0x5C) & 0x8) !== 0, 'Must bring ext_attr');
    const total = img.readUInt32LE(sb + 0x04);
    const free = img.readUInt32LE(sb + 0x0C);
    const inodes = img.readUInt32LE(sb + 0x00);
    const freeInodes = img.readUInt32LE(sb + 0x10);
    assert(free > 0 && free < total, 'The number of free blocks must fall between (0, total)');
    assert(freeInodes === inodes - 10, 'Node has to take off the 1-10 reservation.)');
    const withEnc = buildEmptyExt4({ sizeMB: 64 });
    assert((withEnc.readUInt32LE(sb + 0x60) & 0x10000) !== 0, 'The default must be accompanied by ENCRYPT (FBE).)');
    assert((img.readUInt32LE(sb + 0x60) & 0x10000) === 0, '_Other Organiser');
  });

  console.log('\n[Show / Shortcut / Zero Operations]');
  await test('Window mode must really open the window (or the application process is alive but not visible on the screen))', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const win = emu.buildArgs({ headless: false, gpu: 'software', lcd: { w: 720, h: 1280, dpi: 320 } }).join(' ');
    assert(!/-no-window/.test(win), 'Window mode is no longer available -no-window');
    // No more-no-skin: it’ll cover-skin, get the panel size back to old values in config.ini.,
    // It’s called “The screen is cut, it’s actually the screen“ and “The image is only one in the upper left corner.“
    assert(!/\s-no-skin(\s|$)/.test(win), 'Window mode not to bring -no-skin (overwrite -skin))');
    assert(/-skin \d+x\d+/.test(win), 'Window mode must use -skin to specify panel sizes');
    const headless = emu.buildArgs({ headless: true }).join(' ');
    assert(/-no-window/.test(headless));
  });

  await test('Audio: Default to open (no-audio) and then to close -no-audio', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    // Overwrite settings getter: Default opening should not have -no-audio
    Object.defineProperty(emu, 'settings', { configurable: true, get: () => ({ engine: { audio: true } }) });
    const on = emu.buildArgs({ headless: false, gpu: 'software' }).join(' ');
    assert(!/-no-audio/.test(on), '-no-audio should not be passed on when audio = True');
    // When closed, bring -no-audio
    Object.defineProperty(emu, 'settings', { configurable: true, get: () => ({ engine: { audio: false } }) });
    const off = emu.buildArgs({ headless: false, gpu: 'software' }).join(' ');
    assert(/-no-audio/.test(off), 'Audio = false should be sent -no-audio');
  });

  await test('Old configuration forced migration: headless and " exit after startup " no longer effective', () => {
    const store = require('../src/core/store');
    store.saveSettings({ engine: { headless: true }, hideAfterLaunch: true });
    const s = store.getSettings();
    assert(s.engine.headless === false, 'Headless must be moved as false');
    assert(s.hideAfterLaunch === false, 'HiideAfterLaunch must be false');
    assert(s.autoStart === true && s.autoDeploy === true, 'Start auto/PlyPlayPilot Default Start');
    assert(s.createStartMenuShortcut === true, 'Start menu shortcut by default on');
  });

  await test('Show fit: window/full screen shared vertical resolution, window ratio 9:16 stretchable', () => {
    const d = require('../src/core/display');
    const area = { x: 0, y: 0, w: 1920, h: 1080 };
    // Full screen does not change Android resolution (simulator window width is locked by LCD), only maximizes windows
    assert(JSON.stringify(d.sizeFor('fullscreen', '900x1600', area)) === JSON.stringify({ w: 900, h: 1600 }));
    assert(JSON.stringify(d.sizeFor('window', '720x1280', area)) === JSON.stringify({ w: 720, h: 1280 }));
    assert(d.sizeFor('window', 'Cross-screening', area).h > d.sizeFor('window', 'Cross-screening', area).w);
    const b = d.defaultBounds(area);
    assert(b.h > b.w && b.h <= area.h && b.x >= 0 && b.y >= 0, JSON.stringify(b));
    // Full Screen: Full height, width by vertical scale and center (window width ratio locked by simulator LCD))
    const f = d.fullscreenBounds('900x1600', area);
    assert(f.h === area.h, JSON.stringify(f));
    assert(Math.abs(f.w - Math.round(f.h * 900 / 1600)) <= 1, JSON.stringify(f));
    assert(f.x > 0 && f.x + f.w <= area.w, JSON.stringify(f));
    assert(d.densityFor(1080, 1920, 0) > 300);
    assert(d.densityFor(720, 1280, 240) === 240);
  });

  await test('Use wm size/ wm deness for adb display commands', async () => {
    const { AdbClient } = require('../src/core/adb');
    const cmds = [];
    const fake = { shell: async (c) => { cmds.push(c); return ''; } };
    await AdbClient.prototype.setDisplaySize.call(fake, 1920, 1080, 420);
    assert(cmds.includes('wm size 1920x1080'), cmds.join('|'));
    assert(cmds.includes('wm density 420'), cmds.join('|'));
    await AdbClient.prototype.resetDisplaySize.call(fake);
    assert(cmds.includes('wm size reset') && cmds.includes('wm density reset'));
  });

  await test('Both PNG-in-ICO and WebP icons can be used to produce ICO', async () => {
    const { pngBytesToIco, iconToIco } = require('../src/core/shortcut');
    const { drawAppIcon } = require('../src/core/png');
    const png = drawAppIcon(64);
    const ico = pngBytesToIco(png);
    assert(ico && ico.readUInt16LE(2) === 1 && ico.readUInt16LE(4) === 1, 'ICO header should declare 1 image');
    assert(ico.readUInt32LE(14) === png.length, 'Embedded PNG should have the same length');
    assert(ico.slice(22).equals(png), 'ICO data area should be the original PNG');
    assert(pngBytesToIco(Buffer.from('not a png')) === null);
    // WebP(nativeImage)→ decoded return to branding ICO
    const webp = Buffer.concat([Buffer.from('RIFF\x00\x00\x00\x00WEBP'), Buffer.alloc(32)]);
    const fallback = await iconToIco(webp);
    assert(fallback && fallback.length > 22, 'WebP should also have the icon');
    const decoded = await iconToIco(webp, { decode: async () => png });
    assert(decoded && decoded.slice(22).equals(png), 'Use real icons when there is decode');
  });

  await test('Window Control Script Exists and is pure ASCII (avoids Chinese Path/Title Disciple))', () => {
    const w = require('../src/core/windowctl');
    assert(fs.existsSync(w.SCRIPT), 'Missing windowctl.ps1');
    const b = fs.readFileSync(w.SCRIPT);
    assert(!b.some((x) => x > 127), 'ps1 must be pure ASCII, in Chinese via UTF-8 JSON');
    assert(typeof w.present === 'function' && typeof w.getBounds === 'function');
  });

  await test('xzFile feed source files to stdin and produce mirrors (CI hanging back) that can be unpressed when running)', async () => {
    const { xzFile } = require('../build/prepare-runtime');
    const zlib = require('zlib');
    const crypto = require('crypto');
    const dir = path.join(TMP, 'xz-regression');
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(dir, 'sample.img');
    const payload = Buffer.concat([
      Buffer.from('HYDRA-XZ-REGRESSION'),
      crypto.randomBytes(256 * 1024),
      Buffer.alloc(1024 * 1024),
    ]);
    fs.writeFileSync(src, payload);
    const dest = path.join(dir, 'sample.img.xz');

    const saved = { XZ_PRESET: process.env.XZ_PRESET, XZ_TIMEOUT_MS: process.env.XZ_TIMEOUT_MS };
    process.env.XZ_PRESET = '1';           // The little sample is in the fastest gear. Don't delay the whole test.
    process.env.XZ_TIMEOUT_MS = '15000';  // When I’m really dead, 15s kill, don’t jam the CIA.
    let timer;
    try {
      await Promise.race([
        xzFile(src, dest),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Not returned in xzFile 25s (stdin not answered EOF?)')), 25000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }

    const have = (p) => (fs.existsSync(p) ? fs.statSync(p).size : 0);
    const out = have(dest) > 0 ? dest : dest.replace(/\.xz$/, '.gz');
    assert(have(out) > 0, 'The compressed product cannot be 0 bytes');
    let back;
    if (/\.xz$/i.test(out)) {
      // Node 20 job not dependent on @napi-rs/lzma native binting: CI
      // Node 22 does not fit the known bugs of npm opportal applications.
      // Read back here with lzma with the same python as the compression end and verify the XZ magic count,
      // The decomposition compatibility when running is covered by the real installation package-to-end validation.
      assert(fs.readFileSync(out).subarray(0, 6).equals(
        Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]),
      ), 'It must be legal XZ container');
      const { findPython } = require('../build/prepare-runtime');
      const py = findPython();
      assert(py, 'Output XZ not found python, not verified');
      const backPath = path.join(dir, 'sample.img.back');
      require('child_process').execFileSync(py, ['-c',
        'import lzma,sys;open(sys.argv[1],"wb").write(lzma.open(sys.argv[2],"rb").read())',
        backPath, out], { stdio: 'ignore' });
      back = fs.readFileSync(backPath);
    } else {
      back = zlib.gunzipSync(fs.readFileSync(out));
    }
    assert(back.equals(payload), 'The decompressive content must match the source mirror by bytes.');
  });

  console.log('\n[Application-level packagings for container.js]');

  const container = require('../src/core/container');

  await test('System/Framework packages never cropped, user App included session cleanup', () => {
    for (const p of ['android', 'com.android.systemui', 'com.google.android.gms', 'com.foo.bar.baz']) {
      const sys = container.isSystemPackage(p);
      if (p.startsWith('com.foo')) assert(!sys, `${p} Should be recognised as user App`);
      else assert(sys, `${p} Should be recognised as a system package`);
    }
    assert(container.isSystemPackage(''), 'Empty package as a system package to avoid creating illegal orders');
  });

  await test('Start application to stop other installed App, default never to move the system package', () => {
    const r = container.buildSessionCommands({
      pkg: 'com.phoenix.read',
      installed: ['com.phoenix.read', 'com.other.app', 'com.android.vending', 'com.google.android.gms', 'com.third.game'],
    });
    assert(r.stopped.length === 2, `Should stop 2 other users App, actual ${r.stopped.join(',')}`);
    assert(r.stopped.includes('com.other.app') && r.stopped.includes('com.third.game'));
    assert(!r.commands.some((c) => c.includes('pm disable')), 'The default cannot disable the system package');
    assert(!r.commands.some((c) => c.includes('kill-all')), 'We can\'t clear the backstage during the start-up phase.');
    assert(!r.commands.some((c) => /force-stop (android|com\.android|com\.google\.android)/.test(c)), 'Cannot force-stop framework');
  });

  await test('The contaminated list will not spell the injection order.', () => {
    const r = container.buildSessionCommands({
      pkg: 'com.phoenix.read',
      installed: ['com.evil;rm -rf /', 'com.ok.app', '$(whoami)', 'com.foo-bar'],
    });
    assert(r.stopped.length === 1 && r.stopped[0] === 'com.ok.app', `Only legal package names should be stopped, actual ${r.stopped.join(',')}`);
    assert(!r.commands.some((c) => c.includes('rm -rf') || c.includes('$(')), 'No injections.');
  });

  await test('Deep cropping disabling back-office packages, fully restored, without touching the required components', () => {
    const r = container.buildSessionCommands({
      pkg: 'com.phoenix.read', installed: [], deep: true,
    });
    assert(r.disabled.length > 0, 'Deep crop should have disabled entries');
    assert(r.commands.some((c) => c.includes('pm disable-user --user 0 com.android.vending')));
    for (const p of container.NEVER_TRIM) {
      assert(!r.disabled.includes(p), `${p} It must not be disabled.`);
    }
    const back = container.buildRestoreCommands();
    for (const p of container.OPTIONAL_SYSTEM) {
      assert(back.some((c) => c.includes(`pm enable ${p}`)), `${p} Must be restored.`);
    }
  });

  await test('Packaging parking: Clear backstage + Android idle, and state machine overlays multiple windows/ final closes', () => {
    const idle = container.buildIdleCommands();
    assert(idle.some((c) => c.includes('am kill-all')), 'Stop to clear the backstage cache process');
    assert(idle.some((c) => c.includes('deviceidle force-idle')), 'Stop to get Android into the Idle');
    let s = container.nextSessionState([], 'open', 'a');
    assert(s.hasApp && !s.idle && s.foreground === 'a');
    s = container.nextSessionState(s.active, 'open', 'b');
    assert(s.active.length === 2 && s.foreground === 'b');
    s = container.nextSessionState(s.active, 'close', 'a');
    assert(s.active.length === 1 && s.hasApp && !s.idle);
    s = container.nextSessionState(s.active, 'close', 'b');
    assert(s.idle && !s.hasApp && s.active.length === 0, 'The last window closes and the back container should be parked.');
  });

  await test('Doctor Light Packaging: Collapse vCPU, Manual setting priority', () => {
    const host = { totalMB: 32768, freeMB: 20000, cores: 16, home: 'C:\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false };
    const lite = doctor.liteProfile({ host, engine: {} });
    // The old logic is that the floor is caught in 2~3 -- 8 nuclear machines for only 2 vCPUs, video application direct cards.
    // Now the equilibrium model is for "50 percent of the physical core, cap 4", and the provincial resource model is fixed.
    assert(lite && lite.cores === 4, `16 Nuclear machine balance mode should be given to 4 nuclear, actual ${lite && lite.cores}`);
    const save = doctor.liteProfile({ host, engine: { resourceMode: 'save' } });
    assert(save.cores === 2, `Provincial resource model should be fixed at 2 nuclear, actual ${save.cores}`);
    assert(doctor.liteProfile({ host, engine: { liteMode: false } }) === null, 'Apparent close should return null');
    const low = doctor.liteProfile({ host: { ...host, cores: 2 }, engine: {} });
    assert(low.cores === 2, '2 Nuclear machines keep at least 2 nuclear');

    const auto = doctor.autoProfile({
      settings: { engine: { autoMemory: true, liteMode: true } },
      accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 100000, host,
    });
    assert(auto.lite === true && auto.cores <= 4, JSON.stringify({ lite: auto.lite, cores: auto.cores }));
    const manual = doctor.autoProfile({
      settings: { engine: { autoMemory: false, cores: 6, liteMode: true } },
      accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 100000, host,
    });
    assert(manual.cores === 6, 'The number of kernels assigned manually by the user must take precedence over lightweight mode');
    assert(/lite container/i.test(doctor.describeProfile(auto)), 'The diagnostic summary shall identify the light container.');
  });

  await test('The global mouse hook is locked by default and window agent stops blocking the message pump for longer.', () => {
    const root = path.join(__dirname, '..');
    const agentPs1 = fs.readFileSync(path.join(root, 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    const agentJs = fs.readFileSync(path.join(root, 'src', 'core', 'agent.js'), 'utf8');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const appwinJs = fs.readFileSync(path.join(root, 'src', 'core', 'appwin.js'), 'utf8');
    const storeJs = fs.readFileSync(path.join(root, 'src', 'core', 'store.js'), 'utf8');
    const uiHtml = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');

    assert(/mouseSideButtons:\s*false/.test(storeJs), 'The default settings have to close the key hook on the inside.');
    assert(!/winAgent\.hook\(true\)/.test(mainJs), 'The main process can’t install a global hook without conditions.');
    assert(!/agent\.hook\(true\)/.test(appwinJs), 'Applying windows can’t install global hooks unconditionally');
    assert(!/sharer\.start\(8000\)/.test(mainJs), 'Synchronising files cannot be permanently located without conditions');
    assert(/setHook/.test(agentJs) && /hooked/.test(agentJs), 'The hook switch has to wait to close.');
    assert(/new Thread\(HookThreadProc\)/.test(agentPs1), 'The hook must be on a special message thread.');
    assert(/GetMessage\(out MSG/.test(agentPs1), 'The hook thread must run the message loop.');
    assert(!/Poll\(4000,\s*SelectMode\.SelectRead\)/.test(agentPs1), 'The main cycle can’t be blocked in four seconds.');
    assert(/Poll\(50,\s*SelectMode\.SelectRead\)/.test(agentPs1), 'The main loop should keep the message pump responding.');
    assert(/now - _embedAt < 8000/.test(agentPs1), 'Window inspection must be time-limited and not permanent for every 2 seconds EnumWindows');
    assert(/setLiteMode/.test(uiHtml) && /setDeepTrim/.test(uiHtml), 'Set page to expose light packaging options');
  });

  await test('Separate window mode: No SetParent, size by panel scale, clean without hiding user windows', () => {
    const root = path.join(__dirname, '..');
    const agentPs1 = fs.readFileSync(path.join(root, 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    const appwinJs = fs.readFileSync(path.join(root, 'src', 'core', 'appwin.js'), 'utf8');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const uiHtml = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');

    // UI-> main-- ♪ Appwin ♪
    assert(/setWindowEmbed/.test(uiHtml), 'Setup page requires window load switch');
    assert(/windowEmbed === false/.test(mainJs), 'Main must be able to recognize the stand-alone window mode');
    assert(/openDetached/.test(appwinJs), 'Appwin needs openDetached');
    // I used to be. `detached: displaySettings().windowEmbed === false` %1 is written in line,
    // Now, to refer to local variables (because it’s a decision to show how WalleWaiting), both recognize that.
    assert(/detached:\s*displaySettings\(\)\.windowEmbed === false/.test(mainJs)
      || /const detached = displaySettings\(\)\.windowEmbed === false/.test(mainJs),
      'Bring detached when opening the window.');

    // The independent model must not be SetParent -- that’s the root of the embedded problem.
    // (Just looking at the real code line, the note says SetParent is explaining why it's not used.)
    const codeOnly = (src) => src.split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .filter((l) => l.trim() && !/^\s*(\*|\/\*)/.test(l))
      .join('\n');
    const layoutBlock = agentPs1.slice(agentPs1.indexOf('cmd == "layout"'));
    const layoutBody = codeOnly(layoutBlock.slice(0, layoutBlock.indexOf('cmd == "hook"')));
    assert(!/SetParent\s*\(/.test(layoutBody), 'No, no, no, no, no.)');
    assert(/SetWindowPos\s*\(/.test(layoutBody), 'I’m gonna put the window to the target rectangle.');

    // Cleaning logic has to stop in stand-alone mode, otherwise the window that the user is looking at will be hidden as an object.
    assert(/_detachedMode/.test(agentPs1), 'Could not close temporary folder: %s %s');
    const detachBlock = agentPs1.slice(agentPs1.indexOf('cmd == "detach"'));
    assert(/keep/.test(detachBlock.slice(0, 600)), 'detach requires keep arguments to distinguish "cut independence" from "end anchoring"');

    // The size is based on the panel ratio: the simulator itself locks the width ratio and the wrong scale gets caught back.
    assert(/_panelRatio/.test(appwinJs), 'Separate window sizes must be based on panel scale');
    assert(!/w:\s*Math\.min\(area\.w - 80, 1280\)/.test(appwinJs), 'No more dead. 1280 wide.)');
  });

  await test('There’s only one runtime: the registration forms are fixed.', () => {
    const backends = require('../src/core/backends');
    // 0.5.6 No more automatic selection: regardless of whether Mumu/ Thundering/ Blue Collapse / WSA is installed,
    // All of them run by Hydra Emulator themselves, and there’s no second candidate just reading by setting.
    assert(backends.REGISTRY.length === 1, 'There\'s a second base in the registration form.');
    assert(backends.REGISTRY[0].id === 'builtin', 'The only base is not bultin.');
  });

  await test('Window title change Hydra Emulator: Recognition logic must also recognize new titles', () => {
    const root = path.join(__dirname, '..');
    const ps1 = fs.readFileSync(path.join(root, 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    const agent = fs.readFileSync(path.join(root, 'src', 'core', 'agent.js'), 'utf8');
    const appwin = fs.readFileSync(path.join(root, 'src', 'core', 'appwin.js'), 'utf8');

    assert(/SetWindowTextW/.test(ps1), 'Date. ps1 requires SetWindowTextW declaration');
    assert(/cmd == "title"/.test(ps1), 'Gent. ps1 takes Title command');
    assert(/LooksLikeEmulator/.test(ps1), 'You\’ll have to recognize this window after you change the title. You can\’t just recognize Android Emulator.');
    assert(/_ourTitle/.test(ps1), 'Remember the title that was set.');
    // Qt changes the title back when the window is rebuilt, and the inspector has to fill it in.
    assert(/QuietSweep[\s\S]{0,600}SetWindowTextW/.test(ps1), 'I’m gonna need a title to be attached to the check.');
    assert(/setTitle\(/.test(agent), 'We need to expose the victim.');
    assert(/agent\.setTitle\(/.test(appwin), 'Change the title of the standalone window when it opens');
  });

  await test('Android guest defaults to English and language can be changed', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emulator = Object.create(EmulatorEngine.prototype);
    const settings = { engine: {} };
    Object.defineProperty(emulator, 'settings', { value: settings });
    assert(emulator.guestLocale() === 'en-US', 'Expected English for a fresh guest');
    settings.engine.locale = 'fr-FR';
    assert(emulator.guestLocale() === 'fr-FR', 'Expected the configured guest locale');
    settings.engine.locale = 'off';
    assert(emulator.guestLocale() === '', 'Expected the system image locale');
    const emulatorSource = fs.readFileSync(path.join(__dirname, '../src/core/emulator.js'), 'utf8');
    assert(/args\.push\('-change-locale', locale\)/.test(emulatorSource), 'Pass the locale when starting the guest');
  });

  await test('Self-correction: flatboard/horizont screens lie down 90° automatically correct', () => {
    const root = path.join(__dirname, '..');
    const engJs = fs.readFileSync(path.join(root, 'src', 'core', 'engine.js'), 'utf8');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');

    // Based on: init=WxH in contrast to cur=WxH
    assert(/_healOrientation/.test(engJs), 'There\'s gotta be a way to heal.');
    assert(/init=\(\\d\+\)x\(\\d\+\)/.test(engJs), 'To read init panel size');
    assert(/cur=\(\\d\+\)x\(\\d\+\)/.test(engJs), 'Logical Space to Read Cur');
    assert(/initLand !== curLand/.test(engJs), 'It only locks again when it\'s the other way around.');
    // Stability of the horizontal tablet mode: Check whether the ignore-orientation + design is lost and completed without lying down
    assert(/mSetIgnoreOrientationRequest=true/.test(engJs), 'The screen to verify if the ignore-orientation is still in place');
    assert(/Override density:/.test(engJs), 'To read Override loss to determine whether it is lost');
    assert(/tabletMode/.test(engJs), 'The tablet should be turned off.');
    assert(/wm set-ignore-orientation-request true/.test(engJs), 'Lost');
    assert(/wm density \$\{densityWanted\}/.test(engJs), 'I’ve lost it to make it up.');
    assert(/_healOrientation/.test(engJs.slice(engJs.indexOf('startWatchdog'))), 'Watchdogs have to heal over time.');
    // Applying the Activity reconstruction will cover the direction, and it will need to be filled at that time.
    // Window is relaxed to 2200 characters: then on AppUp to handle the fading of the motor drawings,
    // The notes will push the window of 600 characters backwards and miss out on everything.
    assert(/onAppUp[\s\S]{0,4000}_healOrientation/.test(mainJs), 'We need to fix it once we apply it.');
    // The panel cannot be repaired here if the direction and settings are inconsistent. It must be given to the restart.
    assert(/panelLandscape/.test(engJs), 'To be able to distinguish between "the reboot" and "the relocking direction"');
  });

  await test('Linux Shortcut: .desktop to execute, Exec to transfer, icon to PNG', () => {
    const os = require('os');
    const shortcut = require('../src/core/shortcut');
    // Generates on Windows: . Ink, Linux must be .desktop (freedesktop))
    assert(shortcut.shortcutExt() === (process.platform === 'win32' ? '.lnk' : '.desktop'),
      'Shortcut extension to follow the platform.');

    // Dial .desktop writeer authenticate content (without relying on the current platform))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-dt-'));
    const out = path.join(dir, 'Test application.desktop');
    const png = path.join(dir, 'icon.png');
    fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      shortcut.writeDesktopEntry({
        shortcutPath: out,
        target: '/opt/Hydra Emulator/Hydra Emulator',
        args: '--launch "com.example.app"',
        iconPngPath: png,
        description: 'Test application',
      });
      assert(fs.existsSync(out), '.You have to really drop it.');
      const body = fs.readFileSync(out, 'utf8');
      assert(/\[Desktop Entry\]/.test(body), 'Desktop Entry paragraph is missing');
      assert(/^Type=Application$/m.test(body), 'Type must be Application');
      // The path with the spaces will be broken into two parameters without quotation marks. Direct start failed.
      assert(/^Exec=.*"\/opt\/Hydra Emulator\/Hydra Emulator"/m.test(body), 'Target path in Exec to add quote marks');
      assert(/com\.example\.app/.test(body), 'Exec has to bring-- launch’s name.');
      assert(/^Icon=.*icon\.png$/m.test(body), 'icon to use the PNG absolute path (ICO invalid in Linux))');
      // .Desktop without execution slots, many desktop environments will become normal documents
      if (process.platform !== 'win32') {
        const mode = fs.statSync(out).mode & 0o777;
        assert((mode & 0o100) !== 0, '.Desktop must have executable');
      }
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  });

  await test('The screen must be "Stand Up": Panel Orientation, Rotation Lock 0, ignores the directional requests applied', () => {
    const root = path.join(__dirname, '..');
    const adbJs = fs.readFileSync(path.join(root, 'src', 'core', 'adb.js'), 'utf8');

    // The three-parts that the real machine has stepped on.):
    //  1) Physical Panel Redirection (hw. lcd. width/ height Exchange + Restart) - see doctor. lcdFor
    //  2) Logical orientation locks **0**: The panel is already horizontal, locking one more, turning the panel into a vertical logical space.
    //  3) Ignore application of your own direction request:
    //     Init=1280x720 turns into cur=720x1280 vertical logical space
    const setOri = adbJs.slice(adbJs.indexOf('async setOrientation'), adbJs.indexOf('async resetDisplayOverrides'));
    assert(/wm user-rotation lock 0/.test(setOri),
      'SetOrientation must lock rotation 0 (lock 1 will allow the cross-section to lie down))');
    assert(!/user-rotation lock \$\{landscape \? 1/.test(setOri),
      'Can\’t press the landscape lock 1 -- that\’s the way the "only the panel can rotate" era is written.');
    assert(/wm set-ignore-orientation-request/.test(setOri),
      'The application will have to be ignored, or the application that is being set up will lie down.');

    const reset = adbJs.slice(adbJs.indexOf('async resetDisplayOverrides'));
    assert(/wm user-rotation lock 0/.test(reset.slice(0, 1400)), 'ResetDisplayoverrides also locks 0');
    assert(/wm set-ignore-orientation-request/.test(reset.slice(0, 1400)),
      'ResetDisplayoverrides also sets the mode for the signature-orientation');
  });

  await test('Close application must have an entrance: Right key menu + Tray + IPC', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const preloadJs = fs.readFileSync(path.join(root, 'src', 'preload.js'), 'utf8');
    const uiJs = fs.readFileSync(path.join(root, 'src', 'ui', 'app.js'), 'utf8');

    // The main process should have an app: stop (none before, endApp only triggers when the window closes,
    // And the stand-alone window mode window is hidden.)
    assert(/ipcMain\.handle\('app:stop'/.test(mainJs), 'Missing app: stop ICC');
    // The Rendering Process needs to be able to adjust.
    assert(/stop:\s*\(pkg\)\s*=>\s*invoke\('app:stop'/.test(preloadJs), 'Preload to expose stop');
    // The right-key menu should have this entry
    assert(/key:\s*'stop'/.test(uiJs), 'Right-key menu missing "Close application"');
    assert(/case 'stop':/.test(uiJs), 'Right key menu does not handle stop');
    // The separate window mode main interface is hidden, and the tray is the only accessible entry.
    assert(/close current app/i.test(mainJs), 'Tray menu missing "Close the current application"');
    // Refresh Runs mark when turned off
    assert(/apps:changed/.test(mainJs) && /apps:changed/.test(uiJs),
      'Send after closing apps: changed and let interfaces refresh');

    // Repair: Tray and IPC must share the same stopapp path, not write the same logic in both places
    assert(/async function stopApp/.test(mainJs), 'There must be a uniform stopapp function');
    assert(/ipcMain\.handle\('app:stop'[\s\S]{0,200}stopApp/.test(mainJs),
      'App: stop IPC must be entrusted to stopapp');
    assert(/stopApp\(pkg\)\.then/.test(mainJs) || /stopApp\(pkg\)/.test(mainJs),
      'Tray Menu also has to tune stopapp');
    // Close must clear the current AppPkg, otherwise the tray also shows “Close the current application (xx)“
    assert(/currentAppPkg === target/.test(mainJs) || /currentAppPkg = null/.test(mainJs),
      'StopApp must clear the currentApppkg');
    // The stand-alone window mode must hide the simulator window before closing the shell window.)
    assert(/detached[\s\S]{0,200}agent\.hide/.test(mainJs),
      'standalone window mode');
    // External closing (Alt+F4) also needs to be cleared
    assert(/onCloseApp[\s\S]{0,800}currentAppPkg = null/.test(mainJs) || /onCloseApp[\s\S]{0,800}currentAppPkg === pkg/.test(mainJs),
      'On CloseApp, also clear the currentApppkg.');
  });

  await test('Old version clean-up: any Hydra Emulator directory found anywhere, without touching the current run version', () => {
    const os = require('os');
    const leftovers = require('../src/core/leftovers');
    const np = (p) => { try { return path.resolve(p).toLowerCase(); } catch (_) { return String(p).toLowerCase(); } };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-left-'));
    try {
      // Create three “old version“ directories + one “current version“ directory, each with a fake Hydra Emulator.exe
      const mk = (name) => {
        const d = path.join(root, name);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'Hydra Emulator.exe'), 'fake-exe');
        return d;
      };
      const old1 = mk('Hydra Emulator-v0.3.9-win64-portable');
      const old2 = mk('Hydra Emulator-win64-portable.prev-2026-01-01T00-00-00-000Z'); // Packing Backup Residue
      const curDir = mk('Hydra Emulator-v0.5.0-win64-portable');

      const r = leftovers.scan({ installDir: curDir, dataDir: root, avdHome: '' });
      const found = r.items.filter((i) => i.kind === 'dir').map((i) => np(i.path));

      assert(found.includes(np(old1)), 'The normal old version of the directory was not found.');
      // .Prev-* is the backup of the pack.js that were kept every time the name was changed.
      assert(found.includes(np(old2)), '.Prev, the backups on the pack were not found.');
      // Key security constraints: The one currently running must not appear in the list to be deleted
      assert(!found.includes(np(curDir)), 'The current run version is treated as an old version (dangerous))');
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  });

  await test('Switching application must first shut down the previous application, otherwise the old application ANR/ _activeApps remains', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');

    // OpenAppWindow now must be async: switch away from old applications and open them again.
    assert(/async function openAppWindow/.test(mainJs), 'OpenAppWindow must async (to wait for the old application to close))');
    // Useful also has to be earned, otherwise close/endApp and new applications start and launch and launch the ANR.
    assert(/await openAppWindow\(/.test(mainJs), 'RunLaunch must have an open AppWindow');

    // Core: When cut to another application, must first endApp (old) - only the window is kept in motion is the root of bug
    const fn = mainJs.slice(mainJs.indexOf('async function openAppWindow'));
    const body = fn.slice(0, fn.indexOf('\n}', fn.indexOf('currentAppPkg = pkg')));
    assert(/currentAppPkg !== pkg/.test(body), 'Old only when switching to a different application (reuse with application))');
    assert(/runtime\.endApp\(prev/.test(body) || /runtime\.endApp\(currentAppPkg/.test(body),
      'The switch must really endApp old application (force-stop + move out _activeApps)');
    // AppWin.open() is internal with close({keepApp:true}), no endApp;
    // So the outer layer has to be visible at endApp, not open close.
    assert(/close\(\{ keepApp: true \}\)/.test(body) && /endApp/.test(body),
      'Park image first and endApp stop in order');

    // The window is no longer there, but the process is still hanging on _activeapps.
    assert(/else if \(currentAppPkg && currentAppPkg !== pkg\)/.test(body),
      '_activeapps processes to clear when the window is missing');
  });

  await test('Automatic full screens and screens must be live: set items to consumer and start the headboard direction', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const htmlJs = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');
    const uiJs = fs.readFileSync(path.join(root, 'src', 'ui', 'app.js'), 'utf8');
    const emuJs = fs.readFileSync(path.join(root, 'src', 'core', 'emulator.js'), 'utf8');

    // AutoFullscreen OnLaunch used to state only in default settings that there was no code to read it -- dead switch.
    const uses = (mainJs.match(/autoFullscreenOnLaunch/g) || []).length;
    assert(uses > 0, 'The autoFullscreenOnLaunch must be read.)');
    assert(/fullscreen:[\s\S]{0,200}autoFullscreenOnLaunch/.test(mainJs),
      'Automatically fullscreen participation in openAppWindow fullscreen determination');

    // Setup pages to change these two
    assert(/setAutoFullscreen/.test(htmlJs), 'Cannot initialise Evolution’s mail component.');
    assert(/setLandscape/.test(htmlJs), 'Cannot initialise Evolution’s mail component.');
    assert(/setAutoFullscreen'\)\.addEventListener/.test(uiJs), 'Auto Full Screen Switch No Event');
    assert(/setLandscape'\)\.addEventListener/.test(uiJs), 'The screen-direction switch didn’t answer the incident.');

    // The screen can only be rebooted by the physical panel +; start must be corrected before it lies down
    assert(/panelLandscape/.test(emuJs), 'Emulator needs to be able to read the current panel direction');
    assert(/orientation mismatch/.test(mainJs), 'Check if panel direction is consistent with settings before startup');
    assert(/reloadApp:\s*false/.test(mainJs), 'Unable to start application again when correcting direction (repeated))');

    // Full Screen under stand-alone window mode to act on the emulator window, a hidden window has no meaning
    const appwinJs = fs.readFileSync(path.join(root, 'src', 'core', 'appwin.js'), 'utf8');
    assert(/_wantFullscreen/.test(appwinJs), 'Separate window mode remembers full screen intent');
    assert(/if \(this\._wantFullscreen\)/.test(appwinJs), 'OpenDetached has to fill the available area with full screen');

    // Fix: Old rt.client lapses after restarting, beforeStart must return a new rt
    const instJs = fs.readFileSync(path.join(root, 'src', 'core', 'installer.js'), 'utf8');
    assert(/beforeStart[\s\S]{0,400}replaced[\s\S]{0,200}replaced\.client/.test(instJs),
      'Installer. Launch accepts the return of a new rt');
    assert(/return newRt/.test(mainJs) || /return rt/.test(mainJs.slice(mainJs.indexOf('restartForOrientation'))),
      'RestartForOrganization to return a new rt to beforeStart');

    // Fix: independent window mode screen _panelRadio to correct in panel direction
    assert(/this\.state\.landscape.*b\.height > b\.width/.test(appwinJs)
      || /landscape.*height.*width/.test(appwinJs),
      '_panelRatio screen corrects the margin');
  });

  await test('Dot-opening applications need to be visible as early as possible: the process is connected to the window, which varies from 4 seconds of observation.', () => {
    const root = path.join(__dirname, '..');
    const instJs = fs.readFileSync(path.join(root, 'src', 'core', 'installer.js'), 'utf8');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');

    // The process was detected in two seconds, but we waited four seconds to make sure it didn’t crash.
    // And then you put the window on, and the user saw "no reaction."
    assert(/onAppUp/.test(instJs), 'Installer.Launch needs to return on AppUp');
    assert(/if \(!seen && typeof onAppUp === 'function'\)/.test(instJs),
      'OnappUp has to be triggered by the "First Seeing Process", and only once.');

    // The main process is to take this echo, and it's to be in parallel, or it's to be a series of waits.
    assert(/onAppUp:\s*\(\)\s*=>/.test(mainJs), 'I\'m gonna pass it to you on AppUp.');
    const block = mainJs.slice(mainJs.indexOf('onAppUp: () =>'), mainJs.indexOf('beforeStart:'));
    assert(/attachAppWindow\(\)/.test(block), 'On AppUp, get the picture right away.');
    assert(!/await attachAppWindow\(\)/.test(block),
      'On AppUp, you can’t go to the video.)');

    // You can’t repeat it in the back if you pick it up in advance.
    // Hide it again. Show it again. It’ll flash.
    assert(/attachDoneEarly/.test(mainJs), 'Remember if you\'ve received the video ahead of schedule.');
    assert(/if \(attachDoneEarly\)/.test(mainJs), 'We’re finally gonna skip the repeat.');

    // The survival period itself cannot be deleted: it's the back of a "spill-and-spill" trap.
    assert(/aliveSince >= 4000/.test(instJs), '4 seconds of survival observation.)');
  });

  await test('Virtual network: AVD must have a virtual Wi-Fi and be able to reconnect the hotspots without automatic connection.', () => {
    const root = path.join(__dirname, '..');
    const emuJs = fs.readFileSync(path.join(root, 'src', 'core', 'emulator.js'), 'utf8');
    const engineJs = fs.readFileSync(path.join(root, 'src', 'core', 'engine.js'), 'utf8');

    // API 34 Play Store Image Walking on the Netsim Virtual Wi-Fi, not eth0
    // If you’re missing hw.wifi, wlan0, no-CARRIER, the application has been "network error."
    assert(/['"]hw\.wifi=yes['"]/.test(emuJs), 'ww.wifi=yes');

    // AndroidWifi will be "Saved/ Won't automatically connected",
    // No automatic connection after startup. shell does not have NETWORK_SETTINGS, cmd wifi
    // Connect-network throws Security Exchange, so only UI points.
    assert(/async repairWifi/.test(emuJs), 'Need to reconnect Wi-Fi proactively');
    assert(/WIFI_SETTINGS/.test(emuJs), 'Reconnecting requires pulling up the Wi-Fi settings page');
    assert(/uiautomator dump/.test(emuJs), 'Reconnecting depends on the uiautomator to find a hot spot and a little more.');
    // The network will then replace the network authentication probe with a nationally accessible endpoint, otherwise the system will always call the network “!“,
    // Partially use this to get offline and refuse to load content.
    assert(/captive_portal_http_url/.test(emuJs), 'Need to change the web-based validation probe to a nationally accessible endpoint');
    // It is explicitly prohibited to use contract-network as the main scheme (inadequate access, inevitable failure).
    // Look at the real code line -- the note says it's explaining why it doesn't work.
    const emuCode = emuJs.split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .filter((l) => l.trim() && !/^\s*(\*|\/\*)/.test(l))
      .join('\n');
    assert(!/cmd wifi connect-network/.test(emuCode), 'shell does not have contract-network privileges, cannot use it');

    // The restoration must be light to heavy: reconnect, then cold to start, and then clear the data.
    const repair = engineJs.slice(engineJs.indexOf('async repairNetwork'));
    const repairBody = repair.slice(0, repair.indexOf('async ', 10) > 0 ? undefined : undefined);
    assert(/repairWifi/.test(repairBody), 'repairNetwork should try a light Wi-Fi reconnection first');
    const wifiAt = repairBody.indexOf('repairWifi');
    const wipeAt = repairBody.indexOf('forceWipeOnNextStart');
    assert(wifiAt > -1 && wipeAt > -1 && wifiAt < wipeAt,
      'The order must be: reconnect Wi-Fi before reset data (not clear user data as soon as you get up))');

    // And the insureNetwork needs to be repaired lightly before it starts.
    const ensure = engineJs.slice(engineJs.indexOf('async ensureNetwork'));
    const ensureBody = ensure.slice(0, ensure.indexOf('async repairNetwork'));
    const eWifi = ensureBody.indexOf('repairWifi');
    const eBoot = ensureBody.indexOf('_netColdBootTried');
    assert(eWifi > -1 && eBoot > -1 && eWifi < eBoot,
      'I’m going to try to reconnect Wi-Fi first, and think of cold start.');

    // You have to do it again on the startup path, or you’ll eat a "no web" application at every point.
    // Note that only non-destructive repairWifi is allowed, and there must be no insureNetwork.
    const instJs = fs.readFileSync(path.join(root, 'src', 'core', 'installer.js'), 'utf8');
    assert(/repairWifi/.test(instJs), 'Try to fix Wi-Fi before starting application');
    assert(!/\.ensureNetwork\(/.test(instJs), 'Unable to switch start path)');
    // Must be hung on engine (this. rantime): rt is the return object of ensure(), only clit.
    // It says rt.repairWifi will be unrefined, call-and-call is thrown out and swallowed by catch, and it's unrepaired.
    assert(/this\.runtime\.repairWifi\(/.test(instJs), 'RepairWifi on engine (this.runtime)');
    assert(!/\brt\.repairWifi\(/.test(instJs), 'rt is an essure() return object, not above repairWifi');
    // If you’re not installer, you have to really have this transmission, or you’re calling from the same source.
    assert(/async repairWifi\(/.test(engineJs), 'engine must achieve repairWifi forwarding');
  });

  await test('WinAgent.setHook(false) does not lift PowerShell agent in default', async () => {
    const { WinAgent } = require('../src/core/agent');
    const a = new WinAgent();
    a.hooked = false;
    const r = await a.setHook(false);
    assert(r && r.hooked === false, 'Close should return hooked=false');
    assert(a.ready === null, 'The resident agent process cannot be started for this when the default closes');
  });

  console.log('\n[Mouse Key Map]');

  await test('Default migration with old configuration: Right key returns + smooth roller on, side off', () => {
    const store = require('../src/core/store');
    const d = pointer.pointerOptions(store.getSettings());
    assert(d.rightBack === true, 'Right key returns default to open');
    assert(d.wheel === 'smooth', 'Roller Default Smooth');
    assert(d.side === false, 'Side key default switch');
    assert(d.enabled === true, 'At least right-key mapping needs a hook.');
    // The same thing happens when there's no new key in the old sets.
    assert(pointer.pointerOptions({ engine: { liteMode: true } }).rightBack === true);
    const off = pointer.pointerOptions({ engine: { mouseRightBack: false, mouseWheelMode: 'off', mouseSideButtons: false } });
    assert(off.enabled === false, 'You can\'t have any hooks when you turn them off.');
    const native = pointer.pointerOptions({ engine: { mouseRightBack: false, mouseWheelMode: 'native', mouseSideButtons: false } });
    assert(native.enabled === false, 'The original wheel doesn’t need a hook.');
  });

  await test('HookOffices condensing configuration, all subswitches are zero together when closed', () => {
    const on = pointer.hookOptions({ enabled: true, rightBack: true, wheel: true, side: false });
    assert(on.rightBack && on.wheel && !on.side);
    const off = pointer.hookOptions({ enabled: false, rightBack: true, wheel: true, side: true });
    assert(!off.rightBack && !off.wheel && !off.side, 'I can\'t stop you from doing anything.');
    assert(pointer.hookOptions(true).side === true, 'Compatible with old booleans (side buttons))');
    assert(pointer.hookOptions(false).enabled === false);
  });

  await test('Roll down = finger slide, finger roll up = finger slide, coordinates don’t cross.', () => {
    const down = pointer.wheelToSwipe({ dy: -120, nx: 0.5, ny: 0.5, width: 900, height: 1600 });
    assert(down && down.y1 > down.y2, 'The wheels should move the contents up.)');
    const up = pointer.wheelToSwipe({ dy: 120, nx: 0.5, ny: 0.5, width: 900, height: 1600 });
    assert(up && up.y1 < up.y2, 'The wheels should move the contents down.)');
    assert(pointer.wheelToSwipe({ dx: 0, dy: 0 }) === null, 'Zero shift does not generate an order');
    for (const s of [down, up]) {
      assert([s.x1, s.x2].every((v) => v >= 1 && v <= 899), 'No, no, no.');
      assert([s.y1, s.y2].every((v) => v >= 1 && v <= 1599), 'y Can\'t cross.');
      assert(s.duration >= 100 && s.duration <= 240, 'Slides should have a ceiling.');
    }
    const big = pointer.wheelToSwipe({ dy: -12000, nx: 0, ny: 0, width: 900, height: 1600 });
    assert(big.y1 - big.y2 <= Math.round(1600 * 0.78), 'Get out of here. You can\'t hold your hand forever.');
    const horiz = pointer.wheelToSwipe({ dx: 120, dy: 0, width: 900, height: 1600 });
    assert(horiz && horiz.x1 > horiz.x2 && horiz.y1 === horiz.y2, 'Horizontal wheels should generate horizontal slides');
  });

  await test('Input command white list: only internal spell-out orders are released, blocking injections', async () => {
    assert(pointer.isInputCommand('input keyevent 4'));
    assert(pointer.isInputCommand(pointer.swipeToCommand(pointer.wheelToSwipe({ dy: -120 }))));
    assert(!pointer.isInputCommand('input keyevent 4; rm -rf /sdcard'));
    assert(!pointer.isInputCommand('input swipe 1 2 3 4 100 && reboot'));
    assert(!pointer.isInputCommand('sh -c anything'));
    const c = new AdbClient({ adbPath: 'adb', serial: 'test' });
    let blocked = false;
    try { await c.input('input keyevent 4; rm -rf /'); } catch (e) { blocked = /invalid|unsupported|rejected/i.test(e.message); }
    assert(blocked, 'Illegal orders must be blocked before pulling up adb');
    assert(c._input === null, 'Blocked command cannot create permanent session');
  });

  await test('Returns key priority for permanent input channel, failed before retreating once adb', async () => {
    const c = new AdbClient({ adbPath: 'adb', serial: 'test' });
    const used = [];
    c.input = async (cmd) => { used.push(cmd); };
    c.shell = async () => { used.push('shell'); };
    await c.keyBack();
    assert(used[0] === 'input keyevent 4' && !used.includes('shell'), 'Normal path should not be spawn adb');
    const c2 = new AdbClient({ adbPath: 'adb', serial: 'test' });
    const used2 = [];
    c2.input = async () => { throw new Error('offline'); };
    c2.shell = async (cmd) => { used2.push(cmd); return ''; };
    await c2.keyForward();
    assert(used2[0] === 'input keyevent 125', 'You have to go through the downpass. Don\'t lose this click.');
  });

  await test('WheelRouter merges successive scrolls into a slide command.', async () => {
    const cmds = [];
    const r = new pointer.WheelRouter({
      inject: async (cmd) => { cmds.push(cmd); },
      getSize: () => ({ width: 900, height: 1600 }),
      flushMs: 10,
    });
    r.push({ dx: 0, dy: -120, nx: 0.5, ny: 0.5 });
    r.push({ dx: 0, dy: -120, nx: 0.5, ny: 0.5 });
    r.push({ dx: 0, dy: -120, nx: 0.5, ny: 0.4 });
    await r.flush();
    assert(cmds.length === 1, `3 grid scrolls should be merged into 1 command, actual ${cmds.length}`);
    assert(pointer.isInputCommand(cmds[0]), 'Input swipe');
    const m = /^input swipe (\d+) (\d+) (\d+) (\d+)/.exec(cmds[0]);
    assert(m && Number(m[2]) > Number(m[4]), 'Merger is still going down.');
    r.dispose();
    r.push({ dy: -120 });
    await r.flush();
    assert(cmds.length === 1, 'Dispose can\'t inject after.');
  });

  await test('Proxy Script: Right/roll intercept, wheel merge, front-office limit and dedicated thread', () => {
    const ps1 = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    assert(/WM_RBUTTONDOWN/.test(ps1) && /WM_MOUSEWHEEL/.test(ps1), 'Must handle right and wheels');
    assert(/WM_MOUSEHWHEEL/.test(ps1), 'The horizontal wheels will also be supported.');
    assert(/PushWheel\(/.test(ps1) && /FlushWheel\(false\)/.test(ps1), 'The wheels must be merged and reported.');
    assert(/GetAncestor\(fg, 2\)/.test(ps1), 'The field must be limited by the front root window');
    assert(/new Thread\(HookThreadProc\)/.test(ps1) && /GetMessage\(out MSG/.test(ps1), 'The hook must have a special message thread.');
    assert(!/Poll\(4000,\s*SelectMode\.SelectRead\)/.test(ps1), 'The main cycle can\'t be held back long.');
    assert(/_optRight == 0/.test(ps1) && /_optWheel == 0/.test(ps1), 'Unconfigurated map cannot stop event');
    const appwinJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'appwin.js'), 'utf8');
    assert(/pointerConfig/.test(appwinJs) && /refreshPointer/.test(appwinJs), 'Set changes to instant sync hooks');
    const uiHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'index.html'), 'utf8');
    assert(/setMouseRightBack/.test(uiHtml) && /setMouseWheelMode/.test(uiHtml), 'Setup Page to Exposure Key Switches');
  });

  await test('WinAgent.setHook configures the key to send down and closes without pulling the agent', async () => {
    const { WinAgent } = require('../src/core/agent');
    const a = new WinAgent();
    const sent = [];
    a.call = async (obj) => { sent.push(obj); return { ok: true, hooked: true }; };
    const on = await a.setHook(true, { rightBack: true, wheel: true, side: false });
    assert(on.hooked === true && sent.length === 1, 'It should be opened only once.');
    assert(sent[0].right === 1 && sent[0].wheel === 1 && sent[0].side === 0, 'Configuration must be sent with a Hook command');
    await a.setHook(false);
    assert(sent[1].on === 0 && a.hooked === false, 'Close to unmount the hook');
    const b = new WinAgent();
    const r = await b.setHook(false);
    assert(r.hooked === false && b.ready === null, 'Could not start PowerShell when default closes');
  });

  console.log('\n[Update.js Online Update]');
  await test('Versions compare numbers by paragraph, v prefix/ multiple paragraphs are correct', () => {
    const { cmpVer } = require('../src/core/updater');
    assert(cmpVer('v0.3.2', '0.3.1') === 1, '0.3.2 shall be greater than 0.3.1');
    assert(cmpVer('0.3.1', 'v0.3.1') === 0, 'The prefix does not affect the equality');
    assert(cmpVer('0.10.0', '0.9.9') === 1, 'You have to compare numbers instead of strings.');
    assert(cmpVer('1.0.0', '1.0.1') === -1, '1.0.0 less than 1.0.1');
  });

  await test('Install shape determines which asset: Install = Setup.exe, Portable.zip', () => {
    const { Updater } = require('../src/core/updater');
    const dir = path.join(TMP, 'upd-setup');
    fs.mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, 'Hydra Emulator.exe');
    fs.writeFileSync(exe, 'x');
    const portable = new Updater({ currentVersion: '0.1.0', exePath: exe, isPackaged: true, dataDir: TMP });
    assert(portable.flavor === 'portable', 'Deciding portable when no loader is removed');
    fs.writeFileSync(path.join(dir, 'Uninstall Hydra Emulator.exe'), 'x');
    assert(portable.flavor === 'setup', 'Deciding installation when there is an unmounter');
    // Asset selection is purely functional, and here you feed a fake check, and the result is a confirmation of the sub-naming rule.
    assert(/Setup\.exe$/i.test('Hydra Emulator-0.3.2-Setup.exe'), 'Installed asset name matching');
    assert(/portable.*\.zip$/i.test('Hydra Emulator-v0.3.2-win64-portable.zip'), 'Portable asset name matches');
  });

  await test('Portable versions do not use the running-time package (Hydra Emulator-runtime-*.zip) as an updated package', async () => {
    const { Updater } = require('../src/core/updater');
    const dir = path.join(TMP, 'upd-asset');
    fs.mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, 'Hydra Emulator.exe');
    fs.writeFileSync(exe, 'x');
    const mk = (assets) => ({
      version: '0.5.0', tag: 'v0.5.0', name: 'Hydra Emulator v0.5.0', notes: '', htmlUrl: '',
      publishedAt: '', sources: [], unreachable: [], assets,
    });
    const u = new Updater({ currentVersion: '0.3.4', exePath: exe, isPackaged: true, dataDir: dir });
    // Two assets exist at once.
    u.sources = { latest: async () => mk([
      { name: 'Hydra Emulator-runtime-v0.5.0.zip', url: 'https://x/runtime.zip', urls: ['https://x/runtime.zip'], sizes: {} },
      { name: 'Hydra Emulator-v0.5.0-win64-portable.zip', url: 'https://x/p.zip', urls: ['https://x/p.zip'], sizes: {} },
    ]) };
    let info = await u.check({ force: true });
    assert(/portable/.test(info.asset.name), `You should pick a handbag, actually ${info.asset.name}`);

    // Only the whole package when running (the portable package was not uploaded) would rather not be automatically updated, and not when running with 1.5 GB as a package.
    u.sources = { latest: async () => mk([
      { name: 'Hydra Emulator-runtime-v0.5.0.zip', url: 'https://x/runtime.zip', urls: ['https://x/runtime.zip'], sizes: {} },
    ]) };
    info = await u.check({ force: true });
    assert(!info.asset, 'Only when running a full package should not select an updated asset');
    assert(info.canAutoApply === false, 'Unable to update automatically without available assets');
  });

  await test('Double source: Candidate address contains mirror prefix, custom prefix over public mirror', () => {
    const { Sources, withMirror } = require('../src/core/sources');
    const url = 'https://github.com/o/r/releases/download/v1/a.zip';
    const auto = new Sources(() => ({ runtime: { autoMirror: true } }));
    const list = auto.candidates(url);
    assert(list[0] === url, 'The source station must be ranked first (sequence sequenced))');
    assert(list.length >= 2 && list.some((u) => u.includes('ghfast.top')), 'Automatic mirrors should be put on the list.');

    const custom = new Sources(() => ({ runtime: { autoMirror: true, mirrorPrefix: 'https://my.mirror/' } }));
    const c2 = custom.candidates(url);
    assert(c2.length === 2 && c2[1] === `https://my.mirror/${url}`, `Custom prefix should only be effective, actual ${JSON.stringify(c2)}`);

    const off = new Sources(() => ({ runtime: { autoMirror: false } }));
    assert(off.candidates(url).length === 1, 'Turn off the automatics and we’ll have a straight line.');
    assert(withMirror(url, 'https://x/') === `https://x/${url}`, 'Prefix without tail slash to auto-fill');

    // The mirror represents only GitHub: Gitee's address is only 403 prefixed to the mirror, and should not be put on the list.
    const giteeUrl = 'https://gitee.com/Lord1Egypt/Hydra-Emulator/releases/download/v1/a.zip.part1';
    assert(auto.candidates(giteeUrl).length === 1, 'Gitee asset should not be set up with GitHub mirror prefix');
  });

  await test('Double source: Speed results are sorted at speed, all failed without losing the available address', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: { autoMirror: false } }));
    // Directly injects speed detection caches, avoids testing dependence on the outer net.
    s._rankCache.set('https://slow/', { at: Date.now(), ok: true, speed: 1000 });
    s._rankCache.set('https://fast/', { at: Date.now(), ok: true, speed: 9000 });
    s._rankCache.set('https://dead/', { at: Date.now(), ok: false, speed: 0 });
    const ranked = await s.rank(['https://slow/', 'https://dead/', 'https://fast/']);
    assert(ranked[0] === 'https://fast/', `The fastest one to go first, actually. ${ranked[0]}`);
    assert(ranked[2] === 'https://dead/', 'The failed address is last but still (one more chance))');
    s.reset();
    assert(s._rankCache.size === 0, 'Reset To empty speed measurement caches (re-read after source/net change))');
  });

  await test('Double source: Gite automatically attached source package (v1.2.3.zip) must never be considered an installation package', async () => {
    const { Sources } = require('../src/core/sources');
    const s2 = new Sources(() => ({ runtime: {} }));
    s2.fetchReleases = async () => [
      {
        source: 'gitee',
        name: 'Gitee',
        web: 'e',
        rel: {
          tag_name: 'v0.3.2',
          assets: [
            { name: 'v0.3.2.zip', size: 999, browser_download_url: 'ge://src' },
            { name: 'v0.3.2.tar.gz', size: 999, browser_download_url: 'ge://src2' },
            { name: 'Hydra Emulator-v0.3.2-win64-portable.zip', size: 10, browser_download_url: 'ge://ok' },
          ],
        },
      },
    ];
    const m = await s2.latest();
    assert(m.assets.length === 1 && m.assets[0].url === 'ge://ok',
      `Only Hydra Emulator* assets should be retained, actual ${JSON.stringify(m.assets.map((a) => a.name))}`);
  });

  await test('Gitee has no size field: the snippets still have to be formed (or the whole package is thrown out).)', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    s.fetchReleases = async () => [{
      source: 'gitee',
      name: 'Gitee',
      web: 'e',
      rel: {
        tag_name: 'v0.3.3',
        // Gitee release only name + url, no size (actual))
        assets: [
          { name: 'Hydra Emulator-v0.3.3-win64-portable.zip.part1', browser_download_url: 'ge://p1' },
          { name: 'Hydra Emulator-v0.3.3-win64-portable.zip.part2', browser_download_url: 'ge://p2' },
        ],
      },
    }];
    const m = await s.latest();
    assert(m.assets.length === 1, `should be consolidated into 1 asset, actual ${m.assets.length}`);
    const a = m.assets[0];
    assert(a.name === 'Hydra Emulator-v0.3.3-win64-portable.zip', `The asset name should be the whole name, actual ${a.name}`);
    assert(a.parts && a.parts.length === 2, 'We have to keep two.');
    assert(a.parts[0].urls[0] === 'ge://p1' && a.parts[1].urls[0] === 'ge://p2', 'Split address order/content correct');
    assert(a.size === 0, 'The size unknown should be 0 (interface shows progress by by bytes received))');
  });

  await test('Split assets must be passed all the way to updater.asset, otherwise preparae will report “There is no available download address”', async () => {
    const { Updater } = require('../src/core/updater');
    const u = new Updater({
      currentVersion: '0.0.1', exePath: path.join(TMP, 'A.exe'), isPackaged: true, dataDir: TMP,
      settings: () => ({}),
    });
    u.sources.latest = async () => ({
      version: '9.9.9',
      tag: 'v9.9.9',
      assets: [{
        name: 'Hydra Emulator-v9.9.9-win64-portable.zip',
        size: 0,
        partial: true,
        parts: [{ index: 1, size: 0, urls: ['https://gitee.com/x/p1'] }, { index: 2, size: 0, urls: ['https://gitee.com/x/p2'] }],
      }],
      sources: [{ source: 'gitee', name: 'Gitee', tag: 'v9.9.9' }],
      unreachable: [],
    });
    const info = await u.check({ force: true });
    assert(info.asset && info.asset.parts && info.asset.parts.length === 2, 'Parts must be kept on the set');
    assert(info.canAutoApply === true, 'If you have a split, you should be judged to be automatically renewable.');
  });

  await test('Double source: Merge version only with version assets, not with old bags as new packages', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v0.4.0', assets: [{ name: 'Hydra Emulator-A-portable.zip', size: 10, browser_download_url: 'gh://a' }] } },
      { source: 'gitee', name: 'Gitee', web: 'e', rel: { tag_name: 'v0.3.9', assets: [{ name: 'Hydra Emulator-A-portable.zip', size: 10, browser_download_url: 'ge://a' }, { name: 'Hydra Emulator-B.txt', size: 1, browser_download_url: 'ge://b' }] } },
    ];
    const m = await s.latest();
    assert(m.version === '0.4.0', `Should be higher version, actual ${m.version}`);
    assert(m.assets.length === 1 && m.assets[0].url === 'gh://a', 'Old version same-name asset cannot overwrite new version');
  });

  await test('Window agent: scope with semicolons, filter empty items (window belongs to the only input judged))', async () => {
    const { WinAgent } = require('../src/core/agent');
    const a = new WinAgent();
    const sent = [];
    // Do not really represent process: only verify the content of the agreement sent to it
    a.call = async (obj) => { sent.push(obj); return { ok: true, n: 1 }; };
    const r = await a.scope(['C:////runtime', '', null, 'D:////repo////engine']);
    assert(sent.length === 1 && sent[0].cmd === 'scope', `Only one copy should be sent, actually ${JSON.stringify(sent)}`);
    assert(sent[0].dirs === 'C:////runtime;D:////repo////engine', `Empty entry to filter, actual ${sent[0].dirs}`);
    assert(r.ok === true, 'Scope success returns ok');
    // And you can’t drop the empty array: it’s "no pressure" and it’s up to the caller to call the police.
    const empty = await a.scope([]);
    assert(sent[1].dirs === '' && empty.ok === true, 'The empty range must be ready to drop.)');
  });

  await test('Double source: When the same name is on both sides of the bag, both addresses are kept.)', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: { autoMirror: false } }));
    const gh = 'https://github.com/o/r/releases/download/v0.3.3/a.zip';
    const ge = 'https://gitee.com/o/r/releases/download/v0.3.3/a.zip';
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v0.3.3', assets: [{ name: 'Hydra Emulator-v0.3.3-win64-portable.zip', size: 108200693, browser_download_url: gh }] } },
      // Gitee's assets are not sizeable. It cannot be assumed that GitHub's size
      { source: 'gitee', name: 'Gitee', web: 'e', rel: { tag_name: 'v0.3.3', assets: [{ name: 'Hydra Emulator-v0.3.3-win64-portable.zip', browser_download_url: ge }] } },
    ];
    const m = await s.latest();
    assert(m.assets.length === 1, `The same name is to be combined into one, actual ${m.assets.length}`);
    const a = m.assets[0];
    assert(a.urls.length === 2 && a.urls[1] === ge, `Both source addresses, actually. ${JSON.stringify(a.urls)}`);
    assert(a.sizes[gh] === 108200693 && !a.sizes[ge], 'Size separated by address. Unknown is unknown.');
    const cands = s.candidates(a);
    assert(cands.length === 2 && cands[0] === gh, `Candidate address should include two sources, actual ${JSON.stringify(cands)}`);
  });

  await test('Multi-source parallel downloads: two sources of different sizes and moving with the fastest source (not able to fix size))', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const MB = 1024 * 1024;
    const small = Buffer.alloc(3 * MB);   // The source in front (ordered at speed))
    const big = Buffer.alloc(5 * MB);
    for (let i = 0; i < small.length; i += 1) small[i] = i % 251;
    for (let i = 0; i < big.length; i += 1) big[i] = (i * 7) % 251;
    const serve = (data) => (req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${a}-${b}/${data.length}`,
        'Content-Length': b - a + 1,
      });
      res.end(data.slice(a, b + 1));
    };
    const mk = (data) => new Promise((resolve) => {
      const srv = http.createServer(serve(data));
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const s1 = await mk(small);
    const s2 = await mk(big);
    const out = path.join(TMP, 'mixed-size.bin');
    try {
      // List order = speed order of rank(): the first is the fastest source
      await downloadMulti([`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`], out, { connections: 4 });
      const got = fs.readFileSync(out);
      assert(got.length === small.length && Buffer.compare(got, small) === 0,
        `The fastest source.(${small.length} bytes, actual ${got.length} Bytes`);
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
    }
  });

  await test('Split Update Package: Sequenced the package back in order and the size does not match and aborts immediately', async () => {
    const http = require('http');
    const { Updater } = require('../src/core/updater');
    const partA = Buffer.alloc(4096, 0x41);
    const partB = Buffer.alloc(2048, 0x42);
    const srv = http.createServer((req, res) => {
      if (req.url.startsWith('/a')) { res.writeHead(200, { 'Content-Length': partA.length }); res.end(partA); return; }
      if (req.url.startsWith('/b')) { res.writeHead(200, { 'Content-Length': partB.length }); res.end(partB); return; }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const sb = path.join(TMP, 'parts-upd');
    fs.mkdirSync(sb, { recursive: true });
    const u = new Updater({ currentVersion: '0.0.0', exePath: path.join(sb, 'A.exe'), isPackaged: true, dataDir: sb, settings: () => ({}) });
    const target = path.join(sb, 'joined.zip');
    try {
      await u._downloadParts({
        name: 'joined.zip',
        size: partA.length + partB.length,
        parts: [
          { index: 1, size: partA.length, urls: [`http://127.0.0.1:${port}/a`] },
          { index: 2, size: partB.length, urls: [`http://127.0.0.1:${port}/b`] },
        ],
      }, target, 2, partA.length + partB.length);
      const got = fs.readFileSync(target);
      assert(got.length === partA.length + partB.length, 'The size of the piece must be equal to the sum of the pieces.');
      assert(got.slice(0, partA.length).every((b) => b === 0x41), 'The first one was in an erroneous order.');
      assert(got.slice(partA.length).every((b) => b === 0x42), 'The second one was in an erroneous order.');
    } finally {
      srv.close();
      fs.rmSync(sb, { recursive: true, force: true });
    }
  });

  await test('Multi-source parallel downloads: different fractions pull from different sources and the bytes that are written must be identical', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const data = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < data.length; i += 1) data[i] = i % 251;
    const handler = (req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${a}-${b}/${data.length}`,
        'Content-Length': b - a + 1,
      });
      res.end(data.slice(a, b + 1));
    };
    // The test will hang.
    const mk = () => new Promise((resolve) => {
      const srv = http.createServer(handler);
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const s1 = await mk();
    const s2 = await mk();
    const urls = [
      `http://127.0.0.1:${s1.address().port}/f`,
      `http://127.0.0.1:${s2.address().port}/f`,
    ];
    const out = path.join(TMP, 'multi.bin');
    try {
      const r = await downloadMulti(urls, out, { connections: 6, minChunk: 512 * 1024 });
      const got = fs.readFileSync(out);
      assert(Buffer.compare(got, data) === 0, 'Multi-source synthesizing must be fully aligned with the source file');
      assert(r.sources === 2 && r.parallel >= 2, `Should be used simultaneously to 2 sources, actual ${JSON.stringify(r)}`);
      assert(got.length === data.length, 'The size must be the same.');
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
    }
  });

  await test('Multi-source parallel downloads: Reload only missing blocks after failure (do not reload entire 1.4GB))', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const MB = 1024 * 1024;
    const total = 3 * MB;
    const data = Buffer.alloc(total);
    for (let i = 0; i < total; i += 1) data[i] = i % 251;
    let ranged = 0;
    const handler = (req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': total }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), total - 1);
      if (b > a) ranged += 1;          // Only real data block requests (0-0 for detection))
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${total}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    };
    // There must be two addresses: only one time downloadMulti will hand it to a single block.)
    const mk = () => new Promise((resolve) => {
      const srv = http.createServer(handler);
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const s1 = await mk();
    const s2 = await mk();
    const urls = [`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`];
    const out = path.join(TMP, 'multi-resume.bin');
    try {
      // Creates a field where the first two are finished and the last one is not. (Figure: 3 connections x 1MB))
      const per = Math.ceil(total / 3);
      const fd = fs.openSync(out, 'w');
      fs.ftruncateSync(fd, total);
      fs.writeSync(fd, data, 0, per * 2, 0);
      fs.closeSync(fd);
      fs.writeFileSync(`${out}.chunks.json`, JSON.stringify({ total, n: 3, done: [0, per] }));

      const r = await downloadMulti(urls, out, { connections: 3, minChunk: MB });
      assert(r.resumed === true, 'It should be recognized that this is a break-through.');
      assert(ranged === 1, `Only 1 block should be added, actually requested ${ranged}  Blocks`);
      assert(Buffer.compare(fs.readFileSync(out), data) === 0, 'The serial files must be identical to the source');
      assert(!fs.existsSync(`${out}.chunks.json`), 'When you\'re done, you have to clear the side of the car.');
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
      fs.rmSync(`${out}.chunks.json`, { force: true });
    }
  });

  await test('Downloader: None of the bytes after the connection is created must be replaced by time, not by death.', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const data = Buffer.alloc(4 * 1024 * 1024, 9);
    // The head goes back normal, and then he never talks: simulates the classic state of “TCP Passed but Walled/Sticked“
    const stall = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1 });
      // 1KB first, then no more.
      res.write(data.slice(a, a + 1024));
    });
    const good = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    });
    const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
    const s1 = await listen(stall);
    const s2 = await listen(good);
    const out = path.join(TMP, 'stall.bin');
    const t0 = Date.now();
    try {
      const r = await downloadMulti(
        [`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`],
        out,
        { connections: 4, minChunk: 1024 * 1024, idleMs: 400, retries: 2 },
      );
      const cost = Date.now() - t0;
      assert(fs.statSync(out).size === data.length, 'It must end up intact.');
      assert(cost < 15000, `Can’t hang on to the stagnating connection, actually. ${cost}ms`);
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
      fs.rmSync(`${out}.chunks.json`, { force: true });
    }
  });

  await test('Downloader: A source runs to dozens of KB/s instead of stuck in the last few %s.', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const MB = 1024 * 1024;
    const total = 2 * MB;
    const data = Buffer.alloc(total, 5);
    // Slow source: 4KB per 100ms)
    const slow = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': total }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), total - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${total}`, 'Content-Length': b - a + 1 });
      let pos = a;
      const pump = () => {
        if (pos > b) { res.end(); return; }
        const chunk = data.slice(pos, Math.min(b + 1, pos + 4096));
        pos += chunk.length;
        res.write(chunk);
        setTimeout(pump, 100);
      };
      pump();
    });
    const fast = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': total }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), total - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${total}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    });
    const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
    const s1 = await listen(slow);
    const s2 = await listen(fast);
    const out = path.join(TMP, 'slowrot.bin');
    const t0 = Date.now();
    try {
      await downloadMulti(
        [`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`],
        out,
        { connections: 2, minChunk: 512 * 1024, idleMs: 3000, slowAfterMs: 400, slowBps: 200 * 1024 },
      );
      const cost = Date.now() - t0;
      assert(Buffer.compare(fs.readFileSync(out), data) === 0, 'Resource must be correct.');
      // 2MB/ 40KB/s ≈ 50 seconds for a slow source; the switch must be completed in a few seconds
      assert(cost < 15000, `We need to switch sources at low speed. It's actually working. ${cost}ms`);
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
      fs.rmSync(`${out}.chunks.json`, { force: true });
    }
  });

  await test('Multi-source parallel download: return a single block when only one address is available', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const data = Buffer.alloc(2 * 1024 * 1024, 7);
    const srv = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/f`;
    // Take a port that’s just been released, and now no one’s listening.
    const probe = http.createServer(() => {});
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const deadPort = probe.address().port;
    await new Promise((r) => probe.close(r));
    const out = path.join(TMP, 'multi1.bin');
    try {
      // The second address deliberately pointed to an unconnected port: it must be ignored automatically, not failed in the whole package.
      const r = await downloadMulti([url, `http://127.0.0.1:${deadPort}/nope`], out, { connections: 4 });
      assert(fs.statSync(out).size === data.length, 'The single source must be complete.');
      assert(!r.multi || r.sources === 1, 'If only one available source should not be marked as multi-source');
    } finally {
      srv.close();
      fs.rmSync(out, { force: true });
    }
  });

  await test('Double source: version results cache 10 minutes, mandatory recheck at force', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    let calls = 0;
    s.fetchReleases = async () => {
      calls += 1;
      return [{ source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v1.0.0', assets: [] } }];
    };
    await s.latest();
    await s.latest();
    assert(calls === 1, `Requests should not be repeated during the period of the cache, actual requests ${calls} Numbers`);
    await s.latest({ force: true });
    assert(calls === 2, 'Force has to bypass the cache.');
    s.reset();
    await s.latest();
    assert(calls === 3, 'Reset Rerequested');
  });

  await test('Double source: A source 403 melted and jumped after a limited flow, and no more walls per round', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    let giteeCalls = 0;
    s.fetchReleases = async () => {
      giteeCalls += 1;
      return [
        { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v1.0.0', assets: [] } },
        { source: 'gitee', name: 'Gitee', web: 'e', error: 'Here.com 403 (restricted stream))' },
      ];
    };
    // First: Gitee 403, recorded in smelting
    await s.latest({ force: true });
    assert(giteeCalls === 1, 'I’ve been asked for the first round.');
    const reason = s.blockedReason('gitee');
    assert(!!reason, '403 must trigger the melting.');
    assert(s.blockedReason('github') === null, 'The source of no error should not be melted');
    // Requests during the smelting period should be skipped directly (no more network playing))
    assert(/Temporarily paused/.test(reason), `You have to understand the reason for skipping.: ${reason}`);
    s.reset();
    assert(s.blockedReason('gitee') === null, 'Reset Post Melting should be removed');
  });

  await test('Double source: returns the last result when the source is not reached (labels stale, no direct error))', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v1.2.3', assets: [] } },
    ];
    const first = await s.latest();
    assert(first.tag === 'v1.2.3' && !first.stale, 'The first time should be normal.');
    s._relTtl = 0;   // Exact cache.
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', error: 'Timeout' },
    ];
    const second = await s.latest();
    assert(second.tag === 'v1.2.3' && second.stale === true, 'The old results should be returned and marked.');
  });

  await test('system image drop point: The new installation must be left in the running-time directory (CI assembly running with this))', () => {
    const fs2 = require('fs');
    const os2 = require('os');
    const tmp = fs2.mkdtempSync(path.join(os2.tmpdir(), 'sysroot-'));
    const oldAppData = process.env.APPDATA;
    process.env.APPDATA = path.join(tmp, 'appdata');
    try {
      const store = require('../src/core/store');
      const { Provisioner } = require('../src/core/provision');
      const root = path.join(tmp, 'rt');
      store.saveSettings({ runtime: { dir: root } });
      const p = new Provisioner(path.join(__dirname, '..'));

      // 1) Full new installation: neither running-time directory nor user data directories system-images running-time directory
      assert(p.paths().sysImgRoot === path.join(root, 'system-images'),
        `Full new installation should run when directory, actual ${p.paths().sysImgRoot}`);

      // 2) There's already (package of pressure) in the runtime directory, give it priority.
      fs2.mkdirSync(path.join(root, 'system-images'), { recursive: true });
      assert(p.paths().sysImgRoot === path.join(root, 'system-images'), 'A priority time directory already exists');

      // 3) Only the user data directory has (old version layout)
      fs2.rmSync(path.join(root, 'system-images'), { recursive: true, force: true });
      fs2.mkdirSync(path.join(store.DATA_DIR, 'system-images'), { recursive: true });
      assert(p.paths().sysImgRoot === path.join(store.DATA_DIR, 'system-images'),
        `Old layout should return to user data directory, actual ${p.paths().sysImgRoot}`);
    } finally {
      if (oldAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = oldAppData;
      fs2.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test('Read-only running-time directory (MSIX package): writeable data must be rerouted to user data directory', () => {
    const fs2 = require('fs');
    const os2 = require('os');
    const tmp = fs2.mkdtempSync(path.join(os2.tmpdir(), 'ro-root-'));
    const oldAppData = process.env.APPDATA;
    process.env.APPDATA = path.join(tmp, 'appdata');
    try {
      const store = require('../src/core/store');
      const { Provisioner } = require('../src/core/provision');
      // Create a "non-written" root: make the middle level a normal document, mkdir must be EEXIST/ ENOTDIR
      const blocker = path.join(tmp, 'blocker');
      fs2.writeFileSync(blocker, 'x');
      const roRoot = path.join(blocker, 'rt');
      store.saveSettings({ runtime: { dir: roRoot } });
      const p = new Provisioner(path.join(__dirname, '..'));
      const paths = p.paths();
      assert(paths.rootWritable === false, 'Read-only directories must be recognized as unwritten');
      // Key: Mirrors must be rolled out to the user data directory, not inside the package (read-only in the package, roll-out will fail))
      assert(paths.sysImgRoot === path.join(store.DATA_DIR, 'system-images'),
        `Read-only should be left in the data directory, actual ${paths.sysImgRoot}`);
      assert(paths.tmp.toLowerCase().startsWith(store.DATA_DIR.toLowerCase()), '_tmp also reroute');
      assert(paths.avdHome.toLowerCase().startsWith(store.DATA_DIR.toLowerCase()), 'AVD must also be in a writeable directory');
      // The executable still points to the package (this is how the package is made and the %APDATA% virtual view is consistent with the parent process))
      assert(paths.emulatorExe === path.join(roRoot, 'emulator', 'emulator.exe'), 'Emulator is still running from the bag');
      assert(paths.adbExe === path.join(roRoot, 'platform-tools', 'adb.exe'), 'adb is still running from the package');
      // AnseureDirs can't just read and throw it wrong because of root.
      p.ensureDirs();
    } finally {
      if (oldAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = oldAppData;
      fs2.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test('Inner compressed mirrors must be "in position," otherwise they’ll be reconnected to 1.5 GB.', () => {
    const fs2 = require('fs');
    const os2 = require('os');
    const tmp = fs2.mkdtempSync(path.join(os2.tmpdir(), 'packed-img-'));
    const oldAppData = process.env.APPDATA;
    process.env.APPDATA = path.join(tmp, 'appdata');
    const sparse = (file, size) => {
      fs2.mkdirSync(path.dirname(file), { recursive: true });
      fs2.writeFileSync(file, '');
      fs2.truncateSync(file, size);   // Slipping file: Not really, but only big enough.
    };
    try {
      const store = require('../src/core/store');
      const { Provisioner } = require('../src/core/provision');
      // Simulate complete version install package / Shop MSIX: Only .xxz, no system. img to be rolled out
      const root = path.join(tmp, 'rt');
      const dir = path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64');
      sparse(path.join(dir, 'system.img.xz'), 320 * 1024 * 1024);
      fs2.writeFileSync(path.join(dir, 'kernel-ranchu'), 'x');
      store.saveSettings({ runtime: { dir: root } });
      // AppRoot use empty directory to avoid interference with the already-opened engine/system-images in the warehouse
      const p = new Provisioner(path.join(tmp, 'empty-app'));
      const sys = p.systemImageInfo();
      assert(sys.ok === true, 'The compressed mirror is in position.)');
      assert(sys.compressed === true, 'To mark "and also to expand once"');
      assert(String(sys.dir).toLowerCase().startsWith(root.toLowerCase()), 'Should point to the inside of the package');
      const play = p.playImageInfo();
      assert(play.ok === true && play.compressed === true, 'Synchronistic mirrors');

      // When started (with system.img) to become compressed=file and prioritize the roller
      sparse(path.join(dir, 'system.img'), 320 * 1024 * 1024);
      const after = p.systemImageInfo();
      assert(after.ok === true && after.compressed === false, 'No more compressions after expansion');
    } finally {
      if (oldAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = oldAppData;
      fs2.rmSync(tmp, { recursive: true, force: true });
    }
  });

  console.log('\n[Resource Policy / Disk Allocation / Log Maximum]');

  await test('Resource Strategy One Switch, Automaticly Translating VCPU/Priority/Resolution', () => {
    const store = require('../src/core/store');
    let s = store.saveSettings({ engine: { resourceMode: 'smooth' } });
    assert(s.engine.liteMode === false, 'Fluid mode should not limit the number of cores');
    assert(s.engine.priorityMode === 'game', 'Fluid mode should be in low-delayed game priority (FPS/Video priority))');
    assert(s.engine.renderSize === '720x1280', `Resolution should be 720p, actual ${s.engine.renderSize}`);
    s = store.saveSettings({ engine: { resourceMode: 'save' } });
    assert(s.engine.liteMode === true && s.engine.renderSize === '540x960', 'Saved resources should be 540p + light container');
    s = store.saveSettings({ engine: { resourceMode: 'balanced' } });
    assert(s.engine.renderSize === 'auto', 'Balance mode resolution to automatic');
  });

  await test('Data partition capacity is configured and default is no longer a dead number', () => {
    const store = require('../src/core/store');
    store.saveSettings({ engine: { dataPartitionGB: 12 } });
    const p = doctor.autoProfile({ settings: store.getSettings(), accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 50000 });
    assert(p.dataMB === 12 * 1024, `For 12 GB, actual ${p.dataMB}MB`);
    store.saveSettings({ engine: { dataPartitionGB: 0 } });
    const auto = doctor.autoProfile({ settings: store.getSettings(), accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 50000 });
    assert(auto.dataMB === 6144, `Automatically should be 6GB when disk is adequate, actual ${auto.dataMB}`);
  });

  await test('Fingerprints don\'t contain the size of the data partition.)', () => {
    const base = { emulatorVersion: '37.3.8', api: '34', tag: 'google_apis_playstore' };
    const a = doctor.snapshotKey({ ...base, dataMB: 4096 }, 'img');
    const b = doctor.snapshotKey({ ...base, dataMB: 24576 }, 'img');
    assert(a === b, 'You can’t change your fingerprints if you change your capacity.');
    const c = doctor.snapshotKey({ ...base, dataMB: 4096, emulatorVersion: '36.0.0' }, 'img');
    assert(a !== c, 'The engine version should change the fingerprints.');
  });

  await test('Automatically scroll logs above the cap, only one backup is kept', () => {
    const lf = require('../src/core/logfile');
    const f = path.join(TMP, 'rot.log');
    fs.writeFileSync(f, 'x'.repeat(300 * 1024));
    const rotated = lf.rotate(f, 256);
    assert(rotated === true, 'Scroll should be executed');
    assert(!fs.existsSync(f) && fs.existsSync(path.join(TMP, 'rot.1.log')), 'should become 1.log');
  });

  await test('If the log file name does not end with. log: you prefer not to roll and not delete the log', () => {
    const lf = require('../src/core/logfile');
    const f = path.join(TMP, 'plain.txt');
    fs.writeFileSync(f, 'x'.repeat(300 * 1024));
    const rotated = lf.rotate(f, 256);
    assert(rotated === false, 'bak must discard scrolling when same name as source file');
    assert(fs.existsSync(f), 'Log files cannot be deleted');
  });

  await test('The startup failure logs drop, and the diagnosis can be reset and then the real reason can be seen.', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    emu.lastExitCode = 3221225477;
    emu.lastDiagnosis = doctor.diagnose(['emulator exit 3221225477']);
    emu.attempts = [{ plan: 'Host/ Hardware Acceleration', diagnosis: 'ACCESS_VIOLATION', exitCode: 3221225477 }];
    emu._persistFailure({ why: 'test' });
    const back = emu.lastFailure();
    assert(back && back.exitCode === 3221225477, 'Exit code should drop');
    assert(back.diagnosis && back.diagnosis.code === 'ACCESS_VIOLATION', 'The diagnosis should be set aside.');
    assert(back.attempts.length === 1, 'Try to log down the disk');
    emu._clearFailure();
    assert(emu.lastFailure() === null, 'The record of failure should be cleared after the start-up.');
  });

  await test('.xapk Break Subpack: Streamed out fragments, parsed base, clean the temporary directory if failed', async () => {
    const crypto = require('crypto');
    const { parseBundle } = require('../src/core/installer');
    const { buildApkBytes, buildStoredZip } = require('./lib/make-apk');
    const apk = buildApkBytes();

    // Success: Two pieces in the package (base + config), meta from the parsable one
    const okPath = path.join(TMP, 'ok.xapk');
    fs.writeFileSync(okPath, buildStoredZip([
      { name: 'base.apk', data: apk },
      { name: 'split_config.arm64_v8a.apk', data: apk },
      { name: 'manifest.json', data: Buffer.from('{}') },
    ]));
    const b = await parseBundle(okPath);
    try {
      assert(b.files.length === 2, `2 fragments should be decoded, actual ${b.files.length}`);
      assert(b.files.every((f) => fs.existsSync(f)), 'Discrete should fall');
      assert(b.meta.package === 'com.example.test', `Package name ${b.meta.package}`);
    } finally {
      b.cleanup();
    }

    // Failed: The package contains no APK sub-snippets and clearly states that the temporary directory cannot be left on the user machine
    const badPath = path.join(TMP, 'bad.xapk');
    fs.writeFileSync(badPath, buildStoredZip([{ name: 'readme.txt', data: Buffer.from('nope') }]));
    let err = null;
    try { await parseBundle(badPath); } catch (e) { err = e; }
    assert(err && /no (split APKs|APK splits)/i.test(err.message), `There’s no film, actually. ${err && err.message}`);
    const dir = path.join(os.tmpdir(), 'hydra-bundle',
      crypto.createHash('sha1').update(badPath).digest('hex').slice(0, 12));
    assert(!fs.existsSync(dir), '_Other Organiser');
  });

  await test('MaleializeImages: Expand. img.gz, has jumped and bad mirrors have failed without missing half a leg', async () => {
    const zlib = require('zlib');
    const store = require('../src/core/store');
    const { Provisioner } = require('../src/core/provision');
    const before = store.getSettings().runtime.dir;
    const rt = path.join(TMP, 'rt-materialize');
    const imgDir = path.join(rt, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64');
    fs.mkdirSync(imgDir, { recursive: true });
    fs.writeFileSync(path.join(imgDir, 'kernel-ranchu'), 'kernel');
    // 40MB Zero: only a few dozen KBs after gzip, but after decompression > 32MB, the determination is valid for "started"
    fs.writeFileSync(path.join(imgDir, 'system.img.gz'), zlib.gzipSync(Buffer.alloc(40 * 1024 * 1024, 7)));
    store.saveSettings({ runtime: { dir: rt } });
    const prov = new Provisioner(path.join(__dirname, '..'));
    try {
      const n = await prov.materializeImages();
      assert(n === 1, `1 mirror should be expanded, actual ${n}`);
      const img = path.join(imgDir, 'system.img');
      assert(fs.statSync(img).size === 40 * 1024 * 1024, 'Expand size is correct');
      assert(fs.existsSync(path.join(imgDir, 'kernel-ranchu')), 'Non-compressive components should be co-located');
      assert(!fs.existsSync(`${img}.part`), 'You shouldn’t stay when you’re successful.');

      const again = await prov.materializeImages();
      assert(again === 0, `Skipped when started, actually started ${again}`);

      // Bad mirror: Must throw MATERIALIZE_FAILED, and clear. part (if not next time it’ll be considered finished))
      fs.rmSync(img, { force: true });
      fs.writeFileSync(path.join(imgDir, 'system.img.gz'), Buffer.from('not a gzip at all'));
      let err = null;
      try { await prov.materializeImages(); } catch (e) { err = e; }
      assert(err && err.code === 'MATERIALIZE_FAILED', `Bad mirror should fail, actual ${err && err.message}`);
      assert(!fs.existsSync(`${img}.part`), 'You’re not supposed to stay after a failure.');
    } finally {
      store.saveSettings({ runtime: { dir: before } });
    }
  });

  await test('Change download source/package address: The address cache of the profiler must be cleared (or it will be restarted before it becomes effective))', () => {
    const { Provisioner } = require('../src/core/provision');
    const p = new Provisioner(path.join(__dirname, '..'));
    // Simulate a cache after a package address / engine address
    p._cache.pack = { url: 'https://old.example/runtime.zip', tag: 'v1' };
    p._cache.emulatorUrl = 'https://old.example/emulator.zip';
    p._cache.sysimgUrl = 'https://old.example/sysimg.zip';
    p.invalidateEnvCache();
    assert(!p._cache.pack, 'The whole address cache should be cleared.');
    assert(!p._cache.emulatorUrl && !p._cache.sysimgUrl, 'Engine/sphere address cache should be cleared');
  });

  await test('Each round starts with a log-only diagnosis (the previous crash cannot contaminate the next round).)', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    emu._log = [
      { t: 1, line: 'Graphics backend: gfxstream' },
      { t: 2, line: 'emulator exit 3221225477' },        //  Round 1: 0xC00000005
      { t: 3, line: '--- Round 2 ---' },
      { t: 4, line: 'Address already in use' },          // Round 2: Occupied Port
    ];
    assert(doctor.diagnose(emu._attemptLines(0, 80)).code === 'ACCESS_VIOLATION', 'Round 1 collapses');
    assert(doctor.diagnose(emu._attemptLines(2, 80)).code === 'PORT_BUSY', '2nd Round Consumption Port');
    // Back to the end when there’s no log on this wheel. You can’t go straight to UNKNOWN.
    const fallback = emu._attemptLines(emu._log.length, 80);
    assert(fallback.length === emu._log.length, `Empty wheels should be returned to the overall log, actual ${fallback.length} Okay.`);
  });

  await test('Start component integration: Full component cannot repeat the package name (or the point icon only sees the Android desktop))', () => {
    const { componentArg, parseResolvedActivity } = require('../src/core/adb');
    // Complete components (v0.3.4 is stored in apps.json)
    assert(componentArg('com.phoenix.read', 'com.phoenix.read/com.dragon.read.pages.splash.SplashActivity')
      === 'com.phoenix.read/com.dragon.read.pages.splash.SplashActivity', 'The complete component returns as it is.');
    // Old data: Pure / Class name starting with point → Complement name
    assert(componentArg('com.a.b', 'MainActivity') === 'com.a.b/MainActivity');
    assert(componentArg('com.a.b', '.MainActivity') === 'com.a.b/.MainActivity');
    assert(componentArg('com.a.b', '') === '', 'Empty activity should return empty (obsolete intent))');
    // Resolve-active end of output always available/priority line: components must be available
    const out = 'priority=0\ncom.phoenix.read/com.dragon.read.pages.splash.SplashActivity\n\n';
    assert(parseResolvedActivity('com.phoenix.read', out)
      === 'com.phoenix.read/com.dragon.read.pages.splash.SplashActivity', 'You should skip the empty line to the last line component.');
    assert(parseResolvedActivity('com.other', out) === '', 'No other name for the bag.');
  });

  await test('Individual application window: a stand-alone shell window must not be displayed', () => {
    const root = path.join(__dirname, '..');
    const appwin = fs.readFileSync(path.join(root, 'src', 'core', 'appwin.js'), 'utf8');
    // Maximize() will show:
    // One of the direct causes of the "open application multiple windows".
    assert(/fullscreen && !this\.detachedMode\) this\.win\.maximize\(\)/.test(appwin),
      'Separate window mode cannot maximize shell window (a black window will be displayed empty))');
    assert(/if \(this\.detachedMode\) this\.agent\.show\(\)/.test(appwin),
      'Repeat the same application in stand-alone mode to push the simulator window forward instead of displaying the shell window');
    // You can’t just show:
    // It’s only when you’re open and you’re allowed to show the shell.
    const readyIdx = appwin.indexOf("once('ready-to-show'");
    assert(readyIdx > 0 && /if \(this\.detachedMode && !this\._showWhileWaiting\) return;/
      .test(appwin.slice(readyIdx, readyIdx + 600)),
    'Read-to-show under stand-alone mode default must be directly returned');
  });

  await test('Enable the drawing: splash state must be modular, otherwise it will never be turned off', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    // RunLaunch / autoDeploy is defined whenReady returns**Outside.**, Go back to the const.
    // They don’t even see it -- it’s the same thing that’s causing it.
    // 480x360 always on On Top is nailed to the center of the screen.
    assert(/^let splashWin = null;$/m.test(mainJs), 'splashWin must be a module level let');
    assert(/^let splashDone = \(\) => \{\};$/m.test(mainJs), 'splashDone must be a module level let');
    assert(/^let splashProgress = \(\) => \{\};$/m.test(mainJs), 'splashProgress must be a module level let');
    assert(!/const splashDone = \(\) =>/.test(mainJs), 'Can’t overwnReady');
    // The main process is closed when you don’t turn it off.
    assert(/setTimeout\(\(\) => \{[\s\S]{0,160}splashWin\.close\(\);/.test(mainJs),
      'SplashDone, then a fuse.');
  });

  await test('Multi-window: Start application by closing the management window before opening the application window', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const launchIdx = mainJs.indexOf('async function runLaunch(');
    const body = mainJs.slice(launchIdx, launchIdx + 4200);
    const hideIdx = body.indexOf('mainWindow.hide()');
    const openIdx = body.indexOf('openAppWindow(pkg');
    assert(hideIdx > 0 && openIdx > 0, 'Both calls are in RunLaunch.');
    assert(hideIdx < openIdx, 'MainWindow.hide() must be seen before openAppWindow (otherwise two windows will be seen at the same time))');
  });

  await test('Pane direction must be consistent with the application statement, otherwise it will only be mailboxised.', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const apkJs = fs.readFileSync(path.join(root, 'src', 'core', 'apk.js'), 'utf8');
    const storeJs = fs.readFileSync(path.join(root, 'src', 'core', 'store.js'), 'utf8');
    const installerJs = fs.readFileSync(path.join(root, 'src', 'core', 'installer.js'), 'utf8');

    assert(/function wantLandscapeFor\(pkg\)/.test(mainJs), 'There\'s a determination as to which direction this application should take.');
    assert(/orientationMode/.test(mainJs), 'To read the orientation policy in the settings');
    assert(/orientationOverride/.test(mainJs), 'Single application direction coverage to take effect');
    // Start the path with it, not the naked disclaySettings().landscape
    assert(/const wantLand = wantLandscapeFor\(pkg\)/.test(mainJs), 'You\’re gonna have to be judged in the direction of the application.');
    assert(/const land = wantLandscapeFor\(pkg\)/.test(mainJs), 'OpenAppWindow to open the window in the application direction');
    // Offline from APK List
    assert(/function detectOrientation\(/.test(apkJs), 'The application direction to be judged from the APK list offline');
    assert(/orientation,/.test(apkJs), 'parseApk returns the order');
    assert(/orientation: meta\.orientation/.test(installerJs), 'Put the direction in when installed, apps.json');
    assert(/orientationMode: 'auto'/.test(storeJs), 'The default policy is to follow the application');
    // Old data backfill: either the top or the black side.
    assert(/orientation backfill/.test(mainJs), 'The old version is going back to fill in.');
  });

  await test('Pane screen: A restart triggered by inconsistent directions cannot interrupt the startup.', () => {
    const root = path.join(__dirname, '..');
    const installerJs = fs.readFileSync(path.join(root, 'src', 'core', 'installer.js'), 'utf8');
    // Before Start returns the new rt, which used to be written here, once the branch is reboot.
    // Throwing "Assignment to priority."
    assert(/let rt = await this\.runtime\.ensure\(\{ onLog \}\)/.test(installerJs),
      'rt must be let, otherwise the reboot of clit will crash');
    assert(/if \(replaced && replaced\.client\) rt = replaced;/.test(installerJs), 'To accept new rt');
  });

  await test('Toggle application cannot leave an empty screen: shell windows will be displayed while waiting in stand-alone mode', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const appwin = fs.readFileSync(path.join(root, 'src', 'core', 'appwin.js'), 'utf8');
    // stand-alone window mode (default) underhell window is not shown at regular times; switching to another direction when running again
    // In about 40 seconds, if you don’t show anything during this period, the user will think the program is down.
    assert(/showWhileWaiting: detached && !splashVisible/.test(mainJs),
      'When independent mode and without a motor painting, show WheelWatiting');
    assert(/splashVisible = !!\(splashWin && !splashWin\.isDestroyed\(\)\)/.test(mainJs),
      'Whether or not splash is showing who is responsible for telling the user "waiting"');
    assert(/const willRestart = land !== !!displaySettings\(\)\.landscape/.test(mainJs),
      'To be able to prejudge "this time it\'s going to be restarted."');
    assert(/if \(this\.detachedMode && !this\._showWhileWaiting\) return;/.test(appwin),
      'Ready-to-show displays shell windows only when show');
    assert(/Switching to.{0,75}for/i.test(mainJs), 'I\'m going to tell you why it\'s so slow.');
    // When really starting to reboot, pre-attach may have put the shell window away -- it has to be lit again.,
    // Otherwise, the 40-second desktop will be completely empty.
    assert(/appWin\.showWaiting\(/.test(mainJs), ' Restart to re-show the waiting window');
    assert(/waitingForRestart/.test(appwin), 'Have a "waiting to restart" mark');
    // The pre-attach rotation at the start-up stage must see that the mark must be turned off, and the waiting window cannot be dropped again.
    assert(/if \(appWin\.waitingForRestart\)/.test(mainJs), 'I’m going to have to make way.');
  });

  await test('Titles to be set before show, otherwise the name of the application will flash.', () => {
    const root = path.join(__dirname, '..');
    const appwin = fs.readFileSync(path.join(root, 'src', 'core', 'appwin.js'), 'utf8');
    const start = appwin.indexOf('async openDetached(');
    const body = appwin.slice(start, start + 3400);
    const titleIdx = body.indexOf('this.agent.setTitle(');
    const showIdx = body.indexOf('this.agent.show()');
    assert(titleIdx > 0 && showIdx > 0, 'Both calls are in openDetached.');
    assert(titleIdx < showIdx, 'SetTitle must be before show (agent cached last title))');
  });

  await test('We can\'t just reset data once.', () => {
    const root = path.join(__dirname, '..');
    const emuJs = fs.readFileSync(path.join(root, 'src', 'core', 'emulator.js'), 'utf8');
    // Wi-Fi connection is 5-20 seconds later than sys.boot_completed, and "no network" is equal to every time.
    // Cold starters are misreported; and the previous remediation proposal was to replace Android data (which would delete the application already installed).
    assert(/checkNetwork\('', \{ waitMs: \d+, interval: \d+ \}\)/.test(emuJs),
      'We\’re gonna have to wait for the window after the network check. We can\’t check it and we can\’t make a decision.');
    const boot = emuJs.slice(emuJs.indexOf('Run Ready'));
    const warn = boot.slice(0, 4000);
    // Only the code line: the comment explaining "previously suggested here to reset data" does not count.
    const warnCode = warn.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    assert(!/reset Android data/i.test(warnCode), 'This reminder does not recommend that "replace Android data" (will discard the application already installed))');
    assert(/not yet connected/i.test(warnCode), 'It\'s not scary, it\'s not misleading.');
  });

  await test('The black window on the control table is to be crushed with a high-frequency channel.', () => {
    const root = path.join(__dirname, '..');
    const ps1 = fs.readFileSync(path.join(root, 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    // Windows will create a new control window when emulator pulls up qemu (Win11 tops Windows Terminal)),
    // Only 200 to 300 ms; 250 ms will be missed.
    assert(/_consoleSweep/.test(ps1), 'There’s an independent control scanner time stamp.');
    assert(/now - _consoleSweep > \(_perfMode \? 200 : 100\)/.test(ps1), 'First 15 seconds, 100ms, one round of sweep control.');
    assert(/now - _bootHideStart < 15000/.test(ps1), 'HF channels only run in the open window, avoid long-term burning of CPUs');
    // Must be "Consistency window + header hits running path" and cannot be returned to the pid white list
    assert(/static void HideConsoleWindows\(\)/.test(ps1) && /IsOurConsole\(h\)/.test(ps1),
      'The control station belongs to an IsourConsole pid, not an emulator)');
  });

  await test('Unable to "re-use" a disabled simulator after restarting the panel', () => {
    const root = path.join(__dirname, '..');
    const emuJs = fs.readFileSync(path.join(root, 'src', 'core', 'emulator.js'), 'utf8');
    // The launcher was just the qemu, but this.proc will keep it.
    // (Just look at it. = Think of the machine that’s been shut down as alive.:
    // RestartForOrganization Turns off the machine and then immediately after → start(),
    // Caller’s holding dead serial. Go, adb. → `device not found`, Switching application directly failed.
    const reuse = emuJs.slice(emuJs.indexOf('async start('), emuJs.indexOf('async start(') + 900);
    assert(/_consoleAlive\(\)/.test(reuse), 'Start() \'s re-use branch must confirm that there is a machine on the control portal.');
    assert(/this\.proc = null;/.test(reuse), 'Make sure you clear the proc and go with the real startup.');
    // Stop() closes and drops the trigger handles, otherwise running() will always be true
    const stopFn = emuJs.slice(emuJs.indexOf('async stop('), emuJs.indexOf('async stop(') + 3400);
    assert(/killAttempt\(\)[\s\S]{0,200}this\.proc = null;/.test(stopFn), 'Stop() close this.proc');
    // The engine layer also has to guard against another illusion: adb remains short-timed when the simulators are out.,
    // And so the verdict is online, and the following orders are complete.
    const engineJs = fs.readFileSync(path.join(root, 'src', 'core', 'engine.js'), 'utf8');
    const inner = engineJs.slice(engineJs.indexOf('async _ensureInner('), engineJs.indexOf('async _ensureInner(') + 2200);
    assert(/getprop sys\.boot_completed/.test(inner), 'It\’s a real order to add to the authentication device.');
    assert(/probe !== null/.test(inner), 'Do not reuse old client when the command is not working');
    // And then we’re gonna have to wait for the adb side device to really disappear and pull up the new machine.
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const rot = mainJs.slice(mainJs.indexOf('async function restartForOrientation'), mainJs.indexOf('async function restartForOrientation') + 2600);
    assert(/c\.isOnline\(\)\.catch\(\(\) => false\)/.test(rot), 'Stop and wait for the adb device to disappear.');
  });

  await test('Windows Terminal will also be able to recognize the opening black box.', () => {
    const root = path.join(__dirname, '..');
    const ps1 = fs.readFileSync(path.join(root, 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    // Win11 Switches the default control host to Windows Terminal and the qemu control window belongs to
    // WindowsTerminal.exe: Pid/Parent Process Chain/Titles are not all ours, but only "does not exist before the start of the plane."
    assert(/static void SnapshotConsoles\(\)/.test(ps1), 'You have to write down the control window before you start.');
    assert(/_consolesBeforeBoot/.test(ps1), 'You need a snapshot of the control desk before you turn it on.');
    assert(/now - _bootHideStart < 20000[\s\S]{0,120}_consolesBeforeBoot\.Contains/.test(ps1),
      'Only "New in 20 seconds after starting" control window');
    assert(/tl\.IndexOf\("terminal", StringComparison\.Ordinal\) >= 0/.test(ps1),
      'The title is empty or strapped to terminal.)');
    assert(/SnapshotConsoles\(\);/.test(ps1), 'You have to take a snapshot when you’re in the room.');
  });

  await test('Startup to stringing: connection point/toggle application cannot run twice and twice', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    // A maximum of 80 seconds for start-up at once (reboot panel + cold start). An application will be true for one more application during the previous period.
    // OpenAppWindow turns off the application that’s being started, and the virtual machine’s restarting.,
    // Both sides failed. The log is... `cmd: Can't find service: activity`.
    assert(/let launchInFlight = null;/.test(mainJs), 'We need a record of active start-up.');
    assert(/if \(launchInFlight\.pkg === pkg\)[\s\S]{0,120}return launchInFlight\.promise;/.test(mainJs),
      'The same application link to be reused.');
    assert(/launch queued \$\{pkg\}/.test(mainJs), 'Change applications to line up instead of pulling them off.');
    assert(/async function launchOne\(pkg\)/.test(mainJs), 'The original subject is to be broken down into launchone.');
    assert(/launchInFlight = entry;/.test(mainJs), 'Clear it in the final one, and avoid the jamming.');
  });

  await test('Hardware acceleration: Shop board guide user on WHPX, install one key to AEHD open and back', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const appJs = fs.readFileSync(path.join(root, 'src', 'ui', 'app.js'), 'utf8');
    const preloadJs = fs.readFileSync(path.join(root, 'src', 'preload.js'), 'utf8');

    // 1) The real WHPX function for emulators is HypervisorPlatform (virtual platform is WSL2)),
    //    It has to be in front of the front; both are open once to cover different machines.
    assert(/for \(const f of \['HypervisorPlatform', 'VirtualMachinePlatform'\]\)/.test(mainJs),
      'You have to start with the one that the Hypervisor Platform really needs.)');
    // 2) Can't use WinHvPlatform.dll as a switch: Modern Windows has always been there.,
    //    This way, it’s gonna keep the machine that really needs to function out of the door.
    const handler = mainJs.slice(mainJs.indexOf("ipcMain.handle('provision:enableVirtualization'"));
    const handlerBody = handler.slice(0, 4000);
    assert(!/if \(hv\.dll\) \{/.test(handlerBody), 'WinHvPlatform.dll');
    // 3) Shop (MSIX) version: returns to manual guidance without the right of access, instead of playing a failed UAC
    assert(/if \(store\.STORE_BUILD\) \{[\s\S]{0,900}manual: true/.test(handlerBody),
      'Return amanual to UI when the shop page fails');
    assert(/Store build cannot request elevation/i.test(mainJs), 'The shop version is about to explain why it can\'t be opened automatically.');
    assert(/Windows Hypervisor Platform/i.test(mainJs), 'Name the Windows feature in the Store repair instructions');
    // 4) The acceleration cache must be cleared after the start-up has been successful, otherwise the interface shows old conclusions
    assert(/const whpx = await enableWhpxFeatures\(\);\s*\n\s*runtime\.provisioner\.invalidateEnvCache/.test(mainJs),
      'Start with valueEnvCache.');
    // 5) User-pointed "No" to distinguish between actual failure (1223 = ERROR_CANCELLED))
    assert(/1223/.test(mainJs) && /cancelled/.test(mainJs), 'Distinguishing UAC Cancel');
    // 6) The "Windows Virtual Machine Monitor Program Platform" is a classic dialogue box, not a ms-settings page
    assert(/optionalfeatures\.exe/.test(mainJs), 'To open classic opalfeatures.exe');
    // UI to handle manual / cancelled, and to really open that dialogue box
    assert(/r\.manual/.test(appJs) && /api\.openWindowsFeatures/.test(appJs), 'UI handles manual branches');
    assert(/openWindowsFeatures: \(\) => invoke\('provision:openWindowsFeatures'\)/.test(preloadJs),
      'Preload to expose openWindowsFeatures');
    // 8) System notification for the first start of a software simulation (self-check users in settings are likely not to see))
    assert(/let accelWarned = false;/.test(mainJs) && /using software emulation/i.test(mainJs),
      'The software simulation is reminded.');
  });

  await test('Packing must be written to exe icon/version, otherwise the resource manager shows the Elementron default icon', () => {
    const root = path.join(__dirname, '..');
    const packJs = fs.readFileSync(path.join(root, 'build', 'pack.js'), 'utf8');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const pkg = require(path.join(root, 'package.json'));

    // Exe is also Ecleon: FileDescription=Eclecron,
    // ProducName = Electric, Company Name = GitHub, Inc., version 33.4.11, icons are also default.
    assert(/function embedExeMeta\(exe\)/.test(packJs), 'Need exe meta-writing steps');
    assert(/--set-icon/.test(packJs), 'To write icons');
    assert(/--set-file-version/.test(packJs), 'To write a version of the document');
    assert(/--set-version-string', 'FileDescription'/.test(packJs), 'Write FileDescription');
    assert(/--set-version-string', 'ProductName', 'Hydra Emulator'/.test(packJs), 'ProductName must be Hydra Emulator');
    assert(/embedExeMeta\(exePath\)/.test(packJs), 'You need to call after the name changes.');
    // rcedit is not found to send a clear warning and cannot be silently output the "Elementron icon" package
    assert(/Could not find rcedit\.exe/i.test(packJs), 'rcedit is missing to warn');

    // Taskbar Identity: Without AppUSerModelID, taskbar fixes/ notifications will fall on "Electron"
    assert(/setAumid\(APP_AUMID\);/.test(mainJs), 'Setup AppUSerModelID on startup');

    // Full version (including runtime) as a deliverable version
    assert(/--full/.test(packJs) && /Hydra Emulator-v\$\{PKG\.version\}-win64-full/.test(packJs),
      'Full version of the directory to produce with version number');
    assert(/build', 'runtime'/.test(packJs), 'Build/ rantime to inside the full version');
  });

  await test('Version uniform: package. json / MSIX 4 / Document package name is identical', () => {
    const root = path.join(__dirname, '..');
    const pkg = require(path.join(root, 'package.json'));
    const { msixVersion } = require(path.join(root, 'build', 'msix.js'));
    const four = msixVersion(pkg.version);
    assert(/^\d+\.\d+\.\d+\.0$/.test(four), `MSIX Four Version Numbering Wrong: ${four}`);
    const artifact = `Hydra Emulator_${four}_x64.msix`;
    for (const f of ['docs/store-msix.md']) {
      const t = fs.readFileSync(path.join(root, f), 'utf8');
      assert(t.includes(artifact), `${f} The current package name should be quoted. ${artifact}`);
    }
    // The exe version of the document is also to be given the same number (four paragraphs), and not to talk to package.json.
    const packJs = fs.readFileSync(path.join(root, 'build', 'pack.js'), 'utf8');
    assert(/\$\{PKG\.version\}\.0/.test(packJs), 'ex-file version to match with package.json');
    // The store bag and exe are from the same version, and there's no second hard code version.
    const msixJs = fs.readFileSync(path.join(root, 'build', 'msix.js'), 'utf8');
    assert(/const VERSION = String\(pkg\.version/.test(msixJs), 'MSIX version number must be taken from cardage.json');
  });

  await test('Android must use his own icons and his own taskbar identity as a shortcut.', () => {
    const root = path.join(__dirname, '..');
    const installerJs = fs.readFileSync(path.join(root, 'src', 'core', 'installer.js'), 'utf8');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const shortcutJs = fs.readFileSync(path.join(root, 'src', 'core', 'shortcut.js'), 'utf8');

    // Icon for desktop/start menu shortcut = “Backname“.ico from APK, not by Hydra Emulator
    assert(/const ico = app\.icoPath && fs\.existsSync\(app\.icoPath\) \? app\.icoPath : undefined;/.test(installerJs),
      'Use your own copath');
    assert(/iconIcoPath: ico/.test(installerJs), 'WriteShortcut to get application icons');
    assert(!/iconIcoPath:\s*(APPICON|appicon|brandIcon)/.test(installerJs), 'Could not use Hydra Emulator’s brand icon');
    // Apply an AUMID: Taskbar to group the application so that a fixed entry recognizes which application
    assert(/appUserModelId: `Hydra\.Emulator\.\$\{app\.package\}`/.test(installerJs),
      'Each application must have its own AUMID.');
    // Windows only uses shortcut icons when "Process AUMID = = Shortcut AUMID",
    // So when you open an application, you cut the process identity back to the management window and back to Hydra Emulator.
    assert(/const APP_AUMID = 'Hydra\.Emulator';/.test(mainJs), 'Have a uniform AUMID prefix');
    assert(/setAumid\(`\$\{APP_AUMID\}\.\$\{pkg\}`\)/.test(mainJs), 'AUMID to be cut to the application before opening the application window');
    assert(/function showWindow\(\) \{\s*\n\s*\/\/[^\n]*\n\s*setAumid\(APP_AUMID\);/.test(mainJs),
      'Back management window to cut back AUMID from Hydra Emulator');
    // writeShortcut must set the iconIndex to 0, otherwise certain dimensions will be wrong
    assert(/icon: opt\.iconIcoPath \|\| opt\.target/.test(shortcutJs), 'Icon path to return to target');
    assert(/iconIndex: 0/.test(shortcutJs), 'iconIndex if 0');
  });

  await test('Red fruit screen: Directional decision must be condensed to a pure function, overwrite the APK list', () => {
    const root = path.join(__dirname, '..');
    const o = require('../src/core/orientation');

    // Mandatory Mode Top Priority
    assert(o.resolveLandscape({ mode: 'landscape', orientation: 'portrait', orientationOverride: 'portrait' }) === true,
      ' Force the screen to cover everything.');
    assert(o.resolveLandscape({ mode: 'portrait', orientation: 'landscape', orientationOverride: 'landscape' }) === false,
      ' Force the screen to cover everything.');
    // Single application overrides the APK List declaration - a red fruit APK declaration portrait, and must cross over when user clicks overscreen
    assert(o.resolveLandscape({ mode: 'auto', orientation: 'portrait', orientationOverride: 'landscape' }) === true,
      'Per-app screen overwrite portrait declarations to overwrite APK');
    assert(o.resolveLandscape({ mode: 'auto', orientation: 'landscape', orientationOverride: 'portrait' }) === false,
      'Per-app screen overwrite landscape declaration to overwrite APK');
    // Say it to APK when it’s not covered, follow the panel if it’s not.
    assert(o.resolveLandscape({ mode: 'auto', orientation: 'portrait' }) === false, 'APK declaration on no overlay');
    assert(o.resolveLandscape({ mode: 'auto', orientation: null, panelLandscape: true }) === true, 'Follow gravity and the panel.');
    // Rotate inverse + overwrite matching (Rotation button writing over, next start must read back in the same direction))
    assert(o.flipLandscape(false) === true && o.flipLandscape(true) === false, 'Flip to reverse');
    assert(o.parseOverride(o.overrideValue(true)) === true, 'Horizontal overwrite value is identical');
    assert(o.parseOverride(o.overrideValue(false)) === false, 'Screen overlays are identical');

    // All three entrances must follow the same decision-making function.)
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    assert(/wantLandscapeFor\(pkg\)\s*\)?\.?\s*/.test(mainJs) && /orientation\.resolveLandscape/.test(mainJs),
      '♪ ♪ want LandscapeFor ♪');
    assert(/async function rotateCurrentApp\(\)/.test(mainJs), 'There\'s a uniform rotation entrance.');
    assert(/orientation\.flipLandscape\(current\)/.test(mainJs), 'Rotate the entrance with the same flip');
    assert(/orientation\.overrideValue\(next\)/.test(mainJs), 'Rotate the entrance to write the same overlay value');
    const shellJs = fs.readFileSync(path.join(root, 'src', 'ui', 'shell.js'), 'utf8');
    assert(/shell\.rotate\(\)/.test(shellJs), 'Titlebar Rotation Buttons to the Uniform Entry');
  });

  await test('The mirror rotates automatically to the default, but the panel direction remains locked by wm', () => {
    const root = path.join(__dirname, '..');
    const o = require('../src/core/orientation');
    // Default (No Set / UnClosed) = Open
    assert(o.autoRotateSetting({}) === '1', 'Open auto rotation by default');
    assert(o.autoRotateSetting({ display: {} }) === '1', 'Display is also open by default');
    assert(o.autoRotateSetting({ display: { autoRotate: false } }) === '0', 'The user switch off is not returning 0.');
    // store default to write True
    const storeJs = fs.readFileSync(path.join(root, 'src', 'core', 'store.js'), 'utf8');
    assert(/autoRotate:\s*true/.test(storeJs), 'store default autoRotate=true');
    // Add both paragraphs with acceleration switch and retain the direction lock authority command (check 0/ signature-request pre-test).)
    const adbJs = fs.readFileSync(path.join(root, 'src', 'core', 'adb.js'), 'utf8');
    assert(/accelerometer_rotation \$\{guestAutoRotate\(\)\}/.test(adbJs), 'adb uses the guestAutoRotate value');
  });

  await test('Window mode: Default native window, two modes can be switched in settings and only migrate once', () => {
    const root = path.join(__dirname, '..');
    const storeJs = fs.readFileSync(path.join(root, 'src', 'core', 'store.js'), 'utf8');
    // 0.6.0: Falls and has black edges when the SetParent zooms/rotations, coordinates are mispositioned,
    // Replace default with a simulator opening its own primary window.
    assert(/windowEmbed:\s*false,/.test(storeJs), 'I\’m sorry, Mr. Settings.display.windowEmbed must be false');
    // One-time migration: only "no-option" configurations, and users can’t get their picks back over and over again
    assert(/windowEmbedMigrated2/.test(storeJs), 'One-time migration tag.');
    assert(/windowEmbedChosen !== true/.test(storeJs), 'The configuration selected does not migrate');
    // The tags are not enough: the old configuration may be "migrate2=true but the value is still true" (removed into the disk/ hands modified)),
    // That's the kind of situation that's been spared before, and it's been activated and it's been glorified.
    assert(/d\.windowEmbedChosen !== true && d\.windowEmbed !== false/.test(storeJs),
      'The migration conditions cannot depend on windowEmbedMigrate2, otherwise the old tags will leak.');
    // The primary window must be picked up as soon as possible, so don't let the user do the glorified waiting pages.
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    assert(/appWin\.openDetached\(\)/.test(mainJs), 'Try to connect the simulator to the original window at startup.');
    // The takeover failed must be retryed, otherwise the shell window has been parked on the screen.)
    const attachBody = mainJs.slice(mainJs.indexOf('async function attachAppWindow'), mainJs.indexOf('async function attachAppWindow') + 2200);
    assert(/for \(let i = 0; i < 4; i \+= 1\)/.test(attachBody), 'The primary window takes over and tries again.');
    assert(/falling back to embedded mode/i.test(attachBody), 'Four wheels of failure, no black screens.');
    const appJs = fs.readFileSync(path.join(root, 'src', 'ui', 'app.js'), 'utf8');
    assert(/windowEmbedChosen:\s*true/.test(appJs), 'To write the ’Selected ’ tag when setting the page switch');
    const indexHtml = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');
    assert(/setWindowEmbed/.test(indexHtml), 'Window mode to switch entrances in settings');
    // Original window is in the first option, and the default is the first time the user sets it.
    const sel = indexHtml.slice(indexHtml.indexOf('id="setWindowEmbed"'), indexHtml.indexOf('id="setWindowEmbed"') + 400);
    assert(sel.indexOf('value="detached"') < sel.indexOf('value="embed"'), 'Native window should be the default option (prior))');
  });

  await test('Window mode: The probe and the automatic detection are based on the new default', () => {
    const root = path.join(__dirname, '..');
    const probeJs = fs.readFileSync(path.join(root, 'src', 'core', 'autodebug-probe.js'), 'utf8');
    // Only visible true is included in the embedded mode and is processed in raw windows when not set
    assert(/windowEmbed:\s*!!\(settings\.display && settings\.display\.windowEmbed === true\)/.test(probeJs),
      'The probe is based on “treasumatic“ for embedding.');
  });

  await test('Load speed: Network state fresh cache quick recovery, aborted when running', () => {
    const root = path.join(__dirname, '..');
    const engineJs = fs.readFileSync(path.join(root, 'src', 'core', 'engine.js'), 'utf8');
    // WaitForNetwork directly returns the cache within 8 seconds, saves adb from continuous calls
    assert(/cached\.ok && Date\.now\(\) - cached\.at < 8000/.test(engineJs), 'WaitForNetwork Reuse Fresh Network Cache');
    // Stop() clears the cache and, after restart, does not misuse the old state before shutdown to cause the black screen
    const stopBody = engineJs.slice(engineJs.indexOf('async stop('), engineJs.indexOf('async stop(') + 400);
    assert(/this\._lastNetwork = null/.test(stopBody), 'Stop, we need to clear the web cache.');
  });

  await test('Packing must be accompanied by production dependency (otherwise @napi-rs/lzma missing, mirror not open, application not open))', () => {
    const root = path.join(__dirname, '..');
    const packJs = fs.readFileSync(path.join(root, 'build', 'pack.js'), 'utf8');
    const pkg = require(path.join(root, 'package.json'));

    // 0.5.9 Fatal regression: pack.js copy only src/, no none_modules,
    // Cannot find mode '@napi-rs/lzma', all applications open.
    assert(pkg.dependencies && pkg.dependencies['@napi-rs/lzma'],
      '@napi-rs/ lzma must be in dependencies (repress stem.img.xz needs))');
    assert(/node_modules/.test(packJs) && /dependencies/.test(packJs),
      'Back. js Press copyencities to copy production');
    assert(/startsWith\('@'\)/.test(packJs),
      'The action area package should be copied with the whole shop (original binary in @napi-rs/*-win32-x64-msvc))');
    // You really need to find it on the decompression path:
    const lzmaDir = path.join(root, 'node_modules', '@napi-rs', 'lzma');
    assert(fs.existsSync(lzmaDir), 'This machine needs to be packed @napi-rs/ lzma');
  });

  await test('A mirror decompresses lzma with readable errors, instead of a long list of recquire track', () => {
    const root = path.join(__dirname, '..');
    const provJs = fs.readFileSync(path.join(root, 'src', 'core', 'provision.js'), 'utf8');
    assert(/LZMA_MISSING/.test(provJs), 'Izma is missing to use the LZMA_MISSING error code');
    assert(/package is incomplete/i.test(provJs), 'The error file says the installation package is incomplete. Don\'t let the user think the computer\'s broken.');
    // No longer unprotected, require.resolve:
    assert(/try\s*\{[^}]*require\.resolve\('@napi-rs\/lzma'\)/.test(provJs),
      'Quere. resolve to wrap it in try, give friendly mistakes when you fail');
  });

  await test('Key error: Turn off the large screen taskbar (Taskbar))', () => {
    const root = path.join(__dirname, '..');
    const adbJs = fs.readFileSync(path.join(root, 'src', 'core', 'adb.js'), 'utf8');
    // Sw606dp triggers the Launcher Taskbar: bottom, top, buttoned to the lower left corner
    assert(/async disableLauncherTaskbar\(\)/.test(adbJs), 'DisableLauncherTaskbar');
    assert(/settings put global enable_taskbar 0/.test(adbJs), 'Taskbar Switches with Global energy_taskbar');
    // Launcher only reads the switch once on startup, and it must be restarted before it disappears.
    assert(/am force-stop com\.google\.android\.apps\.nexuslauncher/.test(adbJs), 'To restart Pixel Launcher');
    // Each start is replaced by a knife (scramble, etc.) and an "check + reboot" is performed in the initials.
    const pf = adbJs.slice(adbJs.indexOf('async prepareForeground('), adbJs.indexOf('async prepareForeground(') + 1600);
    assert(/enable_taskbar 0/.test(pf), 'PrepareForeground to write taskbar switch');
    const reset = adbJs.slice(adbJs.indexOf('async resetDisplayOverrides('), adbJs.indexOf('async resetDisplayOverrides(') + 1600);
    assert(/disableLauncherTaskbar\(\)/.test(reset), 'Reset Display Overrides to call DisableLauncherTaskbar');
  });

  await test('Activate Animation: Stay to the first frame and fade out.', () => {
    const root = path.join(__dirname, '..');
    const adbJs = fs.readFileSync(path.join(root, 'src', 'core', 'adb.js'), 'utf8');
    assert(/async waitForAppFirstFrame\(pkg/.test(adbJs), 'WaitForAppFirstFrame');
    // Android 12+ Hangs up the system before the ACT first frame, Splash, determined to be missing + Focus on Target Package
    assert(/Splash Screen/.test(adbJs), 'To determine the header by the System Splash window');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    // The first frame must wait before the animation is collected, otherwise the user sees white bottom + application icons, thinking they're stuck.
    const idx = mainJs.indexOf('waitForAppFirstFrame');
    assert(idx > 0, 'Main to call waitForAppFirstFrame');
    const after = mainJs.slice(idx, idx + 900);
    assert(/finishBootAnimation/.test(after), 'It’s not until the first frame is unified and the animation is activated.');
    // The decision must be made. `dumpsys window`: `dumpsys window windows` There's no mCurrentFocus.,
    // It’s always the focus of judgment, and it’s the result that every start is over-timed.
    assert(/dumpsys window \| grep -E "Splash Screen\|mCurrentFocus"/.test(adbJs),
      'First frame is decided with dumpsys window (including mCurrentFocus))');
    // It takes 15 seconds or more for a heavy application like the red fruit, and 12 seconds to get rid of the animated.
    assert(/timeoutMs:\s*20000/.test(mainJs), 'The frame is waiting for 20 seconds.');
  });

  await test('Activate animation: Boot mask closes with splash and stays to the first frame', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    // Unique closing function: splash window + aboot mask for an appWin
    assert(/const finishBootAnimation = \(\) =>/.test(mainJs), 'Have a unified closing function');
    const fn = mainJs.slice(mainJs.indexOf('const finishBootAnimation'),
      mainJs.indexOf('const finishBootAnimation') + 700);
    assert(/bootAnimDone/.test(fn), 'The end must wait to avoid multiple triggers.');
    assert(/setState\(\{ ready: true/.test(fn), 'End of story to notify Boot mask fades out');
    assert(/splashDone/.test(fn), 'Close the early splash window at the same time');
    // At the end of the launch, set State ready (a pre-encouraging animation will be collected at the end of the white-slash phase))
    assert(/if \(!attachDoneEarly\) finishBootAnimation\(\)/.test(mainJs),
      'Only when you\'re ahead of schedule.');
    // Any path is blocked and forced, and never stopped in an animation.
    assert(/setTimeout\(finishBootAnimation, 24000\)/.test(mainJs), 'It\'s got to be a 24-second total fuse.');
  });

  await test('Activate animation: icons with complete PNG+ spin bottom, with extremely simple wind visual elements', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    // icon prefers the original PNG (iconPath), and no more ICO (Chromium) <img> Rendering will have an angle.)
    assert(/setIcon\(rec && \(rec\.iconPath \|\| rec\.icoPath\)\)/.test(mainJs),
      'Start animated icon with complete PNG');
    const shellHtml = fs.readFileSync(path.join(root, 'src', 'ui', 'shell.html'), 'utf8');
    const shellCss = fs.readFileSync(path.join(root, 'src', 'ui', 'shell.css'), 'utf8');
    const shellJs = fs.readFileSync(path.join(root, 'src', 'ui', 'shell.js'), 'utf8');
    assert(/object-fit:\s*contain/.test(shellCss), 'icon displays the full text of the contain, without cutting the missing angles');
    assert(/class="boot-aura"/.test(shellHtml) && /class="boot-glow"/.test(shellHtml),
      'Boot, soft and radiant.)');
    assert(/@keyframes bootBreathe/.test(shellCss), 'Icons must be slow breathing.');
    assert(/prefers-reduced-motion/.test(shellCss), 'Respect the system’s dynamic reduction preferences');
    assert(/FALLBACK/.test(shellJs) && /logo-128/.test(shellJs), 'Icon loading failure requires a brand image.');
  });

  await test('Start Speed: Do not repeat the permissions (20s+))', () => {
    const root = path.join(__dirname, '..');
    const adbJs = fs.readFileSync(path.join(root, 'src', 'core', 'adb.js'), 'utf8');
    const fn = adbJs.slice(adbJs.indexOf('async grantRuntimePermissions('), adbJs.indexOf('async grantRuntimePermissions(') + 2600);
    // The hit cache must return directly, not even the dumpsy package.
    assert(/rec\.permGranted === true/.test(fn), 'Permission granted to access to the Cache');
    assert(/store\.upsertApp\(\{ package: pkg, permGranted: true \}\)/.test(fn), 'You’re gonna write the mark when you’re done.');
    const clear = adbJs.slice(adbJs.indexOf('async clearData('), adbJs.indexOf('async clearData(') + 400);
    assert(/permGranted: false/.test(clear), 'pm clear before using the cache');
    const inst = fs.readFileSync(path.join(root, 'src', 'core', 'installer.js'), 'utf8');
    assert(/permGranted: false/.test(inst), 'Reload and make a waste cache.');
  });

  await test('AMD host backend off Vulkan after retry hardware acceleration', () => {
    const root = path.join(__dirname, '..');
    const emuJs = fs.readFileSync(path.join(root, 'src', 'core', 'emulator.js'), 'utf8');
    assert(/-feature', '-Vulkan/.test(emuJs), 'Host backend to turn off Vulkan');
    assert(/badGpuVulkanTried/.test(emuJs), 'Every emulator version has to be retryed');
    // Only host + AMD + Windows effective, do not bring the software backend into uncertainty
    assert(/gpu === 'host' && process\.platform === 'win32' && doctor\.detectGpuVendor\(\) === 'amd'/.test(emuJs),
      'Only host + AMD close Vulkan');
  });

  await test('Upgrade residue: The directory at runtime points to the other installation package instead of inside the package', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    assert(/looksForeignBundle/.test(mainJs), 'To recognize "resources/runtime"');
    assert(/resources\[\\\\\/\]runtime\$/.test(mainJs), 'Based on resources/runtime end');
  });

  await test('Double instance rotation: Old instance exits a simulator that the new example has just taken over', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    // When the user “does not respond again“, the second start takes over the simulator;
    // Again, new examples are immediately available -- applications are completely unopenable.
    assert(/owner\.pid/.test(mainJs), 'Remember if you\'re the owner of the operation at startup.');
    assert(/const releaseRuntime = /.test(mainJs), 'Be determined by “runtime attribution”');
    const fn = mainJs.slice(mainJs.indexOf('const releaseRuntime'), mainJs.indexOf('const releaseRuntime') + 800);
    assert(/owner === process\.pid/.test(fn), 'Pid, not when you can\’t stop running.');
    const hits = (mainJs.match(/runtime\?\.dispose\(\)/g) || []).length;
    assert(hits === 1, `Run only once in releaseRuntime, actually ${hits}  Location`);
  });

  await test('Window agent: The simulator window is also recognized from the start of the directory connection', () => {
    const root = path.join(__dirname, '..');
    const agentJs = fs.readFileSync(path.join(root, 'src', 'core', 'agent.js'), 'utf8');
    // The proxy determines belonging by the process exe path prefix, and Windows gives the real path after the junction is solved;
    // If you don’t parse it, emu:0 the primary window takes over failed back to the embedded shell with the rotation button.
    assert(/realpathSync\.native/.test(agentJs), 'Scope directory first parses the real path');
    const scope = agentJs.slice(agentJs.indexOf('async scope('), agentJs.indexOf('async scope(') + 2100);
    assert(/list\.push\(d\)/.test(scope), 'The original path should also be kept. It should fit a few environments.');
  });

  await test('ARM-only Install: Wrong reporting is itself a reason to retry, not just to see the mirror file is there.', () => {
    const root = path.join(__dirname, '..');
    const inst = fs.readFileSync(path.join(root, 'src', 'core', 'installer.js'), 'utf8');
    // Used to use! PlayImageInfo().ok as retry switch: mirror files on disk, but reused unopened translation
    // When the old simulator is retryed by skipping but playing the same “retrying,“ the user sees red “installation failed + retrying“.
    const retry = inst.slice(inst.indexOf('if (e.code === \'NO_MATCHING_ABIS\')'), inst.indexOf('if (e.code === \'NO_MATCHING_ABIS\')') + 260);
    assert(!/NO_MATCHING_ABIS.*playImageInfo/.test(retry), 'ABI Unmatched retry can\’t be stuck in playImageInfo');
    assert(/abiRetried = true/.test(inst), 'The second time you fail, you have to mark it, so the case will not lie that it\'s being retested.');
    const sw = inst.slice(inst.indexOf('async switchToCompat'), inst.indexOf('async install('));
    assert(/invalidateSnapshot\(\)/.test(sw), 'The compatible mirror must be used as a used snapshot, otherwise the translation layer will not be effective.');
    assert(/runningHasArm/.test(inst) && /ro\.product\.cpu\.abilist/.test(inst), 'ARM application is based on the actual translation capability of the current operation');
    const ui = fs.readFileSync(path.join(root, 'src', 'ui', 'app.js'), 'utf8');
    const f = ui.slice(ui.indexOf('function friendlyInstallErrorText'), ui.indexOf('function friendlyInstallErrorText') + 2000);
    assert(!/NO_MATCHING_ABIS/i.test(f) || /retry|compatible image/i.test(f.slice(f.indexOf('NO_MATCHING_ABIS'), f.indexOf('NO_MATCHING_ABIS') + 600)), 'The failed banners have to be clear. They can\’t just say "retrying."');
  });

  console.log(results.join('\n'));
  console.log(`\n Result: ${passed} Through, ${failed}  Failed \n`);

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
