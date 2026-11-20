'use strict';
/**
 * Mouse Key bitmap (purcal calculation, not dependent on Electron/ adb, so that one can be measured)
 *
 * Applying window is embedded in Android Emulator’s Qt sub-window, with original behavior being:
 *   Left key = finger click (just “confirmation,“ without our intervention.)
 *   Right key = also used as a finger click (for mistouch, must be stopped and changed to "return".)
 *   Wheel = single finger slide, but Qt has a single touch event, and the image twitches.
 *
 * So Hydra Emulator only has a low-level hook on a special thread in the application window at the front desk.,
 * Stop right and wheel; when the wheels are merged into a time window, they are translated into one `input swipe`,
 * A smooth and not a rolling adb process.
 */

const WHEEL_NOTCH = 120;

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function clampInt(v, lo, hi) { return Math.round(clamp(v, lo, hi)); }

/**
 * Read the settings, get the switch that the hook needs.
 * When these keys are not available in the old configuration, press "Right key returns + smooth wheels, side key closes" to migrate.
 */
function pointerOptions(settings = {}) {
  const e = (settings && settings.engine) || {};
  const rightBack = e.mouseRightBack !== false;
  const wheel = e.mouseWheelMode === 'native' || e.mouseWheelMode === 'off'
    ? e.mouseWheelMode : 'smooth';
  const side = !!e.mouseSideButtons;
  return { rightBack, wheel, side, enabled: rightBack || wheel === 'smooth' || side };
}

/** Merge configurations from any source into a combination of 0/1 that an agent can consume directly */
function hookOptions(raw = {}) {
  let v = raw;
  // Compatible with old boolean: true = only side key map
  if (typeof v === 'boolean') v = { enabled: v, rightBack: false, wheel: 'off', side: v };
  if (typeof v === 'function') v = v();
  if (!v || typeof v !== 'object') v = {};
  const rightBack = !!v.rightBack;
  const wheel = v.wheel === 'smooth' || v.wheel === true;
  const side = !!v.side;
  const enabled = 'enabled' in v ? !!v.enabled : (rightBack || wheel || side);
  return {
    enabled,
    rightBack: enabled && rightBack,
    wheel: enabled && wheel,
    side: enabled && side,
  };
}

/** Only input orders that we put inside, stop the infusion. */
const INPUT_RE = /^input (?:keyevent \d{1,3}|swipe -?\d+ -?\d+ -?\d+ -?\d+ \d{1,4}|tap -?\d+ -?\d+)$/;
function isInputCommand(cmd) { return INPUT_RE.test(String(cmd || '')); }

/**
 * Transposition of wheels into a slide.
 * @param{object} o {dx, dy, nx, ny, width, height} -- nx/ ny is the unicoded position of the cursor in the LCD
 * @returns {{x1:number,y1:number,x2:number,y2:number,duration:number}|null}
 */
function wheelToSwipe({ dx = 0, dy = 0, nx = 0.5, ny = 0.5, width = 900, height = 1600 } = {}) {
  const w = clampInt(width, 240, 4096);
  const h = clampInt(height, 320, 4096);
  const vertical = Math.abs(Number(dy) || 0) >= Math.abs(Number(dx) || 0);
  const delta = vertical ? (Number(dy) || 0) : (Number(dx) || 0);
  if (!delta) return null;

  // One wheel = approximately 30% screen-wide slide; one continuous roller combined into a longer slide (up to 78% screen-wide))
  const steps = clamp(Math.abs(delta) / WHEEL_NOTCH, 0.6, 6);
  const axis = vertical ? h : w;
  const span = clamp(Math.round(axis * 0.30 * steps), 80, Math.round(axis * 0.78));
  const half = Math.round(span / 2);
  const cx = clampInt(clamp(nx, 0, 1) * w, 8, w - 8);
  const cy = clampInt(clamp(ny, 0, 1) * h, 8, h - 8);

  let x1 = cx, y1 = cy, x2 = cx, y2 = cy;
  if (vertical) {
    // ♪ ♪ 0 (roller up/ away) ♪ finger down, content rolls to top
    const dir = delta > 0 ? 1 : -1;
    y1 = clampInt(cy - half * dir, 1, h - 1);
    y2 = clampInt(cy + half * dir, 1, h - 1);
  } else {
    // dx > 0 (horizontal wheel to right) ~ Finger slides left
    const dir = delta > 0 ? -1 : 1;
    x1 = clampInt(cx - half * dir, 1, w - 1);
    x2 = clampInt(cx + half * dir, 1, w - 1);
  }
  const duration = clampInt(100 + 22 * steps, 100, 240);
  return { x1, y1, x2, y2, duration };
}

function swipeToCommand(swipe) {
  if (!swipe) return '';
  return `input swipe ${swipe.x1} ${swipe.y1} ${swipe.x2} ${swipe.y2} ${swipe.duration}`;
}

/**
 * Wheel merger: All scrolls in a time window produce only one slide command.
 * Injection is a step. It continues to accumulate.,
 * Send it back again when it’s done, avoiding orders to line up in the shell to cause a roll-by card.
 */
class WheelRouter {
  constructor({ inject, getSize, flushMs = 80 } = {}) {
    this.inject = inject || (() => Promise.resolve());
    this.getSize = getSize || (() => ({ width: 900, height: 1600 }));
    this.flushMs = flushMs;
    this._acc = { dx: 0, dy: 0, nx: 0.5, ny: 0.5 };
    this._timer = null;
    this._busy = false;
    this._closed = false;
  }

  push(ev = {}) {
    if (this._closed) return;
    const dx = Number(ev.dx) || 0;
    const dy = Number(ev.dy) || 0;
    if (!dx && !dy) return;
    this._acc.dx += dx;
    this._acc.dy += dy;
    this._acc.nx = clamp(ev.nx, 0, 1);
    this._acc.ny = clamp(ev.ny, 0, 1);
    this._schedule();
  }

  _schedule() {
    if (this._closed || this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._flush();
    }, this.flushMs);
    if (this._timer.unref) this._timer.unref();
  }

  _take() {
    const b = this._acc;
    this._acc = { dx: 0, dy: 0, nx: 0.5, ny: 0.5 };
    return (b.dx || b.dy) ? b : null;
  }

  async flush() { return this._flush(); }

  async _flush() {
    if (this._closed || this._busy) return;
    const batch = this._take();
    if (!batch) return;
    this._busy = true;
    try {
      const size = await this.getSize();
      const cmd = swipeToCommand(wheelToSwipe({ ...batch, width: size.width, height: size.height }));
      if (cmd && isInputCommand(cmd)) await this.inject(cmd);
    } catch (_) { /* Input failure cannot affect the mouse hook. */ }
    finally {
      this._busy = false;
      if (!this._closed && (this._acc.dx || this._acc.dy)) this._schedule();
    }
  }

  dispose() {
    this._closed = true;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this._acc = { dx: 0, dy: 0, nx: 0.5, ny: 0.5 };
  }
}

module.exports = {
  WHEEL_NOTCH, clamp, pointerOptions, hookOptions,
  isInputCommand, wheelToSwipe, swipeToCommand, WheelRouter,
};
