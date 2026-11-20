'use strict';
/**
 * Android’s package is authenticated.
 *
 * AndroidManifest.xml (external input) from APK is used to spell local file paths.
 * (store.iconPath / apkPath) and adb shell command (pm path / pidof / am start...).
 * If you do not check, you will be able to give ’. . . . board, shell character directly to a path.join and shell:
 * The former writes beyond the target directory, the latter orders injection.
 *
 * Android package: point-separated paragraphs beginning with letters/downlines,
 * After that is the letters/numbers/downlines. This is a strict ASCII check, and it’s better to reject a few strange things.
 * Third-party package, without any path separator or shell character.
 */
const RE_PKG = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/;

function validPackageName(pkg) {
  return typeof pkg === 'string' && RE_PKG.test(pkg);
}

/** Reformulate illegal wrappings to secure filenames (for log/deep display, not for installation)) */
function safeFilePart(pkg) {
  if (validPackageName(pkg)) return pkg;
  return `invalid-${String(pkg || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)}`;
}

module.exports = { validPackageName, safeFilePart, RE_PKG };
