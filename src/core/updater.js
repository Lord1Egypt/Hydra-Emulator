'use strict';
/**
 * Online update: take the latest version from GitHub Releases (Lord1Egypt/Hydra-Emulator), download and replace it in situ.
 *
 * All three of them.:
 *   - Installed version (NSIS): Download `Hydra Emulator-x.y.z-Setup.exe`, Silent installation (/S);
 *   - Light edition (portable Zip, download as required): `Hydra Emulator-vX-win64-portable.zip`,
 *     Overwrite application directory after decompression - Runtime Directory (%APPDATA%)\hydra\runtime)& With Installed Applications,
 *     The snapshots are all in the user directory, and the replacement program files do not touch them.
 *   - Full edition (carry but runtime): same light edition, just a lot more in the directory\runtime.
 *
 * Replace cannot be done in this process (exe is being occupied), so generate a PowerShell script,
 * Use EncodedCommand to give to the independent process: wait for this process to exit → copy files reboot.
 * Send scripts instead of writing .ps1 files using base64 to bypass "BGBK decoded scripts when the path contains Chinese"
 * This kind of old question (Powershell 5.1 read without BOM script explaining by ANSI).
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { downloadAny, downloadAnyParallel, downloadMulti, sha256File } = require('./download');
const { ZipFile, resolveZipEntry } = require('./zip');
const { cmpVer } = require('./version');
const { Sources } = require('./sources');
const inc = require('./incremental');

const OWNER = 'Lord1Egypt';
const REPO = 'Hydra-Emulator';

/** PowerShell Single Quote String: Internal 'to write ' */
function psq(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** Find files by name (insensitive case) in the first layer of the directory, return the actual name or null */
function findInDir(dir, name) {
  try {
    const lower = name.toLowerCase();
    return fs.readdirSync(dir).find((n) => n.toLowerCase() === lower) || null;
  } catch (_) {
    return null;
  }
}

/**
 * Find NSIS unloader in the program directory, no returns found.
 * The default name for electron-Builder is `Uninstall <productName>.exe`(I’m sorry, oldter.),
 * The old version/self-defined packing may also be called `uninstaller.exe`(It’s the only thing the old code recognizes.
 * The same rules must be used in both places, otherwise the installation of the "one-key uninloading" will be misconstrued as a portable version.
 */
function findUninstaller(installDir) {
  try {
    const names = fs.readdirSync(installDir);
    return names.find((n) => /^Uninstall .*\.exe$/i.test(n))
      || names.find((n) => /^uninstall(er)?\.exe$/i.test(n))
      || null;
  } catch (_) {
    return null;
  }
}

class Updater {
  /**
   * @param {{currentVersion:string, exePath:string, isPackaged:boolean, dataDir:string,
   *          electronVersion?:string, onProgress?:Function}} o
   */
  constructor(o) {
    this.current = o.currentVersion || '0.0.0';
    this.exePath = o.exePath;
    this.installDir = path.dirname(o.exePath || '');
    this.isPackaged = !!o.isPackaged;
    this.dataDir = o.dataDir;
    this.onProgress = o.onProgress || (() => {});
    // Premise for incremental updating: this is the same version as the sender.
    // Elementron runs from the caller (main.js) to process.versions.electron; the test can be injected.
    this.electronVersion = o.electronVersion || '';
    this.settings = typeof o.settings === 'function' ? o.settings : () => (o.settings || {});
    // Settings() for sources: “Was there a mirror prefix?“
    this.sources = new Sources(this.settings);
    this.latest = null;
    this._last = null;
  }

  /** Installed form: Installed version (with unmounter) or portable package */
  get flavor() {
    return findUninstaller(this.installDir) ? 'setup' : 'portable';
  }

  get updateDir() {
    return path.join(this.dataDir, 'update');
  }

  /**
   * Check for updates: GitHub / release mirrors asks, take the higher version number, take the asset in combination.
   * The download address is sorted again in prepare().
   */
  /**
   * @param{force?:boolean} [opts] force=true skips a 10-minute version cache
   *        (The user active "check for updates" should be provided with the latest results; silent check-in-cache at startup)
   */
  async check(opts = {}) {
    const merged = await this.sources.latest({ force: !!opts.force });
    const pick = (re) => merged.assets.find((a) => re.test(String(a.name || '')));
    // The release is accompanied by "handbags" and "Runtime full packs" (Hydra Emulator-runtime-*.zip).
    // The bottom .zip match must remove the runtime whole package: if one release is only runtime the whole package,
    // Without a portable package, the old logic will press it as an updated package into the program directory (more 1.5 GB files, and the program has been changed).
    const isRuntimePack = (a) => inc.isAuxAsset((a && a.name) || '');

    const wantSetup = this.flavor === 'setup';
    const asset = wantSetup
      ? (pick(/Setup\.exe$/i) || merged.assets.find((a) => /\.exe$/i.test(a.name) && !isRuntimePack(a)))
      : (pick(/portable.*\.zip$/i) || pick(/win64.*\.zip$/i)
        || merged.assets.find((a) => /\.zip$/i.test(a.name) && !isRuntimePack(a)));

    // Incremental assets: List + package. Both are available and may only increase if the Element version is right;
    // The whole bag is always in the asset -- any step of the way that goes up, it’s back to the whole package.
    const manifestAsset = pick(inc.MANIFEST_RE);
    const appAsset = pick(inc.APP_PACK_RE);

    this.latest = {
      version: merged.version,
      tag: merged.tag,
      name: merged.name,
      notes: merged.notes,
      htmlUrl: merged.htmlUrl,
      publishedAt: merged.publishedAt,
      // Take the parts: release mirrors’s sub-packs without a single url, drop the parts and turn them into "with assets but no address."
      asset: asset
        ? {
          name: asset.name,
          size: asset.size,
          url: asset.url,
          // The same name of assets in GitHub/release mirrors: both addresses, prepare() fast-tracking.
          // sizes is "the size of each address" -- the bytes from which the two sources are pressurized are different.
          urls: asset.urls,
          sizes: asset.sizes,
          source: asset.source,
          parts: asset.parts,
          partial: asset.partial,
        }
        : null,
      assets: merged.assets,
      // The latest version of each source / who can't reach it, the interface shows which source this time.
      sources: merged.sources,
      unreachable: merged.unreachable,
      flavor: this.flavor,
      hasUpdate: cmpVer(merged.tag, this.current) > 0,
      current: this.current,
      canAutoApply: !!asset && (!!asset.url || !!(asset.parts && asset.parts.length)),
      // Possibilities for scaling up: prepare() downloads the list and then makes a final determination (version/Hashi))
      incremental: this.flavor === 'portable' && !!manifestAsset && !!appAsset
        ? { manifest: manifestAsset, app: appAsset }
        : null,
    };
    this._last = this.latest;
    return this.latest;
  }

  /**
   * Download and prepare load: Portable unpressure to update/<ver>/Payload, setup.exe.
   * @returns {Promise<{mode:'zip'|'setup', payload:string, version:string}>}
   */
  async prepare(info) {
    const it = info || this.latest;
    if (!it || !it.asset) throw new Error('This version does not have an auto-installed installation package, please download manually to the GitHub release page');
    const dir = path.join(this.updateDir, it.version);
    fs.mkdirSync(dir, { recursive: true });

    // Try incrementally as a matter of priority: only list + package (number of MBs), this Elementron version is consistent, file by file
    // Hashi is good at it. Any one step is no more than an increment, and the whole package below is back seamlessly downloaded.
    // Last incremental replacement failed. → Take the whole package straight this time, and don’t reset the bad load.)
    const forcedFull = fs.existsSync(path.join(dir, '.hydra-force-full'));
    if (it.incremental && it.hasUpdate !== false && !forcedFull) {
      try {
        const job = await this._prepareApp(it, dir);
        if (job) return job;
      } catch (e) {
        this.onProgress({
          stage: 'download', percent: 1,
          message: `Increment update not available(${e.message}), Change to full package…`,
        });
      }
    }
    return this._prepareFull(it, dir);
  }

  /** Full package path: Download portable zip / Setup.exe and release (original logic)) */
  async _prepareFull(it, dir) {
    const file = path.join(dir, it.asset.name);
    let total = it.asset.size || 0;
    const conns = Math.max(1, Math.min(16, Number((this.settings().runtime || {}).downloadConnections) || 8));

    // release mirrors attachment file cap 100MB, so the package will be .part1/.part2.
    // Individual velocity selection source for each fragment (which can be partly from release mirrors and partly from GitHub mirrors)),
    // Putting the whole package back in sequence after the end -- it’s still just "download + unpressure" for the user.
    if (it.asset.parts && it.asset.parts.length) {
      await this._downloadParts(it.asset, file, conns, total);
    } else {
      this.onProgress({ stage: 'download', percent: 1, message: `Downloading ${it.asset.name}…` });
      // Candidate address = source + mirror prefix; 256KB live velocity first, and the fastest fraction to download.
      // It’s the only way to go when “GitHub runs into dozens of KB/s, mirrors can run a few MB/s.“:
      // It doesn’t work by domain name, and it’s very different on the same day.
      const cands = this.sources.candidates(it.asset);
      const ranked = await this.sources.rank(cands, { onProgress: (p) => this.onProgress(p) }).catch(() => cands);
      // The total size of the progress to take "The real source": GitHub and release mirrors are not the same bytes
      // (The compressor is different, it’s a few MBs, and the wrong one is always showing 92% and then suddenly jumps to the end.
      const sizes = it.asset.sizes || {};
      for (const u of ranked) {
        if (sizes[u]) { total = sizes[u]; break; }
      }
      // DownloadMulti: Fragmentation from "GitHub straight" and "Side" with bandwidth added;
      // When only one source is available or the other does not support Range, it returns its own single source block.
      await downloadMulti(ranked, file, {
        connections: conns,
        onProgress: (pr) => {
          const pct = pr.percent != null ? pr.percent : (total ? Math.round((pr.got / total) * 100) : 0);
          const mb = `${(pr.got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`;
          const sp = Number(pr.speed) > 0 ? ` · ${(pr.speed / 1048576).toFixed(2)} MB/s` : '';
          this.onProgress({
            stage: 'download',
            percent: Math.max(1, Math.min(99, pct)),
            message: `Downloading ${mb}${sp}`,
            speed: pr.speed,
          });
        },
      });
    }

    if (/\.zip$/i.test(file)) {
      const out = path.join(dir, 'payload');
      // #98: Last time downloaded + depressure completed, but replacement/restart failed,
      // Re-use this load directly, never again 100MB -- this is the source of the "update death cycle."
      // Readiness markers are written by this function, which replaces the script and clears them, so only fully uncompressed loads are reused.
      if (this._payloadReady(out, it.version)) {
        this.onProgress({ stage: 'ready', percent: 100, message: 'Downloaded updated package already available, directly reused' });
        return { mode: 'zip', payload: out, version: it.version };
      }
      fs.rmSync(out, { recursive: true, force: true });
      fs.mkdirSync(out, { recursive: true });
      await this._extract(file, out);
      this._markPayloadReady(out, it.version);
      this.onProgress({ stage: 'ready', percent: 100, message: 'Update package released.' });
      return { mode: 'zip', payload: out, version: it.version };
    }
    this.onProgress({ stage: 'ready', percent: 100, message: 'Install package downloaded' });
    return { mode: 'setup', payload: file, version: it.version };
  }

  /**
   * Increment update: Download list + code package, depressurize to an app load after verification.
   * returns the null to "do not increase this time" (the caller has changed to take the whole package); drops the anomaly at the same price, with prepare behind it.
   * @returns {Promise<{mode:'app', payload:string, version:string}|null>}
   */
  async _prepareApp(it, dir) {
    if (!it.incremental || !it.incremental.manifest || !it.incremental.app) return null;
    const conns = Math.max(1, Math.min(16, Number((this.settings().runtime || {}).downloadConnections) || 8));

    // 1) The list and the code package are small and are downloaded using a two-source candidate + velocity sorting (GitHub / release mirrors / mirror).
    const fetchAsset = async (asset, name, label) => {
      const target = path.join(dir, name);
      const ranked = await this.sources.rank(this.sources.candidates(asset), {}).catch(() => this.sources.candidates(asset));
      this.onProgress({ stage: 'download', percent: 1, message: `Fetching ${label}…` });
      await downloadAny(ranked, target, {});
      return target;
    };

    const manifestFile = await fetchAsset(it.incremental.manifest, `manifest-${it.version}.json`, 'Update List');
    const manifest = inc.parseManifest(fs.readFileSync(manifestFile, 'utf8'));
    if (String(manifest.version).replace(/^v/i, '') !== String(it.version).replace(/^v/i, '')) {
      throw new Error('List version is not consistent with release');
    }
    // The list says, “app, the asset must be the one in this release.“)
    const appAsset = it.assets && it.assets.find((a) => a && a.name === manifest.app.asset);
    const choice = inc.chooseMode({
      flavor: this.flavor,
      electronVersion: this.electronVersion,
      manifest,
      assets: appAsset ? [appAsset] : [],
      current: this.current,
    });
    if (choice.mode !== 'app') return null;

    const appFile = await fetchAsset(choice.appAsset, manifest.app.asset, 'Increment Code Package');
    const gotHash = await sha256File(appFile);
    if (String(gotHash).toLowerCase() !== String(manifest.app.sha256).toLowerCase()) {
      throw new Error('Increment package verification failed (sha256 not matching))');
    }

    const payload = path.join(dir, 'app-payload');
    // Last download was successful but replacement failed: Direct reuse (with full package. hydra-ready)
    if (this._payloadReady(payload, it.version)) {
      this.onProgress({ stage: 'ready', percent: 100, message: 'A downloaded incremental package has been downloaded and is directly reused' });
      return { mode: 'app', payload, version: it.version, manifest };
    }
    fs.rmSync(payload, { recursive: true, force: true });
    fs.mkdirSync(payload, { recursive: true });
    await this._extract(appFile, payload);
    // Document-by-document verification: Download cut / Mirror given to wrong files can be stopped here
    const bad = await inc.verifyExtracted({ payload, files: manifest.app.files });
    if (bad.length) throw new Error(`Increment package. ${bad.length} Could not close temporary folder: %s`);

    this._markPayloadReady(payload, it.version, 'app');
    this.onProgress({ stage: 'ready', percent: 100, message: 'Increment package verified' });
    return { mode: 'app', payload, version: it.version, manifest };
  }

  /**
   * Download and assemble subpacks.
   * @param {{name:string, size:number, parts:Array<{index:number,size:number,urls:string[]}>}} asset
   */
  async _downloadParts(asset, target, conns, total) {
    const dir = path.dirname(target);
    let doneBytes = 0;
    const fd = fs.openSync(target, 'w');
    try {
      for (const part of asset.parts) {
        const tmp = path.join(dir, `${asset.name}.${part.index}.tmp`);
        const cands = [];
        for (const u of part.urls) {
          for (const c of this.sources.candidates(u)) if (!cands.includes(c)) cands.push(c);
        }
        // eslint-disable-next-line no-await-in-loop
        const ranked = await this.sources.rank(cands, {
          onProgress: (p) => this.onProgress({ ...p, percent: Math.max(1, Math.min(99, Math.round((doneBytes / (total || 1)) * 100))) }),
        }).catch(() => cands);
        // eslint-disable-next-line no-await-in-loop
        await downloadAnyParallel(ranked, tmp, {
          connections: conns,
          onProgress: (pr) => {
            const got = doneBytes + (pr.got || 0);
            const pct = total ? Math.round((got / total) * 100) : 0;
            const sp = Number(pr.speed) > 0 ? ` · ${(pr.speed / 1048576).toFixed(2)} MB/s` : '';
            this.onProgress({
              stage: 'download',
              percent: Math.max(1, Math.min(99, pct)),
              message: `Downloading ${(got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`
                + `(Rule ${part.index}/${asset.parts.length} Snips)${sp}`,
              speed: pr.speed,
            });
          },
        });
        const buf = fs.readFileSync(tmp);
        if (part.size && buf.length !== part.size) {
          throw new Error(`Splits ${part.index} The size is not right.(${buf.length} ≠ ${part.size}), Aborted, retryable`);
        }
        fs.writeSync(fd, buf, 0, buf.length, doneBytes);
        doneBytes += buf.length;
        fs.rmSync(tmp, { force: true });
      }
    } finally {
      fs.closeSync(fd);
    }
    if (total && doneBytes !== total) {
      throw new Error(`Update package sizes are wrong(${doneBytes} ≠ ${total}), Aborted, retryable`);
    }
  }

  async _extract(zipPath, dest) {
    const zf = new ZipFile(zipPath);
    try {
      const names = zf.names().filter((n) => !n.endsWith('/'));
      let i = 0;
      for (const n of names) {
        i += 1;
        // zip-slip: Unite the guard of zip.js (block ./, absolute path, disc, backslash))
        const target = resolveZipEntry(dest, n);
        if (!target) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        await zf.pipeTo(n, fs.createWriteStream(target));
        if (i % 20 === 0) {
          this.onProgress({
            stage: 'extract',
            percent: Math.min(99, Math.round((i / names.length) * 100)),
            message: `Depressing. ${i}/${names.length}`,
          });
        }
      }
    } finally {
      try { zf.close(); } catch (_) { /* ignore */ }
    }
  }

  /** Load ready tag file: Write after the complete fall drive is unpressured for cross-process rejuvenation */
  _readyFile(payload) { return path.join(payload, '.hydra-ready'); }

  _markPayloadReady(payload, version, mode = 'zip') {
    try {
      fs.writeFileSync(this._readyFile(payload), JSON.stringify({ version, at: Date.now(), mode }), 'utf8');
    } catch (_) { /* If you can’t write the marker, you’ll reset it next time. */ }
  }

  _payloadReady(payload, version) {
    try {
      if (!fs.existsSync(this._readyFile(payload))) return false;
      const m = JSON.parse(fs.readFileSync(this._readyFile(payload), 'utf8'));
      // Versions do not match = Last was another version, cannot be reused
      if (m.version !== version) return false;
      if (m.mode === 'app') {
        // The incremental load does not add; its "main file" is resources/app/package.json
        return fs.existsSync(path.join(payload, 'resources', 'app', 'package.json'));
      }
      // Full load: The program owner exe must have... no indication that the decompression interruption/killed soft delete.
      const exeName = path.basename(this.exePath || 'Hydra Emulator.exe');
      return !!findInDir(payload, exeName);
    } catch (_) {
      return false;
    }
  }

  /**
   * Call on startup: Retrieve and continue with "Last Download Unpressure but Replace/Restart Failed".
   * Go straight to the local load, and no more downloads.
   * @returns {{mode:'zip', payload:string, version:string}|null}
   */
  findResumableJob() {
    try {
      if (!fs.existsSync(this.updateDir)) return null;
      const versions = fs.readdirSync(this.updateDir)
        .filter((n) => cmpVer(n, this.current) > 0)   // Only recognize the current updated version, avoid repeated restarts
        .sort((a, b) => cmpVer(b, a));
      for (const v of versions) {
        // Full Package Load
        const payload = path.join(this.updateDir, v, 'payload');
        if (this._payloadReady(payload, v)) return { mode: 'zip', payload, version: v };
        // Increment load (the last incremental replacement failed to mark the mandatory complete package not reset)
        const appPayload = path.join(this.updateDir, v, 'app-payload');
        if (!fs.existsSync(path.join(this.updateDir, v, '.hydra-force-full'))
            && this._payloadReady(appPayload, v)) {
          return { mode: 'app', payload: appPayload, version: v };
        }
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  /**
   * Generates and starts the “Restart + Replace“ script, and then calls the user to quit the application.
   * @param {{mode:'zip'|'setup', payload:string, version:string}} job
   * @param {waitpid? number, spawn? :boolean} [opts] you can specify other Pid/ Unreal startup tests
   */
  apply(job, opts = {}) {
    const exe = this.exePath;
    const dir = this.installDir;
    const logFile = path.join(this.updateDir, 'update.log');
    fs.mkdirSync(this.updateDir, { recursive: true });
    const waitPid = opts.waitPid || process.pid;

    const lines = [
      `$ErrorActionPreference = 'SilentlyContinue'`,
      `$log = ${psq(logFile)}`,
      `function Note($m) { Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }`,
      `Note 'updater start'`,
      `$applyOk = $true`,
      // When this process really exits (up to 90 seconds), exe/ dll will remain occupied
      `try { Wait-Process -Id ${waitPid} -Timeout 90 } catch { }`,
      `Start-Sleep -Milliseconds 700`,
    ];

    if (job.mode === 'zip') {
      // The old script only looks at "target exe exists" -- it exists, so coppy.
      // Failure is also considered a success, and then the load is deleted, the old version is rebooted, and the next time the engine is turned on, it’s detected the update.
      // Change target to .old before copying, confirm new exex real down and byte
      // Same as load; failure rolls back ...old, and**Keep Load**Give it to the next start.
      const exeName = path.basename(exe);
      lines.push(
        `$src = ${psq(job.payload)}`,
        `$dst = ${psq(dir)}`,
        `$exeName = ${psq(exeName)}`,
        `$target = Join-Path $dst $exeName`,
        `$srcExe = Join-Path $src $exeName`,
        `$expected = (Get-Item $srcExe).Length`,
        `$backup = "$target.old"`,
        `$hasBackup = $false`,
        `if (Test-Path $target) {`,
        `  try { Move-Item -LiteralPath $target -Destination $backup -Force; $hasBackup = $true } catch { Note "backup failed: $_" }`,
        `}`,
        `$ok = $false`,
        `for ($i = 1; $i -le 12; $i++) {`,
        `  Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force`,
        `  if ((Test-Path $target) -and ((Get-Item $target).Length -eq $expected)) { $ok = $true; Note "copy pass $i ok"; break }`,
        `  Note "copy pass $i failed, retry"; Start-Sleep -Milliseconds 600`,
        `}`,
        `if (-not $ok) {`,
        `  Note 'copy FAILED - keeping payload for next launch'`,
        `  $applyOk = $false`,
        `  if ($hasBackup) { try { Move-Item -LiteralPath $backup -Destination $target -Force } catch {} }`,
        `} else {`,
        `  if ($hasBackup) { try { Remove-Item -LiteralPath $backup -Force } catch {} }`,
        // Only if the replication is confirmed successfully will the load and readiness mark be cleared; otherwise it will be left to findResumableJob for continuation.
        `  try { Remove-Item -LiteralPath (Join-Path $src '.hydra-ready') -Force } catch {}`,
        `  Remove-Item -Path $src -Recurse -Force`,
        `}`,
      );
    } else if (job.mode === 'app') {
      // Increment replacement: Overwrite only resources\app(Our JS/ Resource / nonee_modules.
      // The Elementron shell (exe / dll / locales) remains intact -- so updates are down from ~100MB.
      // Also rename backup + check new package.json, failed to roll back and retain load for renewal.
      const appRel = path.join('resources', 'app');
      lines.push(
        `$src = ${psq(job.payload)}`,
        `$dst = ${psq(dir)}`,
        `$appRel = ${psq(appRel)}`,
        `$appDst = Join-Path $dst $appRel`,
        `$appSrc = Join-Path $src $appRel`,
        `$pkgDst = Join-Path $appDst 'package.json'`,
        `$backup = "$appDst.old"`,
        `$hasBackup = $false`,
        `if (Test-Path $appDst) {`,
        `  try { Move-Item -LiteralPath $appDst -Destination $backup -Force; $hasBackup = $true } catch { Note "app backup failed: $_" }`,
        `}`,
        `$ok = $false`,
        `for ($i = 1; $i -le 12; $i++) {`,
        `  New-Item -ItemType Directory -Force -Path $appDst | Out-Null`,
        `  Copy-Item -Path (Join-Path $appSrc '*') -Destination $appDst -Recurse -Force`,
        `  if (Test-Path $pkgDst) {`,
        `    try {`,
        `      $pv = (Get-Content -LiteralPath $pkgDst -Raw | ConvertFrom-Json).version`,
        `      if ($pv -eq ${psq(job.version)}) { $ok = $true; Note "app copy pass $i ok"; break }`,
        `    } catch { Note "app version check: $_" }`,
        `  }`,
        `  Note "app copy pass $i failed, retry"; Start-Sleep -Milliseconds 500`,
        `}`,
        `if (-not $ok) {`,
        `  Note 'app copy FAILED - rollback and keep payload'`,
        `  $applyOk = $false`,
        // The incremental replacement failed (not instantaneous): Leave a mark and start next time to force the complete package to go,
        // Avoids the reloading of the same bad load -- this is an incremental version of the issue #98 death cycle.
        `  try { New-Item -ItemType File -Force -Path ${psq(path.join(this.updateDir, job.version, '.hydra-force-full'))} | Out-Null } catch {}`,
        `  if (Test-Path $appDst) { try { Remove-Item -LiteralPath $appDst -Recurse -Force } catch {} }`,
        `  if ($hasBackup) { try { Move-Item -LiteralPath $backup -Destination $appDst -Force } catch {} }`,
        `} else {`,
        `  if ($hasBackup) { try { Remove-Item -LiteralPath $backup -Recurse -Force } catch {} }`,
        `  try { Remove-Item -LiteralPath (Join-Path $src '.hydra-ready') -Force } catch {}`,
        `}`,
      );
    } else {
      lines.push(
        `Note 'run installer'`,
        `$p = Start-Process -FilePath ${psq(job.payload)} -ArgumentList '/S' -PassThru -Wait`,
        `Note ("installer exit " + $p.ExitCode)`,
        `Start-Sleep -Milliseconds 800`,
      );
    }

    lines.push(
      // #98: Start-Process only once, failure silences the user to see "off but not restarted."
      // Add-WorkingDirectory, failed to return cmd/c start, and wrote logs.
      `if (Test-Path ${psq(exe)}) {`,
      `  try {`,
      `    Start-Process -FilePath ${psq(exe)} -WorkingDirectory ${psq(dir)} -ErrorAction Stop`,
      `    Note 'relaunched via Start-Process'`,
      `  } catch {`,
      `    Note ("Start-Process failed: " + $_.Exception.Message + "; fallback to cmd start")`,
      `    try {`,
      `      Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','start','""',${psq(exe)} -WorkingDirectory ${psq(dir)} -WindowStyle Hidden`,
      `      Note 'relaunched via cmd start'`,
      `    } catch { Note ("cmd start failed: " + $_.Exception.Message) }`,
      `  }`,
      `} else { Note 'relaunch skipped: exe missing' }`,
      `Note 'updater done'`,
      `Start-Sleep -Milliseconds 400`,
      // Keep the entire version of the directory (load + readiness tag) when copying failed, to be continued at the next start;
      // Otherwise the pre-session foot says "retention load" and then deletes it, and then it’s never gonna get the document.
      `if ($applyOk) { Remove-Item -Path ${psq(path.join(this.updateDir, job.version))} -Recurse -Force }`,
      `else { Note 'version dir kept for resume on next launch' }`,
      // The closing clean-up statement failed (the directory has been deleted/slain softly). The caller should not be allowed to think that updating failed.
      `exit 0`,
    );

    const script = lines.join('\r\n');
    fs.writeFileSync(path.join(this.updateDir, 'apply.log.ps1'), script, 'utf8');
    if (opts.spawn === false) return script;
    // The Chinese path in the script will not be broken by the GGB decoding.
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    //  Here.**I can't.**Use detached: Some security software / Sandbox strategy to directly block the “separated control table process“,
    // It’s in the form of a script that doesn’t run at all (updated interface card is "substituting program and restarting").
    // Windows parent process exit does not kill ordinary subprocesses, so the same thing can be done with "general subprocess + unref"
    // We’re going to go back to work after we quit, and compatibility is better.
    const child = spawn(ps, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-EncodedCommand', b64,
    ], { stdio: 'ignore', windowsHide: true });
    child.unref();
    return true;
  }

  /** Throw the release page to the browser when the UI scene cannot be opened (or there is no automatically installed asset) */
  static repoUrl() {
    return `https://github.com/${OWNER}/${REPO}/releases`;
  }
}

module.exports = { Updater, cmpVer, OWNER, REPO, findUninstaller };
