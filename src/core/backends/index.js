'use strict';
/**
 * Base registration form
 *
 * **There's only one base: bultin.**
 *
 * 0.5.6, Hydra Emulator runs his own Android in any machine, in any case.
 * (Self-carried adb / emulator / system image), no longer detect, take over, drive any third-party simulator
 * (Mumu / Thunder / Blue Collapse / WSA / FydeOS) does not provide the "connect when running" mode.
 *
 * Why delete the entire optional link, instead of leaving a switch on it?:
 *   - As long as there's a detection branch in the code, the user machine's loaded with Mumu, and it's ready to "take over" at any time.,
 *     In the form of a "Hydra Emulator, but running away from someone else's home simulator," data, archiving, mirrors are not in the place they think they are.
 *   - Third-party simulator upgrades, port conversions, and configurations will directly render Hydra Emulator ineffective, which is not something we can fix;
 *   - Shop bags / Portables with only their own running, and no binding or relying on any third-party simulators.
 * So keep the form of the registration form here (the top interface remains unchanged), with content fixed to buildtin:
 * Read settings, read residue configuration, import old settings.json will never cut to another base.
 */

const { Backend, CAPS } = require('./base');
const { BuiltinBackend } = require('./builtin');

const REGISTRY = [
  BuiltinBackend,
];

/** The only base. Keeping this constant is a clear drop where the rest of us are going to be. */
const ONLY = 'builtin';

function byId(id) {
  return REGISTRY.find((B) => B.id === id) || null;
}

/** Description list for interfaces (silent information only, safe sequence)) */
function describe() {
  return REGISTRY.map((B) => ({
    id: B.id,
    label: B.label,
    summary: B.summary,
    embedCapable: B.embedCapable,
  }));
}

/**
 * Creates an example of a base set.
 *
 * Attention.: **Deliberately ignores.engine.mode.**..the old version may leave mode=mumu / fydeos /attach,
 * Hand-made sets.json may also write a different value -- these have to be treated as buildingtin.,
 * Otherwise, the word "run independently" is empty. The id must be 'builtin'.
 *
 * @param {object} o { appRoot, settings, runtime, store, log, id }
 * @returns {{ backend: Backend, Cls: Function, id: string }}
 */
function create({ appRoot, runtime, store, log, id: forced } = {}) {
  // The other ids are visible, and all drops into the bultin.
  const id = forced && byId(forced) ? forced : ONLY;
  const Cls = byId(id) || BuiltinBackend;
  const backend = new Cls(appRoot, { runtime, store, log });
  return { backend, Cls, id: Cls.id };
}

/**
 * Automatically select the base. There's only one, always back to bultin, no detection.:
 * The detection itself will touch the third-party simulator’s directory/ registration form, which is exactly the behavior to be dropped.
 */
async function autoPick() {
  return { id: ONLY, reason: 'builtin-only' };
}

module.exports = {
  REGISTRY, ONLY, CAPS, byId, describe, create, autoPick, Backend,
};
