'use strict';
/**
 * Enable / install certified pure Node test (no real emulator, no network).
 *
 * Covers 0.5.3 Two root causes of real failure repair:
 *  1) Snapshots taken when the USB debug dialogue box is not confirmed →Divece unauthorized →
 *     Detection, 240sx4 and misdiagnostic card problems.,
 *     It’s only when you’re healthy.
 *  2) PackageManager installed=true, but /data/app files have been lost in snapshot/data inconsistencies →
 *     am start failed. Fix: is Installed checking the APK files for real.
 *
 * Run: none test/boot-auth-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  AdbClient, parseDeviceState, isUnauthorizedError, parsePmPaths,
} = require('../src/core/adb');

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

const adbDevices = (line) => `List of devices attached\n${line}\n`;

(async () => {
  console.log('\n[Adb Device Status Parsing]');
  test('Unauthorized must be able to distinguish (get-state confused))', () => {
    assert.equal(parseDeviceState(adbDevices('emulator-5554\tunauthorized'), 'emulator-5554'), 'unauthorized');
    assert.equal(parseDeviceState(adbDevices('emulator-5554\tdevice'), 'emulator-5554'), 'device');
  });
  test('Offline / no performances / no device must be given in return', () => {
    assert.equal(parseDeviceState(adbDevices('emulator-5554\toffline'), 'emulator-5554'), 'offline');
    assert.equal(parseDeviceState(adbDevices('emulator-5554\tno permissions'), 'emulator-5554'), 'unauthorized');
    assert.equal(parseDeviceState(adbDevices(''), 'emulator-5554'), 'no-device');
  });
  test('Only the Seral line is recognized, not interfered with by another device', () => {
    const out = adbDevices('emulator-5556\tdevice\nemulator-5554\tunauthorized');
    assert.equal(parseDeviceState(out, 'emulator-5554'), 'unauthorized');
  });
  test('Wrong text hit unauthorized (including official ADB_VENDOR_KEYS hint))', () => {
    assert.equal(isUnauthorizedError('error: device unauthorized.'), true);
    assert.equal(isUnauthorizedError("This adb server's $ADB_VENDOR_KEYS is not set. error: device unauthorized"), true);
    assert.equal(isUnauthorizedError('error: device offline'), false);
    assert.equal(isUnauthorizedError('error: no devices/emulators found'), false);
  });

  console.log('\n[pm path parsing + document authenticity verification]');
  test('pm path multi-specule (split APK) to decompose all', () => {
    const out = 'package:/data/app/~~x/com.foo-1/base.apk\npackage:/data/app/~~x/com.foo-1/split_arm64.apk\n';
    assert.deepEqual(parsePmPaths(out), [
      '/data/app/~~x/com.foo-1/base.apk',
      '/data/app/~~x/com.foo-1/split_arm64.apk',
    ]);
  });
  test('pm path empty output = not installed', () => {
    assert.deepEqual(parsePmPaths(''), []);
    assert.deepEqual(parsePmPaths('Error: package not found'), []);
  });

  await atest('PM says that the APK file is loaded returns file', async () => {
    const c = Object.create(AdbClient.prototype);
    c.shell = async (cmd) => {
      if (cmd.startsWith('pm path')) return 'package:/data/app/~~x/com.foo-1/base.apk';
      // Document validation command: File lost, no PRESENT echo
      return '';
    };
    assert.equal(await c.isInstalled('com.foo'), false);
  });
  await atest('APK file is installed returns true', async () => {
    const c = Object.create(AdbClient.prototype);
    c.shell = async (cmd) => {
      if (cmd.startsWith('pm path')) return 'package:/data/app/~~x/com.foo-1/base.apk';
      return '__HYDRA_PRESENT__';
    };
    assert.equal(await c.isInstalled('com.foo'), true);
  });
  await atest('One of the pieces was lost.)', async () => {
    const c = Object.create(AdbClient.prototype);
    const seen = [];
    c.shell = async (cmd) => {
      if (cmd.startsWith('pm path')) {
        return 'package:/data/app/~~x/com.foo/base.apk\npackage:/data/app/~~x/com.foo/split.apk';
      }
      seen.push(cmd);
      return ''; // Both failed.
    };
    assert.equal(await c.isInstalled('com.foo'), false);
    assert.ok(seen.some((s) => s.includes('/data/app/~~x/com.foo/split.apk')), 'Verify command to overwrite each fragment');
  });

  console.log('\n[The flashlights keep the guards.]');
  await atest('No snapshots.', async () => {
    const emu = Object.create(require('../src/core/emulator').EmulatorEngine.prototype);
    emu.port = 5554; // I'm sorry, I'm sorry.${port}
    emu._log = [];   // log() will push
    emu._adbGuestHealthy = async () => false;
    const ok = await emu._saveViaAdb('adb');
    assert.equal(ok, false, 'Unable to save in unhealthy condition');
  });
  await atest('Source level: The snapshot saving path must be preceded by a healthy guard.', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'emulator.js'), 'utf8');
    const fn = src.slice(src.indexOf('async _saveViaAdb('), src.indexOf('async _saveViaAdb(') + 700);
    assert.ok(/_adbGuestHealthy/.test(fn), '_saveViaAdb must first decide health');
    const stopFn = src.slice(src.indexOf('async stop('), src.indexOf('async stop(') + 3500);
    assert.ok(/_adbGuestHealthy/.test(stopFn), 'Stop() to judge health before shutting down');
    assert.ok(/invalidateSnapshot\(\)/.test(stopFn), 'Immortality shut-down.');
  });
  await atest('Source level: Start detection to recognize unauthorized and cold start self-repair', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'engine.js'), 'utf8');
    const boot = src.slice(src.indexOf('async bootEmulator('), src.indexOf('async bootEmulator(') + 6500);
    assert.ok(/isUnauthorizedError/.test(boot), 'The detection is identified by misreporting text.');
    assert.ok(/deviceState\(\)/.test(boot), 'Detection is confirmed twice by devices state');
    assert.ok(/invalidateSnapshot\(\)/.test(boot), 'We\'re stuck with a hit. We\'re gonna need a good snapshot.');
    assert.ok(/_coldBoot = true/.test(boot), 'Force cold start to re-inject adb public key');
    assert.ok(/ADB_UNAUTHORIZED/.test(boot), 'To make a precise diagnosis, no more misdirection to the card problem.');
  });
  await atest('Add server to ADB_VENDOR_KEYS to align the host/ guest key', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'adb.js'), 'utf8');
    assert.ok(/ADB_VENDOR_KEYS/.test(src), 'A public key directory must be clearly specified');
  });

  console.log(`\n Result: ${passed} Through, ${failed}  Failed \n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('  Unusual.: ', e.stack || e.message);
  process.exit(1);
});
