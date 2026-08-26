# Angular CLI Plus for VS Code

Angular CLI commands, schematics generator, and project tools for VS Code — with AI-powered auto-fix support (GitHub Copilot & Claude Code).

Angular CLI Plus brings the full power of the Angular CLI into your editor: generate schematics from the Explorer context menu, serve/build/test/lint with a single keystroke, debug your app (plus Storybook and build-watch sessions) in any major browser, and analyze your codebase for memory leaks, performance pitfalls, and build errors — all without leaving VS Code.

## Table of Contents

- [Requirements](#requirements)
- [Schematics Generator (ng generate)](#schematics-generator-ng-generate)
- [CLI Commands](#cli-commands)
- [Debugging](#debugging)
- [Code Analysis Tools](#code-analysis-tools)
- [AI-Powered Auto-Fix](#ai-powered-auto-fix)
- [JSON Config Manager](#json-config-manager)
- [Angular Migrations](#angular-migrations)
- [Package Management](#package-management)
- [Productivity Tools](#productivity-tools)
- [Code Snippets](#code-snippets)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Extension Settings](#extension-settings)
- [Recommended Extensions](#recommended-extensions)
- [Contributing](#contributing)
- [License](#license)

## Requirements

- VS Code `1.107.0` or newer
- An Angular workspace with an `angular.json` (Angular CLI 8+ is supported; commands adapt to the detected CLI version)
- Node.js and npm installed

The extension prefers the workspace-local Angular CLI from `node_modules/.bin`, so a global `ng` install is not required when `@angular/cli` is installed in the project.

## Schematics Generator (ng generate)

Right-click any folder in the Explorer and open the **Ng Generate** submenu (or run a generate command from the Command Palette) to scaffold Angular artifacts with `ng generate`. The target folder is resolved from the clicked folder, the active editor, or a workspace-folder picker.

Available schematics:

| Schematic   | Group      |
| ----------- | ---------- |
| Component   | Common     |
| Service     | Common     |
| Module      | Common     |
| Directive   | Structural |
| Pipe        | Structural |
| Guard       | Routing    |
| Interceptor | Routing    |
| Resolver    | Routing    |
| Class       | Types      |
| Interface   | Types      |
| Enum        | Types      |

Each schematic honors dedicated settings (standalone, skip tests, flat, style preprocessor, change detection, functional guards/interceptors/resolvers, routing modules, …) — see [Extension Settings](#extension-settings). Generated flags automatically adapt to the detected Angular CLI version (e.g. `--standalone` is stripped for CLI <14 and omitted as redundant on CLI 17+).

## CLI Commands

All commands remember the last used project per command, offer a "Current project" shortcut when an editor tab is open, and auto-detect the project from `angular.json` when possible.

| Command                            | Shortcut         | Description                                                                                                                                                                                        |
| ---------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Angular: Serve Application**     | `Ctrl+Shift+A S` | Runs `ng serve` for a selected project in a dedicated terminal                                                                                                                                     |
| **Angular: Build Project**         | `Ctrl+Shift+A B` | Runs `ng build` with a configurable configuration                                                                                                                                                  |
| **Angular: Build Project (Watch)** | `Ctrl+Shift+A W` | Runs `ng build --watch` with its own configuration setting (which can inherit from the build setting)                                                                                              |
| **Angular: Test Project**          | `Ctrl+Shift+A T` | Runs `ng test`; supports an "All projects" option, a "Run current test file" shortcut when a `.spec.ts` is active, watch mode, and the Vitest UI (`--ui`, CLI 17+)                                 |
| **Angular: Lint Project**          | `Ctrl+Shift+A L` | Runs `ng lint` and presents the results in a rich interactive Webview panel (see [Lint Panel](#lint-panel))                                                                                        |
| **Angular: Update Packages**       | `Ctrl+Shift+A U` | Interactive Webview showing Angular package updates (via `ng update`) and other package updates (via [npm-check-updates](https://www.npmjs.com/package/npm-check-updates)), with selective updates |
| **Angular: Restart Serve**         | `Ctrl+Shift+A R` | Gracefully restarts any active `ng serve` / `ng build --watch` terminal tracked by the extension, re-attaching the debugger if a debug session was live                                            |
| **npm: Install**                   | —                | Runs `npm install` (or a custom command) and streams output to the "Angular CLI Plus: npm" output channel                                                                                          |
| **npm: Clean Install**             | —                | Removes `node_modules` and `package-lock.json`, then runs a fresh install; offers a `--force` retry on failure                                                                                     |
| **Angular: Run npm Script**        | `Ctrl+Shift+A N` | Searchable QuickPick of all scripts in `package.json`; runs the selected one in a dedicated terminal                                                                                               |

Terminal commands detect their exit code: on success a brief info notification is shown; on failure a warning appears with a **Retry** button that re-runs the exact same command.

## Debugging

| Command                          | Shortcut         | Description                                                                                                                                                                                  |
| -------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Angular: Debug Application**   | `Ctrl+Shift+A D` | Starts `ng serve`, waits for the dev server to be ready, then automatically attaches a browser debugger                                                                                      |
| **Angular: Debug Storybook**     | `Ctrl+Shift+A P` | Detects Storybook from `angular.json` architect targets or the `storybook` npm script, starts it, waits for the port, and attaches a browser debugger                                        |
| **Angular: Debug Build (Watch)** | `Ctrl+Shift+A H` | Runs `ng build --watch` alongside a configurable static file server (default: `npx serve`), waits for the server, and attaches a browser debugger; both terminals stop when the session ends |

Supported debug browsers (`angularCliPlus.debug.browser`): **Chrome**, **Edge**, **Brave**, **Opera**, **Opera GX**, **Firefox** (requires the "Debugger for Firefox" extension), and **Safari** (macOS only, requires the "Safari Debugger" extension). A custom executable path can be supplied via `angularCliPlus.debug.browserExecutablePath` — useful for other Chromium browsers such as Vivaldi or Arc.

## Code Analysis Tools

### Memory Leak Detection

**Angular: Check Memory Leaks** (`Ctrl+Shift+A K`) analyzes every `.component.ts`, `.service.ts`, `.directive.ts`, `.pipe.ts`, and `.guard.ts` file using the TypeScript Compiler API and reports eight categories of potential leaks in an interactive Webview panel:

- **Unguarded subscribe** — `subscribe()` calls not protected by `untilDestroyed()` / `takeUntilDestroyed()`
- **Nested subscribe** — `subscribe()` inside another `subscribe()` callback (inter-procedural, up to 10 call levels)
- **Uncleared interval** — `setInterval()` not cleared in `ngOnDestroy`
- **Uncleared timeout** — `setTimeout()` stored on `this` and not cleared in `ngOnDestroy`
- **Unremoved event listener** — `addEventListener()` not matched by a `removeEventListener()` reachable from `ngOnDestroy`
- **Unremoved Renderer listener** — `Renderer2.listen()` cleanup not called in `ngOnDestroy`
- **Retained DOM reference** — `document.getElementById()` / `querySelector()` results stored on `this` and not nulled
- **Incomplete destroy subject** — a `Subject` used in `takeUntil()` that is never completed in `ngOnDestroy`

The panel groups leaks by file with clickable source links, colour-coded kind badges, per-kind pill filters, a stats bar, and a **Reload** button. A scope QuickPick lets you analyze the whole workspace, a single folder, or a custom glob pattern.

### Performance Optimizations

**Angular: Check Optimizations** (`Ctrl+Shift+A O`) scans Angular source files for common performance pitfalls and presents them in an interactive Webview panel:

- **Missing OnPush** — components without `ChangeDetectionStrategy.OnPush`
- **Missing trackBy** — `*ngFor` loops lacking a `trackBy` function
- **Function in Template** — function calls inside template bindings (intelligently excludes Signals: `signal`, `computed`, `input`, `model`)
- **Unnecessary Zone.js Work** — async tasks (`setTimeout`, `setInterval`, `requestAnimationFrame`) not wrapped in `runOutsideAngular`
- **Large Component** — combined TS + HTML size over 300 lines
- **Getter in Template** — class getters called from template bindings
- **Heavy Lifecycle Hook** — loops or heavy array operations inside high-frequency hooks
- **Index as trackBy** — loop index used as the `trackBy` identifier (also `@for ... track $index`)
- **Unshared Async Pipe** — multiple `async` pipes subscribing to the same unshared Observable
- **High Frequency Event** — high-frequency DOM events (`scroll`, `mousemove`, …) bound directly in the template
- **Complex Template** — templates exceeding a high number of bindings and directives

### Build Errors

**Angular: Check Build Errors** (`Ctrl+Shift+A E`) runs an Angular build in the background, parses the output for TypeScript and Angular CLI errors, and presents them in an interactive Webview panel with clickable source links, direct links to the official Angular error reference for NG error codes, and collapsible stack traces. Parsing adapts to the detected builder (Webpack vs ESBuild) and handles ANSI colors and Unicode symbols.

### Lint Panel

**Angular: Lint Project** (`Ctrl+Shift+A L`) runs `ng lint --format json` and presents every problem in a rich UI:

- **Sort by file or by problem type** — toggle between grouping by source file or ESLint rule, instantly re-rendered from cached results
- **Hybrid auto-fix buttons** — auto-fixable problems get a native **Fix** button (per issue, per file, or project-wide **Fix all auto-fixable**) that runs `eslint --fix` and automatically re-lints; non-fixable problems get an AI fix button
- **Severity & fixability filters** — toggle pills for errors/warnings and fixable/manual problems
- **Per-issue details** — severity and rule pills, rule messages, and clickable line links
- **All projects** option to lint every project in the workspace and merge the results
- One-click **Add angular-eslint** when a project has no lint target configured

### Signal Graph

**Angular: Show Signal Graph** (`Ctrl+Shift+A G`) analyzes the currently open TypeScript file with the TypeScript Compiler API, discovers all Angular Signals (`signal()`, `input()`, `computed()`, `effect()`, `output()`), traces their dependencies up to 10 call levels deep, and renders an interactive dependency graph powered by [Mermaid.js](https://mermaid.js.org/) (bundled locally — no network required). Nodes are colour-coded and shaped by kind, edges are drawn from every signal read inside a `computed()`/`effect()` factory and from `output()` signals to their `.emit()` call sites, and clicking a node jumps straight to its declaration.

## AI-Powered Auto-Fix

Every diagnostic row in the **Memory Leaks**, **Optimizations**, **Build Errors**, and **Lint** panels includes a sparkle (✨) button that opens your AI assistant with a fix prompt tailored to the specific code snippet and issue type. File-level "fix all" buttons let the AI process every issue in a file at once.

Two providers are supported:

- **GitHub Copilot** (default) — opens Copilot Chat with the prompt
- **Claude Code** — opens the Claude Code panel with the prompt pre-filled

Configure via `angularCliPlus.ai.provider` and `angularCliPlus.ai.autoFixEnabled`.

## JSON Config Manager

**Angular: Manage JSON Configs** (`Ctrl+Shift+A J`) lets you edit configuration files in a dedicated Webview. The picker only lists files that actually exist, and all edits are written back with [jsonc-parser](https://www.npmjs.com/package/jsonc-parser), preserving comments, key order, and formatting.

- **ESLint** (`eslint.config.json`, `.eslintrc.json`, `eslint.config.js`/`.mjs`/`.cjs`/`.ts`, `.eslintrc.js`/`.cjs`) — rules grouped by package (`eslint` core, `@typescript-eslint`, `@angular-eslint`, …), with the full rule catalog discovered from your installed plugins and current severities read from `eslint --print-config`. A per-rule **off / warn / error** dropdown writes the change back, preserving rule options. JS/TS configs are edited with a surgical TypeScript-AST splice that preserves comments and formatting.
- **TypeScript** (`tsconfig.json`, `tsconfig.app.json`, `tsconfig.spec.json`) — curated `compilerOptions` and `angularCompilerOptions` rendered as typed controls (toggles, dropdowns, text/number inputs) with presence toggles and an **Add option** row for arbitrary keys.
- **angular.json** — split by project, architect target, and scope (options or a named configuration). The option catalog adapts to the detected Angular version and builder, and any uncovered keys are still rendered so nothing is hidden.

## Angular Migrations

**Angular: Run Migrations** (`Ctrl+Shift+A M`) provides integrated support for all official Angular migrations from [angular.dev/reference/migrations](https://angular.dev/reference/migrations). A categorized QuickPick lists the 13 available migrations (Standalone, Control Flow Syntax, `inject()` Function, Lazy-loaded Routes, Signal Inputs/Outputs/Queries, Clean Up Unused Imports, Self-closing Tags, NgClass to Class, NgStyle to Style, Router Testing Module, CommonModule to Standalone), lets you select a target project, and runs `ng generate @angular/core:migration-name --project "project-name"` in a terminal with success notifications and retry support.

## Auto Import Missing Imports

**Angular: Auto Import Missing Imports** (`Ctrl+Shift+A I`) scans the active file's template corpus (inline `template:` plus external `templateUrl` HTML) for element tags, attribute/structural directives, and pipes that are not covered by any entry of the decorators' `imports: [...]` array, and adds everything in one edit pass: new `import { Symbol } from '...';` statements after the last import, identifiers appended into each component's existing array (formatting-aware), and a freshly created array on decorators that don't have one yet. Symbols are resolved against a workspace index of exported `@Component`/`@Directive`/`@Pipe` classes (relative imports and barrels are followed) plus a built-in map of common Angular exports (`NgIf`, `NgFor`, `CommonModule`, `FormsModule`, `RouterLink`, `RouterOutlet`, `AsyncPipe`, `DatePipe`, …). When invoked on an `.html` template, edits target its owning component file, which is opened afterwards. Anything that cannot be confidently resolved — non-standalone components, unresolvable NgModule entries, ambiguous selectors, native HTML/SVG tags, DOM events, control-flow keywords — is skipped, with skips logged to the diagnostics output channel.

## Package Management

- **Dependency check** — on startup and on every git branch change, the extension verifies that `node_modules` is present and that installed versions satisfy the `package.json` ranges, prompting to run `npm install` when problems are found. Disable with `angularCliPlus.checkDependencies.enabled`.
- **Tool version check** — on startup, the `engines` field in `package.json` is verified against the installed Node.js, npm, yarn, and pnpm versions, with update offers and download links when a mismatch is found. Disable with `angularCliPlus.checkToolVersions.enabled`.
- **Angular: Update Packages** — see [CLI Commands](#cli-commands).
- **Angular: Setup .npmrc Auth Tokens** (`Ctrl+Shift+A A`) — extracts registry URLs from your workspace `.npmrc`, prompts for Personal Access Tokens for missing registries, and securely configures your global `~/.npmrc`.

## Productivity Tools

- **Angular: Switch Component File** (`Ctrl+Shift+A Tab`) — quickly switch between a component's related files (`.component.ts`, `.component.html`, styles, `.spec.ts`) via a QuickPick with descriptive icons; the current file is pre-selected.
- **Angular: Auto Import Missing Imports** (`Ctrl+Shift+A I`) — one-shot fix for missing standalone imports; see [Auto Import Missing Imports](#auto-import-missing-imports).
- **Close Terminals** (`Ctrl+Shift+A C`) — a searchable, multi-select QuickPick of all extension-managed terminals showing their state (`running`, `terminated`, `errored`, `killed`); finished terminals are pre-selected so pressing Enter clears them immediately.
- **Angular CLI version detection** — the extension detects the Angular CLI version per workspace (via `ng version`, cached and invalidated on `package.json` changes) and adapts commands: `--prod` vs `--configuration=production`, standalone flag handling, Vitest UI availability, and `dist/<project>/` vs `dist/<project>/browser/` output paths.
- **Terminal management** — terminals are reused for the same command (offering Restart / Show for running serve/watch terminals), re-adopted after a VS Code reload, and tracked with their exit state.

## Code Snippets

The extension bundles 65 snippets for Angular development — 33 for TypeScript and 32 for HTML.

<details>
<summary><strong>TypeScript snippets (33)</strong></summary>

| Prefix                       | Description                       |
| ---------------------------- | --------------------------------- |
| `a`                          | Angular starter                   |
| `a-component`                | Component with OnPush             |
| `a-directive`                | Attribute directive               |
| `a-guard-can-activate`       | `CanActivateFn` guard             |
| `a-guard-can-activate-child` | `CanActivateChildFn` guard        |
| `a-guard-can-deactivate`     | `CanDeactivateFn` guard           |
| `a-guard-can-match`          | `CanMatchFn` guard                |
| `a-http-interceptor`         | Class-based `HttpInterceptor`     |
| `a-http-interceptor-fn`      | Functional `HttpInterceptorFn`    |
| `a-bootstrap-app`            | `bootstrapApplication` app config |
| `a-pipe`                     | Pipe                              |
| `a-routes`                   | Routes array                      |
| `a-service`                  | Root-provided service             |
| `a-service-scoped`           | Scoped service                    |
| `a-signal`                   | `signal()`                        |
| `a-computed`                 | `computed()`                      |
| `a-linked-signal`            | `linkedSignal()`                  |
| `a-effect`                   | `effect()`                        |
| `a-input-signal`             | `input()`                         |
| `a-input-required`           | `input.required()`                |
| `a-output-signal`            | `output()`                        |
| `a-model-signal`             | `model()`                         |
| `a-to-signal`                | `toSignal()`                      |
| `a-to-observable`            | `toObservable()`                  |
| `a-resource`                 | `resource()`                      |
| `a-http-resource`            | `httpResource()`                  |
| `a-view-child`               | `viewChild()` query               |
| `a-view-children`            | `viewChildren()` query            |
| `a-content-child`            | `contentChild()` query            |
| `a-content-children`         | `contentChildren()` query         |
| `a-inject`                   | `inject()`                        |
| `a-test-signal-component`    | Signal component test             |
| `a-test-harness`             | Component harness boilerplate     |

</details>

<details>
<summary><strong>HTML snippets (32)</strong></summary>

| Prefix                | Description                             |
| --------------------- | --------------------------------------- |
| `a-`                  | Angular starter                         |
| `a-class`             | Class binding                           |
| `a-style`             | Style binding                           |
| `a-event`             | Event binding                           |
| `a-attr`              | Attribute binding                       |
| `a-banana-in-a-box`   | Two-way binding `[(ngModel)]`           |
| `a-for`               | `@for` with track                       |
| `a-for-empty`         | `@for` with `@empty`                    |
| `a-form`              | Reactive form                           |
| `a-formArrayName`     | `formArrayName`                         |
| `a-formControlName`   | `formControlName`                       |
| `a-formGroup`         | `formGroup`                             |
| `a-formGroupName`     | `formGroupName`                         |
| `a-if`                | `@if`                                   |
| `a-if-else`           | `@if` / `@else`                         |
| `a-if-elseif`         | `@if` / `@else if` / `@else`            |
| `a-formModel`         | `ngModel` form                          |
| `a-routerLink`        | `routerLink`                            |
| `a-routerLink-param`  | `routerLink` with params                |
| `a-switch`            | `@switch`                               |
| `a-switch-case`       | `@case` / `@default`                    |
| `a-ng-container`      | `ng-container`                          |
| `a-ng-content`        | `ng-content`                            |
| `a-ng-content-select` | `ng-content` with select                |
| `a-ng-template`       | `ng-template`                           |
| `a-router-outlet`     | `router-outlet`                         |
| `a-component-outlet`  | `ng-component-outlet`                   |
| `a-defer`             | `@defer` with placeholder/loading/error |
| `a-defer-trigger`     | `@defer` with triggers                  |
| `a-defer-simple`      | Simple `@defer`                         |
| `a-defer-time`        | `@defer` with timer                     |
| `a-defer-idle`        | `@defer` on idle                        |

</details>

## Keyboard Shortcuts

All shortcuts use the `Ctrl+Shift+A` chord (use `Cmd+Shift+A` on macOS):

| Shortcut           | Command                           |
| ------------------ | --------------------------------- |
| `Ctrl+Shift+A D`   | Angular: Debug Application        |
| `Ctrl+Shift+A P`   | Angular: Debug Storybook          |
| `Ctrl+Shift+A H`   | Angular: Debug Build (Watch)      |
| `Ctrl+Shift+A S`   | Angular: Serve Application        |
| `Ctrl+Shift+A B`   | Angular: Build Project            |
| `Ctrl+Shift+A R`   | Angular: Restart Serve            |
| `Ctrl+Shift+A W`   | Angular: Build Project (Watch)    |
| `Ctrl+Shift+A T`   | Angular: Test Project             |
| `Ctrl+Shift+A L`   | Angular: Lint Project             |
| `Ctrl+Shift+A U`   | Angular: Update Packages          |
| `Ctrl+Shift+A C`   | Close Terminals                   |
| `Ctrl+Shift+A Tab` | Angular: Switch Component File    |
| `Ctrl+Shift+A N`   | Angular: Run npm Script           |
| `Ctrl+Shift+A K`   | Angular: Check Memory Leaks       |
| `Ctrl+Shift+A G`   | Angular: Show Signal Graph        |
| `Ctrl+Shift+A A`   | Angular: Setup .npmrc Auth Tokens |
| `Ctrl+Shift+A O`   | Angular: Check Optimizations      |
| `Ctrl+Shift+A E`   | Angular: Check Build Errors       |
| `Ctrl+Shift+A J`   | Angular: Manage JSON Configs      |
| `Ctrl+Shift+A M`   | Angular: Run Migrations           |
| `Ctrl+Shift+A I`   | Angular: Auto Import Missing Imports |

## Extension Settings

### Schematic defaults

| Setting                                    | Default   | Description                                                     |
| ------------------------------------------ | --------- | --------------------------------------------------------------- |
| `angularCliPlus.component.standalone`      | `true`    | Whether generated components should be standalone               |
| `angularCliPlus.component.skipTests`       | `false`   | Skip creating spec.ts test files for components                 |
| `angularCliPlus.component.inlineStyle`     | `false`   | Include styles inline in the component.ts file                  |
| `angularCliPlus.component.inlineTemplate`  | `false`   | Include template inline in the component.ts file                |
| `angularCliPlus.component.style`           | `css`     | Style file extension: `css`, `scss`, `sass`, `less`, `none`     |
| `angularCliPlus.component.changeDetection` | `Default` | Change detection strategy: `Default` or `OnPush`                |
| `angularCliPlus.component.flat`            | `false`   | Create component files at the top level of the current folder   |
| `angularCliPlus.service.skipTests`         | `false`   | Skip creating spec.ts test files for services                   |
| `angularCliPlus.service.flat`              | `true`    | Create service files at the top level of the current folder     |
| `angularCliPlus.module.flat`               | `false`   | Create module files at the top level of the current folder      |
| `angularCliPlus.module.routing`            | `false`   | Create a routing module                                         |
| `angularCliPlus.directive.standalone`      | `true`    | Whether generated directives should be standalone               |
| `angularCliPlus.directive.skipTests`       | `false`   | Skip creating spec.ts test files for directives                 |
| `angularCliPlus.directive.flat`            | `true`    | Create directive files at the top level of the current folder   |
| `angularCliPlus.pipe.standalone`           | `true`    | Whether generated pipes should be standalone                    |
| `angularCliPlus.pipe.skipTests`            | `false`   | Skip creating spec.ts test files for pipes                      |
| `angularCliPlus.pipe.flat`                 | `true`    | Create pipe files at the top level of the current folder        |
| `angularCliPlus.guard.functional`          | `true`    | Generate the guard as a function                                |
| `angularCliPlus.guard.skipTests`           | `false`   | Skip creating spec.ts test files for guards                     |
| `angularCliPlus.guard.flat`                | `true`    | Create guard files at the top level of the current folder       |
| `angularCliPlus.interceptor.functional`    | `true`    | Create the interceptor as an `HttpInterceptorFn`                |
| `angularCliPlus.interceptor.skipTests`     | `false`   | Skip creating spec.ts test files for interceptors               |
| `angularCliPlus.interceptor.flat`          | `true`    | Create interceptor files at the top level of the current folder |
| `angularCliPlus.class.skipTests`           | `false`   | Skip creating spec.ts test files for classes                    |
| `angularCliPlus.resolver.functional`       | `true`    | Create the resolver as a `ResolveFn`                            |
| `angularCliPlus.resolver.skipTests`        | `false`   | Skip creating spec.ts test files for resolvers                  |
| `angularCliPlus.resolver.flat`             | `true`    | Create resolver files at the top level of the current folder    |

### Debugging

| Setting                                         | Default                            | Description                                                                                     |
| ----------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| `angularCliPlus.debug.browser`                  | `chrome`                           | Browser for debug sessions: `chrome`, `edge`, `brave`, `opera`, `opera-gx`, `firefox`, `safari` |
| `angularCliPlus.debug.browserExecutablePath`    | `""`                               | Optional path to the browser executable; overrides automatic detection                          |
| `angularCliPlus.storybook.port`                 | `0`                                | Port Storybook runs on; `0` auto-detects from angular.json or uses 6006                         |
| `angularCliPlus.buildWatch.servePort`           | `4201`                             | Port the static file server listens on during a debug build watch session                       |
| `angularCliPlus.buildWatch.staticServerCommand` | `npx serve {outputPath} -l {port}` | Static server command; use `{outputPath}` and `{port}` as placeholders                          |

### Build, watch & test

| Setting                              | Default       | Description                                                                             |
| ------------------------------------ | ------------- | --------------------------------------------------------------------------------------- |
| `angularCliPlus.build.configuration` | `production`  | Configuration for `ng build`: `default`, `production`, `development`                    |
| `angularCliPlus.watch.configuration` | `development` | Configuration for `ng build --watch`: `default`, `inherit`, `production`, `development` |
| `angularCliPlus.test.watch`          | `false`       | Run `ng test` in watch mode                                                             |
| `angularCliPlus.test.ui`             | `false`       | Enable the Vitest UI for interactive test execution (Vitest runner only)                |

### Checks & updates

| Setting                                    | Default | Description                                                                     |
| ------------------------------------------ | ------- | ------------------------------------------------------------------------------- |
| `angularCliPlus.checkDependencies.enabled` | `true`  | Check npm dependencies on open and on git branch change                         |
| `angularCliPlus.checkToolVersions.enabled` | `true`  | Check Node.js/npm/yarn/pnpm versions against `engines` on startup               |
| `angularCliPlus.update.allowDirty`         | `false` | Allow `ng update` with uncommitted changes (`--allow-dirty`)                    |
| `angularCliPlus.npm.installCommand`        | `""`    | Custom command for npm: Install (e.g. `yarn install`); empty uses `npm install` |
| `angularCliPlus.npm.cleanInstallCommand`   | `""`    | Custom command for npm: Clean Install; empty uses the default clean flow        |

### AI

| Setting                            | Default   | Description                                      |
| ---------------------------------- | --------- | ------------------------------------------------ |
| `angularCliPlus.ai.provider`       | `copilot` | AI assistant for auto-fix: `copilot` or `claude` |
| `angularCliPlus.ai.autoFixEnabled` | `true`    | Show "Auto Fix" buttons in the analysis webviews |

### On-save

| Setting                                  | Default | Description                                                                                                              |
| ---------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `angularCliPlus.autoCleanImports.enabled` | `false` | Remove unused entries from the `imports` array of standalone `@Component`/`@Directive`/`@Pipe` decorators when saving `.ts` files |

Entries are only removed when the identifier is unused elsewhere in the file and its resolved `selector`/pipe name does not appear in any of the file's templates (inline or `templateUrl`). Anything that cannot be confidently resolved — non-relative specifiers like `@angular/common`, NgModule barrels, exotic selectors, spread elements — is always kept.

## Recommended Extensions

- [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) — for AI-powered auto-fix
- [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) — alternative AI provider for auto-fix
- [Angular Language Service](https://marketplace.visualstudio.com/items?itemName=angular.ng-template) — enhanced Angular template editing

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

```bash
npm install
npm run watch      # compile + typecheck + lint in watch mode
npm run test       # run the extension test suite
npm run package    # production build
```

## License

This project is licensed under the terms of the [LICENSE](LICENSE) file.
