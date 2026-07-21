/**
 * VscodeDiffViewProvider — Shows side-by-side diffs for agent file edits.
 * Simplified version adapted from Cline's DiffViewProvider pattern.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface DiffEdit {
  filePath: string;
  originalContent: string;
  newContent: string;
  title?: string;
}

/**
 * Open a VS Code diff editor showing changes between original and new content.
 * Uses a temp file for the "modified" side + the original as "original" side.
 */
export async function showDiff(edit: DiffEdit): Promise<boolean> {
  // Write BOTH original and new content to temp files.
  // The real file was already modified by the agent, so we can't use it
  // as the "original" side — it now contains the new content.
  const tmpDir = path.join(
    path.dirname(edit.filePath),
    '.hermes-diffs',
  );
  fs.mkdirSync(tmpDir, { recursive: true });

  const tmpOrig = path.join(tmpDir, path.basename(edit.filePath) + '.hermes-orig');
  const tmpNew  = path.join(tmpDir, path.basename(edit.filePath) + '.hermes-edit');
  fs.writeFileSync(tmpOrig, edit.originalContent, 'utf8');
  fs.writeFileSync(tmpNew, edit.newContent, 'utf8');

  const originalUri = vscode.Uri.file(tmpOrig);
  const modifiedUri = vscode.Uri.file(tmpNew);

  const title = edit.title
    ? `Hermes: ${edit.title} — ${path.basename(edit.filePath)}`
    : `Hermes Diff: ${path.basename(edit.filePath)}`;

  // Open the diff editor
  await vscode.commands.executeCommand('vscode.diff', originalUri, modifiedUri, title);

  // Ask user to accept or reject
  const accept = 'Accept Changes';
  const reject = 'Reject';
  const choice = await vscode.window.showInformationMessage(
    `Apply these changes to ${path.basename(edit.filePath)}?`,
    { modal: true },
    accept,
    reject,
  );

  if (choice === accept) {
    // File was already written by the agent; no need to write again.
    // Just clean up temp files.
    try { fs.unlinkSync(tmpOrig); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpNew); } catch { /* ignore */ }
    return true;
  }

  // Rejected — restore original content to the real file
  fs.writeFileSync(edit.filePath, edit.originalContent, 'utf8');
  try { fs.unlinkSync(tmpOrig); } catch { /* ignore */ }
  try { fs.unlinkSync(tmpNew); } catch { /* ignore */ }
  return false;
}

/**
 * Close any open diff editors from Hermes.
 */
export async function closeAllDiffs(): Promise<void> {
  // Close editors showing .hermes-edit files and diff editors
  const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
  for (const tab of tabs) {
    if (tab.label.includes('.hermes-edit') || tab.label.startsWith('Hermes Diff:')) {
      await vscode.window.tabGroups.close(tab);
    }
  }
}

/**
 * Show a simple edit preview using VS Code's built-in diff.
 */
export async function previewEdit(
  filePath: string,
  newContent: string,
  description: string,
): Promise<boolean> {
  if (!fs.existsSync(filePath)) {
    // Create the file if it doesn't exist
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '', 'utf8');
  }

  return showDiff({
    filePath,
    originalContent: fs.readFileSync(filePath, 'utf8'),
    newContent,
    title: description,
  });
}
