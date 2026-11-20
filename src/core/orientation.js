'use strict';
/**
 * Screen orientation decision (pure function, not dependent on Electric / adb / network, CI directly require).
 *
 * The reason why it was taken out alone: the previous judgement was scattered across three parts of Main.js (wantLandscapeFor).,
 * Titlebar Rotation Button, Tray Rotation menu), three separate "Next Directions " , with different baselines
 * (Some look downplay.landscape, some Win.state.landscape.
 * Users click to rotate once and write the overwrite values of apps.json to the opposite of the true cut-off panel direction,
 * The next time you turn on the application, you’re going to wantLandscapeFor to turn it back -- it’s like, "Why can’t the red bee get round?"
 * Now, all entrances take this module, with only one benchmark, and one result.
 */

const ORIENTATION_MODES = ['auto', 'landscape', 'portrait'];

/**
 * Should an application use a cross-screen panel or a screen panel.
 *
 * Priority (high low)):
 *   1. Force mode in settings (landscape/ portrait))
 *   2. A manual overlay for individual applications (orientation Override, written by the spin button / right-key menu))
 *   3. Natural orientation (orientation) from the APK List)
 *   4. The front of the board (declarations do not reboot when following gravity))
 */
function resolveLandscape({ mode = 'auto', orientation = null, orientationOverride = null, panelLandscape = false } = {}) {
  if (mode === 'landscape') return true;
  if (mode === 'portrait') return false;
  if (orientationOverride === 'landscape') return true;
  if (orientationOverride === 'portrait') return false;
  if (orientation === 'landscape') return true;
  if (orientation === 'portrait') return false;
  return !!panelLandscape;
}

/** Reverse, used to rotate buttons: vertical, vertical */
function flipLandscape(current) {
  return !current;
}

/** Override value text: True ’landscape’, false ’portrait’ (in apps.json format)) */
function overrideValue(landscape) {
  return landscape ? 'landscape' : 'portrait';
}

/** readback from overlay value text; invalid value returns null (= no overwrite)) */
function parseOverride(value) {
  if (value === 'landscape') return true;
  if (value === 'portrait') return false;
  return null;
}

/**
 * The default value for the automatic rotation switch in the mirror.
 * Virtual machine does not have a real gravity sensor, accelerometer_rotation 0 in system settings
 * Auto-rotation is always off. Open this switch by default now (the panel’s direction is still open)
 * wm user-rotation lock + set-ignore-orientation-request decides not to be held by sensors),
 * This is how you can read it yourself, Settings.System. ACCELEROTER_ROTATION.
 * Returns the 0/1 string to write to guest.
 */
function autoRotateSetting(settings) {
  const d = (settings && settings.display) || {};
  return d.autoRotate === false ? '0' : '1';
}

module.exports = {
  ORIENTATION_MODES,
  resolveLandscape,
  flipLandscape,
  overrideValue,
  parseOverride,
  autoRotateSetting,
};
