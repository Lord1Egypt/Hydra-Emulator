'use strict';
/**
 * Pure logic for incremental updates (code layer): manifest parsing, mode selection,
 * and local/extracted file verification.
 *
 * Background: the portable package is ~99MB, most of which is the Electron shell
 * (Hydra Emulator.exe 180MB uncompressed, dlls, locales). Those only change when
 * Electron itself is upgraded; what actually changes on every release is
 * `resources/app/**` (our JS / assets / node_modules). Previously every upgrade
 * re-downloaded the whole 99MB shell. Now each release publishes two tiny extra assets:
 *   - `Hydra Emulator-vX-manifest.json`: lists sha256 / size of every file in the app
 *     layer, plus the Electron version this release depends on;
 *   - `Hydra Emulator-vX-app.zip`: the whole app layer (usually a few MB).
 * As long as the local Electron version matches, the client downloads only these two
 * small files, verifies each file and overwrites `resources/app`; if any step fails it
 * falls back to the full package, never leaving the user in a broken update state.
 *
 * This file does not require electron, so CI can require it directly for unit tests.
 */
const path = require('path');
const { sha256File } = require('./download');

const APP_DIR = 'resources/app';
const MANIFEST_RE = /-manifest\.json$/i;
const APP_PACK_RE = /-app\.zip$/i;

/** Normalize to forward slashes and strip the ./ prefix; manifest and zip entries are compared in this form */
function norm(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Validate the manifest format. Better to call it "unusable" and fall back to the full package than overwrite files with a broken manifest. */
function parseManifest(text) {
  let m;
  try { m = JSON.parse(text); } catch (_) { throw new Error('Incremental manifest is not valid JSON'); }
  if (!m || m.schema !== 1) throw new Error('Unsupported incremental manifest version');
  if (!m.version || !m.electronVersion) throw new Error('Incremental manifest is missing version information');
  if (!m.app || !m.app.asset || !m.app.sha256 || !m.app.files
      || typeof m.app.files !== 'object' || !Object.keys(m.app.files).length) {
    throw new Error('Incremental manifest is missing code package information');
  }
  return m;
}

/** These assets are "auxiliary assets" and must not be extracted as a full installer over the program directory */
function isAuxAsset(name) {
  const s = String(name || '');
  return /runtime/i.test(s) || APP_PACK_RE.test(s) || MANIFEST_RE.test(s);
}

/**
 * Decide whether this update uses the incremental path or the full package.
 * Only looks at conditions that do not depend on the network: install flavor,
 * Electron version, and whether the manifest's code package is among the assets.
 */
function chooseMode({ flavor, electronVersion, manifest, assets = [], current = '' }) {
  if (flavor !== 'portable') return { mode: 'full', reason: 'Installed build uses the full installer' };
  if (!manifest) return { mode: 'full', reason: 'No incremental manifest' };
  if (!electronVersion || String(manifest.electronVersion) !== String(electronVersion)) {
    return { mode: 'full', reason: 'Electron version differs, full package required' };
  }
  const appAsset = assets.find((a) => a && a.name === manifest.app.asset);
  if (!appAsset) return { mode: 'full', reason: 'Incremental code package not published' };
  return { mode: 'app', appAsset, reason: 'Code-layer incremental update' };
}

/**
 * Compare the local app layer against the manifest: list missing / hash-mismatched files.
 * @param {string} installDir Portable edition root (contains resources/app)
 * @param {object} files app.files from the manifest (path relative to install root → {sha256,size})
 * @param {function} hash Injected hash function, for unit testing
 */
async function inspectLocal({ installDir, files, hash = sha256File }) {
  const changed = [];
  const missing = [];
  for (const [rel, meta] of Object.entries(files || {})) {
    const full = path.join(installDir, ...norm(rel).split('/'));
    let got = null;
    try { got = await hash(full); } catch (_) { /* file missing or unreadable */ }
    if (got === null) missing.push(norm(rel));
    else if (String(got).toLowerCase() !== String(meta && meta.sha256 || '').toLowerCase()) changed.push(norm(rel));
  }
  return { changed, missing, ok: changed.length === 0 && missing.length === 0 };
}

/**
 * Verify the extracted incremental payload: every file in the manifest must exist and match its sha256.
 * This is the last line of defense against "truncated download / mirror returned the wrong file".
 */
async function verifyExtracted({ payload, files, hash = sha256File }) {
  const bad = [];
  for (const [rel, meta] of Object.entries(files || {})) {
    const full = path.join(payload, ...norm(rel).split('/'));
    let got = null;
    try { got = await hash(full); } catch (_) { /* file missing */ }
    if (got === null || String(got).toLowerCase() !== String(meta && meta.sha256 || '').toLowerCase()) {
      bad.push(norm(rel));
    }
  }
  return bad;
}

module.exports = {
  APP_DIR, MANIFEST_RE, APP_PACK_RE, norm, parseManifest, isAuxAsset,
  chooseMode, inspectLocal, verifyExtracted, sha256File,
};
