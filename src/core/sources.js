'use strict';
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { cmpVer } = require('./version');

const OWNER_GH = 'Lord1Egypt';
const REPO = 'Hydra-Emulator';

const SOURCES = {
  github: {
    id: 'github',
    name: 'GitHub',
    api: `https://api.github.com/repos/${OWNER_GH}/${REPO}`,
    web: `https://github.com/${OWNER_GH}/${REPO}`,
  },
};

/** The known GitHub acceleration prefix. Only participation in speed measurement when the user opens autoMirror and does not customise. */
const KNOWN_MIRRORS = [
  'https://ghfast.top/',
  'https://gh-proxy.com/',
];

/**
 * The number of bytes of a sampling at a time.
 * 128KB is too small: handshake + TLS has hundreds of milliseconds, and the “speed“ measured is basically measuring the delay.,
 * The source of delay but bandwidth is misconstrued to be a slow 256 kB that separates the two, and the flow is acceptable.
 */
const SAMPLE_BYTES = 256 * 1024;

function openUrl(url, { timeout = 10000, headers = {}, redirects = 0, followRedirect = true } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Too many re-directions'));
    let u;
    try { u = new URL(url); } catch (_) { return reject(new Error('Chile')); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(url, {
      method: 'GET',
      timeout,
      headers: {
        'User-Agent': 'Hydra Emulator/0.3 (Windows)',
        'Accept-Encoding': 'identity',
        ...headers,
      },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && followRedirect) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        openUrl(next, { timeout, headers, redirects: redirects + 1, followRedirect }).then(resolve, reject);
        return;
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('Connection timed out')));
    req.on('error', reject);
    req.end();
  });
}

/** Take a little JSON (with redirection, timeout, maximum size)) */
async function getJson(url, timeout = 10000) {
  const res = await openUrl(url, { timeout });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    res.resume();
    throw new Error(`${new URL(url).host} ${res.statusCode}`);
  }
  const chunks = [];
  let len = 0;
  await new Promise((resolve, reject) => {
    res.on('data', (c) => {
      len += c.length;
      if (len > 4 * 1024 * 1024) { res.destroy(); resolve(); return; }
      chunks.push(c);
    });
    res.on('end', resolve);
    res.on('error', reject);
  });
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * It’s a little bit of a byte that really downloads to measure speed.
 * @returns {Promise<{url:string, ok:boolean, speed:number, got:number, ms:number, error?:string}>}
 */
function measure(url, { bytes = SAMPLE_BYTES, timeoutMs = 9000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let firstAt = 0;
    let got = 0;
    let settled = false;
    let req = null;
    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      try { req?.destroy(); } catch (_) { /* ignore */ }
      const now = Date.now();
      // Tossing is only the time after the byte: TLS handshake + DNS, the hundreds of milliseconds are fixed costs.,
      // The 1.4 GB package has little effect on total time, and the mixing speeds tend to lead to a bias in judgment.
      const span = Math.max(1, now - (firstAt || t0));
      resolve({
        url,
        ok: ok && got > 0,
        got,
        ms: now - t0,
        ttfb: firstAt ? firstAt - t0 : 0,
        speed: ok && got > 0 ? (got / span) * 1000 : 0,
        error,
      });
    };
    const timer = setTimeout(() => done(got > 0), timeoutMs);
    if (timer.unref) timer.unref();

    openUrl(url, {
      timeout: timeoutMs,
      headers: { Range: `bytes=0-${bytes - 1}` },
    }).then((res) => {
      req = res;
      if (res.statusCode >= 400) {
        res.resume();
        clearTimeout(timer);
        done(false, `HTTP ${res.statusCode}`);
        return;
      }
      res.on('data', (c) => {
        if (!firstAt) firstAt = Date.now();
        got += c.length;
        if (got >= bytes) { clearTimeout(timer); done(true); }
      });
      // The asset itself is smaller than the sample: reading EOF is a success.
      res.on('end', () => { clearTimeout(timer); done(got > 0); });
      res.on('error', (e) => { clearTimeout(timer); done(false, e.message); });
    }).catch((e) => { clearTimeout(timer); done(false, e.message); });
  });
}

