# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-11

First release.

### Added

- Status-bar toggle that loads a git-annex pointer file (`git annex get`) or
  frees the local copy of a real file (`git annex drop`), depending on the file
  that is open.
- Per-file repository resolution: commands run in the folder of the opened file,
  so git finds the nearest repository by walking up the tree. Works with the
  vault as the repository, a subfolder, several annex repositories in one vault,
  or a repository outside the vault — no configuration needed.
- Pointer detection by reading only the first ~100 bytes of a file, so large
  annexed objects are never read into memory.
- State detection via `git annex whereis --json`: *free* is offered only when a
  location other than `here` holds a copy, so the last copy is never offered for
  dropping.
- Session list of files loaded during the current session, with a
  "Free every file loaded this session" command.
- Distinct notices when a file is not inside a git repository, not in a
  git-annex repository, or not tracked by git-annex.

### Notes

- `git annex drop` is never run with `--force`; a refusal from git-annex is
  surfaced in a notice instead of being worked around.
- Desktop only: the plugin uses Node's `child_process` and requires `git` with
  the git-annex extension on `PATH`.

[0.1.0]: https://github.com/rapus95/obsidian-annex/releases/tag/0.1.0
