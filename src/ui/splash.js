'use strict';
/* Hydra Emulator splash script: receives progress updates from the main process and controls the fade-out */

const api = window.hydraSplash;
if (!api) { /* exit silently when preload is not injected */ }

const $ = (id) => document.getElementById(id);

// Version number
api?.version?.().then((v) => { if ($('ver')) $('ver').textContent = v || ''; }).catch(() => {});

// First-run marker + whether components are bundled with the package
Promise.all([
  api?.isFirstRun?.().catch(() => false),
  api?.bundled?.().catch(() => false),
]).then(([first, bundled]) => {
  if (!first || !$('firstRun')) return;
  $('firstRun').hidden = false;
  // Bundled runtime (full installer / Microsoft Store MSIX build): "download" should never be mentioned.
  // The complaint was "installed 850MB and it is still downloading the image" — in reality it was only
  // extracting the compressed image bundled in the package into the user directory, with no network needed.
  if (bundled) {
    if ($('firstRunTitle')) $('firstRunTitle').textContent = 'First launch · Preparing locally (no internet needed)';
    if ($('firstRunList')) {
      $('firstRunList').innerHTML = [
        '<li>Runtime components are bundled with the installer — nothing else will be downloaded</li>',
        '<li>Extracting the system image to your user directory (about 1 minute, one time only)</li>',
        '<li>Configuring hardware acceleration and networking</li>',
        '<li>Once finished, double-click any APK or desktop icon to launch apps instantly</li>',
      ].join('');
    }
  }
}).catch(() => {});

// Progress updates
api?.onProgress?.((p) => {
  if (!p) return;
  if (p.percent != null && $('progressBar')) {
    $('progressBar').style.width = Math.min(100, Math.max(0, p.percent)) + '%';
  }
  if (p.message && $('status')) {
    $('status').textContent = p.message;
  }
});

// Done → fade out
api?.onDone?.(() => {
  const splash = $('splash');
  if (splash) {
    splash.classList.add('out');
    setTimeout(() => { api?.close?.(); }, 520);
  }
});
