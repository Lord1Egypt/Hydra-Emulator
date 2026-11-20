# Structure

## Layer

```
┌─────────────────────────────────────────────────────────────┐
Src/ui (HTML/CS/JS) preload (contentbridge)
├─────────────────────────────────────────────────────────────┤
Src/main.js (window/ tray/CLI distribution)
installer.js (installation of streaming)
├─────────────────────────────────────────────────────────────┤
Field layer engine.js (life cycle at operation/detection/empty recovery)
adb.js (equipment operations)
├─────────────────────────────────────────────────────────────┤
*zip.js offline *axml.js / ansc.js * apk.js *
│png.js / shortcut.js
├─────────────────────────────────────────────────────────────┤
│ Engine adapts to self-carrying QEMU (WHPX/TCG) System Image Import │ runtime (optional) │
└─────────────────────────────────────────────────────────────┘
```

## Key processes

### 1. Double-click APK installation

```
Explorer double-click.apk
  → HKCU\Software\Classes\Hydra Emulator.apk\shell\open\command
  → Hydra Emulator.exe "C:\...\xxx.apk"
  → main.js parseArgs → runInstall
      1. apk.js: Offline (zip →manifest AXML ansc restoration label/icon))
      2. engine.ensure(): automatically lift/detect when not ready at running
      3. adb install -r -g -t
      4. Icon PNG(icons/)+ Multi-Screen ICO(icons/*.ico)
      5. shell. writeShortcutLink to generate desktop. Ink (-launch) <pkg>)
      6. Store.upsertApp Recording Metadata
```

### 2. Desktop icon start-up (original experience))

```
Double click < appname>. Ink
  → Hydra Emulator.exe --launch <pkg>
  → Single instance lock merges to a running case (or silently pulls a new instance))
  → adb am start --windowingMode 5 -n <pkg>/<activity>
  → Freeform Window
  → Shell window automatically hides/ exits without redundant interfaces
```

### 3. Data interchange

```
Host %USERSPROFILE%\HydraShared  Xia Android / sdcard/HYDRASHARED
  Increment two-way sync (mtime+size), 8s Round + Key Action Trigger
```

## Why don't you use the library?

| Needs | General practice | Hydra Emulator's Practices | Rationale |
|---|---|---|---|
| Read APK metadata | aapt2 / apk-parser | Handwritten zp+AXML+ARSC | Zero volume dependency, free of SDK, start no external process |
| Icon Turn ICO | ImageMagick/sharp | NaviveImage Zoom + Handwritten ICO Container | Avoid 80MB Native Dependence |
| File association | Installer Write HKLM | HKCU + SHChangeNotify | Free admins, switch in settings at any time. |
| Simulator | Packing package VirtualBox | Engine adaptor layer | Reuse existing running zero cost;QEMU routes to maintain a controlled system image |

## Stability Design

- All adb call belt timeout and error re-entry (AdbError).
- runtime detection in parallel, 4s timed out, failed to downgrade automatically.
- QEMU Free Door Watch Dog: No front desk application and no more than the number of minutes set for recycling, which is applied to running and never recycling.
- Set/apply List Write with tmp+rename atom writing.

## Application of class container models (performance))

### Boundary with "real packaging"

Wal-Treeton/ WA/ Anbox belongs to**Packagings or Compatibility Layers**: Host kernel shared with guest,
System services are pulled up on demand, and theoretically only one App can load the services on which it depends.
Hydra Emulator's base is Google Android Emulator (QEMU System-wide Virtualization)),
Linux kernel, zygote, system_server must be guided once in a package., **Can't Load Only Some App
Systems services required”**, This cannot be bypassed by the top code.

But the sense of "heaviness" among users does not come from these resident services, but from four other things.
Dismantling them is the equivalent of "App only needs an environment at each time.":

| Real burden. | Treatment | Actual Location |
| --- | --- | --- |
| Each App is redirected to complete Androids (40~142s, CPU/ Disk Full)) | The environment only leads once and permanently; detached qemu is alive after Hydra Emulator quits, next time. `adoptExisting()` Take over + quickboot snapshots, do just a little bit `am start` + Hang up window | `engine.js` / `emulator.js` |
| The Apps, they're all backstage eating memory, pulling the network. | When opening the new App `am force-stop` Other users App; when closing the last window `am kill-all` + `deviceidle force-idle` | `container.js` / `Runtime.beginApp()` / `endApp()` |
| qemu rob CPU with Normal priority and Windows desktop | Down to startup. `BelowNormal`, The container is down when it's parked. `Idle`;vCPU 1/4 (2-3) of the physical core) | `win/priority.ps1` / `doctor.liteProfile()` |
| No App time sync, notification, window inspection still full speed | The file synchronisation and notification bridge is only open when an application window is available; window patrol is limited to 8 seconds after embed; socket main loop is changed to 50ms short rotation | `main.js` / `win/agent.ps1` |

