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

| Command                        | Shortcut         | Description                                                                                        |
| ------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------- |
| Angular: Serve Application     | `Ctrl+Shift+A S` | Runs `ng serve` for a selected project; offers "Current project" shortcut when a file is open      |
| Angular: Debug Application     | `Ctrl+Shift+A D` | Starts `ng serve`, waits for the dev server, then attaches a browser debugger                      |
| Angular: Build Project         | `Ctrl+Shift+A B` | Runs `ng build` with the configured build configuration; offers "Current project" shortcut         |
| Angular: Build Project (Watch) | `Ctrl+Shift+A W` | Runs `ng build --watch` with the configured watch configuration; offers "Current project" shortcut |
| Angular: Test Project          | `Ctrl+Shift+A T` | Runs `ng test` for a project, all projects, or the currently open spec file                        |
| Angular: Restart Serve         | `Ctrl+Shift+A R` | Gracefully restarts any active `ng serve` or `ng build --watch` terminal                           |
| Angular: Lint Project          | `Ctrl+Shift+A L` | Runs `ng lint` for a selected project; offers "Current project" shortcut when a file is open       |
| Angular: Update Packages       | `Ctrl+Shift+A U` | Shows available package updates and runs `ng update` for selected packages                         |

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

- **Serve** (`Ctrl+Shift+A S`): select a project and start `ng serve` in a terminal; "Current project" appears as the first option when the active file belongs to a project
- **Debug** (`Ctrl+Shift+A D`): start `ng serve`, wait for the server to be ready, then attach a Chrome/Edge debugger; the serve terminal is stopped automatically when you end the debug session; "Current project" shortcut available
- **Build** (`Ctrl+Shift+A B`): select a project and run `ng build` (configuration controlled by `angularCliPlus.build.configuration`); "Current project" shortcut available
- **Build Watch** (`Ctrl+Shift+A W`): same as build but adds `--watch` (configuration controlled by `angularCliPlus.watch.configuration`); "Current project" shortcut available
- **Test** (`Ctrl+Shift+A T`): select a project, all projects at once, run the tests for the `.spec.ts` file you have open, or use the "Current project" shortcut
- **Restart Serve** (`Ctrl+Shift+A R`): restart any active `ng serve` or `ng build --watch` session without closing the terminal
- **Lint** (`Ctrl+Shift+A L`): select a project and run `ng lint` in a terminal; "Current project" shortcut available
- **Update** (`Ctrl+Shift+A U`): checks for available package updates, shows a multi-select list, then runs `ng update` for the selected packages; offers `--force` on failure; respects `angularCliPlus.update.allowDirty`

### npm helpers

Run **Angular CLI Plus: npm: Install** or **Angular CLI Plus: npm: Clean Install** from the Command Palette. Output is streamed to the **Angular CLI Plus: npm** output channel. The extension also automatically prompts you to run `npm install` when it detects missing or outdated packages on startup or after a git branch switch.

## Requirements

- Node.js and npm must be installed
- Angular CLI must be installed in your project or globally (`@angular/cli`)
- Your workspace must be an angular project

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

- `angularCliPlus.debug.browser`: Browser to use when launching the Angular debug session (`chrome` or `edge`) (default: `chrome`)

### Build Options

- `angularCliPlus.build.configuration`: Configuration flag passed to `ng build` (`default`, `production`, `development`) (default: `production`)
- `angularCliPlus.watch.configuration`: Configuration flag passed to `ng build --watch` (`default`, `inherit`, `production`, `development`) — `inherit` copies the value from `angularCliPlus.build.configuration` (default: `development`)

### Test Options

- `angularCliPlus.test.watch`: Run `ng test` in watch mode (default: `false`)
- `angularCliPlus.test.ui`: Enable the Vitest UI for interactive test execution — only available for the Vitest runner (default: `false`)

### Dependency Check Options

- `angularCliPlus.checkDependencies.enabled`: Check if npm dependencies are installed and match `package.json` on startup and on git branch changes (default: `true`)
- `angularCliPlus.checkToolVersions.enabled`: Check if Node.js, npm, yarn, and pnpm versions satisfy the `engines` field in `package.json` on startup (default: `true`)

### Update Options

- `angularCliPlus.update.allowDirty`: Pass `--allow-dirty` to `ng update`, allowing updates when the working tree has uncommitted changes (default: `false`)

### npm Command Options

- `angularCliPlus.npm.installCommand`: Custom command used by **npm: Install** (e.g. `yarn install`, `pnpm install`). Leave empty to use the default `npm install` with automatic clean/force fallbacks (default: `""`)
- `angularCliPlus.npm.cleanInstallCommand`: Custom command used by **npm: Clean Install** (e.g. `yarn install --frozen-lockfile`). Leave empty to use the default behaviour — removes `node_modules` and `package-lock.json` then runs `npm install` (default: `""`)
