# Change Log

All notable changes to the "angular-cli-plus" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [1.3.0]

### Added

- **Failure notifications with retry** — terminal commands (build, lint, test without watch, generate) now detect the exit code when the terminal closes. On success a brief info notification is shown; on failure a warning notification appears with a **Retry** button that re-runs the exact same command automatically
- **Angular: Debug Storybook** (`Ctrl+Shift+A K`): detects Storybook from `angular.json` architect targets (`ng run project:storybook`) or falls back to the `storybook` npm script; starts Storybook, waits for the port to be ready, then attaches a browser debugger. Supports multiple projects via a quick pick
- **Angular: Debug Build (Watch)** (`Ctrl+Shift+A H`): runs `ng build --watch` alongside a configurable static file server (default: `npx serve`), waits for the server to be ready, then attaches a browser debugger; both terminals are stopped when the debug session ends. Output path is read automatically from `angular.json` with support for both Angular 17+ object format and older string format
- **Debug restart re-attach** — `Ctrl+Shift+A R` now works for all debug sessions (Angular serve, Storybook, Build Watch). It stops the existing debug session cleanly, restarts the terminal, and re-attaches the debugger automatically. The restart quick pick shows a `$(debug) debug session active` badge on entries that have a live debug session
- **Multi-browser debug support** — the `angularCliPlus.debug.browser` setting now accepts `brave`, `opera`, `opera-gx`, `firefox`, and `safari` in addition to `chrome` and `edge`. Chromium-based browsers (Brave, Opera, Opera GX) are detected from their standard install paths. Firefox requires the **"Debugger for Firefox"** VS Code extension; Safari requires the **"Safari Debugger"** VS Code extension and is macOS-only
- **Last used project memory** — every command that shows a project picker now remembers the last selected project per command, persisted across sessions. The picker shows `$(history) Last used (name)` as the second option (after the current-file project shortcut). Separate memory is kept for: Serve, Build, Build Watch, Lint, Debug, Debug Build Watch, Test, and Debug Storybook
- **Angular CLI Plus: Clear Finished Terminals** (`Ctrl+Shift+A C`): closes all extension-managed terminals whose process has finished but whose panel is still open. Shows an info message if there is nothing to close
- New settings:
  - `angularCliPlus.debug.browserExecutablePath` — custom path to the browser executable, overrides automatic detection (useful for non-standard installs or other Chromium-based browsers such as Vivaldi or Arc)
  - `angularCliPlus.storybook.port` — port Storybook runs on; `0` means auto-detect from `angular.json` or use the default `6006`
  - `angularCliPlus.buildWatch.servePort` — port the static file server listens on during a Debug Build Watch session (default: `4201`)
  - `angularCliPlus.buildWatch.staticServerCommand` — fully configurable static server command; use `{outputPath}` and `{port}` as placeholders (default: `npx serve {outputPath} -l {port}`)

### Changed

- Schematics generator (`ng generate`) no longer shows a pre-emptive "Generating…" notification; instead it shows a success notification once the terminal exits with code 0
- `Angular: Restart Serve` now accepts and propagates `ExtensionContext` internally to support debug session re-attach

## [1.2.0]

### Added

