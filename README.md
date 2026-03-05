# NG Generate for VS Code

A VS Code extension that allows you to run NG CLI generate commands directly from the folder context menu in the Explorer.

## Features

### Schematics generator

- **Right-click context menu integration**: Generate Angular schematics by right-clicking any folder in the Explorer
- **Organized submenu**: All generate commands in a single "ng Generate" submenu
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

| Command                        | Shortcut           | Description                                                                                        |
| ------------------------------ | ------------------ | -------------------------------------------------------------------------------------------------- |
| Angular: Serve Application     | `Ctrl+Shift+A S`   | Runs `ng serve` for a selected project; offers "Current project" shortcut when a file is open      |
| Angular: Debug Application     | `Ctrl+Shift+A D`   | Starts `ng serve`, waits for the dev server, then attaches a browser debugger                      |
| Angular: Build Project         | `Ctrl+Shift+A B`   | Runs `ng build` with the configured build configuration; offers "Current project" shortcut         |
| Angular: Build Project (Watch) | `Ctrl+Shift+A W`   | Runs `ng build --watch` with the configured watch configuration; offers "Current project" shortcut |
| Angular: Test Project          | `Ctrl+Shift+A T`   | Runs `ng test` for a project, all projects, or the currently open spec file                        |
| Angular: Restart Serve         | `Ctrl+Shift+A R`   | Gracefully restarts any active `ng serve` or `ng build --watch` terminal                           |
| Angular: Lint Project          | `Ctrl+Shift+A L`   | Runs `ng lint` for a selected project; offers "Current project" shortcut when a file is open       |
| Angular: Update Packages       | `Ctrl+Shift+A U`   | Shows available package updates and runs `ng update` for selected packages                         |

### npm helpers

- **npm: Install**: runs `npm install` (or a custom command via `ngGenerate.npm.installCommand`) and streams output to the "ng Generate: npm" output channel; automatically offers a clean install on failure when using the default command
- **npm: Clean Install**: removes `node_modules` and `package-lock.json` then runs `npm install` (or runs a custom command via `ngGenerate.npm.cleanInstallCommand`); offers `--force` as a last resort on failure when using the default command
- **Dependency check**: on startup and on every git branch switch the extension verifies that `node_modules` exists and installed package versions satisfy `package.json` ranges, prompting to run `npm install` when needed; can be disabled via `ngGenerate.checkDependencies.enabled`

## Usage

### Generating schematics

1. Right-click on any folder in the VS Code Explorer
2. Select **ng Generate** from the context menu
3. Choose the type of schematic you want to generate (Component, Service, etc.)
4. Enter the name for the item you want to generate
5. The extension automatically detects the Angular project from `angular.json`:
   - If one project matches the selected folder it is used automatically
   - If multiple projects match you will be prompted to choose from a list
   - If no projects match you can type the project name manually (leave empty for the default project)
6. The extension runs the Angular CLI command with your configured default options in the selected folder

### Running Angular CLI commands

Use the keyboard shortcuts (`Ctrl+Shift+A` followed by a letter) or search for **ng Generate** commands in the Command Palette (`Ctrl+Shift+P`):

- **Serve** (`Ctrl+Shift+A S`): select a project and start `ng serve` in a terminal; "Current project" appears as the first option when the active file belongs to a project
- **Debug** (`Ctrl+Shift+A D`): start `ng serve`, wait for the server to be ready, then attach a Chrome/Edge debugger; the serve terminal is stopped automatically when you end the debug session; "Current project" shortcut available
- **Build** (`Ctrl+Shift+A B`): select a project and run `ng build` (configuration controlled by `ngGenerate.build.configuration`); "Current project" shortcut available
- **Build Watch** (`Ctrl+Shift+A W`): same as build but adds `--watch` (configuration controlled by `ngGenerate.watch.configuration`); "Current project" shortcut available
- **Test** (`Ctrl+Shift+A T`): select a project, all projects at once, run the tests for the `.spec.ts` file you have open, or use the "Current project" shortcut
- **Restart Serve** (`Ctrl+Shift+A R`): restart any active `ng serve` or `ng build --watch` session without closing the terminal
- **Lint** (`Ctrl+Shift+A L`): select a project and run `ng lint` in a terminal; "Current project" shortcut available
- **Update** (`Ctrl+Shift+A U`): checks for available package updates, shows a multi-select list, then runs `ng update` for the selected packages; offers `--force` on failure; respects `ngGenerate.update.allowDirty`

### npm helpers

Run **ng Generate: npm: Install** or **ng Generate: npm: Clean Install** from the Command Palette. Output is streamed to the **ng Generate: npm** output channel. The extension also automatically prompts you to run `npm install` when it detects missing or outdated packages on startup or after a git branch switch.

