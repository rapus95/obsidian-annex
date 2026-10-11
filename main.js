'use strict';

/**
 * Annex Bridge — an Obsidian plugin that loads git-annex pointer files on demand.
 *
 * The vault root is the Obsidian vault (e.g. C:\Users\Aaron\Assistant). The
 * git-annex repository lives in the `brain/` subfolder of that vault. When a
 * file that is a git-annex pointer is opened, a status-bar item appears;
 * clicking it (or running the "Annex: aktuelle Datei laden" command) fetches the
 * real content with `git annex get` and reloads the file.
 *
 * Plain JavaScript, no build step — Obsidian loads this file directly.
 */

const { Plugin, Notice } = require('obsidian');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const { isAnnexPointerFile } = require('./pointer.js');

/** Name of the git-annex repository relative to the vault root. */
const ANNEX_DIR = 'brain';

/** Status bar labels. */
const LABEL_IDLE = '⬇ Annex: laden';
const LABEL_BUSY = '⏳ Annex: lädt …';

/**
 * Extensions we are confident can be re-written through the vault API without
 * corrupting bytes. Anything else (PDF, images, …) is reloaded by re-opening
 * the leaf instead, so the viewer re-reads the now-materialised file from disk.
 */
const TEXT_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'json', 'canvas', 'base', 'csv', 'html', 'htm',
  'css', 'js', 'ts', 'yaml', 'yml',
]);

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
  return detail || 'unbekannter Fehler';
}

/** Does the failure look like the annex remote (the Raspi) being unreachable? */
function looksUnreachable(text) {
  return /ssh|connect|connection|unreachable|timed? ?out|network|no route|host key|host is down|refused/i
    .test(String(text));
}

module.exports = class AnnexBridgePlugin extends Plugin {
  async onload() {
    this.loaded = new Set();   // vault-relative paths loaded during this session
    this.busy = false;
    this.currentFile = null;

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass('annex-bridge-status');
    this.statusBarEl.style.cursor = 'pointer';
    this.statusBarEl.addEventListener('click', () => this.loadCurrentFile());
    this.hideStatus();

    this.addCommand({
      id: 'annex-load-current-file',
      name: 'Annex: aktuelle Datei laden',
      callback: () => this.loadCurrentFile(),
    });

    this.addCommand({
      id: 'annex-drop-loaded-files',
      name: 'Annex: geladene Dateien freigeben',
      callback: () => this.dropLoadedFiles(),
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

  /** Absolute path of the annex repository, or null when it is not one. */
  resolveAnnexRepo() {
    const root = this.getVaultRoot();
    if (!root) {
      new Notice('Annex Bridge: Vault-Pfad konnte nicht ermittelt werden (Desktop-Adapter erwartet).');
      return null;
    }
    const repo = path.join(root, ANNEX_DIR);
    if (!fs.existsSync(path.join(repo, '.git'))) {
      new Notice('Annex Bridge: ' + ANNEX_DIR + '/ ist kein git-annex-Repository (kein .git gefunden).');
      return null;
    }
    return repo;
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

  // -- status bar -----------------------------------------------------------

  showStatus(label) {
    this.statusBarEl.setText(label);
    this.statusBarEl.style.display = '';
  }

  hideStatus() {
    this.statusBarEl.style.display = 'none';
  }

  refreshStatus(file) {
    if (this.busy) return;
    if (!file) {
      this.hideStatus();
      return;
    }
    const root = this.getVaultRoot();
    if (!root) {
      this.hideStatus();
      return;
    }
    const abs = this.absolutePath(file);
    let pointer = false;
    try {
      pointer = fs.existsSync(abs) && isAnnexPointerFile(abs);
    } catch (err) {
      pointer = false;
    }
    if (pointer) {
      this.showStatus(LABEL_IDLE);
    } else {
      this.hideStatus();
    }
  }

  // -- commands -------------------------------------------------------------

  async loadCurrentFile() {
    if (this.busy) return;
    const file = this.currentFile || this.app.workspace.getActiveFile();
    if (!file) {
      new Notice('Annex Bridge: keine aktive Datei.');
      return;
    }
    const root = this.getVaultRoot();
    if (root) {
      const abs = this.absolutePath(file);
      let pointer = false;
      try {
        pointer = fs.existsSync(abs) && isAnnexPointerFile(abs);
      } catch (err) {
        pointer = false;
      }
      if (!pointer) {
        new Notice('Annex Bridge: „' + file.path + '" ist keine git-annex-Pointer-Datei.');
        return;
      }
    }
    await this.loadFile(file);
  }

  async loadFile(file) {
    const repo = this.resolveAnnexRepo();
    if (!repo) return;

    const abs = this.absolutePath(file);
    const rel = this.repoRelativePath(abs, repo);
    if (!rel) {
      new Notice('Annex Bridge: „' + file.path + '" liegt außerhalb von ' + ANNEX_DIR + '/.');
      return;
    }

    this.busy = true;
    this.showStatus(LABEL_BUSY);

    try {
      await run('git annex get ' + quoteArg(rel), repo);
      this.loaded.add(file.path);
      new Notice('Annex Bridge: „' + rel + '" geladen.');
      await this.reloadFile(file);
    } catch (error) {
      const detail = describeError(error);
      const hint = looksUnreachable(detail) ? 'Raspi nicht erreichbar? ' : '';
      new Notice('Annex Bridge: Laden fehlgeschlagen. ' + hint + detail, 10000);
    } finally {
      this.busy = false;
      this.refreshStatus(this.app.workspace.getActiveFile());
    }
  }

  async dropLoadedFiles() {
    if (this.busy) return;
    const repo = this.resolveAnnexRepo();
    if (!repo) return;

    const vaultPaths = Array.from(this.loaded);
    if (!vaultPaths.length) {
      new Notice('Annex Bridge: in dieser Sitzung wurde noch nichts geladen.');
      return;
    }

    const root = this.getVaultRoot();
    const rels = [];
    for (const p of vaultPaths) {
      const rel = this.repoRelativePath(path.join(root, p.split('/').join(path.sep)), repo);
      if (rel) rels.push(rel);
    }
    if (!rels.length) {
      new Notice('Annex Bridge: keine freigebbaren Dateien.');
      return;
    }

    this.busy = true;
    try {
      await run('git annex drop ' + rels.map(quoteArg).join(' '), repo);
      this.loaded.clear();
      new Notice('Annex Bridge: ' + rels.length + ' Datei(en) freigegeben.');
    } catch (error) {
      const detail = describeError(error);
      const hint = looksUnreachable(detail) ? 'Raspi nicht erreichbar? ' : '';
      new Notice('Annex Bridge: Freigeben fehlgeschlagen. ' + hint + detail, 10000);
    } finally {
      this.busy = false;
      this.refreshStatus(this.app.workspace.getActiveFile());
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
      // Never let a reload failure mask a successful `git annex get`.
      new Notice('Annex Bridge: Datei geladen, Ansicht konnte nicht aktualisiert werden: ' + describeError(err));
    }
  }
};
