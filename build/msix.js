'use strict';
/**
 * Microsoft Store (MSIX) packaging.
 *
 * Why not electron-builder's appx target:
 *   - 26.x only ships appx (no msix), and silently downloads a whole Windows SDK
 *     toolset (windows-kits-bundle-10_0_26100_0.zip) at build time as a black-box dependency;
 *   - We need to put our own set of things into the manifest (runFullTrust, file
 *     associations, identity info matching the review notes), and a hand-written
 *     manifest is more controllable than patching its template.
 * So we assemble the stage ourselves and call makeappx ourselves, depending only
 * on two exes from the Windows SDK.
 *
 * Usage:
 *   node build/msix.js                       # Build an unsigned package from dist/release/win-unpacked
 *   node build/msix.js --stage <dir>         # Use a specific unpacked directory
 *   node build/msix.js --sign                # Also generate a self-signed cert and sign (for local testing)
 *   node build/msix.js --identity Name --publisher "CN=..." --display name
 *
 * Environment variables also work: HYDRA_MSIX_IDENTITY / HYDRA_MSIX_PUBLISHER / HYDRA_MSIX_DISPLAY
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { encodePng, drawAppIcon } = require('../src/core/png');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));

// ---------------- Arguments ----------------

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const VERSION = String(pkg.version || '0.0.0');
// MSIX Version must have four segments, and the fourth must be 0 (Store requirement)
function msixVersion(v) {
  const p = String(v).split(/[.\-+]/).filter((x) => /^\d+$/.test(x)).slice(0, 3);
  while (p.length < 3) p.push('0');
  return `${p[0]}.${p[1]}.${p[2]}.0`;
}

// Pass the product identity and publisher from Partner Center for Store submissions.
const CONFIRMED_IDENTITY = 'Hydra.Emulator';
const CONFIRMED_PUBLISHER = 'CN=HydraEmulator';
const IDENTITY = arg('identity') || process.env.HYDRA_MSIX_IDENTITY || CONFIRMED_IDENTITY;
const PUBLISHER = arg('publisher') || process.env.HYDRA_MSIX_PUBLISHER || CONFIRMED_PUBLISHER;
const PUBLISHER_DISPLAY = arg('publisherDisplay') || process.env.HYDRA_MSIX_PUBLISHER_DISPLAY || 'Hydra Emulator';
const DISPLAY = arg('display') || process.env.HYDRA_MSIX_DISPLAY || 'Hydra Emulator';
const APP_ID = arg('appId') || 'HydraEmulator';
const DO_SIGN = !!arg('sign', false);

const STAGE = path.resolve(String(arg('stage')
  || path.join(ROOT, 'dist', 'release', 'win-unpacked')));
const OUT_DIR = path.resolve(String(arg('out') || path.join(ROOT, 'dist', 'store')));

/**
 * Choose the "payload directory": the Hydra Emulator.exe + resources that go
 * under `app\` in the MSIX.
 *
 * Two sources, preferring the offline one:
 *   A. dist/Hydra Emulator-win64-portable — output of `node build/pack.js`, **needs no network**.
 *      It is only the shell without a runtime, so we copy build/runtime into
 *      resources/runtime here (what electron-builder's extraResources does).
 *   B. dist/release/win-unpacked — output of `electron-builder --win dir`, which includes
 *      resources/runtime. But that step pulls the toolset from a CDN, and without a network
 *      it extracts only halfway (only electron.exe, runtime not copied), so it is a fallback only.
 *
 * Use --payload to specify one explicitly.
 */
function resolvePayload() {
  const explicit = arg('payload');
  if (explicit) return { dir: path.resolve(String(explicit)), addRuntime: false };
  const portable = path.join(ROOT, 'dist', 'Hydra Emulator-win64-portable');
  const runtime = path.join(ROOT, 'build', 'runtime');
  if (fs.existsSync(path.join(portable, 'Hydra Emulator.exe'))) {
    const hasRuntime = fs.existsSync(path.join(portable, 'resources', 'runtime', 'emulator', 'emulator.exe'));
    return { dir: portable, addRuntime: !hasRuntime && fs.existsSync(runtime), runtime };
  }
  return { dir: STAGE, addRuntime: false };
}

