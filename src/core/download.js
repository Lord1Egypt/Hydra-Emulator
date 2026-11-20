'use strict';
/**
 * Downloader: Support reoriented, intermittent, progress echo, SHA-256 check
 * Only https/https, the main process and pure Node tests can be used.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const UA = 'Hydra Emulator/0.2 (Windows; +https://github.com/hydra)';

/**
 * Verify whether the Content-Range returned from the server is consistent with this request.
 * Fractional/part downloads are most afraid of "The server does not recognize Range, whole hair wrap" or "returned parts of other files."——
 * It’s like a complete, broken package. It’s a block-by-line, total size and...
 * Concent-Length, refuse any discrepancy, give it to the upper source/restart.
 */
function validRange(res, start, end, total) {
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(res.headers['content-range'] || ''));
  if (!m) return false;
  const [a, b, size] = m.slice(1).map(Number);
  const length = res.headers['content-length'];
  return Number.isSafeInteger(size) && a === start && b === end && size === total &&
    (length == null || Number(length) === end - start + 1);
}

function openStream(url, { method = 'GET', headers = {}, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Too many re-directions'));
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(url, {
      method,
      timeout: 30000,
      headers: { 'User-Agent': UA, 'Accept-Encoding': 'identity', ...headers },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        return resolve(openStream(next, { method, headers, redirects: redirects + 1 }));
      }
      resolve(res);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Connection timed out')); });
    req.end();
  });
}

