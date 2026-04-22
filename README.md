# Angular CLI Plus for VS Code

A VS Code extension providing Angular CLI commands, schematics generation, and project tools directly from the VS Code interface.

## Features

### Automatic Angular CLI version detection

The extension detects the Angular CLI version in each workspace and automatically adapts commands to use the correct flags:

| CLI Version | Build Flag                   | Standalone                     | Output Path               | Test UI |
| ----------- | ---------------------------- | ------------------------------ | ------------------------- | ------- |
| 8–11        | `--prod`                     | N/A                            | `dist/<project>/`         | N/A     |
| 12–13       | `--configuration=production` | N/A                            | `dist/<project>/`         | N/A     |
| 14–16       | `--configuration=production` | `--standalone` (default false) | `dist/<project>/`         | N/A     |
| 17+         | `--configuration=production` | default true                   | `dist/<project>/browser/` | `--ui`  |

Detection runs via `ng version` (preferring the workspace-local CLI from `node_modules/.bin`, with a `node_modules/@angular/cli` package fallback), is cached per workspace root, and refreshes automatically when `package.json` changes. When the version cannot be determined, the extension falls back to modern defaults.

### Schematics generator

- **Explorer and Command Palette support**: Generate Angular schematics from a folder in the Explorer or directly from the Command Palette
- **Organized submenu**: All generate commands in a single "Ng Generate" submenu
- **Configurable defaults**: Set default options for all generate commands in VS Code settings
- **Simple workflow**: Only prompts for the name; all other options use configured defaults
- **Smart target-folder detection**: Uses the selected Explorer folder, the active editor's folder, or a workspace-folder pick as the generation target
- **Smart project detection**: Automatically detects the Angular project from `angular.json` based on the resolved target folder
- **Supports all major Angular schematics**:
  - Component
  - Service
  - Module
  - Directive
  - Pipe
  - Guard
  - Interceptor
  - Class
  - Interface
  - Enum
  - Resolver

### Angular CLI commands (Command Palette & keyboard shortcuts)

| Command                        | Shortcut           | Description                                                                                                                                                                                  |
| ------------------------------ | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Angular: Serve Application     | `Ctrl+Shift+A S`   | Runs `ng serve` for a selected project                                                                                                                                                       |
| Angular: Debug Application     | `Ctrl+Shift+A D`   | Starts `ng serve`, waits for the dev server, then attaches a browser debugger                                                                                                                |
| Angular: Debug Storybook       | `Ctrl+Shift+A K`   | Starts Storybook, waits for it to be ready, then attaches a browser debugger                                                                                                                 |
| Angular: Debug Build (Watch)   | `Ctrl+Shift+A H`   | Runs `ng build --watch` + a static file server, then attaches a browser debugger                                                                                                             |
| Angular: Build Project         | `Ctrl+Shift+A B`   | Runs `ng build` with the configured build configuration                                                                                                                                      |
| Angular: Build Project (Watch) | `Ctrl+Shift+A W`   | Runs `ng build --watch` with the configured watch configuration                                                                                                                              |
| Angular: Test Project          | `Ctrl+Shift+A T`   | Runs `ng test` for a project, all projects, or the currently open spec file                                                                                                                  |
| Angular: Restart Serve         | `Ctrl+Shift+A R`   | Restarts any active serve/build-watch terminal; re-attaches the debugger if a debug session was running                                                                                      |
| Angular: Lint Project          | `Ctrl+Shift+A L`   | Runs `ng lint` for a selected project                                                                                                                                                        |
| Angular: Update Packages       | `Ctrl+Shift+A U`   | Shows available package updates and runs `ng update` for selected packages                                                                                                                   |
| Angular: Switch Component File | `Ctrl+Shift+A Tab` | Quickly switch between a component's `.ts`, `.html`, `.scss`/`.css`, and `.spec.ts` files via a QuickPick                                                                                    |
| Angular: Run npm Script        | `Ctrl+Shift+A N`   | Shows a searchable list of all npm scripts from `package.json` and runs the selected one in a terminal                                                                                       |
| Angular: Close Terminals       | `Ctrl+Shift+A C`   | Opens a searchable multi-select list of all extension terminals with their state (running / terminated / errored / killed) — finished terminals are pre-selected; select which ones to close |
| Angular: Check Memory Leaks    | `Ctrl+Shift+A M`   | Scans Angular source files for potential memory leaks using the TypeScript Compiler API and shows results in an interactive Webview panel with per-kind filters and a Reload button            |

