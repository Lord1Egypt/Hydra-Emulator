'use strict';
/**
 * Pure Node test for the Android System Settings (src/ core/android.js): returns preset output with false adb record command,
 * No simulator required. Run: none test/android-test.js
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AndroidSettings, volumeCmd, parseVolume, volumePercent } = require('../src/core/android');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Accusations failed.');
}

/** Fake run: shell() returns output from replies in order and takes the received scripts */
function fakeSettings(replies) {
  const scripts = [];
  const client = {
    async shell(script) {
      scripts.push(script);
      return replies.length ? replies.shift() : '';
    },
  };
  const runtime = { async ensure() { return { ok: true, client }; } };
  return { set: new AndroidSettings(runtime), scripts };
}

(async () => {
  console.log('\n[volume.js]');

  await test('ParseVolume can read the queue and range', () => {
    const v = parseVolume('[V] will get volume\nvolume is 5 in range [0..15]\n');
    assert(v && v.index === 5 && v.min === 0 && v.max === 15, JSON.stringify(v));
    assert(parseVolume('media: inaccessible or not found') === null, 'Unrecognisable output should return null');
    assert(parseVolume('') === null && parseVolume(undefined) === null, 'Empty output should return null');
  });

  await test('% by strategist range', () => {
    assert(volumePercent({ index: 0, min: 0, max: 15 }) === 0);
    assert(volumePercent({ index: 15, min: 0, max: 15 }) === 100);
    assert(volumePercent({ index: 5, min: 0, max: 15 }) === 33);
    assert(volumePercent({ index: 3, min: 0, max: 0 }) === 0, 'The range 0 should not be divided by 0');
    assert(volumePercent(null) === 0);
  });

  await test('Volume command priority cmd media_session, back to old mirror', () => {
    const c = volumeCmd('--set 7');
    assert(c.indexOf('cmd media_session volume --stream 3 --set 7') >= 0, c);
    assert(c.indexOf('|| media volume --stream 3 --set 7') > c.indexOf('cmd media_session'), c);
    assert(!/^media volume/.test(c), 'The Android 11 removed media tool should not be used');
  });

  await test('SetVolume)', async () => {
    const { set, scripts } = fakeSettings(['volume is 4 in range [0..15]\n', '']);
    const r = await set.setVolume(60);
    assert(scripts.length === 2, `The range should be read before setting, actually ${scripts.length} Article`);
    assert(scripts[0].includes('cmd media_session volume --stream 3 --get'), scripts[0]);
    assert(scripts[1].includes('cmd media_session volume --stream 3 --set 9'), scripts[1]);
    assert(!scripts[1].includes('--set 60'), 'The percentage should not be directly in the slot.');
    assert(r.ok && r.volume === 60, JSON.stringify(r));
  });

  await test('SetVolume Conversions on Different Slotting Ranges (0.25))', async () => {
    const { set, scripts } = fakeSettings(['volume is 10 in range [0..25]\n', '']);
    const r = await set.setVolume(100);
    assert(scripts[1].includes('--set 25'), scripts[1]);
    assert(r.volume === 100, JSON.stringify(r));
  });

  await test('Convert to the usual 0.15 when you cannot read the range and clip it to 0-100.', async () => {
    const { set, scripts } = fakeSettings(['', '']);
    const r = await set.setVolume(250);
    assert(scripts[1].includes('--set 15'), scripts[1]);
    assert(r.volume === 100, JSON.stringify(r));
  });

  await test('status() Converts a slot to a percentage', async () => {
    const out = ['wifi=1', 'air=0', 'font=1.0', 'density=320', 'animw=1.0', 'sdk=34', 'vol=volume is 6 in range [0..15]'].join('\n');
    const { set, scripts } = fakeSettings([out]);
    const s = await set.status();
    assert(scripts[0].includes('cmd media_session volume --stream 3 --get'), 'State should read through media_session');
    assert(s.volume === 40, `For 40%, actual ${s.volume}`);
    assert(s.sdk === 34 && s.wifi === true, JSON.stringify(s));
  });

  // Real sh verification command retreat: only one false command in PATH `media`(Simulate no Cmd mirrors),
  // And a fake one. `cmd`(Simulate Android 11+.
  if (process.platform !== 'win32') {
    await test('Sh: Fall back to media when no cd is available, no more media when cd is available', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-vol-'));
      const log = path.join(dir, 'calls.log');
      const write = (name, body) => {
        fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
        fs.chmodSync(path.join(dir, name), 0o755);
      };
      write('media', 'echo "volume is 3 in range [0..15]"');
      const run = () => execFileSync('/bin/sh', ['-c', `${volumeCmd('--get')} 2>/dev/null`], {
        env: { PATH: dir },
        encoding: 'utf8',
      });
      assert(parseVolume(run()).index === 3, 'The old mirror should read to the volume via media');
      write('cmd', 'echo "volume is 8 in range [0..15]"');
      fs.writeFileSync(log, '');
      assert(parseVolume(run()).index === 8, 'If there is cmd, read the result of the media_session');
      assert(!fs.readFileSync(log, 'utf8').includes('media volume'), 'No more media when cmd is available');
    });
  }

  console.log(`\n Result: ${passed} Through, ${failed}  Failed \n`);
  process.exit(failed ? 1 : 0);
})();
