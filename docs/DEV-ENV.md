# Development environment

Hydra Emulator targets Windows 10 and 11 on x64. Use Node.js 20 or 22 and Git. A real emulator boot also needs the Android runtime components and enough disk space for the system image and virtual device.

## Run from the checkout

```powershell
npm ci
npm test
npm start
```

The standard suite exercises the JavaScript core without booting Android. Run `npm run test:ui` to exercise Settings navigation and search in Electron. Run `npm run test:boot` separately on a Windows host with an installed runtime.

## Runtime and packages

```powershell
node build/fetch-runtime.js engine
npm run runtime
npm run pack:full
```

The fetch script populates `engine/`. The staging script copies the runtime layout to `build/runtime/` and prepares compressed images for packaging. `npm run pack` produces the light portable build without bundling runtime binaries. `npm run build:exe` creates the Windows installer in `dist/release/`.

Rebuild the app icons with `npm run icons` and the offline manual with `npm run build:manual`. Edit [the Markdown manual](USER-MANUAL.md) before regenerating its HTML.

To isolate runtime state during development, set `APPDATA` to a temporary directory for that PowerShell session before launching. See the [architecture guide](ARCHITECTURE.md) for the runtime, renderer, and Windows integration.