### Angular: Check Memory Leaks (`Ctrl+Shift+A M`)

Analyses Angular source files in the workspace using the TypeScript Compiler API and reports potential memory leaks in an interactive Webview panel.

**Detected leak kinds:**

| Kind | Description |
| ---- | ----------- |
| Unguarded subscribe | `subscribe()` not protected by `untilDestroyed()` or `takeUntilDestroyed()` |
| Nested subscribe | `subscribe()` inside another `subscribe()` callback (inter-procedural, up to 10 levels) |
| Uncleared interval | `setInterval()` return value not passed to `clearInterval()` from `ngOnDestroy` |
| Uncleared timeout | `setTimeout()` return value stored on `this` and not passed to `clearTimeout()` from `ngOnDestroy` |
| Unremoved event listener | `addEventListener()` with no matching `removeEventListener()` reachable from `ngOnDestroy` |
| Unremoved Renderer listener | `Renderer2.listen()` cleanup function stored on `this` and not called in `ngOnDestroy` |
| Retained DOM reference | `document.getElementById()` / `querySelector()` / etc. result stored on `this` and not nulled in `ngOnDestroy` |
| Incomplete destroy subject | A `Subject` used in `takeUntil()` that is never `.next()`-ed and `.complete()`-ed in `ngOnDestroy` |

**Panel features:** file-grouped results with clickable source links, colour-coded kind badges, per-kind pill filters, a stats bar, and a **Reload** button that re-runs the analysis and refreshes the same panel without opening a new one.

On launch a QuickPick lets you choose the scope: the whole workspace, a single workspace folder, or a custom glob pattern.

### Failure notifications and retry

All terminal-based commands detect the exit code when the terminal closes:

- **Success** (exit code 0): brief info notification
- **Failure** (non-zero exit code): warning notification with a **Retry** button for build, lint, and test commands; Retry re-runs the exact same command without re-prompting

### Last used project memory

Every command that shows a project picker remembers the last selection per command, persisted across VS Code sessions. The picker shows:

1. `$(file) Current project (…)` — if the active editor file belongs to a project
2. `$(history) Last used (…)` — the last picked project, if different from the above
3. Full project list

### npm helpers

- **npm: Install**: runs `npm install` (or a custom command via `angularCliPlus.npm.installCommand`) and streams output to the "Angular CLI Plus: npm" output channel; automatically offers a clean install on failure when using the default command
- **npm: Clean Install**: removes `node_modules` and `package-lock.json` then runs `npm install` (or runs a custom command via `angularCliPlus.npm.cleanInstallCommand`); offers `--force` as a last resort on failure when using the default command
- **Dependency check**: on startup and on every git branch switch the extension verifies that `node_modules` exists and installed package versions satisfy `package.json` ranges, prompting to run `npm install` when needed; can be disabled via `angularCliPlus.checkDependencies.enabled`; also available as **Angular CLI Plus: Check Dependencies** in the Command Palette
- **Tool version check**: on startup the extension reads the `engines` field from `package.json` and checks that the installed versions of Node.js, npm, yarn, and pnpm satisfy the declared ranges; missing tools that can be installed via npm are installed automatically, version mismatches offer an "Update" button or a link to the tool's download page; can be disabled via `angularCliPlus.checkToolVersions.enabled`; also available as **Angular CLI Plus: Check Tool Versions** in the Command Palette

## Usage

### Generating schematics

1. Start from either of these entry points:

- Right-click any folder in the VS Code Explorer and open **Ng Generate**
- Run an **Angular CLI Plus** generate command from the Command Palette

2. Choose the type of schematic you want to generate (Component, Service, etc.)
3. Enter the name for the item you want to generate
4. The extension resolves the target folder in this order:

- The Explorer folder you clicked
- The folder of the active editor
- A workspace-folder pick if there is no active editor and multiple workspace folders are open

