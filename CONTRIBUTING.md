# Contributing to Angular CLI Plus

## Architecture overview

The extension source lives entirely in `src/` and is split into focused modules:

| File | Responsibility |
|---|---|
| `extension.ts` | VS Code activation entry point — registers commands and wires up listeners, nothing else |
| `types.ts` | Shared TypeScript interfaces and type aliases (no runtime code) |
| `state.ts` | Module-level singletons: output channels, shared Maps/Sets, extension context accessor |
| `pure-utils.ts` | **Zero VS Code dependency** — pure functions (`semverSatisfies`, `buildNgGenerateCommand`, `toKebabCase`, `validateCustomCommand`, `isValidSchematicName`). Unit-tested without VS Code. |
| `utils.ts` | VS Code helpers: workspace resolution, project picking, `runInTerminal`, `angular.json` cache |
| `schematics.ts` | `ng generate` command — prompts, project detection, option building |
| `commands.ts` | Angular CLI commands: serve, build, test, lint, update, clear terminals |
| `debug.ts` | Browser debug sessions, port polling (`waitForPort`), restart logic |
| `dependencies.ts` | Dependency checking, `semver` validation, npm install, tool version checking |

```
extension.ts
├── schematics.ts  ──► pure-utils.ts
├── commands.ts    ──► utils.ts ──► pure-utils.ts
│                                └─ state.ts
├── debug.ts       ──► utils.ts
│                  └─ state.ts
└── dependencies.ts──► pure-utils.ts
                   └─ state.ts
```

## Setup

```bash
git clone https://github.com/danisss9/AngularCliPlus
cd AngularCliPlus
npm install
```

Open the folder in VS Code. Press `F5` to launch the **Extension Development Host** — a second VS Code window that has the extension loaded from source.

## Build commands

| Command | Description |
|---|---|
| `npm run compile` | Type-check + lint + bundle (esbuild, dev mode) |
| `npm run package` | Type-check + lint + bundle (esbuild, production) |
| `npm run watch` | Watch mode: parallel esbuild + tsc |
| `npm run check-types` | TypeScript type check only (`tsc --noEmit`) |
| `npm run lint` | ESLint |
| `npm run compile-tests` | Compile tests to `out/` with `tsc` |
| `npm test` | Compile tests then run them inside VS Code via `@vscode/test-cli` |

## Testing

Unit tests live in `src/test/extension.test.ts`. They cover the pure functions in `pure-utils.ts` and run inside VS Code via Mocha:

```bash
npm test
```

When adding a new pure utility, add it to `pure-utils.ts` and write tests in `src/test/extension.test.ts`. Functions that depend on the VS Code API should be tested manually via the Extension Development Host (`F5`).

## Releasing

Releases are triggered by pushing a tag that matches `acp_*`:

```bash
git tag acp_1.4.0
git push origin acp_1.4.0
```

The GitHub Actions workflow (`.github/workflows/publish.yml`) will:
1. Package the VSIX with `@vscode/vsce`
2. Create a GitHub Release
3. Publish to the VS Code Marketplace (requires the `MARKETPLACE_PAT` secret)

Update `package.json` `"version"` and add a `CHANGELOG.md` entry before tagging.
