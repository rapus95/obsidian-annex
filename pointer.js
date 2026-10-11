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

module.exports = {
  POINTER_PREFIX,
  HEAD_BYTES,
  isAnnexPointer,
  readHeadSync,
  isAnnexPointerFile,
};
