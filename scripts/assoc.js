#!/usr/bin/env node
'use strict';
/**
 * .apk association command line switch (no interface needed to start))
 *   Node scripts/assoc.js on → Register double click APK installation
 *   Node scripts/ sassoc.js off ~ Unconnect
 */
const path = require('path');
const fs = require('fs');
const { registerAssociation, unregisterAssociation } = require('../src/core/assoc');

const action = process.argv[2] || 'on';
const isDev = !process.env.HYDRA_PACKAGED;
const exe = isDev
  ? path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe')
  : process.execPath;
const appDir = path.join(__dirname, '..');

if (action === 'on') {
  const iconPath = path.join(__dirname, '..', 'build', 'hydra.ico');
  const r = registerAssociation(exe, fs.existsSync(iconPath) ? iconPath : undefined,
    isDev ? `"${appDir}"` : undefined);
  console.log('Registered .apk association: ', r.progId);
  console.log('Double-click on the resource manager now to install into Hydra Emulator.');
} else if (action === 'off') {
  unregisterAssociation();
  console.log('Canceled .apk association.');
} else {
  console.log('Usage: nonees/assoc.js [on]|off]');
  process.exit(1);
}
