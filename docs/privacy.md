# Hydra Emulator Privacy Policy

Last updated: 2026-11-16

Hydra Emulator is a locally-running Android app runner. Our principle is simple: **we do not collect, upload, or share your personal data.**

### 1. What we do not collect

- We do not collect identity information such as accounts, names, email addresses, or phone numbers (this app has no account system).
- We do not collect device identifiers, advertising IDs, or location information.
- We do not integrate any analytics, telemetry, crash-reporting, or advertising SDKs.
- We do not send any data to our servers (this app has no servers of its own).

### 2. Data stored locally

The following data is kept only on your own computer and never leaves the device:

| Location | Content |
|---|---|
| `%USERPROFILE%\Hydra Emulator\data` | Android system image, installed apps, app data, snapshots |
| `%USERPROFILE%\HydraShared` | Shared folder synced bidirectionally with `/sdcard/HydraShared` inside Android |

Uninstalling the Microsoft Store version does not automatically delete these directories; you can delete them manually at any time.

### 3. Network behaviour

- **Microsoft Store build**: all runtime components are bundled in the package; first launch only extracts locally and downloads no executable content. App updates are handled by Microsoft Store.
- **Installer / portable build**: the GitHub Releases list is contacted only when you check for updates; the lightweight build downloads the runtime package from the project's Releases on first launch. Requests contain only the version number and the standard HTTP headers required for downloading.
- Network access from Android apps is decided by those apps themselves. Traffic uses QEMU user-mode NAT over the host network; Hydra Emulator does not inspect or retain it.

### 4. Third parties

Android apps you run through Hydra Emulator are provided by their own developers, and their data handling is governed by their own privacy policies. Hydra Emulator neither controls nor represents these third-party apps.

### 5. Children

This app is not directed at children under 13, and does not intentionally collect information from children.

### 6. Changes and contact

If the policy changes, this page will be updated and the "Last updated" date revised.
For questions, open an issue at https://github.com/Lord1Egypt/Hydra-Emulator/issues
