import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'node-html-parser';

export type OptimizationKind =
  | 'missing-on-push'
  | 'missing-track-by'
  | 'function-in-template'
  | 'unnecessary-zone-work'
  | 'large-component';

export interface OptimizationLocation {
  file: string;
  line: number;
  character: number;
  snippet: string;
  kind: OptimizationKind;
}

const LARGE_COMPONENT_THRESHOLD = 300;

function snippetAt(source: string, pos: number): string {
  const lineStart = source.lastIndexOf('\n', pos - 1) + 1;
  const lineEnd = source.indexOf('\n', pos);
  return source.substring(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
}

function snippetAtLine(source: string, line: number): string {
  const lines = source.split(/\r?\n/);
  return lines[line - 1]?.trim() || '';
}

function isInsideRunOutsideAngular(node: ts.Node): boolean {
  let curr = node.parent;
  while (curr) {
    if (ts.isCallExpression(curr)) {
      const exp = curr.expression;
      if (ts.isPropertyAccessExpression(exp) && exp.name.text === 'runOutsideAngular') {
        return true;
      }
    }
    curr = curr.parent;
  }
  return false;
}

function collectSignals(sourceFile: ts.SourceFile): Set<string> {
  const signals = new Set<string>();
  function visit(node: ts.Node) {
    if (ts.isPropertyDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      if (node.initializer && ts.isCallExpression(node.initializer)) {
        const exp = node.initializer.expression;
        if (ts.isIdentifier(exp) && ['signal', 'computed', 'input', 'model'].includes(exp.text)) {
          signals.add(node.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return signals;
}

export function findOptimizationsInFile(filePath: string): OptimizationLocation[] {
  let source: string;
  try {
    source = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const results: OptimizationLocation[] = [];
  const signals = collectSignals(sourceFile);

  let hasComponentDecorator = false;
  let htmlFilePath: string | null = null;
  let inlineTemplate: { text: string; pos: number } | null = null;

  // Pass 1: find @Component
  function visitComponent(node: ts.Node) {
    if (ts.isClassDeclaration(node) && node.modifiers) {
      for (const mod of node.modifiers) {
        if (ts.isDecorator(mod) && ts.isCallExpression(mod.expression)) {
          const exp = mod.expression.expression;
          if (ts.isIdentifier(exp) && exp.text === 'Component') {
            hasComponentDecorator = true;
            const args = mod.expression.arguments;
            if (args.length > 0 && ts.isObjectLiteralExpression(args[0])) {
              const obj = args[0];
              let hasOnPush = false;
              
              for (const prop of obj.properties) {
                if (ts.isPropertyAssignment(prop) && prop.name && ts.isIdentifier(prop.name)) {
                  if (prop.name.text === 'changeDetection') {
                    if (prop.initializer.getText(sourceFile).includes('OnPush')) {
                      hasOnPush = true;
                    }
                  } else if (prop.name.text === 'templateUrl') {
                    if (ts.isStringLiteral(prop.initializer)) {
                      htmlFilePath = path.join(path.dirname(filePath), prop.initializer.text);
                    }
                  } else if (prop.name.text === 'template') {
                    if (ts.isStringLiteral(prop.initializer) || ts.isNoSubstitutionTemplateLiteral(prop.initializer)) {
                      inlineTemplate = { text: prop.initializer.text, pos: prop.initializer.getStart() };
                    }
                  }
                }
              }

              if (!hasOnPush) {
                const pos = sourceFile.getLineAndCharacterOfPosition(mod.getStart());
                results.push({
                  file: filePath,
                  line: pos.line + 1,
                  character: pos.character + 1,
                  snippet: snippetAt(source, mod.getStart()),
                  kind: 'missing-on-push',
                });
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visitComponent);
  }
  visitComponent(sourceFile);

  // Pass 2: Unnecessary Zone.js work
  function visitZoneWork(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (['setTimeout', 'setInterval', 'requestAnimationFrame'].includes(name)) {
        if (!isInsideRunOutsideAngular(node)) {
          const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          results.push({
            file: filePath,
            line: pos.line + 1,
            character: pos.character + 1,
            snippet: snippetAt(source, node.getStart()),
            kind: 'unnecessary-zone-work',
          });
        }
      }
    }
    ts.forEachChild(node, visitZoneWork);
  }
  visitZoneWork(sourceFile);

  // HTML parsing for trackBy, functions in template, and Large Components
  let htmlLines = 0;
  let htmlContent = '';
  let htmlFileToUse = filePath;

  if (htmlFilePath && fs.existsSync(htmlFilePath)) {
    htmlContent = fs.readFileSync(htmlFilePath, 'utf-8');
    htmlLines = htmlContent.split(/\r?\n/).length;
    htmlFileToUse = htmlFilePath;
  } else if (inlineTemplate) {
    htmlContent = (inlineTemplate as any).text;
    htmlLines = htmlContent.split(/\r?\n/).length;
  }

  const tsLines = source.split(/\r?\n/).length;
  if (hasComponentDecorator && (tsLines + htmlLines) > LARGE_COMPONENT_THRESHOLD) {
    results.push({
      file: filePath,
      line: 1,
      character: 1,
      snippet: `Component size: ${tsLines + htmlLines} lines (TS: ${tsLines}, HTML: ${htmlLines})`,
      kind: 'large-component',
    });
  }

  if (htmlContent) {
    // Parse HTML
    try {
      const root = parse(htmlContent);

      const checkHtmlNode = (node: any) => {
        // Find *ngFor
        if (node.attributes) {
          for (const [key, value] of Object.entries(node.attributes)) {
            const attrValue = value as string;
            
            // Missing trackBy
            if (key === '*ngFor' || key === 'ngForOf') {
              if (!attrValue.includes('trackBy:')) {
                // Find line approx
                let line = 1;
                let snippet = attrValue;
                if (htmlFileToUse === filePath && inlineTemplate) {
                   const pos = sourceFile.getLineAndCharacterOfPosition(inlineTemplate.pos);
                   line = pos.line + 1; // approx
                } else {
                   const idx = htmlContent.indexOf(attrValue);
                   if (idx !== -1) {
                     line = htmlContent.substring(0, idx).split(/\r?\n/).length;
                     snippet = snippetAtLine(htmlContent, line);
                   }
                }
                results.push({
                  file: htmlFileToUse,
                  line,
                  character: 1,
                  snippet: `<${node.tagName} *ngFor="${attrValue}">`,
                  kind: 'missing-track-by',
                });
              }
            }

            // Function in template (property binding)
            if (key.startsWith('[') && key.endsWith(']')) {
              // Extract potential function calls
              const fnMatches = attrValue.match(/([a-zA-Z0-9_\.]+)\s*\(/g);
              if (fnMatches) {
                let hasRealFunction = false;
                for (const match of fnMatches) {
                  const fnNameMatch = match.match(/([a-zA-Z0-9_]+)\s*\(/);
                  if (fnNameMatch) {
                    const fnName = fnNameMatch[1];
                    // Skip signals, common pipes might not be here but usually pipes use |
                    // Skip 'any', 'Date', etc
                    if (!signals.has(fnName) && !['$any'].includes(fnName)) {
                      hasRealFunction = true;
                      break;
                    }
                  }
                }

                if (hasRealFunction) {
                  let line = 1;
                  if (htmlFileToUse === filePath && inlineTemplate) {
                     const pos = sourceFile.getLineAndCharacterOfPosition(inlineTemplate.pos);
                     line = pos.line + 1;
                  } else {
                     const idx = htmlContent.indexOf(attrValue);
                     if (idx !== -1) {
                       line = htmlContent.substring(0, idx).split(/\r?\n/).length;
                     }
                  }
                  results.push({
                    file: htmlFileToUse,
                    line,
                    character: 1,
                    snippet: `${key}="${attrValue}"`,
                    kind: 'function-in-template',
                  });
                }
              }
            }
          }
        }

        // Text nodes for interpolation {{ fn() }}
        if ((node as any).nodeType === 3) { // Text node
          const text = (node as any).rawText || (node as any).text || '';
          const interpRegex = /\{\{(.*?)\}\}/g;
          let match;
          while ((match = interpRegex.exec(text)) !== null) {
            const expr = match[1];
            const fnMatches = expr.match(/([a-zA-Z0-9_\.]+)\s*\(/g);
            if (fnMatches) {
              let hasRealFunction = false;
              for (const fm of fnMatches) {
                const fnNameMatch = fm.match(/([a-zA-Z0-9_]+)\s*\(/);
                if (fnNameMatch) {
                  const fnName = fnNameMatch[1];
                  if (!signals.has(fnName) && !['$any'].includes(fnName)) {
                    hasRealFunction = true;
                    break;
                  }
                }
              }

              if (hasRealFunction) {
                  let line = 1;
                  if (htmlFileToUse === filePath && inlineTemplate) {
                     const pos = sourceFile.getLineAndCharacterOfPosition(inlineTemplate.pos);
                     line = pos.line + 1;
                  } else {
                     const idx = htmlContent.indexOf(match[0]);
                     if (idx !== -1) {
                       line = htmlContent.substring(0, idx).split(/\r?\n/).length;
                     }
                  }
                  results.push({
                    file: htmlFileToUse,
                    line,
                    character: 1,
                    snippet: match[0],
                    kind: 'function-in-template',
                  });
              }
            }
          }
        }

        if (node.childNodes) {
          for (const child of node.childNodes) {
            checkHtmlNode(child);
          }
        }
      };

      checkHtmlNode(root);
    } catch (e) {
      // Ignore html parse errors
    }
  }

  results.sort((a, b) => a.line - b.line);
  return results;
}
