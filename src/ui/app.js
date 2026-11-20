'use strict';

const api = window.hydra;
const $ = (id) => document.getElementById(id);

const state = {
  apps: [],
  settings: null,
  status: null,
  filter: '',
  installing: false,
  setupBusy: null,
  menuPkg: null,
};

/* Tools - - - - - */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function initialOf(label) {
  const t = String(label || '?').trim();
  return (t[0] || '?').toUpperCase();
}

function fmtSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}

function relTime(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60000) return 'Just now';
  if (d < 3600000) return `${Math.floor(d / 60000)} min ago`;
  if (d < 86400000) return `${Math.floor(d / 3600000)} hr ago`;
  if (d < 86400000 * 30) return `${Math.floor(d / 86400000)} days ago`;
  return new Date(ts).toLocaleDateString('en-US');
}

/**
 * Mini-Toart
 *
 * The same type of messages are weighed + the maximum number:
 * When the installation failed, there was a running-time start-up log that was being pushed on an ongoing basis, and each of the previous articles was previously created with a new toast,
 * And so the screens were stacked with the same error, and it looked like "failure information keeps going around."
 */
let _toastSeq = 0;
function toast({ title, body = '', type = 'info', progress = null, sticky = false, spinner = false }) {
  const wrap = $('toastWrap');
  // 1 de-heavy: same title + text only refreshs that one, not add
  const key = `${title}|${body}`;
  const dup = [...wrap.children].find((n) => n.dataset.key === key && Date.now() - Number(n.dataset.at || 0) < 4000);
  if (dup) {
    dup.dataset.at = String(Date.now());
    return {
      el: dup,
      dismiss: () => dup.remove(),
      update: ({ title: t2, body: b2 } = {}) => {
        if (t2 !== undefined) dup.querySelector('.t-title-text').textContent = t2;
        if (b2 !== undefined) dup.querySelector('.t-body').textContent = b2;
      },
    };
  }
  // Two caps: up to four at the same time, exceeding the old one first.
  while (wrap.children.length >= 4) wrap.firstElementChild.remove();

  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : ''}`;
  el.dataset.key = key;
  el.dataset.at = String(Date.now());
  el.dataset.seq = String(++_toastSeq);
  el.innerHTML = `
    <div class="t-title">
      ${spinner ? '<span class="spinner"></span>' : ''}
      <span class="t-title-text">${esc(title)}</span>
    </div>
    <div class="t-body">${esc(body)}</div>
    ${progress === null ? '' : '<div class="bar"><i></i></div>'}
  `;
  $('toastWrap').appendChild(el);

  const dismiss = () => {
    el.style.transition = 'opacity .18s, transform .18s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(4px)';
    setTimeout(() => el.remove(), 200);
  };

  const ctl = {
    el, dismiss,
    update({ title: t2, body: b2, progress: p2, type: ty } = {}) {
      if (t2 !== undefined) el.querySelector('.t-title-text').textContent = t2;
      if (b2 !== undefined) el.querySelector('.t-body').textContent = b2;
      if (p2 !== undefined && el.querySelector('.bar i')) {
        el.querySelector('.bar i').style.width = `${Math.max(2, Math.min(100, p2))}%`;
      }
      if (ty === 'error') el.classList.add('error');
      if (ty === 'ok') {
        el.querySelector('.spinner')?.remove();
        el.classList.remove('error');
      }
    },
  };

  if (!sticky) setTimeout(dismiss, type === 'error' ? 6000 : 3200);
  return ctl;
}

/* ----------------------------------------------------------------------------------------------------- */

/** open built-in manual;maping from main process to corresponding chapter when sending trouble messages */
function openManual(payload) {
  if (!api || typeof api.openManual !== 'function') return Promise.resolve(null);
  return api.openManual(payload || { topic: 'overview' }).catch(() => null);
}

/** Reciprocal lesson. */
function openManualForIssue(issue, reason = 'clicked') {
  if (!issue) return openManual({ topic: 'overview', reason });
  return openManual({
    issue: issue.code,
    title: issue.title,
    detail: issue.detail,
    reason,
  });
}

/** Install/run the original error report corresponding course */
function openManualForError(message, reason = 'install-failed') {
  return openManual({ error: message, reason });
}

/* ---------------- */

function visibleApps() {
  const q = state.filter.trim().toLowerCase();
  if (!q) return state.apps;
  return state.apps.filter((a) => (
    a.label.toLowerCase().includes(q)
    || a.package.toLowerCase().includes(q)
  ));
}

function renderGrid() {
  const apps = visibleApps();
  const grid = $('grid');
  const empty = $('empty');

  const hasAny = state.apps.length > 0;
  grid.classList.toggle('hidden', apps.length === 0);
  empty.classList.toggle('hidden', apps.length > 0);

  if (!hasAny) {
    const s = state.status;
    $('emptyHint').textContent = s && s.adbOk === false
      ? 'For the first time: Open the upper right corner settings Run one key to complete, and then come back and install the application.'
      : 'Hint: All applications are shared with Android when running, so the start of the second application is almost instantaneous.';
    grid.innerHTML = '';
    return;
  }

  // Add an application of the dotted card at the end.
  // The purpose is not just to look good: when applications are low, there is a big blank below, and users don’t know what to do.
  // This card puts the “and drag the APK in“ thing right in front of us and fills the blanks.
  grid.innerHTML = apps.map((a) => `
    <div class="card" data-pkg="${esc(a.package)}" title="${esc(a.label)} · ${esc(a.package)}">
      ${a.pinned ? '<span class="pin">★</span>' : ''}
      ${a.running ? '<span class="badge-run" title="Running"></span>' : ''}
      <div class="icon">
        ${a.iconUrl
          ? `<img src="${esc(a.iconUrl)}" alt="" draggable="false" />`
          : `<div class="fallback" style="background:${esc(a.accent || '#9aa6b2')}">${esc(initialOf(a.label))}</div>`}
      </div>
      <div class="name">${esc(a.label)}</div>
      <div class="meta">${a.running ? 'Running' : `v${esc(a.versionName)}${a.lastLaunchAt ? ' · ' + relTime(a.lastLaunchAt) : ''}`}</div>
      <div class="open-hint">${a.running ? 'Bring to front' : 'Open'}</div>
    </div>
  `).join('') + `
    <div class="card card-add" id="cardAdd" role="button" tabindex="0" title="Drop an APK or click to browse">
      <div class="add-plus" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round"><path d="M12 6v12"/><path d="M6 12h12"/></svg>
      </div>
      <div class="name">Add an app</div>
      <div class="meta">Drop an APK to install it</div>
    </div>
  `;
}

/* ---------- Data updating-------------------------------------------------------------------------------------------------------------------------------- */

async function refreshApps() {
  try {
    state.apps = await api.listApps();
    renderGrid();
    updateStats();
  } catch (e) {
    console.error(e);
  }
}

function updateStats() {
  const n = state.apps.length;
  $('statusStats').textContent = n ? `${n} apps` : 'No apps installed';
}

async function refreshStatus() {
  try {
    state.status = await api.runtimeStatus();
    const s = state.status;
    const dot = $('statusDot');
    const text = $('statusText');
    const tag = $('engineTag');

    if (!s.adbOk) {
      dot.className = 'dot err';
      text.textContent = 'Android runtime needs setup. Open Settings → General & Installation';
      tag.textContent = 'Setup required';
      tag.className = 'brand-tag';
    } else if (s.deviceOnline) {
      dot.className = 'dot ok';
      text.textContent = `Runtime ready · Android ${s.android || '?'}${s.freeform ? ' · App windows enabled' : ''}`;
      tag.textContent = `Android ${s.android || ''}`.trim();
      tag.className = 'brand-tag ok';
    } else if (s.phase === 'booting' || s.vmStarting) {
      dot.className = 'dot warn';
      text.textContent = 'Starting Android…';
      tag.textContent = 'Starting';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'accel') {
      dot.className = 'dot warn';
      // Just say "how to fix" instead of "not open" -- that’s the most visible position on the status strip.
      text.textContent = 'Hardware acceleration is unavailable. Hydra is using software emulation. Open Diagnostics & Fixes to check acceleration';
      tag.textContent = 'Software emulation';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'sysimg') {
      dot.className = 'dot err';
      text.textContent = 'Android 14 image is missing. Use Settings → General & Installation to download it.';
      tag.textContent = 'Image required';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'emulator') {
      dot.className = 'dot err';
      text.textContent = 'Android runtime is missing. Open Settings → General & Installation to set it up';
      tag.textContent = 'Setup required';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'boot') {
      dot.className = 'dot warn';
      text.textContent = 'Runtime ready. Installing an APK or opening an app will start Android';
      tag.textContent = 'Ready to start';
      tag.className = 'brand-tag';
    } else if (s.installing) {
      dot.className = 'dot warn';
      text.textContent = 'Complete Android installation in the virtual machine window';
      tag.textContent = 'Installing';
      tag.className = 'brand-tag';
    } else {
      dot.className = 'dot';
      text.textContent = s.installed
        ? 'When running (installation or opening application))'
        : 'Android is missing. Open Settings → General & Installation to continue';
      tag.textContent = s.installed ? 'Idle' : 'Installation required';
      tag.className = 'brand-tag';
    }
    $('statusDevice').textContent = s.deviceOnline ? (s.serial || '') : '';
    // Network status: This is the most easy pit for users to step on.
    // Put it directly in the status bar, see it at the moment of the problem, and don’t have to look at the log.
    const netEl = $('statusNet');
    const netSep = $('statusNetSep');
    if (netEl) {
      const show = !!s.deviceOnline && !!s.network;
      netEl.hidden = !show;
      if (netSep) netSep.hidden = !show;
      if (show) {
        netEl.textContent = s.network.ok ? `Network connected ${s.network.ip || ''}`.trim() : 'Android is offline';
        netEl.className = 'status-item status-net ' + (s.network.ok ? 'ok' : 'warn');
        netEl.title = s.network.ok
          ? 'Android has a network connection'
          : 'Android is offline. Use the network repair under Diagnostics & Fixes';
      }
    }

    renderSetup(s);
  } catch (e) {
    $('statusText').textContent = `Status check failed: ${e.message}`;
  }
}

/* -------------------------------------------------------------------------------------------------------------------------------------------- */

/**
 * The operating/deployment/self-check panel is now embedded in the Settings and the main interface only allows installed applications.
 * Keep showSetup for tray menus to repeat with ui: navigate, semantic change to "open settings and position them when running."
 */
function showSetup(on) {
  if (!on) { $('setupGuide').hidden = true; return; }
  openSettings().then(() => {
    focusGroup($('runtimeGroup'));
  }).catch(() => {});
}

function fmtGB(n) { return n ? `${(n / 1073741824).toFixed(2)} GB` : ''; }

function stepRow(opt) {
  const cls = ['step'];
  if (opt.done) cls.push('done');
  if (opt.busy) cls.push('busy');
  return `
    <div class="${cls.join(' ')}" data-step="${opt.key}">
      <div class="idx">${opt.done ? '✓' : opt.index}</div>
      <div class="body">
        <div class="t">${esc(opt.title)}${opt.tag ? `<span class="tag ${opt.req ? 'req' : ''}">${esc(opt.tag)}</span>` : ''}</div>
        <div class="d" data-desc>${esc(opt.desc)}</div>
        <div class="bar"><i data-bar></i></div>
      </div>
      <div class="act">${opt.actions || ''}</div>
    </div>`;
}

function renderSetup(s) {
  if (!s) return;
  const env = s.env || {};
  const hv = env.hypervisor || {};
  const accel = env.accel || s.accel || {};

  // Start with installed application: no more deployment wizard screens to take over the main interface,
  // The state is only displayed on the running panel + bottom status bar in the settings.
  const accelOk = accel.ok || hv.whpx;
  const adbDone = !!(env.adb && env.adb.ok);
  const emuDone0 = !!(env.emulator && env.emulator.ok);
  const imgDone0 = !!(env.sysimg && env.sysimg.ok);
  const allDone0 = adbDone && emuDone0 && imgDone0;
  const stateText = $('setupStateText');
  if (stateText) {
    const missing = [];
    if (!adbDone) missing.push('adb');
    if (!emuDone0) missing.push('Engine');
    if (!imgDone0) missing.push('System image');
    stateText.textContent = s.deviceOnline
      ? `Ready · Android ${s.android || ''}`
      : s.phase === 'booting' || s.vmStarting
        ? 'Starting Android…'
        : allDone0
          ? 'Full assembly • To be activated (self lifted when application is open))'
          : `Missing ${missing.join(', ')}${accelOk ? '' : '(Hardware acceleration unavailable. Using software emulation)'}`;
    stateText.title = s.autoProfile || accel.note || hv.note || '';
  }

  const emuDone = !!(env.emulator && env.emulator.ok);
  const imgDone = !!(env.sysimg && env.sysimg.ok);
  const busy = state.setupBusy;
  const booting = s.phase === 'booting';

  // Keep only one step: download, parameter adapt, all set by "one key complete",
  // And the first start will automatically run in the backstage, and the user will not have to click gradually.
  const allDone = !!(env.adb && env.adb.ok) && emuDone && imgDone;
  const left = [];
  if (!(env.adb && env.adb.ok)) left.push('ADB tools');
  if (!emuDone) left.push('Android runtime');
  if (!imgDone) left.push('System image');
  const step = {
    key: 'all',
    index: 1,
    title: allDone ? 'Ready' : 'Auto Setup',
    tag: allDone ? 'Setup complete' : 'Auto',
    done: allDone,
    busy: !!busy,
    desc: s.deviceOnline
      ? `Android ${s.android || ''} is ready. App windows adjust to the display`
      : booting
        ? 'Starting Android…'
        : allDone
          ? 'Runtime ready. Open an APK or app shortcut to start Android'
          : `Still needed: ${left.join(', ')};point "one key complete " , will be installed at the backstage and will be turned on automatically`,
    actions: s.deviceOnline
      ? '<button class="btn ghost sm" data-act="vmStop">Stop runtime</button>'
      : '',
  };

  $('setupSteps').innerHTML = stepRow(step);
  $('btnDeployAll').disabled = !!busy;
  $('btnDeployAll').textContent = busy ? 'Preparing…' : (allDone ? 'Setup complete · Check again' : 'Auto Setup');
  // "Why didn't you get up last time" gives priority to the failure record of the fall drive: the diagnosis in the memory after the process restarts is empty,
  // Just showing that autoProfile will make the user completely invisible (issuue #20#25 report).
  const lf = s.lastFailure;
  const lastMsg = (lf && lf.diagnosis && lf.diagnosis.title)
    ? `Previous startup failed: ${lf.diagnosis.title}`
    : (s.diagnosis ? `Previous startup diagnosis: ${s.diagnosis.title}` : '');
  $('setupNote').textContent = lastMsg
    || s.autoProfile || 'Auto Setup selects the Android image, acceleration, and memory settings';
}

function store_getDiskSize() {
  return (state.settings && state.settings.runtime && state.settings.runtime.diskSizeGB) || 24;
}

function setStepBusy(key, on) {
  state.setupBusy = on ? key : null;
  // Five steps have been merged into one line, and all the substeps are on this only step.
  const row = $('setupSteps').querySelector('[data-step="all"]');
  if (row) {
    row.classList.toggle('busy', !!on);
    if (on) {
      const bar = row.querySelector('[data-bar]');
      if (bar) bar.style.width = '3%';
    }
  }
}

function updateStepProgress(component, p) {
  if (!component) return;
  const row = $('setupSteps').querySelector('[data-step="all"]');
  if (!row) return;
  if (p.percent !== undefined) {
    const bar = row.querySelector('[data-bar]');
    if (bar) bar.style.width = `${Math.max(3, Math.min(100, p.percent))}%`;
  }
  if (p.message) {
    const d = row.querySelector('[data-desc]');
    if (d) d.textContent = p.message;
  }
}

async function deployAll() {
  if (state.setupBusy) return;
  setStepBusy('all', true);
  try {
    // A call to complete the adb / engine / system image at once, showing progress in the only line.
    // The user point "Step One" is a clear manual retry, bypassing failure cooling
    const r = await api.autoDeploy({ force: true });
    if (!r || !r.ok) {
      toast({ title: 'Setup failed', body: (r && r.error) || 'Check your connection and try again', type: 'error', sticky: true });
      return;
    }
    await refreshStatus();
    toast({ title: 'Components ready. Starting Android…', body: 'The first time is about 1 to 3 minutes, and the next few seconds.', type: 'info' });
    const started = await api.runtimeStart();
    await refreshStatus();
    toast(started && started.ok
      ? { title: 'Runtime ready', body: 'Now drag the APK into the window, or double click the desktop icon.', type: 'ok' }
      : { title: 'Android did not finish starting', body: (started && started.error) || 'Export a diagnostic report for details', type: 'error', sticky: true });
  } catch (e) {
    toast({ title: 'Setup failed', body: e.message, type: 'error', sticky: true });
  } finally {
    setStepBusy('all', false);
    await refreshStatus();
    selfCheck();
  }
}

async function runStep(key) {
  if (state.setupBusy) return { ok: false, error: 'Runtime setup is already in progress' };
  setStepBusy(key, true);
  let r;
  try {
    if (key === 'adb') r = await api.installAdb();
    else if (key === 'emulator') r = await api.installEmulator();
    else if (key === 'sysimg') r = await api.installSysimg();
    else if (key === 'accel') {
      const t = toast({
        title: 'Installing the hardware acceleration driver…',
        body: 'Choose Yes at the Windows permission prompt',
        sticky: true,
        spinner: true,
      });
      r = await api.enableAccel();
      if (r.ok) t.update({ title: 'Hardware acceleration enabled', type: 'ok' });
      else t.update({ title: 'Hardware acceleration unavailable', body: r.error, type: 'error', sticky: true });
    } else if (key === 'qemu') r = await api.installQemu();
    else if (key === 'iso') r = await api.downloadIso();
    else if (key === 'disk') r = await api.createDisk(store_getDiskSize());
    else r = { ok: false, error: 'Unknown setup step' };
  } catch (e) {
    r = { ok: false, error: e.message };
  }
  setStepBusy(key, false);
  await refreshStatus();
  return r;
}

async function startInstall() {
  const r = await api.startInstaller();
  if (!r.ok) {
    toast({ title: 'Could not start the installer', body: r.error, type: 'error', sticky: true });
    return;
  }
  $('setupGuide').hidden = false;
  $('setupGuide').scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast({ title: 'Virtual machine opened', body: 'Press 6 below to complete installation; reload the rear point "I have installed"', type: 'ok', sticky: true });
}

async function markInstalled() {
  await api.markInstalled();
  await api.runtimeStop();
  $('setupGuide').hidden = true;
  await refreshStatus();
  toast({ title: 'Android installation complete', body: 'Now you can just drag the APK in and install it.', type: 'ok' });
}



/* ------------------- */

/** Add recovery steps to common APK installation errors. */
function friendlyInstallErrorText(msg) {
  const error = String(msg || 'Unknown error');
  if (/INSUFFICIENT_STORAGE|not enough space|ENOSPC/i.test(error)) {
    return `${error}\nIncrease the Android data partition under Settings → Performance & Resources, then select Expand Data Partition Now.`;
  }
  if (/NO_MATCHING_ABIS/i.test(error)) {
    return `${error}\nCheck that the Android 14 compatible image is installed, then see the ARM section of the user manual.`;
  }
  if (/INSTALL_FAILED_ALREADY_EXISTS|INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(error)) {
    return `${error}\nThe existing app has a different signature. Use an APK signed by the same developer, or uninstall the existing app first.`;
  }
  if (/INSTALL_FAILED_VERSION_DOWNGRADE/i.test(error)) {
    return `${error}\nA newer version is already installed. Use a newer APK or uninstall the current version first.`;
  }
  if (/ERR_FS_FILE_TOO_LARGE|greater than possible Buffer|Cannot allocate|ENOMEM|out of memory/i.test(error)) {
    return `${error}\nCheck available disk space and memory, then try again from a short path such as C:/APK/app.apk.`;
  }
  return error;
}

async function installFiles(paths) {
  if (!paths || !paths.length) return;
  if (state.installing) {
    toast({ title: 'Another installation is in progress', body: 'Please continue until the current application is complete.' });
    return;
  }
  state.installing = true;
  let ok = 0;
  let failed = 0;

  for (const p of paths) {
    const name = p.split(/[\\/]/).pop();
    const t = toast({ title: `Installing ${name}`, body: 'Reading APK…', progress: 8, sticky: true, spinner: true });
    installToast = t;
    let off = () => {};
    try {
      off = api.on('install:progress', (pr) => {
        const base = { parse: 12, 'parse-done': 24, runtime: 38, install: 62, shortcut: 88, done: 100 }[pr.stage] || 50;
        const pct = pr.percent != null ? Math.min(60, Math.round((pr.percent / 100) * 60)) : base;
        t.update({ title: pr.meta ? `Installing ${pr.meta.label}` : `Installing ${name}`, body: pr.message, progress: pct });
      });
      const r = await api.installApk(p);
      t.update({ title: `${r.app.label} installed`, body: r.app.shortcutPath ? 'Desktop shortcuts have been created and open directly by double-click.' : 'You can create desktop shortcuts using the card ’s right key.', progress: 100, type: 'ok' });
      t.el.querySelector('.spinner')?.remove();
      setTimeout(t.dismiss, 3600);
      if (r.warnings && r.warnings.length) {
        toast({ title: `${r.app.label} compatibility notice`, body: r.warnings.join(' '), type: 'error', sticky: false });
      }
      ok++;
    } catch (e) {
      failed++;
      // Put that sticky tip off, or it’s going to go round and round, and it’s going to go on.
      // runtime log refresh -- the user sees "failure information always looped."
      // The error hint is harmonized by the following install:error listener (with file name and reason for Chinese)),
      // There’s no more playing one here.
      try { off(); } catch (_) { /* ignore */ }
      t.dismiss();
      if (installToast === t) installToast = null;
    } finally {
      try { off(); } catch (_) { /* ignore */ }
    }
  }

  state.installing = false;
  await refreshApps();
  if (ok && !failed) $('search').value = '';
}

/* ----------------------- */

async function launchApp(pkg) {
  const app = state.apps.find((a) => a.package === pkg);
  state.launchPkg = pkg;
  const t = toast({
    title: `Opening ${app ? app.label : pkg}`,
    body: 'Starting the Android runtime. This may take a moment…',
    sticky: true,
    spinner: true,
  });
  const r = await api.launch(pkg);
  if (r.ok) {
    // Apply with its own window, the main interface is automatically closed; here only a hint is left, and the window is hidden
    t.update({ title: 'App started', body: 'Applying in stand-alone window (top rotateable screen).', type: 'ok' });
    setTimeout(t.dismiss, 1600);
    setTimeout(() => api.winHide(), 900);
    setTimeout(refreshApps, 1200);
  } else {
    t.update({ title: 'Startup failed', body: r.error, type: 'error' });
    setTimeout(t.dismiss, 6000);
  }
}

async function createShortcut(pkg) {
  try {
    const r = await api.createShortcut(pkg);
    toast({ title: 'Desktop shortcut created', body: r.path, type: 'ok' });
    refreshApps();
  } catch (e) {
    toast({ title: 'Could not create the shortcut', body: e.message, type: 'error' });
  }
}

async function uninstall(pkg) {
  const app = state.apps.find((a) => a.package === pkg);
  if (!app) return;
  const ok = window.confirm(`Determines to Unmount${app.label}”?\n\n Applying data will be cleared together, and desktop shortcuts will be removed.`);
  if (!ok) return;
  try {
    await api.uninstall(pkg);
    toast({ title: 'App uninstalled', body: app.label, type: 'ok' });
    refreshApps();
  } catch (e) {
    toast({ title: 'Uninstall failed', body: e.message, type: 'error' });
  }
}

/* -------- right-key menu-------------------------------------------------------------------------------------------------------------------------------- */

const MENU_ITEMS = [
  { key: 'open', label: 'Open app', kbd: 'Enter' },
  // Only happens when you apply it (see filters in showmenu).
  // There was no such thing, and there was no pointable shut-down button under stand-alone window mode.,
  // If you apply it together, you can’t turn it off.
  { key: 'stop', label: 'Close app', onlyRunning: true },
  { key: 'shortcut', label: 'Create desktop shortcut' },
  { key: 'orientation', label: 'Landscape / Portrait' },
  { key: 'pin', label: 'Pin to top' },
  { key: 'keymap', label: 'Key mapping…' },
  { divider: true },
  { key: 'reveal', label: 'Show APK in File Explorer' },
  { key: 'clear', label: 'Clear app data' },
  { divider: true },
  { key: 'uninstall', label: 'Uninstall', danger: true },
];

function showMenu(x, y, pkg) {
  const menu = $('ctxmenu');
  state.menuPkg = pkg;
  const app = state.apps.find((a) => a.package === pkg);
  const items = MENU_ITEMS.filter((it) => !it.onlyRunning || (app && app.running));
  menu.innerHTML = items.map((it) => {
    if (it.divider) return '<div class="divider"></div>';
    const label = it.key === 'pin' ? (app && app.pinned ? 'Unpin' : 'Pin to top')
      : (it.key === 'orientation'
        ? (app && app.orientationOverride === 'landscape' ? 'Standup start (current screen))'
          : (app && app.orientationOverride === 'portrait' ? 'Wide screen start (current vertical screen))' : 'Launch in landscape'))
        : it.label);
    return `<div class="item ${it.danger ? 'danger' : ''}" data-key="${it.key}" data-act="${it.key}">
      <span>${esc(label)}</span>${it.kbd ? `<span class="k">${it.kbd}</span>` : ''}
    </div>`;
  }).join('');
  menu.classList.add('on');

  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 10)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 10)}px`;
}

