import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { ngOutput, extensionTerminals } from './state';
import {
  resolveWorkspaceAndAngularJson,
  runInTerminal,
  pickProjectWithCurrentFile,
  detectActiveFileProject,
  getLastProject,
  setLastProject,
} from './utils';
import { spawnCapture } from './dependencies';
import { parseNgUpdateOutput } from './pure-utils';

// ── Serve ─────────────────────────────────────────────────────────────────────

export async function serveAngularProject() {
  const resolved = await resolveWorkspaceAndAngularJson();
  if (!resolved) {
    return;
  }
  const { workspaceRoot, projects } = resolved;

  const appProjects = Object.entries(projects)
    .filter(([, p]) => !p.projectType || p.projectType === 'application')
    .map(([n]) => n);

  const projectName = await pickProjectWithCurrentFile(
    workspaceRoot,
    projects,
    appProjects,
    'Angular Serve: Select Project',
    'serve',
  );
  if (!projectName) {
    return;
  }

  const serveCommand = `ng serve --project "${projectName}"`;
  const terminalName = `ng serve (${projectName})`;
  runInTerminal(terminalName, serveCommand, workspaceRoot, { trackAsServe: true });
}

// ── Test ──────────────────────────────────────────────────────────────────────

export async function testAngularProject() {
  const resolved = await resolveWorkspaceAndAngularJson();
  if (!resolved) {
    return;
  }
  const { workspaceRoot, projects } = resolved;

  const testableProjects = Object.entries(projects)
    .filter(([, p]) => p.architect?.test !== undefined)
    .map(([n]) => n);

  if (testableProjects.length === 0) {
    vscode.window.showWarningMessage('No projects with a test architect found in angular.json.');
    return;
  }

  const ALL_PROJECTS = '$(list-flat)  All projects';

  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
  const isSpecFile = activeFile?.endsWith('.spec.ts') ?? false;
  const CURRENT_FILE = '$(file)  Run current test file';

  const currentProject = detectActiveFileProject(workspaceRoot, projects);
  const currentInTestable =
    currentProject && testableProjects.includes(currentProject) ? currentProject : null;
  const CURRENT_PROJECT_LABEL = currentInTestable
    ? `$(file)  Current project (${currentInTestable})`
    : null;

  const lastTest = getLastProject('test');
  const lastInTestable =
    lastTest && testableProjects.includes(lastTest) && lastTest !== currentInTestable
      ? lastTest
      : null;
  const LAST_LABEL = lastInTestable ? `$(history)  Last used (${lastInTestable})` : null;

  const choices = [
    ...(isSpecFile ? [CURRENT_FILE] : []),
    ...(CURRENT_PROJECT_LABEL ? [CURRENT_PROJECT_LABEL] : []),
    ...(LAST_LABEL ? [LAST_LABEL] : []),
    ALL_PROJECTS,
    ...testableProjects,
  ];

  const picked = await vscode.window.showQuickPick(choices, {
    placeHolder: 'Select a project to test, or "All" to run ng test without a project',
    title: 'Angular Test: Select Project',
  });

  if (!picked) {
    return;
  }

  let testCommand: string;
  let terminalName: string;

  const config = vscode.workspace.getConfiguration('angularCliPlus');
  const watchMode = config.get<boolean>('test.watch', false);
  const watchFlag = watchMode ? ' --watch' : ' --watch=false';
  const uiMode = config.get<boolean>('test.ui', false);
  const uiFlag = uiMode ? ' --ui' : '';

  if (picked === CURRENT_FILE && activeFile) {
    const relPath = path.relative(workspaceRoot, activeFile).replaceAll(path.sep, '/');
    testCommand = `ng test --include "${relPath}"${watchFlag}${uiFlag}`;
    terminalName = `ng test (${path.basename(activeFile)})`;
  } else if (CURRENT_PROJECT_LABEL && picked === CURRENT_PROJECT_LABEL) {
    setLastProject('test', currentInTestable!);
    testCommand = `ng test --project "${currentInTestable}"${watchFlag}${uiFlag}`;
    terminalName = `ng test (${currentInTestable})`;
  } else if (LAST_LABEL && picked === LAST_LABEL) {
    testCommand = `ng test --project "${lastInTestable}"${watchFlag}${uiFlag}`;
    terminalName = `ng test (${lastInTestable})`;
  } else if (picked === ALL_PROJECTS) {
    testCommand = `ng test${watchFlag}${uiFlag}`;
    terminalName = 'ng test (all)';
  } else {
    setLastProject('test', picked);
    testCommand = `ng test --project "${picked}"${watchFlag}${uiFlag}`;
    terminalName = `ng test (${picked})`;
  }

  runInTerminal(terminalName, testCommand, workspaceRoot, {
    successMessage: watchMode ? undefined : `${terminalName} completed successfully.`,
    retryLabel: watchMode ? undefined : 'Retry',
  });
}

