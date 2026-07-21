/**
 * SettingsPanel — VS Code WebviewView provider for Hermes settings.
 *
 * Renders a tabbed settings UI and bridges messages between the webview
 * and the config/secret/MCP managers.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  getConfig,
  setConfig,
  getConfigPath,
  getEnvPath,
  getModel,
  setModel,
  getApiKeys,
  setApiKey,
  removeApiKey,
  isHermesInstalled,
  getHermesVersion,
} from './config/configManager';
import { readEnv, writeEnv, removeEnvEntry, maskSecret } from './config/secretManager';
import { listMcpServers, addMcpServer, removeMcpServer, testMcpServer } from './config/mcpManager';

type SettingsMessage =
  | { type: 'ready' }
  | { type: 'getConfig' }
  | { type: 'setConfig'; key: string; value: string }
  | { type: 'setModel'; provider: string; model: string }
  | { type: 'setApiKey'; provider: string; value: string }
  | { type: 'removeApiKey'; provider: string }
  | { type: 'getMcpServers' }
  | { type: 'addMcpServer'; name: string; transport: string; command?: string; url?: string }
  | { type: 'removeMcpServer'; name: string }
  | { type: 'testMcpServer'; name: string };

type SettingsResponse =
  | { type: 'config'; data: Record<string, unknown> }
  | { type: 'error'; message: string }
  | { type: 'mcpServers'; servers: any[] }
  | { type: 'mcpTestResult'; name: string; ok: boolean; message: string };

export class SettingsPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'hermes-ai.settingsView';

  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist'),
      ],
    };

    webviewView.webview.html = this.buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: SettingsMessage) => {
      void this.handleMessage(msg);
    });
  }

  /** Post a message to the settings webview. */
  private post(msg: SettingsResponse): void {
    this.view?.webview.postMessage(msg);
  }

  private async handleMessage(msg: SettingsMessage): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready':
        case 'getConfig': {
          // Send everything the settings UI needs
          const config = getConfig();
          const envEntries = readEnv();

          this.post({
            type: 'config',
            data: {
              paths: config.paths,
              model: config.model,
              maxTurns: config.maxTurns,
              display: config.display,
              terminal: config.terminal,
              timezone: config.timezone,
              contextCompression: config.contextCompression,
              apiKeys: envEntries.reduce((acc, e) => ({
                ...acc,
                [e.key]: { masked: e.masked, isSet: e.isSet },
              }), {} as Record<string, { masked: string; isSet: boolean }>),
              hermesInstalled: isHermesInstalled(),
              hermesVersion: getHermesVersion(),
              configPath: getConfigPath(),
              envPath: getEnvPath(),
            },
          });
          break;
        }

        case 'setConfig': {
          setConfig(msg.key, msg.value);
          // Send updated config back
          await this.handleMessage({ type: 'getConfig' });
          break;
        }

        case 'setModel': {
          setModel(msg.provider, msg.model);
          await this.handleMessage({ type: 'getConfig' });
          break;
        }

        case 'setApiKey': {
          setApiKey(msg.provider, msg.value);
          await this.handleMessage({ type: 'getConfig' });
          break;
        }

        case 'removeApiKey': {
          removeApiKey(msg.provider);
          await this.handleMessage({ type: 'getConfig' });
          break;
        }

        case 'getMcpServers': {
          const servers = listMcpServers();
          this.post({ type: 'mcpServers', servers });
          break;
        }

        case 'addMcpServer': {
          if (msg.transport === 'stdio' && msg.command) {
            addMcpServer(msg.name, { type: 'stdio', command: msg.command });
          } else if (msg.url) {
            addMcpServer(msg.name, { type: msg.transport as 'sse' | 'http', url: msg.url });
          }
          const servers = listMcpServers();
          this.post({ type: 'mcpServers', servers });
          break;
        }

        case 'removeMcpServer': {
          removeMcpServer(msg.name);
          const servers = listMcpServers();
          this.post({ type: 'mcpServers', servers });
          break;
        }

        case 'testMcpServer': {
          const result = testMcpServer(msg.name);
          this.post({ type: 'mcpTestResult', name: msg.name, ok: result.ok, message: result.message });
          break;
        }
      }
    } catch (err) {
      this.post({ type: 'error', message: String(err) });
    }
  }

  /**
   * Build the self-contained HTML for the settings webview.
   * Uses vanilla JS + CSS with tabbed layout.
   */
  private buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'settings.js'),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline';">
  <title>Hermes Settings</title>
  <style>
    :root {
      --bg: var(--vscode-sideBar-background, #1e1e1e);
      --fg: var(--vscode-foreground, #cccccc);
      --border: var(--vscode-panel-border, #3c3c3c);
      --input-bg: var(--vscode-input-background, #3c3c3c);
      --input-fg: var(--vscode-input-foreground, #cccccc);
      --input-border: var(--vscode-input-border, #5a5a5a);
      --btn-bg: var(--vscode-button-background, #0e639c);
      --btn-fg: var(--vscode-button-foreground, #ffffff);
      --btn-hover: var(--vscode-button-hoverBackground, #1177bb);
      --btn-secondary-bg: var(--vscode-button-secondaryBackground, #3a3d41);
      --btn-secondary-fg: var(--vscode-button-secondaryForeground, #cccccc);
      --badge: var(--vscode-badge-background, #4d4d4d);
      --error-fg: var(--vscode-errorForeground, #f44747);
      --ok-fg: #4ec9b0;
      --tab-hover: var(--vscode-list-hoverBackground, #2a2d2e);
      --tab-active: var(--vscode-list-activeSelectionBackground, #094771);
      --tab-active-fg: var(--vscode-list-activeSelectionForeground, #ffffff);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family, -apple-system, sans-serif);
      font-size: 13px;
      color: var(--fg);
      background: var(--bg);
      padding: 0;
      height: 100vh;
      overflow: hidden;
    }

    .layout {
      display: flex;
      height: 100vh;
    }

    /* ── Sidebar tabs ── */
    .sidebar {
      width: 120px;
      border-right: 1px solid var(--border);
      padding: 8px 0;
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
    }

    .tab {
      padding: 8px 12px;
      cursor: pointer;
      color: var(--fg);
      border: none;
      background: none;
      text-align: left;
      font-size: 13px;
      font-family: inherit;
      width: 100%;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .tab:hover { background: var(--tab-hover); }
    .tab.active { background: var(--tab-active); color: var(--tab-active-fg); }

    /* ── Content area ── */
    .content {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
    }

    .section { display: none; }
    .section.active { display: block; }

    .section h2 {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
    }

    .field {
      margin-bottom: 14px;
    }

    .field label {
      display: block;
      font-size: 12px;
      color: var(--vscode-descriptionForeground, #999);
      margin-bottom: 4px;
      font-weight: 600;
    }

    .field input[type="text"],
    .field input[type="password"],
    .field input[type="number"],
    .field select {
      width: 100%;
      padding: 6px 8px;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      border-radius: 2px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 13px;
    }

    .field input[type="checkbox"] {
      margin-right: 6px;
      vertical-align: middle;
    }

    .field input:focus, .field select:focus {
      outline: 1px solid var(--vscode-focusBorder, #007acc);
      outline-offset: -1px;
    }

    .field-row {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .field-row input { flex: 1; }

    button {
      padding: 4px 12px;
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      border-radius: 2px;
      cursor: pointer;
      font-family: inherit;
      font-size: 12px;
    }

    button:hover { background: var(--btn-hover); }

    button.secondary {
      background: var(--btn-secondary-bg);
      color: var(--btn-secondary-fg);
    }

    button.small {
      padding: 2px 8px;
      font-size: 11px;
    }

    button.danger {
      background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
      color: var(--error-fg);
    }

    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 10px;
      background: var(--badge);
    }

    .status-badge.ok { background: #1b3a2d; color: var(--ok-fg); }
    .status-badge.err { background: #3a1d1d; color: var(--error-fg); }

    .api-key-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 0;
      border-bottom: 1px solid var(--border);
    }

    .api-key-row:last-child { border-bottom: none; }

    .api-key-label {
      flex: 1;
      font-weight: 600;
    }

    .api-key-value {
      font-family: monospace;
      font-size: 12px;
      opacity: 0.7;
    }

    .api-key-actions {
      display: flex;
      gap: 4px;
    }

    .mcp-server-row {
      padding: 10px 0;
      border-bottom: 1px solid var(--border);
    }

    .mcp-server-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
    }

    .mcp-server-name {
      font-weight: 600;
      flex: 1;
    }

    .info-text {
      font-size: 12px;
      color: var(--vscode-descriptionForeground, #999);
      margin-top: 4px;
    }

    .spacer { margin-top: 20px; }

    .hidden { display: none !important; }

    .toast {
      position: fixed;
      bottom: 16px;
      right: 16px;
      padding: 8px 16px;
      border-radius: 4px;
      font-size: 12px;
      z-index: 100;
      animation: fadeIn 0.2s;
    }

    .toast.success { background: #1b3a2d; color: var(--ok-fg); }
    .toast.error { background: #3a1d1d; color: var(--error-fg); }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
  </style>
</head>
<body>
  <div class="layout">
    <nav class="sidebar">
      <button class="tab active" data-tab="general">General</button>
      <button class="tab" data-tab="model">Model</button>
      <button class="tab" data-tab="apikeys">API Keys</button>
      <button class="tab" data-tab="mcp">MCP</button>
      <button class="tab" data-tab="terminal">Terminal</button>
      <button class="tab" data-tab="about">About</button>
    </nav>

    <div class="content">
      <!-- General -->
      <div class="section active" id="section-general">
        <h2>General Settings</h2>
        <div class="field">
          <label>Hermes Binary Path</label>
          <div class="field-row">
            <input type="text" id="hermes-path" placeholder="hermes" />
            <button id="browse-hermes" class="secondary small">Browse</button>
          </div>
        </div>
        <div class="field">
          <label>
            <input type="checkbox" id="debug-logs" />
            Enable debug logging
          </label>
        </div>
        <div class="field">
          <label>
            <input type="checkbox" id="auto-connect" />
            Auto-connect on startup
          </label>
        </div>
        <div class="field">
          <label>Installation Status</label>
          <span id="hermes-status" class="status-badge">Checking...</span>
        </div>
        <div class="spacer">
          <button id="save-general">Save Changes</button>
        </div>
      </div>

      <!-- Model -->
      <div class="section" id="section-model">
        <h2>Model Settings</h2>
        <div class="field">
          <label>Provider</label>
          <input type="text" id="model-provider" placeholder="openrouter" />
        </div>
        <div class="field">
          <label>Default Model</label>
          <input type="text" id="model-name" placeholder="deepseek/deepseek-v4-flash" />
        </div>
        <div class="field">
          <label>Base URL (optional, for custom providers)</label>
          <input type="text" id="model-baseurl" placeholder="http://127.0.0.1:1234/v1" />
        </div>
        <div class="field">
          <label>Max Turns</label>
          <input type="number" id="max-turns" min="10" max="500" />
        </div>
        <div class="field">
          <label>
            <input type="checkbox" id="show-reasoning" />
            Show reasoning
          </label>
        </div>
        <div class="spacer">
          <button id="save-model">Save Changes</button>
        </div>
      </div>

      <!-- API Keys -->
      <div class="section" id="section-apikeys">
        <h2>API Keys</h2>
        <div id="apikeys-list"></div>
        <div class="field spacer">
          <label>Add Key</label>
          <div class="field-row">
            <input type="text" id="new-key-provider" placeholder="Provider (e.g., OpenRouter)" />
            <input type="password" id="new-key-value" placeholder="sk-or-..." />
            <button id="add-apikey">Add</button>
          </div>
        </div>
        <div class="info-text spacer">
          Keys stored in <code id="env-path-display">~/.hermes/.env</code>
        </div>
      </div>

      <!-- MCP Servers -->
      <div class="section" id="section-mcp">
        <h2>MCP Servers</h2>
        <div id="mcp-list"></div>
        <div class="field spacer">
          <h3 style="margin-bottom:8px; font-size:14px;">Add Server</h3>
          <div class="field">
            <label>Name</label>
            <input type="text" id="mcp-name" placeholder="my-server" />
          </div>
          <div class="field">
            <label>Transport</label>
            <select id="mcp-transport">
              <option value="stdio">Stdio (local process)</option>
              <option value="sse">SSE (Server-Sent Events)</option>
              <option value="http">HTTP</option>
            </select>
          </div>
          <div class="field" id="mcp-command-field">
            <label>Command</label>
            <input type="text" id="mcp-command" placeholder="npx -y @hermes/mcp-server" />
          </div>
          <div class="field hidden" id="mcp-url-field">
            <label>URL</label>
            <input type="text" id="mcp-url" placeholder="https://..." />
          </div>
          <button id="add-mcp">Add Server</button>
        </div>
      </div>

      <!-- Terminal -->
      <div class="section" id="section-terminal">
        <h2>Terminal Settings</h2>
        <div class="field">
          <label>Backend</label>
          <select id="terminal-backend">
            <option value="local">Local</option>
            <option value="ssh">SSH</option>
          </select>
        </div>
        <div class="field">
          <label>Working Directory</label>
          <input type="text" id="terminal-workdir" placeholder="." />
        </div>
        <div class="field">
          <label>Timeout (seconds)</label>
          <input type="number" id="terminal-timeout" min="10" max="3600" />
        </div>
        <div class="spacer">
          <button id="save-terminal">Save Changes</button>
        </div>
      </div>

      <!-- About -->
      <div class="section" id="section-about">
        <h2>About</h2>
        <div class="field">
          <label>Hermes Version</label>
          <span id="about-version">Checking...</span>
        </div>
        <div class="field">
          <label>Config File</label>
          <code id="about-config-path">-</code>
        </div>
        <div class="field">
          <label>Environment File</label>
          <code id="about-env-path">-</code>
        </div>
        <div class="spacer">
          <button id="run-doctor" class="secondary">Run Hermes Doctor</button>
          <button id="open-config" class="secondary" style="margin-left:8px;">Open Config File</button>
        </div>
      </div>
    </div>
  </div>

  <div id="toast" class="toast hidden"></div>

  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
