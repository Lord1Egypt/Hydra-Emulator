'use strict';
/**
 * Pure Node test (no need for ELECTron/ Simulator) for repair of "non-100% zoom screen display half."
 *
 * Root: The stand-alone window mode feeds the DIP logical pixels of Electron directly to the DPI-aware process
 *       SetWindowPos, 125/150,
 *       Click misposition. Fix: pass to agent.layout _physical() multiplied by scaleActor.
 *
 * Overwrite:
 *  - _physical Conversion under 100/125/150/175 (with negative coordinates, rounded))
 *  - sf=1 / Unchange rectangular while defaulting
 *  - _area() bring sf fields and share them with the area
 *  - Source level: Separate window mode three ways to playout through _physical, restore path without repeating
 *
 * Run: nonee test/display-scale-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
// Only require zero-dependent pure conversion module - CI with ELECTRON_SKIP_BINARY_DOWNLOAD=1,
// Directly recquire appwin.js will be mistaken for the lack of binary binary (the first pit in this test).
const { physicalRect } = require('../src/core/geometry');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

(() => {
  console.log('\n[*Physic pixel conversion]');

  test('100% Zoom: Rectangular returns (same object, zero expense))', () => {
    const r = { x: 100, y: 60, w: 1280, h: 720 };
    assert.equal(physicalRect(r, 1), r, 'sf=1 should return directly to the object');
    assert.equal(physicalRect(r, 0), r, 'Sf Missing Retrievals will not change');
  });

  test('150% zoom in with coordinates, rounded', () => {
    assert.deepEqual(physicalRect({ x: 100, y: 60, w: 1280, h: 720 }, 1.5),
      { x: 150, y: 90, w: 1920, h: 1080 });
  });

  test('125% Zoom: When decimals appear, take the nearest whole number', () => {
    assert.deepEqual(physicalRect({ x: 33, y: 41, w: 1001, h: 777 }, 1.25),
      { x: Math.round(33 * 1.25), y: Math.round(41 * 1.25), w: Math.round(1001 * 1.25), h: Math.round(777 * 1.25) });
  });

  test('Negative coordinates (-8 ash edge spill) are also converted pro rata and no sign is thrown', () => {
    assert.deepEqual(physicalRect({ x: -8, y: 30 - 8, w: 900, h: 500 }, 2),
      { x: -16, y: 44, w: 1800, h: 1000 });
  });

  test('Full screen full: workArea DIP x sf = physical resolution', () => {
    // 150% down WorkArea of 1920x1080 Physics Screens about 1280x693DIP
    const phys = physicalRect({ x: 0, y: 0, w: 1280, h: 693 }, 1.5);
    assert.equal(phys.w, 1920);
    assert.equal(phys.h, Math.round(693 * 1.5)); // 1040, leave it to taskbar
  });

  console.log('\n[Source Level . Independent window mode all playout access conversions]');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'appwin.js'), 'utf8');

  test('_physical to zero-dependent geometry.physicalRect', () => {
    assert(/require\('\.\/geometry'\)/.test(src), 'Appwin should be introduced');
    const start = src.indexOf('_physical(rect, sf) {');
    const body = src.slice(start, start + 200);
    assert(/physicalRect\(rect/.test(body), '_physical must call physicalRect)');
  });

  test('_area() returns sf and is taken from the same screen', () => {
    const fn = src.slice(src.indexOf('_area() {'), src.indexOf('_scale() {'));
    assert(/scaleFactor/.test(fn), '_area must record scalefactor');
    assert(/return \{[^}]*sf:/s.test(fn), '_area returns value with sf fields');
  });

  test('OpenDetached playout _physical', () => {
    const start = src.indexOf('async openDetached(');
    const body = src.slice(start, src.indexOf('async embed(', start));
    assert(/agent\.layout\(this\._physical\(/.test(body),
      'OpenDetached to agent.layout’s rectangle must first _physical');
  });

  test('Full screen toggle Maximize', () => {
    const start = src.indexOf('async toggleMaximize()');
    const body = src.slice(start, src.indexOf('openDetachedLayoutOnly(area) {'));
    assert(/agent\.layout\(this\._physical\(/.test(body),
      'Independent mode full-screen conversion also');
    // Revert path using probe-returned physical pixels, never again.
    assert(/agent\.layout\(this\._preFullscreenRect\)/.test(body),
      'The physical rectangular restorations obtained from probe cannot be repeated');
  });

  test('OpenDetached LayoutOnly', () => {
    const start = src.indexOf('openDetachedLayoutOnly(area) {');
    const body = src.slice(start, start + 600);
    assert(/agent\.layout\(this\._physical\(/.test(body),
      'The path to the default size is also converted.');
  });

  test('Embedded mode _rect() retains its own sf conversion (not destroyed by this change))', () => {
    const start = src.indexOf('_rect() {');
    const body = src.slice(start, start + 500);
    assert(/this\._scale\(\)/.test(body) && /\* sf/.test(body),
      'Physical translation of embedded mode must be retained');
  });

  console.log(`\n Result: ${passed} Through, ${failed}  Failed \n`);
  process.exit(failed ? 1 : 0);
})();
