'use strict';
/**
 * window validation: pulls up emulator by main process, confirming that "no excess window on the desktop appears".
 *
 * We're looking at two types of windows.:
 *   1. "Android Emulator - Hydra 5554" (QWindowIcon, Simulator Main Window))
 *      —— Normal should only appear as a sub-window of our window after embed, and never see it on the desktop;
 *   ConsolWindowClass/ CASCADIA_HOSTING_WINDOW_CLASS)
 *      —— qemu, netsimd each plays one, with the title of the exe path that was started.
 *
 * Usage: none of these/check-windows.js [runtimeRoot]]
 *   RuntimeRoot by default takes engine/ from the warehouse (run time of local downloads), and also transmits the installed directory
 *   resources/runtime.
 */
const path = require('path');
const { spawn } = require('child_process');
const { WinAgent } = require('../src/core/agent');

// runtime directory: command line parameter > environment variable > engine in repository/
const ROOT = path.resolve(process.argv[2] || process.env.HYDRA_RUNTIME || path.join(__dirname, '..', 'engine'));
const EMU = path.join(ROOT, 'emulator', 'emulator.exe');
// AVD may be used on other disks (runtime.avdDir in settings), usually online; this also supports explicit designations
const AVD_HOME = process.env.HYDRA_AVD_HOME
  || path.join(process.env.APPDATA || '', 'hydra', 'avd');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bad = (w) => {
  const t = String(w.title || '').toLowerCase();
  const c = String(w.cls || '');
  const isConsole = c.indexOf('ConsoleWindowClass') >= 0 || c.indexOf('CASCADIA_HOSTING') >= 0;
  if (isConsole) return t.indexOf('emulator') >= 0 || t.indexOf('netsim') >= 0 || t.indexOf('qemu') >= 0;
  return t.indexOf('android emulator') >= 0;
};

(async () => {
  const agent = new WinAgent();
  await agent.ensure();
  console.log('agent ready, port=', agent.port);

  const windows = async () => {
    const r = await agent.call({ cmd: 'windows' }, 5000).catch(() => null);
    return (r && r.list) || [];
  };

  // The agent only touches the window created by the "Processes in the Runtime Directory": first declare the range, otherwise it hides nothing.
  await agent.scope([ROOT]);
  await agent.bootHide();
  console.log('Permanent repression is on.');

  const proc = spawn(EMU, [
    '-avd', 'hydra', '-port', '5554', '-no-boot-anim', '-no-metrics',
    '-crash-report-mode', 'disabled', '-gpu', 'swangle', '-memory', '3072',
    '-cores', '3', '-no-skin', '-snapshot', 'hydra', '-no-snapshot-load',
  ], {
    cwd: path.dirname(EMU),
    env: {
      ...process.env,
      ANDROID_SDK_ROOT: ROOT, ANDROID_HOME: ROOT,
      ANDROID_AVD_HOME: AVD_HOME, ANDROID_EMULATOR_HOME: AVD_HOME,
      ANDROID_ADB_SERVER_PORT: '5044',
    },
    windowsHide: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.unref();
  proc.stderr.on('data', () => {});
  proc.stdout.on('data', () => {});

  let leaked = 0;
  const ticks = Math.max(24, Number(process.env.CHECK_SECONDS || 0) * 2 || 24);
  for (let i = 0; i < ticks; i += 1) {
    await sleep(500);
    const list = await windows();
    const hit = list.filter(bad);
    if (hit.length) {
      leaked += hit.length;
      console.log(`[${((i + 1) * 0.5).toFixed(1)} s] Visible abnormal window:`, JSON.stringify(hit));
    }
  }

  const probe = await agent.probe().catch(() => null);
  console.log('Probe (hidden window should also be found)):', JSON.stringify(probe));

  const left = (await windows()).filter(bad);
  console.log('Anomalous window still on the desktop at the end:', JSON.stringify(left));

  const okProbe = !!(probe && Number(probe.emu) !== 0);
  // Allowing "exceeded but crushed in 400ms" eventually has to be zero
  const ok = left.length === 0 && okProbe;
  console.log('');
  console.log(`Result: ${ok ? 'Through' : ' Failed'}(Accumulation of abnormal windows visible in the process ${leaked} Next, at the end ${left.length} One.)`);

  try { proc.kill(); } catch (_) { /* ignore */ }
  agent.dispose();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