5. The extension automatically detects the Angular project from `angular.json`:

- If one project matches the resolved folder it is used automatically
- If multiple projects match you will be prompted to choose from a list
- If no projects match you can type the project name manually (leave empty for the default project)

6. The extension runs the Angular CLI command with your configured default options in the resolved target folder

### Running Angular CLI commands

Use the keyboard shortcuts (`Ctrl+Shift+A` followed by a letter) or search for **Angular CLI Plus** commands in the Command Palette (`Ctrl+Shift+P`). When `@angular/cli` is installed in the workspace, the extension uses that local CLI automatically instead of requiring a global `ng` on `PATH`:

- **Serve** (`Ctrl+Shift+A S`): select a project and start `ng serve` in a terminal
- **Debug** (`Ctrl+Shift+A D`): start `ng serve`, wait for the server, then attach a browser debugger; the terminal is stopped when the debug session ends
- **Debug Storybook** (`Ctrl+Shift+A K`): detects Storybook via `angular.json` architect targets or a `storybook` npm script, starts it, waits for the port (default `6006`), then attaches a browser debugger; configurable port via `angularCliPlus.storybook.port`
- **Debug Build Watch** (`Ctrl+Shift+A H`): runs `ng build --watch` and a static file server in parallel, waits for the server port, then attaches a browser debugger; both terminals are stopped when the session ends; fails fast when the configured serve port is already occupied; configurable via `angularCliPlus.buildWatch.servePort` and `angularCliPlus.buildWatch.staticServerCommand`
- **Build** (`Ctrl+Shift+A B`): select a project and run `ng build` (configuration controlled by `angularCliPlus.build.configuration`)
- **Build Watch** (`Ctrl+Shift+A W`): same as build but adds `--watch` (configuration controlled by `angularCliPlus.watch.configuration`)
- **Test** (`Ctrl+Shift+A T`): select a project, all projects at once, or the `.spec.ts` file you have open; when a spec file belongs to a detected Angular project, the owning project is passed explicitly to `ng test`
- **Restart Serve** (`Ctrl+Shift+A R`): restart any active `ng serve`, `ng build --watch`, Storybook, or static server terminal; if a debug session is attached it is stopped first and re-attached after the restart
- **Lint** (`Ctrl+Shift+A L`): select a project and run `ng lint`
- **Update** (`Ctrl+Shift+A U`): checks for available package updates, shows a multi-select list, then runs `ng update`; offers `--force` on failure
- **Switch Component File** (`Ctrl+Shift+A Tab`): switch between a component's related files (`.ts`, `.html`, `.scss`/`.css`/`.sass`/`.less`, `.spec.ts`) — shows a QuickPick with icons for each file type; the current file is pre-selected
- **Run npm Script** (`Ctrl+Shift+A N`): shows a searchable list of all scripts from `package.json`; select one to run it in a dedicated terminal
- **Close Terminals** (`Ctrl+Shift+A C`): opens a searchable multi-select QuickPick of all extension terminals; each entry shows the terminal name and state (`running`, `terminated`, `errored`, or `killed`); finished terminals are pre-selected and sorted to the top so pressing Enter clears them immediately; use the select-all checkbox or search to filter further
- **Check Memory Leaks** (`Ctrl+Shift+A M`): prompts for scope (whole workspace, a single folder, or a custom glob), scans all matching Angular source files with the TypeScript Compiler API, and opens an interactive Webview panel showing eight categories of potential memory leaks — each finding is a clickable link that jumps to the source location; use the pill filters in the legend to show/hide specific kinds; click **Reload** to re-run the analysis and refresh the same panel in place

### Debugging

The extension supports attaching a browser debugger to any dev server it starts. Configure the browser with `angularCliPlus.debug.browser`:

| Value      | Browser        | Notes                                                            |
| ---------- | -------------- | ---------------------------------------------------------------- |
| `chrome`   | Google Chrome  | Built-in, no extra extension needed                              |
| `edge`     | Microsoft Edge | Built-in, no extra extension needed                              |
| `brave`    | Brave          | Auto-detected from standard install paths                        |
| `opera`    | Opera          | Auto-detected from standard install paths                        |
| `opera-gx` | Opera GX       | Auto-detected from standard install paths                        |
| `firefox`  | Firefox        | Requires the **"Debugger for Firefox"** VS Code extension        |
| `safari`   | Safari         | Requires the **"Safari Debugger"** VS Code extension; macOS only |

