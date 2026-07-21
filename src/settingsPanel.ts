/**
 * SettingsPanel — VS Code WebviewView provider for Hermes settings.
 *
 * Renders a tabbed settings UI and bridges messages between the webview
 * and the config manager.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import {
  getConfig,
  setConfig,
  getConfigPath,
  getEnvPath,
  getModel,
  setModel,
  isHermesInstalled,
  getHermesVersion,
} from './config/configManager';

type SettingsMessage =
  | { type: 'ready' }
  | { type: 'getConfig' }
  | { type: 'setConfig'; key: string; value: string }
  | { type: 'setModel'; provider: string; model: string }
  | { type: 'saveModelVisibility'; visibility: Record<string, boolean> };

type SettingsResponse =
  | { type: 'config'; data: Record<string, unknown> }
  | { type: 'error'; message: string };

/**
 * Load the full model catalog from Hermes cache file.
 * Returns a flat array of { provider, modelId, name, visible }.
 */
function loadModelCatalog(): Array<{ provider: string; providerId: string; modelId: string; name: string; visible: boolean }> {
  const cachePath = path.join(os.homedir(), '.hermes', 'models_dev_cache.json');
  const envPath = path.join(os.homedir(), '.hermes', '.env');
  
  if (!fs.existsSync(cachePath)) {
    return [];
  }
  
  try {
    // Read .env to find which providers have API keys configured (not commented out)
    const activeProviderPrefixes: Set<string> = new Set();
    let localBaseUrl: string | null = null;
    
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf8');
      for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        
        // Match _API_KEY or _BASE_URL entries with actual values
        const match = trimmed.match(/^([A-Z_]+?)(?:_API_KEY|_BASE_URL)=(.+)/);
        if (match && match[2].trim()) {
          activeProviderPrefixes.add(match[1]);
        }
        if (trimmed.startsWith('LM_BASE_URL=') && trimmed.split('=', 2)[1]?.trim()) {
          localBaseUrl = trimmed.split('=', 2)[1].trim();
        }
      }
    }
    
    // Map env var prefixes to cache provider IDs
    const envToCacheMap: Record<string, string[]> = {
      'OPENROUTER': ['openrouter'],
      'GOOGLE': ['google'],
      'NOVITA': ['novitaai'],
      'OLLAMA': ['ollama-cloud'],
      'GLM': ['z-ai', 'z-ai-coding-plan'],
      'KIMI': ['moonshot-ai', 'moonshot-ai-china', 'kimi-for-coding'],
      'MINIMAX': ['minimax-io', 'minimaxi-com', 'minimax-token-plan-minimax-io', 'minimax-token-plan-minimaxi-com'],
      'XIAOMI': ['xiaomi', 'xiaomi-token-plan-europe', 'xiaomi-token-plan-china', 'xiaomi-token-plan-singapore'],
      'HF': ['hugging-face'],
      'ANTHROPIC': ['anthropic'],
      'OPENAI': ['openai'],
      'OPENCODE_ZEN': ['opencode-zen'],
      'OPENCODE_GO': ['opencode-go'],
      'ARCEEAI': ['arcee-ai'],
    };
    
    // Collect active cache provider IDs
    const activeCacheIds: Set<string> = new Set();
    for (const prefix of activeProviderPrefixes) {
      const cacheIds = envToCacheMap[prefix];
      if (cacheIds) {
        for (const id of cacheIds) {
          activeCacheIds.add(id);
        }
      }
    }
    
    // Read the cache
    const raw = fs.readFileSync(cachePath, 'utf8');
    const cache = JSON.parse(raw) as Record<string, { name?: string; models?: Record<string, { id: string; name?: string }> }>;
    
    // Load existing visibility settings
    const visibilityPath = path.join(os.homedir(), '.hermes', 'model_visibility.json');
    let visibility: Record<string, boolean> = {};
    if (fs.existsSync(visibilityPath)) {
      visibility = JSON.parse(fs.readFileSync(visibilityPath, 'utf8'));
    }
    
    const results: Array<{ provider: string; providerId: string; modelId: string; name: string; visible: boolean }> = [];
    
    // Add models from active cached providers
    for (const providerId of activeCacheIds) {
      const providerData = cache[providerId];
      if (!providerData) continue;
      
      const models = providerData?.models;
      if (!models || Object.keys(models).length === 0) continue;
      
      const providerName = providerData.name || providerId;
      
      for (const [modelId, modelData] of Object.entries(models)) {
        const key = providerId + '::' + modelId;
        results.push({
          provider: providerName,
          providerId: providerId,
          modelId,
          name: modelData.name || modelId,
          visible: visibility[key] ?? true,
        });
      }
    }
    
    // Also add lmstudio if LM_BASE_URL is set but lmstudio wasn't in the activeCacheIds
    if (localBaseUrl) {
      const lmStudio = cache['lmstudio'];
      if (lmStudio?.models) {
        for (const [modelId, modelData] of Object.entries(lmStudio.models)) {
          const key = 'lmstudio::' + modelId;
          results.push({
            provider: 'LM Studio (Local)',
            providerId: 'lmstudio',
            modelId,
            name: modelData.name || modelId,
            visible: visibility[key] ?? true,
          });
        }
      }
    }
    
    return results;
  } catch {
    return [];
  }
}

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
          const modelCatalog = loadModelCatalog();

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
              hermesInstalled: isHermesInstalled(),
              hermesVersion: getHermesVersion(),
              configPath: getConfigPath(),
              envPath: getEnvPath(),
              modelCatalog: modelCatalog,
            },
          });
          break;
        }

        case 'setConfig': {
          setConfig(msg.key, msg.value);
          await this.handleMessage({ type: 'getConfig' });
          break;
        }

        case 'setModel': {
          setModel(msg.provider, msg.model);
          await this.handleMessage({ type: 'getConfig' });
          break;
        }

        case 'saveModelVisibility': {
          this.saveModelVisibility(msg.visibility);
          break;
        }
      }
    } catch (err) {
      this.post({ type: 'error', message: String(err) });
    }
  }

  /**
   * Save model visibility settings to ~/.hermes/model_visibility.json
   * and notify listeners.
   */
  private saveModelVisibility(visibility: Record<string, boolean>): void {
    try {
      const visibilityPath = path.join(os.homedir(), '.hermes', 'model_visibility.json');
      fs.writeFileSync(visibilityPath, JSON.stringify(visibility, null, 2), 'utf8');
      this._onDidSaveVisibility.fire();
    } catch (err) {
      this.post({ type: 'error', message: `Failed to save model visibility: ${err}` });
    }
  }

  private _onDidSaveVisibility = new vscode.EventEmitter<void>();
  public readonly onDidSaveVisibility = this._onDidSaveVisibility.event;

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
  <title>Hermes AI Settings</title>
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

    .field { margin-bottom: 14px; }

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

    .info-text {
      font-size: 12px;
      color: var(--vscode-descriptionForeground, #999);
      margin-top: 4px;
    }
  </style>
</head>
<body>
  <div class="layout">
    <nav class="sidebar">
      <button class="tab active" data-tab="general">General</button>
      <button class="tab" data-tab="model">Model</button>
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
        <h2>Model Visibility</h2>
        <p class="info-text">Toggle which models appear in the chat model dropdown. Changes take effect immediately.</p>
        <div style="margin-bottom: 12px;">
          <input type="text" id="model-vis-search" placeholder="Search models..." style="width:100%;padding:6px 8px;background:var(--input-bg);color:var(--input-fg);border:1px solid var(--input-border);border-radius:2px;font-size:13px;font-family:var(--vscode-editor-font-family, monospace);">
        </div>
        <div id="model-catalog"></div>
        <div class="spacer">
          <button id="save-model">Save Visibility</button>
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