function hideMenu() {
  $('ctxmenu').classList.remove('on');
  state.menuPkg = null;
}

async function handleMenu(act) {
  const pkg = state.menuPkg;
  const app = state.apps.find((a) => a.package === pkg);
  hideMenu();
  if (!app) return;
  switch (act) {
    case 'open': return launchApp(pkg);
    case 'stop': {
      try {
        const r = await api.stop(pkg);
        if (r && r.ok) {
          toast({ title: 'App closed', body: app.label, type: 'ok' });
        } else {
          toast({ title: 'Could not close the app', body: (r && r.error) || 'Unknown error', type: 'error' });
        }
      } catch (e) {
        toast({ title: 'Could not close the app', body: e.message, type: 'error' });
      }
      return refreshApps();
    }
    case 'shortcut': return createShortcut(pkg);
    case 'orientation': {
      // Three-state loop: Follow application → screen screen application
      // So that the list is turned into a screen application, and the user can force the screen and remember.
      const cur = app.orientationOverride;
      const next = cur === 'landscape' ? 'portrait' : (cur === 'portrait' ? null : 'landscape');
      try {
        const r = await api.setAppOrientation(pkg, next);
        const txt = next === 'landscape' ? 'Launch in landscape' : (next === 'portrait' ? 'Launch in portrait' : 'Follow app');
        toast({ title: `Setup ${txt}`, body: 'The next time you open the application, it will be effective without reopening the environment.', type: 'ok' });
        if (r && typeof r.landscape === 'boolean' && state.apps) {
          const rec = state.apps.find((a) => a.package === pkg);
          if (rec) rec.orientationOverride = next;
        }
      } catch (e) {
        toast({ title: 'Could not change orientation', body: e.message, type: 'error' });
      }
      return refreshApps();
    }
    case 'pin': return api.pin(pkg, !app.pinned).then(refreshApps);
    case 'keymap': return showKeymapPicker(pkg, app.label);
    case 'reveal': return api.revealApk(pkg);
    case 'clear': {
      if (!window.confirm(`Clear${app.label}’All data? This operation is irrevocable.`)) return;
      try {
        await api.clearData(pkg);
        toast({ title: 'App data cleared', body: app.label, type: 'ok' });
      } catch (e) {
        toast({ title: 'Could not clear app data', body: e.message, type: 'error' });
      }
      return;
    }
    case 'uninstall': return uninstall(pkg);
    default: return undefined;
  }
}

/**
 * KeyMap Preset Selector. Make the simplest interaction with confirm+prompt (no new UI component is included).
 * And then you can make it a more sophisticated window editor.
 */
async function showKeymapPicker(pkg, label) {
  try {
    const presets = await api.keymap.getPresets();
    const current = await api.keymap.getMap(pkg);
    const hasCurrent = current && current.length > 0;
    const lines = presets.map((p, i) => `${i + 1}. ${p.label} — ${p.desc}`);
    if (hasCurrent) lines.unshift('Clear the current map');
    const msg = `For${label}’Select KeyMap Preset: \n\n${lines.join('\n')}\n\n Enter Numbering:`;
    const input = window.prompt(msg, hasCurrent ? '0' : '1');
    if (input === null) return; // Cancel
    const idx = parseInt(input, 10);
    if (hasCurrent && idx === 0) {
      await api.keymap.setMap(pkg, []);
      toast({ title: 'Cleared key map', body: label, type: 'ok' });
      return;
    }
    const presetIdx = hasCurrent ? idx - 1 : idx;
    if (presetIdx < 1 || presetIdx > presets.length) {
      toast({ title: 'Invalid numbering', type: 'error' });
      return;
    }
    const chosen = presets[presetIdx - 1];
    await api.keymap.applyPreset(pkg, chosen.id);
    toast({ title: `Applied ${chosen.label}`, body: `${label} · Opens the application keyboard to manipulate`, type: 'ok' });
  } catch (e) {
    toast({ title: 'KeyMap Settings Failed', body: e.message, type: 'error' });
  }
}

/* ------- settings------------------------------------------------------------------------------------------------------------------------------------ */

// --------------------------------------------------------------------------------------------------------------------------------------------

let volumeTimer = null;

