# Code walkthrough

Hydra Emulator is an Electron desktop app. [`src/main.js`](../src/main.js) handles application windows, the tray, command-line dispatch, and IPC. [`src/preload.js`](../src/preload.js) exposes the renderer's API. The app interface, splash, hosted window, and generated offline manual live under [`src/ui/`](../src/ui).

## Install to launch

1. The renderer or Windows file association sends an APK to the installer.
2. The installer parses its manifest, checks the runtime, and installs the package over ADB.
3. Hydra stores the package and creates shortcuts with the app icon.
4. An app launch starts or reuses the Android runtime. The window controller presents the emulator in the configured window mode.

Read the [APK parsing walkthrough](CODE-WALKTHROUGH-PARSE.md) and [runtime walkthrough](CODE-WALKTHROUGH-RUNTIME.md) for module details.

## Diagnostics and packaging

System preflight and automatic monitoring report configuration and runtime issues. The manual router maps a diagnostic code or error text to a section in the offline [user manual](USER-MANUAL.md).

The [build scripts](../build) prepare Windows packages. The CI workflow runs the automated suite against supported Node versions. The release-asset workflow runs manually and uploads assets to a GitHub release that already exists.