async function head(url) {
  try {
    const res = await openStream(url, { method: 'HEAD' });
    res.resume();
    return {
      status: res.statusCode,
      size: Number(res.headers['content-length']) || 0,
      type: res.headers['content-type'] || '',
    };
  } catch (e) {
    return { status: 0, size: 0, error: e.message };
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

/**
 * Discard all the remnants of a failed download.
 *
 * Here's the root of the "repeated downloads": all the failed paths used to be abnormal, not delete files.,
 * So tmp lies in one and a half zip + one .chunks.json sidekick. Next time come in.
 * Download Parallel/ Download takes Range for renewal when you see an existing file
 * The total size/separation pattern will continue to fail if it’s not the same as the last time. →
 * Infinite loops. Users see "The same package is re-downloaded every time it’s open."
 *
 * Keeping the value of the periodicals is correct, but must be limited to the "acknowledged" scene; once this time,
 * The downloads failed, the whole package was scrapped, and the next time it was clean.
 */
function discardPartial(dest) {
  for (const p of [dest, `${dest}.chunks.json`, `${dest}.part`]) {
    try { fs.rmSync(p, { force: true }); } catch (_) { /* It's okay if you're occupied. */ }
  }
}

/**
 * Download to local files (auto-resumed).
 * @param {string} url
 * @param {string} dest
 * @param {object} opt { onProgress({got,total,percent,speed}), signal, expectSha256, timeoutMs }
 */
async function download(url, dest, opt = {}) {
  const { onProgress = () => {}, signal, expectSha256, retries = 2 } = opt;
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  let attempt = 0;
  try {
  for (;;) {
    attempt++;
    const existing = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    const headers = {};
    if (existing > 0) headers.Range = `bytes=${existing}-`;

    // eslint-disable-next-line no-await-in-loop
    const res = await openStream(url, { headers });

    if (res.statusCode === 416) {
      res.resume();
      // 416. There are two possibilities: the file is really finished, or the local fragments are not matched to the target.
      // Range is illegal. It was an unconditional success.
      // Range, who can still try again, cleans the pieces and pulls them all up again; re-drying is not a success, but a mistake.
      if (existing > 0 && attempt <= retries + 1) {
        discardPartial(dest);
        continue;
      }
      throw new Error('Could not verify extension, server returns HTTP 416');
    }
    if (res.statusCode !== 200 && res.statusCode !== 206) {
      res.resume();
      if (attempt <= retries) { await new Promise((r) => setTimeout(r, 1500)); continue; }
      discardPartial(dest);   // Try again: don't leave bad files for the next transmission.
      throw new Error(`Download Failed HTTP ${res.statusCode}: ${url}`);
    }

    if (res.statusCode === 206) {
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(res.headers['content-range'] || ''));
      if (!m || !validRange(res, existing, Number(m[2]), Number(m[3])) || Number(m[2]) !== Number(m[3]) - 1) {
        res.resume();
        discardPartial(dest);
        throw new Error('The server returned an unexpected byte range.');
      }
    }

    const total = res.statusCode === 206
      ? existing + (Number(res.headers['content-length']) || 0)
      : Number(res.headers['content-length']) || 0;

    if (res.statusCode === 200 && existing > 0) {
      // Server does not support renewal, rewrite
      fs.rmSync(dest, { force: true });
    }

    try {
      await new Promise((resolve, reject) => {
        const startSize = res.statusCode === 206 ? existing : 0;
        let got = startSize;
        let lastTick = Date.now();
        let lastBytes = got;
        const ws = fs.createWriteStream(dest, { flags: startSize > 0 ? 'a' : 'w' });

        // As with block downloads, there must be assurance that the program will.
        // Quiet connects (wall/ speed limit) res neither end, nor end, Pipe,
        // The whole download was stuck here, and the user saw the progress bar, and it was not wrong.
        const idleMs = Number(opt.idleMs) > 0 ? Number(opt.idleMs) : 30000;
        let settled = false;
        let idle = null;
        const finish = (err) => {
          if (settled) return;
          settled = true;
          if (idle) clearTimeout(idle);
          try { ws.destroy(); } catch (_) { /* ignore */ }
          if (err) reject(err); else resolve();
        };
        const kick = () => {
          if (settled) return;
          if (idle) clearTimeout(idle);
          idle = setTimeout(() => {
            res.destroy();
            finish(new Error('Connection stagnated (for long time no data available))'));
          }, idleMs);
        };
        kick();

        const onAbort = () => { res.destroy(new Error('Cancelled')); };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });

        res.on('data', (c) => {
          got += c.length;
          kick();
          const now = Date.now();
          if (now - lastTick > 400) {
            const speed = (got - lastBytes) / ((now - lastTick) / 1000);
            lastTick = now;
            lastBytes = got;
            onProgress({
              got, total,
              percent: total ? Math.min(100, (got / total) * 100) : 0,
              speed,
              eta: total && speed > 0 ? Math.max(0, (total - got) / speed) : null,
            });
          }
        });
        res.pipe(ws);
        ws.on('finish', () => finish());
        ws.on('error', (e) => finish(e));
        res.on('error', (e) => finish(e));
        res.on('close', () => { if (!res.complete) finish(new Error('Connection interrupted.')); });
      });
    } catch (e) {
      // Interrupt / timeout / write disk failed: Half-sections will only allow the next transmission to continue to fail
      discardPartial(dest);
      throw e;
    }

    break;
  }

  // End of story: Make sure the progress bar reaches 100%.
  const finalSize = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
  onProgress({ got: finalSize, total: finalSize, percent: 100, speed: 0, eta: 0 });

  if (expectSha256) {
    const actual = await sha256File(dest);
    if (actual.toLowerCase() !== expectSha256.toLowerCase()) {
      discardPartial(dest);
      throw new Error(`Verify failed: Expecting ${expectSha256.slice(0, 12)}… Actual ${actual.slice(0, 12)}…`);
    }
  }
  return { file: dest, size: fs.statSync(dest).size };
  } catch (e) {
    // OpenStream directly reject (connect denied / DNS failed / timeout) does not enter the flow section
    // Try/ catch -- there’s nothing clear here before, half a piece of paper to keep the next transmission going.
    // And then we’re all in the outermost layer: any drop is the first to throw away the remains.
    discardPartial(dest);
    throw e;
  }
}

/**
 * Parallel section downloads (large files only).
 * Single TCP connections to parts of the mirror will be limited to dozens of KB/s, and the splits will significantly increase actual vomiting.
 * Only in parallel when the target file does not exist; returns a single stream when part of the file is already available, avoiding the loss of block status.
 */
