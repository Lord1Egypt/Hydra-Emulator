# Runtime Engine Directory (manual placement, optional)

**Since 0.2, Hydra Emulator is fully self-contained by default**: adb, QEMU, and system images are downloaded and deployed automatically by the app into
`%APPDATA%\hydra\runtime\`, so no manual preparation is required.

This directory is only used in the following two situations:

## 1. Placing QEMU manually (download source blocked / want a specific version)

```
engine/qemu/
├─ qemu-system-x86_64.exe
├─ qemu-img.exe
└─ … (other QEMU files)
```

Official QEMU Windows builds: https://qemu.weilnetz.de/w64/
(`qemu-w64-setup-*.exe` is an NSIS installer; Hydra Emulator installs it silently into the runtime directory with `/S /D=`; you can also extract the installer with 7-Zip and place the files in the location above)

## 2. Placing adb manually

```
tools/platform-tools/
└─ adb.exe
```

Download: https://developer.android.com/tools/releases/platform-tools

## System images

- Recommended: Android-x86 9.0-r2 (x86_64), downloadable directly in the app (multiple images, resumable downloads)
- Or import: any disk image with Android already installed (qcow2 / raw / vmdk), choose it under "Runtime → Import"
- After importing, Hydra Emulator boots directly from the disk with no installation step

## Hardware acceleration

QEMU uses WHPX acceleration: Control Panel → "Turn Windows features on or off" → check "Virtual Machine Platform" → restart.
When not enabled, Hydra Emulator automatically falls back to pure software emulation (TCG), and the first boot is slow.
