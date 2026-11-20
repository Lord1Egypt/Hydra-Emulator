'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('hydra', {
  info: () => invoke('app:info'),
  listApps: () => invoke('apps:list'),
  pickApk: () => invoke('apk:pick'),
  parseApk: (p) => invoke('apk:parse', p),
  installApk: (p) => invoke('apk:install', p),
  launch: (pkg) => invoke('app:launch', pkg),
  stop: (pkg) => invoke('app:stop', pkg),
  uninstall: (pkg) => invoke('app:uninstall', pkg),
  createShortcut: (pkg) => invoke('app:shortcut', pkg),
  clearData: (pkg) => invoke('app:clearData', pkg),
  pin: (pkg, pinned) => invoke('app:pin', { pkg, pinned }),
  setAppOrientation: (pkg, orientation) => invoke('app:setOrientation', { pkg, orientation }),
  revealApk: (pkg) => invoke('app:revealApk', pkg),
  revealApkDir: () => invoke('apk:reveal'),
  openDir: () => invoke('dialog:openDir'),

  getSettings: () => invoke('settings:get'),
  setSettings: (patch) => invoke('settings:set', patch),
  restoreSystemApps: () => invoke('settings:restoreSystem'),
  refreshPointerMapping: () => invoke('settings:refreshPointer'),
  restoreMouseHook: () => invoke('settings:unhook'),

  runtimeStatus: () => invoke('runtime:status'),
  runtimeProbe: () => invoke('runtime:probe'),
  runtimeStart: () => invoke('runtime:start'),
  runtimeStop: () => invoke('runtime:stop'),
  runtimeLog: () => invoke('runtime:log'),
  doctorProfile: () => invoke('doctor:profile'),
  doctorReport: () => invoke('doctor:report'),
  vcRedist: () => invoke('runtime:vcRedist'),
  installVcRedist: () => invoke('runtime:installVcRedist'),
  runtimeUsage: () => invoke('runtime:usage'),
  runtimeCleanup: (opts) => invoke('runtime:cleanup', opts || {}),
  runtimeResetData: () => invoke('runtime:resetData'),
  runtimeRepairNetwork: () => invoke('runtime:repairNetwork'),
  runtimeCheckNetwork: () => invoke('runtime:checkNetwork'),
  leftoversScan: () => invoke('leftovers:scan'),
  leftoversClean: (items) => invoke('leftovers:clean', items),
  startupInfo: () => invoke('app:startupInfo'),
  dataInfo: () => invoke('runtime:dataInfo'),
  setDataSize: (gb) => invoke('runtime:setDataSize', gb),
  resources: () => invoke('engine:resources'),
  // Host preflight / auto-configuration
  preflightRun: () => invoke('preflight:run'),
  preflightApply: () => invoke('preflight:apply'),
  // Auto-check (autodebug): periodic collection + evaluation, producing an issue list grouped by category
  autodebugRun: () => invoke('autodebug:run'),
  autodebugState: () => invoke('autodebug:state'),
  autodebugConfig: (patch) => invoke('autodebug:config', patch || {}),
  // Repair actions for auto-check findings
  clearOrphans: () => invoke('app:clearOrphans'),
  clearSnapshot: () => invoke('app:clearSnapshot'),
  restartRuntime: () => invoke('runtime:restart'),
  // Drivers (compatibility patches): list / import / open directory / export host template / enable or disable
  driversList: () => invoke('drivers:list'),
  driversImport: () => invoke('drivers:import'),
  driversOpenFolder: () => invoke('drivers:openFolder'),
  driversExportTemplate: () => invoke('drivers:exportTemplate'),
  driversSetEnabled: (id, enabled) => invoke('drivers:setEnabled', { id, enabled }),

  resetAndResize: (gb) => invoke('runtime:resetAndResize', gb),
  confirm: (opts) => invoke('app:confirm', opts || {}),
  displayState: () => invoke('display:state'),
  displaySet: (patch) => invoke('display:set', patch || {}),
  displayToggle: () => invoke('display:toggle'),
  rebuildShortcuts: () => invoke('shortcut:rebuild'),
  autoDeploy: (opts) => invoke('runtime:autoDeploy', opts || {}),
  startInstaller: () => invoke('runtime:startInstaller'),
  markInstalled: () => invoke('runtime:markInstalled'),
  resetInstall: () => invoke('runtime:resetInstall'),

  provisionCheck: () => invoke('provision:check'),
  provisionProbeSources: () => invoke('provision:probeSources'),
  installAdb: () => invoke('provision:installAdb'),
  installQemu: () => invoke('provision:installQemu'),
  installEmulator: () => invoke('provision:installEmulator'),
  installSysimg: () => invoke('provision:installSysimg'),
  installPlayImage: () => invoke('provision:installPlayImage'),
  installAehd: () => invoke('provision:installAehd'),
  enableAccel: () => invoke('provision:enableAccel'),
  enableVirtualization: () => invoke('provision:enableVirtualization'),
  // Open the "Turn Windows features on or off" dialog (the Store build can only guide the user to tick them manually)
  openWindowsFeatures: () => invoke('provision:openWindowsFeatures'),
  downloadIso: () => invoke('provision:downloadIso'),
  createDisk: (gb) => invoke('provision:createDisk', gb),
  importIso: () => invoke('provision:importIso'),
  importDisk: () => invoke('provision:importDisk'),

  selfCheck: () => invoke('doctor:selfCheck'),
  clearLocks: () => invoke('app:clearLocks'),
  removeSelf: () => invoke('app:removeSelf'),
  setSharedDir: (dir) => invoke('settings:setSharedDir', dir),

  // Online updates (GitHub Releases)
  updateCheck: (opts) => invoke('app:updateCheck', opts || {}),
  updateApply: () => invoke('app:updateApply'),
  updateCancel: () => invoke('app:updateCancel'),
  updateOpenRelease: (url) => invoke('app:updateOpen', url),
  restartApp: () => invoke('app:restart'),

  assocStatus: () => invoke('assoc:status'),
  assocRegister: () => invoke('assoc:register'),
  assocUnregister: () => invoke('assoc:unregister'),

  syncShared: () => invoke('share:sync'),
  openSharedDir: () => invoke('share:open'),

  openExternal: (url) => invoke('shell:open', url),
  // 0.6.2 built-in manual: passing { topic } / { issue } / { error } jumps to the corresponding section
  openManual: (payload) => invoke('manual:open', payload || {}),
  winMinimize: () => invoke('window:minimize'),
  winMaximize: () => invoke('window:maximize'),
  winClose: () => invoke('window:close'),
  winHide: () => invoke('window:hide'),
  bringAppToFront: () => invoke('app:foreground'),

  // APIs used by the app window (only rotate / minimize / maximize / close)
  shell: {
    state: () => invoke('shell:state'),
    minimize: () => invoke('shell:minimize'),
    maximize: () => invoke('shell:maximize'),
    close: () => invoke('shell:close'),
    rotate: () => invoke('shell:rotate'),
    back: () => invoke('shell:back'),
    forward: () => invoke('shell:forward'),
    keyEvent: (key) => invoke('shell:keyEvent', key),
    onState: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('shell:state', handler);
      return () => ipcRenderer.removeListener('shell:state', handler);
    },
  },

  // Android system settings (WiFi / volume / display / animations / permissions …)
  android: {
    status: () => invoke('android:status'),
    set: (key, value) => invoke('android:set', { key, value }),
    open: (action) => invoke('android:open', action),
    tune: (pkg) => invoke('android:tune', pkg),
    permissions: (pkg) => invoke('android:permissions', pkg),
    grantAll: (pkg) => invoke('android:grantAll', pkg),
  },

  // Keymapping (gaming keyboard → touchscreen)
  keymap: {
    getPresets: () => invoke('keymap:getPresets'),
    getMap: (pkg) => invoke('keymap:getMap', pkg),
    setMap: (pkg, mappings) => invoke('keymap:setMap', pkg, mappings),
    setEnabled: (on) => invoke('keymap:setEnabled', on),
    isEnabled: () => invoke('keymap:isEnabled'),
    applyPreset: (pkg, presetId) => invoke('keymap:applyPreset', pkg, presetId),
  },

  pathForFile: (file) => webUtils.getPathForFile(file),

  on: (channel, cb) => {
    const allowed = [
      'install:start', 'install:progress', 'install:done', 'install:error',
      'app:launched', 'runtime:log', 'toast', 'ui:navigate', 'provision:progress',
      'update:progress', 'update:state', 'autodebug:state',
    ];
    if (!allowed.includes(channel)) return () => {};
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
