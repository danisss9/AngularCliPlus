import * as vscode from 'vscode';
import * as path from 'path';
import { getExtensionContext } from './state';
import type { SignalGraphData, SignalKind } from './signals-ast';

// ── State ──────────────────────────────────────────────────────────────────────

let activePanel: vscode.WebviewPanel | undefined;

// ── Entry point ────────────────────────────────────────────────────────────────

export function showSignalGraphWebview(data: SignalGraphData): void {
  const context = getExtensionContext();

  if (activePanel) {
    activePanel.title = buildTitle(data);
    activePanel.webview.html = buildWebviewHtml(data, activePanel.webview, context.extensionUri);
    activePanel.reveal(undefined, true);
  } else {
    activePanel = vscode.window.createWebviewPanel(
      'angularSignalGraph',
      buildTitle(data),
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
      },
    );

    activePanel.webview.html = buildWebviewHtml(data, activePanel.webview, context.extensionUri);

    activePanel.onDidDispose(() => {
      activePanel = undefined;
    });
  }

  activePanel.webview.onDidReceiveMessage(
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
      }
    },
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildTitle(data: SignalGraphData): string {
  const base = data.className ?? path.basename(data.file, '.ts');
  return `Signal Graph: ${base}`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

function buildMermaidGraph(data: SignalGraphData): {
  mermaidGraph: string;
  nodeDataMap: Record<string, NodeMeta>;
} {
  const lines: string[] = ['flowchart LR'];
  const nodeDataMap: Record<string, NodeMeta> = {};

  for (const node of data.nodes) {
    const id = sanitizeId(node.name);
    const label = `${node.kind}: ${node.name}`;
    lines.push(`  ${id}${shapeWrap(label, node.kind)}`);
    nodeDataMap[id] = { file: node.file, line: node.line };
  }

  lines.push('');

  for (const edge of data.edges) {
    const fromId = sanitizeId(edge.from);
    const toId = sanitizeId(edge.to);
    const arrow = edge.label ? `-- ${edge.label} -->` : '-->';
    lines.push(`  ${fromId} ${arrow} ${toId}`);
  }

  lines.push('');

  for (const node of data.nodes) {
    const id = sanitizeId(node.name);
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
    ids.push(sanitizeId(node.name));
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
  const mermaidUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'mermaid.min.js'),
  );

  const { mermaidGraph, nodeDataMap } = buildMermaidGraph(data);
  const nodeDataJson = JSON.stringify(nodeDataMap);
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
