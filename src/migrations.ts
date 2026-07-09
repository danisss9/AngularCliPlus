import * as vscode from 'vscode';
import { runInTerminal, buildAngularCliTerminalCommand, pickProjectWithCurrentFile, resolveWorkspaceAndAngularJson } from './utils';

// List of available Angular migrations from https://angular.dev/reference/migrations
export interface AngularMigration {
  name: string;
  label: string;
  description: string;
  command: string;
  category: string;
}

const AVAILABLE_MIGRATIONS: AngularMigration[] = [
  {
    name: 'standalone',
    label: 'Standalone Components',
    description: 'Convert components, directives, and pipes to standalone',
    command: '@angular/core:standalone',
    category: 'Core',
  },
  {
    name: 'control-flow',
    label: 'Control Flow Syntax',
    description: 'Migrate to the new built-in control flow syntax (@if, @for, @switch)',
    command: '@angular/core:control-flow',
    category: 'Core',
  },
  {
    name: 'inject-function',
    label: 'inject() Function',
    description: 'Migrate to the new inject() function for dependency injection',
    command: '@angular/core:inject-function',
    category: 'Core',
  },
  {
    name: 'route-lazy-loading',
    label: 'Lazy-loaded Routes',
    description: 'Convert eagerly loaded routes to lazy-loaded routes',
    command: '@angular/core:route-lazy-loading',
    category: 'Core',
  },
  {
    name: 'signal-inputs',
    label: 'Signal Inputs',
    description: 'Convert @Input() to the new signal input() API',
    command: '@angular/core:signal-inputs',
    category: 'Core',
  },
  {
    name: 'outputs',
    label: 'Signal Outputs',
    description: 'Convert @Output() to the new output() function',
    command: '@angular/core:outputs',
    category: 'Core',
  },
  {
    name: 'signal-queries',
    label: 'Signal Queries',
    description: 'Convert @ViewChild/@ContentChild to signal queries',
    command: '@angular/core:signal-queries',
    category: 'Core',
  },
  {
    name: 'cleanup-unused-imports',
    label: 'Clean Up Unused Imports',
    description: 'Remove unused imports from your project',
    command: '@angular/core:cleanup-unused-imports',
    category: 'Core',
  },
  {
    name: 'self-closing-tags',
    label: 'Self-closing Tags',
    description: 'Convert templates to use self-closing tags where possible',
    command: '@angular/core:self-closing-tags',
    category: 'Core',
  },
  {
    name: 'ngclass-to-class',
    label: 'NgClass to Class Bindings',
    description: 'Convert NgClass directives to class bindings',
    command: '@angular/core:ngclass-to-class',
    category: 'Core',
  },
  {
    name: 'ngstyle-to-style',
    label: 'NgStyle to Style Bindings',
    description: 'Convert NgStyle directives to style bindings',
    command: '@angular/core:ngstyle-to-style',
    category: 'Core',
  },
  {
    name: 'router-testing-module-migration',
    label: 'Router Testing Module',
    description: 'Convert RouterTestingModule to RouterModule with provideLocationMocks()',
    command: '@angular/core:router-testing-module-migration',
    category: 'Core',
  },
  {
    name: 'common-to-standalone',
    label: 'CommonModule to Standalone',
    description: 'Replace CommonModule imports with individual directive imports',
    command: '@angular/core:common-to-standalone',
    category: 'Core',
  },
];

// Group migrations by category for better organization
function getMigrationsByCategory(migrations: AngularMigration[]): Map<string, AngularMigration[]> {
  const grouped = new Map<string, AngularMigration[]>();
  
  for (const migration of migrations) {
    const category = grouped.get(migration.category) || [];
    category.push(migration);
    grouped.set(migration.category, category);
  }
  
  return grouped;
}

export async function runAngularMigrations(): Promise<void> {
  const resolved = await resolveWorkspaceAndAngularJson();
  if (!resolved) {
    return;
  }
  
  const { workspaceRoot, projects } = resolved;
  
  // Get all application projects (not libraries)
  const appProjects = Object.entries(projects)
    .filter(([, p]) => !p.projectType || p.projectType === 'application')
    .map(([n]) => n);

  if (appProjects.length === 0) {
    vscode.window.showWarningMessage('No Angular application projects found in angular.json.');
    return;
  }

  // Show project picker
  const projectName = await pickProjectWithCurrentFile(
    workspaceRoot,
    projects,
    appProjects,
    'Angular Migrations: Select Project',
    'migrations',
  );
  
  if (!projectName) {
    return;
  }

  // Group migrations by category for the QuickPick
  const migrationsByCategory = getMigrationsByCategory(AVAILABLE_MIGRATIONS);
  
  type MigrationItem = vscode.QuickPickItem & {
    migration: AngularMigration;
    type: 'migration' | 'category';
  };

  const items: MigrationItem[] = [];
  
  // Add category headers
  const categories = Array.from(migrationsByCategory.entries());
  for (const [category, categoryMigrations] of categories) {
    items.push({
      label: `$(folder) ${category}`,
      description: '',
      migration: { name: '', label: category, description: '', command: '', category },
      type: 'category',
    });
    
    // Add migrations under each category
    for (const migration of categoryMigrations) {
      items.push({
        label: `  ${migration.label}`,
        description: migration.description,
        migration,
        type: 'migration',
      });
    }
  }

  const qp = vscode.window.createQuickPick<MigrationItem>();
  qp.items = items;
  qp.placeholder = 'Select a migration to run…';
  qp.title = 'Angular Migrations';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;

  // Prevent selecting category headers
  qp.activeItems = items.filter(item => item.type === 'migration');

  const chosen = await new Promise<MigrationItem | undefined>((resolve) => {
    qp.onDidAccept(() => {
      const selected = qp.selectedItems[0];
      if (selected && selected.type === 'migration') {
        resolve(selected);
        qp.hide();
      }
    });
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
  
  qp.dispose();

  if (!chosen || chosen.type !== 'migration') {
    return;
  }

  const { command: migrationCommand, label: migrationLabel } = chosen.migration;
  
  // Build the full command: ng generate @angular/core:migration-name --project "project-name"
  const fullCommand = buildAngularCliTerminalCommand(
    workspaceRoot,
    `ng generate ${migrationCommand} --project "${projectName}"`,
  );
  
  const terminalName = `ng generate ${migrationCommand} (${projectName})`;
  
  void runInTerminal(terminalName, fullCommand, workspaceRoot, {
    successMessage: `${migrationLabel} migration started successfully for ${projectName}.`,
    retryLabel: 'Retry Migration',
  }).catch((err) => {
    vscode.window.showErrorMessage(`Failed to start migration "${migrationLabel}": ${err}`);
  });
}

// Legacy export for backwards compatibility
export const runMigrations = runAngularMigrations;