## Requirements

- Node.js and npm must be installed
- Angular CLI must be installed in your project or globally (`@angular/cli`)
- Your workspace must be an angular project

## Extension Settings

This extension contributes the following settings:

### Component Options

- `ngGenerate.component.standalone`: Whether generated components should be standalone (default: `true`)
- `ngGenerate.component.skipTests`: Skip creating spec.ts test files (default: `false`)
- `ngGenerate.component.inlineStyle`: Include styles inline in the component.ts file (default: `false`)
- `ngGenerate.component.inlineTemplate`: Include template inline in the component.ts file (default: `false`)
- `ngGenerate.component.style`: The file extension or preprocessor to use (`css`, `scss`, `sass`, `less`, `none`) (default: `css`)
- `ngGenerate.component.changeDetection`: The change detection strategy (`Default`, `OnPush`) (default: `Default`)
- `ngGenerate.component.flat`: Create files at the top level of the current folder (default: `false`)

### Service Options

- `ngGenerate.service.skipTests`: Skip creating spec.ts test files (default: `false`)
- `ngGenerate.service.flat`: Create files at the top level of the current folder (default: `true`)

### Module Options

- `ngGenerate.module.flat`: Create files at the top level of the current folder (default: `false`)
- `ngGenerate.module.routing`: Create a routing module (default: `false`)

### Directive Options

- `ngGenerate.directive.standalone`: Whether generated directives should be standalone (default: `true`)
- `ngGenerate.directive.skipTests`: Skip creating spec.ts test files (default: `false`)
- `ngGenerate.directive.flat`: Create files at the top level of the current folder (default: `true`)

### Pipe Options

- `ngGenerate.pipe.standalone`: Whether generated pipes should be standalone (default: `true`)
- `ngGenerate.pipe.skipTests`: Skip creating spec.ts test files (default: `false`)
- `ngGenerate.pipe.flat`: Create files at the top level of the current folder (default: `true`)

### Guard Options

- `ngGenerate.guard.functional`: Specifies whether to generate a guard as a function (default: `true`)
- `ngGenerate.guard.skipTests`: Skip creating spec.ts test files (default: `false`)
- `ngGenerate.guard.flat`: Create files at the top level of the current folder (default: `true`)

### Interceptor Options

- `ngGenerate.interceptor.functional`: Creates the interceptor as a HttpInterceptorFn (default: `true`)
- `ngGenerate.interceptor.skipTests`: Skip creating spec.ts test files (default: `false`)
- `ngGenerate.interceptor.flat`: Create files at the top level of the current folder (default: `true`)

### Class Options

- `ngGenerate.class.skipTests`: Skip creating spec.ts test files (default: `false`)

### Resolver Options

- `ngGenerate.resolver.functional`: Creates the resolver as a ResolveFn (default: `true`)
- `ngGenerate.resolver.skipTests`: Skip creating spec.ts test files (default: `false`)
- `ngGenerate.resolver.flat`: Create files at the top level of the current folder (default: `true`)

### Debug Options

- `ngGenerate.debug.browser`: Browser to use when launching the Angular debug session (`chrome` or `edge`) (default: `chrome`)

### Build Options

- `ngGenerate.build.configuration`: Configuration flag passed to `ng build` (`default`, `production`, `development`) (default: `production`)
- `ngGenerate.watch.configuration`: Configuration flag passed to `ng build --watch` (`default`, `inherit`, `production`, `development`) — `inherit` copies the value from `ngGenerate.build.configuration` (default: `development`)

### Test Options

- `ngGenerate.test.watch`: Run `ng test` in watch mode (default: `false`)
- `ngGenerate.test.ui`: Enable the Vitest UI for interactive test execution — only available for the Vitest runner (default: `false`)

### Dependency Check Options

- `ngGenerate.checkDependencies.enabled`: Check if npm dependencies are installed and match `package.json` on startup and on git branch changes (default: `true`)

### Update Options

- `ngGenerate.update.allowDirty`: Pass `--allow-dirty` to `ng update`, allowing updates when the working tree has uncommitted changes (default: `false`)

### npm Command Options

- `ngGenerate.npm.installCommand`: Custom command used by **npm: Install** (e.g. `yarn install`, `pnpm install`). Leave empty to use the default `npm install` with automatic clean/force fallbacks (default: `""`)
- `ngGenerate.npm.cleanInstallCommand`: Custom command used by **npm: Clean Install** (e.g. `yarn install --frozen-lockfile`). Leave empty to use the default behaviour — removes `node_modules` and `package-lock.json` then runs `npm install` (default: `""`)
