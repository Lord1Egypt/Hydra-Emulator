'use strict';
/**
 * Displays the appropriate pure computational part (single measure, not dependent on Electric / adb).
 *  - Full screen: Android resolution alignment monitor working area, content automatically filled;
 *  - Window: Keep the screen preset, Qt automatically zooms when the user drags the window and the dimensions are recorded in the application metadata.
 */
function densityFor(w, h, manual) {
  if (manual > 0) return Math.max(120, Math.min(640, Math.round(manual)));
  return Math.max(200, Math.min(480, Math.round(Math.min(w, h) / 2.57)));
}

function portraitSize(str) {
  const m = /^(\d{3,4})x(\d{3,4})$/i.exec(String(str || ''));
  if (!m) return { w: 900, h: 1600 };
  const w = Number(m[1]);
  const h = Number(m[2]);
  return (h > w && w >= 320 && h >= 480) ? { w, h } : { w: 900, h: 1600 };
}

function defaultBounds(area) {
  const h = Math.round((area.h || 1080) * 0.84);
  const w = Math.round(h * 9 / 16);
  return {
    x: Math.round((area.x || 0) + ((area.w || 1920) - w) / 2),
    y: Math.round((area.y || 0) + ((area.h || 1080) - h) / 2),
    w, h,
  };
}

/**
 * Full screen = Full screen height and horizontal center.
 * The width ratio of the simulator window was locked to death by LCD when it was opened (9:16), and only SW_MAXIMIZE would get it.
 * A window that is left, the width is constant; the height is proportionally filled, and then centered, and the visual is just...
 * "Application Full Screen", and the image is not deformed.
 */
function fullscreenBounds(portrait, area) {
  const p = portraitSize(portrait);
  const ratio = p.w / p.h;
  const h = Math.max(320, Math.round(area.h || 1080));
  const w = Math.max(240, Math.round(h * ratio));
  return {
    x: Math.round((area.x || 0) + ((area.w || 1920) - w) / 2),
    y: Math.round(area.y || 0),
    w, h,
  };
}

/**
 * Android Side Resolution: Both modes keep the screen preset.
 * Reason: The width ratio of the simulator window was locked to death by the LCD size at the start of the operation (actually changed to 1920x1080)
 * The window is still only accepted 9:16, and the image is stuck in it to leave a black edge or a deformation.
 * Maximizes full screens, "Wind" = the screen is freely stretched, sharing the same Android resolution,
 * You don’t have to restart the operation when you switch, and you don’t have to reset the application.
 */
function sizeFor(mode, portrait, area) {
  return portraitSize(portrait);
}

module.exports = { densityFor, portraitSize, defaultBounds, fullscreenBounds, sizeFor };
