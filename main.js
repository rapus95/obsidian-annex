'use strict';

/**
 * Obsidian Annex — an Obsidian plugin that loads and frees git-annex content.
 *
 * SINGLE FILE ON PURPOSE. Obsidian runs plugins inside an Electron renderer
 * (`electron/js2c/renderer_init`), where a relative `require('./pointer.js')`
 * cannot be resolved. Everything the plugin needs therefore lives in this file;
 * the pure helpers at the top are also hung off the exported class so the test
 * suite can exercise them without a build step.
 *
 * The git-annex repository may be the vault itself or any folder inside it
 * (configured under Settings → Obsidian Annex). Paths are resolved from the
 * vault root at runtime, so nothing here depends on where the vault lives.
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

const { Plugin, PluginSettingTab, Setting, Notice } = require('obsidian');
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

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Default settings for a fresh install. */
const DEFAULT_SETTINGS = {
  /**
   * Where the git-annex repository lives. Empty means "the vault root itself".
   * A relative value (e.g. `annex`, `media`, `brain`) is resolved against the
   * vault root; an absolute path is used as-is.
   */
  annexRepoPath: '',
};

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

class ObsidianAnnexPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

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

    this.addSettingTab(new ObsidianAnnexSettingTab(this.app, this));

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

  // -- settings -------------------------------------------------------------

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // -- paths ----------------------------------------------------------------

  getVaultRoot() {
    const adapter = this.app.vault.adapter;
    if (adapter && typeof adapter.getBasePath === 'function') {
      return adapter.getBasePath();
    }
    return adapter && adapter.basePath;
  }

  /**
   * Absolute path of the git-annex repository, derived from the setting and the
   * vault root. Returns null when no vault root can be determined and the
   * setting is not absolute.
   */
  getAnnexRepo() {
    const root = this.getVaultRoot();
    const configured = String(this.settings && this.settings.annexRepoPath || '').trim();
    if (path.isAbsolute(configured)) return configured;
    if (!root) return null;
    return configured ? path.join(root, configured) : root;
  }

  /** Human-readable form of the configured repository, for notices. */
  describeRepo() {
    const configured = String(this.settings && this.settings.annexRepoPath || '').trim();
    return configured || '(vault root)';
  }

  absolutePath(file) {
    const root = this.getVaultRoot();
    return path.join(root, file.path.split('/').join(path.sep));
  }

  /** Path of `absPath` relative to `repo`, in forward slashes; null if outside. */
  repoRelativePath(absPath, repo) {
    const rel = path.relative(repo, absPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join('/');
  }

  // -- classification -------------------------------------------------------

  /**
   * Inspect `file` and decide which action applies. Quiet: never raises a
   * Notice, never throws. Returns `{ mode, reason, file, repo, rel }`.
   */
  async classify(file) {
    const result = { mode: 'none', reason: 'no-file', file: null, repo: null, rel: null };
    if (!file) return result;
    result.file = file;

    const repo = this.getAnnexRepo();
    if (!repo) {
      result.reason = 'no-vault';
      return result;
    }

    if (!fs.existsSync(path.join(repo, '.git'))) {
      result.reason = 'not-annex-repo';
      return result;
    }
    result.repo = repo;

    const abs = this.absolutePath(file);
    result.rel = this.repoRelativePath(abs, repo);
    if (!result.rel) {
      result.reason = 'outside-repo';
      return result;
    }

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

    // Real content on disk: a remote copy means it is safe to free locally.
    let whereisOutput = '';
    try {
      const { stdout } = await run('git annex whereis --json ' + quoteArg(result.rel), repo);
      whereisOutput = stdout;
    } catch (err) {
      whereisOutput = '';
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
      new Notice('Obsidian Annex: no active file.');
      return;
    }

    const result = await this.classify(file);

    if (result.reason === 'no-vault') {
      new Notice('Obsidian Annex: vault path could not be determined (desktop adapter expected).');
      return;
    }
    if (result.reason === 'not-annex-repo') {
      new Notice('Obsidian Annex: ' + this.describeRepo() + ' is not a git-annex repository (no .git found). Set the path in Settings → Obsidian Annex.');
      return;
    }
    if (result.reason === 'outside-repo') {
      new Notice('Obsidian Annex: "' + file.path + '" is outside the annex repository (' + this.describeRepo() + ').');
      return;
    }

    if (result.mode === 'load') {
      await this.loadFile(result);
    } else if (result.mode === 'drop') {
      await this.dropFile(result);
    } else {
      new Notice('Obsidian Annex: nothing to do for "' + file.path + '" (not an annexed file, or the only copy).');
    }
  }

  async loadFile({ file, repo, rel }) {
    this.busy = true;
    this.refreshToken += 1;
    this.showStatus(LABEL_LOADING);
    try {
      await run('git annex get ' + quoteArg(rel), repo);
      this.loaded.add(file.path);
      new Notice('Obsidian Annex: loaded "' + rel + '".');
      await this.reloadFile(file);
    } catch (error) {
      const detail = describeError(error);
      const hint = looksUnreachable(detail) ? 'remote unreachable? ' : '';
      new Notice('Obsidian Annex: load failed. ' + hint + detail, 12000);
    } finally {
      this.busy = false;
      await this.refreshStatus(this.app.workspace.getActiveFile());
    }
  }

  async dropFile({ file, repo, rel }) {
    this.busy = true;
    this.refreshToken += 1;
    this.showStatus(LABEL_DROPPING);
    try {
      // Deliberately no --force: a refusal is the safety net, not an error.
      await run('git annex drop ' + quoteArg(rel), repo);
      this.loaded.delete(file.path);
      new Notice('Obsidian Annex: freed "' + rel + '".');
      await this.reloadFile(file);
    } catch (error) {
      const detail = describeError(error);
      const hint = looksUnreachable(detail) ? 'remote unreachable? ' : '';
      new Notice('Obsidian Annex: free refused. ' + hint + detail, 12000);
    } finally {
      this.busy = false;
      await this.refreshStatus(this.app.workspace.getActiveFile());
    }
  }

  async dropAllLoaded() {
    if (this.busy) return;

    const repo = this.getAnnexRepo();
    if (!repo || !fs.existsSync(path.join(repo, '.git'))) {
      new Notice('Obsidian Annex: ' + this.describeRepo() + ' is not a git-annex repository (no .git found). Set the path in Settings → Obsidian Annex.');
      return;
    }

    const vaultPaths = Array.from(this.loaded);
    if (!vaultPaths.length) {
      new Notice('Obsidian Annex: nothing has been loaded this session.');
      return;
    }

    const root = this.getVaultRoot();
    const rels = [];
    for (const p of vaultPaths) {
      const rel = this.repoRelativePath(path.join(root, p.split('/').join(path.sep)), repo);
      if (rel) rels.push(rel);
    }
    if (!rels.length) {
      new Notice('Obsidian Annex: no files can be freed.');
      return;
    }

    this.busy = true;
    this.refreshToken += 1;
    this.showStatus(LABEL_DROPPING);
    try {
      // No --force here either.
      await run('git annex drop ' + rels.map(quoteArg).join(' '), repo);
      this.loaded.clear();
      new Notice('Obsidian Annex: freed ' + rels.length + ' file(s).');
    } catch (error) {
      const detail = describeError(error);
      const hint = looksUnreachable(detail) ? 'remote unreachable? ' : '';
      new Notice('Obsidian Annex: free refused. ' + hint + detail, 12000);
    } finally {
      this.busy = false;
      await this.refreshStatus(this.app.workspace.getActiveFile());
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
      new Notice('Obsidian Annex: annex action succeeded, but the view could not be refreshed: ' + describeError(err));
    }
  }
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

class ObsidianAnnexSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Obsidian Annex' });

    new Setting(containerEl)
      .setName('Annex repository path')
      .setDesc(
        'Folder holding the git-annex repository, relative to the vault root ' +
          '(for example "annex" or "media"). Leave empty if the vault itself is ' +
          'the annex repository. Absolute paths are also accepted.'
      )
      .addText((text) =>
        text
          .setPlaceholder('(vault root)')
          .setValue(this.plugin.settings.annexRepoPath)
          .onChange(async (value) => {
            this.plugin.settings.annexRepoPath = value.trim();
            await this.plugin.saveSettings();
            this.plugin.refreshStatus(this.app.workspace.getActiveFile());
          })
      );
  }
}

/** Shell-quote a single argument for `exec` (Windows and POSIX friendly). */
function quoteArg(value) {
  return '"' + String(value).replace(/"/g, '\\"') + '"';
}

/** Run a command through the shell and resolve with its output. */
function run(command, cwd) {
  return new Promise((resolve, reject) => {
    exec(command, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
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
module.exports.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
