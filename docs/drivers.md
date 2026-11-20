# Drivers (compatibility patches)

> Since Hydra Emulator 0.5.7, "drivers" are supported as an extension: a driver = one JSON file that declares
> **which machines it matches** + **which boot parameters it changes when it matches**.
> Users can write a patch for "this machine of mine" themselves, without waiting for a Hydra Emulator release.

---

## 1. What problem it solves

One set of default parameters cannot possibly work on every machine:

- Older integrated GPUs only support GLES up to 3.1, and with `-gpu host` the guest crashes a dozen or so seconds after booting;
- A machine without "Hypervisor Platform" enabled will always fail on hardware acceleration and needs to go straight to software emulation;
- A particular GPU driver version blacks out as soon as Vulkan is enabled, and switching to `swangle` fixes it;
- Certain screen ratio / DPI combinations need `hw.lcd.density` changed to stop looking blurry.

These differences are **machine properties**, not program bugs. Putting the decisions in code means shipping a release every time; making them data files means a user (or the community) can discover a working combination, write a JSON file, and share it with others.

## 2. Where they live

| Directory | Purpose |
|---|---|
| Settings → Drivers → **Open driver directory** | Your own drivers, `%APPDATA%\hydra\drivers\*.json` (Store version: `%USERPROFILE%\Hydra Emulator\data\drivers`) |
| Install directory `resources/app/src/drivers/` | Built-in examples, read-only, `enabled: false` by default |

For the same `id`, **the user directory overrides the built-in one**: to change an official example, export/copy it to the user directory and edit it there; the install directory is left untouched.

## 3. What a driver looks like

```json
{
  "format": "hydra-driver/1",
  "id": "amd-igpu-swangle",
  "name": "AMD integrated GPU: switch to swangle rendering",
  "version": "1.0.0",
  "author": "Your name",
  "description": "Explain why this machine needs this change, so others can understand it at a glance",
  "priority": 0,
  "match": {
    "platform": ["win32"],
    "gpuVendor": ["amd"],
    "totalMB": { "min": 8192 },
    "accel": ["whpx"]
  },
  "effect": {
    "gpuMode": "swangle",
    "forceTcg": false,
    "emulatorArgs": ["-feature=Vulkan"],
    "configIni": { "hw.gpu.mode": "swangle" },
    "env": { "ANDROID_EMUGL_VERBOSE": "1" },
    "notes": ["If it still blacks out, change gpuMode to software"]
  }
}
```

### 3.1 Top-level fields

| Field | Required | Description |
|---|---|---|
| `format` | ✅ | Fixed as `hydra-driver/1` |
| `id` | ✅ | Alphanumerics and `. _ -`, 3~64 characters; used as the filename when importing |
| `name` | ✅ | Name shown in the UI (≤80 characters) |
| `version` | ✅ | Of the form `1.0.0`; remember to bump it when you change the patch |
| `author` / `description` / `homepage` | | For human readers, so others can judge whether it applies to them |
| `enabled` | | Default on/off inside the file; built-in examples are all `false`. The UI toggle takes priority over it |
| `priority` | | `-100~100`, default 0. **Higher values are applied later** (overriding earlier ones) |
| `match` | ✅ | Match conditions, see 3.2 |
| `effect` | ✅ | What to change on a match, see 3.3 |

### 3.2 `match`: should this machine use it

All conditions must be satisfied (AND); writing no condition at all means "matches nothing" — for "all machines", write `{"any": true}`.

| Key | Values | Description |
|---|---|---|
| `any` | `true` | Matches every machine (good for a baseline fallback) |
| `platform` | `win32` / `linux` | |
| `arch` | `x64` / `arm64` | |
| `gpuVendor` | `nvidia` / `amd` / `intel` / `unknown` | Coarse classification by GPU name; arrays allowed |
| `gpuName` | Regex string (≤200 characters) | For example `"radeon\\s+780m"`, case-insensitive |
| `cpuVendor` | String or array | Matches the CPU model text |
| `accel` | `whpx` / `aehd` / `none` | Current hardware acceleration state; `none` = software emulation only |
| `osBuild` | Number or `{min,max}` | Windows internal build number, for example 22631 |
| `totalMB` | `{min,max}` | Physical memory (MB) |
| `cores` | `{min,max}` | Logical core count |
| `emulatorVersion` | `{min,max}` | Compared numerically, `36.4.9 < 36.4.10` |

In the settings page every driver shows "Matched: gpu=amd / accel=whpx" or "Does not match this machine", so you never have to guess why it is not taking effect.

### 3.3 `effect`: what to change on a match