/** Put the GitHub asset address in a mirror prefix */
function withMirror(url, prefix) {
  if (!prefix || !/^https?:\/\//i.test(prefix)) return '';
  const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return `${p}${url}`;
}

/**
 * release mirrors distribution attachment single file cap 100MB, installation package 105~110MB unloaded, so it is cut when released
 * xx.zip.part1 /xx.zip.part2.:
 *   {name: 'xx.zip', size: sum, parts: [{index, size, urls: [...]}
 * The fragments must start continuously from part 1, or they will be considered disabled, discarded (preferable to the whole package, not the next one).
 */
function groupParts(assets) {
  const groups = new Map();
  const out = [];
  for (const a of assets) {
    const m = /^(.*)\.part(\d+)$/i.exec(String(a.name || ''));
    if (!m) { out.push(a); continue; }
    const base = m[1];
    const idx = Number(m[2]);
    let g = groups.get(base);
    if (!g) {
      g = { name: base, size: 0, parts: [], partial: true };
      groups.set(base, g);
      out.push(g);
    }
    let p = g.parts.find((x) => x.index === idx);
    if (!p) {
      p = { index: idx, size: Number(a.size) || 0, urls: [] };
      g.parts.push(p);
    }
    if (a.url && !p.urls.includes(a.url)) p.urls.push(a.url);
    if (!p.size) p.size = Number(a.size) || 0;
  }
  for (const g of groups.values()) {
    g.parts.sort((x, y) => x.index - y.index);
    const contiguous = g.parts.every((p, i) => p.index === i + 1);
    g.size = g.parts.reduce((n, p) => n + (Number(p.size) || 0), 0);
    // Note: issue asset entries for release mirrors only have name/ url, **No size**.
    // "size>0" as a condition of integrity is used to render the whole fragment to be broken and discarded.),
    // So here only requires "separated series + each piece has an address"; the size of the item is not known and the progress is shown by the received byte.
    if (!contiguous || !g.parts.every((p) => p.urls.length)) g.broken = true;
  }
  return { list: out.filter((a) => !a.broken), broken: [...groups.values()].filter((g) => g.broken).map((g) => g.name) };
}

/** list of mmirors: User custom priority, second built-in (autoMirror off) only by custom) */
function mirrorList(settings) {
  const r = (settings && settings.runtime) || {};
  const custom = String(r.mirrorPrefix || process.env.HYDRA_MIRROR || '').trim();
  if (custom) return [custom];
  if (r.autoMirror !== true) return [];
  return KNOWN_MIRRORS.slice();
}

class Sources {
  constructor(settingsFn) {
    this.settings = typeof settingsFn === 'function' ? settingsFn : () => ({});
    this._rankCache = new Map();   // url -> {at, speed, ok}
    this._rankTtl = 30 * 60 * 1000;
    // Version check results cache: The anonymous call limit flow for release mirrors is tight (403 times in a row).),
    // And "There’s no new version" doesn’t need a second-class freshness.
    this._relCache = { at: 0, value: null };
    this._relTtl = 10 * 60 * 1000;
    // Melting: After a source has been restricted/misreported, skips it directly for a while, stops hitting walls every time it starts.
    this._blocked = new Map();     // sourceId -> until(ms)
    this._blockMs = 15 * 60 * 1000;
  }

  /** Whether the source is in a smelting break; returns null to be available, otherwise the reason for the user to see */
  blockedReason(id) {
    const until = this._blocked.get(id) || 0;
    if (until <= Date.now()) return null;
    return `Temporarily paused. Retry in ${Math.ceil((until - Date.now()) / 60000)} min.`;
  }

  /** The latest release of all sources. None of the failures affect the other.) */
  /**
   * API ’s background not dependent on: follow directly `/releases/latest` 302, get the bag.
   *
   * Why must this be: the anonymous API of GitHub only 60 times an hour for each IP?,
   * The anonymous API of release mirrors is tighter.
   * Company/campus network, operator NT exit, user easily “checking update failed”——
   * And... `releases/latest` This web page jumps from CDN, without an API amount.
   *
   * We’ll get the tag and we’ll spell the asset name out as promised.:
   *   Hydra Emulator-<tag>-win64-portable.zip / Hydra Emulator-<version>-Setup.exe / Hydra Emulator-runtime-<tag>.zip
   */
  async _releaseTagViaRedirect(id) {
    const s = SOURCES[id];
    const page = `${s.web}/releases/latest`;
    const res = await openUrl(page, { timeout: 9000, followRedirect: false });
    const loc = String(res.headers.location || '');
    try { res.resume(); } catch (_) { /* ignore */ }
    const m = /\/releases\/tag\/([^/?#]+)/i.exec(loc);
    return m ? decodeURIComponent(m[1]) : '';
  }

  /** Spell a "minim available" release with tag (without API)) */
  _syntheticRelease(id, tag) {
    const s = SOURCES[id];
    const ver = String(tag).replace(/^v/i, '');
    const names = [
      `Hydra-Emulator-${tag}-win64-portable.zip`,
      `Hydra-Emulator-${ver}-Setup.exe`,
      `Hydra-Emulator-runtime-${tag}.zip`,
    ];
    // GitHub and release mirrors support/releases/download/<tag>/This is a regular address for <document name >
    // (It’s been measured that release mirrors will have 302 attachments to the mirror host, which can normally drop down to the full bytes.),
    // So you can spell out the available download address without API. The assets not on release mirrors will be 404.,
    // The velocity sequences in the back jump over it.
    const assets = names.map((n) => ({
      name: n,
      size: 0,
      browser_download_url: `${s.web}/releases/download/${tag}/${n}`,
    }));
    return {
      tag_name: tag,
      name: tag,
      body: '',
      html_url: `${s.web}/releases/tag/${tag}`,
      published_at: '',
      assets,
      synthetic: true,
    };
  }

  async fetchReleases() {
    const s = SOURCES.github;
    const source = { source: s.id, name: s.name, web: s.web };
    const skip = this.blockedReason(s.id);
    if (skip) return [{ ...source, error: skip }];
    try {
      const rel = await getJson(`${s.api}/releases/latest`, 9000);
      return [{ ...source, rel }];
    } catch (e) {
      try {
        const list = await getJson(`${s.api}/releases?per_page=10`, 9000);
        const first = (Array.isArray(list) ? list : []).find((release) => release && !release.draft);
        if (first) return [{ ...source, rel: first }];
      } catch (_) { /* Try the release page if the API is unavailable. */ }
      try {
        const tag = await this._releaseTagViaRedirect(s.id);
        if (tag) return [{ ...source, rel: this._syntheticRelease(s.id, tag), degraded: true }];
      } catch (_) { /* Report the API error below. */ }
      const limited = /\b(403|429)\b/.test(e.message);
      if (limited) this._blocked.set(s.id, Date.now() + this._blockMs);
      return [{ ...source, error: e.message + (limited ? ' (rate limited)' : '') }];
    }
  }

  /**
   * Merge the latest version on both sides: the higher version number wins, but**Assets List Merge**,
   * So even if release mirrors only put metadata in it, the assets in GitHub can be tried both ways.
   */
  async latest({ force = false } = {}) {
    const cached = this._relCache;
    if (!force && cached.value && Date.now() - cached.at < this._relTtl) {
      return cached.value;
    }
    const all = await this.fetchReleases();
    // The source of the restricted stream is entered into the melting (instead of being set inside the fetchReleases), so that "who will provide it?"
    // And it’s been replaced/tested, and it’s guaranteed that 403 of any entry will trigger a break-up.)
    for (const x of all) {
      if (x && x.error && /\b(403|429)\b/.test(x.error)) {
        this._blocked.set(x.source, Date.now() + this._blockMs);
      }
    }
    const ok = all.filter((x) => x && x.rel);
    if (!ok.length) {
      const why = all.map((x) => `${x.name || x.source}: ${x.error || 'No data'}`).join('; ');
      // All dead but with the last result: we’d rather give an old version of information.,
      // Nor should the interface be misdirected -- at least the user can see the current version and the page entry.
      if (cached.value) return { ...cached.value, stale: true, staleReason: why };
      throw new Error(`Could not close temporary folder: %s(${why})`);
    }
    ok.sort((a, b) => cmpVer(b.rel.tag_name || b.rel.name, a.rel.tag_name || a.rel.name));
    const top = ok[0];
    const tag = String(top.rel.tag_name || top.rel.name || '');
    const version = tag.replace(/^v/i, '');

    // Only the same version of assets counts.
    // When the same name whole package + snippets exist simultaneously, priority is given to the whole package: the piece must be combined, with one more failure point.
    let raw = [];
    for (const item of ok) {
      const t = String(item.rel.tag_name || item.rel.name || '').replace(/^v/i, '');
      if (t !== version) continue;
      for (const a of (item.rel.assets || [])) {
        const key = String(a.name || '');
        if (!key) continue;
        // release mirrors automatically hangs the "source package" as an asset (v0.3.2.zip/v0.3.2.tar.gz).),
        // These aren't installation packages., `\.zip$` The matching rules will be downloaded as an update package -- they must be excluded.
        // Our own release of assets is made more secure, starting with Hydra Emulator, by the prefixed white list.
        if (!/^Hydra[ -]Emulator-/i.test(key)) continue;
        raw.push({
          name: key,
          size: Number(a.size) || 0,
          url: a.browser_download_url || a.url || '',
          source: item.source,
        });
      }
    }
    const grouped = groupParts(raw);
    const wholeNames = new Set(grouped.list.filter((a) => !a.partial).map((a) => a.name));
    raw = grouped.list.filter((a) => !(a.partial && wholeNames.has(a.name)));

    // The same asset has both sources (the usual pattern after the whole package is no longer sliced): keep the address as a candidate.
    // It used to be, "Who’s gonna use it first?" -- GitHub was in front, and release mirrors’s address was thrown out.,
    // "Automated selection of better sources of network" actually degenerates into one walk, GitHub. Now picks at actual speed (see rank()).
    // The size of each address is recorded separately: two source packages are not the same bytes (compressors/constructors differ, they can vary by a few MBs)),
    // DownloadMulti will only mix the "declarations of equal size" addresses, so they must not be equalized.
    const assets = [];
    const byName = new Map();
    for (const a of raw) {
      const hit = byName.get(a.name);
      if (!hit) {
        const item = { ...a, urls: a.url ? [a.url] : [], sizes: {} };
        if (a.url && a.size) item.sizes[a.url] = a.size;
        byName.set(a.name, item);
        assets.push(item);
        continue;
      }
      if (a.url && !hit.urls.includes(a.url)) hit.urls.push(a.url);
      if (a.url && a.size) hit.sizes[a.url] = a.size;
      if (!hit.size && a.size) hit.size = a.size;
    }

    const result = {
      version,
      tag,
      name: top.rel.name || tag,
      notes: top.rel.body || '',
      htmlUrl: top.rel.html_url || top.web,
      publishedAt: top.rel.published_at || top.rel.created_at || '',
      assets,
      sources: ok.map((x) => ({ source: x.source, name: x.name, tag: x.rel.tag_name || x.rel.name || '' })),
      unreachable: all.filter((x) => x && x.error).map((x) => ({ source: x.source, name: x.name, error: x.error })),
      bySource: top.source,
    };
    this._relCache = { at: Date.now(), value: result };
    return result;
  }

  /**
   * A candidate address for an asset under all source + mirrors (go weight, sequence: source station priority, second mirror).
   * Mirror only on GitHub address: ghfast/ gh-proxy only represents GitHub,
   * Putting release mirrors’s link together will only get a 403, one more speed.
   */
  candidates(assetOrUrl) {
    // Supports three accesses: single address, asset object (url), consolidated asset object (urls arrays, with two sources))
    const urls = (typeof assetOrUrl === 'string'
      ? [assetOrUrl]
      : (assetOrUrl && (assetOrUrl.urls && assetOrUrl.urls.length ? assetOrUrl.urls : [assetOrUrl.url])))
      .filter(Boolean);
    const out = [];
    if (!urls.length) return out;
    const mirrors = mirrorList(this.settings());
    for (const url of urls) {
      if (out.includes(url)) continue;
      out.push(url);
      let host = '';
      try { host = new URL(url).host.toLowerCase(); } catch (_) { continue; }
      const isGithub = /(^|\.)github\.com$/.test(host) || /(^|\.)githubusercontent\.com$/.test(host);
      if (!isGithub) continue;
      for (const m of mirrors) {
        const u = withMirror(url, m);
        if (u && !out.includes(u)) out.push(u);
      }
    }
    return out;
  }

  /**
   * Sorting of candidate address at actual speed. Speed results cache 30 minutes;
   * The failure of all speed tests returns to the original sequence.
   */
  async rank(urls, { onProgress } = {}) {
    const list = (urls || []).filter(Boolean);
    if (list.length <= 1) return list;
    const now = Date.now();
    const need = [];
    for (const u of list) {
      const c = this._rankCache.get(u);
      if (!c || now - c.at > this._rankTtl) need.push(u);
    }
    if (need.length) {
      onProgress?.({ stage: 'probe', message: `We’re going to speed. ${need.length} Synchronising folder…` });
      // And then they’re going to grab each other’s bandwidth, and they’re going to be called "who’s the killer.",
      // And not "who’s really fast." Every source 256 kB, normal for about a second.
      // Single source waits 6 seconds at most (old version 9 seconds x 4 sources = maximum 36 seconds without any byte progress,
      // Users see "cards when they're ready to run"; speed failure is only the last, without prejudice to downloading.
      let i = 0;
      for (const u of need) {
        i += 1;
        let host = u;
        try { host = new URL(u).host; } catch (_) { /* Could not close temporary folder: %s */ }
        onProgress?.({ stage: 'probe', message: `We’re going to speed number one. ${i}/${need.length} Source: ${host}…` });
        // eslint-disable-next-line no-await-in-loop
        const r = await measure(u, { timeoutMs: 6000 });
        this._rankCache.set(u, { at: Date.now(), ok: r.ok, speed: r.speed });
      }
    }
    const score = (u) => {
      const c = this._rankCache.get(u);
      return c && c.ok ? c.speed : -1;
    };
    const sorted = list.slice().sort((a, b) => score(b) - score(a));
    const best = sorted[0];
    const s = score(best);
    if (s > 0) {
      onProgress?.({
        stage: 'probe',
        message: `The fastest source selected: ${new URL(best).host}(- I’m sorry. ${(s / 1048576).toFixed(2)} MB/s)`,
      });
    }
    return sorted;
  }

  /** Speed detection cache empty (user changed mirror prefix / changed network call) */
  reset() {
    this._rankCache.clear();
    this._relCache = { at: 0, value: null };
    this._blocked.clear();
  }
}

module.exports = { Sources, SOURCES, measure, KNOWN_MIRRORS, withMirror, mirrorList };
