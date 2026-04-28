import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'node-html-parser';

export type OptimizationKind =
  | 'missing-on-push'
  | 'missing-track-by'
  | 'function-in-template'
  | 'unnecessary-zone-work'
  | 'large-component'
  | 'getter-in-template'
  | 'heavy-lifecycle-hook'
  | 'index-as-trackby'
  | 'unshared-async-pipe'
  | 'high-frequency-event'
  | 'complex-template';

export interface OptimizationLocation {
  file: string;
  line: number;
  character: number;
  snippet: string;
  kind: OptimizationKind;
}

const LARGE_COMPONENT_THRESHOLD = 300;
const COMPLEX_TEMPLATE_THRESHOLD = 100;
const HIGH_FREQ_EVENTS = new Set(['scroll', 'mousemove', 'wheel', 'drag', 'dragover']);

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

function collectGetters(sourceFile: ts.SourceFile): Set<string> {
  const getters = new Set<string>();
  function visit(node: ts.Node) {
    if (ts.isGetAccessor(node) && node.name && ts.isIdentifier(node.name)) {
      getters.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return getters;
}

function isIndexTrackBy(sourceFile: ts.SourceFile, fnName: string): boolean {
  let isIndex = false;
  function visit(node: ts.Node) {
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === fnName) {
      if (node.parameters.length >= 1) {
        const indexParamName = ts.isIdentifier(node.parameters[0].name) ? node.parameters[0].name.text : null;
        if (indexParamName && node.body) {
          const bodyText = node.body.getText(sourceFile);
          if (new RegExp(`return\\s+${indexParamName}\\s*;`).test(bodyText)) {
            isIndex = true;
          }
        }
      }
    }
    if (!isIndex) { ts.forEachChild(node, visit); }
  }
  visit(sourceFile);
  return isIndex;
}

function isUnsharedObservable(sourceFile: ts.SourceFile, varName: string): boolean {
  let isUnshared = true;
  function visit(node: ts.Node) {
    if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === varName) {
      if (node.initializer) {
        const initText = node.initializer.getText(sourceFile);
        if (initText.includes('.pipe(') && initText.includes('shareReplay')) {
          isUnshared = false;
        }
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (ts.isPropertyAccessExpression(node.left) && node.left.expression.kind === ts.SyntaxKind.ThisKeyword && node.left.name.text === varName) {
        const rightText = node.right.getText(sourceFile);
        if (rightText.includes('.pipe(') && rightText.includes('shareReplay')) {
          isUnshared = false;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return isUnshared;
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
  const getters = collectGetters(sourceFile);

  let hasComponentDecorator = false;
  let htmlFilePath: string | null = null;
  let inlineTemplate: { text: string; pos: number } | null = null;

  // Pass 1: find @Component & Heavy Hooks
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

    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text;
      if (['ngDoCheck', 'ngAfterContentChecked', 'ngAfterViewChecked'].includes(name) && node.body) {
        let isHeavy = false;
        function checkHeavy(n: ts.Node) {
          if (ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isWhileStatement(n)) {
            isHeavy = true;
          }
          if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
            const methodName = n.expression.name.text;
            if (['forEach', 'map', 'filter', 'reduce'].includes(methodName) || ['querySelectorAll', 'getElementById', 'getElementsByClassName'].includes(methodName)) {
              isHeavy = true;
            }
          }
          if (!isHeavy) { ts.forEachChild(n, checkHeavy); }
        }
        checkHeavy(node.body);
        if (isHeavy) {
          const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          results.push({
            file: filePath,
            line: pos.line + 1,
            character: pos.character + 1,
            snippet: snippetAt(source, node.getStart()),
            kind: 'heavy-lifecycle-hook',
          });
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
    let bindingsCount = 0;
    const asyncPipesMap = new Map<string, number>();

    // Parse HTML @for syntax for index usage
    const forBlockRegex = /@for\s*\(\s*[a-zA-Z0-9_$]+\s+of\s+[^;]+;\s*track\s+(\$index)\s*\)/g;
    let forMatch;
    while ((forMatch = forBlockRegex.exec(htmlContent)) !== null) {
      let line = 1;
      if (htmlFileToUse === filePath && inlineTemplate) {
        const pos = sourceFile.getLineAndCharacterOfPosition((inlineTemplate as any).pos);
        line = pos.line + 1;
      } else {
        const idx = htmlContent.indexOf(forMatch[0]);
        if (idx !== -1) {
          line = htmlContent.substring(0, idx).split(/\r?\n/).length;
        }
      }
      results.push({
        file: htmlFileToUse,
        line,
        character: 1,
        snippet: forMatch[0],
        kind: 'index-as-trackby',
      });
    }

    try {
      const root = parse(htmlContent);

      const checkHtmlNode = (node: any) => {
        if (node.attributes) {
          for (const [key, value] of Object.entries(node.attributes)) {
            const attrValue = value as string;
            if (key.startsWith('[') || key.startsWith('(') || key.startsWith('*')) {
              bindingsCount++;
            }

            // Inefficient Event Filtering
            if (key.startsWith('(') && key.endsWith(')')) {
              const eventName = key.substring(1, key.length - 1);
              if (HIGH_FREQ_EVENTS.has(eventName)) {
                 let line = 1;
                 if (htmlFileToUse === filePath && inlineTemplate) {
                    const pos = sourceFile.getLineAndCharacterOfPosition((inlineTemplate as any).pos);
                    line = pos.line + 1;
                 } else {
                    const idx = htmlContent.indexOf(attrValue);
                    if (idx !== -1) {
                      line = htmlContent.substring(0, idx).split(/\r?\n/).length;
                    }
                 }
                 results.push({
                   file: htmlFileToUse, line, character: 1,
                   snippet: `${key}="${attrValue}"`,
                   kind: 'high-frequency-event',
                 });
              }
            }

            // Missing trackBy / Index as trackBy
            if (key === '*ngFor' || key === 'ngForOf') {
              if (!attrValue.includes('trackBy:')) {
                let line = 1;
                let snippet = attrValue;
                if (htmlFileToUse === filePath && inlineTemplate) {
                   const pos = sourceFile.getLineAndCharacterOfPosition((inlineTemplate as any).pos);
                   line = pos.line + 1;
                } else {
                   const idx = htmlContent.indexOf(attrValue);
                   if (idx !== -1) {
                     line = htmlContent.substring(0, idx).split(/\r?\n/).length;
                     snippet = snippetAtLine(htmlContent, line);
                   }
                }
                results.push({
                  file: htmlFileToUse, line, character: 1,
                  snippet: `<${node.tagName} *ngFor="${attrValue}">`,
                  kind: 'missing-track-by',
                });
              } else {
                // Parse trackBy function name
                const trackByMatch = attrValue.match(/trackBy:\s*([a-zA-Z0-9_]+)/);
                if (trackByMatch) {
                  const fnName = trackByMatch[1];
                  if (isIndexTrackBy(sourceFile, fnName)) {
                    let line = 1;
                    if (htmlFileToUse === filePath && inlineTemplate) {
                      const pos = sourceFile.getLineAndCharacterOfPosition((inlineTemplate as any).pos);
                      line = pos.line + 1;
                    } else {
                      const idx = htmlContent.indexOf(attrValue);
                      if (idx !== -1) {
                        line = htmlContent.substring(0, idx).split(/\r?\n/).length;
                      }
                    }
                    results.push({
                      file: htmlFileToUse, line, character: 1,
                      snippet: `<${node.tagName} *ngFor="${attrValue}">`,
                      kind: 'index-as-trackby',
                    });
                  }
                }
              }
            }

            // Function in template & async pipe in bindings
            if (key.startsWith('[')) {
              const fnMatches = attrValue.match(/([a-zA-Z0-9_\.]+)\s*\(/g);
              if (fnMatches) {
                let hasRealFunction = false;
                for (const match of fnMatches) {
                  const fnNameMatch = match.match(/([a-zA-Z0-9_]+)\s*\(/);
                  if (fnNameMatch) {
                    const fnName = fnNameMatch[1];
                    if (!signals.has(fnName) && !['$any'].includes(fnName)) {
                      hasRealFunction = true; break;
                    }
                  }
                }
                if (hasRealFunction) {
                  let line = 1;
                  if (htmlFileToUse === filePath && inlineTemplate) {
                     const pos = sourceFile.getLineAndCharacterOfPosition((inlineTemplate as any).pos);
                     line = pos.line + 1;
                  } else {
                     const idx = htmlContent.indexOf(attrValue);
                     if (idx !== -1) { line = htmlContent.substring(0, idx).split(/\r?\n/).length; }
                  }
                  results.push({
                    file: htmlFileToUse, line, character: 1,
                    snippet: `${key}="${attrValue}"`,
                    kind: 'function-in-template',
                  });
                }
              }

              // Async pipes
              const asyncMatches = attrValue.match(/([a-zA-Z0-9_\.$]+)\s*\|\s*async/g);
              if (asyncMatches) {
                for (const am of asyncMatches) {
                  const varNameMatch = am.match(/([a-zA-Z0-9_\.$]+)/);
                  if (varNameMatch) {
                    const varName = varNameMatch[1];
                    asyncPipesMap.set(varName, (asyncPipesMap.get(varName) || 0) + 1);
                  }
                }
              }

              // Getters in template
              for (const getter of getters) {
                const regex = new RegExp(`\\b${getter}\\b`);
                if (regex.test(attrValue)) {
                  let line = 1;
                  if (htmlFileToUse === filePath && inlineTemplate) {
                     const pos = sourceFile.getLineAndCharacterOfPosition((inlineTemplate as any).pos);
                     line = pos.line + 1;
                  } else {
                     const idx = htmlContent.indexOf(attrValue);
                     if (idx !== -1) { line = htmlContent.substring(0, idx).split(/\r?\n/).length; }
                  }
                  results.push({
                    file: htmlFileToUse, line, character: 1,
                    snippet: `${key}="${attrValue}"`,
                    kind: 'getter-in-template',
                  });
                  break; // Only flag once per binding
                }
              }
            }
          }
        }

        // Text nodes for interpolation
        if ((node as any).nodeType === 3) {
          const text = (node as any).rawText || (node as any).text || '';
          const interpRegex = /\{\{(.*?)\}\}/g;
          let match;
          while ((match = interpRegex.exec(text)) !== null) {
            bindingsCount++;
            const expr = match[1];

            // Functions in template
            const fnMatches = expr.match(/([a-zA-Z0-9_\.]+)\s*\(/g);
            if (fnMatches) {
              let hasRealFunction = false;
              for (const fm of fnMatches) {
                const fnNameMatch = fm.match(/([a-zA-Z0-9_]+)\s*\(/);
                if (fnNameMatch) {
                  const fnName = fnNameMatch[1];
                  if (!signals.has(fnName) && !['$any'].includes(fnName)) {
                    hasRealFunction = true; break;
                  }
                }
              }
              if (hasRealFunction) {
                  let line = 1;
                  if (htmlFileToUse === filePath && inlineTemplate) {
                     const pos = sourceFile.getLineAndCharacterOfPosition((inlineTemplate as any).pos);
                     line = pos.line + 1;
                  } else {
                     const idx = htmlContent.indexOf(match[0]);
                     if (idx !== -1) { line = htmlContent.substring(0, idx).split(/\r?\n/).length; }
                  }
                  results.push({
                    file: htmlFileToUse, line, character: 1,
                    snippet: match[0],
                    kind: 'function-in-template',
                  });
              }
            }

            // Async pipes
            const asyncMatches = expr.match(/([a-zA-Z0-9_\.$]+)\s*\|\s*async/g);
            if (asyncMatches) {
              for (const am of asyncMatches) {
                const varNameMatch = am.match(/([a-zA-Z0-9_\.$]+)/);
                if (varNameMatch) {
                  const varName = varNameMatch[1];
                  asyncPipesMap.set(varName, (asyncPipesMap.get(varName) || 0) + 1);
                }
              }
            }

            // Getters in template
            for (const getter of getters) {
              const regex = new RegExp(`\\b${getter}\\b`);
              if (regex.test(expr)) {
                let line = 1;
                if (htmlFileToUse === filePath && inlineTemplate) {
                   const pos = sourceFile.getLineAndCharacterOfPosition((inlineTemplate as any).pos);
                   line = pos.line + 1;
                } else {
                   const idx = htmlContent.indexOf(match[0]);
                   if (idx !== -1) { line = htmlContent.substring(0, idx).split(/\r?\n/).length; }
                }
                results.push({
                  file: htmlFileToUse, line, character: 1,
                  snippet: match[0],
                  kind: 'getter-in-template',
                });
                break;
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

      if (bindingsCount > COMPLEX_TEMPLATE_THRESHOLD) {
        results.push({
          file: htmlFileToUse, line: 1, character: 1,
          snippet: `Template bindings count: ${bindingsCount} (threshold: ${COMPLEX_TEMPLATE_THRESHOLD})`,
          kind: 'complex-template',
        });
      }

      for (const [varName, count] of asyncPipesMap.entries()) {
        if (count > 1 && isUnsharedObservable(sourceFile, varName)) {
           // Find first occurence line
           let line = 1;
           let snippet = `${varName} | async`;
           if (htmlFileToUse === filePath && inlineTemplate) {
              const pos = sourceFile.getLineAndCharacterOfPosition((inlineTemplate as any).pos);
              line = pos.line + 1;
           } else {
              const idx = htmlContent.indexOf(`${varName} | async`) !== -1 ? htmlContent.indexOf(`${varName} | async`) : htmlContent.indexOf(`${varName}|async`);
              if (idx !== -1) {
                line = htmlContent.substring(0, idx).split(/\r?\n/).length;
                snippet = snippetAtLine(htmlContent, line);
              }
           }
           results.push({
             file: htmlFileToUse, line, character: 1,
             snippet: `${snippet} (used ${count} times)`,
             kind: 'unshared-async-pipe',
           });
        }
      }

    } catch (e) {
      // Ignore html parse errors
    }
  }

  results.sort((a, b) => a.line - b.line);
  return results;
}
