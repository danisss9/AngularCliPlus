# Change Log

All notable changes to the "angular-cli-plus" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [1.4.1]

### Fixed

- **Schematic commands from the Command Palette** — `ng generate` commands no longer depend on an Explorer folder URI. They now resolve the target folder from the clicked Explorer folder, the active editor, or a workspace-folder picker, so generate commands work from both the Explorer and the Command Palette
- **Workspace-local Angular CLI resolution** — Angular commands now prefer the workspace-local CLI from `node_modules/.bin` for terminal commands, `ng update`, and CLI version detection, so a global `ng` install is no longer required when `@angular/cli` is installed in the project
- **Current spec-file test targeting** — running `Angular: Test Project` against the current `.spec.ts` file now passes the detected owning Angular project to `ng test`, preventing multi-project workspaces from falling back to the wrong project or the default target
- **Build-watch debug port collisions** — `Angular: Debug Build (Watch)` now fails fast when the configured static-server port is already occupied instead of treating an unrelated listener as the server it just started
- **Unsafe static-server command execution** — `angularCliPlus.buildWatch.staticServerCommand` is now validated before execution, matching the existing safety checks used for custom npm install commands
- **Terminal reclaim by name after reload** — the extension no longer re-adopts pre-existing terminals by terminal name alone on activation, avoiding collisions with user-created terminals that happen to share the same name
- **TypeScript Node environment drift** — `tsconfig.json` now explicitly includes the `node` and `mocha` type libraries so the repo typecheck reflects the intended extension runtime and test environment

## [1.4.0]

### Added

- **Angular CLI version detection** — the extension now automatically detects the Angular CLI version used in each workspace (via `ng version`, with a `node_modules` fallback) and adapts commands accordingly. The detected version is cached per workspace root and invalidated whenever `package.json` changes. Supports Angular CLI 8+
  - **Build**: CLI <12 uses `--prod`; CLI 12+ uses `--configuration=production`
  - **Schematics**: `--standalone` flag is stripped for CLI <14 (unsupported), kept as-is for CLI 14–16, and omitted when redundant on CLI 17+ (standalone is the default)
  - **Test**: the `--ui` flag (Vitest UI) is only passed on CLI 17+ where Vitest is supported
  - **Output path resolution**: uses the detected version to choose between `dist/<project>/` (legacy) and `dist/<project>/browser/` (CLI 17+), with a filesystem fallback when version info is unavailable
- **Angular: Switch Component File** (`Ctrl+Shift+A Tab`): quickly switch between a component's related files (`.component.ts`, `.component.html`, `.component.scss`/`.css`/`.sass`/`.less`, `.component.spec.ts`) via a QuickPick that shows all existing sibling files with descriptive icons; the current file is pre-selected so you can arrow or tab to the desired file and press Enter to open it in the same editor column
- **Angular: Run npm Script** (`Ctrl+Shift+A N`): shows a searchable QuickPick listing all scripts defined in the workspace's `package.json`; each entry shows the script name and its command; select one to run it in a dedicated terminal

## [1.3.4]

### Fixed

