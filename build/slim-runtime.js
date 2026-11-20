'use strict';
/**
 * Run thinner: delete the file from the emulator, "We’ll never load the way we started."
 *
 * Based on a fixed start parameter for emularator.js:
 *   - with x86_64 image (API30 AOSP)—qemu-system-aarch64.exe not needed
 *   - gpu software (wiftshader) → vulkan / gles_angle backend not available
 *   - The interface keeps only 38px titlebars Simulators with their own multi-language interfaces and WebEngine panels are not needed
 *
 * Network-related netsimd / netsim / nimble_bridge must be kept:
 * They're in charge of wifi/bluetooth data access, and they can't access the net by deleting the application, which is the bottom line of "runable."
 *
 * Usage:
 *   Node build/slim-runtime.js build/runtime # security (default))
 *   Node build/slim-runtime.js build/runtime-aggressive#)
 *   node build/slim-runtime.js build/runtime --dry-run
 */
const fs = require('fs');
const path = require('path');

/**
 * Security: delete something that will not be loaded.
 * Checking single-point roll-back confirmed boundaries (important, don’t add up)):
 *   - Qt6WebEngineCoreAndroidEmu.dll is a hard reliance on emulator.exe (static import), deleting direct non-rises
 *   - lib64/gles_angle provides vk_swiftshader, swiftshader flexible rendering dependent on it reservation
 *   - lib64/vulkan deletes just to return soft rendering, but it's not big enough to save 103 MB
 */
const SAFE = [
  ['emulator/qemu/windows-x86_64/qemu-system-aarch64.exe', 'QEMU binary for arm64 (x86_64 mirrors only))'],
  // N.B. cannot delete emulator/ lib64/ volkan — vulkan-1.dll is -gpu host,
  // Deletes the host and fails directly, leaving only the software rendering (actual AMD 780M must be retained).:
  ['emulator/lib64/vulkan/layers', 'Vulkan Validation Layer (host rendering unusable, -20MB))'],
  ['emulator/lib64/vulkan/glslangValidator.exe', 'Colourer Validation Tool (not available at run time, -7MB))'],
  ['emulator/lib64/vulkan/libvulkan_lvp.dll', 'Lavapipe software Vulkan backup (not available when system visible cards drive, -53MB))'],
  ['emulator/lib64/vulkan/lvp_icd.json', 'ICD description for lavapipe (1KB))'],
  ['emulator/lib64/vulkan/vk_swiftshader.dll', 'Swift Shader Vulkan (gles_angle directory with the same copy, -23MB))'],
  ['emulator/lib64/qt/translations', 'Multilingual package for emulator interface (38px titlebar only))'],
  // Note: not delete emular-check.exe — emulator-accel-check using it to detect AEHD/WHPX,
  // The absence will determine the return of the "hardware acceleration" to the TPG software simulation (the live detector turns from 42s to 10 minutes plus).
  ['emulator/qsn.exe', 'QEMU snapshot alert assistant (emularor.exe without any quotes, has strings empirical evidence, -34MB))'],
  ['emulator/resources/Toren1BD_Main.png', 'VR Panorama (unused by red nuts) - 3.7MB)'],
  ['emulator/resources/Toren1BD_Decor.png', 'VR Panorama Decoration Post (-3.5MB))'],
  ['emulator/resources/Toren1BD.obj', 'VR Panorama 3D model (-3.5MB))'],
  ['emulator/resources/macroPreviews', 'Macro Operation Preview (-2.7MB))'],
  ['emulator/resources/default360.mp4', '360° Panorama default video (-2.4MB))'],
];

/** WebEngine is a hard-core, gles_angle is a soft-recorded dependent, and none of it can be deleted. */
const AGGRESSIVE = [];

function sizeOf(p) {
  let s = 0;
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) s += sizeOf(path.join(p, e.name));
  } catch (_) { /* Ignore */ }
  return s;
}

function slim(root, { aggressive = false, dryRun = false, log = console.log } = {}) {
  if (!fs.existsSync(path.join(root, 'emulator', 'emulator.exe'))) {
    throw new Error(`${root} is not a running-time directory (lack emulator/ emulator.exe)`);
  }
  const list = aggressive ? SAFE.concat(AGGRESSIVE) : SAFE;
  let freed = 0;
  for (const [rel, why] of list) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    const n = sizeOf(p);
    if (!dryRun) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch (e) {
        log(`  Skip ${rel}: ${e.message}`);
        continue;
      }
    }
    freed += n;
    log(`  Delete ${rel}(${(n / 1048576).toFixed(0)} MB)— ${why}`);
  }
  log(`${dryRun ? 'Released' : ' Released'} ${(freed / 1048576).toFixed(0)} MB`);
  return freed;
}

module.exports = { slim };

if (require.main === module) {
  const root = path.resolve(process.argv[2] || path.join(__dirname, 'runtime'));
  const aggressive = process.argv.includes('--aggressive');
  const dryRun = process.argv.includes('--dry-run');
  console.log(`Slender target.: ${root}(${aggressive ? 'Radical' : 'Clear.'} Queue)`);
  slim(root, { aggressive, dryRun });
}