### About "APK translator x86"

This step.**Not every time you open it.**, It's built up.:
- System mirrors like x86_64, x86 raw APK running directly;
- ARM-only's APK relies on the mirror's native image (Google Play)
  ARM →86 binary translation layer)**On installation**Achieved, the period of operation is called upon as required;
- So Hydra Emulator doesn't need to, and should not "translation" every time he starts.
  "Retranslation every time you open it" is the slowest design.

### Mouse drift / whole Caton root (repaired))

`win/agent.ps1`  Used `WH_MOUSE_LL` Global low mouse hook to achieve "side key return",
But it's being installed in the same way that it's blocked. `sock.Poll(4000)` . The window service on the line.
Every mouse event in Windows is to wait for this thread to come back, up to 4 seconds;
The window is not unmounted, and as long as Hydra Emulator is alive, it slows down the whole system.
Collapse `.xz` Expand / `e2fsck` / `resize2fs` I/ O peak,
The front desk can barely grab resources.

Repair:
- The hook no longer resides unconditionally.**Special Message Thread**(`GetMessage` ♪ On, and only ♪
  Application window is in front desk, installed at least one mouse map on; lost/off is immediately unloaded; echo only
  7 target messages, the rest (including all left-key events) once `CallNextHookEx` Direct release;
- Service master loop `Poll(4000)` → `Poll(50)`;
- `EnumWindows` + `SetWindowPos(SWP_FRAMECHANGED)` From "permanently per 2 seconds" to
  "Embed within 8 seconds, and no longer forced recalculation of non-client areas."
- First deployment delayed by 20 seconds, avoid and cold start robbery.

### Mouse button (left key confirmed / right key returned / wheel slider)

Apply the Qt sub-windows of the emulator embedded in the window with the following original map:

| Enter | Qt Native Behaviour | Treatment of Hydra Emulator |
| --- | --- | --- |
| Left | Finger click/ drag = Slide | **No intercept.**, Direct release; this is confirmation |
| Right | It's also seen as a click. It's easy to miss. | Stop! `WM_RBUTTONDOWN/UP/DBLCLK`,  Let's go. `input keyevent 4`(Back) |
| Wheel | A single touch event, a twitch. | Stop! `WM_MOUSEWHEEL/MOUSEHWHEEL`, Press 60-90ms to merge into one `input swipe` |
| Side Keys | None | Option: Map to Return/ Forward (Default level)) |

The merging of the wheels occurred `win/agent.ps1`(`PushWheel` / `FlushWheel`), Translation takes place
`core/pointer.js`(`WheelRouter` → `wheelToSwipe`)...injection. `AdbClient.input()`
It's...**Permanent Representative `adb shell`**, Use `echo __HYDRA_<id>__` Get the bag back and back.,
Not every single one of them. `execFile` An adb process, and it doesn't make a slide order long in a shell.
Coordinates map with a unicoded location within the LCD, roll to generate horizontal slides, and automatically refresh resolution after turning the screen.

Hooks are installed only when applying the front desk of the window, and cut back to the desktop or close the window to unmount; right key returns, smooth roller,
All three side buttons are off, and one whole hook is off.

### Configureable Entry (set → mouse button/ performance and light packaging))

| Item |  Default | Annotations |
| --- | --- | --- |
| `engine.mouseRightBack` | `true` | Right key = Android returns; turn off and restore the Qt 's right key is also clicked |
| `engine.mouseWheelMode` | `smooth` | `smooth` Merge In. / `native` Hand over to Qt to the grid. / `off` Do not intercept. |
| `engine.mouseSideButtons` | `false` | Side key returns / forwards; global hooks are not installed on three full-time |
| `engine.liteMode` | `true` | absorbing vCPU quotas; turning off automatically to allocate more cores according to machine configurations |
| `engine.priorityMode` | `balanced` | `performance` qemu with Normal priority |
| `engine.deepTrim` | `false` | Extra `pm disable-user` systems back-office packages; Auto-deactivating when closed `pm enable` Restore |

Deep Cut with Deliberate Intentional `gms` / `systemui` / Required components such as webview / input method
(See? `container.NEVER_TRIM`), Avoiding error with the Apple punctuation that relies on push and login.

### Life cycle of a session

```
Cold Start (only for the first time, or after AVD has been deleted))
  materializeImages → e2fsck/resize2fs → boot_completed → saveSnapshot
        ↓
Open AppA: Asure() to take over the permanent environment →am start A
            → beginApp(A): Stop other users App, raise priority, sync/nom
        ↓
Switch to App B: beginApp(B) → am start B (do not restart Android))
        ↓
Turn off the last window: → force-stop am kill-all deviceidle
            → qemu drop Idle → Sync/notice (container is parked, not switched off))
        ↓
When the door dog shuts down and runs
(The case of the takeover was previously unrecoverable due to the absence of a local proc handle.)
```