// ---------------- Asset icons ----------------
// The manifest only references the five 100% scale images. Once .scale-* / .targetsize-*
// files appear in the directory, resources.pri (makepri) must also be generated, which
// adds a lot of complexity — the first version does not touch that.
const ASSETS = [
  { file: 'StoreLogo.png', w: 50, h: 50 },
  { file: 'Square44x44Logo.png', w: 44, h: 44 },
  { file: 'Square71x71Logo.png', w: 71, h: 71 },
  { file: 'Square150x150Logo.png', w: 150, h: 150 },
  { file: 'Square310x310Logo.png', w: 310, h: 310 },
  { file: 'Wide310x150Logo.png', w: 310, h: 150 },
  { file: 'SplashScreen.png', w: 620, h: 300 },
];

const BG = [20, 22, 27];        // #14161b dark background
const ACCENT = [61, 220, 132];  // #3ddc84 Android green

/** Rounded-rectangle hit test (to draw the brand icon on non-square canvases) */
function inRoundRect(px, py, x, y, w, h, r) {
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

/** Draw the brand icon (rounded dark block + green play triangle) at side length `side` centered on a w×h canvas */
function composeIcon(w, h, side) {
  const rgba = new Uint8Array(w * h * 4);
  const ox = (w - side) / 2;
  const oy = (h - side) / 2;
  const pad = side * 0.06;
  const box = { x: ox + pad, y: oy + pad, w: side - pad * 2, h: side - pad * 2, r: side * 0.24 };
  const tW = side * 0.30;
  const tH = side * 0.34;
  const tcx = ox + side * 0.5 + side * 0.02;
  const tcy = oy + side * 0.5;
  const ax = tcx - tW * 0.38;
  const ay = tcy - tH / 2;
  const bx = tcx - tW * 0.38;
  const by = tcy + tH / 2;
  const cx2 = tcx + tW * 0.62;
  const cy2 = tcy;
  const inTri = (px, py) => {
    const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
    const d2 = (px - cx2) * (by - cy2) - (bx - cx2) * (py - cy2);
    const d3 = (px - ax) * (cy2 - ay) - (cx2 - ax) * (py - ay);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // Base plate: solid dark fill (both tiles and splash screens use a full-bleed background)
      let r = BG[0];
      let g = BG[1];
      let b = BG[2];
      let a = 255;
      const px = x + 0.5;
      const py = y + 0.5;
      if (inRoundRect(px, py, box.x, box.y, box.w, box.h, box.r)) {
        const t = (x / w) * 0.6 + (y / h) * 0.4;
        r = Math.round(20 + t * 14);
        g = Math.round(26 + t * 18);
        b = Math.round(33 + t * 24);
        if (inTri(px, py)) { r = ACCENT[0]; g = ACCENT[1]; b = ACCENT[2]; }
      }
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a;
    }
  }
  return encodePng(w, h, rgba);
}

/** Pre-rendered assets: the main logo and simplified small-size logos produced by build/build-icons.js */
const STORE_ASSETS = path.join(ROOT, 'build', 'store-assets');

function writeAssets(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const made = [];
  for (const a of ASSETS) {
    const pre = path.join(STORE_ASSETS, a.file);
    let buf = null;
    if (fs.existsSync(pre)) {
      buf = fs.readFileSync(pre);
    } else {
      // Fallback: still produces a package when build-icons has not run, but icons may not be consistent across sizes
      buf = (a.w === a.h)
        ? drawAppIcon(a.w)
        : composeIcon(a.w, a.h, Math.min(a.h * 0.72, a.w * 0.42));
      console.warn(`  [fallback] ${a.file} not found in build/store-assets, drawing programmatically instead`);
    }
    fs.writeFileSync(path.join(dir, a.file), buf);
    made.push(`${a.file} ${a.w}x${a.h}`);
  }
  return made;
}

// ---------------- Manifest ----------------