async function refreshAndroid() {
  const el = $('androidStatus');
  if (!el) return;
  el.textContent = 'Reading…';
  const r = await api.android.status().catch(() => null);
  if (!r || !r.ok) {
    el.textContent = r && r.error ? `Android runtime is not ready(${String(r.error).slice(0, 36)})` : 'Android runtime is stopped';
    return;
  }
  el.textContent = `Android ${r.sdk || '?'} · ${r.wifi ? 'Wi-Fi on' : 'Wi-Fi off'}` +
    `${r.airplane ? ' · Flight mode' : ''} · Volume ${r.volume}%`;
  $('setAndroidWifi').checked = !!r.wifi;
  $('setAndroidAirplane').checked = !!r.airplane;
  $('setAndroidAnim').checked = !r.animationsOff;
  $('setAndroidVolume').value = r.volume;
  $('androidVolumeText').textContent = `${r.volume}%`;
  if (r.fontScale) $('setAndroidFont').value = Number(r.fontScale).toFixed(2);
  if (r.density) {
    const opt = [...$('setAndroidDensity').options].find((o) => o.value === String(r.density));
    if (opt) $('setAndroidDensity').value = String(r.density);
  }
}

function bindAndroid() {
  const set = async (key, value, msg) => {
    const r = await api.android.set(key, value).catch(() => null);
    toast({
      type: r && r.ok ? 'ok' : 'error',
      title: r && r.ok ? (msg || 'Applied') : `Failed: ${(r && r.error) || 'Android runtime is not ready'}`,
    });
    if (r && r.ok) refreshAndroid();
  };
  $('setAndroidWifi').addEventListener('change', (e) => set('wifi', e.target.checked, e.target.checked ? 'Wi-Fi enabled' : 'Wi-Fi closed'));
  $('setAndroidAirplane').addEventListener('change', (e) => set('airplane', e.target.checked, e.target.checked ? 'Flight mode in progress.' : 'Exited flight mode'));
  $('setAndroidAnim').addEventListener('change', (e) => set('animations', e.target.checked, e.target.checked ? 'System Animation is on.' : 'System Animation is closed. Interface is faster.'));
  $('setAndroidFont').addEventListener('change', (e) => set('fontScale', Number(e.target.value), 'Font size adjusted'));
  $('setAndroidDensity').addEventListener('change', (e) => set('density', Number(e.target.value), 'Show size adjusted'));
  $('setAndroidVolume').addEventListener('input', (e) => {
    $('androidVolumeText').textContent = `${e.target.value}%`;
    clearTimeout(volumeTimer);
    volumeTimer = setTimeout(() => set('volume', Number(e.target.value), 'Volume adjusted'), 260);
  });
  $('btnAndroidRefresh').addEventListener('click', () => refreshAndroid());
  $('btnAndroidTune').addEventListener('click', async () => {
    const r = await api.android.tune(state.launchPkg || '').catch(() => null);
    toast({ type: r && r.ok ? 'ok' : 'error', title: r && r.ok ? 'Android performance settings applied' : 'Could not update Android performance settings' });
    if (r && r.ok) refreshAndroid();
  });
  const open = async (action) => {
    const r = await api.android.open(action).catch(() => null);
    if (!r || !r.ok) {
      toast({ type: 'error', title: 'Open an app to start the Android runtime.' });
    }
  };
  $('btnAndroidSettings').addEventListener('click', () => open('settings'));
  $('btnAndroidDisplay').addEventListener('click', () => open('display'));
  $('btnAndroidSound').addEventListener('click', () => open('sound'));
  $('btnAndroidLocale').addEventListener('click', () => open('locale'));
  $('btnAndroidApps').addEventListener('click', () => open('apps'));
}

/** Sets the page field synchronisation: Only when running on your own, all resource items are visible and no more bottom-switching */
function syncBackendFields() {
  const perf = $('perfGroup');
  if (perf) perf.hidden = false;
  refreshResources();
}

/** The current resource cap + current allocation (set the grey lines on the page)) */
async function refreshResources() {
  const bNote = $('builtinResNote');
  if (!bNote) return;
  const gb = (mb) => (Number(mb) > 0 ? `${Math.round(Number(mb) / 1024)} GB` : 'Unknown');
  const r = await api.resources().catch(() => null);
  if (!r || r.ok === false) {
    bNote.textContent = (r && (r.note || r.error)) || 'Resource usage is unavailable';
    return;
  }
  const host = r.host || {};
  const lim = r.limits || {};
  const free = Number(r.freeMB) || Number((r.current && r.current.freeMB) || 0);
  bNote.textContent = `Host: ${gb(host.totalMB)} RAM · ${host.cores} CPU cores.`
    + `Maximum share of memory ${gb(lim.maxMB)}, Most Cores ${Math.max(1, (host.cores || 1) - 1)} One fourth each for Windows.`
    + `Data partition cap ${lim.maxGB || 0} GB${free ? `(Remaining Disk ${(free / 1024).toFixed(1)} GB)` : ''}.`
    + (r.verdict && r.verdict.note ? ` ${r.verdict.note}` : '');
}

/** Medical check-up: Rendering report (per band level and executable action)) */
function renderPreflight(res) {
  const list = $('preflightList');
  const sum = $('preflightSummary');
  const applyBtn = $('btnPreflightApply');
  if (!list) return;
  list.textContent = '';
  if (!res || !res.report) {
    if (sum) sum.textContent = (res && res.error) || 'No diagnostic results. Try again.';
    return;
  }
  const { report, edition } = res;
  for (const it of report.items) {
    const item = document.createElement('div');
    item.className = 'pf-item';
    const head = document.createElement('div');
    head.className = 'pf-head';
    const dot = document.createElement('span');
    dot.className = `pf-dot ${it.level}`;
    const title = document.createElement('span');
    title.className = 'pf-title';
    title.textContent = it.title;
    head.append(dot, title);
    item.append(head);
    if (it.detail) {
      const d = document.createElement('div');
      d.className = 'pf-detail';
      d.textContent = it.detail;
      item.append(d);
    }
    if (it.action && it.action.kind === 'elevate') {
      const wrap = document.createElement('div');
      wrap.className = 'pf-action';
      const btn = document.createElement('button');
      btn.className = 'btn ghost sm';
      btn.textContent = it.action.label;
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const old = btn.textContent;
        btn.textContent = 'Processing…';
        let r = null;
        if (it.action.id === 'accel') r = await api.enableAccel().catch(() => null);
        else r = await api.enableVirtualization().catch(() => null);
        btn.disabled = false;
        btn.textContent = old;
        if (!r) { toast({ type: 'error', title: 'Operation not completed', body: 'Try again or follow the manual steps in the user guide.' }); return; }
        if (r.cancelled) toast({ type: 'warn', title: 'Cancelled', body: 'System settings were left as they were.' });
        else if (r.ok || r.already) {
          const reboot = r.restartNeeded === true;
          toast({
            type: 'ok',
            title: r.already ? 'Hardware acceleration is available.' : (reboot ? 'Restart required' : 'Applied'),
            body: r.already ? '' : (reboot ? 'Hardware will not be effective until the computer’s restarted.' : 'Run Diagnostic Preflight again to confirm.'),
          });
          if (r.already || !reboot) setTimeout(() => runPreflight().catch(() => {}), 1200);
        } else {
          toast({ type: 'error', title: 'Unable to auto-complete', body: (r.error || r.note || 'See the user manual to finish the repair.') });
        }
      });
      wrap.append(btn);
      item.append(wrap);
    } else if (it.action && it.action.kind === 'manual') {
      const wrap = document.createElement('div');
      wrap.className = 'pf-action pf-detail';
      wrap.textContent = `⚠ ${it.action.label}`;
      item.append(wrap);
    }
    list.append(item);
  }
  const rec = report.recommended || {};
  if (sum) {
    sum.textContent = `${report.summary} · Recommended profile: ${Math.round((rec.memoryMB || 0) / 1024)} GB RAM / `
      + `${rec.cores || 2} Nuclear / ${rec.renderSize || 'auto'} · Render ${rec.gpuMode || 'auto'}`
      + (edition === 'store' ? '(Shop version: System functionality can only be manually opened in Windows functionality)' : '');
  }
  if (applyBtn) applyBtn.hidden = false;
}

async function runPreflight() {
  const btn = $('btnPreflight');
  const sum = $('preflightSummary');
  if (!btn) return null;
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Checking this PC…';
  if (sum) sum.textContent = 'Checking virtualization, graphics, and memory…';
  let r = null;
  try {
    r = await api.preflightRun();
  } catch (e) {
    r = { error: e.message || 'Medical examination failed.' };
  }
  btn.disabled = false;
  btn.textContent = old;
  renderPreflight(r);
  return r;
}

/** Driver (compatible patch): Rendering List + Hit State */
function renderDrivers(r) {
  const list = $('drvList');
  const sum = $('drvSummary');
  if (!list) return;
  const host = (r && r.host) || {};
  const drivers = (r && r.drivers) || [];
  const errors = (r && r.errors) || [];
  const onCount = drivers.filter((d) => d.enabled && d.matched).length;
  if (sum) {
    const accel = host.accel === 'none' ? 'No hardware acceleration' : (host.accel || 'Unknown');
    sum.textContent = `Host: ${host.platform || ''}/${host.arch || ''} · GPU: ${host.gpuVendor || 'Unknown'} · ${accel}`
      + ` · Emulator ${host.emulatorVersion || 'unknown'} · Profiles: ${drivers.length} available, ${onCount} active.`
      + (errors.length ? ` ${errors.length} Failed to load a file (see below).` : '');
  }
  list.textContent = '';
  for (const d of drivers) {
    const item = document.createElement('div');
    item.className = d.enabled ? 'drv-item on' : 'drv-item';

    const head = document.createElement('div');
    head.className = 'drv-head';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!d.enabled;
    cb.addEventListener('change', async () => {
      const res = await api.driversSetEnabled(d.id, cb.checked).catch(() => null);
      if (res && res.ok && res.overview) renderDrivers(res.overview);
      else { cb.checked = !cb.checked; toast({ type: 'error', title: 'Save Failed', body: (res && res.error) || 'Please try again later.' }); }
    });
    const name = document.createElement('span');
    name.className = 'drv-name';
    name.textContent = d.name;
    head.append(cb, name);

    if (d.matched && d.enabled) {
      const b = document.createElement('span');
      b.className = 'drv-badge hit';
      b.textContent = 'Applied';
      head.append(b);
    }
    if (d.builtin) {
      const b = document.createElement('span');
      b.className = 'drv-badge';
      b.textContent = 'Built-in Example';
      head.append(b);
    }
    item.append(head);

    const meta = document.createElement('div');
    meta.className = 'drv-meta';
    meta.textContent = `v${d.version || '?'}`
      + (d.author ? ` · ${d.author}` : '')
      + ` · priority ${d.priority}`
      + (d.hits && d.hits.length ? ` · Hit!: ${d.hits.join(' / ')}` : ' · This is not a match.');
    item.append(meta);

    if (d.description) {
      const desc = document.createElement('div');
      desc.className = 'drv-meta';
      desc.textContent = d.description;
      item.append(desc);
    }
    list.append(item);
  }
  for (const e of errors) {
    const err = document.createElement('div');
    err.className = 'drv-err';
    err.textContent = `${String(e.file || '').split(/[\\/]/).pop()}: ${(e.errors || []).join('; ')}`;
    list.append(err);
  }
  if (!drivers.length && !errors.length) {
    const empty = document.createElement('div');
    empty.className = 'drv-meta';
    empty.textContent = 'No hardware profiles. Export a template to create one or import an existing JSON profile.';
    list.append(empty);
  }
}

async function refreshDrivers() {
  if (!$('drvList')) return;
  const r = await api.driversList().catch(() => null);
  if (!r) {
    if ($('drvSummary')) $('drvSummary').textContent = 'Hardware profiles are unavailable. Check the runtime setup.';
    return;
  }
  renderDrivers(r);
}

function fillSettings(s) {
  syncBackendFields();
  refreshDrivers().catch(() => {});
  $('setAdbPath').value = s.adbPath || '';
  $('setSystemImage').value = s.runtime.isoPath || '';
  $('setMemory').value = s.engine.memoryMB;
  $('setCores').value = s.engine.cores;
  $('setIdle').value = s.engine.idleShutdownMinutes;
  if ($('setAutoMirror')) $('setAutoMirror').checked = (s.runtime && s.runtime.autoMirror) === true;
  if ($('setMirrorPrefix')) $('setMirrorPrefix').value = (s.runtime && s.runtime.mirrorPrefix) || '';
  if ($('setConnections')) $('setConnections').value = Number((s.runtime && s.runtime.downloadConnections) || 8);
  $('setAudio').checked = s.engine.audio !== false;
  $('setLiteMode').checked = s.engine.liteMode !== false;
  $('setPrewarm').checked = s.engine.prewarm !== false;
  $('setPriorityMode').value = ['performance', 'game'].includes(s.engine.priorityMode)
    ? s.engine.priorityMode : 'balanced';
  $('setDeepTrim').checked = !!s.engine.deepTrim;
  $('setMouseRightBack').checked = s.engine.mouseRightBack !== false;
  $('setMouseWheelMode').value = ['smooth', 'native', 'off'].includes(s.engine.mouseWheelMode)
    ? s.engine.mouseWheelMode : 'smooth';
  $('setMouseSideButtons').checked = !!s.engine.mouseSideButtons;
  if ($('setKeymapEnabled')) $('setKeymapEnabled').checked = s.engine.keymapEnabled !== false;
  // Laboratory: Native multi-window open (experimental))
  if ($('setMultiWindow')) $('setMultiWindow').checked = !!s.engine.multiWindow;
  if ($('setKeepBackground')) $('setKeepBackground').value = String(
    Number(s.engine.keepBackground) >= 0 ? Number(s.engine.keepBackground) : 1,
  );
  $('setCompat').checked = !!(s.runtime && s.runtime.compatImage);
  $('setAutoShortcut').checked = !!s.createShortcutOnInstall;
  $('setStartMenuShortcut').checked = s.createStartMenuShortcut !== false;
  $('setShortcutDir').value = s.shortcutDir || '';
  $('setSharedDir').value = s.sharedDir || '';
  $('setDeviceSharedDir').value = s.deviceSharedDir || '';
  const d = s.display || {};
  $('setAutoStart').checked = s.autoStart !== false;
  const eng = s.engine || {};
  if ($('setResourceMode')) $('setResourceMode').value = eng.resourceMode || 'balanced';
  if ($('setRenderSize')) $('setRenderSize').value = eng.renderSize || 'auto';
  if ($('setDataGB')) $('setDataGB').value = String(Number(eng.dataPartitionGB || 0));
  if ($('setFastDns')) $('setFastDns').checked = eng.fastDns !== false;
  if ($('setLocale')) $('setLocale').value = eng.locale || 'en-US';
  if ($('setKeepSnapshot')) $('setKeepSnapshot').checked = eng.keepSnapshot !== false;
  $('setDisplayMode').value = d.mode === 'fullscreen' ? 'fullscreen' : 'window';
  if ($('setAutoFullscreen')) $('setAutoFullscreen').value = d.autoFullscreenOnLaunch === true ? 'on' : 'off';
  if ($('setLandscape')) $('setLandscape').value = d.landscape === true ? 'landscape' : 'portrait';
  if ($('setOrientationMode')) $('setOrientationMode').value = d.orientationMode || 'auto';
  if ($('setAutoRotate')) $('setAutoRotate').value = d.autoRotate === false ? 'off' : 'on';
  if ($('setTabletMode')) $('setTabletMode').value = d.tabletMode === false ? 'off' : 'on';
  $('setPortrait').value = d.portrait || '900x1600';
  // 0.6.0 Default primary window: Only obvious true is embedded mode (unundefined in old configuration considered original))
  if ($('setWindowEmbed')) $('setWindowEmbed').value = d.windowEmbed === true ? 'embed' : 'detached';
  $('portraitField').hidden = $('setDisplayMode').value === 'fullscreen';
}

