'use strict';
/**
 * Setup Page UI Smoke Test (requires a real Electric window))
 *
 * Run: electron test/setings-ui-test.js
 * Output: test/out/settings-*.png
 *
 * Why write it alone: the structure of the setup page has just been changed (with class navigation and search)),
 * Pure Node single measure can only verify the source structure, not "point to move, right."
 * Run through it with a real rendering process: Open settings →Cutting Searching for a screenshot.
 */

const { app, ipcMain, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');
const UI = path.join(__dirname, '..', 'src', 'ui');

const SETTINGS = {
  adbPath: '',
  runtime: { isoPath: '', sourcePreference: 'auto', autoMirror: true, giteeToken: '', mirrorPrefix: '', downloadConnections: 8 },
  engine: {
    memoryMB: 4096, cores: 4, idleShutdownMinutes: 15, audio: true, liteMode: true,
    prewarm: true, priorityMode: 'balanced', deepTrim: false, mouseRightBack: true,
    mouseWheelMode: 'smooth', mouseSideButtons: false, keymapEnabled: true,
    resourceMode: 'balanced', renderSize: 'auto', dataPartitionGB: 6, fastDns: true,
    locale: 'en-US', keepSnapshot: true, logLimitKB: 2048,
  },
  display: {
    mode: 'window', portrait: '900x1600', autoFullscreenOnLaunch: false, landscape: false,
    orientationMode: 'auto', autoRotate: true, tabletMode: true, windowEmbed: true,
  },
  createShortcutOnInstall: true,
  createStartMenuShortcut: true,
  shortcutDir: '',
  sharedDir: path.join(process.env.USERPROFILE || '', 'HydraShared'),
  deviceSharedDir: '/sdcard/HydraShared',
  autoStart: true,
  notifyOnInstall: true,
  debug: { auto: true, intervalMin: 10, notify: true },
};

const DEBUG_ISSUES = [
  { code: 'device.unauthorized', category: 'device', severity: 'error', title: 'The Android device is not authorized to debug', hint: 'Reboot the confirmation box when restarting.', fix: 'restartRuntime', detail: '' },
  { code: 'storage.diskLow', category: 'storage', severity: 'warn', title: 'The disk space running is tight', hint: '8 GB.', fix: 'disk', detail: 'Remaining 5120 MB' },
  { code: 'settings.orientationConflict', category: 'settings', severity: 'warn', title: 'Screen orientation policy is opposite to the current panel direction', hint: 'Just change the panel direction to the same strategy.', fix: 'orientation', detail: '' },
];

const OVERRIDES = {
  'settings:get': () => SETTINGS,
  'settings:set': () => SETTINGS,
  'app:info': () => ({ version: '0.6.0', isDev: true, dataDir: 'C:\\data', runtimeDir: 'C:\\data\\runtime' }),
  'apps:list': () => ({ apps: [] }),
  'assoc:status': () => ({ registered: false }),
  'doctor:profile': () => ({ profile: {}, text: 'Balance . 4 Nuclear / 4 GB / 720p' }),
  'doctor:selfCheck': () => ({ issues: [], accel: { ok: true }, free: 102400 }),
  'doctor:report': () => ({ ok: true, file: 'C:\\report.txt' }),
  'runtime:usage': () => ({ totalText: '8.2 GB', reclaimableText: '1.1 GB', count: 3 }),
  'runtime:status': () => ({ mode: 'builtin', backend: 'builtin', backendLabel: 'Inline', installed: true, vmRunning: false, deviceOnline: false, ready: false, phase: 'idle', needsSetup: null, error: '', env: { adb: { ok: true }, emulator: { ok: true }, sysimg: { ok: true } }, accel: { ok: true }, network: null }),
  'runtime:dataInfo': () => ({ avdDir: 'C:\\data\\avd', configuredGB: 6, actualGB: 6 }),
  'android:status': () => ({ running: false, wifi: true, airplane: false, anim: true, volume: 50, font: 1, density: 320 }),
  'drivers:list': () => ({ drivers: [], errors: [] }),
  'preflight:run': () => ({ items: [] }),
  'autodebug:state': () => ({ issues: DEBUG_ISSUES, summary: { total: 3, errors: 1, warns: 2, infos: 0, health: 'error', byCategory: [] }, at: Date.now(), running: false }),
  'autodebug:run': () => ({ issues: DEBUG_ISSUES, summary: { total: 3, errors: 1, warns: 2, infos: 0, health: 'error', byCategory: [] }, at: Date.now(), running: false }),
  'autodebug:config': () => SETTINGS.debug,
  'app:startupInfo': () => ({ firstRun: false, tips: [] }),
  'app:updateCheck': () => ({ ok: true, current: '0.6.0', hasUpdate: false, sources: [] }),
  'runtime:log': () => [],
  'leftovers:scan': () => ({ items: [] }),
  'engine:resources': () => ({ memory: {}, cores: {} }),
  'display:state': () => ({ mode: 'window' }),
  'keymap:getPresets': () => ({ presets: [] }),
  'keymap:isEnabled': () => ({ enabled: true }),
};

// The remaining channel returns the empty object uniformly: all calls in app.js are .catch/ empty
const CHANNELS = [
  'apk:pick', 'apk:parse', 'apk:install', 'apk:reveal', 'dialog:openDir',
  'settings:restoreSystem', 'settings:refreshPointer', 'settings:unhook', 'settings:setSharedDir',
  'runtime:probe', 'runtime:start', 'runtime:stop', 'runtime:vcRedist', 'runtime:installVcRedist',
  'runtime:cleanup', 'runtime:resetData', 'runtime:repairNetwork', 'runtime:checkNetwork',
  'runtime:setDataSize', 'runtime:resetAndResize', 'runtime:autoDeploy', 'runtime:startInstaller',
  'runtime:markInstalled', 'runtime:resetInstall', 'app:confirm', 'display:set', 'display:toggle',
  'shortcut:rebuild', 'preflight:apply', 'drivers:import', 'drivers:openFolder',
  'drivers:exportTemplate', 'drivers:setEnabled', 'app:clearLocks', 'app:removeSelf',
  'app:clearOrphans', 'app:clearSnapshot', 'runtime:restart', 'assoc:register', 'assoc:unregister',
  'share:sync', 'share:open', 'shell:open', 'window:minimize', 'window:maximize', 'window:close',
  'window:hide', 'app:foreground', 'app:updateApply', 'app:updateCancel', 'app:updateOpen',
  'app:restart', 'app:pin', 'app:setOrientation', 'app:launch', 'app:stop', 'app:uninstall',
  'app:createShortcut', 'app:clearData', 'app:revealApk', 'android:set', 'android:open',
  'android:tune', 'android:permissions', 'android:grantAll', 'keymap:getMap', 'keymap:setMap',
  'keymap:setEnabled', 'keymap:applyPreset', 'leftovers:clean', 'provision:check',
  'provision:probeSources', 'provision:installAdb', 'provision:installQemu', 'provision:installEmulator',
  'provision:installSysimg', 'provision:installPlayImage', 'provision:installAehd',
  'provision:enableAccel', 'provision:enableVirtualization', 'provision:openWindowsFeatures',
  'provision:downloadIso', 'provision:createDisk', 'provision:importIso', 'provision:importDisk',
];

let passed = 0;
let failed = 0;
function step(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${name}${detail ? ` ${detail}` : ''}`); } else { failed++; console.error(`  ✗ ${name}${detail ? ` ${detail}` : ''}`); }
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  for (const ch of CHANNELS) ipcMain.handle(ch, async () => ({}));
  for (const [ch, fn] of Object.entries(OVERRIDES)) ipcMain.handle(ch, async (_e, ...args) => fn(...args));

  const win = new BrowserWindow({
    width: 1180, height: 860, show: false,
    backgroundColor: '#f4f7f5',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message);   // 2=warning, 3=error
  });
  await win.loadFile(path.join(UI, 'index.html'));
  await new Promise((r) => setTimeout(r, 1200));

  const evalJs = (code) => win.webContents.executeJavaScript(code, true);

  console.log('\n[Setup Page • Class Navigator]');
  // Open the set window first (auto-detection results are rendered when opening the setup))
  await evalJs(`document.getElementById('btnSettings').click()`);
  await new Promise((r) => setTimeout(r, 900));
  const modalOpen = await evalJs(`document.getElementById('settingsMask').classList.contains('on')`);
  step('Set the window to open', modalOpen);

  const navInfo = await evalJs(`(() => ({
    items: document.querySelectorAll('#setNav .set-nav-item').length,
    cats: Array.from(document.querySelectorAll('#setNav .set-nav-item')).map(b => b.dataset.cat),
    groups: document.querySelectorAll('#settingsBody [data-cat]').length,
    visible: Array.from(document.querySelectorAll('#settingsBody [data-cat]')).filter(g => !g.hidden).map(g => g.dataset.cat),
  }))()`);
  step('The navigation line has been redacted.', navInfo.items === 9, `${navInfo.items} Item`);
  step('There\'s a laboratory classification.', navInfo.cats.indexOf('lab') >= 0, navInfo.cats.join(','));
  // Note: Classifications will be remembered, so only the assertion is that “only one group of classifications will be shown at the same time”
  const oneCat = navInfo.visible.length > 0 && navInfo.visible.every((c) => c === navInfo.visible[0]);
  step('Show only one group of categories at the same time', oneCat, `Default Visible: ${navInfo.visible.join(',')}`);

  // Point " Show with Window "
  await evalJs(`document.querySelector('#setNav .set-nav-item[data-cat="display"]').click()`);
  await new Promise((r) => setTimeout(r, 300));
  const afterSwitch = await evalJs(`(() => ({
    visible: Array.from(document.querySelectorAll('#settingsBody [data-cat]')).filter(g => !g.hidden).map(g => g.dataset.cat),
    on: document.querySelector('#setNav .set-nav-item.on') ? document.querySelector('#setNav .set-nav-item.on').dataset.cat : '',
  }))()`);
  step('Show only the category after “ Show and Window “', afterSwitch.visible.length > 0 && afterSwitch.visible.every((c) => c === 'display'), `Visible: ${afterSwitch.visible.join(',')}`);
  step('Navigator Highlights and switch', afterSwitch.on === 'display', `Highlight: ${afterSwitch.on}`);

  await win.capturePage().then((img) => fs.writeFileSync(path.join(OUT, 'settings-display.png'), img.toPNG()));

  // Dot “laborator,“ look at the switch.
  await evalJs(`document.querySelector('#setNav .set-nav-item[data-cat="lab"]').click()`);
  await new Promise((r) => setTimeout(r, 300));
  const lab = await evalJs(`(() => ({
    visible: Array.from(document.querySelectorAll('#settingsBody [data-cat]')).filter(g => !g.hidden).map(g => g.dataset.cat),
    hasSwitch: !!document.getElementById('setMultiWindow'),
    hasKeep: !!document.getElementById('setKeepBackground'),
    notice: (document.querySelector('#labGroup .lab-notice') || {}).textContent || '',
  }))()`);
  step('To “laborator“ shows only this classification', lab.visible.length > 0 && lab.visible.every((c) => c === 'lab'), `Visible: ${lab.visible.join(',')}`);
  step('How many switches and backstages are kept in the lab?', lab.hasSwitch && lab.hasKeep, `switch=${lab.hasSwitch} keep=${lab.hasKeep}`);
  step(' There\'s an experimental tip in the lab.', /experimental/i.test(lab.notice), lab.notice.slice(0, 30));

  // Point "Diagnosing and Fixing", check the automatic detection panel.
  await evalJs(`document.querySelector('#setNav .set-nav-item[data-cat="diag"]').click()`);
  await new Promise((r) => setTimeout(r, 400));
  const diag = await evalJs(`(() => ({
    visible: Array.from(document.querySelectorAll('#settingsBody [data-cat]')).filter(g => !g.hidden).map(g => g.dataset.cat),
    items: document.querySelectorAll('#autodebugList .dbg-item').length,
    groups: document.querySelectorAll('#autodebugList .dbg-group').length,
    text: (document.getElementById('autodebugStateText') || {}).textContent || '',
    fixBtns: Array.from(document.querySelectorAll('#autodebugList .dbg-fix')).filter(b => b.textContent === 'Fix').length,
    helpBtns: Array.from(document.querySelectorAll('#autodebugList .dbg-help')).filter(b => b.textContent === 'Help').length,
  }))()`);
  step('We’ll see a medical checkup on the machine under “Default and Repair“, drive and autotest.', diag.visible.includes('diag') && diag.visible.length === 3, `Visible: ${diag.visible.join(',')}`);
  step('Auto-check results are rendered by grouping by categories', diag.groups >= 3 && diag.items === 3, `${diag.groups} Group / ${diag.items} Item`);
  step('Every problem has a "handle" button.', diag.fixBtns === 3 && diag.helpBtns === 3, `${diag.fixBtns} Button`);
  step('Status Line Show Last Test Time', /Last checked/i.test(diag.text), diag.text);

  // Go to auto-detect the panel re-capture (synthesizing) to keep up, avoid getting a frame.)
  await evalJs(`document.getElementById('autodebugGroup').scrollIntoView({ block: 'start' })`);
  await new Promise((r) => setTimeout(r, 900));
  await win.capturePage().then((img) => fs.writeFileSync(path.join(OUT, 'settings-diag.png'), img.toPNG()));

  console.log('\n[Setup Page & Search]');
  await evalJs(`(() => { const s = document.getElementById('setSearch'); s.value = 'landscape'; s.dispatchEvent(new Event('input')); })()`);
  await new Promise((r) => setTimeout(r, 300));
  const search = await evalJs(`(() => ({
    visible: Array.from(document.querySelectorAll('#settingsBody [data-cat]')).filter(g => !g.hidden).length,
    names: Array.from(document.querySelectorAll('#settingsBody [data-cat]')).filter(g => !g.hidden).map(g => (g.querySelector('.group-title')||{}).textContent),
    clearVisible: !document.getElementById('btnClearSearch').hidden,
  }))()`);
  step('Searching for screens to hit groups', search.visible >= 1, `Hit! ${search.visible} One.: ${search.names.join(' / ')}`);
  step('Hits are visible across categories (not blocked by the current category))', search.visible >= 1);
  step('Clear buttons appear', search.clearVisible);

  await win.capturePage().then((img) => fs.writeFileSync(path.join(OUT, 'settings-search.png'), img.toPNG()));

  await evalJs(`document.getElementById('btnClearSearch').click()`);
  await new Promise((r) => setTimeout(r, 250));
  const afterClear = await evalJs(`(() => Array.from(document.querySelectorAll('#settingsBody [data-cat]')).filter(g => !g.hidden).map(g => g.dataset.cat))()`);
  step('Clear the search and return to the current category', afterClear.length > 0 && afterClear.every((c) => c === 'diag'), `Visible: ${afterClear.join(',')}`);

  console.log('\n[Setup Page • Memory Classification]');
  const remembered = await evalJs(`localStorage.getItem('hydra.settings.cat')`);
  step('The last time we stayed in the class was remembered.', remembered === 'diag', ` Got it.: ${remembered}`);

  console.log('\n[Set Page . Rendering is not abnormal]');
  await evalJs(`document.querySelector('#setNav .set-nav-item[data-cat="about"]').click()`);
  const about = await evalJs(`(() => ({
    visible: !document.getElementById('aboutGroup').hidden,
    version: document.getElementById('aboutVer').textContent,
    manual: document.getElementById('btnOpenManual').textContent,
    sourceLink: document.querySelector('#aboutGroup a').getAttribute('href'),
    logoDecoded: document.querySelector('#aboutGroup .about-logo').naturalWidth > 0,
    lang: document.documentElement.lang,
  }))()`);
  step('About shows the English manual, Hydra artwork, build version, and source link',
    about.visible && about.version === 'v0.6.0' && about.manual === 'User Manual'
    && about.sourceLink.endsWith('/Hydra-Emulator') && about.logoDecoded && about.lang === 'en');
  await new Promise((r) => setTimeout(r, 250));
  await win.capturePage().then((img) => fs.writeFileSync(path.join(OUT, 'settings-about.png'), img.toPNG()));

  const realErrors = errors.filter((e) => !/Autofill|devtools|Request Autofill/i.test(e));
  step('Control’s got nothing wrong with it.', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  console.log(`\n Result: ${passed} Through, ${failed}  Failed`);
  app.exit(failed ? 1 : 0);
}).catch((e) => {
  console.error(e);
  app.exit(1);
});
