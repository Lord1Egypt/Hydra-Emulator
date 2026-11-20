'use strict';
/**
 * Pure Node test for resource allocation (RAM / CPU / Storage): Electron is not required, simulator is not required.
 *
 * The value of this layer is "no problem filling in": 32GB memory, 128GB partition,
 * You have to be collected to the extent that the host actually gets before saving, otherwise it’s a black screen/ half-loading failure.,
 * Users don't see what's wrong.
 *
 * Run: none test/resources-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  hostProfile, memoryLimits, clampMemoryMB, clampCores, memVerdict,
  diskRequiredMB, diskVerdict, diskLimits, clampDataGB, storageVerdict,
} = require('../src/core/resources');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const GB = 1024 * 1024 * 1024;

(() => {
  console.log('\n[:: Host capacity]');

  test('HostProfile Accept Injection Value (test environment does not touch the real machine))', () => {
    const h = hostProfile({ totalMB: 32768, cores: 16 });
    assert.equal(h.totalMB, 32768);
    assert.equal(h.cores, 16);
  });

  test('HostProfile does not return 0 n/ n without value', () => {
    const h = hostProfile({});
    assert.ok(h.cores >= 1);
    assert.ok(Number.isFinite(h.totalMB));
  });

  test('Memory ceiling for host 25%', () => {
    const lim = memoryLimits(32768);
    assert.equal(lim.maxMB, 24576, `32GB Host ' s maximum score 24GB, actual ${lim.maxMB}`);
    assert.equal(lim.stepMB, 512);
    assert.equal(lim.minMB, 1024);
  });

  test('A conservative ceiling when you cannot read the host\'s memory.', () => {
    const lim = memoryLimits(0);
    assert.ok(lim.maxMB >= 4096 && lim.maxMB <= 16384);
  });

  console.log('\n[:: Allocation of resources • Reconciling of memory]');

  test('0 means auto, returns 0 as it is', () => {
    const r = clampMemoryMB(0, 32768);
    assert.equal(r.mb, 0);
    assert.equal(r.reason, 'auto');
  });

  test('3GB press 512MB alignment to 3072', () => {
    const r = clampMemoryMB(3000, 32768);
    assert.equal(r.mb, 3072);
    assert.equal(r.capped, true);
  });

  test('Fill 64GB pressed to host ceiling and given reasons', () => {
    const r = clampMemoryMB(64 * 1024, 32768);
    assert.equal(r.mb, 24576);
    assert.equal(r.capped, true);
    assert.ok(/at most 24 GB/.test(r.reason), r.reason);
  });

  test('128MB loaded to minimum startable value', () => {
    const r = clampMemoryMB(128, 32768);
    assert.equal(r.mb, 1024);
    assert.equal(r.capped, true);
  });

  test('Small memory machine (4GB) will not give 4GB to Android.', () => {
    const r = clampMemoryMB(4096, 4096);
    assert.equal(r.mb, 3072);
  });

  console.log('\n[· CPU]');

  test('16 Nuclear machine maximum score 15 nuclear', () => {
    assert.equal(clampCores(16, 16).cores, 15);
  });

  test('The single-nuclear machine still gives one.', () => {
    assert.equal(clampCores(8, 1).cores, 1);
  });

  test('0 = Auto', () => {
    assert.equal(clampCores(0, 8).cores, 0);
  });

  console.log('\n[:: Instructions on the RAM ratio]');

  test('The splits are too full to hint Windows to change pages', () => {
    const v = memVerdict(28672, 32768);
    assert.equal(v.level, 'insufficient');
    assert.ok(/paging/.test(v.note), v.note);
  });

  test('Normal area does not disturb users', () => {
    assert.equal(memVerdict(8192, 32768).level, 'ok');
    assert.equal(memVerdict(8192, 32768).note, '');
  });

  test('Less than 768MB, no call.', () => {
    assert.equal(memVerdict(512, 32768).level, 'insufficient');
  });

  console.log('\n[Resource allocation • Storage]');

  test('50GB game based on 1.8 times + 2GB preset estimate', () => {
    const need = diskRequiredMB(50 * GB);
    assert.equal(need, Math.ceil(50 * 1024 * 1.8) + 2048);
  });

  test('Data partition cap 80% of the disk', () => {
    assert.equal(diskLimits(100 * 1024).maxGB, 80);
  });

  test('The disk is only 20 GB when it is available. 64 GB partition is not allowed.', () => {
    const r = clampDataGB(64, 20 * 1024);
    assert.equal(r.gb, 16);
    assert.equal(r.capped, true);
    assert.ok(/20\.0 GB left/.test(r.reason), r.reason);
  });

  test('64GB partition release when disk is full', () => {
    const r = clampDataGB(64, 200 * 1024);
    assert.equal(r.gb, 64);
    assert.equal(r.capped, false);
  });

  test('How much less is left when space is not enough', () => {
    const v = storageVerdict(30 * 1024, 50 * GB);
    assert.equal(v.ok, false);
    assert.ok(v.shortMB > 0);
    assert.ok(/short by 62/.test(v.note), v.note);
  });

  test('Skipping pretests instead of stopping death when you can\'t read the rest of the disk.', () => {
    assert.equal(storageVerdict(0, 50 * GB).ok, true);
  });

  console.log('\n[• Disk pre-screening]');

  test('DiskVerdict Release When Space is Sufficient', () => {
    const v = diskVerdict(200 * 1024, 100 * 1024);
    assert.equal(v.ok, true);
    assert.equal(v.message, '');
  });

  test('DiskVerdic how many trips are given when space is not enough (the disk that is running at the tip))', () => {
    const v = diskVerdict(10 * 1024, 60 * 1024);
    assert.equal(v.ok, false);
    assert.ok(/Not enough disk space/.test(v.message), v.message);
    assert.ok(/disk holding the Hydra Emulator runtime/.test(v.message), v.message);
  });

  test('DiskVerdic does not stop when you cannot read the remaining space.', () => {
    assert.equal(diskVerdict(0, 60 * 1024).ok, true);
  });

  test('The pre-screen space for 50GB level install packages is estimated at 1.8 times + 2GB', () => {
    const need = diskRequiredMB(50 * GB);
    assert.ok(need > 85 * 1024 && need < 95 * 1024, `Yes. ${need} MB`);
  });

  console.log('\n[• Wire check]');

  const builtinSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'backends', 'builtin.js'), 'utf8');
  test('And the base seat is also available.()', () => {
    assert(/resources\(\) \{/.test(builtinSrc), 'Buildtin missing resources()');
  });

  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  test('Master process captures transboundary values and exposes resource profiles', () => {
    assert(/sanitizeResourcePatch/.test(mainSrc), 'Cannot initialise Evolution’s mail component.');
    assert(/engine:resources/.test(mainSrc), 'Missing: resources IPC');
    assert(/runtime:resetAndResize/.test(mainSrc), 'Lack of replacement + re-established access to new capacity');
    assert(!/mumuMemoryGB|mumuCores/.test(mainSrc), 'The master process still leaves the memory-concentration logic of the third-party base.');
  });

  const emulatorSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'emulator.js'), 'utf8');
  test('Quickboot Disk Blocks local expansion with false mistakes and success', () => {
    assert(/_hasDataOverlay/.test(emulatorSrc), 'qCow2 Disk not detected');
    assert(/needsReset: true/.test(emulatorSrc), 'Extension failed to mark needsReset');
    assert(/fsGB/.test(emulatorSrc), 'DataInfo Unexposed File System Actual Size');
  });

  const doctorSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'doctor.js'), 'utf8');
  test('The memory/core ceiling in the automatic slot follows the host, and no more 8GB/8 is written.', () => {
    assert(/memoryLimits\(host\.totalMB\)/.test(doctorSrc), 'Doctor does not collect memory by host');
    assert(!/1536, 8192/.test(doctorSrc), 'Doc’s still writing down the 8192 cap');
  });

  console.log(`\n Result: ${passed} Through, ${failed}  Failed \n`);
  process.exit(failed ? 1 : 0);
})();
