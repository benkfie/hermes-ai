/**
 * PermissionApproval — Rich permission dialog for agent tool approvals.
 * Replaces the raw vscode.window.showWarningMessage modal with contextual info.
 */
import * as vscode from 'vscode';

export interface PermissionRequest {
  toolName: string;
  reason?: string;
  filePath?: string;
  details?: string;
  options?: Array<{ optionId: string; label: string }>;
}

/**
 * Show a rich permission approval dialog using QuickPick.
 * Returns the selected option ID, or null if denied.
 */
export async function requestPermission(request: PermissionRequest): Promise<string | null> {
  // Build a rich message for the QuickPick placeholder
  const parts: string[] = [];
  parts.push(`Hermes wants to: ${request.toolName}`);

  if (request.filePath) {
    parts.push(`File: ${request.filePath}`);
  }
  if (request.reason) {
    parts.push(`Reason: ${request.reason}`);
  }
  if (request.details) {
    parts.push(request.details);
  }

  const quickPick = vscode.window.createQuickPick();
  quickPick.title = 'Hermes Permission';
  quickPick.placeholder = parts.join(' | ');
  quickPick.ignoreFocusOut = true;
  quickPick.canSelectMany = false;

  // Build items from options or defaults
  const items: vscode.QuickPickItem[] = [];

  if (request.options && request.options.length > 0) {
    for (const opt of request.options) {
      items.push({ label: opt.label, description: opt.optionId });
    }
  } else {
    items.push(
      { label: '$(check) Allow Once', description: 'allow_once' },
      { label: '$(check-all) Allow Always', description: 'allow_always' },
      { label: '$(x) Deny', description: 'deny_once' },
      { label: '$(circle-slash) Deny Always', description: 'deny_always' },
    );
  }
  quickPick.items = items;

  return new Promise<string | null>((resolve) => {
    quickPick.onDidAccept(() => {
      const selected = quickPick.selectedItems[0];
      quickPick.hide();
      if (selected?.description) {
        resolve(selected.description);
      } else {
        resolve(null);
      }
    });
    quickPick.onDidHide(() => {
      quickPick.dispose();
      // If no selection was made, treat as deny
      resolve(null);
    });
    quickPick.show();
  });
}

/**
 * Simple permission dialog using window.showWarningMessage (fallback).
 */
export async function requestPermissionSimple(toolName: string, reason?: string): Promise<boolean> {
  const message = reason
    ? `Allow Hermes to ${toolName}?\n\n${reason}`
    : `Allow Hermes to ${toolName}?`;

  const choice = await vscode.window.showWarningMessage(
    message,
    { modal: true },
    'Allow',
    'Deny',
  );

  return choice === 'Allow';
}
