# Hydra Emulator User Manual

> Hydra Emulator v0.6.3 · Windows 10 and 11 (x64)

Hydra Emulator installs Android apps from APK files and opens them from Windows shortcuts. This manual covers initial setup, everyday use, and troubleshooting.

## 1. Getting started

1. Start Hydra Emulator on Windows.
2. Open **Settings → General & Installation** and run the automatic runtime setup.
3. Drag an APK into Hydra Emulator or use **Install APK**.
4. Launch the installed app from its card or its desktop or Start menu shortcut.

Each shortcut uses the icon extracted from its APK. Hydra starts the Android runtime on demand and restores a compatible Quick Boot snapshot if one is available.

## 2. Installation and first launch

| Build | Runtime |
|---|---|
| Light portable ZIP | Downloads the runtime and Android 14 image during initial setup. |
| Full portable ZIP | Includes the runtime and system image. Extract the archive before launching. |
| Windows installer | Installs the full runtime and adds a Windows uninstall entry. |
| MSIX | Packages the runtime and uses the configured Store or deployment channel for updates. |

See the [GitHub releases page](https://github.com/Lord1Egypt/Hydra-Emulator/releases) for published builds. On the first launch, Hydra Emulator may need to download the runtime, expand the Android system image, initialize the guest data partition, and boot the guest. Subsequent launches can reuse that setup.

## 3. Everyday use

### 3.1 Install and remove apps

Use the main window, drag an APK onto it, or pass its path on the command line. Enable the **.apk** file association under **Settings → Integration & Files** if you want to install the file directly from File Explorer. Hydra also supports split APK bundles in `.apks` and `.xapk` format.

Right-click an app card for actions such as creating a shortcut and uninstalling the app. When several apps share the runtime, launching another app with the same orientation can reuse the running guest.

### 3.2 App windows and shortcuts

| Shortcut | Action |
|---|---|
| `F11` | Switch between fullscreen and windowed mode. |
| `Ctrl+Alt+R` | Rotate the active app. |
| `Ctrl+R` | Rotate the app when it is hosted in a Hydra shell window. |

The title bar can also rotate the app. Hydra remembers the orientation for that app. An orientation change can require a runtime restart when the virtual display needs to change shape. Use **Settings → Display & Window** to set orientation, automatic fullscreen, tablet layout, and window mode.

### 3.3 Share files with Android

Open **Settings → Integration & Files** to choose the Windows and Android shared folders, run synchronization, or open the Windows folder. The defaults are `%USERPROFILE%\HydraShared` and `/sdcard/HydraShared`. Changes to either folder are copied during synchronization.

### 3.6 Settings navigation

The search field matches labels and descriptions across categories.

| Category | What you can change |
|---|---|
| General & Installation | Runtime setup, launch at login, storage, and guest reset. |
| Display & Window | Window mode, orientation, fullscreen, and tablet layout. |
| Controls & Input | Mouse controls and key mapping. |
| Performance & Resources | CPU, memory, rendering, storage, guest language, audio, and Quick Boot. |
| Network & Downloads | Release asset mirrors and the number of download connections. |
| Diagnostics & Fixes | System preflight, hardware profiles, monitoring, repairs, and diagnostic reports. |
| Integration & Files | Windows shortcuts, APK association, shared folders, and data locations. |
| Updates & About | Update status, app version, source links, and the user manual. |
| Laboratory | Experimental background app retention. Several apps can stay resident, with one guest app visible at a time. |

### 3.7 Updates

Open **Settings → Updates & About → Check for Updates**. Portable builds can use a small application update when the Electron version matches and the files pass verification. Otherwise Hydra falls back to a full portable download when one is available. The update leaves Android data and snapshots in their data directory. Store installations follow their Store update channel.

## 4. How the runtime works

### 4.1 Android image and app data

Hydra's built-in runtime uses the Android 14 Google Play x86-64 system image. The image contains Android itself. Installed packages, user data, and Quick Boot snapshots reside in the virtual device directory. A damaged image or an incompatible data partition can prevent startup.

### 4.2 Hardware acceleration

**Windows Hypervisor Platform (WHPX)** uses Windows virtualization features. **Android Emulator Hypervisor Driver (AEHD)** is an alternative when the host supports it. Hydra can fall back to software emulation, which can take several minutes to boot and may render more slowly.

### 4.3 ARM translation

The Android x86-64 image uses an ARM translation layer for compatible apps that ship ARM native libraries. Native-library dependencies, unsupported instructions, and device requirements can still prevent some apps from running.

## 5. Diagnostics and repairs

### 5.1 System preflight

Open **Settings → Diagnostics & Fixes → Run Diagnostic Preflight**. The report checks CPU virtualization, the Windows hypervisor, the GPU and driver, physical memory, and Windows support. Choose **Apply Recommended Settings** to save the suggested hardware profile.

If virtualization is disabled in firmware, enable **Intel VT-x** or **AMD SVM** in BIOS or UEFI and rerun the checks after rebooting.

### 5.2 Automatic diagnostics and networking

Enable **Automatic Monitoring** in **Diagnostics & Fixes** to check for stalled boots, stale locks, orphan processes, snapshots, ADB connectivity, storage, settings conflicts, and guest network failures. An issue can offer a repair such as restarting the runtime, clearing stale locks, or resetting guest networking. The issue list refreshes after a repair.

If only network-dependent Android apps fail, check the guest network diagnosis. If runtime downloads fail, also check Windows connectivity and **Settings → Network & Downloads**.

### 5.3 Export a diagnostic report

Use **Settings → Diagnostics & Fixes → Export Diagnostics Report**. The report includes startup settings, diagnostic results, and recent log entries. Review it for private paths and app information before attaching it to an issue.

### 5.4 User manual and automatic troubleshooting

Open the manual from the main window or **Settings → Updates & About**. Use the contents or search to find a section, and use **Print / Save as PDF** for a copy. A diagnostic item's help button opens the relevant section. Hydra can also open a matching section automatically when an install or fix fails.

## 6. Troubleshooting

### 6.1 Hardware acceleration unavailable

Use **Diagnostics & Fixes** to check BIOS virtualization and run the acceleration repair. Enable **Windows Hypervisor Platform** in **Turn Windows features on or off**, then restart Windows. The Windows feature name is `HypervisorPlatform`. If WHPX is unavailable and Hydra offers AEHD, follow the installer prompt.

For MSIX installs, use the Windows features dialog opened from Hydra to make the change. If firmware virtualization is off, switch it on first.

### 6.2 APK installation errors

| Error | What to check |
|---|---|
| `INSTALL_FAILED_NO_MATCHING_ABIS` | The app's native libraries require a compatible image. See **ARM apps fail or crash**. |
| `INSTALL_FAILED_OLDER_SDK` | The APK requires a newer Android version. |
| `INSTALL_PARSE_FAILED_NO_CERTIFICATES` or `INSTALL_FAILED_INVALID_APK` | Obtain a complete, correctly signed APK. |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | The existing installation has a different signing certificate. Use a matching build or uninstall the conflicting app first. |
| `INSTALL_FAILED_VERSION_DOWNGRADE` | Android already has a newer version. Install a newer APK or uninstall the current version first. |
| `INSTALL_FAILED_INSUFFICIENT_STORAGE` | Check host disk space and increase the Android data partition if needed. |
| `INSTALL_FAILED_INVALID_URI` | Try a short local path such as `C:\APK\app.apk`. |
| `INSTALL_FAILED_DEPRECATED_SDK_VERSION` or `INSTALL_FAILED_TEST_ONLY` | Hydra may retry with the relevant Android installer option. |
| `INSTALL_FAILED_MISSING_SHARED_LIBRARY` | The APK needs a system or vendor library the image does not provide. |
| `INSTALL_FAILED_CONFLICTING_PROVIDER` | Check for another installed package that declares the same content provider. |
| `INSTALL_FAILED_USER_RESTRICTION` or `INSTALL_FAILED_INTERNAL_ERROR` | Restart the runtime, wait for Android to finish booting, and try again. |

### 6.3 ARM apps fail or crash

Look for `NO_MATCHING_ABIS`, `DoBadTrampoline`, `libndk_translation`, or `UnsatisfiedLinkError` in the error or runtime log. Hydra can retry after preparing the compatible image and restarting the runtime. Check runtime setup if the system image is missing. If the retry fails or the app still crashes, export a diagnostic report with the APK architecture and error details.

### 6.4 ADB authorization

If `adb devices` shows `unauthorized`, find the Android window and accept **Allow USB debugging?**. Select **Always allow from this computer** to remember the authorization. If the prompt is inaccessible, restart the runtime from diagnostics. Resetting the Android data partition is a last resort because it clears guest app data.

Hydra uses a dedicated ADB server on port `5044`. From PowerShell, point your ADB client at that server.

```powershell
$env:ANDROID_ADB_SERVER_PORT = '5044'
adb devices
```

Keep the existing host ADB key. Replacing it can leave the guest trusting the previous key.

### 6.5 App shortcut or window fails to open

1. Confirm the shortcut points to the current Hydra executable. Rebuild shortcuts from **Settings → Integration & Files** if Hydra moved.
2. Give a cold boot time to complete. A restart to change orientation can take longer than opening a second app in a running guest.
3. If a window with only the Hydra controls appears, look for `attach failed` or `emu:0` in the report. Those errors point to a window attachment problem.
4. Export a report before resetting Android data. Use the reset only when needed to recover an unusable guest data partition. It clears installed app data.

### 6.6 Other startup problems

| Symptom | Action |
|---|---|
| Memory allocation failure | Close memory-heavy Windows applications or lower the guest memory and CPU settings. |
| Emulator port in use | Close other instances of the emulator if automatic port selection fails. |
| AVD is locked | Use the diagnostic repair after confirming the virtual device is not running elsewhere. |
| Snapshot fails to load | Use the diagnostic action to discard the snapshot and cold-boot the guest. |
| System image is missing or damaged | Prepare the runtime again from **General & Installation**. |
| Disk is full | Free disk space or move the runtime data directory. |
| Graphics initialization fails | Run system preflight, update the host GPU driver, or choose a safer renderer. |
| A path fails to resolve | Try a short local installation or APK path. |

### 6.7 No sound or low volume

1. Check Windows output selection and the per-app volume mixer, then check the media volume inside Android.
2. Enable **Settings → Performance & Resources → Audio Emulation** and restart the runtime. Audio is selected when the guest starts.
3. In `services.msc`, confirm **Windows Audio** is running. Hydra also reports a stopped audio service under **Diagnostics & Fixes**.
4. If you changed headphones or Bluetooth devices while Android was running, restart the guest to pick up the new output.

### 6.8 Store build startup error 0xC0000135

Windows error `0xC0000135` (decimal `3221225781`) means a DLL failed to load. The cause may be MSIX path restrictions, a missing VC++ runtime, or a missing or quarantined runtime file.

1. Run the system preflight. If it finds a missing VC++ runtime, use the offered repair.
2. Check the Windows Application event log for `FaultingModuleName`, and review security software history for any affected runtime file.
3. Restart Hydra from the tray. If the error only occurs with an MSIX install, try a portable build from a local folder.
4. Attach the event details and Hydra diagnostic report when filing an issue.

## 7. Command line

```powershell
& ".\Hydra Emulator.exe"
& ".\Hydra Emulator.exe" "C:\Downloads\app.apk"
& ".\Hydra Emulator.exe" --launch com.example.app
```

## 8. Data and directories

| Data | Default location |
|---|---|
| Settings and app list | `settings.json` and `apps.json` in the Hydra data folder. |
| Runtime components | `runtime` in the Hydra data folder, or `resources\runtime` for a bundled build. |
| System images and guest data | `system-images` and `avd` beneath the runtime root. |
| Logs | `logs\app.log` in the Hydra data folder. |
| Shared files | `%USERPROFILE%\HydraShared` and Android's `/sdcard/HydraShared`. |

Use **Settings → Integration & Files** to find the active runtime and Android data folders. Custom data locations and MSIX installations use different paths. Back up your guest app data before using **Reset Android Data**.

## 9. Get help

Include the version, build type, steps to reproduce, and diagnostic report when you open a [GitHub issue](https://github.com/Lord1Egypt/Hydra-Emulator/issues).
