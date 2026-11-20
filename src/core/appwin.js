'use strict';
/**
 * Apply window: A running Android application = a clean Windows window.
 *
 * Only 38px titlebar in the window (rotation/ minimization/ maximization/ closing)),
 * The whole image below is embedded in the simulator window (SetParent), so you can't see the Android desktop.,
 * The side toolbar that the emulator has on its own is not visible, nor is there an extra icon for the second taskbar.
 */
const { BrowserWindow, screen, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { hookOptions } = require('./pointer');
const store = require('./store');
const { physicalRect } = require('./geometry');

const TITLEBAR_H = 38;
/**
 * Grey interior margin with 8px around the emulator window (Qt border white)),
 * The real LCD image starts with +8px. Zoom the subwindow in 16px and move it to the top left by 8px,
 * This ring of ash is pushed outside the client area, with a clean picture all over the place.
 */
const EMU_PAD = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function iconUrl(p) {
  if (!p || !fs.existsSync(p)) return '';
  return `file:///${p.replace(/\\/g, '/').replace(/ /g, '%20')}?v=${fs.statSync(p).mtimeMs}`;
}

class AppWindow {
  constructor({ agent, setOrientation, mouseHook = false, pointerConfig = null, windowTargets = null }) {
    this.agent = agent;
    this.setOrientation = setOrientation || null;
    // The candidate source for the screen window: there’s only one base, constant null,
    // The window agents search for the process field.
    this.windowTargets = typeof windowTargets === 'function' ? windowTargets : null;
    // The global mouse hook is installed only when "Application window front desk + at least one map open".
    // PointerConfig function: The settings page has changed the switch, the next Focus will be effective without restarting.
    this.mouseHook = mouseHook;
    this.pointerConfig = pointerConfig;
    this.win = null;
    this.pkg = null;
    this.state = { label: '', tip: '', ready: false, landscape: false };
    this._fitTimer = null;
    this._closedCb = null;
  }

  get isOpen() { return !!(this.win && !this.win.isDestroyed()); }

  /** Target size of window contents under screen/ screen (self zoom to screen)) */
  static sizeFor(area, portrait, landscape) {
    const p = portrait || { w: 540, h: 960 };
    // Left margin: Titlebar 38 + 24 each up and down, 40 each around
    const availH = Math.max(360, (area.h || 1040) - TITLEBAR_H - 48);
    const availW = Math.max(300, (area.w || 1920) - 80);
    const k = landscape
      ? Math.min(availW / p.h, availH / p.w)
      : Math.min(availH / p.h, availW / p.w);
    const w = Math.round((landscape ? p.h : p.w) * k);
    const h = Math.round((landscape ? p.w : p.h) * k);
    // Double-insured: never exceed the screen area available, otherwise it will be cut off by the system, which looks like "black edges / not filled."
    return {
      w: Math.max(320, Math.min(w, Math.round(availW))),
      h: Math.max(360, Math.min(h, Math.round(availH))),
    };
  }

  _area() {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const a = d.workArea || d.bounds;
    // WorkArea is DIP. Window proxy process is per-monitor DPI-aware,
    // SetWindowPos collects physical pixels, so stand-alone window mode gives the value to the agent.layout.
    // Sf converts.sf and isa from the same screen, multiple monitors don’t zoom in.
    return { x: a.x, y: a.y, w: a.width, h: a.height, sf: d.scaleFactor || 1 };
  }

  /**
   * Simulator primary windows are punctured by the size of the device’s panel lock, and the wrong scale is caught back.
   * Here’s the w/h ratio (including the height of the titlebar), which is used to give the right size at a time.
   * Separate window mode shell windows are hidden, and bounds may be a screen default,
   * So correct by panel orientation (Wide > High, Value > 1).
   */
  _panelRatio() {
    const b = this.win ? this.win.getBounds() : this._area();
    if (b && b.width > 0 && b.height > 0) {
      // Bunds of the shell window may still be vertical under the crossscreen panel (detached pattern)),
      // Direct reading will get 0.56 (9:16), but the actual panel is 16:9.
      // Use h/w of portrait as a width (map = vertical screen panel 90°))
      if (this.state.landscape && b.height > b.width) {
        return b.height / b.width;
      }
      return b.width / b.height;
    }
    return 0.5625; // Standup 9:16
  }

  _scale() {
    try {
      const b = this.win ? this.win.getBounds() : this._area();
      return screen.getDisplayMatching(b).scaleFactor || 1;
    } catch (_) {
      return 1;
    }
  }

  /**
   * Converts a DIP rectangle into a Physic pixel for the use of SetWindowPos, a window agent.
   * The Screen/BrowserWindow coordinates of Electron are all DIPs; and the top level of the agent.ps1 states
   * Per-monitor v2 DPI perception, SetWindowPos of Win32 received physics pixels.
   * At 125/150, scaling down is the root of the "Window is only half displayed / to the corner / Clicking to the wrong position"
   * (_rect() has already flown sf, to fill this missing link in stand-alone window mode.
   */
  _physical(rect, sf) {
    return physicalRect(rect, sf || this._scale());
  }

  /**
   * Open (or reuse) application window.
   * @param {object} o { pkg, label, iconPath, portrait, fullscreen, detached,
   *                     showWhileWaiting, onClosed }
   *        Detached = True Walking "Independent Window Mode": Shell Window is loaded and not displayed, and the image is in the Simulator’s original window.
   *        Show WheelWatiting=True, **During the waiting period**Show the shell window first.),
   *        When the simulator window is connected, it will be openedDetached() to close. Switch to App in another direction.
   *        When it’s needed to reboot (about 40 seconds), there’s nothing on the screen before that time, and the user thinks it’s gone.
   */
  open(o) {
    const { pkg, label, iconPath, portrait, fullscreen, detached } = o;
    this.detachedMode = !!detached;
    this.waitingForRestart = false;
    this._showWhileWaiting = !!o.showWhileWaiting;
    this._closedCb = o.onClosed || null;
    if (this.isOpen && this.pkg === pkg) {
      // A stand-alone window with a shell window should never be visible.
      // And then the user order the same application again, and what he wants is, "Get the window you’re looking at in front of it.",
      // Give it to the window agent to lift the simulator’s original window.
      if (this.detachedMode) this.agent.show().catch(() => {});
      else {
        this.win.show();
        this.win.focus();
      }
      return this.win;
    }
    this.close({ keepApp: true });

    this.pkg = pkg;
    // Remember the path of the original icon file: it is set to the Simulator original window in stand-alone window mode (Win32)
    // LoadImage only recognizes the file path, not the data URL used by HTML.
    this.iconFilePath = iconPath || '';
    this.portrait = portrait || { w: 540, h: 960 };
    // Full screen under stand-alone window mode is used on the simulator window.,
    // A hidden window with no visual effects, openDetached will read this mark.
    this._wantFullscreen = !!fullscreen;
    this.state = { label: label || 'Apply', tip: 'Starting Android.…', ready: false, landscape: false };

    const area = this._area();
    const size = AppWindow.sizeFor(area, this.portrait, false);
    const w = Math.max(320, size.w);
    const h = Math.max(420, size.h + TITLEBAR_H);

    const iconFile = iconPath && fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;

    this.win = new BrowserWindow({
      width: w,
      height: h,
      minWidth: 320,
      minHeight: 420,
      x: Math.round(area.x + (area.w - w) / 2),
      y: Math.round(area.y + (area.h - h) / 2),
      show: false,
      frame: false,
      thickFrame: true,
      resizable: true,
      maximizable: true,
      backgroundColor: '#0b0c0e',
      title: label || 'Hydra Emulator',
      icon: iconFile,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });

    this.win.loadFile(path.join(__dirname, '..', 'ui', 'shell.html'));
    // Page title changes window title to shell.html <title>, The task column doesn't recognize which application.,
    // Block here, let the OS caption always be the same as the application of the name.
    this.win.webContents.on('page-title-updated', (e) => {
      e.preventDefault();
      try { this.win.setTitle(label || 'Hydra Emulator'); } catch (_) { /* Window may have been destroyed */ }
    });
    this.win.once('ready-to-show', () => {
      // In stand-alone window mode, Android's image is in the original window of the simulator itself, and we have no contents to show.,
      // Keep only one more black empty window. So just load it, and don’t show it.
      // Exceptions: showWhileWatitng (no auto-painting at the time of the switch application) - this is the first time that you can show the piece.
      // "Opening xx..." shell, do not let the user wait 40 seconds for the empty desktop.
      if (this.detachedMode && !this._showWhileWaiting) return;
      this.win.show();
      this._push();
    });

    // The size of the window will be stabilized in several steps when Electric maximizes (OS animated, DPI recalculated)),
    // A single 40ms shivering fit often captures the middle, and then only one of the top left angles is embedded.,
    // There’s a big blank on the right -- it’s the user’s screen that’s not filled with "maximization."
    // And then it’s a series of rounds, and each round is recalculated by the latest getContentBounds.
    const refit = () => this.scheduleFit(6);
    this.win.on('resize', refit);
    this.win.on('move', refit);
    this.win.on('maximize', refit);
    this.win.on('unmaximize', refit);
    this.win.on('restore', () => {
      this.agent.show().catch(() => {});
      this.scheduleFit(6);
    });
    this.win.on('minimize', () => { this.agent.hide().catch(() => {}); });
    this.win.on('close', () => { this._closing = true; });
    this.win.on('closed', () => {
      if (this._selfClose) return;   // close() close after the mark is finished
      this.win = null;
      const pkg = this.pkg;
      this.pkg = null;
      this._closing = false;
      // Close path without close() (Alt+F4, taskbar closed, system shut down) must also stop Android application,
      // Take off the simulator window. Otherwise the window disappears, but the application runs backstage, and the user calls the meeting because
      // “Wanted“ cuts straight past, which seems to be “cannot be turned off.“
      if (pkg && this._onCloseApp) {
        try { this._onCloseApp(pkg); } catch (_) { /* ignore */ }
      }
      Promise.resolve(this.agent && this.agent.park()).catch(() => {}).then(() => {
        if (this._closedCb) this._closedCb(pkg);
      });
    });
    // Only "Application window is really on the front desk" and at least one mouse map opens the global hook;
    // Unmount immediately, without focus/off, and never allow Hydra Emulator to slow down the entire system in the backstage.
    this.win.on('focus', () => this._syncHook(true));
    this.win.on('blur', () => this._syncHook(false));

    // Note: maximize() will show the window:false directly.
    // The image in stand-alone window mode is in the emulator's primary window, and one maximize here will be right on the screen.
    // An extra black shell window -- half of the user feedback “open applications with multiple windows“ comes from here.
    if (fullscreen && !this.detachedMode) this.win.maximize();
    return this.win;
  }

  _pointerOptions() {
    const getter = this.pointerConfig || this.mouseHook;
    const raw = typeof getter === 'function' ? getter() : getter;
    return hookOptions(raw);
  }

  _syncHook(active) {
    const opts = this._pointerOptions();
    // No global mouse hooks in game/low delay mode: WH_MOUSE_LL to each mouse event on the desktop
    // Synchronizes the echoes, significantly increasing the delay in the pointer; what the FPS needs is a Qt window that receives the original input directly.
    const game = !!(store.getSettings().engine && store.getSettings().engine.priorityMode === 'game');
    const on = !!active && opts.enabled && !game;
    if (this.agent && typeof this.agent.setHook === 'function') {
      this.agent.setHook(on, opts).catch(() => {});
    }
  }

  /** The settings page changed the mouse map: re-sync it with the current focus (no reloading of hook lines)) */
  refreshPointer() {
    const focused = this.isOpen && !!this.win.isFocused();
    if (!focused) {
      // The window’s not on the front desk: just unload it, and don’t let the hooks go empty on the backstage.
      if (this.agent && typeof this.agent.setHook === 'function') {
        this.agent.setHook(false).catch(() => {});
      }
      return;
    }
    this._syncHook(true);
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this._push();
  }

  /**
   * Unique window mode "Shows the shell window out temporarily".
   *
   * Scene: Toggle to a different application across the screen to restart Android’s operation (approximately 40 seconds), during which time
   * The simulator’s original window will be destroyed, and the new window has not been built yet. If the shell window is hidden at this moment, on the screen.
   * Nothing -- the user will think the program is out. The start-up phase depends on showtimeWaiting.,
   * But then pre-attach will put it away when it's done; when it's really restarted, no one will show it again.
   *
   * So reboot and then call again: first to show the shell with a hint, and then to the new window when it’s connected.
   * OpenDetached() Hide() on the first line.
   */
  showWaiting(tip) {
    if (!this.isOpen) return false;
    // Marking "waiting for restart": the pre-attach round of inquiry at startup stage will see it moving.,
    // Otherwise, it will openDetached() to drop the shell window first, and the user will be drying the empty desktop again.
    this.waitingForRestart = true;
    if (tip) this.state = { ...this.state, tip, ready: false };
    this._push();
    try {
      this.win.show();
      this.win.moveTop();
    } catch (_) {
      return false;
    }
    return true;
  }

  _push() {
    if (!this.isOpen) return;
    try {
      this.win.webContents.send('shell:state', {
        ...this.state,
        iconUrl: this.iconUrl || '',
      });
    } catch (_) { /* Window may just be closed */ }
  }

  setIcon(p) { this.iconUrl = iconUrl(p); this._push(); }

  /**
   * Place the emulator window in the current window and fill the area below the titlebar.
   * Resident suppression not closed: it skips the one “in our window“ with the rest of the window (including qemu) /
   * Keep it down -- when it’s closed, it gives them a chance to show their faces again.
   * The simulator window is occasionally not created yet, and here we try again.
   */
  /**
   * Separate window mode: **Oh, no.**The simulator is embedded in our window, but it opens its own original window.
   *
   * Why this way: “SetParent“ is the same, but it’s a whole set of problems. ——
   * Front and back table Z sequence, black edge, coordinates map error, maximized unpaved, Qt panel direction versus host ratio.
   * These are the inherent costs of "pluging a window into another’s window."
   *
   * Under stand-alone windows, the simulator window is the original window of the system: orientation, scaling, input is entirely in its own hands.,
   * The whole set of problems above does not exist at the root. The cost is one more taskbar icon, and the perception is not exactly uniform.
   *
   * @returns {Promise<boolean>} Successfully cut to stand-alone window
   */
  async openDetached() {
    // Shell windows are closed (user clicks closed / start-up shut off) without objects to carry.
    // Write down the reason: otherwise the top log can only hit one “unknown,“ and it doesn’t seem to be “window’s gone.“
    // Or "Simulator window not found."
    if (!this.isOpen) { this.lastEmbedError = 'shell-closed'; return false; }
    // Really start taking over, wait for the mark to come to an end.)
    this.waitingForRestart = false;
    // Shell windows must not appear in stand-alone mode.
    // But show WhileWaiting it’s now visible "waiting for a hint," and here’s where it’s supposed to be.
    try { this.win.hide(); } catch (_) { /* ignore */ }
    // Make sure it's not embedded.
    // Keep=true: Tell agent this is a "cut standalone window" not an "end anchoring" -- otherwise it’ll put
    // The simulator window that the user is looking at is hidden as a sundry.
    const dt = await this.agent.detach(true).catch((e) => ({ ok: false, error: e.message }));
    this._detachedDebug = `detach=${JSON.stringify(dt)}`;
    // Title must be set before show.
    // Could not close temporary folder: %s %s
    // One show comes out and it’s put on the old title -- the window will be used to switch applications.**Previous application
    //  Name**Flash 0.5 seconds, first start with "Android Emulator - hydra:5554".
    // The order used to be show() → setTitle(), so the half-second must have seen.
    const title = this.state && this.state.label ? this.state.label : 'Hydra Emulator';
    await this.agent.setTitle(title).catch(() => {});
    // Both icons and titles are set before the window show: avoid flashing the old title/green robot icon,
    // Wait twice to merge the original "setTitle after 600ms + show + setIcon"
    // Once -- open it to about 300 ms.
    // icon only affects the task bar/ Alt+Tab, setting up an existing Qt window, not relying on its show past.
    const icoForNative = this.iconFilePath
      ? this.iconFilePath.replace(/\.png$/i, '.ico')
      : '';
    if (icoForNative && fs.existsSync(icoForNative)) {
      try { await this.agent.setIcon(icoForNative); } catch (_) { /* ignore */ }
    } else if (this.iconFilePath) {
      try { await this.agent.setIcon(this.iconFilePath); } catch (_) { /* ignore */ }
    }
    await sleep(600);
    // Make the simulator window really visible
    const shown = await this.agent.show().catch((e) => ({ ok: false, error: e.message }));
    this._detachedDebug += ` show=${JSON.stringify(shown)}`;
    if (!shown || shown.ok === false) { this.lastEmbedError = this._detachedDebug; return false; }
    // Centering by screen availability and sizing.
    // Note: Simulator primary window itself is locked in width by device panel scale (vertical screen 9:16).),
    // Give an unmatched w/h, it’ll clip the width back back to the high value, and it’ll be 1280 wide.
    // And it's only 400 wide." So this is the size of the panel, one at a time.
    //
    // Full screen (Automated Full Screen on Start) filled with the entire available area; horizontal screens have a better width than they would have been
    // The screen, which will not leave the black edge -- that is why the screen is more worthy of the full screen than the screen.
    const area = this._area();
    const ratio = this._panelRatio();
    let w;
    let h;
    let x;
    let y;
    if (this._wantFullscreen) {
      // "Pocket" also holds the panel scale. When the panel (720x1280) is plugged into the 1920x1080 screen,,
      // Set the window directly as isa.w x isa.h, Qt will scale it back in proportion, but the position remains.
      // The top left corner -- the user sees a vertical window on the top left corner of the screen, not the full screen.
      // The maximum available rectangle is proportional and centered here, and the cross-screen panel would have been proportional, and the effect would have been really full.
      const fitW = Math.min(area.w, Math.round(area.h * ratio));
      w = fitW;
      h = Math.round(fitW / ratio);
      x = Math.round(area.x + (area.w - w) / 2);
      y = Math.round(area.y + (area.h - h) / 2);
      // Synchronize full screen tags, or the first dot "maximizing" button will be misconstrued as "get into full screen" instead of being restored.
      this._detachedFullscreen = true;
    } else {
      this._detachedFullscreen = false;
      const maxH = Math.min(area.h - 140, 1000);
      const maxW = Math.min(area.w - 80, 1280);
      w = maxW;
      h = Math.round(w / ratio);
      if (h > maxH) { h = maxH; w = Math.round(h * ratio); }
      x = Math.round(area.x + (area.w - w) / 2);
      y = Math.round(area.y + 60);
    }
    // Area/x/y/w/h are all DIPs for Ecleon, and SetWindowPos for windows.
    // Pixels 150%. If you zoom down and don’t convert, the window is only two-thirds large and the top left corner -- that is, issue #99.
    // _rect() (inline mode) has been multiplied by sf, where the gap in stand-alone mode is filled.
    const lay = await this.agent.layout(this._physical({ x, y, w, h }, area.sf))
      .catch((e) => ({ ok: false, error: e.message }));
    this._detachedDebug += ` layout=${JSON.stringify(lay)}`;
    this.lastEmbedError = this._detachedDebug;
    this.lastEmbedOk = false;
    return !!(lay && lay.ok !== false);
  }

  async embed() {
    if (!this.isOpen) return false;
    let last = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!this.isOpen) return false;
      const hwnd = this._hwnd();
      if (!hwnd) return false;
      // If the externals provide the test handle (historic interface, current constant null); if you don’t get it, try again.
      // —— The handles are redistributed every time you start, and the old one is cached to the wrong place.
      let targets = null;
      if (typeof this.windowTargets === 'function') {
        // eslint-disable-next-line no-await-in-loop
        targets = await Promise.resolve(this.windowTargets()).catch(() => null);
        if (Array.isArray(targets) && !targets.length) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(attempt < 2 ? 400 : 1000);
          continue;
        }
      }
      // eslint-disable-next-line no-await-in-loop
      const r = await this.agent.embed(hwnd, this._rect(), targets).catch((e) => ({ ok: false, error: e.message }));
      last = r;
      if (r && r.ok) { this.lastEmbedOk = true; return true; }
      // eslint-disable-next-line no-await-in-loop
      await sleep(attempt < 2 ? 300 : 800);
    }
    // Bring out the cause of failure: the upper level will be written into app.log, and the problem at first glance shows that "no simulator window found."
    // Or "SetParent Failed," no more guessing.
    this.lastEmbedError = last ? (last.error || `emu=${last.emu}`) : 'no-response';
    return false;
  }

  async fitNow() {
    if (!this.isOpen) return;
    await this.agent.fit(this._rect()).catch(() => {});  }

  /** The rectangle that the simulator sub-window should occupy (physical pixels, which have pushed 8px inner margin into the visual area)) */
  _rect() {
    const sf = this._scale();
    const b = this.win.getContentBounds();
    const top = Math.round(TITLEBAR_H * sf);
    return {
      x: -EMU_PAD,
      y: top - EMU_PAD,
      w: Math.round(b.width * sf) + EMU_PAD * 2,
      h: Math.round((b.height - TITLEBAR_H) * sf) + EMU_PAD * 2,
      // The above-EMU_PAD will press on the titlebar and hand it over to the window agent ’s cliptop (see agent.fit).)
      clipTop: EMU_PAD,
    };
  }

  /**
   * @param{number} Rounds lined up to several rounds (up to date for each round when the size of the window changes))
   */
  scheduleFit(rounds = 1) {
    if (!this.isOpen) return;
    if (this._fitTimer) clearTimeout(this._fitTimer);
    const run = async (left) => {
      await this.fitNow().catch(() => {});
      if (left > 1) {
        this._fitTimer = setTimeout(() => run(left - 1), 160);
      } else {
        this._fitTimer = null;
      }
    };
    this._fitTimer = setTimeout(() => run(Math.max(1, rounds)), 40);
  }

  _hwnd() {
    try {
      const buf = this.win.getNativeWindowHandle();
      const v = buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
      return v.toString();
    } catch (_) {
      return null;
    }
  }

  /**
   * Cross-screen switch (titlebar rotation button) = Real switch “Physics Panel“ to “Physics Panel“ or “Physics“ screen.
   *
   * Why do you have to do this?):
   *   - Change wm size: Just Android Logical Resolution, the simulator's physics LCD is still vertical,
   *     Qt puts the image on the top left corner - > the image lies 90°, only one, all around the black edge, clicking at the coordinates to the wrong position;
   *   - Change wm denity: frambuffer in size, not full, and maximize a large space on the right side;
   *   - adb emu network: only image content, the system still stands up.
   * The only way to get a "Down + Filled" screen is to replace hw.ld.width/ height
   * 1280x720 and reboot the simulator. Reboot about 30 to 60 seconds, so only once here, and give a clear hint.
   *
   * @param {(next:boolean)=>Promise<boolean>} [onRestatt] Reboot from the upper layer
   * @param{boolean} [explicitNext] Target orientation. Use it directly when coming in, and no longer reverse ——
   *        We’re going to have to do the rotation entrances in the right direction, and we’re going to do it in the right direction, so we don’t have to do anything about it.
   *        "Criteria for apps.json" is the opposite of "exact past panel direction".
   */
  async rotate(onRestart, explicitNext) {
    if (!this.isOpen) return this.state.landscape;
    const next = explicitNext === undefined || explicitNext === null
      ? !this.state.landscape : !!explicitNext;
    this.setState({ tip: next ? 'Switching to screen (about 30-60 seconds at the time Android runs restart))…' : 'Cutting back the screen (about 30-60 seconds at the time of the operation of Android))…', ready: false });
    if (typeof onRestart === 'function') {
      const ok = await onRestart(next).catch(() => false);
      if (ok) {
        this.state.landscape = next;
        this._push();
        // The panel size changed, the window width ratio changed;
        for (let i = 0; i < 5; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(400);
          // eslint-disable-next-line no-await-in-loop
          await this.fitNow();
        }
        this.setState({ ready: true, tip: '' });
        return next;
      }
    }
    // Back to the demosity project without injection to restart (or fail), at least to cut the layout
    if (this.setOrientation) await this.setOrientation(next).catch(() => {});
    this.state.landscape = next;
    this.setState({ ready: true, tip: '' });
    return next;
  }

  /** To the specified direction (full screen = screen, window = screen)) */
  async setLandscape(want) {
    if (!this.isOpen) return this.state.landscape;
    if (!!this.state.landscape === !!want) return this.state.landscape;
    return this.rotate();
  }

  async toggleMaximize() {
    if (!this.isOpen) return;
    // Separate window mode: The image is in the original simulator window, the shell window is hidden --maximize a hidden window
    // The window has no visual effect.
    // Simulator window full of workspaces / restore to previous dimensions.
    if (this.detachedMode) {
      const area = this._area();
      if (this._detachedFullscreen) {
        // Revert: Back to the size (if any) that you remember before the full screen, otherwise it’s proportionally centered by default
        this._detachedFullscreen = false;
        if (this._preFullscreenRect) {
          await this.agent.layout(this._preFullscreenRect).catch(() => {});
          this._preFullscreenRect = null;
        } else {
          await this.openDetachedLayoutOnly(area);
        }
      } else {
        // Remember the current window position and size before fullscreen, restore time
        try {
          const probe = await this.agent.probe().catch(() => null);
          if (probe && probe.w > 0 && probe.h > 0) {
            this._preFullscreenRect = { x: probe.x, y: probe.y, w: probe.w, h: probe.h };
          }
        } catch (_) { /* By default when you can't get it back */ }
        this._detachedFullscreen = true;
        // Same as openDetached: All screens also hold the panel ratio and center, otherwise the screen application will be
        // Qt scale back, stop at the top left corner.
        const ratio = this._panelRatio();
        const fitW = Math.min(area.w, Math.round(area.h * ratio));
        const fitH = Math.round(fitW / ratio);
        await this.agent.layout(this._physical({
          x: Math.round(area.x + (area.w - fitW) / 2),
          y: Math.round(area.y + (area.h - fitH) / 2),
          w: fitW,
          h: fitH,
        }, area.sf)).catch(() => {});
      }
      return;
    }
    if (this.win.isMaximized()) this.win.unmaximize();
    else this.win.maximize();
    this.scheduleFit();
  }

  /**
   * Resize only the simulator window size (do not re-dotach/show) for fullscreen/revert toggled
   * The size logic of the calculation.
   */
  async openDetachedLayoutOnly(area) {
    const maxH = Math.min(area.h - 140, 1000);
    const maxW = Math.min(area.w - 80, 1280);
    const ratio = this._panelRatio();
    let w = maxW;
    let h = Math.round(w / ratio);
    if (h > maxH) { h = maxH; w = Math.round(h * ratio); }
    await this.agent.layout(this._physical({
      x: Math.round(area.x + (area.w - w) / 2),
      y: Math.round(area.y + 60),
      w, h,
    }, area.sf)).catch(() => {});
  }

  minimize() {
    if (!this.isOpen) return;
    // Separate window mode: Minimal is the simulator’s primary window (agent.hide hides it)),
    // Not the invisible shell window.
    if (this.detachedMode) { this.agent.hide().catch(() => {}); return; }
    this.win.minimize();
  }

  /**
   * Close the window. By default, the Android application will be stopped simultaneously, but the engine will be kept, and the next point will be a second.
   *
   * The order is important: the simulator window must be removed and hidden from the host window and destroyed.
   * In turn, Windows will re-mount the cross-process sub-window to the desktop and keep it in its original visible state.,
   * On the user ’s desktop, there’s a black window "Android Emulator - hydra5554" out of thin air.
   */
  close({ keepApp = false } = {}) {
    if (!this.isOpen) return;
    const win = this.win;
    const pkg = this.pkg;
    this._syncHook(false);
    this.lastEmbedOk = false;
    if (!keepApp && pkg && this._onCloseApp) this._onCloseApp(pkg);
    this._selfClose = true;
    this.win = null;
    this.pkg = null;
    const done = () => {
      try { win.destroy(); } catch (_) { /* ignore */ }
      this._selfClose = false;
      this._closing = false;
      if (this._closedCb) this._closedCb(pkg);
    };
    Promise.resolve(this.agent && this.agent.park()).catch(() => {}).then(done, done);
  }

  onCloseApp(cb) { this._onCloseApp = cb; }
}

module.exports = { AppWindow, TITLEBAR_H };