async function downloadParallel(url, dest, opt = {}) {
  const {
    connections = 8,
    onProgress = () => {},
    minChunk = 1024 * 1024,
    retries = 3,
  } = opt;

  // Some files are already available.
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    return download(url, dest, opt);
  }

  // Checking for support for Range
  let total = 0;
  let supportsRange = false;
  try {
    const probe = await openStream(url, { headers: { Range: 'bytes=0-0' } });
    const cr = probe.headers['content-range'];
    if (probe.statusCode === 206 && cr) {
      supportsRange = true;
      total = Number(/\/(\d+)$/.exec(cr)[1]) || 0;
    } else {
      total = Number(probe.headers['content-length']) || 0;
    }
    probe.destroy();
  } catch (_) { /* We're going to go to the unistream when we fail to detect. */ }

  if (!supportsRange || !total || total < minChunk * 2) {
    return download(url, dest, opt);
  }

  const n = Math.max(1, Math.min(connections, Math.ceil(total / minChunk)));
  const per = Math.ceil(total / n);
  const idleMs = Number(opt.idleMs) > 0 ? Number(opt.idleMs) : 20000;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { force: true });

  // Create an empty file and position it to the bottom byte to avoid any further cross-bordering of the write
  const fd = fs.openSync(dest, 'w');
  fs.ftruncateSync(fd, total);

  const chunks = Array.from({ length: n }, (_, i) => {
    const start = i * per;
    const end = Math.min(total - 1, start + per - 1);
    return { start, end, pos: start, done: false, tries: 0 };
  });

  let got = 0;
  let lastTick = Date.now();
  let lastBytes = 0;
  const tick = () => {
    const now = Date.now();
    if (now - lastTick < 400) return;
    const speed = (got - lastBytes) / ((now - lastTick) / 1000);
    lastTick = now;
    lastBytes = got;
    onProgress({
      got, total,
      percent: Math.min(100, (got / total) * 100),
      speed,
      eta: speed > 0 ? Math.max(0, (total - got) / speed) : null,
    });
  };

  const fetchChunk = async (c) => {
    const res = await openStream(url, { headers: { Range: `bytes=${c.pos}-${c.end}` } });
    if (res.statusCode !== 206) {
      res.resume();
      throw new Error(`Block request denied HTTP ${res.statusCode}`);
    }
    if (!validRange(res, c.pos, c.end, total)) {
      res.resume();
      throw new Error('The server returned an unexpected byte range.');
    }
    await new Promise((resolve, reject) => {
      // "Promise never setle": res. destroy(err) in some cases.
      // Close without error, without this guard, the whole block would be dead, the whole download would be parked there.
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(idle);
        if (err) reject(err); else resolve();
      };
      let idle = setTimeout(() => { res.destroy(); finish(new Error('Connection stagnated (for long time no data available))')); }, idleMs);
      const kick = () => {
        clearTimeout(idle);
        idle = setTimeout(() => { res.destroy(); finish(new Error('Connection stagnated (for long time no data available))')); }, idleMs);
      };
      res.on('data', (buf) => {
        // The server may return data beyond the requested fractions, and the extra bytes will be written through the other sections.,
        // Crush a silently damaged bag. It'd be better to make a failure, not let it fall.
        if (buf.length > c.end - c.pos + 1) {
          res.destroy();
          return finish(new Error('Block response beyond the request'));
        }
        try {
          fs.writeSync(fd, buf, 0, buf.length, c.pos);
        } catch (e) {
          res.destroy();
          return finish(e);
        }
        c.pos += buf.length;
        got += buf.length;
        kick();
        tick();
      });
      res.on('end', () => finish());
      res.on('error', (e) => finish(e));
      res.on('close', () => finish(new Error('Connection interrupted.')));
    });
    return c.pos > c.end;
  };

  try {
    await Promise.all(chunks.map(async (c) => {
      for (;;) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const ok = await fetchChunk(c);
          if (ok) return;
          throw new Error('Blocks incompletely returned');
        } catch (e) {
          c.tries += 1;
          if (c.tries >= retries) throw new Error(`Split Download Failed(${c.start}-${c.end}): ${e.message}`);
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 800 * c.tries));
        }
      }
    }));
  } catch (e) {
    try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    discardPartial(dest);   // The whole bag is dead. Don't leave half a piece of paper for the next transmission.
    throw e;
  }
  fs.closeSync(fd);

  const size = fs.statSync(dest).size;
  onProgress({ got: size, total: size, percent: 100, speed: 0, eta: 0 });
  if (size !== total) {
    discardPartial(dest);
    throw new Error(`Download incomplete: ${size}/${total} Bytes`);
  }
  return { file: dest, size, parallel: n };
}

