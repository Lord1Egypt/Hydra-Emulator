'use strict';
/**
 * Setup page class navigation + search (0.6.0) structure test
 *
 * Setup pages are the most common facet of users, and when a classification is not matched to a grouping, there is "a classification point is empty."
 * Here’s the source-level assertion: each sub-group in HTML must have a data-cat, and the navigation item must match the classification used in the group.,
 * The front-end classification must match HTML.
 */

const fs = require('fs');
const path = require('path');

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

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'src/ui/app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'src/ui/style.css'), 'utf8');

/** Remove HTML snippets from settings Body */
const bodyMatch = html.match(/<div class="modal-body" id="settingsBody">([\s\S]*?)\n    <\/div>\n    <\/div>\n    <footer/);
assert(bodyMatch, 'Should be able to locate to the panel’s main object');

console.log('\n[Set classification . Structure]');
test('Set panel with class navigation and search boxes', () => {
  assert(html.includes('id="setNav"'), 'There should be a class navigation container.');
  assert(html.includes('id="setSearch"'), 'There should be a search box');
  assert(html.includes('id="btnClearSearch"'), 'There should be a clean search button');
  assert(html.includes('id="settingsBody"'), 'The content area should be stable id (positioning and scrolling to use))');
});

test('Navigator covers all 9 classifications (including laboratory))', () => {
  const navMatch = html.match(/<nav class="set-nav" id="setNav"[\s\S]*?<\/nav>/);
  assert(navMatch, 'Should be nav');
  const items = navMatch[0].match(/data-cat="([a-z]+)"/g) || [];
  const ids = items.map((s) => s.replace(/data-cat="|"/g, ''));
  const expected = ['basic', 'display', 'input', 'perf', 'net', 'diag', 'files', 'about', 'lab'];
  assert(ids.length === expected.length, `The navigation item should have ${expected.length} individual, actual ${ids.length}`);
  for (const e of expected) {
    assert(ids.includes(e), `Lack of classification of navigation ${e}`);
  }
});

test('Each set group is classed (no leaks))', () => {
  // Remove the start tab of all top-level groups in the setup subject
  const groups = bodyMatch[1].match(/<(div class="group"|details class="advanced-group")[^>]*>/g) || [];
  assert(groups.length >= 15, `Set up not less than 15 groups, actual ${groups.length}`);
  for (const g of groups) {
    assert(/data-cat="[a-z]+"/.test(g), `missing group data-cat: ${g}`);
  }
});

test('The categories used in the groups are in the navigation.)', () => {
  const navMatch = html.match(/<nav class="set-nav" id="setNav"[\s\S]*?<\/nav>/);
  const navIds = (navMatch[0].match(/data-cat="([a-z]+)"/g) || []).map((s) => s.replace(/data-cat="|"/g, ''));
  const used = (bodyMatch[1].match(/data-cat="([a-z]+)"/g) || []).map((s) => s.replace(/data-cat="|"/g, ''));
  const usedSet = Array.from(new Set(used));
  for (const u of usedSet) {
    assert(navIds.includes(u), `Classification ${u} No corresponding navigation item`);
  }
  // At least one group for each class. The empty class should be removed from the navigation.
  for (const n of navIds) {
    assert(used.includes(n), `Classification ${n} There's no grouping. It's not supposed to be in the navigation.`);
  }
});

test('Key clusters fall into a reasonable classification.', () => {
  const expect = [
    ['id="runtimeGroup"', 'basic'],
    ['id="perfGroup"', 'perf'],
    ['id="preflightGroup"', 'diag'],
    ['id="driverGroup"', 'diag'],
    ['id="autodebugGroup"', 'diag'],
    ['id="downloadGroup"', 'net'],
    ['id="updateGroup"', 'about'],
    ['id="aboutGroup"', 'about'],
    ['id="labGroup"', 'lab'],
  ];
  for (const [marker, cat] of expect) {
    const idx = html.indexOf(marker);
    assert(idx > 0, `Not found ${marker}`);
    const tail = html.slice(idx, idx + 120);
    assert(tail.includes(`data-cat="${cat}"`), `${marker} It's back. ${cat}`);
  }
});

