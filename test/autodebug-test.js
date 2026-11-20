'use strict';
/**
 * Automatically detect kernels (src/core/autodebug.js) monopolistic
 *
 * Pure function, not relying on eclecron/ adb/ network -- CI can run directly.
 * Focus on two bottom lines.:
 *   1) Failure to detect must not become a “problem” (not to be reported);
 *   2) The real problem has to be reported, and give an executable repair action.
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
const ad = require(path.join(ROOT, 'src/core/autodebug'));

const codes = (issues) => issues.map((i) => i.code);

console.log('\n[Automatic detection . Empty snapshots are not misreported]');
test('A completely empty snapshot doesn\'t cause any problems.', () => {
  const issues = ad.evaluate({});
  assert(issues.length === 0, `There shouldn't be a problem, actually. ${JSON.stringify(codes(issues))}`);
});

test('I don\'t think I\'m going to tell you half the time.', () => {
  // I just know “run.“ I don't know.
  const issues = ad.evaluate({ runtime: { running: true } });
  assert(issues.length === 0, `There shouldn't be a problem, actually. ${JSON.stringify(codes(issues))}`);
});

test('The equipment is not “seen“ until it is checked.', () => {
  const issues = ad.evaluate({ runtime: { running: true }, device: { checked: false } });
  assert(!codes(issues).includes('device.missing'), 'We shouldn\'t have reported missing equipment.');
});

console.log('\n[Autodetect . Runtime]');
test('The last time you failed to start, you\'ll report it, and you\'ll take the real ones.', () => {
  const issues = ad.evaluate({ runtime: { error: 'FATAL: cannot lock AVD' } });
  const it = issues.find((i) => i.code === 'runtime.bootFailed');
  assert(it, 'Should report launch failure');
  assert(it.severity === 'error', 'It should be a serious problem.');
  assert(it.detail.includes('cannot lock AVD'), 'You should take the real reason.');
  assert(it.fix === 'restartRuntime', 'Should give executable fix action');
});

test('The lead’s stuck over two and a half minutes to the tip.)', () => {
  const soon = ad.evaluate({ runtime: { running: true, phase: 'booting', bootMs: 30000 } });
  assert(!codes(soon).includes('runtime.stuckBoot'), 'I shouldn\'t have told you.');
  const stuck = ad.evaluate({ runtime: { running: true, phase: 'booting', bootMs: 200000 } });
  assert(codes(stuck).includes('runtime.stuckBoot'), 'It\'s a long time.');
});

test('We’ll report each of the remaining lock files and the orphan process.', () => {
  const issues = ad.evaluate({ runtime: { locks: 2, orphans: 1 } });
  assert(codes(issues).includes('runtime.staleLocks'), 'Residual locks to be reported');
  assert(codes(issues).includes('runtime.orphanProcesses'), 'The orphan reporting process');
});

test('They\'re gonna spot the shell.', () => {
  const issues = ad.evaluate({ runtime: { snapshotStale: true } });
  assert(codes(issues).includes('runtime.saleSnapshot') === false, 'There should be no misspelled code.');
  assert(codes(issues).includes('runtime.staleSnapshot'), 'I’m gonna have to report the snapshot damage.');
});

console.log('\n[Automatic detection • Device connection]');
test('Unauthorized is a serious problem.)', () => {
  const issues = ad.evaluate({ device: { checked: true, state: 'unauthorized' } });
  const it = issues.find((i) => i.code === 'device.unauthorized');
  assert(it, 'Receivable for unauthorized');
  assert(it.severity === 'error', 'It should be a serious problem.');
  assert(it.category === 'device', 'Should be attributed to device connection');
});

test('Offline separates from no-device and is different in severity', () => {
  const off = ad.evaluate({ device: { checked: true, state: 'offline' } });
  assert(codes(off).includes('device.offline'), 'Reportable');
  const none = ad.evaluate({ runtime: { running: true }, device: { checked: true, state: 'no-device' } });
  assert(codes(none).includes('device.missing'), 'Lack of reported equipment');
});

console.log('\n[Autodetect . Store]');
test('We have a problem with the disk, the 2GB is a serious problem.', () => {
  const crit = ad.evaluate({ storage: { freeMB: 1024 } });
  const ci = crit.find((i) => i.code === 'storage.diskCritical');
  assert(ci && ci.severity === 'error', 'Less than 2GB should be a serious problem');
  const warn = ad.evaluate({ storage: { freeMB: 5000 } });
  const wi = warn.find((i) => i.code === 'storage.diskLow');
  assert(wi && wi.severity === 'warn', 'Below 8GB should be a reminder');
});

test('The data partition is blocked by the differential disk and will be reported correctly.', () => {
  const issues = ad.evaluate({ storage: { needsReset: true, configuredGB: 16, actualGB: 6 } });
  const it = issues.find((i) => i.code === 'storage.dataNeedsReset');
  assert(it, 'Not effective.');
  assert(it.detail.includes('16') && it.detail.includes('6'), 'Configuration values and actual values should be brought');
});

test('The configuration capacity is greater than the actual capacity is a serious problem', () => {
  const issues = ad.evaluate({ storage: { configuredGB: 24, actualGB: 6 } });
  const it = issues.find((i) => i.code === 'storage.dataMismatch');
  assert(it && it.severity === 'error', 'It should be a serious problem.');
});

test('If you can’t write a shared directory, you’ll report it.', () => {
  const issues = ad.evaluate({ storage: { sharedOk: false, sharedPath: 'D:\\share' } });
  const it = issues.find((i) => i.code === 'storage.sharedBroken');
  assert(it, 'Should be reported as sharing directory anomaly');
  assert(it.detail.includes('share'), 'Should bring directory path');
});

console.log('\n[Autodetect • Setup Conflict]');
test('Force screens but panels are screens -- fight in the direction.', () => {
  const issues = ad.evaluate({ settings: { orientationMode: 'portrait', landscape: true } });
  assert(codes(issues).includes('settings.orientationConflict'), 'Reaction to conflict');
});

test('Force screens but panel is staggered -- a fight in the direction.', () => {
  const issues = ad.evaluate({ settings: { orientationMode: 'landscape', landscape: false } });
  assert(codes(issues).includes('settings.orientationConflict'), 'Reaction to conflict');
});

test('Follow application + any panel direction is not conflict', () => {
  const a = ad.evaluate({ settings: { orientationMode: 'auto', landscape: true } });
  const b = ad.evaluate({ settings: { orientationMode: 'auto', landscape: false } });
  assert(!codes(a).includes('settings.orientationConflict'), 'Autu, you shouldn\'t have called a conflict.');
  assert(!codes(b).includes('settings.orientationConflict'), 'Autu, you shouldn\'t have called a conflict.');
});

console.log('\n[Automatic detection . Sound (0.6.2))]');
test('Android\'s voice will be turned off, and he\'ll bring the lessons.', () => {
  const issues = ad.evaluate({ audio: { checked: true, enabled: false, serviceRunning: true } });
  const it = issues.find((i) => i.code === 'audio.disabled');
  assert(it, 'The voice switch is off.');
  assert(it.category === 'settings' && it.fix === 'audio', 'Should be set and can be handled with one key');
  assert(it.help && it.help.id === 'sound', 'The built-in curriculum should be brought with');
});

test('Windows audio services will stop and report.', () => {
  const issues = ad.evaluate({ audio: { checked: true, enabled: true, serviceRunning: false } });
  const it = issues.find((i) => i.code === 'audio.windowsServiceStopped');
  assert(it, 'The audio service should be reported to have stopped.');
  assert(it.fix === 'audioService', 'The corresponding repair action should be given');
});

test('The failure of audio services detection is not considered a problem.', () => {
  const issues = ad.evaluate({ audio: { checked: true, enabled: true, serviceRunning: null } });
  assert(!codes(issues).includes('audio.windowsServiceStopped'), 'You shouldn\'t have reported it if you don\'t know.');
});

console.log('\n[• Networks and logs]');
test('Android\'s not gonna report it and give him a fix.', () => {
  const issues = ad.evaluate({ network: { ok: false, reason: 'dns timeout' } });
  const it = issues.find((i) => i.code === 'network.guestDown');
  assert(it, 'We\'ll call Android No Network.');
  assert(it.fix === 'repairNetwork', 'The repair action should be given');
});

test('Download Source Not Connected to Accounting', () => {
  const issues = ad.evaluate({ network: { sources: [{ name: 'GitHub', ok: false }, { name: 'Gitee', ok: true }] } });
  const it = issues.find((i) => i.code === 'network.sourcesDown');
  assert(it, 'We\'ve got a dead end.');
  assert(it.detail.includes('GitHub'), 'Which source should be indicated');
  assert(!it.detail.includes('Gitee'), 'Normal sources shouldn’t be listed.');
});

test('The errors in the log will be removed.', () => {
  const issues = ad.evaluate({ logs: { errors: ['2026-01-01 FATAL: cannot lock AVD'] } });
  const it = issues.find((i) => i.code === 'logs.errors');
  assert(it, 'Reportable log error');
  assert(it.detail.includes('cannot lock'), 'The wrong text should be brought with it.');
});

console.log('\n[• Summary versus Difference]');
test('Summarizes by severity and gives health.', () => {
  const s = ad.summarize(ad.evaluate({
    runtime: { error: 'boom' },
    storage: { freeMB: 1024 },
    device: { checked: true, state: 'unauthorized' },
  }));
  assert(s.total === 3, `There should be 3 items, actual ${s.total}`);
  assert(s.errors === 3, `There should be 3 serious problems, actual ${s.errors}`);
  assert(s.health === 'error', 'Health should be error');
  assert(s.byCategory.length === 6, 'Classification should be fixed at 6');
});

test('There’s no problem with the health level.', () => {
  const s = ad.summarize([]);
  assert(s.total === 0 && s.health === 'ok', 'It should be empty and healthy.');
});

test('The same line of code left only the last one.', () => {
  const list = ad.dedupe([
    { code: 'x', severity: 'warn', title: 'Old' },
    { code: 'x', severity: 'error', title: 'New' },
  ]);
  assert(list.length === 1, 'There’s only one left.');
  assert(list[0].title === 'New', 'The last article should be retained');
});

test('Differences can distinguish between "new" and "disappeared"', () => {
  const prev = [{ code: 'a', severity: 'error' }, { code: 'b', severity: 'warn' }];
  const next = [{ code: 'b', severity: 'warn' }, { code: 'c', severity: 'error' }];
  const d = ad.diff(prev, next);
  assert(d.added.length === 1 && d.added[0].code === 'c', 'New problems should be identified');
  assert(d.resolved.length === 1 && d.resolved[0].code === 'a', 'It should be recognized that it’s gone.');
});

test('The severity of the change is also called “new“ (error upgrade from warn to warn).)', () => {
  const d = ad.diff([{ code: 'a', severity: 'warn' }], [{ code: 'a', severity: 'error' }]);
  assert(d.added.length === 1, 'The severity of the escalation should be recalled.');
});

console.log('\n[Auto-detection . Structure constraints]');
test('Every problem is classified, serious, title', () => {
  const issues = ad.evaluate({
    runtime: { error: 'x', locks: 1, orphans: 1, snapshotStale: true },
    device: { checked: true, state: 'offline' },
    storage: { freeMB: 100, needsReset: true, sharedOk: false },
    settings: { orientationMode: 'portrait', landscape: true },
    network: { ok: false },
    logs: { errors: ['err'] },
  });
  assert(issues.length > 0, 'There’s got to be a few questions.');
  for (const it of issues) {
    assert(it.code, 'There must be code');
    assert(ad.CATEGORY_IDS.includes(it.category), `Classification must be legal: ${it.category}`);
    assert(['error', 'warn', 'info'].includes(it.severity), `It must be legal.: ${it.severity}`);
    assert(it.title, 'There must be a title.');
    assert(typeof it.hint === 'string', 'There must be a statement.');
  }
});

test('The classification table is consistent at the front end (reflex layer DEBUG_CATS))', () => {
  const appJs = fs.readFileSync(path.join(ROOT, 'src/ui/app.js'), 'utf8');
  const m = appJs.match(/const DEBUG_CATS = \[([\s\S]*?)\];/);
  assert(m, 'I think there’s a DEBUG_CATS in the app.js.');
  const ids = (m[1].match(/id:\s*'([a-z]+)'/g) || []).map((s) => s.replace(/id:\s*'|'/g, ''));
  assert(ids.length === ad.CATEGORIES.length, `The number of classifications should be consistent: front end ${ids.length} / Backend ${ad.CATEGORIES.length}`);
  for (const c of ad.CATEGORIES) {
    assert(ids.includes(c.id), `Lack of classification at front end ${c.id}`);
  }
});

console.log('\n[· Automatically detect main process connections]');
test('The main process has registered the IPC for the testing.', () => {
  const mainJs = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
  for (const ch of ['autodebug:run', 'autodebug:state', 'autodebug:config', 'app:clearOrphans', 'app:clearSnapshot', 'runtime:restart']) {
    assert(mainJs.includes(`'${ch}'`), `The main process should be registered ${ch}`);
  }
  assert(mainJs.includes('scheduleAutodebug()'), 'Main process should be scheduled for detection');
});

test('Preload exposed the detection interface and released the state event', () => {
  const p = fs.readFileSync(path.join(ROOT, 'src/preload.js'), 'utf8');
  for (const fn of ['autodebugRun', 'autodebugState', 'autodebugConfig', 'clearOrphans', 'clearSnapshot', 'restartRuntime']) {
    assert(p.includes(fn), `Preload should be exposed. ${fn}`);
  }
  assert(p.includes("'autodebug:state'"), 'Preload should release autodebug: state event');
});

test('Set switches and buttons for autodetection in the entry', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8');
  for (const id of ['setAutodebugAuto', 'setAutodebugInterval', 'setAutodebugNotify', 'btnAutodebugRun', 'autodebugList']) {
    assert(html.includes(`id="${id}"`), `Setup Page Should ${id}`);
  }
});

console.log(`\n Result: ${passed} Through, ${failed}  Failed`);
process.exit(failed ? 1 : 0);