function manifest() {
  return `<?xml version="1.0" encoding="utf-8"?>
<!--
  Hydra Emulator · Microsoft Store (MSIX) manifest
  Generated by build/msix.js; do not edit by hand. To change the template, edit build/msix.js.

  Two fields that must match Partner Center verbatim:
    Identity/@Name          ← Product identity → Package/Identity/Name
    Identity/@Publisher     ← Product identity → Package/Identity/Publisher
  For local self-signed testing, Publisher must equal the self-signed certificate's Subject.
-->
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap rescap">

  <Identity
    Name="${IDENTITY}"
    Publisher="${PUBLISHER}"
    Version="${msixVersion(VERSION)}"
    ProcessorArchitecture="x64" />

  <Properties>
    <DisplayName>${DISPLAY}</DisplayName>
    <PublisherDisplayName>${PUBLISHER_DISPLAY}</PublisherDisplayName>
    <Description>${pkg.description || DISPLAY}</Description>
    <Logo>Assets\\StoreLogo.png</Logo>
  </Properties>

  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.22621.0" />
  </Dependencies>

  <Resources>
    <Resource Language="en-US" />
  </Resources>

  <Capabilities>
    <!-- The only capability required by a full-trust desktop app (Desktop Bridge). -->
    <rescap:Capability Name="runFullTrust" />
    <!--
      We deliberately do not declare unvirtualizedResources / broadFileSystemAccess:
      the former is only granted to PC games published by Microsoft and its partners, and
      the Store rarely approves it; the latter exists for AppContainer apps to break out of
      the sandbox, while full-trust apps already run as the user.
      To avoid AppData write redirection, we place the data directory under %USERPROFILE%\\Hydra Emulator,
      which stays entirely outside virtualization (see STORE_BUILD in src/core/store.js).
    -->
  </Capabilities>

  <Applications>
    <Application Id="${APP_ID}" Executable="app\\Hydra Emulator.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements
        DisplayName="${DISPLAY}"
        Description="${pkg.description || DISPLAY}"
        BackgroundColor="#14161B"
        Square150x150Logo="Assets\\Square150x150Logo.png"
        Square44x44Logo="Assets\\Square44x44Logo.png">
        <!--
          Low on a little or big tape can only be placed on uap:DefaultTile, not on
          uap: In the properties of VisualElements -- MakeAppx will simply reject the entire package when it is misplaced:
          "?? DTD/??????? 'VisualElements' ??? 'Square71x71Logo'?"
          (0x80080204 The package manifest is not valid)
        -->
        <uap:DefaultTile Wide310x150Logo="Assets\\Wide310x150Logo.png"
          Square71x71Logo="Assets\\Square71x71Logo.png"
          Square310x310Logo="Assets\\Square310x310Logo.png" />
        <uap:SplashScreen Image="Assets\\SplashScreen.png" BackgroundColor="#14161B" />
      </uap:VisualElements>
    </Application>
  </Applications>
</Package>
`;
}

// ---------- looking for makeappx/signtool---

function which(exe) {
  const cands = [];
  const push = (p) => { if (p) cands.push(p); };
  // 1) PATH
  const envPath = process.env.PATH || '';
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, exe);
    try { if (fs.statSync(p).isFile()) push(p); } catch (_) { /* next */ }
  }
  // 2) Windows SDK(10.0.x any version, priority x 64)
  const kits = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin'),
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Windows Kits', '10', 'bin'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'App Certification Kit'),
  ];
  for (const k of kits) {
    let versions = [];
    try { versions = fs.readdirSync(k); } catch (_) { continue; }
    for (const v of versions) {
      for (const arch of ['x64', 'x86', '']) {
        const p = arch ? path.join(k, v, arch, exe) : path.join(k, v, exe);
        try { if (fs.statSync(p).isFile()) push(p); } catch (_) { /* next */ }
      }
    }
  }
  // 3) eclecron-Builder download tool cache (run through --win appx))
  const cacheRoot = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'electron-builder', 'Cache');
  const stack = [cacheRoot];
  let guard = 0;
  while (stack.length && guard < 6000) {
    const dir = stack.pop();
    guard += 1;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.toLowerCase() === exe.toLowerCase()) push(p);
    }
  }
  if (!cands.length) return null;

  /**
   * Pick the latest tool.
   *
   * This step is crucial: the set of tools that we’ve released has a combination of Windows-6 / Windows-8. /
   * Three-generation signaturetool.exe.windows-6. MSIX will report directly.
   * `0x80080209 (SignerSign failed)` —— It doesn’t know the SIP structure of MSIX.
   * So you have to show a preference for Windows-10.\x64, Instead of “find which one to find first and which one to use.“
   */
  const score = (p) => {
    const l = p.toLowerCase();
    let s = 0;
    if (/\\windows-10\\x64\\/.test(l)) s += 100;
    else if (/\\windows-10\\/.test(l)) s += 60;
    if (/\\windows-1[01]\\x64\\/.test(l)) s += 40;
    if (/\\x64\\/.test(l)) s += 10;
    if (/\\windows-6\\|\\windows-8\\|\\darwin\\|\\linux\\/.test(l)) s -= 200;
    return s;
  };
  cands.sort((a, b) => (score(b) - score(a)) || b.localeCompare(a, 'en'));
  return cands[0];
}

function run(exe, args, opts = {}) {
  return execFileSync(exe, args, { stdio: 'inherit', windowsHide: true, ...opts });
}

