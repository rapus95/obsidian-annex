# Annex Bridge

An Obsidian plugin that loads **git-annex** pointer files on demand.

The vault is `C:\Users\Aaron\Assistant\`; the git-annex repository is the
`brain/` subfolder. Files whose content is only a small git-annex *pointer*
(their content starts with `/annex/objects/`) are not present on disk until they
are fetched. Annex Bridge watches for those files and offers a one-click way to
materialise them.

## What it does

- **Detects pointers.** When you open a file that is a git-annex pointer, a
  status-bar item appears at the bottom: **`⬇ Annex: laden`**. Real content
  (non-pointers) leaves the status bar hidden. The plugin only reads the first
  ~100 bytes of a file, never the whole thing.
- **Loads on click.** Clicking the status-bar item runs
  `git annex get "<relative-path>"` inside `brain/` and then reloads the file so
  the real content shows up.
- **Progress + errors.** While loading, the item shows `⏳ Annex: lädt …`. On
  failure you get an Obsidian `Notice` with the error (including a
  “Raspi nicht erreichbar?” hint when the failure looks like an unreachable
  remote).
- **Free the disk again.** Everything loaded in the current session is tracked in
  memory; the *Annex: geladene Dateien freigeben* command drops all of it.

## Commands

Both are available in the command palette (`Ctrl+P`):

| Command | What it does |
| --- | --- |
| `Annex: aktuelle Datei laden` | `git annex get` on `app.workspace.getActiveFile()` and reload it. No path prompt. |
| `Annex: geladene Dateien freigeben` | `git annex drop` on every file loaded during this session. |

## Install

Run the helper script from a PowerShell prompt (idempotent — safe to re-run):

```powershell
.\install.ps1
```

It copies `manifest.json`, `main.js` and `pointer.js` into
`C:\Users\Aaron\Assistant\.obsidian\plugins\annex-bridge\` (creating the folder
if needed). Override the defaults if your vault lives elsewhere:

```powershell
.\install.ps1 -VaultRoot "D:\Vault"
```

Then enable **Annex Bridge** in *Settings → Community plugins* (turn off
restricted mode if necessary).

### Manual install

Copy `manifest.json`, `main.js` and `pointer.js` into
`<vault>\.obsidian\plugins\annex-bridge\`.

## Requirements

- Obsidian **desktop** (the plugin uses Node's `child_process`; `isDesktopOnly`
  is `true`).
- `git` with the **git-annex** extension on `PATH`.
- The vault contains a `brain/` directory that is a git-annex repository. If it
  is not, the plugin shows a clear `Notice` instead of failing silently.

## Files

```
annex-bridge/
├── manifest.json            Obsidian plugin manifest
├── main.js                  plugin entry point (plain JS, no build step)
├── pointer.js               git-annex pointer detection (dep-free, unit-tested)
├── install.ps1              installs into the vault's plugins folder
├── test/
│   ├── pointer-detect.test.js   standalone Node test
│   └── fixtures/
│       ├── pointer.pdf          a real pointer file
│       └── real.txt             ordinary content
└── README.md
```

## Tests

No Obsidian needed:

```powershell
node --check main.js                     # syntax check
node test\pointer-detect.test.js         # detection unit test
```

The detection test proves the predicate **fails on real content and passes on a
pointer**, both for in-memory strings and for on-disk fixtures.

## Notes / limitations

- The loaded-files list is in-memory only; reloading Obsidian forgets it (by
  design — it describes *this session*).
- Binary viewers (PDF, images) are refreshed by re-opening the leaf; if a viewer
  still shows stale bytes, close and reopen the file.
