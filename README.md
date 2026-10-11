# Annex Bridge

An Obsidian plugin that loads **and frees** git-annex content on demand.

The vault is `C:\Users\Aaron\Assistant\`; the git-annex repository is the
`brain/` subfolder. Files whose content is only a small git-annex *pointer*
(their content starts with `/annex/objects/`) are not present on disk until they
are fetched. Annex Bridge gives you a single status-bar **toggle** that always
does the right thing for the file you are looking at.

## The toggle

One status-bar item, whose label and click action depend on the open file:

| File state | Status bar shows | Click does |
| --- | --- | --- |
| **Pointer** (content starts with `/annex/objects/`) | `⬇ Annex: laden` | `git annex get` — fetch and reload |
| **Real file**, and a copy exists on a remote (Raspi) | `⬆ Annex: freigeben` | `git annex drop` — free the local copy |
| **Real file**, but it is the *only* copy | *(hidden)* | — |
| Not an annexed file at all | *(hidden)* | — |

How it decides: the plugin reads only the first ~100 bytes of the file to spot a
pointer; for real files it asks
`git annex whereis --json <path>` and offers *freigeben* only when a location
other than `here` holds a copy. That is a **safety rule**: the last copy is never
offered for dropping, and `git annex drop` is **never** run with `--force` — if
git-annex refuses, the refusal is shown in a `Notice` instead of being worked
around.

While an action runs, the item shows `⏳ Annex: lädt …` / `⏳ Annex: gibt frei …`.
On failure you get a `Notice` with the error (including a “Raspi nicht
erreichbar?” hint when the failure looks like an unreachable remote).

## Commands

Available in the command palette (`Ctrl+P`):

| Command | What it does |
| --- | --- |
| `Annex: umschalten (laden/freigeben)` | Same context logic as the status-bar click, on `app.workspace.getActiveFile()`. No path prompt. |
| `Annex: alle geladenen freigeben` | `git annex drop` on every file loaded during this session (kept in an in-memory list). |

## Install

Run the helper script from a PowerShell prompt (idempotent — safe to re-run):

```powershell
.\install.ps1
```

It copies the self-contained `manifest.json` and `main.js` into
`C:\Users\Aaron\Assistant\.obsidian\plugins\annex-bridge\` (creating the folder
if needed), and removes a stale `pointer.js` left by older versions. Override
the defaults if your vault lives elsewhere:

```powershell
.\install.ps1 -VaultRoot "D:\Vault"
```

Then enable **Annex Bridge** in *Settings → Community plugins* (turn off
restricted mode if necessary).

### Manual install

Copy `manifest.json` and `main.js` into
`<vault>\.obsidian\plugins\annex-bridge\`.

> **Why one file?** Obsidian loads plugins inside an Electron renderer
> (`electron/js2c/renderer_init`), where a relative `require('./pointer.js')`
> cannot be resolved — a split plugin fails to load with
> `Cannot find module './pointer.js'`. `main.js` is therefore deliberately
> self-contained; the pure helpers are exported off its class for the tests.

## Requirements

- Obsidian **desktop** (the plugin uses Node's `child_process`; `isDesktopOnly`
  is `true`).
- `git` with the **git-annex** extension on `PATH`. `git annex whereis --json`
  is required (git-annex ≥ 5; verified on 10.20261006).
- The vault contains a `brain/` directory that is a git-annex repository. If it
  is not, the plugin shows a clear `Notice` instead of failing silently.

## Files

```
annex-bridge/
├── manifest.json            Obsidian plugin manifest
├── main.js                  the whole plugin: self-contained, no build step,
│                            no relative require (pointer detection +
│                            action-state mapping + the Plugin class)
├── install.ps1              installs into the vault's plugins folder
└── test/
    ├── pointer-detect.test.js   standalone Node test — is this a pointer?
    ├── annex-state.test.js      standalone Node test — load / drop / none
    ├── load-plugin.js           requires main.js under the obsidian stub
    ├── stubs/obsidian.js        minimal `obsidian` stand-in for Node
    └── fixtures/
        ├── pointer.pdf          a real pointer file
        └── real.txt             ordinary content
```

## Tests

No Obsidian needed. The tests load the *real* `main.js` with `require('obsidian')`
redirected to `test/stubs/obsidian.js`, so they also guard that the plugin stays
a single self-contained file:

```powershell
node --check main.js                          # syntax check
node test\pointer-detect.test.js              # detection
node test\annex-state.test.js                 # load/drop/none mapping
```

`annexState({ isPointer, whereisOutput })` is a pure function, so the four states
above are covered without a repository, a remote, or a network. The tests also
prove the detection predicate fails on real content and passes on a pointer.

## Notes / limitations

- The loaded-files list is in-memory only; reloading Obsidian forgets it (by
  design — it describes *this session*).
- Deciding *freigeben* costs one `git annex whereis --json` call per opened real
  file.
- Binary viewers (PDF, images) are refreshed by re-opening the leaf; after a
  `drop` the file becomes a pointer again, so a viewer will show it as such
  until it is loaded again.
- If a viewer still shows stale bytes, close and reopen the file.