// Self-employed guards: No third-party simulators like MuMu (only dependent on self-carried operations) in MSIX)
const { assertStandalone } = require('./guard-standalone');

// - - - - Main process - - -

function stagePackage() {
  const pick = resolvePayload();
  const appSrc = pick.dir;
  if (!fs.existsSync(path.join(appSrc, 'Hydra Emulator.exe'))) {
    console.error(`\n Not found ${path.join(appSrc, 'Hydra Emulator.exe')}.`);
    console.error('Two ways.: ');
    console.error('  A) none build/pack.js (offline, recommended; this script will automatically plug the build/runtime)');
    console.error('  B) npx electron-builder --win dir --x64 --config electron-builder.yml');
    console.error('     —— This step will go to the CDN Pull Tool set, and half of it will be cut off when there\'s no web, and finally Win-unpacked is disabled.\n');
    process.exit(1);
  }
  const work = path.join(OUT_DIR, '.stage');
  fs.rmSync(work, { recursive: true, force: true });
  const appDir = path.join(work, 'app');
  fs.mkdirSync(appDir, { recursive: true });
  console.log(`Copy application payload (source) ${appSrc})…`);
  fs.cpSync(appSrc, appDir, { recursive: true });
  // These are the intermediates of Elementon/electron-Builder. They’re not supposed to be in the package.
  for (const junk of ['builder-debug.yml', 'builder-effective-config.yaml', '.icon-ico', 'VERSION.txt']) {
    fs.rmSync(path.join(appDir, junk), { force: true, recursive: true });
  }
  // When the portable version is not running: copy the build/ runime (exptraResources at the eclectron-Builder equivalent))
  if (pick.addRuntime) {
    console.log(`Built when running ${pick.runtime} → App/resources/runtime (approximately 1 GB, in a few minutes))…`);
    fs.cpSync(pick.runtime, path.join(appDir, 'resources', 'runtime'), { recursive: true });
  }
  const rtExe = path.join(appDir, 'resources', 'runtime', 'emulator', 'emulator.exe');
  if (!fs.existsSync(rtExe)) {
    console.error(`\n Warning: ${rtExe} There is no -- this package will still be downloaded online while running.`);
    console.error('Node build/prepare-runtime.js generates build/runtime.\n');
  } else {
    console.log('built-in (emulator / platform-tools / system-images))');
  }
  // Once the load is finished, the store bag must run itself, independently, without any third-party simulators.
  assertStandalone(appDir, { label: 'MSIX payload app/' });
  console.log('Generate store icons…');
  const made = writeAssets(path.join(work, 'Assets'));
  for (const m of made) console.log(`  ${m}`);
  fs.writeFileSync(path.join(work, 'AppxManifest.xml'), manifest(), 'utf8');
  console.log(`List: Identity=${IDENTITY} Publisher=${PUBLISHER} Version=${msixVersion(VERSION)}`);
  return work;
}

