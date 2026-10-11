'use strict';

/**
 * Annex — an Obsidian plugin that loads and frees git-annex content.
 *
 * SINGLE FILE ON PURPOSE. Obsidian runs plugins inside an Electron renderer
 * (`electron/js2c/renderer_init`), where a relative `require('./pointer.js')`
 * cannot be resolved. Everything the plugin needs therefore lives in this file;
 * the pure helpers at the top are also hung off the exported class so the test
 * suite can exercise them without a build step.
 *
 * NO CONFIGURATION. The annex repository is resolved *per file*: commands are
 * run with `git -C <folder of the opened file>`, and git walks up the directory
 * tree until it finds `.git`. That works for any layout — the vault itself being
 * one annex repository, several annex repositories inside one vault, or a
 * repository that lives outside the vault — without the plugin knowing where the
 * repository is.
 *
 * The plugin exposes a single status-bar *toggle* whose meaning depends on the
 * file that is open:
 *
 *   pointer file              -> "⬇ Annex: load"    -> `git annex get`
 *   real file, copy elsewhere -> "⬆ Annex: free"    -> `git annex drop`
 *   real file, only copy      -> hidden (never drop the last copy)
 *   not an annexed file       -> hidden
 *
 * `drop` is never run with `--force`: when git-annex refuses (e.g. it would
 * remove the last copy), the refusal is surfaced in a Notice instead of being
 * worked around.
 */

const { Plugin, Notice } = require('obsidian');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Pointer detection
// ---------------------------------------------------------------------------

/**
 * A git-annex *pointer file* is a tiny text file whose content starts with the
 * key path `/annex/objects/`, e.g.:
 *
 *     /annex/objects/SHA256E-s123--abc.pdf
 *     /annex/objects/SHA256E-s123--abc.pdf
 *
 * We only ever read a small head of the file (never the whole file) so that
 * large annexed objects are not slurped into memory.
 */

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

// ---------------------------------------------------------------------------
// Action state
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

/** Status bar labels. */
const LABEL_LOAD = '⬇ Annex: load';
const LABEL_DROP = '⬆ Annex: free';
const LABEL_LOADING = '⏳ Annex: loading…';
const LABEL_DROPPING = '⏳ Annex: freeing…';

/**
 * Extensions we are confident can be re-written through the vault API without
 * corrupting bytes. Anything else (PDF, images, …) is reloaded by re-opening
 * the leaf instead, so the viewer re-reads the now-changed file from disk.
 */
const TEXT_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'json', 'canvas', 'base', 'csv', 'html', 'htm',
  'css', 'js', 'ts', 'yaml', 'yml',
]);

