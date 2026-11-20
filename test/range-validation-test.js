'use strict';
/**
 * Pure Node tests for download range verification (no real network/simulator required).
 * Content-Range calibration and 416 continuation restoration over #92:
 *   - validRenge item by item, total size, Concent-Length;
 *   - Discarding the damaged fragments at 416 p.m., reloading them completely;
 *   - Block/multi-source downloads are rejected when the range does not match, and the damage bytes are not added to the target file.
 * Run: none test/range-value-test.js
 */
const assert = require('assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { download, downloadParallel, downloadMulti, validRange } = require('../src/core/download');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
const baseOf = (server) => `http://127.0.0.1:${server.address().port}`;

(async () => {
  console.log('\n[Checkdownload.jsContent-Range]');

  test('validRange accepts a fully matched response', () => {
    const res = { headers: { 'content-range': 'bytes 100-199/500', 'content-length': '100' } };
    assert.equal(validRange(res, 100, 199, 500), true);
  });
  test('validRange', () => {
    const res = { headers: { 'content-range': 'bytes 100-199/500' } };
    assert.equal(validRange(res, 100, 199, 500), true);
  });
  test('ValidRange rejects error starting/endpoint/total size/length', () => {
    const hdr = (cr, len) => ({ headers: { 'content-range': cr, 'content-length': len } });
    assert.equal(validRange(hdr('bytes 101-199/500', '99'), 100, 199, 500), false, 'The starting point does not match');
    assert.equal(validRange(hdr('bytes 100-198/500', '99'), 100, 199, 500), false, 'Endpoints do not match');
    assert.equal(validRange(hdr('bytes 100-199/400', '100'), 100, 199, 500), false, 'Total size does not match');
    assert.equal(validRange(hdr('bytes 100-199/500', '99'), 100, 199, 500), false, 'Length does not match');
    assert.equal(validRange(hdr('', '100'), 100, 199, 500), false, 'Missing Content-Range');
    assert.equal(validRange(hdr('bytes 0-3/8', '4'), 0, 3, 8), true);
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-range-'));
  try {
    // /416: take Range and go back to 416, without Range back to full “good“
    // /Bad: Detection bytes=0-0 back legal, with all remaining requests returned bytes 0-3/8 (not consistent with the scope of the request))
    const server = await serve((req, res) => {
      const r = req.headers.range;
      if (req.url === '/416') {
        if (r) { res.writeHead(416, { 'Content-Range': 'bytes */4' }); res.end(); }
        else { res.writeHead(200, { 'Content-Length': '4' }); res.end('good'); }
      } else if (req.url === '/ok') {
        if (r === 'bytes=0-0') { res.writeHead(206, { 'Content-Range': 'bytes 0-0/8', 'Content-Length': '1' }); res.end('a'); }
        else if (r) {
          const m = /bytes=(\d+)-(\d+)/.exec(r);
          const s = Number(m[1]); const e = Number(m[2]); const body = 'abcdefgh'.slice(s, e + 1);
          res.writeHead(206, { 'Content-Range': `bytes ${s}-${e}/8`, 'Content-Length': String(body.length) });
          res.end(body);
        } else { res.writeHead(200, { 'Content-Length': '8' }); res.end('abcdefgh'); }
      } else {
        if (r === 'bytes=0-0') { res.writeHead(206, { 'Content-Range': 'bytes 0-0/8', 'Content-Length': '1' }); res.end('a'); }
        else { res.writeHead(206, { 'Content-Range': 'bytes 0-3/8', 'Content-Length': '4' }); res.end('abcd'); }
      }
    });
    const base = baseOf(server);
    try {
      await atest('Single 416: Discard bad fragments and reload them', async () => {
        const out = path.join(dir, 'one');
        fs.writeFileSync(out, 'corrupt data');
        await download(`${base}/416`, out);
        assert.equal(fs.readFileSync(out, 'utf8'), 'good');
      });

      await atest('Single stream 206 is rejected if range does not match', async () => {
        const out = path.join(dir, 'resume');
        fs.writeFileSync(out, 'xxxx'); // Let's get the request with Range: bytes=4-
        await assert.rejects(download(`${base}/bad`, out), /range/i);
      });

      await atest('Refuse downloadparallel if range does not match, without half a document', async () => {
        const out = path.join(dir, 'two');
        await assert.rejects(
          downloadParallel(`${base}/bad`, out, { connections: 2, minChunk: 2, retries: 1 }),
          /range/i,
        );
        assert.equal(fs.existsSync(out), false, 'Target files should be cleared after failure');
      });

      await atest('Deny downloadMulti when range does not match', async () => {
        const out = path.join(dir, 'three');
        await assert.rejects(
          downloadMulti([`${base}/bad1`, `${base}/bad2`], out, { connections: 2, minChunk: 2, retries: 1 }),
          /range/i,
        );
      });

      await atest('Legal downloads are still successful (no return))', async () => {
        const out = path.join(dir, 'ok');
        const r = await download(`${base}/ok`, out, { retries: 1 });
        assert.equal(fs.readFileSync(out, 'utf8'), 'abcdefgh');
        assert.equal(r.size, 8);
      });
    } finally {
      await new Promise((r) => server.close(r));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n Result: ${passed} Through, ${failed}  Failed \n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