For a browser not in the list, or for a non-standard install path, set `angularCliPlus.debug.browserExecutablePath` to the full path of the browser executable. Any Chromium-based browser (Vivaldi, Arc, etc.) works this way.

### npm helpers

Run **Angular CLI Plus: npm: Install** or **Angular CLI Plus: npm: Clean Install** from the Command Palette. Output is streamed to the **Angular CLI Plus: npm** output channel. The extension also automatically prompts you to run `npm install` when it detects missing or outdated packages on startup or after a git branch switch.

## Troubleshooting

### Commands don't appear in the Command Palette

Make sure the workspace contains an `angular.json` file. The extension activates automatically when VS Code opens.

### Debug session fails to start

- Verify the selected browser is installed. Brave, Opera, and Opera GX require installation at the standard path; set `angularCliPlus.debug.browserExecutablePath` for non-standard locations.
- For Firefox, install the **Debugger for Firefox** VS Code extension.
- For Safari, install the **Safari Debugger** VS Code extension and use macOS.
- For **Debug Build Watch**, make sure `angularCliPlus.buildWatch.servePort` is free before starting the session. If another process is already listening on that port, the extension now stops immediately instead of attaching to the wrong server.

### Dependency check triggers too often / not at all

- Toggle `angularCliPlus.checkDependencies.enabled` in VS Code settings.
- The check fires on startup, on every `git checkout` (branch switch), and whenever `package.json` is saved.
- Diagnostic logs are available in the **Angular CLI Plus: diagnostics** output channel (`View › Output`, then select the channel from the dropdown).

### `ng` / `npm` command not found

- Ensure Node.js and npm are on your `PATH`. For Angular commands, the extension prefers the workspace-local CLI from `node_modules/.bin` when available, so a global `ng` install is optional.
- The **Angular CLI Plus: npm** output channel shows the full output of every npm operation.

### Custom install command is rejected

Commands containing dangerous patterns (`; rm`, `&& rm`, `| del`, `$()`, backtick substitution, etc.) are blocked as a safety measure. Use a plain package-manager invocation (e.g. `pnpm install --frozen-lockfile`).

### Custom static server command is rejected

`angularCliPlus.buildWatch.staticServerCommand` is validated with the same safety rules as custom npm commands. Keep it to a plain server invocation such as `npx serve {outputPath} -l {port}` and avoid chained shell commands or shell substitution.

## Requirements

- Node.js and npm must be installed
- Angular CLI must be installed in your project or globally (`@angular/cli`)
- Your workspace must be an Angular project
- Supports Angular CLI version 8 and above

## Extension Settings

This extension contributes the following settings:

### Component Options

- `angularCliPlus.component.standalone`: Whether generated components should be standalone (default: `true`)
- `angularCliPlus.component.skipTests`: Skip creating spec.ts test files (default: `false`)
- `angularCliPlus.component.inlineStyle`: Include styles inline in the component.ts file (default: `false`)
- `angularCliPlus.component.inlineTemplate`: Include template inline in the component.ts file (default: `false`)
- `angularCliPlus.component.style`: The file extension or preprocessor to use (`css`, `scss`, `sass`, `less`, `none`) (default: `css`)
- `angularCliPlus.component.changeDetection`: The change detection strategy (`Default`, `OnPush`) (default: `Default`)
- `angularCliPlus.component.flat`: Create files at the top level of the current folder (default: `false`)

### Service Options

- `angularCliPlus.service.skipTests`: Skip creating spec.ts test files (default: `false`)
- `angularCliPlus.service.flat`: Create files at the top level of the current folder (default: `true`)

### Module Options

- `angularCliPlus.module.flat`: Create files at the top level of the current folder (default: `false`)
- `angularCliPlus.module.routing`: Create a routing module (default: `false`)

### Directive Options

