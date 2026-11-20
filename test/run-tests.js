'use strict';
/**
 * Pure Node module test (not dependent on Electric/ adb/ network))
 * Run: npm test
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
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

console.log('\n[zip.js]');
const { ZipArchive } = require('../src/core/zip');
test('Capable of parsing the package structure of your project', () => {
  // Verify resolution with the smallest zip (stored mode) constructed in a memory
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(0, 8); // stored
  const name = Buffer.from('hello.txt');
  const data = Buffer.from('hello hydra');
  header.writeUInt16LE(name.length, 26);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 14);

  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(0, 8);
  cen.writeUInt16LE(name.length, 28);
  cen.writeUInt32LE(data.length, 24);
  cen.writeUInt32LE(data.length, 20);
  cen.writeUInt32LE(0, 42); // local offset

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + name.length, 12); // Total size of central directory
  eocd.writeUInt32LE(30 + name.length + data.length, 16); // Central Directory Offset

  const zip = new ZipArchive(Buffer.concat([header, name, data, cen, name, eocd]));
  assert(zip.has('hello.txt'), 'I think we should find it.');
  assert(zip.read('hello.txt').toString() === 'hello hydra', 'There should be consistency in content');
});

console.log('\n[png.js]');
const { encodePng, drawAppIcon } = require('../src/core/png');
test('PNG encoder output legal signature with IHDR', () => {
  const rgba = new Uint8Array(16 * 16 * 4).fill(128);
  const png = encodePng(16, 16, rgba);
  assert(png[0] === 0x89 && png[1] === 0x50, 'PNG Signature');
  assert(png.toString('ascii', 12, 16) === 'IHDR', 'IHDR chunk');
  assert(png.length > 50, 'Reasonable length');
});
test('Apply icons to draw at any size', () => {
  for (const s of [16, 32, 64, 256]) {
    const png = drawAppIcon(s);
    const w = png.readUInt32BE(16);
    assert(w === s, `The width should read ${s}, Actual ${w}`);
  }
});

console.log('\n[axml.js + arsc.js + apk.js]');
const { parseAxml } = require('../src/core/axml');
const { ResTable } = require('../src/core/arsc');
const { parseApk, quickCheck } = require('../src/core/apk');

// Test folder: Priority for environment variable HYDRA_TEST_APK specified,
// Otherwise try the usual APK position (read-only, not copied))
function findFixture() {
  const candidates = [
    process.env.HYDRA_TEST_APK,
    path.join(__dirname, 'fixtures', 'sample.apk'),
  ];
  try {
    const dl = path.join(process.env.USERPROFILE || '', 'Documents');
    for (const f of fs.readdirSync(dl)) {
      if (/\.apk$/i.test(f)) candidates.push(path.join(dl, f));
    }
  } catch (_) { /* ignore */ }
  return candidates.find((c) => c && fs.existsSync(c));
}

const fixture = findFixture();
if (fixture) {
  console.log(`  (Plugin: ${fixture})`);
  test('QuickCheck recognised PK head', () => {
    assert(quickCheck(fixture) === true);
  });
  const meta = parseApk(fixture);
  test('Parsing packagename / Version / Start Activity', () => {
    assert(/^[\w.]+$/.test(meta.package), `It’s an unusual name.: ${meta.package}`);
    assert(meta.versionName, 'Missing VersionName');
    assert(meta.launchActivity && /\./.test(meta.launchActivity),
      `Activity Unusual: ${meta.launchActivity}`);
  });
  test('Parsing Available Icons', () => {
    assert(meta.iconPng && meta.iconPng.length > 100, 'Icon is empty or too small');
    assert(meta.label, 'Application name is empty');
    console.log(`    ↳ ${meta.label} (${meta.package}) v${meta.versionName}`);
  });
  test('AXML Root is manyest', () => {
    const zip = new ZipArchive(fs.readFileSync(fixture));
    const root = parseAxml(zip.read('AndroidManifest.xml'));
    assert(root.name === 'manifest');
  });
  test('Resources.arsc parsable', () => {
    const zip = new ZipArchive(fs.readFileSync(fixture));
    if (zip.has('resources.arsc')) {
      const res = new ResTable(zip.read('resources.arsc'));
      assert(res.packages.length > 0, 'There should be at least one cardage');
    }
  });
} else {
  console.log('  (Skip: APK clamps not found, set up HYDRA_TEST_APK)');
}

// Constructor for synthetic APKs in test/lib/make-apk.js: Parsing is also covered when the real clamp is missing,
// And run-tests / auto-test shares the same (avoiding two separate byte syntheses).
const { buildApkBytes } = require('./lib/make-apk');

