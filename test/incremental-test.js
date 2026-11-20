'use strict';
/**
 * Increment update test: List check, mode selection, file-by-file Harshi check, apply script, continuation.
 * All offline, no access to GitHub/Gitee.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Updater } = require('../src/core/updater');
const inc = require('../src/core/incremental');
const { ZipFile } = require('../src/core/zip');

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
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Accusations failed.'); }
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const TMP = path.join(__dirname, 'out', 'incremental');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const sampleFiles = {
  'resources/app/package.json': { sha256: 'AAA', size: 3 },
  'resources/app/src/main.js': { sha256: 'BBB', size: 9 },
};

console.log('\n[• Inventory and model selection]');
test('ParseManifest Refuses the Disability List', () => {
  for (const bad of ['not json', '{}', JSON.stringify({ schema: 2 }), JSON.stringify({ schema: 1, version: '1' })]) {
    let threw = false;
    try { inc.parseManifest(bad); } catch (_) { threw = true; }
    assert(threw, `It should be rejected.: ${bad.slice(0, 30)}`);
  }
});

test('ParseManifest accepts the legal list', () => {
  const m = inc.parseManifest(JSON.stringify({
    schema: 1, version: '0.6.3', electronVersion: '33.4.11',
    app: { asset: 'Hydra Emulator-v0.6.3-app.zip', sha256: 'x', files: sampleFiles },
  }));
  assert(m.version === '0.6.3' && m.app.files['resources/app/package.json'], 'The parse results are wrong.');
});

test('Auxiliary assets (list / code package / whole package when running) cannot be considered as complete packages', () => {
  assert(inc.isAuxAsset('Hydra Emulator-v0.6.3-manifest.json'));
  assert(inc.isAuxAsset('Hydra Emulator-v0.6.3-app.zip'));
  assert(inc.isAuxAsset('Hydra Emulator-runtime-v0.6.3.zip'));
  assert(!inc.isAuxAsset('Hydra Emulator-v0.6.3-win64-portable.zip'));
});

test('Elementron version is inconsistent / install version * Back to the complete package', () => {
  const manifest = { app: { asset: 'a.zip', sha256: 'x', files: {} }, electronVersion: '33.4.11' };
  const assets = [{ name: 'a.zip' }];
  assert(inc.chooseMode({ flavor: 'portable', electronVersion: '33.4.11', manifest, assets }).mode === 'app');
  assert(inc.chooseMode({ flavor: 'portable', electronVersion: '22.0.0', manifest, assets }).mode === 'full');
  assert(inc.chooseMode({ flavor: 'setup', electronVersion: '33.4.11', manifest, assets }).mode === 'full');
  assert(inc.chooseMode({ flavor: 'portable', electronVersion: '33.4.11', manifest, assets: [] }).mode === 'full');
});

console.log('\n[Increment. Hashi\'s verification.]');
(async () => {
  const dir = path.join(TMP, 'hash');
  fs.mkdirSync(path.join(dir, 'resources', 'app', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'resources', 'app', 'package.json'), '{"version":"0.6.3"}');
  fs.writeFileSync(path.join(dir, 'resources', 'app', 'src', 'main.js'), 'console.log(1)');
  const files = {
    'resources/app/package.json': { sha256: sha(fs.readFileSync(path.join(dir, 'resources/app/package.json'))) },
    'resources/app/src/main.js': { sha256: sha(fs.readFileSync(path.join(dir, 'resources/app/src/main.js'))) },
    'resources/app/src/gone.js': { sha256: 'deadbeef' },
  };
  const hash = (f) => fs.existsSync(f) ? sha(fs.readFileSync(f)) : null;

  await atest('InspectLocal to find missing and changed', async () => {
    const r = await inc.inspectLocal({ installDir: dir, files, hash });
    assert(r.missing.length === 1 && r.missing[0] === 'resources/app/src/gone.js', `missing=${r.missing}`);
    assert(r.changed.length === 0, `changed=${r.changed}`);
    assert(!r.ok);
  });

  await atest('It\'s a vereffy Exchange. It\'s a fake.', async () => {
    const ok = { 'resources/app/package.json': files['resources/app/package.json'] };
    assert((await inc.verifyExtracted({ payload: dir, files: ok, hash })).length === 0);
    const bad = { 'resources/app/package.json': { sha256: '0'.repeat(64) } };
    assert((await inc.verifyExtracted({ payload: dir, files: bad, hash })).length === 1);
  });

  console.log('\n[.check the exposure incremental entrance.]');
  await atest('Check() recognizes the list and the code package, and the whole package is still in place.', async () => {
    const exe = path.join(TMP, 'check', 'Hydra Emulator.exe');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, 'x');
    const u = new Updater({ currentVersion: '0.6.2', exePath: exe, isPackaged: true, dataDir: path.join(TMP, 'check-data'), electronVersion: '33.4.11' });
    u.sources.latest = async () => ({
      version: '0.6.3', tag: 'v0.6.3', notes: '', htmlUrl: '', publishedAt: '',
      assets: [
        { name: 'Hydra Emulator-v0.6.3-manifest.json', size: 1, url: 'https://x/m', urls: ['https://x/m'], sizes: {} },
        { name: 'Hydra Emulator-v0.6.3-app.zip', size: 2, url: 'https://x/a', urls: ['https://x/a'], sizes: {} },
        { name: 'Hydra Emulator-v0.6.3-win64-portable.zip', size: 3, url: 'https://x/f', urls: ['https://x/f'], sizes: {} },
      ],
      sources: [], unreachable: [],
    });
    const info = await u.check();
    assert(info.incremental && info.incremental.manifest.name.endsWith('manifest.json'), 'I don\'t recognize the list.');
    assert(info.incremental.app.name.endsWith('app.zip'), 'I didn\'t recognize the package.');
    assert(info.asset && info.asset.name.endsWith('portable.zip'), 'I lost my whole bag.');
    assert(info.hasUpdate);
  });

  console.log('\n[..apply scripts and continuations]');
  test('App Mode Script only replaces resources/app, failed to roll back and double path restart', () => {
    const dataDir = path.join(TMP, 'apply');
    const exe = path.join(dataDir, 'Hydra Emulator.exe');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(exe, 'old');
    const u = new Updater({ currentVersion: '0.6.2', exePath: exe, isPackaged: true, dataDir });
    const payload = path.join(dataDir, 'update', '0.6.3', 'app-payload');
    fs.mkdirSync(path.join(payload, 'resources', 'app'), { recursive: true });
    fs.writeFileSync(path.join(payload, 'resources', 'app', 'package.json'), '{"version":"0.6.3"}');
    const script = u.apply({ mode: 'app', payload, version: '0.6.3' }, { spawn: false });
    assert(/Join-Path \$appDst 'package\.json'/.test(script) || /'package\.json'/.test(script), 'No check.');
    assert(/Move-Item -LiteralPath \$appDst -Destination \$backup/.test(script), 'No backup, app, directory.');
    assert(/app copy FAILED - rollback and keep payload/.test(script), 'Failed to roll back/maintain load');
    assert(/Start-Process -FilePath/.test(script) && /cmd\.exe/.test(script), 'The reboot has no bottom.');
    assert(!/Join-Path \$src '\*'\) -Destination \$dst -Recurse/.test(script), 'The shell should not be covered by an entire directory');
  });

  test('Increment application failed mark to force complete package, script to write mark and no more bad loads', () => {
    const dataDir = path.join(TMP, 'forcefull');
    const exe = path.join(dataDir, 'Hydra Emulator.exe');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, 'x');
    const u = new Updater({ currentVersion: '0.6.2', exePath: exe, isPackaged: true, dataDir });
    const payload = path.join(dataDir, 'update', '0.6.3', 'app-payload');
    fs.mkdirSync(path.join(payload, 'resources', 'app'), { recursive: true });
    fs.writeFileSync(path.join(payload, 'resources', 'app', 'package.json'), '{}');
    u._markPayloadReady(payload, '0.6.3', 'app');
    assert(u.findResumableJob().mode === 'app', 'Can not open message');
    fs.writeFileSync(path.join(dataDir, 'update', '0.6.3', '.hydra-force-full'), '');
    assert(u.findResumableJob() === null, 'You can’t add after the tag.');
    const script = u.apply({ mode: 'app', payload, version: '0.6.3' }, { spawn: false });
    assert(/\.hydra-force-full/.test(script), 'Apply failed branch to write mandatory complete package tags');
  });

  test('incremental load can be recovered by findResumableJob and the full load is still compatible', () => {
    const dataDir = path.join(TMP, 'resume');
    const exe = path.join(dataDir, 'Hydra Emulator.exe');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, 'x');
    const u = new Updater({ currentVersion: '0.6.2', exePath: exe, isPackaged: true, dataDir });
    const appPayload = path.join(dataDir, 'update', '0.6.3', 'app-payload');
    fs.mkdirSync(path.join(appPayload, 'resources', 'app'), { recursive: true });
    fs.writeFileSync(path.join(appPayload, 'resources', 'app', 'package.json'), '{}');
    u._markPayloadReady(appPayload, '0.6.3', 'app');
    const job = u.findResumableJob();
    assert(job && job.mode === 'app' && job.version === '0.6.3', `Should get back to the app, actually. ${JSON.stringify(job)}`);

    const zipPayload = path.join(dataDir, 'update', '0.6.4', 'payload');
    fs.mkdirSync(zipPayload, { recursive: true });
    fs.writeFileSync(path.join(zipPayload, 'Hydra Emulator.exe'), 'new');
    u._markPayloadReady(zipPayload, '0.6.4', 'zip');
    // 0.6.4 In front of 0.6.3
    const job2 = u.findResumableJob();
    assert(job2 && job2.mode === 'zip' && job2.version === '0.6.4', 'Full load continues as returns');
  });

  console.log('\n[• Build product]');
  test('Build/incorporate.js Generate legal lists and code packages', async () => {
    const fixture = path.join(TMP, 'portable');
    fs.mkdirSync(path.join(fixture, 'resources', 'app', 'src'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'Hydra Emulator.exe'), 'shell-bytes-not-in-app-pack');
    fs.writeFileSync(path.join(fixture, 'resources', 'app', 'package.json'), '{"version":"0.6.3","name":"hydra"}');
    fs.writeFileSync(path.join(fixture, 'resources', 'app', 'src', 'main.js'), 'console.log("incremental")');
    const out = path.join(TMP, 'assets');
    const { build } = require('../build/incremental');
    const r = await build(fixture, 'v0.6.3', out);
    assert(fs.existsSync(r.manifestPath) && fs.existsSync(r.appZip), 'No two assets were generated');
    const m = inc.parseManifest(fs.readFileSync(r.manifestPath, 'utf8'));
    assert(m.version === '0.6.3' && m.electronVersion, 'List Version / Elementron Version Wrong');
    assert(m.app.files['resources/app/src/main.js'], 'List not listed App File');
    assert(!m.app.files['Hydra Emulator.exe'], 'The shell cannot enter the increment list.');
    const zf = new ZipFile(r.appZip);
    const names = zf.names();
    assert(names.some((n) => /resources\/app\/package\.json/.test(n)), `The code package is missing.: ${names}`);
    assert(!names.some((n) => /Hydra Emulator\.exe/.test(n)), 'The package shouldn\'t contain the shell, exe.');
    zf.close();
  });

  console.log(`\n Increment Update Test: ${passed} Through, ${failed}  Failed \n`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('Test crash: ', e);
  process.exit(1);
});
