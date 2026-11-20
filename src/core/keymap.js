'use strict';
/**
 * Game key map -- Pure Data Layer
 *
 * Map keyboard to Android’s touch screen coordinates. Every map entry.:
 *   {key: 'w', action: 'tap', x: 0.15, y:0.85}/ relative coordinates (0~1),)
 *   { key: 'space', action: 'tap', x: 0.5, y: 0.9 }
 *   { key: 'j', action: 'swipe', x1: 0.7, y1: 0.5, x2: 0.3, y2: 0.5, duration: 100 }
 *
 * Coordinates are the unicoded values (0-1) relative to the LCD panel, which is multiplied by the actual wm size to get pixels.
 *
 * Preset template overwrite common game types:
 *   - fps: WASD Move Rockstick Area + Mouse Aim (Mouse treated by Qt native, here only keyboards))
 *   - rpg: WASD Mobile + J/K/L Skills + Space Confirm
 *   -generic: Arrow + Enter/ Space
 */

const PRESETS = {
  fps: {
    label: 'FPS / Shooting Class',
    desc: 'WASD controls the left virtual rock pole area, J shoots, K-locks, Space jumps',
    mappings: [
      { key: 'w', action: 'tap', x: 0.15, y: 0.75 },
      { key: 'a', action: 'tap', x: 0.08, y: 0.82 },
      { key: 's', action: 'tap', x: 0.15, y: 0.89 },
      { key: 'd', action: 'tap', x: 0.22, y: 0.82 },
      { key: 'j', action: 'tap', x: 0.85, y: 0.75 },
      { key: 'k', action: 'tap', x: 0.92, y: 0.82 },
      { key: ' ', action: 'tap', x: 0.78, y: 0.82 },
    ],
  },
  rpg: {
    label: 'RPG/ Action class',
    desc: 'WASD move, J attack, K skill, L big move, Space confirmation/dialogue',
    mappings: [
      { key: 'w', action: 'tap', x: 0.15, y: 0.75 },
      { key: 'a', action: 'tap', x: 0.08, y: 0.82 },
      { key: 's', action: 'tap', x: 0.15, y: 0.89 },
      { key: 'd', action: 'tap', x: 0.22, y: 0.82 },
      { key: 'j', action: 'tap', x: 0.82, y: 0.78 },
      { key: 'k', action: 'tap', x: 0.90, y: 0.78 },
      { key: 'l', action: 'tap', x: 0.86, y: 0.70 },
      { key: ' ', action: 'tap', x: 0.5, y: 0.92 },
    ],
  },
  generic: {
    label: 'General / Leisure',
    desc: 'Arrow moves, Enter confirms, Space cancels/ returns',
    mappings: [
      { key: 'ArrowUp', action: 'tap', x: 0.15, y: 0.75 },
      { key: 'ArrowLeft', action: 'tap', x: 0.08, y: 0.82 },
      { key: 'ArrowDown', action: 'tap', x: 0.15, y: 0.89 },
      { key: 'ArrowRight', action: 'tap', x: 0.22, y: 0.82 },
      { key: 'Enter', action: 'tap', x: 0.5, y: 0.92 },
      { key: ' ', action: 'keyevent', code: 4 },  // BACK
    ],
  },
};

/**
 * Align the key name of Electron to the format used in the map.
 * Easyron KeyboardEvent.key values like ’w’, ’W’, ’ArrowUp’, ’, ’Enter’, etc.
 */
function normalizeKey(key) {
  if (!key) return '';
  // Single letter lowercase
  if (key.length === 1 && /[A-Za-z]/.test(key)) return key.toLowerCase();
  return key;
}

/**
 * Finds the action of a key in the current map.
 * @param{Array} map entries array
 * @param {string} key Electron KeyboardEvent.key
 * @returns {object|null} Matching Map Entry
 */
function lookup(mappings, key) {
  const nk = normalizeKey(key);
  if (!nk || !Array.isArray(mappings)) return null;
  return mappings.find((m) => normalizeKey(m.key) === nk) || null;
}

/**
 * Convert map entries + LCD dimensions to adb shell commands.
 * @param{object} map mapping entry
 * @param{number}width LCD width (pixels))
 * @param{number} Height LCD height (pixels))
 * @returns{string} adb shell command (e. g. 'input tab 192 612'))
 */
function toCommand(mapping, width, height) {
  if (!mapping) return '';
  if (mapping.action === 'tap') {
    const x = Math.round(mapping.x * width);
    const y = Math.round(mapping.y * height);
    return `input tap ${x} ${y}`;
  }
  if (mapping.action === 'swipe') {
    const x1 = Math.round(mapping.x1 * width);
    const y1 = Math.round(mapping.y1 * height);
    const x2 = Math.round(mapping.x2 * width);
    const y2 = Math.round(mapping.y2 * height);
    const dur = mapping.duration || 100;
    return `input swipe ${x1} ${y1} ${x2} ${y2} ${dur}`;
  }
  if (mapping.action === 'keyevent') {
    return `input keyevent ${mapping.code}`;
  }
  return '';
}

module.exports = { PRESETS, normalizeKey, lookup, toCommand };