/** The actual size of the data partition + disk balance, displaying below the set page capacity selection */
async function refreshDataInfo() {
  const el = $('dataNote');
  if (!el) return;
  const info = await api.dataInfo().catch(() => null);
  if (!info) { el.textContent = 'Failed to read data partition information'; return; }
  const auto = Number(($('setDataGB') || {}).value || 0) === 0;
  // The size of the base image when there is a Quickboot Disk is not equal to the size of the view (actual 8GB mirror, guess 5.7GB) seen),
  // Instead of showing a misleading figure, it would be better to say, "be at the time of operation."
  const img = info.overlay
    ? 'Quick Start Difference Disk (actual capacity based on running/data))'
    : (info.fsGB ? `Actual documentation system ${info.fsGB} GB` : (info.imageGB ? `${info.imageGB} GB` : 'Not created'));
  const free = info.freeDiskMB ? `${(info.freeDiskMB / 1024).toFixed(1)} GB` : 'Unknown';
  const pending = Number(info.pendingGB) > 0
    ? ` Objective ${info.configuredGB} GB Not yet in effect: Android is using the Quick Start Disk, which needs to be re-established at a new capacity after the "replaced Android data" (which will empty the installed applications).`
    : '';
  el.textContent = `Current data partition: ${img}${auto ? '(Auto)' : ''} · Remaining Disk ${free}.${pending}`
    + 'The game cue “insufficiency of storage space“ increases the back dot “intensible“; does not lose the installed application when it is in place.';
}

/* -----------set pages: class navigation + search ---- */

/**
 * Sets more and more, and a long rolling is a hard line to find.:
 * “Calculate within the settings.“ This is to divide the settings into 8 categories by use, and to the left one column to navigate.
 *
 * The catalog must match the data-cat of each group in index.html ——
 * The test/settings-categories-test.js will verify the consistency.
 */
const SETTINGS_CATS = [
  { id: 'basic', name: 'General & Installation' },
  { id: 'display', name: 'Display & Window' },
  { id: 'input', name: 'Controls & Input' },
  { id: 'perf', name: 'Performance & Resources' },
  { id: 'net', name: 'Network & Downloads' },
  { id: 'diag', name: 'Diagnostics & Fixes' },
  { id: 'files', name: 'Integration & Files' },
  { id: 'about', name: 'Updates & About' },
  { id: 'lab', name: 'Laboratory' },
];

const settingsCatState = { cat: 'basic', query: '' };

/** All groups with classification tags in the setup (. group and details. advanced-group) are counted) */
function settingsGroups() {
  return Array.from(document.querySelectorAll('#settingsBody [data-cat]'));
}

/** Whether or not to hit a search word in a group: Title, field name, description text counts */
function groupMatches(group, q) {
  if (!q) return true;
  const text = (group.textContent || '').toLowerCase();
  if (text.includes(q)) return true;
  const title = group.querySelector('.group-title');
  return !!title && title.textContent.toLowerCase().includes(q);
}

/** Cut to a class */
function switchSettingsCat(cat, { keepQuery = false } = {}) {
  const target = SETTINGS_CATS.some((c) => c.id === cat) ? cat : 'basic';
  settingsCatState.cat = target;
  if (!keepQuery) settingsCatState.query = '';
  try { localStorage.setItem('hydra.settings.cat', target); } catch (_) { /* ignore */ }
  const search = $('setSearch');
  if (search && !keepQuery) search.value = '';
  const clear = $('btnClearSearch');
  if (clear) clear.hidden = !settingsCatState.query;
  document.querySelectorAll('#setNav .set-nav-item').forEach((b) => {
    b.classList.toggle('on', b.dataset.cat === target);
  });
  applySettingsFilter();
}

/**
 * Apply Visibility: Display groups of life across categories when searching (otherwise, what is found is hidden in another class),
 * Users will think "no response"; show only the current classification when no search takes place.
 */
function applySettingsFilter() {
  const q = settingsCatState.query.trim().toLowerCase();
  const groups = settingsGroups();
  const hitPerCat = {};
  for (const g of groups) {
    const hit = groupMatches(g, q);
    const inCat = g.dataset.cat === settingsCatState.cat;
    g.hidden = q ? !hit : !inCat;
    if (hit) hitPerCat[g.dataset.cat] = (hitPerCat[g.dataset.cat] || 0) + 1;
  }
  // Category button: Which categories hit when searching
  document.querySelectorAll('#setNav .set-nav-item').forEach((b) => {
    const n = hitPerCat[b.dataset.cat] || 0;
    b.classList.toggle('dim', !!q && n === 0);
    b.title = q ? `${n} matches` : '';
  });
  // The last visible group does not draw the dividing line (after the group is hidden: last-child selects the wrong object)
  const visible = groups.filter((g) => !g.hidden);
  visible.forEach((g) => g.classList.remove('last-visible'));
  if (visible.length) visible[visible.length - 1].classList.add('last-visible');
  updateCatBadges();
}

/** Positioning to a group: first cut to the classification to which it belongs, then roll over. */
function focusGroup(el) {
  if (!el) return;
  const cat = el.dataset && el.dataset.cat;
  if (cat) switchSettingsCat(cat);
  const body = $('settingsBody');
  if (body) body.scrollTop = 0;
  if (typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}

function bindSettingsCategory() {
  const nav = $('setNav');
  if (nav) {
    nav.addEventListener('click', (e) => {
      const btn = e.target.closest('.set-nav-item');
      if (!btn) return;
      switchSettingsCat(btn.dataset.cat);
      const body = $('settingsBody');
      if (body) body.scrollTop = 0;
    });
  }

  const search = $('setSearch');
  const clear = $('btnClearSearch');
  if (search) {
    search.addEventListener('input', () => {
      settingsCatState.query = search.value || '';
      if (clear) clear.hidden = !settingsCatState.query;
      applySettingsFilter();
    });
    // Back to the car: Jump to the first group of life
    search.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const hit = settingsGroups().find((g) => !g.hidden);
      if (hit) focusGroup(hit);
    });
  }
  if (clear) {
    clear.addEventListener('click', () => {
      settingsCatState.query = '';
      if (search) search.value = '';
      clear.hidden = true;
      applySettingsFilter();
    });
  }

  // Remember the last time you stayed.
  try {
    const last = localStorage.getItem('hydra.settings.cat');
    if (last && SETTINGS_CATS.some((c) => c.id === last)) settingsCatState.cat = last;
  } catch (_) { /* ignore */ }
  switchSettingsCat(settingsCatState.cat);
}

/* ----------Automated testing (automatic debug)-------------------------------------------------------------------------------------------------------------------------- */

/** Autodetected problem classification name (comparable to CATEGORIES of src/ core/ autodebug.js) */
const DEBUG_CATS = [
  { id: 'runtime', name: 'Runtime' },
  { id: 'device', name: 'Device connection' },
  { id: 'storage', name: 'Storage' },
  { id: 'settings', name: 'Settings' },
  { id: 'network', name: 'Network' },
  { id: 'logs', name: 'Logs' },
];

let autodebugLast = null;

function renderAutodebug(res) {
  const list = $('autodebugList');
  const txt = $('autodebugStateText');
  if (!list) return;
  autodebugLast = res || null;
  const issues = (res && res.issues) || [];
  const at = res && res.at;

  if (txt) {
    if (res && res.running) txt.textContent = 'Checking…';
    else if (!at) txt.textContent = 'No checks run yet';
    else if (!issues.length) txt.textContent = `Last checked ${relTime(at)} · No issues found`;
    else txt.textContent = `Last checked ${relTime(at)} · ${issues.length} issues to review`;
  }

  if (!issues.length) {
    list.innerHTML = `<div class="dbg-ok">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>
      <span>No issues found in the runtime, ADB connection, storage, or settings.</span>
    </div>`;
    updateCatBadges();
    return;
  }

  const byCat = new Map();
  for (const it of issues) {
    const key = it.category || 'runtime';
    if (!byCat.has(key)) byCat.set(key, []);
    byCat.get(key).push(it);
  }
  const order = DEBUG_CATS.map((c) => c.id);
  const keys = Array.from(byCat.keys()).sort((a, b) => {
    const ia = order.indexOf(a); const ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  list.innerHTML = keys.map((key) => {
    const name = (DEBUG_CATS.find((c) => c.id === key) || {}).name || key;
    const items = byCat.get(key);
    return `<div class="dbg-group">
      <div class="dbg-group-title">${esc(name)}<span class="dbg-count">${items.length}</span></div>
      ${items.map((it) => `
        <div class="dbg-item ${esc(it.severity || 'info')}">
          <span class="dbg-sev"></span>
          <div class="dbg-body">
            <div class="dbg-name">${esc(it.title || '')}</div>
            <div class="dbg-hint">${esc(it.hint || '')}</div>
            ${it.detail ? `<div class="dbg-detail">${esc(it.detail)}</div>` : ''}
          </div>
          ${it.fix ? `<button class="dbg-fix" data-code="${esc(it.code)}">Fix</button>` : ''}
          <button class="dbg-help" data-code="${esc(it.code)}" title="Open the user manual">Help</button>
        </div>`).join('')}
    </div>`;
  }).join('');

  list.querySelectorAll('.dbg-fix').forEach((b) => {
    b.addEventListener('click', () => {
      const issue = issues.find((x) => x.code === b.dataset.code);
      if (issue) fixIssue(issue);
    });
  });
  list.querySelectorAll('.dbg-help').forEach((b) => {
    b.addEventListener('click', () => {
      const issue = issues.find((x) => x.code === b.dataset.code);
      if (issue) openManualForIssue(issue, 'clicked');
    });
  });

  updateCatBadges();
}

/** Problem corner on category buttons: Show numbers only on problematic categories */
function updateCatBadges() {
  const issues = (autodebugLast && autodebugLast.issues) || [];
  document.querySelectorAll('#setNav .set-nav-badge').forEach((el) => {
    const cat = el.dataset.badge;
    // The automatic detection problem does not necessarily belong to a set classification, and only the setup problem is marked on the "diagnostic and restoration"
    const n = cat === 'diag' ? issues.filter((i) => i.severity === 'error').length : 0;
    el.hidden = n === 0;
    el.textContent = n ? String(n) : '';
    el.classList.toggle('warn', false);
  });
}

function bindAutodebug() {
  const btn = $('btnAutodebugRun');
  if (btn) {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const old = btn.textContent;
      btn.textContent = 'Checking…';
      try {
        const r = await api.autodebugRun().catch(() => null);
        if (r) renderAutodebug(r);
        else toast({ title: 'Failed to detect', body: 'Error while collecting state, try again later', type: 'error' });
      } finally {
        btn.disabled = false;
        btn.textContent = old;
      }
    });
  }

  const report = $('btnAutodebugReport');
  if (report) {
    report.addEventListener('click', async () => {
      const r = await api.doctorReport().catch(() => null);
      if (r && r.ok !== false) toast({ title: 'Diagnostic report exported', body: 'Attach the report when opening a GitHub issue', type: 'ok' });
      else toast({ title: 'Export Failed', body: (r && r.error) || 'Please try again.', type: 'error' });
    });
  }

  const auto = $('setAutodebugAuto');
  if (auto) {
    auto.addEventListener('change', async () => {
      const r = await api.autodebugConfig({ auto: auto.checked }).catch(() => null);
      if (r) fillAutodebugSettings(r);
      toast({
        title: auto.checked ? 'Automatic monitoring enabled' : 'Automatic monitoring disabled',
        body: auto.checked ? 'Hydra will check for new issues in the background.' : 'You can still run a check manually.',
        type: 'info',
      });
    });
  }

  const interval = $('setAutodebugInterval');
  if (interval) {
    interval.addEventListener('change', async () => {
      const r = await api.autodebugConfig({ intervalMin: Number(interval.value) }).catch(() => null);
      if (r) fillAutodebugSettings(r);
      toast({ title: 'Test interval updated', body: `Checks run every ${r ? r.intervalMin : interval.value} minutes.`, type: 'ok' });
    });
  }

  const notify = $('setAutodebugNotify');
  if (notify) {
    notify.addEventListener('change', async () => {
      const r = await api.autodebugConfig({ notify: notify.checked }).catch(() => null);
      if (r) fillAutodebugSettings(r);
    });
  }
}

function fillAutodebugSettings(cfg) {
  if (!cfg) return;
  const auto = $('setAutodebugAuto');
  if (auto) auto.checked = cfg.auto !== false;
  const interval = $('setAutodebugInterval');
  if (interval) interval.value = String(cfg.intervalMin || 10);
  const notify = $('setAutodebugNotify');
  if (notify) notify.checked = cfg.notify !== false;
}

async function openSettings() {
  state.settings = await api.getSettings();
  fillSettings(state.settings);
  fillAutodebugSettings((state.settings && state.settings.debug) || {});
  const info = await api.info();
  $('setRuntimeDir').value = info.runtimeDir || info.dataDir;
  if ($('setAvdDir')) {
    const di = await api.dataInfo().catch(() => null);
    $('setAvdDir').value = (di && di.avdDir) || '';
  }
  const verEl = document.getElementById('aboutVer');
  if (verEl && info.version) verEl.textContent = `v${info.version}`;
  const curVerEl = document.getElementById('updateCurrent');
  if (curVerEl && info.version) curVerEl.textContent = `v${info.version}`;
  const assoc = await api.assocStatus();
  const btn = $('btnAssoc');
  btn.textContent = assoc.registered ? 'Remove association' : 'Associate .apk files';
  btn.dataset.on = assoc.registered ? '1' : '0';

  api.doctorProfile().then((r) => {
    if (r && r.text) $('autoProfileText').textContent = r.text;
  }).catch(() => { $('autoProfileText').textContent = 'Auto Mode'; });
  api.runtimeUsage().then((u) => {
    $('usageText').textContent = u
      ? `Total ${u.totalText}${u.reclaimable ? ` · Recoverable ${u.reclaimableText}(${u.count} Item)` : ' · It\'s streamlined.'}`
      : 'Statistics not available';
  }).catch(() => { $('usageText').textContent = 'Statistics not available'; });

  $('settingsMask').classList.add('on');
  refreshAndroid();
  refreshDataInfo();
  applySettingsFilter();
  // Put the last test on the table first, then refresh the backstage.
  api.autodebugState().then((r) => { if (r) renderAutodebug(r); }).catch(() => {});
}