console.log('\n[Synthetic APK: axml + apk All Links]');
{
  const { attrValue, ANDROID_NS } = require('../src/core/axml');
  test('The namespace semantic for anatrValue: pass null = open, default only android', () => {
    const node = {
      attrs: [
        { ns: '', name: 'package', typed: 'com.a.b' },
        { ns: ANDROID_NS, name: 'label', typed: 'Test' },
      ],
    };
    // Unnamed space properties (e. g. cardage) must be passed round to get to; this is the key premise for parseApk
    assert(attrValue(node, 'package', null) === 'com.a.b', 'Package needs n=null');
    assert(attrValue(node, 'package') === null, 'Default recognition of android namespace only');
    assert(attrValue(node, 'label') === 'Test', 'android properties by default namespace');
    assert(attrValue(node, 'label', null) === 'Test', 'ns= null should find android properties');
  });
}
{
  const tmp = path.join(os.tmpdir(), `hydra-synth-${Date.now()}.apk`);
  fs.writeFileSync(tmp, buildApkBytes());
  try {
    const meta = parseApk(tmp);
    test('Package name: package on manifest is a non-namespace attribute', () => {
      assert(meta.package === 'com.example.test', `Actual ${meta.package}`);
    });
    test('Apply name / version / SDK', () => {
      assert(meta.label === 'TestApp', `label=${meta.label}`);
      assert(meta.versionName === '1.2.3', `versionName=${meta.versionName}`);
      assert(meta.versionCode === 7, `versionCode=${meta.versionCode}`);
      assert(meta.minSdk === 21 && meta.targetSdk === 34, `sdk=${meta.minSdk}/${meta.targetSdk}`);
    });
    test('Activity parsing from indent-filter', () => {
      assert(meta.launchActivity === 'com.example.test.Main', `activity=${meta.launchActivity}`);
    });
    test('ABI Directory and Icon Resource', () => {
      assert(JSON.stringify(meta.abis) === '["arm64-v8a"]', JSON.stringify(meta.abis));
      assert(meta.iconFile === 'res/mipmap-hdpi/ic_launcher.png', `icon=${meta.iconFile}`);
      assert(meta.iconPng && meta.iconPng[0] === 0x89 && meta.iconPng[1] === 0x50, 'Icon should be PNG');
      assert(meta.sizeBytes === fs.statSync(tmp).size, 'File size should be filled back');
    });
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (_) { /* ignore */ }
  }
}

{
  const { detectOrientation } = require('../src/core/apk');
  const { ANDROID_NS } = require('../src/core/axml');
  const act = (name, ori) => ({
    name: 'activity',
    attrs: [
      { ns: ANDROID_NS, name: 'name', typed: name },
      ...(ori == null ? [] : [{ ns: ANDROID_NS, name: 'screenOrientation', typed: ori }]),
    ],
  });
  test('Screen Orientation: Use the Activity Declaration to calculate the natural direction of the application', () => {
    // Red bean’s kind of "Dozens of portrait + One Sensor Launch Page" portrait
    const hongguo = [
      act('SplashActivity', 3), act('MainActivity', 1), act('ReaderActivity', 3),
      act('WebActivity', 1), act('DetailActivity', 1),
    ];
    assert(detectOrientation(hongguo, hongguo[0]) === 'portrait', 'Most of the statements are to be made to the screen.');
    // Ink readings of that kind of thing.
    const modu = [act('MainActivity', 2)];
    assert(detectOrientation(modu, modu[0]) === 'landscape', 'Single landscape campaign is to be set as a screen');
    // Full Sensor / Full unspecified & Unjudged, Leave it to Settings
    const sensorOnly = [act('A', 3), act('B', 11), act('C', 0), act('D', 14)];
    assert(detectOrientation(sensorOnly, sensorOnly[0]) === null, 'You follow gravity and you’re going back.');
    assert(detectOrientation([act('A', null)], null) === null, 'Return when no direction is stated');
    // Activity weight: it determines the first image the user sees.
    const launcherWins = [act('Launcher', 2), act('P1', 1), act('P2', 1), act('P3', 1)];
    assert(detectOrientation(launcherWins, launcherWins[0]) === 'landscape', 'Activity is weighted.');
    // ReversePortrait / userLandscape, and that's the right side.
    assert(detectOrientation([act('A', 7)], null) === 'portrait', 'reversPertrait belonging to the screen');
    assert(detectOrientation([act('A', 12)], null) === 'landscape', 'userLandscape belongs to the screen');
  });
}

console.log(`\n Result: ${passed} Through, ${failed}  Failed \n`);
process.exit(failed ? 1 : 0);
