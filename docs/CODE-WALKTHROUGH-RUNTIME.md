# Runtime code walkthrough

## Provisioning and activation

[`src/core/provision.js`](../src/core/provision.js) locates a bundled runtime or prepares one under the selected data directory. It reads official Android SDK indexes, resolves package URLs, checks available space, and extracts the emulator and system image. A light portable build can download the runtime archive from a Hydra release. If the archive is unavailable, setup can download individual Android components.

[`src/core/engine.js`](../src/core/engine.js) coordinates the runtime lifecycle and coalesces concurrent boot requests. [`src/core/emulator.js`](../src/core/emulator.js) builds emulator parameters, manages AVD data and snapshots, monitors startup, and retries compatible render or acceleration modes. [`src/core/doctor.js`](../src/core/doctor.js) selects hardware profiles and interprets startup failures.

## Updates and downloads

[`src/core/sources.js`](../src/core/sources.js) reads Hydra release metadata from GitHub, builds asset candidates, and measures available download paths. Third-party mirrors are opt-in. [`src/core/download.js`](../src/core/download.js) streams downloads to disk and handles resumption, validation, and range downloads.

[`src/core/updater.js`](../src/core/updater.js) selects a suitable release asset for the current build. [`src/core/incremental.js`](../src/core/incremental.js) validates the update manifest and checks file hashes. An incremental update requires a matching Electron version. If the requirements fail, Hydra can use the full portable package where available.

## Host integration

[`src/core/store.js`](../src/core/store.js) keeps application metadata and settings in the Hydra data directory. [`src/core/leftovers.js`](../src/core/leftovers.js) identifies cleanup candidates and protects active runtime data. [`src/core/sharer.js`](../src/core/sharer.js) synchronizes the shared directory. [`src/core/notify.js`](../src/core/notify.js) forwards supported Android notifications to the desktop.