- **Angular: Lint Project** (`Ctrl+Shift+A L`): runs `ng lint` for a selected project in a dedicated terminal
- **Angular: Update Packages** (`Ctrl+Shift+A U`): runs `ng update`, parses available package updates, shows a multi-select list to choose which packages to update, then streams the update output to the "Angular CLI Plus: ng" output channel; offers a `--force` retry on failure
- **Current project shortcut** in all project pickers: when an editor tab is open, a "Current project (name)" option appears at the top of the list for Serve, Debug, Build, Build Watch, Lint, and Test commands — detected automatically from the active file's path against `angular.json` roots (Test shows it as the second option, after "Run current test file")
- **Angular CLI Plus: Check Dependencies** command: manual trigger to run the dependency check for a selected workspace folder — same logic as the automatic startup check
- **Angular CLI Plus: Check Tool Versions** command: manually triggers the tool version check for a selected workspace folder
- **Tool version check**: on startup the extension reads the `engines` field from `package.json` and verifies that the installed versions of Node.js, npm, yarn, and pnpm satisfy the declared ranges; if a tool is missing and can be installed via npm it is installed automatically; if a version mismatch is found an "Update" button is offered alongside a link to the tool's download page; can be disabled with `angularCliPlus.checkToolVersions.enabled`
- New settings:
  - `angularCliPlus.update.allowDirty` — pass `--allow-dirty` to `ng update` when the working tree has uncommitted changes (default: `false`)
  - `angularCliPlus.npm.installCommand` — custom command for **npm: Install** (e.g. `yarn install`); replaces the default `npm install` flow when set (default: `""`)
  - `angularCliPlus.npm.cleanInstallCommand` — custom command for **npm: Clean Install** (e.g. `yarn install --frozen-lockfile`); replaces the default clean flow when set (default: `""`)
  - `angularCliPlus.checkToolVersions.enabled` — run the tool version check on startup (default: `true`)

### Changed

- All keyboard shortcuts updated from `Ctrl+A {key}` to `Ctrl+Shift+A {key}` to avoid conflicts with the standard Select All binding
- Dependency check now respects `angularCliPlus.checkDependencies.enabled` at startup — the initial check is skipped when the setting is disabled
- Toggling `angularCliPlus.checkDependencies.enabled` to `true` immediately triggers a dependency check; toggling to `false` cancels any pending check

### Fixed

- Output channels (`Angular CLI Plus: npm`, `Angular CLI Plus: ng`) are now properly disposed when the extension deactivates
- Pending debounced dependency-check timeouts are now cleared on extension deactivation

## [1.1.0]

### Added

- **Angular Serve** (`Ctrl+A S`): runs `ng serve` for a selected project in a dedicated terminal
- **Angular Debug** (`Ctrl+A D`): starts `ng serve`, waits for the dev server to become ready, then automatically attaches a browser debugger (Chrome or Edge, configurable via `angularCliPlus.debug.browser`); the serve terminal is cleaned up when the debug session ends
- **Angular Build** (`Ctrl+A B`): runs `ng build` for a selected project with a configurable build configuration (`angularCliPlus.build.configuration`)
- **Angular Build (Watch)** (`Ctrl+A W`): runs `ng build --watch` with a separate configurable configuration (`angularCliPlus.watch.configuration`, which can also inherit from the build setting)
- **Angular Test** (`Ctrl+A T`): runs `ng test` for a selected project; supports an "All projects" option, a "Run current test file" shortcut when a `.spec.ts` file is active, watch mode (`angularCliPlus.test.watch`), and Vitest UI (`angularCliPlus.test.ui`)
- **Angular Restart Serve** (`Ctrl+A R`): gracefully restarts any active `ng serve` or `ng build --watch` terminal tracked by the extension
- **npm: Install**: runs `npm install` and streams output to a dedicated "Angular CLI Plus: npm" output channel; on failure offers a "Run Clean Install" fallback
- **npm: Clean Install**: removes `node_modules` and `package-lock.json`, then runs `npm install`; on failure offers a "Run with --force" fallback
- **Dependency check**: on startup and on every git branch change the extension checks whether `node_modules` is present and whether installed package versions satisfy `package.json` ranges; prompts to run `npm install` when problems are found; can be disabled with `angularCliPlus.checkDependencies.enabled`
- New keyboard shortcuts for all Angular CLI commands (`Ctrl+A D/S/B/R/W/T`)
- New settings: `angularCliPlus.debug.browser`, `angularCliPlus.build.configuration`, `angularCliPlus.watch.configuration`, `angularCliPlus.test.watch`, `angularCliPlus.test.ui`, `angularCliPlus.checkDependencies.enabled`

## [1.0.2]

### Changed

- Project name is now auto-detected from `angular.json` instead of always prompting the user to type it
  - If exactly one project's `root`/`sourceRoot` contains the selected folder, it is used automatically
  - If multiple projects match, a Quick Pick list is shown for the user to choose
  - If no projects match (or no `angular.json` is found), a free-text input box is shown as a fallback

## [1.0.0]

- Initial release