// ── Lint ──────────────────────────────────────────────────────────────────────

export async function lintAngularProject() {
  const resolved = await resolveWorkspaceAndAngularJson();
  if (!resolved) {
    return;
  }
  const { workspaceRoot, projects } = resolved;

  const allProjects = Object.keys(projects);
  const projectName = await pickProjectWithCurrentFile(
    workspaceRoot,
    projects,
    allProjects,
    'Angular Lint: Select Project',
    'lint',
  );
  if (!projectName) {
    return;
  }

  const terminalName = `ng lint (${projectName})`;
  const lintCommand = `ng lint --project "${projectName}"`;
  runInTerminal(terminalName, lintCommand, workspaceRoot, {
    successMessage: `ng lint (${projectName}) completed successfully.`,
    retryLabel: 'Retry',
  });
}

// ── Build ─────────────────────────────────────────────────────────────────────

export async function buildAngularProject() {
  await runNgBuild(false);
}

export async function buildAngularProjectWatch() {
  await runNgBuild(true);
}

async function runNgBuild(watch: boolean) {
  const resolved = await resolveWorkspaceAndAngularJson();
  if (!resolved) {
    return;
  }
  const { workspaceRoot, projects } = resolved;

  const allProjects = Object.keys(projects);
  const title = watch ? 'Angular Build Watch: Select Project' : 'Angular Build: Select Project';
  const projectName = await pickProjectWithCurrentFile(
    workspaceRoot,
    projects,
    allProjects,
    title,
    watch ? 'buildWatch' : 'build',
  );
  if (!projectName) {
    return;
  }

  const config = vscode.workspace.getConfiguration('angularCliPlus');
  let effectiveConfig: string;
  if (watch) {
    const watchConfig = config.get<string>('watch.configuration', 'development');
    effectiveConfig =
      watchConfig === 'inherit'
        ? config.get<string>('build.configuration', 'production')
        : watchConfig;
  } else {
    effectiveConfig = config.get<string>('build.configuration', 'production');
  }
  const configFlag = effectiveConfig !== 'default' ? ` --configuration=${effectiveConfig}` : '';
  const watchFlag = watch ? ' --watch' : '';

  const terminalName = watch ? `ng build --watch (${projectName})` : `ng build (${projectName})`;
  const buildCommand = `ng build --project "${projectName}"${configFlag}${watchFlag}`;
  runInTerminal(terminalName, buildCommand, workspaceRoot, {
    trackAsServe: watch,
    successMessage: watch ? undefined : `ng build (${projectName}) completed successfully.`,
    retryLabel: watch ? undefined : 'Retry',
  });
}

// ── Clear terminals ───────────────────────────────────────────────────────────

