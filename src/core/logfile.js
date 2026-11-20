'use strict';
/**
 * Light log writing + rolling.
 *
 * Used to be app.log/ emulator.log is pure append, long-term use will continue.:
 * Emulator has dozens of KBs, dozens of switches a day, plus qemu's kernel logs.
 * Verbose output, hundreds of MB in months -- that's how disks are quietly eaten.
 * Scroll here in size, with only one 1.log backup, the upper limit being controlled by the "Log cap" in the set.
 */
const fs = require('fs');
const path = require('path');

const counters = new Map();

function rotate(file, limitKB) {
  try {
    const st = fs.statSync(file);
    if (st.size < limitKB * 1024) return false;
    const bak = file.replace(/\.log$/i, '.1.log');
    // When the filename does not end with.log, the bak will be equal to the original file: delete the log after rename.
    // It's a clear way to skip this boundary, and it's better to keep a log than to lose it.
    if (path.resolve(bak) === path.resolve(file)) return false;
    try { fs.rmSync(bak, { force: true }); } catch (_) { /* ignore */ }
    fs.renameSync(file, bak);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * @param{string} file target log
 * @param{string} line line content (auto wrap line))
 * @param{number} [limitKB] Scroll beyond this size
 */
function append(file, line, limitKB = 2048) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const n = (counters.get(file) || 0) + 1;
    counters.set(file, n);
    // Every process starts with a check, and every 200 lines of check after that.)
    if (n === 1 || n % 200 === 0) rotate(file, Math.max(256, Number(limitKB) || 2048));
    fs.appendFileSync(file, line.endsWith('\n') ? line : `${line}\n`);
    return true;
  } catch (_) {
    return false;
  }
}

/** Clean up on startup: Roll out the oversized logs first (without looking at the counter).) */
function trimNow(file, limitKB = 2048) {
  return rotate(file, Math.max(256, Number(limitKB) || 2048));
}

module.exports = { append, rotate, trimNow };
