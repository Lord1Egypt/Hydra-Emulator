<div align="center">
  <img src="docs/images/logo.png" alt="Hydra Emulator emblem" width="132">
  <h1>Hydra Emulator</h1>
  <p><strong>Android apps on your Windows desktop.</strong></p>
  <p>Install APKs, launch apps from Windows shortcuts, and share files with Android.</p>
  <p>
    <a href="docs/USER-MANUAL.md">User manual</a> ·
    <a href="https://github.com/Lord1Egypt/Hydra-Emulator/releases">Releases</a> ·
    <a href="https://github.com/Lord1Egypt/Hydra-Emulator/issues">Issues</a>
  </p>
</div>

[![Windows CI](https://github.com/Lord1Egypt/Hydra-Emulator/actions/workflows/ci.yml/badge.svg)](https://github.com/Lord1Egypt/Hydra-Emulator/actions/workflows/ci.yml)
[![Windows 10 and 11 x64](https://img.shields.io/badge/Windows-10%20%2F%2011%20x64-147a65)](#requirements)
[![MIT License](https://img.shields.io/badge/license-MIT-147a65)](LICENSE)

## What you can do

| Feature | How it works |
| --- | --- |
| **Install APKs** | Drag an APK into Hydra or enable the Windows file association to open APKs from File Explorer. Split APK bundles in `.apks` and `.xapk` format are supported. |
| **Open Android apps from Windows** | Hydra extracts app icons and creates desktop and Start menu shortcuts. Installed apps open in dedicated windows with orientation and fullscreen controls. |
| **Share files** | Sync a Windows folder with a directory in the Android guest. The defaults are `%USERPROFILE%\HydraShared` and `/sdcard/HydraShared`. |
| **Tune the runtime** | Set guest memory, CPU cores, rendering, data partition size, Android language, and Quick Boot from Settings. |
| **Diagnose startup problems** | Check virtualization and graphics, run repair actions, and open the built-in troubleshooting guide from diagnostic results. |

Hydra manages one Android runtime. The **Laboratory** settings can keep several apps resident while one app is displayed. APK compatibility depends on Android version, native libraries, and the device features the app requires.

## Requirements

- Windows 10 version 2004 or later, or Windows 11, on x64 hardware
- 8 GB of RAM recommended and enough free disk space for the runtime, guest data, and snapshots
- CPU virtualization and Windows Hypervisor Platform or an available Android Emulator Hypervisor Driver for hardware acceleration

Hydra can use software emulation when acceleration is unavailable. First boot and graphics can be significantly slower in that mode.

## First run

1. Run Hydra Emulator on Windows.
2. Open **Settings → General & Installation** and select **Auto Setup** to prepare the Android runtime. A light portable build downloads the emulator and Android 14 image on first use.
3. Drag an APK into Hydra or choose **Install APK**.
4. Open the app from its card, desktop shortcut, or Start menu entry.

Use **Settings → Updates & About → User Manual** for the offline manual. The [online version](docs/USER-MANUAL.md) covers acceleration, APK installation errors, ADB authorization, audio, and startup diagnostics.

## Build from source

Use Node.js 20 or 22 on Windows.

```powershell
git clone https://github.com/Lord1Egypt/Hydra-Emulator.git
cd Hydra-Emulator
npm ci
npm test
npm start
```

| Command | Output |
| --- | --- |
| `npm run pack` | Light Windows portable directory in `dist/`. |
| `node build/fetch-runtime.js engine` | Downloads the runtime components for full builds. |
| `npm run runtime` | Stages the local Android runtime under `build/runtime`. |
| `npm run pack:full` | Full Windows portable directory with the staged runtime. |
| `npm run build:exe` | Windows NSIS installer. |

See the [development setup](docs/DEV-ENV.md), [architecture guide](docs/ARCHITECTURE.md), and [contribution guide](CONTRIBUTING.md).

## License

Hydra Emulator's source is distributed under the [MIT License](LICENSE). Electron, Android runtime components, and other dependencies carry their respective licenses.
