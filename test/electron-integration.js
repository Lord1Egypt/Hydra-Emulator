'use strict';
/**
 * Electron Integration Test: Validate ICO generation, create fast, real icons faller
 * Run: eclectron test/electron-integration.js
 * Output: test/out/result.json
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const result = { steps: [] };
  const step = (name, ok, detail = '') => {
    result.steps.push({ name, ok, detail });
    console.log(`${ok ? '✓' : '✗'} ${name} ${detail}`);
  };

  try {
    const { drawAppIcon } = require('../src/core/png');
    const { pngToIco, writeShortcut, removeShortcut, iconToIco } = require('../src/core/shortcut');
    const { parseApk } = require('../src/core/apk');

    // 1. Program icons PNG ICO
    const png = drawAppIcon(256);
    fs.writeFileSync(path.join(OUT, 'icon.png'), png);
    const ico = pngToIco(png);
    fs.writeFileSync(path.join(OUT, 'icon.ico'), ico);
    step('Generate ICO', !!ico && ico.length > 1000, `${ico ? ico.length : 0} bytes`);

    // 1b. WebP icon downgrade path: nativeImage cannot solve WebP, must be decoded,
    // Branded placeholders when no decoder is available**In return.**(It’s a soft warning when it’s installed.
    {
      // Smallest WebP of 1x1
      const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
      let noDecoder = '';
      const placeholderIco = await iconToIco(webp, { onFallback: (why) => { noDecoder = why; } });
      step('WebP no decoder * legal ICO with downgrade',
        !!placeholderIco && placeholderIco.length > 100 && /placeholder|webp-decode-failed/.test(noDecoder),
        noDecoder || '(no callback)');

      let decoded = 0;
      const viaDecode = await iconToIco(webp, {
        decode: async () => { decoded++; return png; },
        onFallback: (why) => { throw new Error(`You shouldn't be downgraded.: ${why}`); },
      });
      // The key is that the output is legal.
      step('WebP icon final output ICO', !!viaDecode && viaDecode.readUInt16LE(2) === 1,
        `decode call ${decoded} Numbers, ${viaDecode ? viaDecode.length : 0} bytes`);
    }

    // 2. Shortcuts
    const lnk = path.join(OUT, 'test.lnk');
    writeShortcut({
      shortcutPath: lnk,
      target: process.execPath,
      args: '--version',
      iconIcoPath: path.join(OUT, 'icon.ico'),
      description: 'Hydra Emulator Integration Test',
    });
    step('Create. Ink', fs.existsSync(lnk));
    removeShortcut(lnk);
    step('Delete. Ink', !fs.existsSync(lnk));

    // 3. Real APK icon *ICO
    const fixture = process.env.HYDRA_TEST_APK
      || (() => {
        try {
          const dl = path.join(process.env.USERPROFILE || '', 'Documents');
          return fs.readdirSync(dl).map((f) => path.join(dl, f)).find((f) => /\.apk$/i.test(f));
        } catch (_) { return null; }
      })();
    if (fixture) {
      const meta = parseApk(fixture);
      const iconIco = pngToIco(meta.iconPng);
      if (iconIco) {
        fs.writeFileSync(path.join(OUT, 'app.ico'), iconIco);
        step('APK icon multi-dimensional ICO', true, `${meta.label}: ${iconIco.length} bytes`);
      } else {
        step('APK icon multi-dimensional ICO', false, 'PngToIco returns empty (an icon may be a format other than webp/ jpg))');
      }
    }

    result.ok = result.steps.every((s) => s.ok);
  } catch (e) {
    result.error = e.message;
    result.ok = false;
    console.error(e);
  }

  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
  app.exit(result.ok ? 0 : 1);
});
