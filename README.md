# Annex

[![Built with AI](https://img.shields.io/badge/built_with-AI-8A2BE2)](#built-with-ai)

Load and free [git-annex](https://git-annex.branchable.com/) content on demand,
from a single button in Obsidian's status bar.

## Why git-annex in an Obsidian vault?

Obsidian keeps your whole vault in a normal folder, and that folder quickly grows
past what you want on every machine. git-annex lets you version that folder in
git while storing the **large files** (PDFs, images, audio, video, datasets, …)
in a separate object store, synced to wherever you like — a home server, an
external drive, a cloud remote.

In an annexed repository, a large file that is *not* checked out on this machine
is replaced by a tiny **pointer file** whose content starts with:

```
/annex/objects/SHA256E-s123--abc.pdf
```

The file still appears in your vault (and in git), but it is only a stub. To read
it you first have to fetch it:

```sh
git annex get path/to/file.pdf     # download the content
git annex drop path/to/file.pdf    # delete the local copy again (keeps the remote)
```

That is exactly the workflow Annex automates. Instead of dropping to a
terminal, you open the file in Obsidian and click one button.

## How it works

Annex watches the file you open and shows a status-bar toggle whose
label and click action depend on that file's state:

| File state | Status bar shows | Click does |
| --- | --- | --- |
| **Pointer** (content starts with `/annex/objects/`) | `⬇ Annex: load` | `git annex get` — download and reload the view |
| **Real file**, and a copy exists on a remote | `⬆ Annex: free` | `git annex drop` — free the local copy |
| **Real file**, but it is the *only* copy | *(hidden)* | — |
| Not an annexed file at all | *(hidden)* | — |

How it decides: it reads only the first ~100 bytes of the file to spot a pointer.
For real files it runs `git annex whereis --json <file>` and offers *free* only
when a location other than `here` holds a copy. That is a **safety rule**: the
last copy is never offered for dropping, and `git annex drop` is **never** run
with `--force` — if git-annex refuses, the refusal is shown in a notice instead
of being worked around.

To find the repository the plugin does not need to know where it is: every git
command runs in the folder of the file you opened (`git -C <that folder> …`), and
git walks up the directory tree until it finds `.git`. So it works with a single
annex repository, with the vault itself being the repository, or with **several
annex repositories** (even ones outside the vault) — whichever repository the open
file belongs to is the one used.

If the file is not in a git repository, or the repository is not a git-annex
repository, or the file is not tracked by git-annex, clicking shows a clear
notice saying which of those it is.

While an action runs the item shows `⏳ Annex: loading…` / `⏳ Annex: freeing…`.
On failure you get a notice with the error text (plus a “remote unreachable?”
hint when the failure looks like a connection problem).

## Requirements

- **Obsidian desktop**, version 1.4.0 or newer. The plugin shells out to
  `git annex`, which needs Node's `child_process`; it is marked `isDesktopOnly`
  and will not run on mobile. See [Compatibility](#compatibility) for what that
  version bound is (and is not) based on.
- **`git` with the `git-annex` extension on your `PATH`.** `git annex whereis
  --json` must work (git-annex ≥ 5).
- A **git-annex repository** somewhere above the files you open — the vault
  folder itself, a subfolder, or a repository outside the vault. The plugin
  finds it per file, so you can have several in one vault (see
  [Configuration](#configuration)).

## Installation

Annex is not in the community-plugin directory yet, so install it
manually. Everything the plugin needs is two files, `main.js` and
`manifest.json`.

1. Download `main.js` and `manifest.json` from the latest release (or clone this
   repo).
2. Copy them into a new folder inside your vault:
   `<your-vault>/.obsidian/plugins/obsidian-annex/`.
3. In Obsidian, open **Settings → Community plugins**, turn off *Restricted
   mode* if it is on, and enable **Annex**.

Because the plugin is not in the directory yet, it will also show up in the
**Community plugins → Browse** list only after it is added there. To install
from a git URL or a release without copying files by hand, you can use
[BRAT](https://github.com/TfTHacker/obsidian42-brat): add this repository as a
beta plugin and BRAT will keep it up to date.

If you prefer a script, `install.ps1` copies `manifest.json` and `main.js` into
the plugin folder for you (Windows / PowerShell):

```powershell
.\install.ps1 -VaultRoot "D:\MyVault"
```

### Manual, step by step

The plugin folder must be named exactly `obsidian-annex`:

```
<your-vault>/.obsidian/plugins/obsidian-annex/manifest.json
<your-vault>/.obsidian/plugins/obsidian-annex/main.js
```

> **Why is it a single file?** Obsidian loads plugins inside an Electron
> renderer, where a relative `require('./something.js')` cannot be resolved — a
> split plugin fails to load with `Cannot find module './something.js'`.
> `main.js` is therefore deliberately self-contained; there is no build step.

## Configuration

There is **nothing to configure.** An earlier version asked for the annex
repository path; the plugin now discovers the repository per file with git
itself, so any layout works — the vault as the repository, a subfolder, several
repositories side by side, or a repository that lives outside the vault.

If a `data.json` with an old `annexRepoPath` key is left in the plugin folder
from an earlier version, it is simply ignored.

## Commands

Available from the command palette (`Ctrl/Cmd+P`):

| Command | What it does |
| --- | --- |
| *Toggle load/free for the current file* | Same context logic as the status-bar click, applied to the active file. No path prompt. |
| *Free every file loaded this session* | `git annex drop` on every file loaded during this session (kept in an in-memory list). |

## Known limitations

- **PDF (and other binary) viewers show an error on pointer files.** When a file
  is a pointer, its viewer tries to open the tiny text stub as a PDF/image and
  fails. Load the file (status bar → `⬇ Annex: load`) and the viewer works; after
  a *free*, the file becomes a pointer again, so the viewer shows the stub until
  it is loaded again.
- The loaded-files list is **in-memory only**; reloading Obsidian forgets it (by
  design — it describes the current session).
- Deciding whether a real file can be freed costs one `git annex whereis --json`
  call per opened real file.
- If a viewer still shows stale bytes after a load/free, close and reopen the
  file.
- `git` and `git annex` must be on the `PATH` of the process that runs Obsidian.

## Development

No build step, no dependencies. The plugin is `main.js`; the tests run under
plain Node with `require('obsidian')` redirected to a stub.

```sh
node --check main.js                          # syntax check
node test/pointer-detect.test.js              # pointer detection
node test/annex-state.test.js                 # load / drop / none mapping
```

## Built with AI

This plugin was built with AI (Letta Code & DeepSeek). I use it myself to
handle my second-brain annex — it is not battle-tested by a wide user base.
Open for feature requests, issues and bug reports.

## Compatibility

`minAppVersion` is set to **1.4.0**. Every Obsidian API this plugin uses exists
in 1.4.0 with matching signatures — verified against the type definitions in
[`obsidianmd/obsidian-api`](https://github.com/obsidianmd/obsidian-api) at
commit `90517f4` ("Release for 1.4.0").

The earliest API-repo commit that contains every API used here is `06510d0`
(v0.9.11, 2020-11-08), so 1.4.0 is a conservative bound rather than a measured
minimum. Development and testing happened on **1.14.4**.

If you run it on an older version — whether it works or not — please
[open an issue](https://github.com/rapus95/obsidian-annex/issues). That tells us
whether the bound can be lowered, or has to be raised.

## License

[MIT](LICENSE) © rapus95