- **Schematics run from wrong directory** — `ng generate` commands now run from the workspace root (where `angular.json` lives) instead of the right-clicked folder, which previously caused the command to fail
- **Spawn promises could hang forever** — all child-process spawn helpers (`spawnNg`, `spawnNpm`, `spawnCapture`, `spawnShellCommand`) now handle the `error` event so the promise resolves instead of hanging indefinitely when the binary is not found
- **Stray "y" sent on terminal restart** — restarting a serve/watch terminal no longer sends a blind `y` keystroke (intended only for `ng serve`'s confirmation prompt) which could be misinterpreted by other processes like `ng build --watch` or Storybook
- **Case-sensitive path matching on Windows** — project detection from `angular.json` now compares paths case-insensitively on Windows, preventing mismatches when drive letters or folder names differ in casing
- **QuickPick resource leak** — the Close Terminals picker is now properly `.dispose()`d after use
- **Version prefix regex** — the tool-version check regex was matching `v/` instead of `v`; corrected to `/^v/`
- **Unquoted string values in generated commands** — `ng generate` flag values containing spaces or shell metacharacters are now quoted
- **Synchronous file I/O** — `angular.json` is now read with `fs.promises` instead of blocking the extension host thread
- **Debug session listener leak** — the `onDidTerminateDebugSession` listener is now cleaned up when the terminal closes, preventing listener accumulation across debug sessions
- **esbuild error handler crash** — the build error reporter now guards against `null` location objects
- **Command validation hardening** — `validateCustomCommand` now also blocks `$()` and backtick shell substitution in addition to the existing `; rm`-style patterns
- **Spurious tool-version warnings** — `checkToolVersions` on activation is now gated on `angular.json` existing, so non-Angular workspaces with an `engines` field no longer receive unexpected notifications
- **Unhandled `fs.watch` errors** — the `.git/HEAD` file watcher now has an `error` event handler to prevent uncaught exceptions
- **Command injection in shell argument escaping** — `buildNgGenerateCommand` now escapes backslashes and double quotes inside option values before wrapping them in double quotes, preventing shell breakout via crafted option values
- **Unescaped output path in debug server command** — the `{outputPath}` placeholder in the static server command template is now properly escaped before quoting, preventing command injection via paths containing quotes or shell metacharacters
- **Fire-and-forget terminal restart dialog** — `runInTerminal` is now `async`; the restart confirmation dialog is properly awaited instead of being dispatched as a detached promise, ensuring callers can rely on the returned terminal being in the expected state
- **Listener cleanup race in debug sessions** — the `onDidTerminateDebugSession` and `onDidCloseTerminal` listeners now share a guarded `disposeListeners()` helper that prevents double-disposal when both events fire near-simultaneously
- **Unhandled errors in browser debug launcher** — the `withProgress` callback in `launchBrowserDebugSession` is now wrapped in a `try/catch` that logs the error and shows a user-facing notification instead of silently swallowing failures
- **Terminal reuse race condition** — `runInTerminal` now re-checks `exitStatus` after awaiting the user's restart/show dialog; if the terminal was disposed while the dialog was open, it falls through to create a fresh terminal instead of operating on a stale reference
- **Double socket destruction in `waitForPort`** — socket event handlers now use a `handled` flag to ensure `destroy()` and the retry timer are only triggered once, even if both `timeout` and `error` events fire
- **Improved custom command validation** — `validateCustomCommand` now additionally blocks chained `powershell`, `cmd`, `bash`, `sh`, `curl`, `wget`, `nc`, `ncat` invocations and suspicious output redirections to absolute paths
- **Silent `angular.json` parse errors** — parse failures in `readAngularJson` now log the underlying error message to the diagnostics output channel instead of silently returning `null`
- **Unknown browser setting silently defaults to Chrome** — unrecognised `angularCliPlus.debug.browser` values now log a diagnostic warning before falling back to Chrome
- **Unquoted project names in shell commands** — all `--project` arguments in `ng serve`, `ng test`, `ng lint`, `ng build`, and `ng build --watch` commands are now quoted to handle project names containing spaces or special characters
- **Unquoted file path in `ng test --include`** — the relative spec-file path is now quoted to prevent breakage on paths with spaces
- **Unhandled promise rejection in dependency check** — the `setTimeout` callback in `scheduleDependencyCheck` now catches and logs rejections from the async `checkDependencies` call; fire-and-forget `checkToolVersions` calls in activation are now explicitly `void`-prefixed
- **Unsafe non-null assertions in debug commands** — `entries.find(...)!` in storybook debug now returns early if no match is found instead of crashing; `activeServeTerminals.get(...)!` in restart now shows an error message instead of throwing

## [1.3.3]

### Fixed

- **Terminal reclamation after restart** — extension-owned terminals that survive a VS Code reload are now re-adopted on activation. Their metadata (`command`, `cwd`, `trackAsServe`) is persisted in `workspaceState` so they appear correctly in the Close Terminals picker and the Restart Serve quick pick without needing to re-run commands
- **Terminal reuse for same command** — running a command whose terminal is already open no longer creates a duplicate. If the terminal is still running, it is focused (or, for serve/watch terminals, the user is offered a Restart / Show choice). If it has finished, the old panel is disposed and a fresh one is opened
- **Terminal state detection** — the Close Terminals picker now distinguishes four states: `running` (still active), `killed` (closed without an exit code), `terminated` (exit 0), and `errored` (non-zero exit). Finished terminals (errored, killed, terminated) are sorted to the top and pre-selected so pressing Enter clears them immediately. Killed terminals are no longer silently conflated with running ones
- **Killed terminal logging** — terminals closed without an exit code (e.g. the user drags the panel closed mid-run) are now logged to the **Angular CLI Plus: diagnostics** output channel instead of being silently swallowed

## [1.3.2]

### Changed

- Internal code readability improvements and expanded test coverage

## [1.3.1]

### Changed

- **Close Terminals** (`Ctrl+Shift+A C`) reworked: instead of silently closing all finished terminals it now opens a searchable, multi-select QuickPick listing **all** active extension terminals. Each entry shows the terminal name and its current state — `running`, `terminated`, or `errored`. Use the native select-all checkbox or search to filter, then confirm to close the selected terminals

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