/** Shell-quote a single argument for `exec` (Windows and POSIX friendly). */
function quoteArg(value) {
  return '"' + String(value).replace(/"/g, '\\"') + '"';
}

/**
 * Run a command through the shell and resolve with its output.
 *
 * Commands are always given an explicit `-C <dir>` so the working directory of
 * the Obsidian process never matters.
 */
function run(command) {
  return new Promise((resolve, reject) => {
    exec(command, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/** `git -C <dir> <rest...>` with every argument safely quoted. */
function git(dir, rest) {
  return 'git -C ' + quoteArg(dir) + ' ' + rest;
}

/** Is `dir` inside a git work tree? (git walks up until it finds `.git`.) */
async function isGitRepo(dir) {
  try {
    await run(git(dir, 'rev-parse --show-toplevel'));
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Is `dir` inside a git *annex* repository? `annex.uuid` is set by
 * `git annex init` and is the cheapest reliable marker.
 */
async function isAnnexRepo(dir) {
  try {
    const { stdout } = await run(git(dir, 'config --get annex.uuid'));
    return Boolean(String(stdout).trim());
  } catch (err) {
    return false;
  }
}

/** Condense a Node/git error into one readable line for a Notice. */
function describeError(error) {
  const parts = [];
  if (error && error.stderr) parts.push(String(error.stderr).trim());
  if (!parts.length && error && error.stdout) parts.push(String(error.stdout).trim());
  if (!parts.length && error && error.message) parts.push(String(error.message).trim());
  const detail = parts.join(' ').split(/\r?\n/).filter(Boolean).slice(-3).join(' ');
  return detail || 'unknown error';
}

/** Does the failure look like the annex remote being unreachable? */
function looksUnreachable(text) {
  return /ssh|connect|connection|unreachable|timed? ?out|network|no route|host key|host is down|refused/i
    .test(String(text));
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

class ObsidianAnnexPlugin extends Plugin {
  async onload() {
    this.loaded = new Set();   // vault-relative paths loaded during this session
    this.busy = false;
    this.mode = 'none';        // 'load' | 'drop' | 'none'
    this.currentFile = null;
    this.refreshToken = 0;     // guards against stale async refreshes

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass('obsidian-annex-status');
    this.statusBarEl.style.cursor = 'pointer';
    this.statusBarEl.addEventListener('click', () => this.toggleCurrentFile());
    this.hideStatus();

    this.addCommand({
      id: 'annex-toggle-current-file',
      name: 'Toggle load/free for the current file',
      callback: () => this.toggleCurrentFile(),
    });

    this.addCommand({
      id: 'annex-drop-all-loaded',
      name: 'Free every file loaded this session',
      callback: () => this.dropAllLoaded(),
    });

    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        this.currentFile = file || null;
        this.refreshStatus(file || null);
      })
    );

    // Reflect the file that is already open when the plugin loads.
    this.refreshStatus(this.app.workspace.getActiveFile());
  }

  onunload() {
    this.hideStatus();
  }

  // -- paths ----------------------------------------------------------------

  getVaultRoot() {
    const adapter = this.app.vault.adapter;
    if (adapter && typeof adapter.getBasePath === 'function') {
      return adapter.getBasePath();
    }
    return adapter && adapter.basePath;
  }

  absolutePath(file) {
    const root = this.getVaultRoot();
    return path.join(root, file.path.split('/').join(path.sep));
  }

  // -- classification -------------------------------------------------------

  /**
   * Inspect `file` and decide which action applies. Quiet: never raises a
   * Notice, never throws. Returns `{ mode, reason, file, dir, name }`.
   *
   * The repository is discovered per file: `dir` is the folder the file lives
   * in, and every git command runs with `git -C <dir>`, so git finds the
   * nearest repository by walking up.
   */
  async classify(file) {
    const result = { mode: 'none', reason: 'no-file', file: null, dir: null, name: null };
    if (!file) return result;
    result.file = file;

    const root = this.getVaultRoot();
    if (!root) {
      result.reason = 'no-vault';
      return result;
    }

    const abs = this.absolutePath(file);
    const dir = path.dirname(abs);
    result.dir = dir;
    result.name = path.basename(abs);

    // A pointer file is cheap to spot from disk alone and is, by definition,
    // git-annex content — no repository probe needed to offer a load.
    let isPointer = false;
    try {
      isPointer = fs.existsSync(abs) && isAnnexPointerFile(abs);
    } catch (err) {
      isPointer = false;
    }
    if (isPointer) {
      result.mode = 'load';
      result.reason = 'pointer';
      return result;
    }

    // Real content on disk: it only makes sense to offer *free* inside an
    // annex repository that tracks the file.
    if (!(await isGitRepo(dir))) {
      result.reason = 'not-git-repo';
      return result;
    }
    if (!(await isAnnexRepo(dir))) {
      result.reason = 'not-annex-repo';
      return result;
    }

    let whereisOutput = '';
    try {
      const { stdout } = await run(git(dir, 'annex whereis --json ' + quoteArg(result.name)));
      whereisOutput = stdout;
    } catch (err) {
      // git-annex errors for a file it does not track.
      result.reason = 'not-tracked';
      return result;
    }

    result.mode = annexState({ isPointer: false, whereisOutput });
    result.reason = 'whereis';
    return result;
  }

  // -- status bar -----------------------------------------------------------

  showStatus(label) {
    this.statusBarEl.setText(label);
    this.statusBarEl.style.display = '';
  }

  hideStatus() {
    this.statusBarEl.style.display = 'none';
  }

  applyMode(mode) {
    this.mode = mode;
    if (mode === 'load') this.showStatus(LABEL_LOAD);
    else if (mode === 'drop') this.showStatus(LABEL_DROP);
    else this.hideStatus();
  }

  /** Re-evaluate the open file and update the toggle. */
  async refreshStatus(file) {
    if (this.busy) return;
    const token = ++this.refreshToken;
    let result;
    try {
      result = await this.classify(file);
    } catch (err) {
      result = { mode: 'none' };
    }
    if (token !== this.refreshToken || this.busy) return;
    this.applyMode(result.mode);
  }

  // -- commands -------------------------------------------------------------

  /** The toggle: load the pointer, or free the real file, depending on state. */
  async toggleCurrentFile() {
    if (this.busy) return;
    const file = this.currentFile || this.app.workspace.getActiveFile();
    if (!file) {
      new Notice('Annex: no active file.');
      return;
    }

    const result = await this.classify(file);

    if (result.reason === 'no-vault') {
      new Notice('Annex: vault path could not be determined (desktop adapter expected).');
      return;
    }
    if (result.reason === 'not-git-repo') {
      new Notice('Annex: "' + file.path + '" is not inside a git repository.');
      return;
    }
    if (result.reason === 'not-annex-repo') {
      new Notice('Annex: "' + file.path + '" is not in a git-annex repository.');
      return;
    }
    if (result.reason === 'not-tracked') {
      new Notice('Annex: "' + file.path + '" is not tracked by git-annex.');
      return;
    }

    if (result.mode === 'load') {
      await this.loadFile(result);
    } else if (result.mode === 'drop') {
      await this.dropFile(result);
    } else {
      new Notice('Annex: nothing to do for "' + file.path + '" (not an annexed file, or the only copy).');
    }
  }

  async loadFile({ file, dir, name }) {
    this.busy = true;
    this.refreshToken += 1;
    this.showStatus(LABEL_LOADING);
    try {
      await run(git(dir, 'annex get ' + quoteArg(name)));
      this.loaded.add(file.path);
      new Notice('Annex: loaded "' + name + '".');
      await this.reloadFile(file);
    } catch (error) {
      const detail = describeError(error);
      const hint = looksUnreachable(detail) ? 'remote unreachable? ' : '';
      new Notice('Annex: load failed. ' + hint + detail, 12000);
    } finally {
      this.busy = false;
      await this.refreshStatus(this.app.workspace.getActiveFile());
    }
  }

  async dropFile({ file, dir, name }) {
    this.busy = true;
    this.refreshToken += 1;
    this.showStatus(LABEL_DROPPING);
    try {
      // Deliberately no --force: a refusal is the safety net, not an error.
      await run(git(dir, 'annex drop ' + quoteArg(name)));
      this.loaded.delete(file.path);
      new Notice('Annex: freed "' + name + '".');
      await this.reloadFile(file);
    } catch (error) {
      const detail = describeError(error);
      const hint = looksUnreachable(detail) ? 'remote unreachable? ' : '';
      new Notice('Annex: free refused. ' + hint + detail, 12000);
    } finally {
      this.busy = false;
      await this.refreshStatus(this.app.workspace.getActiveFile());
    }
  }

  async dropAllLoaded() {
    if (this.busy) return;

    const vaultPaths = Array.from(this.loaded);
    if (!vaultPaths.length) {
      new Notice('Annex: nothing has been loaded this session.');
      return;
    }

    const root = this.getVaultRoot();
    if (!root) {
      new Notice('Annex: vault path could not be determined (desktop adapter expected).');
      return;
    }

    // Group by folder so each repository/location is invoked once. Files from
    // different annex repositories are handled independently.
    const groups = new Map(); // dir -> { names: string[], paths: string[] }
    for (const p of vaultPaths) {
      const abs = path.join(root, p.split('/').join(path.sep));
      const dir = path.dirname(abs);
      const name = path.basename(abs);
      let group = groups.get(dir);
      if (!group) {
        group = { names: [], paths: [] };
        groups.set(dir, group);
      }
      group.names.push(name);
      group.paths.push(p);
    }

    this.busy = true;
    this.refreshToken += 1;
    this.showStatus(LABEL_DROPPING);

    let freed = 0;
    const errors = [];
    try {
      // No --force here either.
      for (const [dir, group] of groups) {
        try {
          await run(git(dir, 'annex drop ' + group.names.map(quoteArg).join(' ')));
          freed += group.names.length;
          for (const p of group.paths) this.loaded.delete(p);
        } catch (error) {
          errors.push(describeError(error));
        }
      }
    } finally {
      this.busy = false;
      await this.refreshStatus(this.app.workspace.getActiveFile());
    }

    if (!errors.length) {
      new Notice('Annex: freed ' + freed + ' file(s).');
    } else {
      const hint = looksUnreachable(errors.join(' ')) ? 'remote unreachable? ' : '';
      new Notice('Annex: freed ' + freed + ' file(s); some failed. ' + hint + errors[0], 12000);
    }
  }

  // -- reload ---------------------------------------------------------------

  async reloadFile(file) {
    const ext = (file.extension || '').toLowerCase();
    try {
      if (TEXT_EXTENSIONS.has(ext)) {
        // Re-read from disk and hand the same content back, which refreshes
        // Obsidian's in-memory cache for text views.
        const data = await this.app.vault.adapter.read(file.path);
        await this.app.vault.modify(file, data);
      } else {
        // Binary viewers (PDF, images) re-read from disk when re-opened.
        const leaf = this.app.workspace.getLeaf(false);
        if (leaf) await leaf.openFile(file, { active: true });
      }
    } catch (err) {
      // Never let a reload failure mask a successful annex operation.
      new Notice('Annex: annex action succeeded, but the view could not be refreshed: ' + describeError(err));
    }
  }
}

module.exports = ObsidianAnnexPlugin;

// The pure helpers are attached to the exported class so the test suite can
// reach them without a build step and without a second source file.
module.exports.POINTER_PREFIX = POINTER_PREFIX;
module.exports.HEAD_BYTES = HEAD_BYTES;
module.exports.isAnnexPointer = isAnnexPointer;
module.exports.readHeadSync = readHeadSync;
module.exports.isAnnexPointerFile = isAnnexPointerFile;
module.exports.STATE_LOAD = STATE_LOAD;
module.exports.STATE_DROP = STATE_DROP;
module.exports.STATE_NONE = STATE_NONE;
module.exports.parseWhereisJson = parseWhereisJson;
module.exports.hasRemoteCopy = hasRemoteCopy;
module.exports.annexState = annexState;
