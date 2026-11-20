# Android Backend Option Assessment (v0.5.0 branch)

> Background: v0.4.3 used Google's native emulator plus a Qt window, which was then embedded into an Electron window.
> The embedding approach had a string of inherent problems (black borders, misaligned coordinates, failure to fill the frame, conflicting Qt panel orientations).
> This document records the feasibility assessment of "switching the backend" and the approach actually shipped in v0.5.0.

## Summary

| Option | Performance | Stability | Distribution/compliance | Effort | Conclusion |
|------|------|--------|-----------|--------|------|
| **A. Existing emulator + detached window mode** | Medium | High | No issues | Small | ✅ **Shipped in v0.5.0** |
| **B. Waydroid + WSL2** | High | Medium | No issues | Large | ⚠️ Feasible, but with hard prerequisites |
| **C. Waydroid + lightweight Linux VM** | High | Medium | No issues | Large | ⚠️ Same as B, and heavier |
| **D. Tencent App Store (PC edition)** | High | High | ❌ Closed source | — | ❌ Not viable |
| **E. Microsoft WSA** | High | — | ❌ Support ended | — | ❌ Not viable |
| **F. Switch to FydeOS / PhoenixOS / Bliss OS** | High | Medium | No issues | Huge | ❌ Conflicts with product positioning |

## A. Detached window mode (shipped)

Instead of `SetParent`-ing the emulator window into our own window, we let the emulator open its own native window, and we only handle "open the app → bring that window in front of the user".

**Why this is better than continuing to fix embedding**: the problems under embedding mode (black borders, misaligned coordinates, clicks not landing where expected, failure to fill the frame) all have their root cause in "we are treating a Qt/OpenGL window as an ordinary child window". Fixing one always leads to the next. In detached window mode, rendering, input mapping, and size adaptation are all handled by the emulator itself — which is exactly where it is strong.

**Implemented**:
- The `display.windowEmbed` setting (`embed` / `detached`), selectable in the UI.
- `appwin.openDetached()`: hides the empty shell window → breaks the parent-child relationship → shows the native window → centers it according to the panel ratio.
- `agent.ps1` gains `layout` / `detach` / `perf` commands; under `_detachedMode`, cleanup does only the minimum and never hides the window the user is watching as if it were clutter.
- The size must be **given correctly in one go, in proportion to the panel**: the emulator's native window locks its own aspect ratio, and a wrong ratio gets clamped back (ask for 1280 wide and you actually get 400).

**Measured** (local machine Ryzen 7 8745HS / Win10 26300 / AEHD):
the Hongguo Free Short Drama app fills its native `Android Emulator - hydra:5554` window, with correct orientation, clicks landing correctly, and no black borders.

**Cost**: one extra taskbar icon, and the look is not fully unified with the main window.

## B / C. Waydroid route

Waydroid is an LXC container approach (not a virtual machine) that reuses the host Linux kernel to run the Android framework directly, drawing graphics straight to Wayland, so performance is markedly better than any emulator.

**Hard prerequisites** (all required):

1. **A working Linux kernel**, and the kernel must be compiled with binder / ashmem.
   - Microsoft's official WSL2 kernel **drops binder by default**; you must compile your own from `microsoft/WSL2-Linux-Kernel` with options such as `CONFIG_ANDROID_BINDER_IPC` and swap it in.
2. **A Wayland session**. Waydroid does not run on X11.
3. **A `/dev/dri/renderD*` GPU render node**, and **NVIDIA proprietary drivers are not supported**.
4. **Hyper-V / WSL2 infrastructure** (if taking the WSL2 route).

**Actual state of this machine**:

| Prerequisite | Status |
|------|------|
| `HypervisorPresent` | `False` — Hyper-V not enabled |
| WSL | Only the `wsl.exe` stub, **with no distribution installed** |
| AEHD | Running (the emulator relies on it for acceleration) |
| GPU | AMD Radeon 780M (qualifies, not NVIDIA) |
| CPU / RAM | 16 threads / 31.3 GB (ample) |

**Key conflict**: Hydra Emulator currently accelerates via **AEHD** (Android Emulator Hypervisor Driver). AEHD and Hyper-V are **mutually exclusive** — once Hyper-V is enabled, AEHD stops working. So Waydroid cannot coexist with the existing emulator backend on the same machine at the same time; it is one or the other.

**Option C (lightweight Linux VM) is heavier than B**: it means running a full Linux virtual machine on Windows (QEMU/VirtualBox/Hyper-V) and then installing Waydroid inside it — two layers of virtualization plus packaging a whole Linux distribution. Boot time, disk usage, and first-run configuration complexity would all far exceed the current "double-click an APK and it just works".

**Waydroid also lacks ARM compatibility**: in an x86 environment it can only run x86 apps; apps that only ship ARM binaries need an extra `libhoudini`/`libndk` translation layer, and performance drops after translation. Many domestic short-drama and social APKs are arm64-only, which is a serious flaw for the positioning of "the user drops in any APK".

## D. Tencent App Store (PC edition)

A closed-source commercial product with no public API; it cannot be embedded, redistributed with us, or guaranteed to remain available. **Not viable.**

## E. Microsoft WSA

Microsoft ended support in March 2025 and closed the official distribution channel; it also depends on Hyper-V, which conflicts with AEHD. Third-party repackaged versions carry compliance risk. **Not viable.**

## F. Switching operating systems (FydeOS / PhoenixOS / Bliss OS)

These are **complete operating systems**, not components for "running Android apps on Windows". Adopting them would mean asking users to reinstall their OS — in direct conflict with the positioning of "double-click an APK on Windows and it just works". In addition, PhoenixOS is essentially unmaintained. **Not a product direction.**

## Follow-up recommendations

1. **Short term**: detached window mode (A) already solves the main experience problems; polish it and watch user feedback. This is the step with the best benefit/cost ratio.
2. **Medium term**: the pluggable backend abstraction in `src/core/backends/` is already in place (`Backend` + `CAPS` capability bits). If Waydroid is to be integrated later, only a new backend implementation is needed, without touching the main flow.
3. **If Waydroid is ever truly pursued**, the only pragmatic form is: **a separate installer / separate branch**, clearly telling users "this version requires Hyper-V and cannot coexist with the emulator version", rather than imagining a seamless switch with the existing backend.
