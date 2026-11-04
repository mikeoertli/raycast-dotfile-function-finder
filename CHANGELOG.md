# Changelog

Project versions use semantic versioning. `package.json` is the version source; `package-lock.json` is kept in sync by npm. Record user-visible changes here before releasing a new version.

## [Unreleased]

## [0.1.0] - 2026-11-04

### Added

- Case-insensitive fuzzy search across alias names, function names, script filenames, and complete definitions or script contents.
- Separator-insensitive fuzzy matching and an exact whole-name search mode.
- Separate dotfile path and script directory preferences, with recursive scanning and symlink handling.
- Result labels for aliases, glob aliases (`alias -g`, Zsh global aliases), suffix aliases, functions, and scripts.
- Source previews, copying names or contents, and opening source with `VISUAL`, falling back to `EDITOR`.
- Pages of 200 results, full-index counts, scan summaries, and scan warnings.
- Portable installation and live-development scripts with colored status messages and emoji.
- A custom project icon shared by Raycast and the README header.
- Version metadata and this changelog.

### Changed

- Documentation and default preferences use portable examples instead of machine-specific repository locations.
