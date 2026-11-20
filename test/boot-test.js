'use strict';
/**
 * Real Guide Test (default to skip), `npm run test:boot` Manually running.)
 *
 * Use the Alpine virt ISO of 61MB to go through the real start parameters of the product:
 *   Create a qcow2 virtual disk to be guided by light Confirm from serial entry to user state → grace switch
 *
 * Purpose: The engine layer is most prone to error: "The parameters look right, but the real machine doesn't come up.",
 * Start order, virtio disk, ACPI off. Use the real QEMU + the real guest to nail it.
 * No need for Android mirrors, no need for hardware acceleration.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Dissociate data directory: The mirror/disk path used for the test must not be written into the real user settings
process.env.APPDATA = path.join(os.tmpdir(), `hydra-boot-test-${Date.now()}`);
fs.mkdirSync(path.join(process.env.APPDATA, 'hydra'), { recursive: true });

const store = require('../src/core/store');
const { Runtime } = require('../src/core/engine');
const { downloadParallel } = require('../src/core/download');

const ISO_URL = 'https://mirrors.tuna.tsinghua.edu.cn/alpine/v3.20/releases/x86_64/alpine-virt-3.20.3-x86_64.iso';
const WORK = path.join(os.tmpdir(), 'hydra-boot');
const ISO = path.join(WORK, 'alpine-virt.iso');
const DISK = path.join(WORK, 'boot-test.qcow2');
const SERIAL = path.join(WORK, 'serial.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`  ${m}`);

async function ensureIso() {
  if (fs.existsSync(ISO) && fs.statSync(ISO).size > 50 * 1024 * 1024) return;
  fs.mkdirSync(WORK, { recursive: true });
  log('Download Alpine first ISO (approximately 61MB))…');
  await downloadParallel(ISO_URL, ISO, { connections: 8, minChunk: 4 * 1024 * 1024 });
}

(async () => {
  console.log('\n[Real Orientation Test]');
  const runtime = new Runtime(path.join(__dirname, '..'));
  const env = await runtime.provisioner.checkEnv();
  if (!env.qemu.ok) {
    console.error('  Skip: QEMU not installed');
    process.exit(0);
  }
  log(`QEMU ${env.qemu.version} · ${env.qemu.path}`);

  await ensureIso();
  log(`ISO ${(fs.statSync(ISO).size / 1048576).toFixed(0)}MB`);

  // 1) qemu-img builder (createDisk tool chain for the product simultaneously))
  const img = path.join(path.dirname(env.qemu.path), 'qemu-img.exe');
  try { fs.rmSync(DISK, { force: true }); } catch (_) { /* ignore */ }
  const { execFileSync } = require('child_process');
  execFileSync(img, ['create', '-f', 'qcow2', DISK, '2G'], { windowsHide: true });
  log(`Virtual Disk ${(fs.statSync(DISK).size / 1024).toFixed(0)} KB (slurry))`);

  // 2) Use of real start parameters of the product
  runtime._hv = env.hypervisor;
  store.saveSettings({
    runtime: { isoPath: ISO, diskPath: DISK },
    engine: { memoryMB: 1024, cores: 2 },
  });
  const args = runtime.buildArgs({ install: true, headless: true });
  args.push('-serial', `file:${SERIAL}`, '-no-reboot');
  try { fs.rmSync(SERIAL, { force: true }); } catch (_) { /* ignore */ }

  log(`Start: ${args.filter((a) => !a.includes('=')).slice(0, 8).join(' ')} …`);
  const proc = spawn(env.qemu.path, args, { stdio: 'ignore', windowsHide: true });
  let exited = false;
  proc.on('exit', () => { exited = true; });

  // 3) When the guest enters the user state (a login hint at a serial entry is a guide to success))
  const start = Date.now();
  let booted = false;
  while (Date.now() - start < 180000) {
    if (exited) break;
    if (fs.existsSync(SERIAL)) {
      const txt = fs.readFileSync(SERIAL, 'latin1');
      if (/login:/i.test(txt)) { booted = true; break; }
    }
    await sleep(2000);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(0);
  if (!booted) {
    const tail = fs.existsSync(SERIAL) ? fs.readFileSync(SERIAL, 'latin1').slice(-600) : '(No Serial Output)';
    console.error(`  ♪ The guide failed ♪(${elapsed}s): \n${tail}`);
    try { proc.kill(); } catch (_) { /* ignore */ }
    process.exit(1);
  }
  log(`Guest entered user state(${elapsed}s)`);

  // 4) Elegance shutdown: system_powerdown, time out before quit (it’s product stop() behavior))
  let graceful = false;
  try {
    await runtime.monitorCmd('system_powerdown');
    for (let i = 0; i < 20; i++) {
      if (exited) { graceful = true; break; }
      await sleep(500);
    }
    if (!exited) {
      log('Guess not responding ACPI off, switch to quit.)…');
      await runtime.monitorCmd('quit');
      for (let i = 0; i < 10; i++) {
        if (exited) break;
        await sleep(300);
      }
    }
  } catch (e) {
    log(`monitor abnormal: ${e.message}`);
  }
  if (!exited) { try { proc.kill(); } catch (_) { /* ignore */ } }
  log(exited ? `* Virtual machine off(${graceful ? 'ACPI Elegance Switchoff' : 'quit'})` : 'Virtual machine shutdown failed');

  try { fs.rmSync(DISK, { force: true }); } catch (_) { /* ignore */ }
  console.log(`\n Result: ${exited ? 'Through' : ' Failed'}\n`);
  process.exit(exited ? 0 : 1);
})().catch((e) => {
  console.error('  Unusual.: ', e.message);
  process.exit(1);
});
