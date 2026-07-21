import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { AcpClient } from './acpClient';
import { PermissionRequestHandler, SessionManager } from './sessionManager';
import { ChatPanelProvider } from './chatPanel';
import { SettingsPanelProvider } from './settingsPanel';
import { registerContextCommands } from './commands/ContextMenuCommands';
import { requestPermission } from './PermissionApproval';
import { showDiff, previewEdit } from './hosts/VscodeDiffViewProvider';

const DEFAULT_SONNET_MODEL = 'claude-sonnet-4-6';
const APPROVED_BINARIES_KEY = 'hermes-ai.approvedBinaries';

function extractModelFromHermesConfig(content: string): string | null {
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const modelMatch = /^(\s*)model:\s*(.*)$/.exec(line);
    if (!modelMatch) continue;

    const modelIndent = modelMatch[1].length;
    const inlineValue = modelMatch[2].trim();
    if (inlineValue) {
      return inlineValue;
    }

    for (let j = i + 1; j < lines.length; j += 1) {
      const childLine = lines[j];
      if (!childLine.trim() || childLine.trimStart().startsWith('#')) continue;

      const childIndent = childLine.match(/^\s*/)?.[0].length ?? 0;
      if (childIndent <= modelIndent) break;

      const defaultMatch = /^\s*default:\s*(\S+)/.exec(childLine);
      if (defaultMatch) {
        return defaultMatch[1];
      }
    }
  }

  return null;
}

function readHermesModel(): { model: string; source: 'env' | 'config' | 'fallback' } {
  try {
    const configPath = path.join(os.homedir(), '.hermes', 'config.yaml');
    const content = fs.readFileSync(configPath, 'utf8');
    const model = extractModelFromHermesConfig(content);
    if (model) {
      return { model, source: 'config' };
    }
  } catch {
    // Fall through to the built-in Sonnet default.
  }

  return { model: DEFAULT_SONNET_MODEL, source: 'fallback' };
}

