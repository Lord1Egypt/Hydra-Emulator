'use strict';
/**
 * End-to-end validation "Andrea applications open only Android applications window":
 *   1) Use Sandbox APPDATA to be real, `--apk` Installation of a test APK (a simulator);
 *   2) Again `- Launch.` Open application;
 *   3) Full-Imaging Visible Top Window: Simulator Main Window (Android Emulator - ) and qemu / netsimd
 *      The control window is not allowed to appear; the application window must appear (indicating the embed success, the image is in the window).
 *
 * Usage: none tools/check-launch-clean.js [apkPath]]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { WinAgent } = require('../src/core/agent');

const ROOT = path.join(__dirname, '..');
// As with the other two window tests, external runtime/data directory is supported (user often runs on D Disk))
const ENGINE = path.resolve(process.env.HYDRA_RUNTIME || path.join(ROOT, 'engine'));
const AVD_DIR = process.env.HYDRA_AVD_HOME || '';
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const APK = process.argv[2] || path.join(os.tmpdir(), 'fdroid.apk');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bad = (w) => {
  const t = String(w.title || '').toLowerCase();
  const c = String(w.cls || '');
  const isConsole = c.indexOf('ConsoleWindowClass') >= 0 || c.indexOf('CASCADIA_HOSTING') >= 0;
  if (isConsole) return t.indexOf('emulator') >= 0 || t.indexOf('netsim') >= 0 || t.indexOf('qemu') >= 0;
  return t.indexOf('android emulator') >= 0;
};

function launch(args, sandbox) {
  const env = { ...process.env, APPDATA: sandbox };
  delete env.ELECTRON_RUN_AS_NODE;
  const p = spawn(ELECTRON, ['.', ...args], {
    cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', () => {});
  p.stderr.on('data', () => {});
  return p;
}

(async () => {
  if (!fs.existsSync(APK)) throw new Error(`Could not find test APK: ${APK}`);
  const sandbox = path.join(os.tmpdir(), `apk-launch-${Date.now()}`);
  const appData = path.join(sandbox, 'hydra');
  fs.mkdirSync(appData, { recursive: true });
  fs.writeFileSync(path.join(appData, 'settings.json'), JSON.stringify({
    runtime: { dir: ENGINE, avdDir: AVD_DIR }, engine: { prewarm: true },
  }));

  const agent = new WinAgent();
  await agent.ensure();
  await agent.scope([ENGINE]);

  let pass = true;
  const check = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) pass = false; };

  // - 1) Install -
  console.log('— Install APK (first time cold start simulator, approximately 40~90 seconds))…');
  let p = launch(['--apk', APK], sandbox);
  let pkg = '';
  for (let i = 0; i < 240; i += 1) {
    await sleep(1000);
    try {
      const apps = JSON.parse(fs.readFileSync(path.join(appData, 'apps.json'), 'utf8')).apps || [];
      if (apps.length && apps[0].package) { pkg = apps[0].package; break; }
    } catch (_) { /* It's not written. */ }
    if (p.exitCode !== null) break;
  }
  check(!!pkg, `Install complete: ${pkg || '(Timeout)'}`);
  // We have to wait for the first example.**Real exit**Once again, if the single case is locked, the second one will exit immediately.,
  // It's in the form of "windows never appear" instead of a failure to start.
  try { p.kill(); } catch (_) { /* ignore */ }
  for (let i = 0; i < 30 && p.exitCode === null; i += 1) await sleep(500);
  await sleep(2000);

  if (!pkg) {
    agent.dispose();
    console.log('\n Result: Failed (no app installed, skipping later))');
    process.exit(1);
  }

  // -2) Open application -
  console.log('— Open app…');
  p = launch(['--launch', pkg], sandbox);
  let leaked = 0;
  let sawAppWin = false;
  const titles = new Set();
  // Cold start 23s + application pull-up ~17s, stay for 120 seconds; 60 seconds before it fails on slow machine
  for (let i = 0; i < 240; i += 1) {
    await sleep(500);
    const r = await agent.call({ cmd: 'windows' }, 5000).catch(() => null);
    const list = ((r && r.list) || []);
    for (const w of list) if (w.title) titles.add(w.title);
    const hit = list.filter(bad);
    if (hit.length) {
      leaked += hit.length;
      console.log(`[${((i + 1) * 0.5).toFixed(1)} s] Visible abnormal window:`, JSON.stringify(hit));
    }
    // Apply window = a normal window with a title, not a simulator/console
    if (!sawAppWin) {
      sawAppWin = list.some((w) => {
        const t = String(w.title || '');
        return t && !bad(w) && !/Hydra Emulator|WorkBuddy|Microsoft|Program Manager|\u8bbe\u7f6e|Edge|\u8f93\u5165\u4f53\u9a8c/.test(t);
      });
      if (sawAppWin) console.log(`[${((i + 1) * 0.5).toFixed(1)} s] Application window appears`);
    }
    if (sawAppWin && i > 40) break;
  }

  check(leaked === 0, `Simulator/console windows are always invisible (cumulative) ${leaked} Numbers)`);
  check(sawAppWin, `Application window has emerged (specify image embedded in window instead of stand-alone emulator window))`);
  console.log('  Visible window title: ', JSON.stringify([...titles].slice(0, 12)));
  if (!pass) {
    console.log('---app.log end ---');
    try {
      const log = fs.readFileSync(path.join(appData, 'logs', 'app.log'), 'utf8').trim().split('\n');
      console.log(log.slice(-12).join('\n'));
    } catch (_) { console.log('(No app.log)'); }
  }

  try { p.kill(); } catch (_) { /* ignore */ }
  agent.dispose();
  await sleep(1500);
  if (pass) {
    try { fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 }); } catch (_) { /* ignore */ }
  } else {
    console.log(`  The sandbox is kept.: ${sandbox}`);
  }
  console.log('');
  console.log(`Result: ${pass ? 'Through' : ' Failed'}`);
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
