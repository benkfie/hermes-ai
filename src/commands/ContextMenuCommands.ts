/**
 * Context menu commands — register right-click actions for Hermes.
 */
import * as vscode from 'vscode';

/**
 * Register all context menu commands.
 * @param sendToChat Callback to send text to the active Hermes chat session.
 */
export function registerContextCommands(
  context: vscode.ExtensionContext,
  sendToChat: (text: string) => void,
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  // ── Add to Chat ──────────────────────────────
  disposables.push(
    vscode.commands.registerTextEditorCommand('hermes.addToChat', (editor) => {
      const selection = editor.selection;
      const text = editor.document.getText(selection);
      const filePath = vscode.workspace.asRelativePath(editor.document.uri);
      const startLine = selection.start.line + 1;

      if (text.trim()) {
        const formatted = `[File: ${filePath}:${startLine}]\n\`\`\`\n${text}\n\`\`\``;
        sendToChat(formatted);
      } else {
        // No selection — send the file reference
        sendToChat(`[File: ${filePath}]`);
      }
    }),
  );

  // ── Explain Code ─────────────────────────────
  disposables.push(
    vscode.commands.registerTextEditorCommand('hermes.explainCode', (editor) => {
      const selection = editor.selection;
      const text = editor.document.getText(selection);
      const filePath = vscode.workspace.asRelativePath(editor.document.uri);
      const startLine = selection.start.line + 1;
      const endLine = selection.end.line + 1;

      const prompt = `Explain this code from ${filePath}:${startLine}-${endLine}:\n\`\`\`\n${text}\n\`\`\``;
      sendToChat(prompt);
    }),
  );

  // ── Fix Code ─────────────────────────────────
  disposables.push(
    vscode.commands.registerTextEditorCommand('hermes.fixCode', (editor) => {
      const selection = editor.selection;
      const text = editor.document.getText(selection);
      const filePath = vscode.workspace.asRelativePath(editor.document.uri);
      const startLine = selection.start.line + 1;

      const prompt = `Fix the issues in this code from ${filePath}:${startLine}:\n\`\`\`\n${text}\n\`\`\``;
      sendToChat(prompt);
    }),
  );

  // ── Improve Code ─────────────────────────────
  disposables.push(
    vscode.commands.registerTextEditorCommand('hermes.improveCode', (editor) => {
      const selection = editor.selection;
      const text = editor.document.getText(selection);
      const filePath = vscode.workspace.asRelativePath(editor.document.uri);
      const startLine = selection.start.line + 1;

      const prompt = `Improve this code from ${filePath}:${startLine}. Make it cleaner, more efficient, and better structured:\n\`\`\`\n${text}\n\`\`\``;
      sendToChat(prompt);
    }),
  );

  // ── Add Terminal Output ──────────────────────
  disposables.push(
    vscode.commands.registerCommand('hermes.addTerminalOutput', () => {
      const terminal = vscode.window.activeTerminal;
      if (!terminal) {
        vscode.window.showWarningMessage('No active terminal to capture output from.');
        return;
      }
      // Note: VS Code doesn't expose terminal output programmatically.
      // User must select and right-click in the terminal to trigger this.
      // We guide them to use the 'Copy All' approach instead.
      const prompt = '[Terminal output requested — please copy terminal content and paste here]';
      sendToChat(prompt);
    }),
  );

  // ── Generate Commit Message ──────────────────
  disposables.push(
    vscode.commands.registerCommand('hermes.generateCommitMsg', async () => {
      const gitExtension = vscode.extensions.getExtension('vscode.git');
      if (!gitExtension?.isActive) {
        try { await gitExtension?.activate(); } catch { /* ok */ }
      }

      const api = gitExtension?.exports?.getAPI(1);
      if (!api) {
        vscode.window.showWarningMessage('Git extension not available.');
        return;
      }

      const repo = api.repositories[0];
      if (!repo) {
        vscode.window.showWarningMessage('No Git repository found.');
        return;
      }

      // Get staged and unstaged changes summary
      const staged = repo.inputBox.value || '';
      const changes = repo.state.workingTreeChanges.map((c: any) => {
        return `${c.status} ${c.uri.fsPath}`;
      }).join('\n');

      const prompt = `Generate a conventional commit message for these changes:\n\nStaged:\n${staged || '(nothing staged)'}\n\nWorking tree changes:\n${changes}\n\nWrite ONLY the commit message, nothing else.`;
      sendToChat(prompt);
    }),
  );

  return disposables;
}
