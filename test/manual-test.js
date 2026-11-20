'use strict';
/**
 * Internal manual map test (0.6.3))
 *
 * Focus on two things.:
 *  1) Each chapter anchor must be present in a packaged src/ui/manual.html;
 *  2) Autodetect/ Install Wrong / Users 3-way entry to the same correct chapter.
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
const manual = require(path.join(ROOT, 'src/core/manual'));
const html = fs.readFileSync(path.join(ROOT, 'src/ui/manual.html'), 'utf8');

console.log('\n[Built manual . anchor point]');
test('The anchors for each theme are in the package HTML', () => {
  for (const topic of Object.values(manual.TOPICS)) {
    assert(html.includes(`id="${topic.anchor}"`), `${topic.id} anchor point ${topic.anchor} It doesn't exist in the manual.`);
  }
});

test('The body of the manual contains 0.6.3 version numbers and sound sections', () => {
  assert(html.includes('v0.6.3'), 'The manual should be marked v. 6.3');
  assert(html.includes('No sound or low volume'), 'The manual should have voice-disorder sections.');
  assert(html.includes('User manual and automatic troubleshooting'), 'The manual should describe the automatic curriculum');
});

test('The manual has 6.8 store version DLL loading failed sections and corrects a single miscalculation', () => {
  assert(html.includes('Store build startup error 0xC0000135'), 'The manual should have 6.8 chapters');
  assert(/MSIX path restrictions, a missing VC\+\+ runtime/.test(html), 'Explain multiple possible causes for error 0xC0000135');
});

console.log('\n[• Auto-detection problems * Chapters]');
test('Hardware acceleration is positioned at 6.1.', () => {
  const t = manual.topicForIssue({ code: 'accel.softwareEmulation', title: 'There is no hardware acceleration at this time' });
  assert(t.id === 'accel', `Could not close temporary folder: %s ${t.id}`);
});

test('Adb unauthorised position to 6.4', () => {
  const t = manual.topicForIssue({ code: 'device.unauthorized', title: 'The Android device is not authorized to debug' });
  assert(t.id === 'adb', `Should be located to adb, actual ${t.id}`);
});

test('Sound switches and service stoppages are located at 6.7.', () => {
  assert(manual.topicForIssue({ code: 'audio.disabled' }).id === 'sound', 'Sound switch to 6.7.');
  assert(manual.topicForIssue({ code: 'audio.windowsServiceStopped' }).id === 'sound', 'Audio services should reach 6.7.');
});

test('DLL / VC++ Diagnosis Problem Position to 6.8', () => {
  assert(manual.topicForIssue({ code: 'DLL', title: 'Reliance on DLL loading on running failed' }).id === 'dll', 'DLL classification should read 6.8');
  assert(manual.topicForIssue({ code: 'vcRedist', title: 'Missing VC++ running library' }).id === 'dll', 'VC++ field item should be 6.8');
  const t = manual.topicForIssue({ code: 'runtime.bootFailed', title: 'Startup failed', detail: '0xC0000135 emulator exit' });
  assert(t.id === 'dll', `Startup failed with 0xC0000135 should be 6.8, actual ${t.id}`);
});

test('Prefer ARM log to 6.3 when starting ARM for failure', () => {
  const t = manual.topicForIssue({
    code: 'runtime.bootFailed',
    title: 'The last time Android was running failed.',
    detail: 'DoBadTrampoline libndk_translation',
  });
  assert(t.id === 'arm', `Should be positioned to anarm, actual ${t.id}`);
});

test('Normal startup failed to locate 6.5', () => {
  const t = manual.topicForIssue({ code: 'runtime.bootFailed', title: 'Startup failed', detail: 'cannot lock AVD' });
  assert(t.id === 'startup', `Should be positioned to startup, actual ${t.id}`);
});

console.log('\n[Internal manual • Installation error section]');
test('NO_MATCHING_ABIS position to ARM chapter', () => {
  assert(manual.topicForError('INSTALL_FAILED_NO_MATCHING_ABIS').id === 'arm', 'Should come to ARM Chapter');
});

test('Other INSTALL_FAILED position to install chapter', () => {
  assert(manual.topicForError('INSTALL_FAILED_INSUFFICIENT_STORAGE').id === 'install', 'Should be to install chapter');
});

test('Positioning separate from original error of sound', () => {
  assert(manual.topicForError('ADB_UNAUTHORIZED').id === 'adb', 'adb to 6.4');
  assert(manual.topicForError('audio disabled -no-audio').id === 'sound', 'Sound error is due to 6.7.');
});

test('0xC0000135 The original report was mispositioned to 6.8 instead of installing the chapter', () => {
  assert(manual.topicForError('emulator exit 3221225781').id === 'dll', 'Decimal exit code to 6.8');
  assert(manual.topicForError('0xC0000135 STATUS_DLL_NOT_FOUND').id === 'dll', 'Hexadecimal exit code to 6.8.');
});

console.log('\n[Internal manual • Uniform entrance]');
test('Resolve accepts three shapes / issue / topic', () => {
  assert(manual.resolve('INSTALL_FAILED_NO_MATCHING_ABIS').id === 'arm', 'String should be recognised');
  assert(manual.resolve({ issue: 'audio.disabled' }).id === 'sound', 'Que code should be identifiable');
  assert(manual.resolve({ topic: 'overview', reason: 'toolbar' }).anchor, 'Topic should be able to identify');
});

test('Unknown input back to directory page, no anomaly', () => {
  const r = manual.resolve({});
  assert(r.id === 'overview' && r.anchor, 'Should return to the directory page');
});

console.log('\n[Internal manual • Wiring check]');
test('Main:open, preload exposed', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
  assert(/ipcMain\.handle\('manual:open'/.test(main), 'Main process not registered');
  assert(/openManual:\s*\(payload\)/.test(preload), 'Preload Unexposed openManual');
  assert(/new BrowserWindow\([\s\S]*manual\.html/.test(main), 'Main process did not create a manual window');
});

test('Titlebar / Manual entrance for pages', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.js'), 'utf8');
  assert(/id="btnManual"/.test(html), 'Can not get folder: %s: %s');
  assert(/id="btnOpenManual"/.test(html), 'Lack of manual buttons for pages');
  assert(/\$\('btnManual'\)\?\.addEventListener/.test(js), 'Titlebar button unbound');
  assert(/\$\('btnOpenManual'\)\?\.addEventListener/.test(js), 'About Page Button Unbound');
});

test('Both installation failure and restoration failure automatically open the corresponding curriculum', () => {
  const js = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.js'), 'utf8');
  assert(/openManualForError\(raw, 'install-failed'\)/.test(js), 'Installation failed without an automatic course');
  assert(/function failFix\([\s\S]*openManualForIssue\(issue, 'fix-failed'\)/.test(js), 'The restoration failed without an automatic course');
  assert(/case 'audioService'/.test(js) && /case 'audio':/.test(js), 'Sound fix action not connected');
});

test('Diagnosis entry with tutorial buttons', () => {
  const js = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.js'), 'utf8');
  assert(/class="dbg-help"/.test(js), 'Autodetection entries missing tutorial buttons');
  assert(/class="ec-help"/.test(js), 'Lack of tutorial buttons for self-check entries');
});

test('0xC0000135 no longer cut to kill DLL / missing VC++', () => {
  const doctor = fs.readFileSync(path.join(ROOT, 'src', 'core', 'doctor.js'), 'utf8');
  const emu = fs.readFileSync(path.join(ROOT, 'src', 'core', 'emulator.js'), 'utf8');
  assert(/runtime DLL failed to load \(cause unknown\)/i.test(doctor), 'Preserve the uncertainty in diagnostics');
  assert(/0xC0000135[^\n]*cause unknown/i.test(emu), 'Preserve the uncertainty in the exit description');
});

console.log(`\n Built-in manual testing: ${passed} Through, ${failed}  Failed \n`);
process.exitCode = failed ? 1 : 0;
