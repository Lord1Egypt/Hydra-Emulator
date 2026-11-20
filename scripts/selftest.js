'use strict';
/**
 * Self-check when running (no interface needed to open))
 *
 *   npm run selffest# only when medical check-ups are in place
 *   npm run own -- apk a.apk#Adden up → Start → Screenshot Share directory
 *
 * Purpose: After load Android, confirm with a command that "double-click application, stand-alone window, data interconnection"
 * It’s really working on the machine now, and it’s possible to get a specific link when it comes to the problem.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../src/core/store');
const { Runtime } = require('../src/core/engine');
const { Sharer } = require('../src/core/sharer');
const { parseApk } = require('../src/core/apk');

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : '';
};
const APK = argOf('--apk');
// Leave empty = automatically pulls the product path up and runs the built-in and uses dynamic serial; to connect to external devices only when specified
const SERIAL = argOf('--serial') || '';

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const mark = ok === null ? '○' : ok ? '✓' : '✗';
  console.log(`  ${mark} ${name}${detail ? `  —  ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function step(name, fn) {
  process.stdout.write('');
  try {
    const detail = await fn();
    record(name, true, detail || '');
    return true;
  } catch (e) {
    record(name, e && e.skipped ? null : false, e.message);
    return false;
  }
}

(async () => {
  console.log('\n Self-checking while Hydra Emulator runs');
  console.log(`Equipment: ${SERIAL}`);
  console.log('─'.repeat(64));

  console.log('\n[Component]');
  const runtime = new Runtime(path.join(__dirname, '..'));
  const prov = runtime.provisioner;

  let env = null;
  await step('Adb Available', async () => {
    env = await prov.checkEnv();
    if (!env.adb.ok) throw new Error('No adb installed, please run "One Key Deployment" first');
    return `v${env.adb.version}`;
  });
  await step('Android Emulator ready.', async () => {
    if (!env.emulator.ok) throw new Error('Do not install running engine, please run One Key Deployment first');
    return `v${env.emulator.version}`;
  });
  await step('system image complete.', async () => {
    if (!env.sysimg.ok) throw new Error(env.sysimg.note || 'Mirror missing');
    return `Android ${env.sysimg.api} · ${(env.sysimg.size / 1073741824).toFixed(2)}GB`;
  });
  record('hardware acceleration', env.accel.ok ? true : null,
    env.accel.ok ? env.accel.note : 'Auto-release software simulation (can run, but obviously slow))');

  console.log('\n[Equipment]');
  let client = runtime.client(SERIAL || undefined);
  const online = await step('Runtime ready', async () => {
    if (SERIAL) {
      await client.connect().catch(() => false);
      if (!await client.isOnline()) throw new Error(`External devices are not online: ${SERIAL}`);
      return SERIAL;
    }
    const r = await runtime.ensure({ onLog: () => {} });
    if (!r.ok) throw new Error(r.error || 'Not available when running');
    client = r.client;
    return client.serial;
  });

  if (!online) {
    console.log('\n Device not ready, follow-up project skips.');
  } else {
    await step('Android version', async () => {
      const [ver, sdk, abi] = await Promise.all([
        client.androidVersion(), client.sdkInt(), client.shell('getprop ro.product.cpu.abi').catch(() => ''),
      ]);
      if (!ver) throw new Error('Could not read system version');
      return `Android ${ver} (API ${sdk}) · ${String(abi).trim()}`;
    });
    await step('Screen Resolution', async () => {
      const s = await client.wmSize();
      if (!s) throw new Error('wm size no return');
      return `${s.width}×${s.height}`;
    });
    await step('FreeForm standalone window', async () => {
      const ok = await client.ensureFreeform();
      if (!ok) throw new Error('Could not open freeform (system may not support multiple windows))');
      return 'Enabled';
    });

    console.log('\n[Shared Directory]');
    await step('Two-way Synchronization', async () => {
      const sharer = new Sharer(runtime);
      await client.shellMkdir(store.getSettings().deviceSharedDir);
      const localDir = store.getSettings().sharedDir;
      fs.mkdirSync(localDir, { recursive: true });
      const probe = path.join(localDir, `selftest-${Date.now()}.txt`);
      const payload = `hydra selftest ${new Date().toISOString()}`;
      fs.writeFileSync(probe, payload);

      const up = await sharer.sync();
      if (up.errors && up.errors.length) throw new Error(up.errors[0]);
      const remote = `${store.getSettings().deviceSharedDir}/${path.basename(probe)}`;
      const back = await client.shell(`cat "${remote}" 2>/dev/null`);
      if (!String(back).includes('hydra selftest')) throw new Error('Local device not synchronised');

      const reverse = path.join(localDir, `selftest-from-device-${Date.now()}.txt`);
      await client.shell(`echo device-side > "${store.getSettings().deviceSharedDir}/${path.basename(reverse)}"`);
      await sharer.sync();
      if (!fs.existsSync(reverse) || !fs.readFileSync(reverse, 'utf8').includes('device-side')) {
        throw new Error('Device: This machine is not synchronized');
      }
      fs.rmSync(probe, { force: true });
      fs.rmSync(reverse, { force: true });
      await client.shell(`rm -f "${remote}"`);
      return 'Up + Down Line Normal';
    });

    if (APK) {
      console.log('\n[Apply Links]');
      let meta = null;
      await step('Parsing APK', async () => {
        meta = parseApk(APK);
        return `${meta.label} (${meta.package} v${meta.versionName})`;
      });
      if (meta) {
        await step('Install to Device', async () => {
          await client.install(APK);
          const installed = await client.isInstalled(meta.package);
          if (!installed) throw new Error('pm path not found');
          return 'pm path check';
        });
        await step('Independent window startup', async () => {
          await client.startApp(meta.package, meta.launchActivity, { freeform: true });
          await sleep(4000);
          const top = await client.shell('dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity"');
          if (!String(top).includes(meta.package)) throw new Error('Applying off-front');
          return meta.package;
        });
        await step('Screenshot', async () => {
          const png = await client.screenshot();
          const out = path.join(__dirname, '..', 'test', 'out');
          fs.mkdirSync(out, { recursive: true });
          const file = path.join(out, 'selftest.png');
          fs.writeFileSync(file, png);
          if (png.length < 4096) throw new Error('The screenshot is abnormal.');
          return file;
        });
      }
    } else {
      console.log('\n[Apply links] Unspecified --apk, skip');
    }
  }

  // Stop active when checking your own pull-up: otherwise the stdio pipe of the emulator subprocess
  // Keeps Node event loops constant. Commands appear to be stuck.
  if (!SERIAL && runtime.emulator.running()) {
    await runtime.stop({}).catch(() => {});
  }

  const failed = results.filter((r) => r.ok === false);
  console.log('\n' + '─'.repeat(64));
  console.log(`Result: ${results.filter((r) => r.ok === true).length} Through, ${failed.length}  Failed,`
    + `${results.filter((r) => r.ok === null).length} Skip`);
  if (failed.length) {
    console.log(' Failed: ');
    failed.forEach((f) => console.log(`  · ${f.name}: ${f.detail}`));
    process.exit(1);
  }
  console.log('Check all through\n');
  process.exit(0);
})().catch((e) => {
  console.error('\n Self-censorship has been terminated.: ', e.message);
  process.exit(1);
});
