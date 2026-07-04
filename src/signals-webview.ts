import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getExtensionContext } from './state';
import type { SignalGraphData, SignalKind } from './signals-ast';
import { createAnalysisPanel, escapeHtml } from './webview-utils';

// ── Entry point ────────────────────────────────────────────────────────────────

/** Each run opens its own tab (the graph is scoped to a specific file/class). */
export function showSignalGraphWebview(data: SignalGraphData): void {
  const context = getExtensionContext();

  const analysisPanel = createAnalysisPanel('angularSignalGraph', buildTitle(data), {
    localResourceRoots: [
      vscode.Uri.joinPath(context.extensionUri, 'dist'),
      ...(vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.map((f) => f.uri) : []),
    ],
  });

  analysisPanel.setHtml(buildWebviewHtml(data, analysisPanel.panel.webview, context.extensionUri));

  analysisPanel.onMessage(
    async (message: { command: string; file: string; line: number }) => {
      if (message.command === 'openFile') {
        const uri = vscode.Uri.file(message.file);
        await vscode.window.showTextDocument(uri, {
          selection: new vscode.Range(
            new vscode.Position(message.line - 1, 0),
            new vscode.Position(message.line - 1, 0),
          ),
          preview: false,
        });
      } else if (message.command === 'installMermaid') {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(data.file));
        if (workspaceFolder) {
          const terminal = vscode.window.createTerminal('Install Mermaid');
          terminal.show();
          terminal.sendText('npm install mermaid -D');
        } else {
          vscode.window.showErrorMessage('Could not determine workspace folder to install Mermaid.');
        }
      }
    },
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildTitle(data: SignalGraphData): string {
  const base = data.className ?? path.basename(data.file, '.ts');
  return `Signal Graph: ${base}`;
}

function sanitizeId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

function shapeWrap(label: string, kind: SignalKind): string {
  switch (kind) {
    case 'signal':
      return `(["${label}"])`; // stadium / pill
    case 'input':
      return `[/"${label}"/]`; // parallelogram
    case 'computed':
      return `[["${label}"]]`; // subroutine
    case 'effect':
      return `{{"${label}"}}`; // hexagon
    case 'output':
      return `>"${label}"]`; // asymmetric flag
    default:
      return `["${label}"]`;
  }
}

// ── Mermaid graph builder ──────────────────────────────────────────────────────

interface NodeMeta {
  file: string;
  line: number;
}

/** Allocates a stable, collision-free id per name within one graph build (`sanitizeId` alone can map distinct names like `foo.bar` and `foo_bar` to the same id). */
function makeIdAllocator(): (name: string) => string {
  const seen = new Map<string, string>();
  const used = new Set<string>();
  return (name: string) => {
    const existing = seen.get(name);
    if (existing) {
      return existing;
    }
    const base = sanitizeId(name);
    let candidate = base;
    let n = 1;
    while (used.has(candidate)) {
      candidate = `${base}_${n++}`;
    }
    used.add(candidate);
    seen.set(name, candidate);
    return candidate;
  };
}

function buildMermaidGraph(data: SignalGraphData): {
  mermaidGraph: string;
  nodeDataMap: Record<string, NodeMeta>;
} {
  const lines: string[] = ['flowchart LR'];
  const nodeDataMap: Record<string, NodeMeta> = {};
  const idFor = makeIdAllocator();

  for (const node of data.nodes) {
    const id = idFor(node.name);
    const label = `${node.kind}: ${node.name}`;
    lines.push(`  ${id}${shapeWrap(label, node.kind)}`);
    nodeDataMap[id] = { file: node.file, line: node.line };
  }

  lines.push('');

  for (const edge of data.edges) {
    const fromId = idFor(edge.from);
    const toId = idFor(edge.to);
    const arrow = edge.label ? `-- ${edge.label} -->` : '-->';
    lines.push(`  ${fromId} ${arrow} ${toId}`);
  }

  lines.push('');

  for (const node of data.nodes) {
    const id = idFor(node.name);
    lines.push(`  click ${id} __signalNodeClick`);
  }

  lines.push('');
  lines.push('  classDef signal fill:#1a5276,stroke:#4fc3f7,color:#e0f7fa');
  lines.push('  classDef input fill:#1b5e20,stroke:#81c784,color:#e8f5e9');
  lines.push('  classDef computed fill:#4a148c,stroke:#ce93d8,color:#f3e5f5');
  lines.push('  classDef effect fill:#7d3200,stroke:#ffb74d,color:#fff3e0');
  lines.push('  classDef output fill:#7f0000,stroke:#ef9a9a,color:#ffebee');
  lines.push('');

  const byKind = new Map<string, string[]>();
  for (const node of data.nodes) {
    const ids = byKind.get(node.kind) ?? [];
    ids.push(idFor(node.name));
    byKind.set(node.kind, ids);
  }
  for (const [kind, ids] of byKind.entries()) {
    lines.push(`  class ${ids.join(',')} ${kind}`);
  }

  return { mermaidGraph: lines.join('\n'), nodeDataMap };
}

// ── HTML builder ───────────────────────────────────────────────────────────────

function buildWebviewHtml(
  data: SignalGraphData,
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): string {
  let mermaidDiskPath = vscode.Uri.joinPath(extensionUri, 'dist', 'mermaid.min.js');
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(data.file));
  
  if (!fs.existsSync(mermaidDiskPath.fsPath) && workspaceFolder) {
    const wsMermaid = vscode.Uri.joinPath(workspaceFolder.uri, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js');
    if (fs.existsSync(wsMermaid.fsPath)) {
      mermaidDiskPath = wsMermaid;
    }
  }

  const mermaidUri = webview.asWebviewUri(mermaidDiskPath);

  const { mermaidGraph, nodeDataMap } = buildMermaidGraph(data);
  // Escape `<` so a file path or name containing `</script>` can't break out of the inline script.
  const nodeDataJson = JSON.stringify(nodeDataMap).replace(/</g, '\\u003c');
  const cspSource = webview.cspSource;

  const classNameSuffix = data.className ? ` &mdash; ${escapeHtml(data.className)}` : '';
  const nodeCount = data.nodes.length;
  const edgeCount = data.edges.length;
  const fileName = escapeHtml(path.basename(data.file));

  const graphOrEmpty =
    nodeCount === 0
      ? `<div class="empty-state">
          <h2>No Angular signals found in this file.</h2>
          <p>Open a file that contains <code>signal()</code>, <code>input()</code>, <code>computed()</code>, <code>effect()</code>, or <code>output()</code> calls.</p>
        </div>`
      : `<div class="graph-container"><div class="mermaid">\n${mermaidGraph}\n</div></div>`;

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${cspSource} 'unsafe-inline'; style-src 'unsafe-inline';">
  <title>Signal Graph</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 20px 24px 40px;
      line-height: 1.5;
    }

    .header {
      margin-bottom: 20px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    h1 { font-size: 1.15em; font-weight: 600; margin-bottom: 4px; }

    .stats {
      font-size: 0.82em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 10px;
    }

    .legend { display: flex; flex-wrap: wrap; gap: 14px; }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground);
    }

    .legend-swatch {
      width: 28px;
      height: 14px;
      border-radius: 3px;
      border: 1px solid rgba(255,255,255,0.15);
    }

    .graph-container { overflow: auto; border-radius: 6px; padding: 8px 0; }

    .mermaid { display: flex; justify-content: center; }
    .mermaid svg { max-width: 100%; height: auto; }
    .mermaid .node { cursor: pointer; }

    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: var(--vscode-descriptionForeground);
    }

    .empty-state h2 { font-size: 1em; font-weight: 500; margin-bottom: 8px; }
    .empty-state code {
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 4px;
      border-radius: 3px;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Signal Graph${classNameSuffix}</h1>
    <div class="stats">
      ${nodeCount} signal${nodeCount !== 1 ? 's' : ''}
      &middot; ${edgeCount} connection${edgeCount !== 1 ? 's' : ''}
      &middot; ${fileName}
    </div>
    <div class="legend">
      <span class="legend-item"><span class="legend-swatch" style="background:#1a5276;border-color:#4fc3f7"></span>signal</span>
      <span class="legend-item"><span class="legend-swatch" style="background:#1b5e20;border-color:#81c784"></span>input</span>
      <span class="legend-item"><span class="legend-swatch" style="background:#4a148c;border-color:#ce93d8"></span>computed</span>
      <span class="legend-item"><span class="legend-swatch" style="background:#7d3200;border-color:#ffb74d"></span>effect</span>
      <span class="legend-item"><span class="legend-swatch" style="background:#7f0000;border-color:#ef9a9a"></span>output</span>
    </div>
  </div>

  ${graphOrEmpty}

  <script src="${mermaidUri}"></script>
  <script>
    (function () {
      const vscode = acquireVsCodeApi();
      const nodeData = ${nodeDataJson};

      if (typeof mermaid === 'undefined') {
        const container = document.querySelector('.graph-container');
        if (container) {
          container.innerHTML = \`
            <div class="empty-state" style="margin-top: 40px;">
              <h2 style="margin-bottom: 12px; color: var(--vscode-errorForeground);">Mermaid is not available</h2>
              <p style="margin-bottom: 8px;">The Signal Graph requires the <strong>mermaid</strong> package to render.</p>
              <p style="font-size: 0.9em; opacity: 0.8; margin-bottom: 20px;">Please install it in your workspace to enable this feature.</p>
              <button id="install-btn" style="padding: 8px 16px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; border-radius: 2px; font-weight: 500;">Install Mermaid</button>
            </div>
          \`;
          document.getElementById('install-btn').addEventListener('click', function() {
            vscode.postMessage({ command: 'installMermaid' });
          });
        }
        return;
      }

      window.__signalNodeClick = function (nodeId) {
        const data = nodeData[nodeId];
        if (data) {
          vscode.postMessage({ command: 'openFile', file: data.file, line: data.line });
        }
      };

      mermaid.initialize({
        startOnLoad: true,
        securityLevel: 'loose',
        theme: 'dark',
        flowchart: { curve: 'basis', useMaxWidth: true },
      });
    })();
  </script>
</body>
</html>`;
}
