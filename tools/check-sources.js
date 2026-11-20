'use strict';
/**
 * Double-source inspection: one command shows "the latest version of each of the two sources" and "the actual speed of each download address".
 *
 *   Node tables/check-sources.js# Check the updated package
 *   Node downs/checks-sources.js runtime#
 *
 * It's actually 256 KB, so it's gonna take a little traffic; it's gonna be confirmed before you do the code change.
 * "What kind of source should this machine come from?"
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-sources-'));
process.env.APPDATA = TMP;

const { Sources } = require('../src/core/sources');
const store = require('../src/core/store');
const { Provisioner } = require('../src/core/provision');

const mb = (n) => (n / 1048576).toFixed(2);
const host = (u) => { try { return new URL(u).host; } catch (_) { return u.slice(0, 40); } };

(async () => {
  const which = (process.argv[2] || 'update').toLowerCase();
  const sources = new Sources(() => store.getSettings());

  console.log('== sync, corrected by elderman ==');
  const rels = await sources.fetchReleases();
  for (const r of rels) {
    if (r.rel) {
      const assets = (r.rel.assets || []).length;
      console.log(`  ${r.name.padEnd(7)} ${String(r.rel.tag_name || r.rel.name || '').padEnd(10)} Assets ${assets} One.`);
    } else {
      console.log(`  ${r.name.padEnd(7)} It’s impossible.: ${r.error}`);
    }
  }

  console.log('\n== sync, corrected by elderman ==');
  const merged = await sources.latest();
  console.log(`  Maximum Version ${merged.tag}(${merged.assets.length} Assets)`);
  for (const a of merged.assets) {
    console.log(`    · ${a.name}  ${(a.size / 1048576).toFixed(0)}MB  [${a.source}]`);
  }

  console.log('\n== @elder_man');
  let target = null;
  if (which === 'runtime') {
    const p = new Provisioner(path.resolve(__dirname, '..'));
    const pack = await p.resolveRuntimePack().catch((e) => { console.log('  Parsing failed: ', e.message); return null; });
    if (pack) {
      console.log(`  Pack when running ${pack.name}(${pack.tag} · ${pack.from || '?'})`);
      target = pack.url;
    }
  } else {
    const pick = merged.assets.find((a) => /portable.*\.zip$/i.test(a.name)) || merged.assets[0];
    if (pick) {
      console.log(`  Update Package ${pick.name}`);
      target = pick.url;
    }
  }
  if (!target) {
    console.log('  No measurable assets');
  } else {
    const cands = sources.candidates(target);
    for (const c of cands) console.log(`  ${host(c).padEnd(22)} ${c === target ? '(Direct)' : '(Mirror)'}`);
    const t0 = Date.now();
    const ranked = await sources.rank(cands, { onProgress: (p) => console.log('  ·', p.message) });
    console.log(`  Speed time-consuming ${Date.now() - t0} ms, final order:`);
    ranked.forEach((u, i) => {
      const c = sources._rankCache.get(u) || {};
      console.log(`    ${i + 1}. ${host(u).padEnd(22)} ${c.ok ? `${mb(c.speed)} MB/s` : 'Not available'}`);
    });
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
})().catch((e) => {
  console.error(' Failed: ', e.message);
  process.exit(1);
});