| Field | Description |
|---|---|
| `gpuMode` | Fixed render backend: `auto` / `host` / `swangle` / `swiftshader` / `swiftshader_indirect` / `software`. `auto` = do not intervene |
| `forceTcg` | `true` = turn off hardware acceleration and use software emulation (equivalent to `-accel off`) |
| `emulatorArgs` | Extra arguments passed to the emulator, in `-flag=value` form; only the whitelist is allowed |
| `configIni` | Overrides the AVD's `config.ini`; only whitelisted keys are allowed |
| `env` | Extra environment variables; only the `ANDROID_` / `QEMU_` / `LIBGL_` / `MESA_` / `EMUGL_` prefixes are allowed |
| `notes` | Explanatory text, shown in the boot log and the settings page |

`gpuMode` and `forceTcg` apply to **every** launch attempt (including automatic fallback retries): if the driver says "this machine can only use swangle", there is no point trying a backend that has already crashed first.

## 4. Whitelist: what can be changed, and why

Driver files can be downloaded from the internet and passed around, so Hydra Emulator restricts their power tightly:

**No code may be executed.** Drivers are pure JSON: no script hooks, no `eval`, no `require` of files you write.

**`emulatorArgs` only accepts**

| Argument | Allowed values |
|---|---|
| `-gpu` | Known render backends (see the table above) |
| `-accel` | `auto` / `off` / `on` / `whpx` / `hax` / `haxm` / `aehd` / `tcg` |
| `-feature` | Alphanumerics and `_,.-`, ≤160 characters |
| `-gltransport` | `pipe` / `asgpu` / `virtio` |
| `-qemu` | A single qemu argument, restricted character set, ≤120 characters |
| Flag-style | `-no-audio` `-no-boot-anim` `-no-metrics` `-no-snapshot` `-no-snapshot-load` `-no-snapshot-save` |

Explicitly rejected: `-wipe-data` (wipes apps and save data), `-partition-size`, `-datadir`, `-sysdir`, `-avd`, `-port`, `-http-proxy`. These either destroy data or break the locations Hydra Emulator manages itself.

**`configIni` only accepts**: `hw.gpu.mode`, `hw.gpu.enabled`, `hw.gltransport`, `hw.keyboard`, `hw.audioInput`, `hw.audioOutput`, `hw.camera.back`, `hw.camera.front`, `hw.gps`, `vm.heapSize`, `hw.lcd.density`.
`disk.dataPartition.size`, `hw.ramSize`, `hw.cpu.ncore`, `image.sysdir.*` are always rejected — Hydra Emulator writes these from settings itself, and changing them at the same time only creates conflicts.

**`env`**: `ANDROID_*`, `QEMU_*`, `LIBGL_*`, `MESA_*`, `EMUGL_*`; values ≤200 characters and must not contain newlines.
Entries such as `PATH`, `SystemRoot`, and `NODE_OPTIONS` are rejected outright.

## 5. How to make your own driver

1. Settings → Drivers → **Export local template** (`match` is already filled in for the current machine, and it is saved to the driver directory);
2. Open it in Notepad / VS Code and edit `effect`:
   - Black screen / artifacts → try `"gpuMode": "swangle"` first; if that fails, change it to `"software"`;
   - Machine without hardware acceleration → `"forceTcg": true`;
   - Save when done;
3. Back on the settings page click **Refresh** and check that it shows "Matches this machine / Active";
4. Open an app once to verify, then shut down and start again to confirm stability;
5. To share: send the JSON to someone and they can use "Import driver…".

A bad file cannot break boot: files that fail validation only appear in the error list on the settings page, and drivers that do not match have no effect at all.

## 6. Troubleshooting

- The boot log (Settings → Diagnostics / `%APPDATA%\hydra\logs\emulator.log`) records:
  `drivers: amd-igpu-swangle@1.0.0`, along with the `-gpu` / `-accel` actually used on each attempt;
- The settings page explains "matched / not matched / disabled" for each driver, and which conditions matched;
- File load failures (JSON syntax error, wrong field, over 256KB) list the specific file and reason;
- To temporarily exclude a driver: just turn off its toggle in the UI (written to settings, the file is not deleted).

## 7. Built-in examples

Three examples under `src/drivers/`, **disabled** by default:

| File | Scenario |
|---|---|
| `example-amd-igpu-swangle.json` | AMD integrated GPU + old driver, crashes after starting with `-gpu host` |
| `example-no-hypervisor-tcg.json` | No hardware acceleration, go straight to software emulation |
| `example-intel-igpu-software.json` | Old Intel integrated GPU fails GLES initialization |

They double as documentation: edit `match` along these lines to turn one into a patch that "only applies to this machine of mine".