/** Try multiple sources in turn, any success returns */
async function downloadAny(urls, dest, opt = {}) {
  const errors = [];
  for (const u of urls) {
    discardPartial(dest);   // Clear the half-section of the previous source before changing source
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await download(u, dest, opt);
      return { ...r, url: u };
    } catch (e) {
      errors.push(`${u} → ${e.message}`);
      discardPartial(dest);
    }
  }
  throw new Error(`All Download Sources Failed: \n${errors.join('\n')}`);
}

/**
 * Multi-source simultaneous download: Cut files into pieces, **Different pieces pull from different sources at the same time.**, Bandwidth stacking.
 *
 * Why do you need: GitHub single-connected speed limits are common, and mirror stations usually limit speeds on their own.
 * 8 links to the same address, the ceiling is the upper limit of that address. Give 4 to GitHub.,
 * Four to mirrors, plus the two ceilings, which are almost double the actuals.
 *
 * Security premises: Only the source of the “declaration of consistency” will be used, otherwise it may be misspelled;
 * Any source fails, and its sections are automatically replaced by the next available address (not repackaged).
 */
async function downloadMulti(urls, dest, opt = {}) {
  const {
    connections = 8,
    onProgress = () => {},
    minChunk = 2 * 1024 * 1024,
    // Three retries per piece are not enough on the "two occasional stops in three sources" chain.:
    // Once a piece of runtime bag is run out of time, the package is scraped. Give it to six times (two rounds per source).
    // Retry continues from breakpoint (c.pos reserves) and does not download the received bytes.
    retries = 6,
  } = opt;
  const idleMs = Number(opt.idleMs) > 0 ? Number(opt.idleMs) : 20000;

  const list = [...new Set((urls || []).filter(Boolean))];
  if (!list.length) throw new Error('No download address available');
  if (list.length === 1) return downloadParallel(list[0], dest, opt);

  // 1) Parallel detection: total size + whether Renge is supported
  const probes = await Promise.all(list.map(async (u) => {
    try {
      const res = await openStream(u, { headers: { Range: 'bytes=0-0' } });
      const cr = res.headers['content-range'];
      const total = res.statusCode === 206 && cr ? Number(/\/(\d+)$/.exec(cr)[1]) || 0 : 0;
      res.destroy();
      return { url: u, total, ranged: !!total };
    } catch (_) {
      return { url: u, total: 0, ranged: false };
    }
  }));

  const usable = probes.filter((p) => p.ranged && p.total > 0);
  if (!usable.length) {
    return downloadAnyParallel(list, dest, opt);
  }
  // Just mix the "states the same size" source, or it’ll spell out the bad files.
  // Baseline extraction**The fastest source is measured to be the total size.**(The order of usable is a rsk() sequenced speed order,
  // Promise.all, but the results are returned in the order of input.):
  // GitHub is different from release mirrors ’s bag bytes.),
  // Used to fix Math.max, it's like going down to the bigger source forever -- under the domestic network.
  // Instead, it is “a faster release mirrors bag is excluded and forced to slow the GitHub bag.“
  const total = usable[0].total;
  const same = usable.filter((p) => p.total === total);
  if (same.length === 1 || total < minChunk * 2) {
    return downloadParallel(same[0].url, dest, opt);
  }

  // 2) Cut blocks, rotation distribution source
  const n = Math.max(2, Math.min(connections, Math.ceil(total / minChunk)));
  const per = Math.ceil(total / n);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  // Break-in: 1.4 GB bag is easily depleted on the "Screen-Screen" chain.,
  // Once the whole package is scraped, the user will have to wait another 10 minutes.
  // In the side car file, next time only the missing blocks.
  const meta = `${dest}.chunks.json`;
  let doneSet = new Set();
  let resume = false;
  try {
    const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
    if (m && m.total === total && m.n === n && fs.existsSync(dest) && fs.statSync(dest).size === total) {
      doneSet = new Set(m.done || []);
      resume = true;
    }
  } catch (_) { /* If you don't have a side, you'll be all new. */ }

  if (!resume) {
    fs.rmSync(dest, { force: true });
    fs.rmSync(meta, { force: true });
  }
  const fd = resume ? fs.openSync(dest, 'r+') : fs.openSync(dest, 'w');
  if (!resume) fs.ftruncateSync(fd, total);

  const chunks = Array.from({ length: n }, (_, i) => ({
    start: i * per,
    end: Math.min(total - 1, i * per + per - 1),
    pos: i * per,
    src: i % same.length,
    tries: 0,
    rotates: 0,   // Must visible initialize: undefined < 2, is false, the switch of source never triggers
  })).filter((c) => !doneSet.has(c.start));

  const saveMeta = () => {
    try {
      fs.writeFileSync(meta, JSON.stringify({ total, n, done: [...doneSet] }));
    } catch (_) { /* It doesn't matter if the car doesn't go in. */ }
  };

  // Count completed blocks into progress on extension, the percentage that users see will not be repeated from 0
  let got = resume ? [...doneSet].reduce((sum, start) => (
    sum + (Math.min(total - 1, start + per - 1) - start + 1)
  ), 0) : 0;
  let lastTick = Date.now();
  let lastBytes = got;
  const tick = (force) => {
    const now = Date.now();
    if (!force && now - lastTick < 400) return;
    const speed = (got - lastBytes) / Math.max(0.001, (now - lastTick) / 1000);
    lastTick = now;
    lastBytes = got;
    onProgress({
      got,
      total,
      percent: Math.min(100, (got / total) * 100),
      speed,
      eta: speed > 0 ? Math.max(0, (total - got) / speed) : null,
      sources: same.length,
    });
  };

  // Low-speed source: When a block runs from one source to dozens of kB/s, light drags the whole download into the next.
  // "Crack at 95%." Run enough slowAafterMs and lower average speed than slowBps, and stop. Change source.
  // (Continue from breakpoint, without losing data. 2 times per piece, to avoid jumping between slow sources.
  const slowAfterMs = Number(opt.slowAfterMs) > 0 ? Number(opt.slowAfterMs) : 45000;
  const slowBps = Number(opt.slowBps) > 0 ? Number(opt.slowBps) : 120 * 1024;

  const fetchChunk = async (c) => {
    const url = same[c.src % same.length].url;
    const res = await openStream(url, { headers: { Range: `bytes=${c.pos}-${c.end}` } });
    if (res.statusCode !== 206) {
      res.resume();
      throw new Error(`Block denied HTTP ${res.statusCode}`);
    }
    if (!validRange(res, c.pos, c.end, total)) {
      res.resume();
      throw new Error('The server returned an unexpected byte range.');
    }
    const startPos = c.pos;
    const startedAt = Date.now();
    // The same connection destroy may still receive a buffered package. It will trigger a new source, skip the source.,
    // So each request is allowed only one more time.
    let rotated = false;
    await new Promise((resolve, reject) => {
      // Free door dog + "Secured setle": connection created but not a byte (commonly used)
      // "TCP through walls/limited", light waits 30 seconds; res. destroy (err))
      // Maybe if we don’t send a close, then we’ll never reject -- it’s a dead end.,
      // The whole download stopped there. So the doorman called himself.
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(idle);
        if (err) reject(err); else resolve();
      };
      let idle = setTimeout(() => { res.destroy(); finish(new Error('Connection stagnated (for long time no data available))')); }, idleMs);
      const kick = () => {
        clearTimeout(idle);
        idle = setTimeout(() => { res.destroy(); finish(new Error('Connection stagnated (no data timeout))')); }, idleMs);
      };
      res.on('data', (buf) => {
        // Idem: Deny bytes beyond the request, avoid silently writing bad fractions
        if (buf.length > c.end - c.pos + 1) {
          res.destroy();
          return finish(new Error('Block response beyond the request'));
        }
        try {
          fs.writeSync(fd, buf, 0, buf.length, c.pos);
        } catch (e) {
          res.destroy();
          return finish(e);
        }
        c.pos += buf.length;
        got += buf.length;
        kick();
        tick(false);
        // Slow to unacceptable before it's finished (c.pos is moving forward, continue from breakpoint next time))
        const took = Date.now() - startedAt;
        if (!rotated && took > slowAfterMs && (c.rotates || 0) < 2 && c.pos <= c.end) {
          const bps = (c.pos - startPos) / (took / 1000);
          if (bps < slowBps) {
            rotated = true;
            c.rotates = (c.rotates || 0) + 1;
            // C.src: Change of source is done by the Catch below, otherwise a failure will jump two sources.
            res.destroy();
            finish(new Error(`The source is too low.(${(bps / 1024).toFixed(0)} KB/s), retrying for source change`));
          }
        }
      });
      res.on('end', () => finish());
      res.on('error', (e) => finish(e));
      res.on('close', () => finish(new Error('Connection interrupted.')));
    });
    return c.pos > c.end;
  };

  try {
    await Promise.all(chunks.map(async (c) => {
      for (;;) {
        try {
          // eslint-disable-next-line no-await-in-loop
          if (await fetchChunk(c)) {
            doneSet.add(c.start);
            saveMeta();
            return;
          }
          throw new Error('Blocks incompletely returned');
        } catch (e) {
          c.tries += 1;
          if (c.tries >= retries) {
            // Retry Exhausted: This document has been mixed into "Bigs from different sources", and it’s continued.
            // You can't spell the right byte. The whole bag + the car is dead, and the next clean reset.
            // Once there was only save Meta, and each time it was opened, it continued from the bad side to the infinity.
            discardPartial(dest);
            throw new Error(`Split Failed(${c.start}-${c.end}): ${e.message}`);
          }
          // Another source retry: a mirror blow should not drag down the whole download.
          c.src += 1;
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 600 * c.tries));
        }
      }
    }));
  } catch (e) {
    try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    discardPartial(dest);
    throw e;
  }
  fs.closeSync(fd);
  fs.rmSync(meta, { force: true });

  const size = fs.statSync(dest).size;
  tick(true);
  if (size !== total) {
    discardPartial(dest);
    throw new Error(`Download incomplete: ${size}/${total} Bytes`);
  }
  return { file: dest, size, parallel: n, sources: same.length, multi: true, resumed: resume };
}

/** Try multiple sources in turn (parallel section), any success returns */
async function downloadAnyParallel(urls, dest, opt = {}) {
  const errors = [];
  for (const u of urls) {
    // Half-sections left from the previous source must be cleared before the source is changed: the package bytes from different sources may differ,
    // Take the A-source semi-finished to renew the B-source, and spell it out to be a bad file.
    discardPartial(dest);
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await downloadParallel(u, dest, opt);
      return { ...r, url: u };
    } catch (e) {
      errors.push(`${u} → ${e.message}`);
      discardPartial(dest);
    }
  }
  throw new Error(`All Download Sources Failed: \n${errors.join('\n')}`);
}

module.exports = {
  download, downloadAny, downloadParallel, downloadAnyParallel, downloadMulti,
  head, sha256File, openStream, discardPartial, validRange,
};
