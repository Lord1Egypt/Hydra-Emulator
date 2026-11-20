'use strict';
/**
 * Pure geometry conversion (zero reliance, directly require without Ecoctron).
 *
 * Selectron’s screen / BronderserWindow coordinates are all DIPs; window agents
 * Agent. ps1 summit states per-monitor v2 DPI perception, it calls Win32 SetWindowPos
 * It’s a combination of physical pixels, at 125%/ 150%. Zoom out is "Windows show only half/ corner." /
 * _rect() of the embedded mode _cancer clicked (issue #99) already has scalefactor, here the same one
 * A conversion is extracted for independent window mode reuse and individual testing.
 */

/**
 * Convert a DIP rectangle into a physical pixel.
 * @param {x: number, y: number, w: number, h: number}rect DIP Logical Pixel Rect
 * @param{number} [scaleActor] scale ratio; 1 / default returns as it is (same object, zero expense))
 * @returns{x: number, y: number, w: number, h: number} Physics Pixel Rectangle
 */
function physicalRect(rect, scaleFactor) {
  const k = Number(scaleFactor) || 1;
  if (!rect || k === 1) return rect;
  return {
    x: Math.round(rect.x * k),
    y: Math.round(rect.y * k),
    w: Math.round(rect.w * k),
    h: Math.round(rect.h * k),
  };
}

module.exports = { physicalRect };
