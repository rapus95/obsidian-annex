'use strict';

/**
 * git-annex pointer detection.
 *
 * A git-annex *pointer file* is a tiny text file whose content starts with the
 * key path `/annex/objects/`, e.g.:
 *
 *     /annex/objects/SHA256E-s123--abc.pdf
 *     /annex/objects/SHA256E-s123--abc.pdf
 *
 * We only ever read a small head of the file (never the whole file) so that
 * large annexed objects are not slurped into memory.
 *
 * This module is deliberately free of any Obsidian dependency so that it can be
 * unit-tested with plain Node and required from `main.js`.
 */

const fs = require('fs');

/** Every git-annex pointer file starts with this literal prefix. */
const POINTER_PREFIX = '/annex/objects/';

/** How many bytes of a file head we inspect for detection. */
const HEAD_BYTES = 100;

/**
 * Decide whether a head snippet belongs to a git-annex pointer file.
 *
 * @param {unknown} head first bytes of a file, decoded as UTF-8
 * @returns {boolean} true when the content is a git-annex pointer
 */
function isAnnexPointer(head) {
  if (typeof head !== 'string') return false;
  return head.startsWith(POINTER_PREFIX);
}

/**
 * Read up to `bytes` bytes from the start of a file, decoded as UTF-8.
 *
 * @param {string} filePath absolute path to the file
 * @param {number} [bytes] number of bytes to read (default HEAD_BYTES)
 * @returns {string} the file head
 */
function readHeadSync(filePath, bytes = HEAD_BYTES) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.slice(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read only the head of `filePath` and decide whether it is a pointer file.
 *
 * @param {string} filePath absolute path to the file
 * @returns {boolean} true when the file on disk is a git-annex pointer
 */
function isAnnexPointerFile(filePath) {
  return isAnnexPointer(readHeadSync(filePath, HEAD_BYTES));
}

// --- action state -----------------------------------------------------------

/** The file must be fetched from the annex (`git annex get`). */
const STATE_LOAD = 'load';
/** The local copy may be freed (`git annex drop`). */
const STATE_DROP = 'drop';
/** Nothing to do; the status bar stays hidden. */
const STATE_NONE = 'none';

/**
 * Parse the output of `git annex whereis --json` into the list of locations.
 *
 * git-annex emits one compact JSON object per file (newline delimited); each
 * carries a `whereis` array whose entries have a boolean `here` flag. Anything
 * unparseable is ignored rather than thrown, so a surprising git-annex version
 * degrades to "no copy known" instead of crashing the plugin.
 *
 * @param {unknown} text raw stdout of `git annex whereis --json`
 * @returns {Array<object>} the flattened `whereis` entries (possibly empty)
 */
function parseWhereisJson(text) {
  if (typeof text !== 'string') return [];
  const trimmed = text.trim();
  if (!trimmed) return [];

  const entries = [];

  const collect = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value.whereis)) {
      for (const entry of value.whereis) {
        if (entry && typeof entry === 'object') entries.push(entry);
      }
    }
  };

  for (const line of trimmed.split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) parsed.forEach(collect);
      else collect(parsed);
    } catch (err) {
      // Not a complete object on this line; the whole-text fallback below
      // still gets a chance to parse pretty-printed output.
    }
  }

  if (!entries.length) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) parsed.forEach(collect);
      else collect(parsed);
    } catch (err) {
      return [];
    }
  }

  return entries;
}

/**
 * Does at least one location other than the local repository hold a copy?
 *
 * @param {unknown} entries entries from {@link parseWhereisJson}
 * @returns {boolean} true when a remote (i.e. not `here`) has a copy
 */
function hasRemoteCopy(entries) {
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) => entry && typeof entry === 'object' && entry.here === false);
}

/**
 * Map a file's annex situation onto the action the status bar should offer.
 *
 * - a pointer file must be fetched -> `'load'`
 * - real content that a remote also has -> `'drop'` (safe to free locally)
 * - real content that is the only copy -> `'none'` (never drop the last copy)
 * - not an annexed file at all -> `'none'`
 *
 * Pure and total: never throws, whatever it is handed.
 *
 * @param {{ isPointer?: boolean, whereisOutput?: unknown }} input
 * @returns {'load'|'drop'|'none'}
 */
function annexState(input) {
  const value = input && typeof input === 'object' ? input : {};
  if (value.isPointer) return STATE_LOAD;
  const entries = parseWhereisJson(value.whereisOutput);
  if (!entries.length) return STATE_NONE;
  return hasRemoteCopy(entries) ? STATE_DROP : STATE_NONE;
}

module.exports = {
  POINTER_PREFIX,
  HEAD_BYTES,
  isAnnexPointer,
  readHeadSync,
  isAnnexPointerFile,
  STATE_LOAD,
  STATE_DROP,
  STATE_NONE,
  parseWhereisJson,
  hasRemoteCopy,
  annexState,
};
