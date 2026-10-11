'use strict';

/**
 * Standalone tests for the Annex *action state* mapping.
 *
 * Runs with plain Node (no Obsidian, no test framework):
 *     node test/annex-state.test.js
 *
 * The mapping is pure: `{ isPointer, whereisOutput } -> 'load' | 'drop' | 'none'`
 * so it can be exercised without a repository, a remote, or Obsidian.
 */

const assert = require('assert');

// The plugin is a single self-contained file; the helpers hang off its export.
const { annexState, parseWhereisJson, hasRemoteCopy } = require('./load-plugin.js');

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

// --- representative `git annex whereis --json` output (git-annex 10.x) --------

// A pointer file whose content lives only on a remote (trimmed to the fields
// the plugin reads).
const WHEREIS_REMOTE_ONLY =
  '{"command":"whereis","error-messages":[],' +
  '"file":"notes/attachments/diagram.png",' +
  '"key":"SHA256E-s21285--87df50f6.png","success":true,' +
  '"whereis":[{"description":"git@example.com:~/annex.git [origin]","here":false,' +
  '"urls":[],"uuid":"188da70c-7f58-4c88-adbd-1d41124e2cc9"}]}';

// Real content present here *and* a copy on a remote.
const WHEREIS_HERE_AND_REMOTE =
  '{"command":"whereis","success":true,"whereis":[' +
  '{"description":"here","here":true,"urls":[],"uuid":"aaaa"},' +
  '{"description":"git@example.com:~/annex.git [origin]","here":false,"urls":[],"uuid":"bbbb"}]}';

// Real content present here and it is the only copy.
const WHEREIS_HERE_ONLY =
  '{"command":"whereis","success":true,"whereis":[' +
  '{"description":"here","here":true,"urls":[],"uuid":"aaaa"}]}';

console.log('annex action state');

// --- the four required states ------------------------------------------------

check('pointer -> load', () => {
  assert.strictEqual(annexState({ isPointer: true, whereisOutput: '' }), 'load');
});

check('pointer -> load even if whereis reports a remote', () => {
  assert.strictEqual(
    annexState({ isPointer: true, whereisOutput: WHEREIS_REMOTE_ONLY }),
    'load'
  );
});

check('real file + remote copy -> drop', () => {
  assert.strictEqual(
    annexState({ isPointer: false, whereisOutput: WHEREIS_HERE_AND_REMOTE }),
    'drop'
  );
});

check('real file + only here -> none', () => {
  assert.strictEqual(
    annexState({ isPointer: false, whereisOutput: WHEREIS_HERE_ONLY }),
    'none'
  );
});

check('real file, not annexed (empty whereis) -> none', () => {
  assert.strictEqual(annexState({ isPointer: false, whereisOutput: '' }), 'none');
  assert.strictEqual(
    annexState({ isPointer: false, whereisOutput: '   \r\n' }),
    'none'
  );
});

// --- parsing robustness ------------------------------------------------------

check('parseWhereisJson extracts entries', () => {
  const entries = parseWhereisJson(WHEREIS_HERE_AND_REMOTE);
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].here, true);
  assert.strictEqual(entries[1].here, false);
});

check('parseWhereisJson handles newline-delimited objects', () => {
  const text = WHEREIS_HERE_ONLY + '\n' + WHEREIS_REMOTE_ONLY + '\n';
  assert.strictEqual(parseWhereisJson(text).length, 2);
});

check('parseWhereisJson tolerates garbage without throwing', () => {
  assert.deepStrictEqual(parseWhereisJson('not json at all'), []);
  assert.deepStrictEqual(parseWhereisJson('{"partial":'), []);
  assert.deepStrictEqual(parseWhereisJson(null), []);
  assert.deepStrictEqual(parseWhereisJson(undefined), []);
});

check('hasRemoteCopy: true only for a non-here entry', () => {
  assert.strictEqual(hasRemoteCopy(parseWhereisJson(WHEREIS_HERE_AND_REMOTE)), true);
  assert.strictEqual(hasRemoteCopy(parseWhereisJson(WHEREIS_REMOTE_ONLY)), true);
  assert.strictEqual(hasRemoteCopy(parseWhereisJson(WHEREIS_HERE_ONLY)), false);
  assert.strictEqual(hasRemoteCopy([]), false);
});

check('annexState never throws on odd input', () => {
  assert.strictEqual(annexState({}), 'none');
  assert.strictEqual(annexState({ isPointer: false, whereisOutput: null }), 'none');
  assert.strictEqual(annexState({ isPointer: false, whereisOutput: '{"a":1}' }), 'none');
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
