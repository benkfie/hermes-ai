/**
 * WorkspaceContext — Smart context gathering for Hermes prompts.
 */
import * as vscode from 'vscode';
import * as path from 'path';

export interface WorkspaceContext {
  activeFile?: string;
  activeSelection?: { text: string; startLine: number; endLine: number };
  openTabs: string[];
  fileTree: string;
  gitDiff?: string;
}

/**
 * Gather workspace context for a prompt.
 */
export function collectContext(): WorkspaceContext {
  const ctx: WorkspaceContext = {
    openTabs: [],
    fileTree: '',
  };

  // Active editor
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    ctx.activeFile = vscode.workspace.asRelativePath(editor.document.uri);
    if (!editor.selection.isEmpty) {
      ctx.activeSelection = {
        text: editor.document.getText(editor.selection),
        startLine: editor.selection.start.line + 1,
        endLine: editor.selection.end.line + 1,
      };
    }
  }

  // Open tabs
  ctx.openTabs = vscode.window.tabGroups.all
    .flatMap(g => g.tabs)
    .map(t => {
      const input = t.input;
      if (input && typeof input === 'object' && 'uri' in (input as any)) {
        return vscode.workspace.asRelativePath((input as any).uri);
      }
      return null;
    })
    .filter((p): p is string => p !== null);

  return ctx;
}

/**
 * Format workspace context as a string to prepend to user prompts.
 */
export function formatContextForPrompt(ctx: WorkspaceContext): string {
  const parts: string[] = [];

  if (ctx.activeFile) {
    parts.push(`[Active file: ${ctx.activeFile}]`);
  }

  if (ctx.activeSelection) {
    const { text, startLine, endLine } = ctx.activeSelection;
    if (text.length <= 2000) {
      parts.push(`[Selection lines ${startLine}-${endLine}]\n\`\`\`\n${text}\n\`\`\``);
    } else {
      parts.push(`[Selection: ${text.length} chars, lines ${startLine}-${endLine}]`);
    }
  }

  if (ctx.openTabs.length > 0) {
    parts.push(`[Open tabs: ${ctx.openTabs.join(', ')}]`);
  }

  return parts.length > 0 ? parts.join('\n') + '\n\n' : '';
}

/**
 * Get git diff summary for the workspace.
 */
export async function getGitDiff(): Promise<string> {
  try {
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    if (!gitExtension?.isActive) {
      await gitExtension?.activate();
    }
    const api = gitExtension?.exports?.getAPI(1);
    if (!api) return '';

    const repo = api.repositories[0];
    if (!repo) return '';

    const changes = repo.state.workingTreeChanges.map((c: any) => {
      return `${c.status} ${path.basename(c.uri.fsPath)}`;
    });

    return changes.length > 0 ? changes.join('\n') : '';
  } catch {
    return '';
  }
}
