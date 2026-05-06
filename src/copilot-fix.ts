import * as vscode from 'vscode';

export interface CopilotFixOptions {
  /** Absolute path of the file containing the issue */
  file: string;
  /** 1-based line number */
  line: number;
  /** Machine-readable issue kind (e.g. 'unguarded-subscribe') */
  kind: string;
  /** Human-readable label for the kind (e.g. 'Unguarded Subscribe') */
  kindLabel: string;
  /** The code snippet as shown in the webview */
  snippet: string;
  /** Short description of the problem */
  description: string;
  /** Concrete fix instruction */
  fixHint: string;
}

export interface CopilotFixFileOptions {
  /** Absolute path of the file */
  file: string;
  /** All issues in the file */
  issues: Array<{
    line: number;
    kind: string;
    kindLabel: string;
    snippet: string;
    description: string;
    fixHint: string;
  }>;
  /** Context label for the title (e.g. 'Memory Leak', 'Optimization', 'Build Error') */
  issueType: string;
}

/**
 * Attempts to select the preferred model in VS Code's language model API.
 * Uses vscode.lm.selectChatModels to find a model matching the configured ID.
 * Falls back silently if the model is unavailable.
 */
async function selectPreferredModel(): Promise<void> {
  const config = vscode.workspace.getConfiguration('angularCliPlus');
  const preferredModelId = config.get<string>('copilot.preferredModel', 'gpt-4o');

  try {
    const models = await vscode.lm.selectChatModels({ id: preferredModelId });
    if (models.length > 0) {
      // The model exists — use the chat.setLanguageModel command to select it in the UI
      await vscode.commands.executeCommand('workbench.action.chat.setLanguageModel', {
        identifier: models[0].id,
      });
    }
  } catch {
    // Model selection is best-effort — don't block the flow if it fails
  }
}

/**
 * Opens Copilot Chat with a fix prompt for a single issue.
 * The preferred model is selected in the chat UI before the prompt is sent.
 */
export async function sendCopilotAutoFix(opts: CopilotFixOptions): Promise<void> {
  const prompt = buildSinglePrompt(opts);
  await openChatWithPrompt(prompt);
}

/**
 * Opens Copilot Chat with a fix prompt covering all issues in a single file.
 */
export async function sendCopilotAutoFixForFile(opts: CopilotFixFileOptions): Promise<void> {
  const prompt = buildFilePrompt(opts);
  await openChatWithPrompt(prompt);
}

async function openChatWithPrompt(prompt: string): Promise<void> {
  // First try to select the preferred model in the chat UI
  await selectPreferredModel();

  try {
    await vscode.commands.executeCommand('workbench.action.chat.open', {
      query: prompt,
    });
  } catch {
    // Copilot Chat not available — copy to clipboard as fallback
    await vscode.env.clipboard.writeText(prompt);
    vscode.window.showWarningMessage(
      'GitHub Copilot Chat does not appear to be available. The fix prompt has been copied to your clipboard.',
    );
  }
}

function buildSinglePrompt(opts: CopilotFixOptions): string {
  return [
    `@workspace #editor`,
    ``,
    `**[Angular CLI Plus] Auto Fix — ${opts.kindLabel}**`,
    ``,
    `**File:** \`${opts.file}\` (Line ${opts.line})`,
    `**Issue type:** ${opts.kindLabel} (\`${opts.kind}\`)`,
    ``,
    `**Code snippet (line ${opts.line}):**`,
    `\`\`\`typescript`,
    opts.snippet.trim(),
    `\`\`\``,
    ``,
    `**Problem:** ${opts.description}`,
    ``,
    `**Fix:** ${opts.fixHint}`,
    ``,
    `Please open \`${opts.file}\`, locate line ${opts.line}, and apply the fix described above. ` +
      `Ensure the change is minimal and correct. Do not alter unrelated code.`,
  ].join('\n');
}

function buildFilePrompt(opts: CopilotFixFileOptions): string {
  const issueCount = opts.issues.length;
  const issueLines = opts.issues
    .map((issue, i) => {
      return [
        `### Issue ${i + 1} — ${issue.kindLabel} (Line ${issue.line})`,
        ``,
        `**Code snippet:**`,
        `\`\`\`typescript`,
        issue.snippet.trim(),
        `\`\`\``,
        ``,
        `**Problem:** ${issue.description}`,
        `**Fix:** ${issue.fixHint}`,
      ].join('\n');
    })
    .join('\n\n');

  return [
    `@workspace`,
    ``,
    `**[Angular CLI Plus] Auto Fix All — ${issueCount} ${opts.issueType}${issueCount !== 1 ? 's' : ''} in \`${opts.file}\`**`,
    ``,
    issueLines,
    ``,
    `Please open \`${opts.file}\` and fix all ${issueCount} issue${issueCount !== 1 ? 's' : ''} listed above. ` +
      `Apply each fix at the correct line. Ensure changes are minimal and correct. Do not alter unrelated code.`,
  ].join('\n');
}