function main() {
  console.log(`Hydra Emulator MSIX Packup Version ${VERSION} → ${msixVersion(VERSION)}`);
  if (PUBLISHER === CONFIRMED_PUBLISHER && !process.argv.includes('--allow-placeholder')) {
    console.error('Set HYDRA_MSIX_PUBLISHER to the Store publisher identity or use --allow-placeholder for local packaging.');
    process.exit(3);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const work = stagePackage();

  const makeappx = which('makeappx.exe');
  if (!makeappx) {
    console.error('\n Makeappx.exe. Two options not found: ');
    console.error('  Windows SDK (Windows SDK only)): ');
    console.error('     https://developer.microsoft.com/windows/downloads/windows-sdk/');
    console.error('  B. Run first npx electron-Builder-win appx, so that it can drop windows-kits-bundle into the cache, ');
    console.error('     This script will automatically be found in the eclecron-Builder cache.');
    console.error(`\n The stage directory is ready, manually packed.: \n  "${'<makeappx.exe>'}" pack /d "${work}" /p "${path.join(OUT_DIR, artifactName())}" /o\n`);
    process.exit(2);
  }
  const out = path.join(OUT_DIR, artifactName());
  console.log(`\n Use ${makeappx} Pack.…`);
  // Makeappx /o overwrite; no more fs.rmSync old bag.
  // The large package of 1.5 GB is easy for ETIMEDOUT to walk through a wastebin in a regulated environment.,
  // It’s covered by the product, but it breaks the whole building.
  run(makeappx, ['pack', '/d', work, '/p', out, '/o', '/v']);

  const mb = fs.statSync(out).size / 1048576;
  console.log(`\n Completed: ${out}  (${mb.toFixed(0)} MB)`);

  // Self-check with ZipFile with .NET: The package must contain a list + block map + content type
  try {
    const { execFileSync: ex } = require('child_process');
    const ps = [
      '-NoProfile', '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem;`
      + `$z=[IO.Compression.ZipFile]::OpenRead('${out.replace(/'/g, "''")}');`
      + `$n=$z.Entries | ForEach-Object { $_.FullName }; $z.Dispose();`
      + `foreach($k in @('AppxManifest.xml','AppxBlockMap.xml','[Content_Types].xml')){`
      + ` if($n -contains $k){ "OK   $k" } else { "MISS $k" } }`
      + `"entries: " + $n.Count`,
    ];
    ex('powershell.exe', ps, { stdio: 'inherit', windowsHide: true });
  } catch (_) { /* Self-censorship failure does not affect the product. */ }

  if (DO_SIGN) sign(out);
  else {
    console.log('\n Unsigned (Store will remark with its own certificate and do not need to sign at the time of submission).');
    console.log('Locally wanted to load with -- sign generated from visa and signed.');
  }
  // Stage is an intermediate product of 1.3 GB, and keeping it is useless and makes it look like "two in the bag.",
  // When you pack it, you clear it.
  if (!process.argv.includes('--keep-stage')) {
    try {
      fs.rmSync(work, { recursive: true, force: true });
      console.log('Cleared intermediate directory dist/store/.stage');
    } catch (_) { /* Keep it, it doesn’t affect the product. */ }
  }
  console.log(`\n Read it before submission`);
}

function artifactName() {
  return `Hydra Emulator_${msixVersion(VERSION)}_x64.msix`;
}

function sign(file) {
  const signtool = which('signtool.exe');
  if (!signtool) {
    console.error('\n No signtool.exe, skip signature.');
    return;
  }
  const pfx = path.join(OUT_DIR, 'Hydra Emulator-test.pfx');
  const pwd = process.env.HYDRA_MSIX_PFX_PASSWORD || 'Hydra Emulator!test';
  const subject = PUBLISHER;   // It has to be word-for-word with the Publisher on the list.
  if (!fs.existsSync(pfx)) {
    console.log(`\n Generate from visa (Subject=${subject})…`);
    const ps = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `$c = New-SelfSignedCertificate -Type Custom -KeyUsage DigitalSignature`
      + ` -CertStoreLocation 'Cert:\\CurrentUser\\My'`
      + ` -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3','2.5.29.19={text}')`
      + ` -Subject '${subject}' -FriendlyName 'Hydra Emulator MSIX Test';`
      + `$p = ConvertTo-SecureString -String '${pwd}' -Force -AsPlainText;`
      + `Export-PfxCertificate -Cert ("Cert:\\CurrentUser\\My\\" + $c.Thumbprint) -FilePath '${pfx}' -Password $p | Out-Null;`
      + `"thumbprint=" + $c.Thumbprint`,
    ];
    try { run('powershell.exe', ps); } catch (e) { console.error(`Could not close temporary folder: %s: ${e.message}`); return; }
  }
  console.log('Signature…');
  try {
    run(signtool, ['sign', '/a', '/v', '/fd', 'SHA256', '/f', pfx, '/p', pwd, file]);
  } catch (e) {
    console.error(`Signing failed: ${e.message}`);
    console.error('\n Note: the binCodeSign set of electron-Builder caches has been cut, ');
    console.error('Signtool.exe sign MSIX is not present');
    console.error('(Unable to register with MSIX’s SIP provider. If you really want to try it locally, use the signtool in the full Windows SDK: ');
    console.error('  "C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.26100.0\\x64\\signtool.exe" \\');
    console.error(`    sign /fd SHA256 /a /f "${pfx}" /p "${pwd}" "${file}"`);
    console.error('\n**Local signature is not required on the mount.**: Microsoft Store will resign your upload with his own certificate.');
    return;
  }
  console.log('\n Trust Certificate (Operator PowerShell executable once before Add-AppxPackage): ');
  console.log(`  Import-PfxCertificate -CertStoreLocation 'Cert:\\LocalMachine\\TrustedPeople' -FilePath '${pfx}' -Password (ConvertTo-SecureString '${pwd}' -Force -AsPlainText)`);
  console.log(`  Add-AppxPackage -Path '${file}'`);
}

if (require.main === module) main();

module.exports = { msixVersion, manifest, composeIcon, which, ASSETS };