function closeSettings() {
  $('settingsMask').classList.remove('on');
}

/* -------- software upgrades------------------------------------------------------------------------------------------ */

let lastUpdate = null;

/** Draws the results of an inspection to set the panel (also used for static check-in-transmission status at startup)) */
function renderUpdate(info) {
  lastUpdate = info || null;
  const cur = $('updateCurrent');
  const st = $('updateState');
  const btn = $('btnDoUpdate');
  const bar = $('updateBar');
  if (!cur || !st || !btn) return;
  if (!info) return;
  if (info.current) cur.textContent = `v${info.current}`;

  if (info.ok === false) {
    st.textContent = `Check failed: ${info.error || 'Network Not Available'}`;
    // The check failed also gives a way out: directly open the release page, the user can at least download it manually.
    // Before, this was nothing, and the users only felt that the update was broken.
    showUpdateBtn(true);
    btn.textContent = 'Open releases';
    btn.dataset.mode = 'manual';
    lastUpdate = { htmlUrl: info.htmlUrl || '' };
    if (bar) bar.hidden = true;
    return;
  }
  if (info.hasUpdate) {
    // So tell me which source this time gave us, and why the other source didn't participate. ——
    // When users check "Why are the updates slow?" this line is more direct than any log.
    const src = (info.sources || []).map((x) => `${x.name} ${x.tag || ''}`.trim()).join(' / ');
    const bad = (info.unreachable || []).map((x) => x.name).join(', ');
    const stale = info.stale ? '(Offline cache, probably not the latest.)' : '';
    st.textContent = `Update available: ${info.tag}${src ? `(${src})` : ''}${bad ? `; ${bad} It’s impossible.` : ''}${stale}`;
    showUpdateBtn(true);
    btn.textContent = info.asset ? 'Update now' : 'Open releases';
    btn.dataset.mode = info.asset ? 'auto' : 'manual';
    const note = $('updateNote');
    if (note && info.notes) {
      const brief = String(info.notes).split('\n').slice(0, 8).join('\n').trim();
      if (brief) note.textContent = `Update: \n${brief}`;
    }
    if (bar) bar.hidden = true;
  } else {
    const src = (info.sources || []).map((x) => x.name).join(' / ');
    const stale = info.stale ? '(Offline Cache)' : '';
    st.textContent = `You have the latest version (v${info.current})${src ? ` · via ${src}` : ''}${stale}`;
    showUpdateBtn(false);
    if (bar) bar.hidden = true;
  }
}

/** .btn self-carrying:inline-flux, overlays the hidden properties, so change it directly here */
function showUpdateBtn(on) {
  const btn = $('btnDoUpdate');
  if (!btn) return;
  btn.hidden = !on;
  btn.style.display = on ? '' : 'none';
}

function renderUpdateProgress(p) {
  if (!p) return;
  const st = $('updateState');
  const bar = $('updateBar');
  const fill = $('updateBarFill');
  if (p.stage === 'error') {
    if (st) st.textContent = `Update failed: ${p.message || ''}`;
    if (bar) bar.hidden = true;
    toast({ title: 'Update failed', body: p.message || '', type: 'error' });
    return;
  }
  if (st) st.textContent = p.message || 'Updating…';
  if (bar && fill) {
    bar.hidden = false;
    fill.style.width = `${Math.max(0, Math.min(100, p.percent || 0))}%`;
  }
}

function bindUpdate() {
  const check = $('btnCheckUpdate');
  const go = $('btnDoUpdate');
  if (!check || !go) return;

  const runCheck = async (silent) => {
    if (!silent) {
      check.disabled = true;
      const old = check.textContent;
      check.textContent = 'Checking…';
      $('updateState').textContent = 'Connecting to GitHub…';
      try {
        const info = await api.updateCheck();
        renderUpdate(info);
        if (info && info.hasUpdate) toast({ title: `Update available: ${info.tag}`, body: 'Select Update Now to download and install it.', type: 'info' });
        else if (info && info.ok !== false) toast({ title: 'You have the latest version', body: `v${info.current}`, type: 'ok' });
      } catch (e) {
        $('updateState').textContent = `Check failed: ${e.message}`;
      } finally {
        check.disabled = false;
        check.textContent = old;
      }
      return;
    }
    const info = await api.updateCheck().catch(() => null);
    if (info) renderUpdate(info);
  };

  check.addEventListener('click', () => runCheck(false));

  go.addEventListener('click', async () => {
    if (go.dataset.mode === 'manual') {
      api.updateOpenRelease(lastUpdate && lastUpdate.htmlUrl);
      return;
    }
    go.disabled = true;
    go.textContent = 'Updating…';
    const r = await api.updateApply().catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) {
      go.disabled = false;
      go.textContent = 'Update now';
      if (r && r.error && !r.manual) {
        $('updateState').textContent = `Update failed: ${r.error}`;
        toast({ title: 'Update failed', body: r.error, type: 'error' });
      }
    } else {
      $('updateState').textContent = `Downloaded v${r.version}. Restarting to finish the update…`;
    }
  });

  // If the settings are open and they're not working, check them out.)
  runCheck(true).catch(() => {});
}

