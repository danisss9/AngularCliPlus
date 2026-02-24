# NG Generate for VS Code

A VS Code extension that allows you to run NG CLI generate commands directly from the folder context menu in the Explorer.

## Features

- **Right-click context menu integration**: Generate angular schematics by right-clicking any folder in the Explorer
- **Organized submenu**: All generate commands in a single "NG Generate" submenu
- **Configurable defaults**: Set default options for all generate commands in VS Code settings
- **Simple workflow**: Only prompts for the name, all other options use configured defaults
- **Smart project detection**: Automatically detects the Angular project from `angular.json` based on the folder you right-clicked
- **Supports all major angular schematics**:
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

## Usage

1. Right-click on any folder in the VS Code Explorer
2. Select "ng Generate" from the context menu
3. Choose the type of schematic you want to generate (Component, Service, etc.)
4. Enter the name for the item you want to generate
5. The extension automatically detects the Angular project from `angular.json`:
   - If one project matches the selected folder it is used automatically
   - If multiple projects match you will be prompted to choose from a list
   - If no projects match you can type the project name manually (leave empty for the default project)
6. The extension will run the Angular CLI command with your configured default options in the selected folder

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
