'use strict';
/**
 * Pure Node test for enhanced feedback (no simulator/network/registration form required).
 *
 * Overwrite 5 items implemented from GitHub issues:
 *  - #2 P0-1: APK package name not verified Any Path Writing / adb command injection
 *  - #2 P0-4: Protection/updater uncompressed zip-slip
 *  - #2 P1-1: _fetchText After Limit
 *  - #51: Installation one key unmounting was misconstrued as a portable version (unmounter named two different places))
 *  - #98: Do not reboot portable updates after downloading → Death loop (copy check false positive + load deleted))
 *
 * Run: nonee test/issue-hardening-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const { validPackageName, safeFilePart } = require('../src/core/pkgname');
const { resolveZipEntry } = require('../src/core/zip');
const store = require('../src/core/store');
const { findUninstaller, Updater } = require('../src/core/updater');
const { Provisioner } = require('../src/core/provision');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-hardening-'));

(async () => {
  console.log('\n[Assue #2 P0-1 : Package name check]');
  test('The legal Android bag passes.', () => {
    for (const p of ['com.github.tvbox.osc', 'com.tencent.mm', 'org.example.app_2']) {
      assert.equal(validPackageName(p), true, `${p} Legally`);
    }
  });
  test('Path Pass / Disk / shell character / Space all rejected', () => {
    for (const p of ['../evil', 'com..x', '.com.x', 'com/x', 'com\\x', 'C:evil', 'a;rm -rf', 'a|b',
      'a b', 'a$(id)', 'a`id`', '', 'com.x.', '1com.x', 'com.x-y']) {
      assert.equal(validPackageName(p), false, `${JSON.stringify(p)} It should be rejected.`);
    }
  });
  test('The name of the illegal package has been changed to a secure document name.', () => {
    const safe = safeFilePart('../evil');
    assert.ok(!safe.includes('/') && !safe.includes('\\') && !safe.includes('..'), `Rewrite must have no path character: ${safe}`);
    assert.equal(safeFilePart('com.ok.pkg'), 'com.ok.pkg');
  });
  test('The icon/ APK path for store could not escape the data directory', () => {
    const icon = store.iconPath('../../Windows/System32/drivers/etc/hosts');
    const apk = store.apkPath('../../evil', '../../x');
    assert.ok(!icon.includes('..'), `Icon path should not contain ..: ${icon}`);
    assert.ok(!apk.includes('..'), `APK path should not contain ..: ${apk}`);
    assert.match(path.basename(apk), /\.apk$/);
  });

  console.log('\n[issue #2 P0-4 · zip-slip]');
  test('Normal relative path release', () => {
    const root = path.join(TMP, 'zip-ok');
    assert.equal(resolveZipEntry(root, 'emulator/qemu.exe'), path.join(root, 'emulator', 'qemu.exe'));
    assert.equal(resolveZipEntry(root, 'a/b/c.txt'), path.join(root, 'a', 'b', 'c.txt'));
  });
  test('../ / Absolute path / plate/ reverse slash over / UNC all rejected', () => {
    const root = path.join(TMP, 'zip-root');
    for (const n of ['../evil', 'a/../../evil', '/etc/passwd', 'C:\\Windows\\x', 'C:/Windows/x',
      'a\\..\\..\\evil', '\\\\server\\share\\x', 'a/../b']) {
      assert.equal(resolveZipEntry(root, n), null, `${JSON.stringify(n)} It should be rejected.`);
    }
  });
  test('The program connects to the updater source of zip-slip guards.', () => {
    const prov = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'provision.js'), 'utf8');
    const upd = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'updater.js'), 'utf8');
    assert.ok(/resolveZipEntry\(/.test(prov), 'Project. extractZip must verify the entry name');
    assert.ok(/resolveZipEntry\(/.test(upd), 'The name of the entry must be verified.');
  });

  console.log('\n[Asue #2 P1-1 _fetchText Not Hanged]');
  await atest('Promise can settle when the upper limit is exceeded and never settle', async () => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Length': String(64 * 1024) });
      res.end(Buffer.alloc(64 * 1024, 0x61));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/index.xml`;
    try {
      const p = new Provisioner({});
      const out = await Promise.race([
        p._fetchText(url, 1024),
        new Promise((_, rej) => setTimeout(() => rej(new Error('_fetchText Card Dead Pending')), 5000)),
      ]);
      assert.equal(out, '', 'The limit must be dropped. It must not be half complete.');
    } finally {
      srv.close();
    }
  });
  test('_fetchText source contains a single setle doorlock and hard timeout', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'provision.js'), 'utf8');
    assert.ok(/let done = false/.test(src) && /const finish = \(\) =>/.test(src), 'There has to be a one-time settlement of the hatch.');
    assert.ok(/setTimeout/.test(src), 'It has to be a hard time.');
  });

  console.log('\n[Que #51 . Unloader recognition]');
  test('Uninstall X.exe can be identified as an installation version for eclecron-Builder', () => {
    const dir = path.join(TMP, 'uninst-a');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Uninstall Hydra Emulator.exe'), 'x');
    assert.equal(findUninstaller(dir), 'Uninstall Hydra Emulator.exe');
  });
  test('Same old-fashioned uninstaller.exe.', () => {
    const dir = path.join(TMP, 'uninst-b');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'uninstaller.exe'), 'x');
    assert.equal(findUninstaller(dir), 'uninstaller.exe');
  });
  test('Portable (no unmounter) returns null', () => {
    const dir = path.join(TMP, 'uninst-c');
    fs.mkdirSync(dir, { recursive: true });
    assert.equal(findUninstaller(dir), null);
  });

  console.log('\n[Que #98 Update not to restart the cycle of death]');
  await atest('Ready loads can be retrieved back to work, version does not match/exe is not available', async () => {
    const dataDir = path.join(TMP, 'upd-resume');
    const exe = path.join(dataDir, 'Hydra Emulator.exe');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(exe, 'x');
    const u = new Updater({ currentVersion: '0.5.3', exePath: exe, isPackaged: true, dataDir });

    const payload = path.join(dataDir, 'update', '0.5.4', 'payload');
    fs.mkdirSync(payload, { recursive: true });
    fs.writeFileSync(path.join(payload, 'Hydra Emulator.exe'), 'new');
    assert.equal(u.findResumableJob(), null, 'No ready tags should not be reused');
    u._markPayloadReady(payload, '0.5.4');
    const job = u.findResumableJob();
    assert.ok(job && job.version === '0.5.4', 'We should get back 0.5.4.');

    // Version is older than the current version no reuse
    const cur = new Updater({ currentVersion: '0.5.4', exePath: exe, isPackaged: true, dataDir });
    assert.equal(cur.findResumableJob(), null, 'No less than the current version of the load cannot be renewed');
    // Marked version does not match
    fs.writeFileSync(u._readyFile(payload), JSON.stringify({ version: '0.5.2' }));
    assert.equal(u.findResumableJob(), null, 'Tag version does not match cannot be reused');
  });
  test('Apply Script successfully replaced with byte check, with failed load, double-track restart', () => {
    const dataDir = path.join(TMP, 'upd-apply');
    const exe = path.join(dataDir, 'Hydra Emulator.exe');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(exe, 'old');
    const u = new Updater({ currentVersion: '0.5.3', exePath: exe, isPackaged: true, dataDir });
    const payload = path.join(dataDir, 'update', '0.5.4', 'payload');
    fs.mkdirSync(payload, { recursive: true });
    fs.writeFileSync(path.join(payload, 'Hydra Emulator.exe'), 'new-version-bytes');
    const script = u.apply({ mode: 'zip', payload, version: '0.5.4' }, { spawn: false });
    assert.ok(/\(Get-Item \$target\)\.Length -eq \$expected/.test(script), 'New exe must be verified by by bytes');
    assert.ok(/keeping payload for next launch/.test(script), 'Copying failure must keep load for renewal');
    assert.ok(/Start-Process -FilePath/.test(script) && /cmd\.exe/.test(script), 'The reboot must have a bottom path.');
  });

  console.log(`\n Result: ${passed} Through, ${failed}  Failed \n`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('  Unusual.: ', e.stack || e.message);
  process.exit(1);
});