function readHermesVersion(hermesPath: string): string {
  try {
    const output = execFileSync(hermesPath, ['--version'], {
      timeout: 5000,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${path.dirname(hermesPath)}:${process.env.PATH ?? ''}` },
    });
    const match = output.match(/v(\d+\.\d+\.\d+)/);
    return match?.[1] ? `v${match[1]}` : '';
  } catch {
    return '';
  }
}

function readConfiguredHermesPath(): { value: string; workspaceOverrideIgnored: boolean } {
  const hermesConfig = vscode.workspace.getConfiguration('hermes-ai');
  const inspected = hermesConfig.inspect<string>('path');
  const workspaceOverrideIgnored = !!(inspected?.workspaceValue || inspected?.workspaceFolderValue);
  // Try all scopes: global first (for security), then workspace, then default
  const value = inspected?.globalValue
    ?? inspected?.workspaceValue
    ?? inspected?.defaultValue
    ?? 'hermes';
  return { value, workspaceOverrideIgnored };
}

function resolveHermesBinary(configuredPath: string): string {
  let hermesPath = configuredPath;
  const isWindows = process.platform === 'win32';

  if (hermesPath !== 'hermes' && !path.isAbsolute(hermesPath)) {
    throw new Error('hermes.path must be an absolute path or the default "hermes" value');
  }

  if (hermesPath === 'hermes') {
    // Try to find via PATH
    try {
      const whichCmd = isWindows ? 'where' : 'which';
      const resolved = execFileSync(whichCmd, ['hermes'], { timeout: 3000, encoding: 'utf8' }).trim();
      // 'where' on Windows may return multiple lines; take the first
      if (resolved) hermesPath = resolved.split(/\r?\n/)[0].trim();
    } catch {
      // not in PATH
    }

    if (hermesPath === 'hermes') {
      // Check known locations by platform
      const tryPaths = isWindows
        ? [
            path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'hermes-agent', 'hermes.exe'),
            path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'hermes.exe'),
            path.join(os.homedir(), '.hermes', 'bin', 'hermes.exe'),
            'C:\\Program Files\\hermes\\hermes.exe',
          ]
        : [
            path.join(os.homedir(), '.local', 'bin', 'hermes'),
            '/usr/local/bin/hermes',
            '/usr/bin/hermes',
          ];
      for (const candidate of tryPaths) {
        try {
          if (fs.existsSync(candidate)) {
            hermesPath = candidate;
            break;
          }
        } catch {
          // skip unreadable candidate
        }
      }
    }
  }

  if (!path.isAbsolute(hermesPath)) {
    throw new Error(`Unable to resolve hermes binary from setting "${configuredPath}". Set the full path in VS Code User Settings → Hermes: Path.`);
  }
  if (!fs.existsSync(hermesPath)) {
    throw new Error(`Configured hermes binary does not exist: ${hermesPath}. Check your Hermes: Path setting.`);
  }

  return hermesPath;
}

async function ensureTrustedBinary(
  context: vscode.ExtensionContext,
  hermesPath: string,
): Promise<boolean> {
  const approved = context.globalState.get<string[]>(APPROVED_BINARIES_KEY, []);
  if (approved.includes(hermesPath)) return true;

  const allow = 'Allow';
  const choice = await vscode.window.showWarningMessage(
    `Hermes wants to launch this local binary:\n${hermesPath}\n\nOnly allow binaries you trust.`,
    { modal: true },
    allow,
  );
  if (choice !== allow) return false;

  await context.globalState.update(APPROVED_BINARIES_KEY, [...new Set([...approved, hermesPath])]);
  return true;
}

function summarizePermissionRequest(params: unknown): string {
  if (!params || typeof params !== 'object') return 'Hermes requested permission for an action.';
  const record = params as Record<string, unknown>;
  const toolName = typeof record.toolName === 'string'
    ? record.toolName
    : typeof record.title === 'string'
      ? record.title
      : typeof record.kind === 'string'
        ? record.kind
        : 'an action';
  const reason = typeof record.reason === 'string'
    ? record.reason
    : typeof record.description === 'string'
      ? record.description
      : '';
  return reason
    ? `Hermes requested permission for ${toolName}: ${reason}`
    : `Hermes requested permission for ${toolName}.`;
}

function optionIdByIntent(params: unknown, intent: 'allow' | 'deny'): string | null {
  if (!params || typeof params !== 'object') return null;
  const options = (params as { options?: Array<Record<string, unknown>> }).options;
  if (!Array.isArray(options)) return null;

  const preferredAllow = ['allow_once', 'allow', 'approve', 'yes'];
  const preferredDeny = ['deny_once', 'deny', 'reject', 'no'];
  const preferred = intent === 'allow' ? preferredAllow : preferredDeny;

  for (const keyword of preferred) {
    const match = options.find((option) => {
      const id = typeof option.optionId === 'string' ? option.optionId : typeof option.id === 'string' ? option.id : '';
      return id.toLowerCase().includes(keyword);
    });
    if (match) {
      return (typeof match.optionId === 'string' ? match.optionId : match.id) as string;
    }
  }

  if (intent === 'allow') {
    const fallback = options.find((option) => {
      const id = typeof option.optionId === 'string' ? option.optionId : typeof option.id === 'string' ? option.id : '';
      return id && !/deny|reject|no/i.test(id);
    });
    return (typeof fallback?.optionId === 'string' ? fallback.optionId : fallback?.id as string | undefined) ?? null;
  }

  return null;
}

let client: AcpClient | null = null;
let outputChannel: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel('Hermes AI');
  context.subscriptions.push(outputChannel);

  const configuredHermes = readConfiguredHermesPath();
  if (configuredHermes.workspaceOverrideIgnored) {
    outputChannel.appendLine('[security] Ignoring workspace-scoped hermes.path override');
  }

  let hermesPath = configuredHermes.value;

  outputChannel.appendLine(`[hermes] homedir: ${os.homedir()}`);
  outputChannel.appendLine(`[hermes] platform: ${process.platform}`);
  try {
    hermesPath = resolveHermesBinary(hermesPath);
    outputChannel.appendLine(`[hermes] binary: ${hermesPath}`);
  } catch (err) {
    outputChannel.appendLine(`[security] invalid Hermes binary: ${err}`);
  }

  const hermesConfig = vscode.workspace.getConfiguration('hermes-ai');
  const debugLogs = hermesConfig.get<boolean>('debugLogs', false);

  client = new AcpClient(
    hermesPath,
    debugLogs ? { HERMES_LOG_LEVEL: 'DEBUG' } : {},
    debugLogs,
  );

  if (debugLogs) {
    outputChannel.show(true);
    outputChannel.appendLine('[hermes] ACP diagnostic logging enabled');
  }

  client.on('log', (line: string) => outputChannel.appendLine(line));
  client.on('exit', (code: number) => {
    outputChannel.appendLine(`[hermes acp exited: code ${code}]`);
    setStatus('disconnected');
  });

  const permissionHandler: PermissionRequestHandler = async (_method, params) => {
    const toolName = typeof (params as any)?.toolName === 'string' ? (params as any).toolName : 'an action';
    const reason = typeof (params as any)?.reason === 'string' ? (params as any).reason : undefined;
    const filePath = typeof (params as any)?.filePath === 'string' ? (params as any).filePath : undefined;

    // Use QuickPick-based permission UI
    const selectedOption = await requestPermission({ toolName, reason, filePath });

    if (!selectedOption || selectedOption.startsWith('deny')) {
      outputChannel.appendLine(`[security] permission denied for ${toolName}`);
      throw new Error('Permission denied by user');
    }

    outputChannel.appendLine(`[security] permission granted: ${selectedOption} for ${toolName}`);
    return { outcome: 'selected', optionId: selectedOption };
  };

  const session = new SessionManager(client, line => outputChannel.appendLine(line), permissionHandler);
  const { model: hermesModel } = readHermesModel();
  const hermesVersion = readHermesVersion(hermesPath);
  const panel = new ChatPanelProvider(
    context.extensionUri,
    session,
    hermesModel,
    hermesVersion,
    context,
    line => outputChannel.appendLine(line),
  );

  // Register chat view
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatPanelProvider.viewId, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Register settings view
  const settingsPanel = new SettingsPanelProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SettingsPanelProvider.viewId, settingsPanel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // When visibility settings change, refresh the chat model menu
  settingsPanel.onDidSaveVisibility(() => {
    const { model: currentModel } = readHermesModel();
    panel.refreshModelMenu(currentModel);
    outputChannel.appendLine('[ui] model visibility saved -> refreshed chat model menu');
  });

  // Register context menu commands (right-click -> Hermes actions)
  const sendToChat = (text: string) => {
    panel.post({ type: 'statusBar' }); // nudge
    // Queue the text as if the user typed it
    panel.post({ type: 'append', text: `
[Context] ${text}
` });
  };
  const ctxDisposables = registerContextCommands(context, sendToChat);
  context.subscriptions.push(...ctxDisposables);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('hermes-ai.openChat', async () => {
      outputChannel.appendLine('[ui] open chat');
      await vscode.commands.executeCommand('hermes-ai.chatView.focus');
      await ensureConnected();
    }),

    vscode.commands.registerCommand('hermes-ai.newSession', () => {
      outputChannel.appendLine('[ui] new session');
      session.reset();
      panel.post({ type: 'clear' });
    }),

    vscode.commands.registerCommand('hermes-ai.openSettings', async () => {
      outputChannel.appendLine('[ui] open settings');
      await vscode.commands.executeCommand('hermes-ai.settingsView.focus');
    }),
  );

  // Status bar
  const statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusItem.text = '$(circle-outline) Hermes';
  statusItem.command = 'hermes-ai.openChat';
  statusItem.show();
  context.subscriptions.push(statusItem);

  function setStatus(state: 'connected' | 'disconnected' | 'connecting'): void {
    const icons: Record<string, string> = {
      connected: '$(circle-filled)',
      disconnected: '$(circle-outline)',
      connecting: '$(loading~spin)',
    };
    statusItem.text = `${icons[state]} Hermes`;
    panel.post({ type: 'status', status: state });
  }

  async function ensureConnected(): Promise<void> {
    if (!client) return;
    if (!vscode.workspace.isTrusted) {
      outputChannel.appendLine('[security] workspace is not trusted; Hermes launch blocked');
      setStatus('disconnected');
      void vscode.window.showWarningMessage('Hermes is disabled until this workspace is trusted.');
      return;
    }

    try {
      hermesPath = resolveHermesBinary(readConfiguredHermesPath().value);
    } catch (err) {
      setStatus('disconnected');
      vscode.window.showErrorMessage(`Hermes: invalid binary path — ${err}`);
      return;
    }

    const approved = await ensureTrustedBinary(context, hermesPath);
    if (!approved) {
      outputChannel.appendLine('[security] Hermes launch cancelled by user');
      setStatus('disconnected');
      return;
    }
    client.setHermesPath(hermesPath);

    outputChannel.appendLine('[acp] connecting');
    setStatus('connecting');
    try {
      await client.start();
      outputChannel.appendLine('[acp] connected');
      setStatus('connected');
    } catch (err) {
      outputChannel.appendLine(`[acp] connect failed: ${err}`);
      setStatus('disconnected');
      vscode.window.showErrorMessage(`Hermes: failed to start — ${err}`);
    }
  }

  // Auto-connect
  if (vscode.workspace.isTrusted) {
    void ensureConnected();
  } else {
    setStatus('disconnected');
  }
}

export function deactivate(): void {
  client?.stop();
}
