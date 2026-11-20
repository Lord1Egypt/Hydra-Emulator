// Explorer entrance: Only minimal Elementron initialization, and then hand over the work. /embed-probe.js
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const LOG = path.join(__dirname, '..', '..', '..', '.probe', 'boot.txt');
function mark(m) { try { fs.appendFileSync(LOG, m + ' ' + new Date().toISOString() + '\n'); } catch (_) {} }
try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.writeFileSync(LOG, ''); } catch (_) {}
mark('module-loaded');

// The subprocess will run this script (-type=renderer/gpu/...) without any involvement in the main process.
if (process.argv.some((a) => a.startsWith('--type='))) {
  module.exports = {};
} else {
  process.on('uncaughtException', (e) => { mark('UNCAUGHT ' + (e && e.stack || e)); });

  mark('before-whenReady');
  app.whenReady().then(async () => {
    mark('ready');
    try {
      const { run } = require('../embed-probe.js');
      await run(path.join(__dirname, '..', '..'));
      mark('done');
      app.exit(0);
    } catch (e) {
      mark('ERR ' + (e && e.stack || e));
      app.exit(1);
    }
  });
  app.on('window-all-closed', () => {});
}