- `angularCliPlus.directive.standalone`: Whether generated directives should be standalone (default: `true`)
- `angularCliPlus.directive.skipTests`: Skip creating spec.ts test files (default: `false`)
- `angularCliPlus.directive.flat`: Create files at the top level of the current folder (default: `true`)

### Pipe Options

- `angularCliPlus.pipe.standalone`: Whether generated pipes should be standalone (default: `true`)
- `angularCliPlus.pipe.skipTests`: Skip creating spec.ts test files (default: `false`)
- `angularCliPlus.pipe.flat`: Create files at the top level of the current folder (default: `true`)

### Guard Options

- `angularCliPlus.guard.functional`: Specifies whether to generate a guard as a function (default: `true`)
- `angularCliPlus.guard.skipTests`: Skip creating spec.ts test files (default: `false`)
- `angularCliPlus.guard.flat`: Create files at the top level of the current folder (default: `true`)

### Interceptor Options

- `angularCliPlus.interceptor.functional`: Creates the interceptor as a HttpInterceptorFn (default: `true`)
- `angularCliPlus.interceptor.skipTests`: Skip creating spec.ts test files (default: `false`)
- `angularCliPlus.interceptor.flat`: Create files at the top level of the current folder (default: `true`)

### Class Options

- `angularCliPlus.class.skipTests`: Skip creating spec.ts test files (default: `false`)

### Resolver Options

- `angularCliPlus.resolver.functional`: Creates the resolver as a ResolveFn (default: `true`)
- `angularCliPlus.resolver.skipTests`: Skip creating spec.ts test files (default: `false`)
- `angularCliPlus.resolver.flat`: Create files at the top level of the current folder (default: `true`)

### Debug Options

- `angularCliPlus.debug.browser`: Browser to use when launching a debug session (`chrome`, `edge`, `brave`, `opera`, `opera-gx`, `firefox`, `safari`) (default: `chrome`)
- `angularCliPlus.debug.browserExecutablePath`: Optional path to the browser executable; overrides automatic detection (default: `""`)

### Build Options

- `angularCliPlus.build.configuration`: Configuration flag passed to `ng build` (`default`, `production`, `development`) (default: `production`)
- `angularCliPlus.watch.configuration`: Configuration flag passed to `ng build --watch` (`default`, `inherit`, `production`, `development`) — `inherit` copies the value from `angularCliPlus.build.configuration` (default: `development`)

### Test Options

- `angularCliPlus.test.watch`: Run `ng test` in watch mode (default: `false`)
- `angularCliPlus.test.ui`: Enable the Vitest UI for interactive test execution — only available for the Vitest runner (default: `false`)

### Storybook Options

- `angularCliPlus.storybook.port`: Port Storybook runs on; `0` means auto-detect from `angular.json` or use the default `6006` (default: `0`)

### Debug Build Watch Options

- `angularCliPlus.buildWatch.servePort`: Port the static file server listens on during a Debug Build Watch session (default: `4201`)
- `angularCliPlus.buildWatch.staticServerCommand`: Command used to serve the build output; use `{outputPath}` and `{port}` as placeholders (default: `npx serve {outputPath} -l {port}`)

### Dependency Check Options

- `angularCliPlus.checkDependencies.enabled`: Check if npm dependencies are installed and match `package.json` on startup and on git branch changes (default: `true`)
- `angularCliPlus.checkToolVersions.enabled`: Check if Node.js, npm, yarn, and pnpm versions satisfy the `engines` field in `package.json` on startup (default: `true`)

### Update Options

- `angularCliPlus.update.allowDirty`: Pass `--allow-dirty` to `ng update`, allowing updates when the working tree has uncommitted changes (default: `false`)

### npm Command Options

- `angularCliPlus.npm.installCommand`: Custom command used by **npm: Install** (e.g. `yarn install`, `pnpm install`). Leave empty to use the default `npm install` with automatic clean/force fallbacks (default: `""`)
- `angularCliPlus.npm.cleanInstallCommand`: Custom command used by **npm: Clean Install** (e.g. `yarn install --frozen-lockfile`). Leave empty to use the default behaviour — removes `node_modules` and `package-lock.json` then runs `npm install` (default: `""`)
