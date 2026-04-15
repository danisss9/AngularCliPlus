import * as vscode from 'vscode';

export interface DebugConfig {
  workspaceFolder: vscode.WorkspaceFolder;
  port: number;
  sessionName: string;
  browserSetting: string;
  browserDebugConfig: BrowserDebugConfig;
}

export interface ServeEntry {
  terminal: vscode.Terminal;
  command: string;
  cwd: string;
  debugConfig?: DebugConfig;
  activeDebugSession?: vscode.DebugSession;
}

export interface GenerateOptions {
  [key: string]: boolean | string;
}

export interface AngularProject {
  root?: string;
  sourceRoot?: string;
  projectType?: string;
  architect?: {
    serve?: {
      options?: {
        port?: number;
      };
    };
    test?: Record<string, unknown>;
    storybook?: {
      options?: {
        port?: number;
      };
    };
    build?: {
      options?: {
        outputPath?: string | { base?: string; browser?: string };
      };
    };
  };
}

export interface AngularJson {
  projects?: { [name: string]: AngularProject };
  defaultProject?: string;
}

export interface PersistedTerminalEntry {
  command: string;
  cwd: string;
  trackAsServe: boolean;
}

export type SchematicType =
  | 'component'
  | 'service'
  | 'module'
  | 'directive'
  | 'pipe'
  | 'guard'
  | 'interceptor'
  | 'class'
  | 'interface'
  | 'enum'
  | 'resolver';

export interface BrowserDebugConfig {
  type: string;
  runtimeExecutable?: string;
}