function bindSettings() {
  const save = async (patch) => {
    state.settings = await api.setSettings(patch);
  };

  if ($('btnPreflight')) $('btnPreflight').addEventListener('click', () => runPreflight());
  if ($('btnPreflightApply')) {
    $('btnPreflightApply').addEventListener('click', async () => {
      const btn = $('btnPreflightApply');
      btn.disabled = true;
      const r = await api.preflightApply().catch(() => null);
      btn.disabled = false;
      if (!r || !r.ok) {
        toast({ type: 'error', title: 'Could not apply the recommended settings', body: (r && r.error) || 'Please try again later.' });
        return;
      }
      state.settings = r.settings;
      toast({
        type: 'ok',
        title: 'Recommended settings applied',
        body: `Memory ${Math.round((r.recommended.memoryMB || 0) / 1024)} GB / ${r.recommended.cores} cores / ${r.recommended.renderSize}`
          + (r.driverFile ? ';generating drivers, applying the next opportunity automatically' : ''),
      });
      if (r.driverError) toast({ type: 'warn', title: 'Could not save the hardware profile', body: r.driverError });
      fillSettings(r.settings);
      refreshStatus();
    });
  }
  if ($('btnDrvReload')) $('btnDrvReload').addEventListener('click', () => refreshDrivers());
  if ($('btnDrvFolder')) {
    $('btnDrvFolder').addEventListener('click', async () => {
      const r = await api.driversOpenFolder().catch(() => null);
      if (!r || !r.ok) toast({ type: 'error', title: 'Could not open the hardware profiles folder' });
    });
  }
  if ($('btnDrvImport')) {
    $('btnDrvImport').addEventListener('click', async () => {
      const r = await api.driversImport().catch(() => null);
      if (!r || r.canceled) return;
      if (!r.ok) {
        toast({ type: 'error', title: 'Import Failed', body: (r.errors || []).slice(0, 3).join('; ') });
        return;
      }
      toast({ type: 'ok', title: 'Driver imported and enabled', body: `${r.driver.name} v${r.driver.version}` });
      if (r.overview) renderDrivers(r.overview);
    });
  }
  if ($('btnDrvExport')) {
    $('btnDrvExport').addEventListener('click', async () => {
      const r = await api.driversExportTemplate().catch(() => null);
      if (!r || r.canceled) return;
      if (!r.ok) { toast({ type: 'error', title: 'Export Failed' }); return; }
      toast({ type: 'ok', title: 'Template Exported', body: 'Edit the effect fields, then refresh the hardware profile list.' });
      refreshDrivers();
    });
  }

  $('setAdbPath').addEventListener('change', (e) => save({ adbPath: e.target.value.trim() }));
  $('setSystemImage').addEventListener('change', (e) => save({ runtime: { isoPath: e.target.value.trim() } }));
  // Memory / Core: If you fill out a specific value, turn off "auto", fill 0 and return to auto.
  // The old code only writes memory MB, and the overrides FromSettings only recognize it when autu Memory=false,
  // And so the "manual memory fill" is always ignored -- it’s one of the things that sets pages most easily look like "no use."
  $('setMemory').addEventListener('change', (e) => {
    const v = Number(e.target.value) || 0;
    save(v > 0 ? { engine: { memoryMB: v, autoMemory: false } } : { engine: { memoryMB: 0, autoMemory: true } });
  });
  $('setCores').addEventListener('change', (e) => {
    const v = Number(e.target.value) || 0;
    save(v > 0 ? { engine: { cores: v, autoMemory: false } } : { engine: { cores: 0, autoMemory: true } });
  });
  if ($('setResourceMode')) {
    $('setResourceMode').addEventListener('change', async (e) => {
      // Resource strategy will be modified in conjunction with LiteMode / PriceMode / RenderSize (interpretation in main process))
      state.settings = await api.setSettings({ engine: { resourceMode: e.target.value } });
      fillSettings(state.settings);
      toast({ title: 'Resource policy updated', body: 'Applies the next time you open an app.', type: 'ok' });
    });
  }
  if ($('setRenderSize')) {
    $('setRenderSize').addEventListener('change', (e) => save({ engine: { renderSize: e.target.value } }));
  }
  if ($('setFastDns')) {
    $('setFastDns').addEventListener('change', (e) => save({ engine: { fastDns: e.target.checked } }));
  }
  if ($('setLocale')) {
    $('setLocale').addEventListener('change', async (e) => {
      state.settings = await api.setSettings({ engine: { locale: e.target.value } });
      toast({ title: 'Android language updated', body: 'Applies when the Android runtime restarts', type: 'ok' });
    });
  }
  if ($('setKeepSnapshot')) {
    $('setKeepSnapshot').addEventListener('change', (e) => save({ engine: { keepSnapshot: e.target.checked } }));
  }
  if ($('setDataGB')) {
    $('setDataGB').addEventListener('change', (e) => {
      save({ engine: { dataPartitionGB: Number(e.target.value) || 0 } });
      refreshDataInfo();
    });
  }
  if ($('btnGrowData')) {
    $('btnGrowData').addEventListener('click', async () => {
      const gb = Number($('setDataGB').value) || 0;
      if (!gb) { toast({ title: 'Select a partition size first.', body: 'Choose a size in GB to expand the partition manually.', type: 'info' }); return; }
      const { response } = await api.confirm({
        title: 'Expand the Android data partition?',
        message: `Adjust /data to ${gb} GB (in-situ, installed applications and archives will be retained).`,
        detail: 'The expansion requires the shutdown of the running Android application, and the next application to open will be redirected, taking about 10 seconds.',
        okLabel: 'Start magnifying.',
      });
      if (response !== 1) return;
      $('btnGrowData').disabled = true;
      const old = $('btnGrowData').textContent;
      $('btnGrowData').textContent = 'Expanding…';
      const r = await api.setDataSize(gb).catch((e) => ({ ok: false, error: e.message }));
      $('btnGrowData').disabled = false;
      $('btnGrowData').textContent = old;
      if (r && !r.ok && r.needsReset) {
        // The Quick Start Disk is blocked: it cannot be expanded in place, it can only be rebuilt at new capacity /data.
        // This is a clear data loss operation that must be confirmed separately.
        const again = await api.confirm({
          title: 'Reset Android data to expand the partition?',
          message: `The Quick Boot overlay prevents in-place expansion. A reset rebuilds the partition at ${gb} GB.`,
          detail: 'Rebuilding will empty installed applications and archives (simulators themselves and mirrors will not be affected). Are you sure you want to continue?',
          okLabel: 'Clear and rebuild.',
        });
        if (again.response !== 1) { refreshDataInfo(); return; }
        $('btnGrowData').disabled = true;
        $('btnGrowData').textContent = 'Rebuilding…';
        const rr = await api.resetAndResize(gb).catch((e) => ({ ok: false, error: e.message }));
        $('btnGrowData').disabled = false;
        $('btnGrowData').textContent = old;
        toast({
          type: rr && rr.ok ? 'ok' : 'error',
          title: rr && rr.ok ? 'Recreated at new capacity' : 'Rebuilding Failed',
          body: rr && rr.ok
            ? `Next time open application press ${gb} GB Rebuild / Data (first entry takes dozens of seconds))`
            : (rr && rr.error) || 'Unknown error',
        });
        refreshDataInfo();
        return;
      }
      toast({
        type: r && r.ok ? 'ok' : 'error',
        title: r && r.ok ? 'Data partition expanded' : 'Extension Failed',
        body: r && r.ok ? `Partition capacity: ${r.fsGB || r.imageGB || gb} GB` : (r && r.error) || 'Unknown error',
      });
      refreshDataInfo();
    });
  }
  $('setIdle').addEventListener('change', (e) => save({ engine: { idleShutdownMinutes: Number(e.target.value) || 0 } }));
  if ($('setAutoMirror')) {
    $('setAutoMirror').addEventListener('change', (e) => save({ runtime: { autoMirror: e.target.checked } }));
  }
  if ($('setMirrorPrefix')) {
    $('setMirrorPrefix').addEventListener('change', (e) => save({ runtime: { mirrorPrefix: e.target.value.trim() } }));
  }
  if ($('setConnections')) {
    $('setConnections').addEventListener('change', (e) => {
      const n = Math.max(1, Math.min(16, Number(e.target.value) || 8));
      e.target.value = n;
      save({ runtime: { downloadConnections: n } });
    });
  }
  $('setAudio').addEventListener('change', (e) => save({ engine: { audio: e.target.checked } }));
  $('setLiteMode').addEventListener('change', (e) => save({ engine: { liteMode: e.target.checked } }));
  $('setPrewarm').addEventListener('change', (e) => save({ engine: { prewarm: e.target.checked } }));
  $('setPriorityMode').addEventListener('change', (e) => save({ engine: { priorityMode: e.target.value } }));
  const savePointer = async (patch) => {
    await save({ engine: patch });
    // Reassemble/unmount hooks immediately by the current window focus, without waiting for the next window to be cut.
    api.refreshPointerMapping().catch(() => {});
  };
  $('setMouseRightBack').addEventListener('change', (e) => savePointer({ mouseRightBack: e.target.checked }));
  $('setMouseWheelMode').addEventListener('change', (e) => savePointer({ mouseWheelMode: e.target.value }));
  $('setMouseSideButtons').addEventListener('change', (e) => savePointer({ mouseSideButtons: e.target.checked }));
  if ($('setKeymapEnabled')) {
    $('setKeymapEnabled').addEventListener('change', async (e) => {
      await api.keymap.setEnabled(e.target.checked);
      toast({ title: e.target.checked ? 'Keymap enabled' : 'Key mapping disabled', type: 'ok' });
    });
  }
  // Laboratories: Multiple switches and back-office retentions. Change the hint to open application for next time (to switch application path to read it).
  if ($('setMultiWindow')) {
    $('setMultiWindow').addEventListener('change', (e) => {
      save({ engine: { multiWindow: e.target.checked } });
      toast({
        title: e.target.checked ? 'Background app retention enabled' : 'Single-app mode enabled',
        body: e.target.checked ? 'Applies on the next launch. Background apps can stay resident while one app is shown.' : '',
        type: 'ok',
      });
    });
  }
  if ($('setKeepBackground')) {
    $('setKeepBackground').addEventListener('change', (e) => {
      save({ engine: { keepBackground: Number(e.target.value) } });
    });
  }
  $('setDeepTrim').addEventListener('change', async (e) => {
    await save({ engine: { deepTrim: e.target.checked } });
    // Turn off the depth crop and restore the prepdisable-user bag, otherwise the impact will be lasting.
    if (!e.target.checked) {
      api.restoreSystemApps().catch(() => {});
      toast({ title: 'System components restored', body: 'The packages will be restored when Android restarts.', type: 'info' });
    }
  });
  $('setCompat').addEventListener('change', async (e) => {
    const on = e.target.checked;
    await save({ runtime: { compatImage: on } });
    const env = ((state.status = await api.runtimeStatus()).env) || {};
    const ok = env.playImage && env.playImage.ok;
    $('compatInstallField').hidden = !on || !!ok;
    if (on && !ok) toast({ title: 'ARM Compatibility Mode enabled', body: 'Download the Android 14 compatible image to continue (about 1.5 GB).', type: 'info' });
    else if (on) toast({ title: 'ARM Compatibility Mode enabled', body: 'Effective after restarting', type: 'info' });
  });
  $('setAutoShortcut').addEventListener('change', (e) => save({ createShortcutOnInstall: e.target.checked }));
  $('setStartMenuShortcut').addEventListener('change', (e) => save({ createStartMenuShortcut: e.target.checked }));
  $('setShortcutDir').addEventListener('change', (e) => save({ shortcutDir: e.target.value.trim() }));
  $('setDeviceSharedDir').addEventListener('change', (e) => save({ deviceSharedDir: e.target.value.trim() }));
  $('setAutoStart').addEventListener('change', (e) => save({ autoStart: e.target.checked }));
  $('setDisplayMode').addEventListener('change', async (e) => {
    const mode = e.target.value;
    $('portraitField').hidden = mode === 'fullscreen';
    state.settings = await api.setSettings({ display: { mode } });
    toast({ title: mode === 'fullscreen' ? 'Fullscreen enabled' : 'Windowed mode enabled', type: 'ok' });
  });
  if ($('setAutoFullscreen')) {
    $('setAutoFullscreen').addEventListener('change', async (e) => {
      const on = e.target.value === 'on';
      state.settings = await api.setSettings({ display: { autoFullscreenOnLaunch: on } });
      toast({ title: on ? 'Automatic Full Screen Enabled' : 'Turn off automatic fullscreen', body: 'Effective on next application open', type: 'ok' });
    });
  }
  if ($('setOrientationMode')) {
    $('setOrientationMode').addEventListener('change', async (e) => {
      const mode = e.target.value;
      state.settings = await api.setSettings({ display: { orientationMode: mode } });
      toast({
        title: mode === 'auto' ? 'Set to follow application' : (mode === 'landscape' ? 'Landscape' : 'Portrait'),
        body: mode === 'auto'
          ? 'Next time you turn on the application, the panel will be selected in its own direction, and if it does not, it will start again.'
          : 'Next time you turn the application on, you will reboot the panel to the specified direction and not restart it.',
        type: 'ok',
      });
    });
  }
  if ($('setAutoRotate')) {
    $('setAutoRotate').addEventListener('change', async (e) => {
      const on = e.target.value === 'on';
      state.settings = await api.setSettings({ display: { autoRotate: on } });
      toast({
        title: on ? 'Android auto-rotate enabled' : 'Android auto-rotate disabled',
        body: 'Applies the next time an app opens. The window orientation setting remains in effect.',
        type: 'ok',
      });
    });
  }
  if ($('setTabletMode')) {
    $('setTabletMode').addEventListener('change', async (e) => {
      const on = e.target.value === 'on';
      state.settings = await api.setSettings({ display: { tabletMode: on } });
      toast({
        title: on ? 'Tablet layout enabled' : 'Tablet layout disabled',
        body: 'Applies on next launch. A density change may restart Android.',
        type: 'ok',
      });
    });
  }
  if ($('setLandscape')) {
    $('setLandscape').addEventListener('change', async (e) => {
      const landscape = e.target.value === 'landscape';
      state.settings = await api.setSettings({ display: { landscape } });
      toast({
        title: landscape ? 'Virtual display set to landscape' : 'Virtual display set to portrait',
        body: 'The next time you turn on the application, you start running again to switch the physical panel direction (about a dozen seconds) and not again.',
        type: 'ok',
      });
    });
  }
  $('setPortrait').addEventListener('change', async (e) => {
    state.settings = await api.setSettings({ display: { portrait: e.target.value } });
    toast({ title: 'Image size updated', body: 'Effective when next application is open or toggled', type: 'ok' });
  });
  $('setWindowEmbed').addEventListener('change', async (e) => {
    const embed = e.target.value === 'embed';
    // WindowsEmbedChose tag "User Selected": Upgrades are no longer overtaken by default migrations.
    state.settings = await api.setSettings({
      display: { windowEmbed: embed, windowEmbedChosen: true },
    });
    toast({
      title: embed ? 'Embedded window mode enabled' : 'Standalone window mode enabled',
      body: embed
        ? 'Next time you open the application, it takes effect. The embedded mode is uniform, the title bar is rotated with a button, but it is easier to drop the frame or to have a black edge when zooming/rotation.'
        : 'The next application to open is effective. The original window is rendered and released by the simulator itself, the frame rate and zoom is more stable, and the screen is available on the tray menu or Ctrl+Alt+R.',
      type: 'ok',
    });
  });
  $('btnRebuildShortcuts').addEventListener('click', async () => {
    const r = await api.rebuildShortcuts();
    toast({
      title: r && r.fixed && r.fixed.length ? 'Shortcut completed' : 'Shortcuts are up to date',
      body: r && r.fixed && r.fixed.length ? r.fixed.join(', ') : 'Desktop and start menu entry normal',
      type: 'ok',
    });
  });

  $('btnDiagnostics').addEventListener('click', async () => {
    try {
      const r = await api.doctorReport();
      toast({ title: 'Diagnostic report exported', body: `${r.diagnosis.title} · ${r.file}`, type: 'ok', sticky: true });
    } catch (e) {
      toast({ title: 'Export Failed', body: e.message, type: 'error' });
    }
  });

  $('btnCleanup').addEventListener('click', async () => {
    const btn = $('btnCleanup');
    const includeSnapshots = $('chkCleanSnapshots') && $('chkCleanSnapshots').checked;
    btn.disabled = true;
    try {
      const preview = await api.runtimeCleanup({ apply: false, includeSnapshots });
      if (!preview.candidates.length) {
        toast({ title: 'It\'s already streamlined.', body: 'There are no unused system images or snapshots.', type: 'ok' });
        return;
      }
      const r = await api.runtimeCleanup({ apply: true, includeSnapshots });
      if (r.cancelled) return;
      toast({
        title: 'Cleanup completed.',
        body: `Release the contract ${(r.saved / 1048576).toFixed(0)} MB(${r.removed.length} ), installed application for retention.`,
        type: 'ok',
      });
      const u = await api.runtimeUsage();
      $('usageText').textContent = `Total ${u.totalText} · Recoverable ${u.reclaimableText}(${u.count} Item)`;
    } catch (e) {
      toast({ title: 'Cleanup failed', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  // Reset Android data: Level 2 confirmation (confirmation of intent and confirmation of irreversibility), clean up of occupancy statistics
  $('btnResetData').addEventListener('click', async () => {
    const btn = $('btnResetData');
    btn.disabled = true;
    try {
      const first = await api.confirm({
        type: 'warning',
        title: 'Reset Android data?',
        message: 'This resets the Android guest to a clean installation.',
        detail: '• Remove all installed third parties app (including red nuts, games, etc.) and their data, login\n'
          + '• Delete the current AVD quick start snapshot\n'
          + '• System mirrors are not affected per se, and reopening applications will freeze construction data again\n\n'
          + 'This operation is irrevocable. Do you continue?',
        buttons: ['Cancel', 'Go on.'],
        defaultId: 0,
        cancelId: 0,
      });
      if (!first || first.response !== 1) return;
      const second = await api.confirm({
        type: 'warning',
        title: 'Confirm Android data reset',
        message: 'Installed apps and their data will be permanently deleted, are you sure you want to reset them?',
        detail: 'Rest assured: System mirrors, other AVDs, the APK caches and icons on this machine will not move.',
        buttons: ['Cancel', 'Set Reset'],
        defaultId: 0,
        cancelId: 0,
      });
      if (!second || second.response !== 1) return;
      const r = await api.runtimeResetData();
      if (!r || !r.ok) {
        toast({ title: 'Reset Failed', body: (r && r.error) || 'Please try again.', type: 'error' });
        return;
      }
      toast({
        title: 'Android data reset',
        body: `Release the contract ${r.reclaimedMB} MB, installed application records are empty.`,
        type: 'ok',
      });
      const u = await api.runtimeUsage();
      $('usageText').textContent = `Total ${u.totalText} · Recoverable ${u.reclaimableText}(${u.count} Item)`;
    } catch (e) {
      toast({ title: 'Reset Failed', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  // Rehabilitating the network: Andreri Internet page is always blacked when the red belle is "consensual and continue" and the whole screen is black.
  // The root is the virtual machine/data’s Wi-Fi configuration is broken, wlan0 is not up, no default route.
  // Play Store mirrors do not allow root, only whole reset / data; apply list retentions, automatically reload when the point starts.
  $('btnRepairNetwork').addEventListener('click', async () => {
    const btn = $('btnRepairNetwork');
    btn.disabled = true;
    try {
      const ok = await api.confirm({
        type: 'warning',
        title: 'Repair the Android network?',
        message: 'Use this repair if Android apps cannot reach the network.',
        detail: 'It’ll be done at a cost from small to large.: \n\n'
          + 'Cold start of virtual aircraft (without snapshots) and wait for networking - without prejudice to any data\n'
          + 'Resetting Android data - application of list retention and automatic reloading at point of meeting, \n'
          + '   But the login state in the application, the record of the play, etc., will be lost.\n\n'
          + 'AVD only affects the current AVD, system mirrors and mainframe APK caches. The whole process is about 1-5 minutes. Do you continue?',
        buttons: ['Cancel', 'Start repair.'],
        defaultId: 0,
        cancelId: 0,
      });
      if (!ok || ok.response !== 1) return;
      const r = await api.runtimeRepairNetwork();
      if (!r || !r.ok) {
        toast({
          title: 'The network has not yet been restored.',
          body: (r && r.error) || 'The reset virtual machine is still non-networked, and please check if the network/firewall has stopped the simulator.',
          type: 'error',
        });
        return;
      }
      toast({
        title: 'Network restored.',
        body: `${(r.network && r.network.ip) || 'Networked'}${r.wiped ? '(To restore the network by resetting Android data, the point-opening application automatically reloads.)' : '(I didn\'t touch your data.)'}`,
        type: 'ok',
      });
    } catch (e) {
      toast({ title: 'Failed to fix', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  // Clears old version residues: Scan the old program directory / invalid unload / update the temporary file and clears it once confirmed.
  $('btnLeftovers').addEventListener('click', async () => {
    const btn = $('btnLeftovers');
    btn.disabled = true;
    try {
      const r = await api.leftoversScan();
      if (!r || !r.ok) {
        toast({ title: 'Scan Failed', body: (r && r.error) || 'Please try again.', type: 'error' });
        return;
      }
      const items = r.items || [];
      if (!items.length) {
        toast({ title: 'It\'s clean.', body: 'There’s no trace of the old version.', type: 'ok' });
        return;
      }
      const mb = Math.round((r.totalBytes || 0) / 1048576);
      const lines = items.slice(0, 8).map((x) => `• ${x.note}: ${x.path}`);
      if (items.length > 8) lines.push(`…There's another one. ${items.length - 8} Item`);
      const ok = await api.confirm({
        type: 'warning',
        title: 'Cleaning up the old version?',
        message: `Found it. ${items.length} Item residue, approximately ${mb} MB: `,
        detail: `${lines.join('\n')}\n\n Only delete "old version of program directory / invalid unmount item / update temporary file",`
          + 'The current version and your application data are not moving.',
        buttons: ['Cancel', 'Start cleaning.'],
        defaultId: 1,
        cancelId: 0,
      });
      if (!ok || ok.response !== 1) return;
      const c = await api.leftoversClean(items);
      if (!c || !c.ok) {
        toast({ title: 'Cleanup failed', body: (c && c.error) || 'Please try again.', type: 'error' });
        return;
      }
      const failNote = (c.failed && c.failed.length) ? `, ${c.failed.length} Items are occupied and not deleted` : '';
      toast({
        title: 'Residue from old version cleared',
        body: `Removed ${c.removed.length} items and freed ${c.freedMB || 0} MB${failNote}.`,
        type: 'ok',
      });
      const u = await api.runtimeUsage();
      $('usageText').textContent = `Total ${u.totalText} · Recoverable ${u.reclaimableText}(${u.count} Item)`;
    } catch (e) {
      toast({ title: 'Cleanup failed', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  $('btnOpenShared').addEventListener('click', () => api.openSharedDir());

  // Rebuild shortcuts: Desktop icons are deleted by error/ the back entrance when the security software stops them
  $('btnRebuildShortcuts').addEventListener('click', async () => {
    const btn = $('btnRebuildShortcuts');
    btn.disabled = true;
    try {
      const r = await api.rebuildShortcuts().catch(() => ({ ok: false }));
      const fixed = (r && r.fixed) || [];
      toast(fixed.length
        ? { title: 'Shortcut recreated', body: fixed.join(', '), type: 'ok' }
        : { title: 'The shortcuts are all over the place.', body: 'There\'s no entrance to be rebuilt.', type: 'info' });
    } finally {
      btn.disabled = false;
    }
  });

  // Shared directory: Browse the selected directory and " Save and Migration " to move old files to a new directory
  $('btnBrowseShared').addEventListener('click', async () => {
    const picked = await api.openDir();
    if (!picked) return;
    $('setSharedDir').value = picked;
    toast({ title: 'New directory selected', body: 'Point “Save and migrate“ to move old files', type: 'info' });
  });
  $('btnSaveShared').addEventListener('click', async () => {
    const dir = $('setSharedDir').value.trim();
    if (!dir) { toast({ title: 'Please fill in or browse the directory first.', type: 'error' }); return; }
    const btn = $('btnSaveShared');
    btn.disabled = true;
    const r = await api.setSharedDir(dir).catch(() => ({ ok: false }));
    btn.disabled = false;
    if (r.ok) {
      const moved = r.oldDir && r.oldDir !== r.newDir;
      toast({ title: 'Share directory updated', body: moved ? 'The existing files in the old directory have been migrated to the new directory' : 'Saved', type: 'ok' });
    } else {
      toast({ title: 'Save Failed', body: r.error, type: 'error' });
    }
  });

  // Unmounting Hydra Emulator Body (cancellation.apk association + start unmounting program; portable version manually removed)
  $('btnUninstall').addEventListener('click', async () => {
    const ok = window.confirm('Uninstall Hydra Emulator?\n\nThis removes Hydra Emulator and its .apk file association.');
    if (!ok) return;
    const btn = $('btnUninstall');
    btn.disabled = true;
    const r = await api.removeSelf().catch(() => ({ ok: false }));
    if (r.ok && r.portable) {
      btn.disabled = false;
      toast({
        title: 'Portable version cannot be automatically unmounted',
        body: `Please manually delete the program directory(${r.exeDir}) With Data Directory(${r.dataDir})`,
        type: 'info', sticky: true,
      });
      return;
    }
    if (!r.ok) {
      btn.disabled = false;
      toast({ title: 'Uninstall failed', body: r.error, type: 'error' });
      return;
    }
    toast({ title: 'Unmounting…', body: 'Unmounting program started and Hydra Emulator is about to quit', type: 'ok', sticky: true });
  });

  // ARM compatible mirror download (with progress past)
  $('btnInstallPlay').addEventListener('click', async () => {
    const btn = $('btnInstallPlay');
    btn.disabled = true;
    const t = toast({ title: 'Start downloading ARM compatible mirrors', body: 'Preparing…', sticky: true, spinner: true, progress: 3 });
    const un = api.on('provision:progress', (p) => {
      if (p.component !== 'playimg') return;
      t.update({ title: 'Download ARM compatible mirrors', body: p.message || '', progress: p.percent });
    });
    try {
      const r = await api.installPlayImage();
      if (r && r.ok) {
        t.update({ title: 'ARM compatible mirror ready', body: 'Effective after restarting', progress: 100 });
        setTimeout(() => t.dismiss(), 3000);
        $('compatInstallField').hidden = true;
        refreshStatus();
      } else {
        t.update({ title: 'Failed to download compatible mirrors', body: (r && r.error) || 'Unknown error', progress: null });
        t.dismiss();
        toast({ title: 'Failed to download compatible mirrors', body: (r && r.error) || 'Unknown error', type: 'error' });
      }
    } catch (e) {
      t.dismiss();
      toast({ title: 'Failed to download compatible mirrors', body: e.message, type: 'error' });
    } finally {
      un();
      btn.disabled = false;
    }
  });

  // Synchronized mirror status display
  (async () => {
    const env = ((state.status = await api.runtimeStatus()).env) || {};
    const s = state.settings;
    const on = !!(s && s.runtime && s.runtime.compatImage);
    const ok = env.playImage && env.playImage.ok;
    $('compatInstallField').hidden = !on || !!ok;
    if (env.playImage) {
      $('compatImgStatus').textContent = ok
        ? `Ready(${(env.playImage.size / 1073741824).toFixed(2)} GB)` : 'Not Downloaded';
    }
  })();
  $('btnOpenData').addEventListener('click', async () => {
    const info = await api.info();
    const dir = info.runtimeDir || info.dataDir;
    window.open(`file:///${dir.replace(/\\/g, '/')}`);
  });
  $('btnBrowseRuntimeDir').addEventListener('click', async () => {
    const info = await api.info();
    const picked = await api.openDir();
    if (!picked) return;
    await api.setSettings({ runtime: { dir: picked } });
    $('setRuntimeDir').value = picked;
    toast({ title: 'Data directory updated', body: 'Please restart Hydra Emulator to make it effective (old data will not be moved automatically).)', type: 'ok', sticky: true });
  });

  // AVD + snapshot: The one that really eats the plate, points to the other.
  if ($('btnBrowseAvdDir')) {
    $('btnBrowseAvdDir').addEventListener('click', async () => {
      const picked = await api.openDir();
      if (!picked) return;
      await api.setSettings({ runtime: { avdDir: picked } });
      $('setAvdDir').value = picked;
      toast({
        title: 'Android Data Directory Updated',
        body: 'Please restart Hydra Emulator to make it effective. Hydra.avd in the old directory can move to the new directory as a whole and delete the old one.',
        type: 'ok',
        sticky: true,
      });
    });
  }
  if ($('btnOpenAvdDir')) {
    $('btnOpenAvdDir').addEventListener('click', async () => {
      const info = await api.dataInfo().catch(() => null);
      const dir = (info && info.avdDir) || (await api.info()).dataDir;
      window.open(`file:///${String(dir).replace(/\\/g, '/')}`);
    });
  }

  $('btnRuntimeStart').addEventListener('click', async () => {
    const el = $('probeResult');
    el.textContent = 'Starting…';
    const r = await api.runtimeStart();
    el.textContent = r.ok ? `Ready: ${r.engine}` : `Startup failed: ${r.error}`;
    refreshStatus();
  });

  $('btnRuntimeStop').addEventListener('click', async () => {
    await api.runtimeStop();
    $('probeResult').textContent = 'Built virtual machine stopped';
    refreshStatus();
  });

  $('btnAssoc').addEventListener('click', async () => {
    const btn = $('btnAssoc');
    if (btn.dataset.on === '1') {
      await api.assocUnregister();
      btn.textContent = 'Associate .apk files';
      btn.dataset.on = '0';
      toast({ title: '.Apk connection cancelled' });
    } else {
      const r = await api.assocRegister();
      btn.textContent = 'Remove association';
      btn.dataset.on = '1';
      toast({ title: '.Apk connection started', body: r.ok ? 'Now double-click APK to install directly to Hydra Emulator.' : '', type: r.ok ? 'ok' : 'error' });
    }
  });
}

/* -------------------------------------------------------------------------------------------------------------------- */

function bindEvents() {
  // Link to Unified Walking System Browser
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href^="http"]');
    if (!a) return;
    e.preventDefault();
    api.openExternal(a.getAttribute('href'));
  });

  $('btnSettings').addEventListener('click', openSettings);
  // 0.6.2: The built-in manual can be opened directly from the title bar and from the " About" page
  $('btnManual')?.addEventListener('click', () => openManual({ topic: 'overview', reason: 'toolbar' }));
  $('btnOpenManual')?.addEventListener('click', () => openManual({ topic: 'overview', reason: 'about' }));
  // Status label also when entry: point "Need to deploy/ Guideing / Android 14" directly into the runtime panel set
  $('engineTag').addEventListener('click', () => showSetup(true));
  $('btnCloseSettings').addEventListener('click', closeSettings);
  $('btnDoneSettings').addEventListener('click', closeSettings);
  $('settingsMask').addEventListener('click', (e) => {
    if (e.target === $('settingsMask')) closeSettings();
  });

  // Deployment while running: entrances are in settings where only the buttons in the panel are processed
  $('btnDeployAll').addEventListener('click', deployAll);
  $('btnMarkInstalled').addEventListener('click', markInstalled);
  $('btnGuideClose').addEventListener('click', () => { $('setupGuide').hidden = true; });
  $('btnSetupAdvanced').addEventListener('click', () => {
    const adv = document.querySelector('.advanced-group');
    if (adv) {
      adv.open = true;
      adv.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  });

  // Self-censorship count on the status bar: Dot-open is the running-time panel in the settings
  $('envChip').addEventListener('click', () => {
    openSettings().then(() => {
      const box = $('envCheck');
      if (box && !box.hidden) focusGroup(box);
      else focusGroup($('runtimeGroup'));
    }).catch(() => {});
  });

  $('setupSteps').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    if (act === 'emulator' || act === 'sysimg' || act === 'accel'
      || act === 'adb' || act === 'qemu' || act === 'iso' || act === 'disk') {
      const r = await runStep(act);
      if (!r.ok) toast({ title: 'Operation Failed', body: r.error, type: 'error', sticky: true });
      return;
    }
    if (act === 'isoImport') {
      const r = await api.importIso();
      if (r.ok) { toast({ title: 'system image Imported', body: r.path, type: 'ok' }); refreshStatus(); }
      else if (!r.canceled) toast({ title: 'Import Failed', body: r.error, type: 'error' });
      return;
    }
    if (act === 'diskImport') {
      const r = await api.importDisk();
      if (r.ok) { toast({ title: 'Virtual disk imported', body: 'Directly start running', type: 'ok' }); refreshStatus(); }
      else if (!r.canceled) toast({ title: 'Import Failed', body: r.error, type: 'error' });
      return;
    }
    if (act === 'install') { await startInstall(); return; }
    if (act === 'vmStart') {
      const t = toast({ title: 'Start running while…', body: 'Start the first time the Android system needs to be guided', sticky: true, spinner: true });
      const r = await api.runtimeStart();
      if (r.ok) { t.update({ title: 'Runtime ready', type: 'ok' }); setTimeout(t.dismiss, 2200); }
      else t.update({ title: 'Startup failed', body: r.error, type: 'error' });
      refreshStatus();
      return;
    }
    if (act === 'vmStop') {
      await api.runtimeStop();
      toast({ title: 'End of session when running' });
      refreshStatus();
    }
  });

  const pick = async () => {
    const files = await api.pickApk();
    if (files.length) installFiles(files);
  };
  $('btnInstall').addEventListener('click', pick);
  $('btnInstall2').addEventListener('click', pick);
  // Share directory entry to settings: Synchronize + Open in file interconnection group
  const btnSync = $('btnSyncShared');
  if (btnSync) btnSync.addEventListener('click', async () => {
    btnSync.disabled = true;
    try {
      await api.syncShared();
      toast({ title: 'Shared Directory Synchronized', type: 'ok' });
    } catch (_) {
      toast({ title: 'Sync failed', body: 'Skip sync when running unready', type: 'error' });
    } finally {
      btnSync.disabled = false;
    }
  });

  $('search').addEventListener('input', (e) => {
    state.filter = e.target.value;
    renderGrid();
  });

  $('grid').addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    // Add Application card does not have data-pkg, go installation process instead of startup.
    // Directly rotates the APK button in the toolbar, and returns its file to choose logic.
    if (card.classList.contains('card-add')) { $('btnInstall').click(); return; }
    if (card.dataset.pkg) launchApp(card.dataset.pkg);
  });

  $('grid').addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    e.preventDefault();
    showMenu(e.clientX, e.clientY, card.dataset.pkg);
  });

  $('grid').addEventListener('dblclick', (e) => {
    const card = e.target.closest('.card');
    if (card) createShortcut(card.dataset.pkg);
  });

  $('ctxmenu').addEventListener('click', (e) => {
    const item = e.target.closest('.item');
    if (item) handleMenu(item.dataset.act);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#ctxmenu')) hideMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideMenu();
      closeSettings();
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('search').focus();
    }
  });

  // Drag and drop installation
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    $('dropzone').classList.add('on');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) $('dropzone').classList.remove('on');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropzone').classList.remove('on');
    const files = [...(e.dataTransfer?.files || [])];
    const paths = files
      .map((f) => { try { return api.pathForFile(f); } catch (_) { return null; } })
      .filter((p) => p && /\.apk$/i.test(p));
    if (paths.length) installFiles(paths);
    else toast({ title: 'Only drag into .apk files', type: 'error' });
  });

  // Main Process Events
  api.on('install:error', (p) => {
    // If you're wrong, don't let the "in the process of installation" go around again.)
    if (installToast) { try { installToast.dismiss(); } catch (_) { /* ignore */ } installToast = null; }
    const name = p && p.file ? String(p.file).split(/[\\/]/).pop() : '';
    const raw = (p && p.message) || 'Unknown error';
    toast({
      title: name ? `Installation failed: ${name}` : 'Installation failed',
      body: friendlyInstallErrorText(raw),
      type: 'error',
    });
    // 0.6.2: Auto-publish the corresponding chapter to the user (ARM/ signature/ space) for installation failure…)
    openManualForError(raw, 'install-failed');
  });
  api.on('toast', (p) => toast({ title: p.message, type: p.type === 'error' ? 'error' : 'info' }));
  api.on('app:launched', () => setTimeout(refreshApps, 800));
  // Applying is turned off (Tray Closes the current application, Right Key Menu, or Window Closes) to refresh the Run-in mark
  api.on('apps:changed', () => setTimeout(refreshApps, 300));
  api.on('runtime:log', (m) => console.log('[runtime]', m));
  api.on('ui:navigate', (v) => {
    if (v === 'settings') openSettings();
    if (v === 'setup') { showSetup(true); refreshStatus(); }
  });
  api.on('provision:progress', (p) => updateStepProgress(p.component, p));
  api.on('update:state', (info) => {
    if (!info) return;
    renderUpdate(info);
    // Start 8 seconds to get the update: welcome Carol's open. Add the new version.
    const wm = $('welcomeMask');
    if (wm && !wm.hidden) renderWelcomeTips();
  });
  api.on('update:progress', (p) => renderUpdateProgress(p));
  // Autotest: When the main process runs out of time, pushes the results, and the set pages are open and the panel is just refreshed.
  api.on('autodebug:state', (r) => {
    if (r && r.running) {
      const txt = $('autodebugStateText');
      if (txt) txt.textContent = 'Checking…';
      return;
    }
    renderAutodebug(r);
  });
}

/* ----------------- */

async function init() {
  bindEvents();
  bindSettings();
  bindSettingsCategory();
  bindAutodebug();
  bindUpdate();
  bindAndroid();
  bindWelcome();
  state.settings = await api.getSettings();
  await refreshStatus();
  await refreshApps();
  refreshAndroid();
  selfCheck();
  maybeShowWelcome();
  setInterval(refreshStatus, 6000);
  setInterval(refreshApps, 15000);
  setInterval(selfCheck, 60000);
}

/* ------------------------------------------------------------------------------------------------------------------------------------------ */

let startupInfo = null;

function greetingOf(h) {
  if (h < 5) return 'It\'s late.';
  if (h < 11) return 'Good morning.';
  if (h < 13) return 'Good afternoon.';
  if (h < 18) return 'Good afternoon.';
  return 'Good evening.';
}

function bindWelcome() {
  const mask = $('welcomeMask');
  if (!mask) return;
  const close = () => { mask.hidden = true; };
  const never = $('welcomeNever');
  $('welcomeOk').addEventListener('click', () => {
    if (never && never.checked) api.setSettings({ welcome: { disabled: true } }).catch(() => {});
    close();
  });
  $('welcomeSettings').addEventListener('click', () => { close(); openSettings(); });
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !mask.hidden) close(); });
}

/** The decision whether to play is to start the self-activated bomb; to open it manually at most once a day and the user can close it permanently. */
async function maybeShowWelcome() {
  const mask = $('welcomeMask');
  if (!mask) return;
  // Don’t play a welcome card when you smoke the screenshot: otherwise every automatic screenshot is blocked by it.
  try { if ((await api.startupInfo()).smoke) return; } catch (_) { /* ignore */ }
  try { startupInfo = await api.startupInfo(); } catch (_) { startupInfo = null; }
  const cfg = (state.settings && state.settings.welcome) || {};
  if (cfg.disabled) return;
  const today = new Date().toISOString().slice(0, 10);
  if (!(startupInfo && startupInfo.autostart) && cfg.lastDate === today) return;

  const h = new Date().getHours();
  $('welcomeHi').textContent = `${greetingOf(h)}, Welcome back.`;
  const ver = (startupInfo && startupInfo.version) || (state.status && state.status.version) || '';
  const ready = state.status && state.status.ready;
  $('welcomeSub').textContent = `Hydra Emulator${ver ? ` v${ver}` : ''} · ${ready ? 'Run as you like, open as soon as you want.' : 'Automatically prepare when running'}`;

  const apps = (state.apps || []).length;
  const dev = $('statusDevice') ? $('statusDevice').textContent.trim() : '';
  const chips = [
    { k: String(apps), v: 'installed' },
    { k: ready ? 'Ready' : 'Stand by.', v: 'Android runtime' },
    { k: dev ? dev.replace(/^.*?(\d+)/, '$1') : '—', v: 'Device/ Port' },
  ];
  $('welcomeStats').innerHTML = chips
    .map((c) => `<div class="welcome-stat"><b>${esc(c.k)}</b><span>${esc(c.v)}</span></div>`)
    .join('');

  const tips = [];
  $('welcomeTips').innerHTML = '';
  mask.hidden = false;
  renderWelcomeTips();
  api.setSettings({ welcome: { lastDate: today } }).catch(() => {});
}

/** Reminder area alone: start 8 seconds before you get the update, and the card may still be open, and it needs to be refilled. */
function renderWelcomeTips() {
  const box = $('welcomeTips');
  if (!box) return;
  const apps = (state.apps || []).length;
  const tips = [];
  if (lastUpdate && lastUpdate.hasUpdate) {
    tips.push(`New Version Found <b>${esc(lastUpdate.tag || '')}</b>, Updateable with Settings & Software Update`);
  }
  if (!apps) {
    tips.push('Drag APK into the window to install it, and automatically generate desktop icons after loading');
  } else {
    tips.push('Double-click application card to run in a stand-alone window, rotated at the upper right corner / zoomed in / closed');
  }
  tips.push('Close the window just to exit the application, and the Android environment will remain, and the next time it opens faster.');
  box.innerHTML = tips
    .map((t, i) => `<div class="welcome-tip"><i>${i + 1}</i><span>${t}</span></div>`)
    .join('');
}

/* - - - - - Environmental self-examination - - */

let envBusy = false;

/** Draw doctor:selfCheck: Rendering the problem to a self-check panel in the setup and leaving a count on the status bar */
async function selfCheck() {
  if (envBusy) return;
  envBusy = true;
  try {
    const r = await api.selfCheck().catch(() => null);
    if (r) renderEnvCheck(r);
  } catch (_) { /* Self-check failure does not interrupt main process */ }
  finally { envBusy = false; }
}

function renderEnvCheck(r) {
  const box = $('envCheck');
  if (!box) return;
  // The "part missing" has been overwritten in the completion of a key to the same panel and is not repeated.
  const needDeploy = !!(state.status && state.status.needsSetup);
  const issues = (r.issues || []).filter((i) => !(needDeploy && i.fix === 'deploy'));

  // Main interface no more banners: leave only a pointable count on the bottom status bar, and the point is the self-censorship panel in the set
  const chip = $('envChip');
  if (chip) {
    const errs = issues.filter((i) => i.severity === 'error').length;
    chip.hidden = issues.length === 0;
    chip.textContent = errs ? `${errs} Items to be repaired` : `${issues.length} Item Hint`;
    chip.className = `status-chip${errs ? ' err' : ''}`;
    chip.title = issues.map((i) => i.title).join('; ');
  }

  if (!issues.length) {
    box.hidden = false;
    box.innerHTML = `
      <div class="env-check-ok">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>
        <span>Diagnostics found no issues.</span>
        <span style="flex:1"></span>
        <button class="btn ghost sm" id="btnEnvRecheck">Recheck</button>
      </div>`;
    const re = $('btnEnvRecheck');
    if (re) re.addEventListener('click', selfCheck);
    return;
  }
  const errs = issues.filter((i) => i.severity === 'error').length;
  const warns = issues.length - errs;
  box.hidden = false;
  box.innerHTML = `
    <div class="env-check-head">
      <span class="ec-title">System diagnostics</span>
      ${errs ? `<span class="ec-count">${errs}  serious</span>` : ''}
      ${warns ? `<span class="ec-count warn">${warns} warnings</span>` : ''}
      <span class="ec-spacer"></span>
      <button class="btn ghost sm" id="btnEnvRecheck">Recheck</button>
      <button class="btn primary sm" id="btnEnvFixAll">Fix all</button>
    </div>
    <div class="env-check-list">
      ${issues.map((i) => `
        <div class="env-check-item ${i.severity}">
          <span class="ec-sev"></span>
          <div class="ec-body">
            <div class="ec-name">${esc(i.title)}</div>
            <div class="ec-hint">${esc(i.hint || '')}</div>
          </div>
          ${i.fix ? `<button class="ec-fix" data-code="${esc(i.code)}">Fix</button>` : ''}
          <button class="ec-help" data-code="${esc(i.code)}" title="Open the user manual">Help</button>
        </div>`).join('')}
    </div>`;
  const re = $('btnEnvRecheck');
  if (re) re.addEventListener('click', selfCheck);
  const fixAll = $('btnEnvFixAll');
  if (fixAll) fixAll.addEventListener('click', () => fixAllIssues(issues));
  box.querySelectorAll('.ec-fix').forEach((b) => {
    b.addEventListener('click', () => {
      const issue = issues.find((x) => x.code === b.dataset.code);
      if (issue) fixIssue(issue);
    });
  });
  box.querySelectorAll('.ec-help').forEach((b) => {
    b.addEventListener('click', () => {
      const issue = issues.find((x) => x.code === b.dataset.code);
      if (issue) openManualForIssue(issue, 'clicked');
    });
  });
}

/** The repair failed: falsely reported, and the corresponding curriculum opened automatically (only one play in 60 seconds).) */
function failFix(issue, ctl, body) {
  const msg = body || 'Please do it manually.';
  if (ctl && typeof ctl.update === 'function') ctl.update({ body: msg, type: 'error', sticky: true });
  else toast({ title: 'Fix not completed', body: msg, type: 'error' });
  openManualForIssue(issue, 'fix-failed');
}

async function fixIssue(issue) {
  switch (issue.fix) {
    case 'vcRedist': {
      const r = await api.installVcRedist().catch(() => ({ ok: false }));
      if (!r.ok && r.reason === 'no-installer') {
        api.openExternal('https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170#visual-studio-2015-2017-2019-and-2022');
        toast({ title: 'No built-in installation package found', body: 'Opened Microsoft official download page, please download version x64', type: 'info' });
        break;
      }
      toast(r.ok
        ? { title: 'VC++ running library installed', type: 'ok' }
        : { title: 'Installation not completed', body: r.error || 'Please try again.', type: 'error' });
      break;
    }
    case 'virtualization': {
      const t = toast({ title: 'Starting hardware acceleration.…', body: 'Please " Yes " at the popup window point', sticky: true, spinner: true });
      const r = await api.enableVirtualization().catch(() => ({ ok: false }));
      if (r.ok) {
        t.update({ title: 'Hardware acceleration enabled', body: r.restartNeeded ? 'Please restart the computer to get the best performance.' : (r.note || ''), type: 'ok' });
        setTimeout(t.dismiss, 3200);
      } else if (r.manual) {
        // MSIX: Packing mediumIL, usually without manager's authorization.
        // Instead of letting the user point a doomed failure button, let’s just turn the Windows function on or off
        // The dialogue box pops out and tells him which one.
        t.dismiss();
        await api.openWindowsFeatures?.().catch(() => null);
        toast({
          title: 'Need to open it manually (only once))',
          body: r.note || 'Check the Windows Virtual Machine Monitor Program platform in the open window, and check to restart the computer.',
          type: 'info',
          sticky: true,
        });
        // When automatic access is not working, turn the graphics into an instruction in a synchronized way, so that users don’t know what to hook up with the system window.
        openManualForIssue(issue, 'fix-failed');
      } else if (r.cancelled) {
        t.update({ title: 'Cancelled', body: r.error || 'No manager’s authorization, no change in hardware acceleration.', type: 'info', spinner: false });
        setTimeout(t.dismiss, 4200);
      } else {
        failFix(issue, t, r.error || r.note || 'Hardware acceleration failed to turn on. Reciprocal course opened.');
      }
      break;
    }
    case 'disk': {
      // The main process will eject the primary confirmation box (including a releaseable space preview), and this is no longer repeated confirm
      const r = await api.runtimeCleanup({ apply: true }).catch(() => null);
      if (!r) { toast({ title: 'Cleanup failed', body: 'Please try again.', type: 'error' }); break; }
      if (r.cancelled) break;
      toast({ title: 'Cleanup completed.', body: `Release the contract ${((r.saved || 0) / 1048576).toFixed(0)} MB`, type: 'ok' });
      break;
    }
    case 'path': {
      toast({ title: 'Suggested to be changed to a purely English directory', body: 'Modify the runtime Data Directory in the Settings → System Integration and restart the software.', type: 'info', sticky: true });
      openSettings();
      break;
    }
    case 'deploy': {
      toast({ title: 'Completing missing running-time components…', type: 'info', sticky: true, spinner: true });
      await deployAll();
      break;
    }
    case 'lock': {
      const r = await api.clearLocks().catch(() => ({ ok: false }));
      toast(r.ok ? { title: 'Residue lock files cleared', type: 'ok' } : { title: 'Cleanup failed', body: r.error, type: 'error' });
      break;
    }
    // - Autodetect (auto debug) added fix action -
    case 'restartRuntime': {
      // Unauthorized / Lead Card Death / Orphan Lock’s preferred self-repair action: Stop pulling again (freezing start))
      const t = toast({ title: 'Restarting Android.…', body: 'It\'ll be re-directed again, about a dozen seconds.', type: 'info', sticky: true, spinner: true });
      const r = await api.restartRuntime().catch(() => ({ ok: false }));
      if (r && r.ok) {
        t.update({ title: 'Android’s running again.', body: 'Please click "Approved" for authorized windows.', type: 'ok' });
        setTimeout(t.dismiss, 3000);
      } else {
        failFix(issue, t, (r && r.error) || 'Reboot failed, the corresponding curriculum is open');
      }
      break;
    }
    case 'orphans': {
      const r = await api.clearOrphans().catch(() => ({ ok: false }));
      toast(r && r.ok
        ? { title: 'Process of clean-up of residual simulators', type: 'ok' }
        : { title: 'Cleanup failed', body: (r && r.error) || 'Please try again.', type: 'error' });
      break;
    }
    case 'snapshots': {
      const r = await api.clearSnapshot().catch(() => ({ ok: false }));
      toast(r && r.ok
        ? { title: 'We’ve got a quick startup snapshot.', body: 'Next time you open the application, you\'ll walk a full cold start.', type: 'ok' }
        : { title: 'Discard failed', body: (r && r.error) || 'Please try again.', type: 'error' });
      break;
    }
    case 'dataReset': {
      // When the magnification is blocked by the differential disk, it must be rebuilt: it will clear the installed application, so only guides, not automatically.
      toast({
        title: 'We need to rebuild the Android Data Division.',
        body: 'To Set up & Performance and Resources, “ Immediate Extension “ ; Confirm once (which will empty the installed application) when the reset is required.',
        type: 'info',
        sticky: true,
      });
      openSettings().then(() => focusGroup($('perfGroup'))).catch(() => {});
      break;
    }
    case 'orientation': {
      // Keep the physical panel in line with the strategy: if the strategy is to be overscreened, it is to be overscreened, it is to be overscreened.
      const s = (state.settings && state.settings.display) || {};
      const mode = s.orientationMode || 'auto';
      if (mode === 'auto') {
        toast({ title: 'Current is Follow application', body: 'The panel direction is automatically switched to the application; if an application is not in the right direction, it can be assigned separately.', type: 'info' });
        break;
      }
      const wantLandscape = mode === 'landscape';
      state.settings = await api.setSettings({ display: { landscape: wantLandscape } });
      fillSettings(state.settings);
      toast({
        title: wantLandscape ? 'Panel has been cut to a screen.' : 'The panel has been cut into a screen.',
        body: 'Applies the next time you open an app.',
        type: 'ok',
      });
      break;
    }
    case 'shared': {
      toast({ title: 'Please check the shared directory', body: 'To Set → Integration & File to confirm that the shared directory exists and is writeable.', type: 'info', sticky: true });
      openSettings().then(() => focusGroup(document.querySelector('#settingsBody [data-cat="files"]'))).catch(() => {});
      break;
    }
    // -0.6.2 Sound detection corresponding repair action -
    case 'audio': {
      const t = toast({ title: 'Turning on Android’s app.…', body: 'Disable-no-audio when restarting immediately', type: 'info', sticky: true, spinner: true });
      const s = await api.setSettings({ engine: { audio: true } }).catch(() => null);
      if (!s) { failFix(issue, t, 'Unable to save sound settings, corresponding instruction opened'); break; }
      state.settings = s;
      fillSettings(s);
      const r = await api.restartRuntime().catch(() => ({ ok: false }));
      if (r && r.ok !== false) {
        t.update({ title: 'The sound is on.', body: 'It\'s been rebooted at the time of the operation. Now I think I can hear the app.', type: 'ok' });
        setTimeout(t.dismiss, 3600);
      } else {
        failFix(issue, t, 'Sound switch open, but restarting on running failed, opening the corresponding lesson');
      }
      break;
    }
    case 'audioService': {
      // MSIX / Normal permissions do not allow the system service to be activated, direct to the user
      toast({ title: 'Windows Audio needs to start manually', body: 'We\'ve opened the curriculum. Just do it once.', type: 'info', sticky: true });
      openManualForIssue(issue, 'clicked');
      break;
    }
    case 'repairNetwork': {
      const t = toast({ title: 'Resetting Android Network.…', body: 'Apply the list to keep', type: 'info', sticky: true, spinner: true });
      const r = await api.runtimeRepairNetwork().catch(() => ({ ok: false }));
      if (r && r.ok !== false) {
        t.update({ title: 'Android Network has been reset.', body: 'Next time open application reconnect', type: 'ok' });
        setTimeout(t.dismiss, 3000);
      } else {
        t.update({ title: 'Reset Failed', body: (r && r.error) || 'Please try again.', type: 'error' });
      }
      break;
    }
    case 'report': {
      const r = await api.doctorReport().catch(() => null);
      toast(r && r.ok !== false
        ? { title: 'Diagnostic report exported', body: 'Attach the report when opening a GitHub issue', type: 'ok' }
        : { title: 'Export Failed', body: (r && r.error) || 'Please try again.', type: 'error' });
      break;
    }
    case 'settings': {
      openSettings();
      break;
    }
    default:
      toast({ title: 'Autorepair is not supported', body: issue.hint || '', type: 'info' });
  }
  // Recheck after repair, refresh banners and states
  setTimeout(selfCheck, 600);
  setTimeout(refreshStatus, 600);
}

async function fixAllIssues(issues) {
  const fixable = issues.filter((i) => i.fix);
  for (const i of fixable) {
    // eslint-disable-next-line no-await-in-loop
    await fixIssue(i);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, 500));
  }
}

init().catch((e) => {
  console.error(e);
  toast({ title: 'Initialisation failed', body: e.message, type: 'error', sticky: true });
});
