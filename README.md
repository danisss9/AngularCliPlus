# Angular CLI Plus for VS Code

A VS Code extension providing Angular CLI commands, schematics generation, and project tools directly from the VS Code interface.

## Features

### Schematics generator

- **Right-click context menu integration**: Generate Angular schematics by right-clicking any folder in the Explorer
- **Organized submenu**: All generate commands in a single "Ng Generate" submenu
- **Configurable defaults**: Set default options for all generate commands in VS Code settings
- **Simple workflow**: Only prompts for the name; all other options use configured defaults
- **Smart project detection**: Automatically detects the Angular project from `angular.json` based on the folder you right-clicked
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

| Command                              | Shortcut         | Description                                                                                                    |
| ------------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------- |
| Angular: Serve Application           | `Ctrl+Shift+A S` | Runs `ng serve` for a selected project                                                                         |
| Angular: Debug Application           | `Ctrl+Shift+A D` | Starts `ng serve`, waits for the dev server, then attaches a browser debugger                                  |
| Angular: Debug Storybook             | `Ctrl+Shift+A K` | Starts Storybook, waits for it to be ready, then attaches a browser debugger                                   |
| Angular: Debug Build (Watch)         | `Ctrl+Shift+A H` | Runs `ng build --watch` + a static file server, then attaches a browser debugger                               |
| Angular: Build Project               | `Ctrl+Shift+A B` | Runs `ng build` with the configured build configuration                                                        |
| Angular: Build Project (Watch)       | `Ctrl+Shift+A W` | Runs `ng build --watch` with the configured watch configuration                                                |
| Angular: Test Project                | `Ctrl+Shift+A T` | Runs `ng test` for a project, all projects, or the currently open spec file                                    |
| Angular: Restart Serve               | `Ctrl+Shift+A R` | Restarts any active serve/build-watch terminal; re-attaches the debugger if a debug session was running        |
| Angular: Lint Project                | `Ctrl+Shift+A L` | Runs `ng lint` for a selected project                                                                          |
| Angular: Update Packages             | `Ctrl+Shift+A U` | Shows available package updates and runs `ng update` for selected packages                                     |
| Angular: Close Terminals             | `Ctrl+Shift+A C` | Opens a searchable multi-select list of all extension terminals with their state (running / terminated / errored) — select which ones to close |

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

1. Right-click on any folder in the VS Code Explorer
2. Select **Ng Generate** from the context menu
3. Choose the type of schematic you want to generate (Component, Service, etc.)
4. Enter the name for the item you want to generate
5. The extension automatically detects the Angular project from `angular.json`:
   - If one project matches the selected folder it is used automatically
   - If multiple projects match you will be prompted to choose from a list
   - If no projects match you can type the project name manually (leave empty for the default project)
6. The extension runs the Angular CLI command with your configured default options in the selected folder

### Running Angular CLI commands

Use the keyboard shortcuts (`Ctrl+Shift+A` followed by a letter) or search for **Angular CLI Plus** commands in the Command Palette (`Ctrl+Shift+P`):

- **Serve** (`Ctrl+Shift+A S`): select a project and start `ng serve` in a terminal
- **Debug** (`Ctrl+Shift+A D`): start `ng serve`, wait for the server, then attach a browser debugger; the terminal is stopped when the debug session ends
- **Debug Storybook** (`Ctrl+Shift+A K`): detects Storybook via `angular.json` architect targets or a `storybook` npm script, starts it, waits for the port (default `6006`), then attaches a browser debugger; configurable port via `angularCliPlus.storybook.port`
- **Debug Build Watch** (`Ctrl+Shift+A H`): runs `ng build --watch` and a static file server in parallel, waits for the server port, then attaches a browser debugger; both terminals are stopped when the session ends; configurable via `angularCliPlus.buildWatch.servePort` and `angularCliPlus.buildWatch.staticServerCommand`
- **Build** (`Ctrl+Shift+A B`): select a project and run `ng build` (configuration controlled by `angularCliPlus.build.configuration`)
- **Build Watch** (`Ctrl+Shift+A W`): same as build but adds `--watch` (configuration controlled by `angularCliPlus.watch.configuration`)
- **Test** (`Ctrl+Shift+A T`): select a project, all projects at once, or the `.spec.ts` file you have open
- **Restart Serve** (`Ctrl+Shift+A R`): restart any active `ng serve`, `ng build --watch`, Storybook, or static server terminal; if a debug session is attached it is stopped first and re-attached after the restart
- **Lint** (`Ctrl+Shift+A L`): select a project and run `ng lint`
- **Update** (`Ctrl+Shift+A U`): checks for available package updates, shows a multi-select list, then runs `ng update`; offers `--force` on failure
- **Close Terminals** (`Ctrl+Shift+A C`): opens a searchable multi-select QuickPick of all extension terminals; each entry shows the terminal name and state (`running`, `terminated`, `errored`); use the select-all checkbox or search to filter, then confirm to close the selected terminals

### Debugging

The extension supports attaching a browser debugger to any dev server it starts. Configure the browser with `angularCliPlus.debug.browser`:

| Value      | Browser       | Notes                                                              |
| ---------- | ------------- | ------------------------------------------------------------------ |
| `chrome`   | Google Chrome | Built-in, no extra extension needed                                |
| `edge`     | Microsoft Edge | Built-in, no extra extension needed                               |
| `brave`    | Brave         | Auto-detected from standard install paths                          |
| `opera`    | Opera         | Auto-detected from standard install paths                          |
| `opera-gx` | Opera GX      | Auto-detected from standard install paths                          |
| `firefox`  | Firefox       | Requires the **"Debugger for Firefox"** VS Code extension          |
| `safari`   | Safari        | Requires the **"Safari Debugger"** VS Code extension; macOS only   |

For a browser not in the list, or for a non-standard install path, set `angularCliPlus.debug.browserExecutablePath` to the full path of the browser executable. Any Chromium-based browser (Vivaldi, Arc, etc.) works this way.

### npm helpers

Run **Angular CLI Plus: npm: Install** or **Angular CLI Plus: npm: Clean Install** from the Command Palette. Output is streamed to the **Angular CLI Plus: npm** output channel. The extension also automatically prompts you to run `npm install` when it detects missing or outdated packages on startup or after a git branch switch.

## Requirements

- Node.js and npm must be installed
- Angular CLI must be installed in your project or globally (`@angular/cli`)
- Your workspace must be an Angular project

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
