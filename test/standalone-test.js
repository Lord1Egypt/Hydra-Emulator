'use strict';
/**
 * Independently run relevant pure Node test: No need for Electric, no need for simulators, no need for networking.
 *
 * It’s a product line (0.5.6) upgraded to hard constraints.):
 *   **Hydra Emulator runs on any machine, any setting, any residual configuration only when running on his own.**
 *
 * Three specific things to watch.:
 *   1. There is no third-party base (Mumu/ Thunder/ Blue Collapse/ WSA/ FydeOS) realization file in the code;
 *   Even if it says “mode=mumu /fydeos /atach,“ only buytin;
 *   3. No binary or catalog of any third-party simulators is allowed to appear in the package.
 *
 * Run: none test/standalone-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { findBundled, findForbiddenSource, assertStandalone } = require('../build/guard-standalone');
const backends = require('../src/core/backends');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const exists = (...p) => fs.existsSync(path.join(ROOT, ...p));

function tmpDir(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `hydra-${name}-`));
  return d;
}
function touch(dir, rel, bytes = 8) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes));
  return p;
}

(() => {
  console.log('\n[Run independently. Only one base.]');

  const store = require('../src/core/store');
  const settings = store.getSettings();

  test('The default engine is running on its own.', () => {
    assert.equal(settings.engine.mode, 'builtin', `Default mode=${settings.engine.mode}`);
  });

  test('There\'s only bultin on the registration form, no second base.', () => {
    assert.equal(backends.REGISTRY.length, 1, `The registration form is... ${backends.REGISTRY.length} A base seat.`);
    assert.deepEqual(backends.describe().map((d) => d.id), ['builtin']);
  });

  test('Any leftover mode will only create bultin (mumu / fydeos / atach / randomly filled))', () => {
    for (const mode of ['mumu', 'fydeos', 'attach', 'ldplayer', 'whatever', '']) {
      const made = backends.create({
        appRoot: ROOT, settings: { engine: { mode } }, store, log: () => {},
      });
      assert.equal(made.id, 'builtin', `mode=${mode} But it was created. ${made.id}`);
      assert.equal(made.backend.constructor.id, 'builtin', 'Example type is not BuiltinBackend');
    }
  });

  test('id is not going to pass.)', () => {
    const made = backends.create({
      appRoot: ROOT, settings: { engine: { mode: 'builtin' } }, store, log: () => {}, id: 'mumu',
    });
    assert.equal(made.id, 'builtin', 'id=mumu is still accepted');
  });

  test('Automatically select when no external operation is detected', async () => {
    // Synchronize assertion: autoPick must be "directly returned to buildin" and no probes in the source code()
    const src = read('src', 'core', 'backends', 'index.js');
    assert(!/\.probe\(/.test(src), 'Registration forms are still detecting external simulators.');
    assert(!/mumu|fydeos|ldplayer|bluestacks/i.test(src.replace(/[\s\S]*?const REGISTRY[\s\S]*?\];/, '')),
      'There\'s a third party base on the registration form.');
  });

  console.log('\n[Run independently. Third-party base code deleted.]');

  test('Backs/ Only base / buildtin / index', () => {
    const files = fs.readdirSync(path.join(ROOT, 'src', 'core', 'backends')).sort();
    assert.deepEqual(files, ['base.js', 'builtin.js', 'index.js'], `Actual: ${files.join(', ')}`);
  });

  test('Momu / fydeos / mumu-compat / frame is missing', () => {
    for (const rel of [
      ['src', 'core', 'backends', 'mumu.js'],
      ['src', 'core', 'backends', 'fydeos.js'],
      ['src', 'core', 'mumu-compat.js'],
      ['src', 'core', 'frame.js'],
    ]) {
      assert.equal(exists(...rel), false, `${rel.join('/')} It still exists.`);
    }
  });

  test('There\'s no branch in the engine like, "Third Party Base is not available."', () => {
    const src = read('src', 'core', 'engine.js');
    assert(!/_fallbackFrom/.test(src), 'And he’s got a third-party backmark.');
    assert(!/backend\.id !== 'builtin'/.test(src), 'And the logic of basing the id fork.');
    assert(!/engine\.mode === 'attach'/.test(src), 'And the branch atatach.');
    assert(!/ATTACH_ENDPOINTS/.test(src), 'Also detecting adb ports of external emulators');
  });

  test('Setup page with no engine mode to pull down and no Mumu/ FydeOS fields', () => {
    const html = read('src', 'ui', 'index.html');
    assert(!/setEngineMode/.test(html), 'There’s still engine mode down on the setup page');
    assert(!/value="mumu"|value="fydeos"|value="attach"/.test(html), 'Third-party options remain on the settings page');
    assert(!/setMumuPath|setMumuMemGB|setMumuCores|setFydeosHost/.test(html), 'There are still third-party fields on the settings page');
    assert(/id="setEngineLabel"/.test(html), 'Setup page missing read-only runtime description');
  });

  test('Rewrite leftover fields of the Persistence Layer', () => {
    const src = read('src', 'core', 'store.js');
    assert(/s\.engine\.mode = 'builtin'/.test(src), 'GetSettings no mandatory mode=bultin');
    assert(/mumuPath/.test(src) && /delete s\.engine\[k\]/.test(src), 'No third-party fields cleared of residuals');
  });

  test('adb candidate path does not contain a third-party simulator \'s own adb', () => {
    const src = read('src', 'core', 'adb.js');
    const block = src.slice(src.indexOf('const COMMON_ADB_PATHS'), src.indexOf('];', src.indexOf('const COMMON_ADB_PATHS')));
    assert(!/mumu|ldplayer|bluestacks|hd-adb/i.test(block), 'Still borrowing third-party emulator adb');
  });

  console.log('\n[Run independently. No other simulators in the bag.]');

  test('Guards recognize Mumu binary.', () => {
    const d = tmpDir('guard-hit');
    touch(d, 'runtime/MuMuManager.exe');
    const hits = findBundled(d);
    assert.equal(hits.length, 1, `Hits ${hits.length}`);
    assert.equal(hits[0].vendor, 'Mumu emulator');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('Guards recognize Mumu\'s directory (nx_main/ nx_device/ nemu))', () => {
    for (const dirName of ['nx_main', 'nx_device', 'nemu']) {
      const d = tmpDir('guard-dir');
      fs.mkdirSync(path.join(d, dirName), { recursive: true });
      touch(d, path.join(dirName, 'whatever.bin'));
      assert.equal(findBundled(d).length, 1, `${dirName} I didn't get stopped.`);
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  test('The guards also recognize lightning / blue stacks', () => {
    const d = tmpDir('guard-others');
    touch(d, 'runtime/LDPlayer.exe');
    touch(d, 'runtime/Bluestacks.exe');
    const vendors = new Set(findBundled(d).map((h) => h.vendor));
    assert.ok(vendors.has('Thunder Simulator'), 'The thunder\'s not stopped.');
    assert.ok(vendors.has('Blue Collapse Simulator'), 'The blue stack was not stopped.');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('The guards won\'t hurt our own operations.', () => {
    const d = tmpDir('guard-src');
    touch(d, 'app/src/core/backends/builtin.js', 64);
    touch(d, 'app/src/core/resources.js', 64);
    assert.equal(findBundled(d).length, 0, 'They\'re using their own source code as a simulator.');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('The guards will stop the third-party base from coming back with the apparition code.)', () => {
    const d = tmpDir('guard-adapter');
    touch(d, 'app/src/core/backends/mumu.js', 64);
    touch(d, 'app/src/core/backends/fydeos.js', 64);
    touch(d, 'app/src/core/mumu-compat.js', 64);
    const hits = findForbiddenSource(d);
    assert.equal(hits.length, 3, `Hits ${hits.length}(For 3)`);
    const r = assertStandalone(d, { label: 'Test', exit: false });
    assert.equal(r.ok, false, 'The adaptor code didn\'t fail the guard.');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('The guards don\'t think of the normal frame.js/ business js as the base of a third party.', () => {
    const d = tmpDir('guard-other-js');
    touch(d, 'app/src/render/frame.js', 64);
    touch(d, 'app/src/core/backends/builtin.js', 64);
    assert.equal(findForbiddenSource(d).length, 0, 'outside of core should not be misjudged.js/ buildin.js');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('A clean runtime directory is correct.', () => {
    const d = tmpDir('guard-clean');
    touch(d, 'runtime/emulator/emulator.exe', 64);
    touch(d, 'runtime/platform-tools/adb.exe', 64);
    const r = assertStandalone(d, { label: 'Test', exit: false });
    assert.equal(r.ok, true, JSON.stringify(r.hits));
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('If the directory doesn’t exist, skip checking instead of crashing.', () => {
    const r = assertStandalone(path.join(os.tmpdir(), 'hydra-not-exist-xyz'), { exit: false });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
  });

  console.log('\n[Run independently . Build links are connected to guards.]');

  test('Portables will be cleaned up, resources', () => {
    const src = read('build', 'pack.js');
    assert(/assertStandalone\(path\.join\(OUT, 'resources'\)/.test(src), 'No security access.');
  });

  test('MSIX Packing will clean the load up, app/', () => {
    const src = read('build', 'msix.js');
    assert(/assertStandalone\(appDir/.test(src), 'No security.');
  });

  test('Packing only with buld/ rantime (Google running while), no other simulator directory', () => {
    const yml = read('electron-builder.yml');
    const block = yml.slice(yml.indexOf('extraResources:'));
    const head = block.slice(0, block.indexOf('win:'));
    assert(!/mumu|ldplayer|bluestacks/i.test(head), 'Third-party simulators appear in extraResources');
    assert(/build\/runtime/.test(head), 'ExtraResources without built-in running');
  });

  console.log(`\n Result: ${passed} Through, ${failed}  Failed \n`);
  process.exit(failed ? 1 : 0);
})();
