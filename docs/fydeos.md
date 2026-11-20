# Hydra Emulator's FydeOS backend (also usable on Windows)

> In one sentence: **use FydeOS's built-in Android environment instead of Google's emulator**.
> FydeOS can be installed on the machine itself, or run inside VMware / VirtualBox and connected to from Hydra Emulator on Windows.

---

## ⚠️ Read this first: the real risks of the FydeOS route

I verified the feasibility of this route, and the conclusion is not optimistic — **you should know this before deciding whether to invest in it**:

1. **The official VMware image is a preview**. The download page says verbatim that it is designed "for users to
   **test and preview** FydeOS in a virtualized environment" ([FydeOS for VMware](https://fydeos.com/download/vm/x86_64/)).
2. **The Android subsystem in the VMware version often does not work**. The FydeOS community states plainly that
   "the VMware version is provided for preview only and full functionality is not currently guaranteed"; users have reported that
   Android apps cannot reach the network, and that `adb` connects but the screen stays black.
   ([community discussion](https://community.fydeos.com/t/topic/47865))
3. **Some say the older version (v18) works while newer ones are broken.** That is, this route depends on a specific version and
   could well stop working at any time.

**Conclusion**: I built the FydeOS backend and it works, but **it should not be treated as the primary option**.
If all you want is "lighter than Google's emulator, and the window problems gone" —
the networking fix in v0.5.0 plus **detached window mode** already deliver that, with no backend switch needed.

---

## Two ways to use it

### Usage A: Hydra Emulator and FydeOS on the same machine (FydeOS installed natively)

Prerequisite: you are running the FydeOS system itself (not Windows).

1. FydeOS app launcher → open "Android Settings"
2. System → Developer options → turn on **ADB debugging**
   (Cannot find Developer options: Android Settings → About device → tap "Build number" 7 times)
3. FydeOS Settings → Linux → enable the Linux subsystem
4. In the Linux terminal: `sudo apt update && sudo apt install -y adb`
5. Hydra Emulator → Settings → Runtime → set the engine mode to **FydeOS Android subsystem** and leave the address **blank**
   (it automatically tries `arc:5555`, `100.115.92.2:5555`, then `127.0.0.1:5555` in order)

### Usage B: Hydra Emulator on Windows, FydeOS in a virtual machine

This is the shape you want. Full steps:

#### 1. Install a virtual machine program

- **VMware Workstation Player** (free) — the official FydeOS VM image is an `.ova`, just import it
- **VirtualBox** — also works, but after importing the `.ova` you may need to adjust UEFI manually

> Note: **do not use Hyper-V**. Hydra Emulator's bundled runtime accelerates via AEHD, and AEHD and Hyper-V are mutually exclusive;
> with Hyper-V enabled the bundled runtime will not work. VMware / VirtualBox do not have this problem.

#### 2. Import the FydeOS image

Get the `.ova` from the [FydeOS for VMware download page](https://fydeos.com/download/vm/x86_64/)
(about 1.5GB+), then in VMware use "Open a virtual machine" → select that `.ova`.
If it reports "failed OVF specification conformance", click **Retry** as prompted to relax the check; the import still works fine.

Give the virtual machine **4GB or more of memory** (the Android subsystem is memory-hungry).

#### 3. Enable ADB debugging inside FydeOS

1. Boot the virtual machine and complete FydeOS setup (sign-in / local account)
2. Open Android Settings and enable the Android subsystem
3. Android Settings → System → Developer options → turn on **ADB debugging**

#### 4. Let Windows reach that virtual machine

Two routes; pick one:

**Route 1 (recommended, least hassle): NAT port forwarding**

VMware: virtual machine settings → Network adapter → choose NAT → "NAT Settings" → Port forwarding → Add:

| Host port | Type | Virtual machine IP | Virtual machine port |
|---|---|---|---|
| 5555 | TCP | (leave blank or 192.168.x.x) | 5555 |

VirtualBox: Settings → Network → Advanced → Port forwarding → add an entry `127.0.0.1:5555 → 10.0.2.15:5555`

Then in Hydra Emulator enter the address: `127.0.0.1:5555`

**Route 2: use the virtual machine IP directly**

Change the virtual machine network to "Bridged", then inside FydeOS run `crosh` (Ctrl+Alt+T) → `shell` → `ip addr` to see the IP,
and in Hydra Emulator enter `<that IP>:5555`.

#### 5. Configure Hydra Emulator

1. Settings → Runtime → set the engine mode to **FydeOS Android subsystem**
2. Enter the address from the previous step (for example `127.0.0.1:5555`)
3. Click Detect

**On the first connection, FydeOS shows an "Allow debugging?" authorization dialog — you must click "Allow"**,
otherwise the APK cannot be installed.

---

## How it differs from the bundled runtime

| | Bundled runtime (QEMU) | FydeOS backend |
|---|---|---|
| Where Android comes from | Hydra Emulator downloads the image itself and boots it itself | Provided by the FydeOS system, already running |
| Startup after shutdown | Requires boot (about 18 seconds in v0.5.0) | Nearly instant (the virtual machine is already running) |
| Extra memory | About 3GB | Depends on the virtual machine allocation |
| Image footprint | Several GB | None (FydeOS's own disk) |
| Window embedding | ✅ Can be embedded into the Hydra Emulator window | ❌ The screen is drawn by FydeOS itself |
| One window per app | ✅ | ❌ All apps share the FydeOS desktop |
| Stability | High (verified empirically) | **Depends on the FydeOS version; see the warning at the top** |

**About "one window per app"**: this is the most valuable part of the Hydra Emulator experience, and the FydeOS backend cannot provide it.
The reason is that the Android screen lives inside the FydeOS desktop (or inside that virtual machine's window), not in an individual
Android app window, so there is no HWND to `SetParent`.

So under the FydeOS backend, Hydra Emulator's role becomes: **app list + package installation + launching + icon/shortcut management**,
with the screen drawn by FydeOS itself.

---

## FAQ

### It says "Please enter the FydeOS address first"

There is no "local Android" on Windows, so Hydra Emulator has no way to guess where that virtual machine is. Set up port forwarding as in step 4 above, or enter the IP.

### It stays unauthorized and no authorization dialog appears

A known issue in some FydeOS X versions (the host and the Linux subsystem have mismatched adb keys). Synchronize the keys by hand:

```bash
# 1. In FydeOS's Linux terminal
adb start-server
cat ~/.android/adbkey.pub      # copy the contents

# 2. Crosh (Ctrl+Alt+T) → shell to enter the host system
sudo mount -o remount,rw /
sudo mkdir -p /opt/google/containers/android/rootfs/android-data/data/misc/adb
sudo tee /opt/google/containers/android/rootfs/android-data/data/misc/adb/adb_keys <<'EOF'
<paste the contents of adbkey.pub here>
EOF
sudo chown 1000:1000 /opt/google/containers/android/rootfs/android-data/data/misc/adb/adb_keys
sudo mount -o remount,ro /
```

Then restart the Android subsystem and connect again.

### It connects, but an installed app will not open

If it is `INSTALL_FAILED_NO_MATCHING_ABIS`, the APK only has an arm64 build while FydeOS
runs on x86. FydeOS has a built-in ARM compatibility layer, but its coverage is incomplete — such apps are more likely to work on the bundled runtime
(which includes Google's ARM translation).

### The app UI is a black screen

This is a long-standing problem with the FydeOS VMware version (see the warning at the top). First check whether FydeOS's own Android apps open correctly;
if even the system's own apps are black, the problem is not Hydra Emulator — switch to another FydeOS version (some report v18 works) or use the bundled runtime instead.

---

## Technical details (for maintainers)

- The backend is implemented in `src/core/backends/fydeos.js`
- The capability bits are deliberately declared very conservatively: no `provision` (no image installation), no `snapshot` (no snapshots of its own),
  no `rotatePanel` (the panel is managed by the system). Only `shutdown`, and even that merely disconnects the adb connection;
  it never actually shuts down Android inside the system, which would affect the user's other apps.
- `embedCapable = false`. When the layer above (`attachAppWindow` in `main.js`) sees this flag, it skips
  screen takeover, so there is no pointless `SetParent` attempt that fails and then spews out a pile of `attach failed`.
- On Windows it uses Hydra Emulator's bundled adb (`runtime/platform-tools/adb.exe`),
  so users do not need to install platform-tools themselves.
