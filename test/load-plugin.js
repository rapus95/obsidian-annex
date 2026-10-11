'use strict';

/**
 * Loads the plugin's single-file `main.js` in a plain Node process by
 * redirecting `require('obsidian')` to the in-repo stub.
 *
 * `main.js` must be self-contained (Obsidian's Electron renderer cannot resolve
 * relative `require('./x')` calls), so this loader is the tests' only bridge to
 * it — it also doubles as a guard that no relative require sneaked back in.
 */

const Module = require('module');
const path = require('path');

const STUB = path.join(__dirname, 'stubs', 'obsidian.js');
const originalResolve = Module._resolveFilename;

Module._resolveFilename = function resolveFilename(request, ...rest) {
  if (request === 'obsidian') return STUB;
  return originalResolve.call(this, request, ...rest);
};

module.exports = require('../main.js');