test('The front-end classification table corresponds to the navigation item I.', () => {
  const m = appJs.match(/const SETTINGS_CATS = \[([\s\S]*?)\];/);
  assert(m, 'SETTINGS_CATS');
  const ids = (m[1].match(/id:\s*'([a-z]+)'/g) || []).map((s) => s.replace(/id:\s*'|'/g, ''));
  const navMatch = html.match(/<nav class="set-nav" id="setNav"[\s\S]*?<\/nav>/);
  const navIds = (navMatch[0].match(/data-cat="([a-z]+)"/g) || []).map((s) => s.replace(/data-cat="|"/g, ''));
  assert(ids.length === navIds.length, `Front-end classification ${ids.length} One, navigation. ${navIds.length} One.`);
  for (const n of navIds) {
    assert(ids.includes(n), `Lack of classification at front end ${n}`);
  }
});

console.log('\n[Set classification . Behavior]');
test('Switch achieved, filtering and memory', () => {
  assert(appJs.includes('function switchSettingsCat'), 'There should be a classification switch function');
  assert(appJs.includes('function applySettingsFilter'), 'Should be visible filter function');
  assert(appJs.includes('function groupMatches'), 'There should be a search matching function');
  assert(appJs.includes('function focusGroup'), 'The function should be positioned to group');
  assert(appJs.includes('hydra.settings.cat'), 'Remember the classification of the last stay.');
});

test('Searches are cross-classified.)', () => {
  // Click to see when filtering instead of just looking at the current classification
  const fn = appJs.match(/function applySettingsFilter\(\) \{[\s\S]*?\n\}/);
  assert(fn, 'It’s supposed to be able to locate an apply SettingsFilter.');
  assert(/g\.hidden = q \? !hit : !inCat/.test(fn[0]), 'Search should be shown by impact (cross-classification))');
});

test('The jump to the portal has been changed to the focusGroup (classifier to still position in group))', () => {
  assert(appJs.includes("focusGroup($('runtimeGroup'))"), 'Deployment Wizard should be positioned in a group when running');
  assert(appJs.includes("focusGroup($('perfGroup'))"), 'Data partitioning issues should be positioned to performance grouping');
  // The old direct ScrollIntoView location should have been replaced by the FocusGroup
  const direct = appJs.match(/box\.scrollIntoView\(\{ block: 'start', behavior: 'smooth' \}\)/g) || [];
  assert(direct.length === 0, `There should be no more direct scrollIntoView positioning (and more) ${direct.length}  Location)`);
});

test('Automatically detect repair buttons for panels to restore crossIssue', () => {
  assert(appJs.includes('data-code="${esc(it.code)}"'), 'Tests should be brought code for repair');
  assert(appJs.includes('fixIssue(issue)'), 'The unified repair entrance should be restored');
});

test('Laboratories have multiple switches and received engine.multiWindow', () => {
  assert(html.includes('id="setMultiWindow"'), 'There should be more windows and more switches.');
  assert(html.includes('id="setKeepBackground"'), 'Reservation set for backstage');
  assert(html.includes('class="lab-notice"'), ' There\'s an experimental tip in the lab.');
  // Switches need to read and write real settings, not empty shells.
  assert(/setMultiWindow'\)\.checked = !!s\.engine\.multiWindow/.test(appJs), 'Reload multiWindow status');
  assert(/engine:\s*\{\s*multiWindow:\s*e\.target\.checked/.test(appJs), 'Save the switch to engine.multiWindow');
  assert(/engine:\s*\{\s*keepBackground:/.test(appJs), 'Number of backstage reservations to save');
  // The bottom level does consume this setup.)
  const engineJs = fs.readFileSync(path.join(ROOT, 'src/core/engine.js'), 'utf8');
  assert(/s\.engine && s\.engine\.multiWindow/.test(engineJs), 'engine to read multiWindow decides not to force-stop old application');
  const storeJs = fs.readFileSync(path.join(ROOT, 'src/core/store.js'), 'utf8');
  assert(/multiWindow:\s*false/.test(storeJs), 'store requires multiWindow default and the default closes');
});

console.log('\n[Set classification styles]');
test('There are navigation, search and detect panel styles', () => {
  for (const sel of ['.set-nav', '.set-nav-item', '.set-search', '.dbg-list', '.dbg-item', '.modal-main']) {
    assert(css.includes(sel), `I don’t know, style.css, style. ${sel}`);
  }
});

test('The window is wide, but it\'s not breaking the screen.', () => {
  assert(/\.modal \{[^}]*width: 880px/.test(css), 'The window should read 880 px');
  assert(css.includes('max-width: calc(100vw - 48px)'), 'The screen should fit it.');
});

console.log(`\n Result: ${passed} Through, ${failed}  Failed`);
process.exit(failed ? 1 : 0);
