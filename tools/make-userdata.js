'use strict';
/**
 * Generate userdata feed mirrors (retrieval).
 * Usage: none more tools/make-userdata.js < Output File > [MB Size and Size]]
 */
const fs = require('fs');
const { buildEmptyExt4 } = require('../src/core/userdata');

const out = process.argv[2];
if (!out) {
  console.error('Usage: none more tools/make-userdata.js < Output File > [MB Size and Size]]');
  process.exit(2);
}
const sizeMB = Number(process.argv[3] || 64);
const img = buildEmptyExt4({ sizeMB });
fs.writeFileSync(out, img);
console.log(`Generated ${out}(${(img.length / 1024 / 1024).toFixed(0)}MB, ext4/4KB block)`);
