'use strict';

/**
 * Standalone test for the git-annex pointer detection used by Annex.
 *
 * Runs with plain Node (no Obsidian, no test framework):
 *     node test/pointer-detect.test.js
 *
 * The detection module is required in isolation so the pure function can be
 * exercised without loading Obsidian or the plugin class.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// The plugin is a single self-contained file; the helpers hang off its export.
const { isAnnexPointer, isAnnexPointerFile } = require('./load-plugin.js');

const FIXTURES = path.join(__dirname, 'fixtures');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok   ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  FAIL ' + name);
    console.log('       ' + err.message);
  }
}

console.log('pointer detection');

// --- pure string checks -----------------------------------------------------

check('pointer string is detected', () => {
  assert.strictEqual(
    isAnnexPointer('/annex/objects/SHA256E-s123--abc.pdf\n/annex/objects/SHA256E-s123--abc.pdf\n'),
    true
  );
});

check('bare pointer key is detected', () => {
  assert.strictEqual(isAnnexPointer('/annex/objects/SHA256E-s123--abc.pdf'), true);
});

check('real text content is NOT a pointer', () => {
  assert.strictEqual(
    isAnnexPointer('# Chapter 1\n\nThis is real content, not an annex pointer.\n'),
    false
  );
});

check('markdown heading starting with a slash is NOT a pointer', () => {
  assert.strictEqual(isAnnexPointer('/etc/hosts is a path, not an annex pointer\n'), false);
});

check('lookalike prefix is NOT a pointer', () => {
  assert.strictEqual(isAnnexPointer('/annex/object/SHA256E-s1--x'), false);
});

check('empty string is NOT a pointer', () => {
  assert.strictEqual(isAnnexPointer(''), false);
});

check('non-string input is NOT a pointer', () => {
  assert.strictEqual(isAnnexPointer(null), false);
  assert.strictEqual(isAnnexPointer(undefined), false);
  assert.strictEqual(isAnnexPointer(42), false);
});

// --- real fixture files -----------------------------------------------------

check('fixture pointer.pdf IS a pointer', () => {
  assert.strictEqual(isAnnexPointerFile(path.join(FIXTURES, 'pointer.pdf')), true);
});

check('fixture real.txt is NOT a pointer', () => {
  assert.strictEqual(isAnnexPointerFile(path.join(FIXTURES, 'real.txt')), false);
});

// --- report -----------------------------------------------------------------

console.log('');
if (failures.length === 0) {
  console.log(`PASS — ${passed} checks, 0 failures`);
  process.exit(0);
} else {
  console.log(`FAIL — ${passed} passed, ${failures.length} failed`);
  for (const f of failures) {
    console.log('  - ' + f.name + ': ' + f.err.message);
  }
  process.exit(1);
}