export async function clearFinishedTerminals() {
  if (extensionTerminals.size === 0) {
    vscode.window.showInformationMessage('No extension terminals to close.');
    return;
  }

  type TerminalState = 'running' | 'terminated' | 'errored' | 'killed';

  function getTerminalState(terminal: vscode.Terminal): {
    state: TerminalState;
    label: string;
    icon: string;
  } {
    if (terminal.exitStatus === undefined) {
      return { state: 'running', label: 'running', icon: '$(play)' };
    }
    if (terminal.exitStatus.code === undefined) {
      return { state: 'killed', label: 'killed', icon: '$(circle-slash)' };
    }
    if (terminal.exitStatus.code === 0) {
      return { state: 'terminated', label: 'terminated', icon: '$(check)' };
    }
    return { state: 'errored', label: 'errored', icon: '$(error)' };
  }

  const stateOrder: Record<TerminalState, number> = {
    errored: 0,
    killed: 1,
    terminated: 2,
    running: 3,
  };

  type TerminalItem = vscode.QuickPickItem & { terminal: vscode.Terminal; state: TerminalState };

  const terminals = [...extensionTerminals].sort((a, b) => {
    const sa = getTerminalState(a);
    const sb = getTerminalState(b);
    return stateOrder[sa.state] - stateOrder[sb.state];
  });

  const terminalItems: TerminalItem[] = terminals.map((t) => {
    const { state, label, icon } = getTerminalState(t);
    return {
      label: `${icon} ${t.name}`,
      description: label,
      terminal: t,
      state,
    };
  });

  const qp = vscode.window.createQuickPick<TerminalItem>();
  qp.items = terminalItems;
  qp.canSelectMany = true;
  qp.placeholder = 'Search and select terminals to close...';
  qp.title = 'Close Terminals';
  // Pre-select finished (non-running) terminals
  qp.selectedItems = terminalItems.filter((i) => i.state !== 'running');

  const chosen = await new Promise<TerminalItem[]>((resolve) => {
    qp.onDidAccept(() => {
      resolve([...qp.selectedItems]);
      qp.hide();
    });
    qp.onDidHide(() => resolve([]));
    qp.show();
  });
  qp.dispose();

  for (const item of chosen) {
    item.terminal.dispose();
    extensionTerminals.delete(item.terminal);
  }

  if (chosen.length > 0) {
    vscode.window.showInformationMessage(
      `Closed ${chosen.length} terminal${chosen.length > 1 ? 's' : ''}.`,
    );
  }
}

// ── Update packages ───────────────────────────────────────────────────────────

export function spawnNg(args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    ngOutput.appendLine(`> ng ${args.join(' ')}\n`);
    const proc = cp.spawn('ng', args, { cwd, shell: true });
    proc.stdout.on('data', (d: Buffer) => ngOutput.append(d.toString()));
    proc.stderr.on('data', (d: Buffer) => ngOutput.append(d.toString()));
    proc.on('error', (err) => {
      ngOutput.appendLine(`Failed to start process: ${err.message}`);
      resolve(1);
    });
    proc.on('close', (code) => resolve(code ?? 1));
  });
}

export async function updateAngularPackages() {
  const resolved = await resolveWorkspaceAndAngularJson();
  if (!resolved) {
    return;
  }
  const { workspaceRoot } = resolved;

  let capturedOutput = '';
  let checkExitCode = 0;
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Checking for Angular package updates…',
      cancellable: false,
    },
    async () => {
      const result = await spawnCapture('ng', ['update'], workspaceRoot);
      capturedOutput = result.stdout;
      checkExitCode = result.exitCode;
    },
  );

  if (checkExitCode !== 0) {
    ngOutput.clear();
    ngOutput.appendLine(capturedOutput);
    ngOutput.show(true);
    vscode.window.showErrorMessage(
      "Failed to check for Angular updates. See 'Angular CLI Plus: ng' output for details.",
    );
    return;
  }

  const packages = parseNgUpdateOutput(capturedOutput);
  if (packages.length === 0) {
    vscode.window.showInformationMessage('All Angular packages are up to date.');
    return;
  }

  const items = packages.map((p) => ({ label: p.name, description: p.versions, picked: false }));
  const selected = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: 'Select packages to update',
    title: 'Angular Update: Select Packages',
  });

  if (!selected || selected.length === 0) {
    return;
  }

  const config = vscode.workspace.getConfiguration('angularCliPlus');
  const allowDirty = config.get<boolean>('update.allowDirty', false);

  await runNgUpdate(
    selected.map((s) => s.label),
    allowDirty,
    false,
    workspaceRoot,
  );
}

export async function runNgUpdate(
  packages: string[],
  allowDirty: boolean,
  force: boolean,
  workspaceRoot: string,
) {
  const args = ['update', ...packages];
  if (allowDirty) {
    args.push('--allow-dirty');
  }
  if (force) {
    args.push('--force');
  }

  ngOutput.clear();
  ngOutput.show(true);

  const exitCode = await spawnNg(args, workspaceRoot);

  if (exitCode === 0) {
    vscode.window.showInformationMessage('ng update completed successfully.');
    return;
  }

  if (!force) {
    const action = await vscode.window.showErrorMessage(
      'ng update failed. Try with --force?',
      'Run with --force',
    );
    if (action === 'Run with --force') {
      await runNgUpdate(packages, allowDirty, true, workspaceRoot);
    }
  } else {
    vscode.window.showErrorMessage(
      "ng update --force also failed. Check the 'Angular CLI Plus: ng' output for details.",
    );
  }
}
