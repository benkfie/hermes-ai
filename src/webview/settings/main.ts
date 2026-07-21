/**
 * Settings webview — vanilla JS that communicates with SettingsPanelProvider.
 */

declare function acquireVsCodeApi(): { postMessage(msg: any): void; getState(): any; setState(state: any): void };

const vscode = acquireVsCodeApi();

// ── Escape HTML helper ─────────────────────────────
function escapeHtml(text: string): string {
  const el = document.createElement('span');
  el.textContent = text;
  return el.innerHTML;
}

// ── State ──────────────────────────────────────────
let currentTab = 'general';
let modelCatalogData: Array<{ provider: string; modelId: string; name: string; visible: boolean }> = [];

// ── Tab navigation ─────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const tabName = (tab as HTMLElement).dataset.tab;
    if (!tabName) return;
    switchTab(tabName);
  });
});

function switchTab(name: string): void {
  currentTab = name;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelector(`.tab[data-tab="${name}"]`)?.classList.add('active');
  document.getElementById(`section-${name}`)?.classList.add('active');

  if (name === 'mcp') loadMcpServers();
  if (name === 'model') loadModelCatalog();
}

// ── Toast ──────────────────────────────────────────
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(message: string, type: 'success' | 'error' = 'success'): void {
  const toast = document.getElementById('toast')!;
  toast.textContent = message;
  toast.className = `toast ${type}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = 'toast hidden'; }, 3000);
}

// ── Message handling ───────────────────────────────
window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'config':
      populateConfig(msg.data);
      break;
    case 'mcpServers':
      populateMcpServers(msg.servers);
      break;
    case 'mcpTestResult':
      showToast(msg.message, msg.ok ? 'success' : 'error');
      break;
    case 'error':
      showToast(msg.message, 'error');
      break;
  }
});

function post(msg: Record<string, unknown>): void {
  vscode.postMessage(msg);
}

// ── Config population ──────────────────────────────
function populateConfig(data: Record<string, any>): void {
  // General
  const hermesPath = document.getElementById('hermes-path') as HTMLInputElement;
  if (hermesPath && data.paths?.install) {
    hermesPath.value = data.paths.install === 'hermes' ? '' : data.paths.install;
    hermesPath.placeholder = data.paths.install;
  }

  const statusEl = document.getElementById('hermes-status')!;
  if (data.hermesInstalled) {
    statusEl.textContent = 'Connected ✓ ' + (data.hermesVersion || '');
    statusEl.className = 'status-badge ok';
  } else {
    statusEl.textContent = 'Not installed';
    statusEl.className = 'status-badge err';
  }

  // Terminal
  setValue('terminal-backend', data.terminal?.backend);
  setValue('terminal-workdir', data.terminal?.workingDir);
  setValue('terminal-timeout', String(data.terminal?.timeout || 180));

  // About
  const aboutVersion = document.getElementById('about-version');
  if (aboutVersion) aboutVersion.textContent = data.hermesVersion || 'Not installed';
  const aboutConfig = document.getElementById('about-config-path');
  if (aboutConfig) aboutConfig.textContent = data.configPath || '-';
  const aboutEnv = document.getElementById('about-env-path');
  if (aboutEnv) aboutEnv.textContent = data.envPath || '-';

  // API Keys
  const envPathDisplay = document.getElementById('env-path-display');
  if (envPathDisplay) envPathDisplay.textContent = data.envPath || '~/.hermes/.env';
  populateApiKeys(data.apiKeys || {});

  // Model catalog
  if (data.modelCatalog && Array.isArray(data.modelCatalog)) {
    modelCatalogData = data.modelCatalog;
    if (currentTab === 'model') {
      renderModelCatalog(modelCatalogData);
    }
  }
}

function setValue(id: string, value: string): void {
  const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
  if (el) el.value = value || '';
}

function setCheckbox(id: string, checked: boolean): void {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (el) el.checked = checked;
}

// ── API Keys ───────────────────────────────────────
function populateApiKeys(keys: Record<string, { masked: string; isSet: boolean }>): void {
  const list = document.getElementById('apikeys-list');
  if (!list) return;

  const providers = Object.keys(keys).sort();
  if (providers.length === 0) {
    list.innerHTML = '<div class="info-text">No API keys configured.</div>';
    return;
  }

  list.innerHTML = providers.map(p => {
    const info = keys[p];
    return '<div class="api-key-row">' +
      '<span class="api-key-label">' + escapeHtml(p) + '</span>' +
      '<span class="api-key-value">' + escapeHtml(info.masked) + '</span>' +
      '<div class="api-key-actions">' +
      '  <button class="small secondary set-key-btn" data-provider="' + escapeHtml(p) + '">' + (info.isSet ? 'Set' : 'Add') + '</button>' +
      (info.isSet ? '  <button class="small danger remove-key-btn" data-provider="' + escapeHtml(p) + '">Remove</button>' : '') +
      '</div>' +
      '</div>';
  }).join('');

  list.querySelectorAll('.set-key-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const provider = (btn as HTMLElement).dataset.provider;
      const value = prompt('Enter API key for ' + provider + ':');
      if (value && provider) {
        post({ type: 'setApiKey', provider, value });
      }
    });
  });

  list.querySelectorAll('.remove-key-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const provider = (btn as HTMLElement).dataset.provider;
      if (provider && confirm('Remove API key for ' + provider + '?')) {
        post({ type: 'removeApiKey', provider });
      }
    });
  });
}

// ── MCP Servers ────────────────────────────────────
function populateMcpServers(servers: any[]): void {
  const list = document.getElementById('mcp-list');
  if (!list) return;

  if (!servers || servers.length === 0) {
    list.innerHTML = '<div class="info-text">No MCP servers configured.</div>';
    return;
  }

  list.innerHTML = servers.map((s: any) => {
    const statusClass = s.status === 'connected' ? 'ok' : s.status === 'error' ? 'err' : '';
    return '<div class="mcp-server-row">' +
      '<div class="mcp-server-header">' +
      '<span class="mcp-server-name">' + escapeHtml(s.name) + '</span>' +
      '<span class="status-badge ' + statusClass + '">' + (s.status || 'unknown') + '</span>' +
      '<button class="small secondary test-mcp-btn" data-name="' + escapeHtml(s.name) + '">Test</button>' +
      '<button class="small danger remove-mcp-btn" data-name="' + escapeHtml(s.name) + '">Remove</button>' +
      '</div>' +
      '<div class="info-text">Transport: ' + escapeHtml(s.transport || 'stdio') + (s.command ? ', Cmd: ' + escapeHtml(s.command) : '') + '</div>' +
      '</div>';
  }).join('');

  list.querySelectorAll('.test-mcp-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = (btn as HTMLElement).dataset.name;
      if (name) post({ type: 'testMcpServer', name });
    });
  });

  list.querySelectorAll('.remove-mcp-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = (btn as HTMLElement).dataset.name;
      if (name && confirm('Remove MCP server "' + name + '"?')) {
        post({ type: 'removeMcpServer', name });
      }
    });
  });
}

function loadMcpServers(): void {
  post({ type: 'getMcpServers' });
}

// ── MCP Transport toggle ──────────────────────────
const mcpTransport = document.getElementById('mcp-transport') as HTMLSelectElement;
if (mcpTransport) {
  mcpTransport.addEventListener('change', () => {
    const isStdio = mcpTransport.value === 'stdio';
    document.getElementById('mcp-command-field')?.classList.toggle('hidden', !isStdio);
    document.getElementById('mcp-url-field')?.classList.toggle('hidden', isStdio);
  });
}

// ── Add MCP server ────────────────────────────────
document.getElementById('add-mcp')?.addEventListener('click', () => {
  const name = (document.getElementById('mcp-name') as HTMLInputElement).value.trim();
  const transport = (document.getElementById('mcp-transport') as HTMLSelectElement).value;

  if (!name) { showToast('Server name is required', 'error'); return; }

  if (transport === 'stdio') {
    const command = (document.getElementById('mcp-command') as HTMLInputElement).value.trim();
    if (!command) { showToast('Command is required for stdio transport', 'error'); return; }
    post({ type: 'addMcpServer', name, transport, command });
  } else {
    const url = (document.getElementById('mcp-url') as HTMLInputElement).value.trim();
    if (!url) { showToast('URL is required for ' + transport.toUpperCase() + ' transport', 'error'); return; }
    post({ type: 'addMcpServer', name, transport, url });
  }

  (document.getElementById('mcp-name') as HTMLInputElement).value = '';
  (document.getElementById('mcp-command') as HTMLInputElement).value = '';
  (document.getElementById('mcp-url') as HTMLInputElement).value = '';
});

// ── Save buttons ──────────────────────────────────
document.getElementById('save-general')?.addEventListener('click', () => {
  showToast('Settings saved');
});

document.getElementById('save-model')?.addEventListener('click', () => {
  saveModelVisibility();
});

document.getElementById('save-terminal')?.addEventListener('click', () => {
  showToast('Terminal settings saved');
});

// ── Model Catalog ─────────────────────────────────
function loadModelCatalog(): void {
  if (modelCatalogData && modelCatalogData.length > 0) {
    renderModelCatalog(modelCatalogData);
  }
}

function renderModelCatalog(catalog: Array<{ provider: string; modelId: string; name: string; visible: boolean }>): void {
  const container = document.getElementById('model-catalog');
  if (!container) return;

  // Group by provider
  const byProvider: Record<string, typeof catalog> = {};
  for (const m of catalog) {
    if (!byProvider[m.provider]) {
      byProvider[m.provider] = [];
    }
    byProvider[m.provider].push(m);
  }

  const providers = Object.keys(byProvider).sort();
  
  let html = '';
  
  for (const provider of providers) {
    const models = byProvider[provider].sort((a, b) => a.name.localeCompare(b.name));
    
    html += `<div class="provider-section">`;
    html += `<h3>${escapeHtml(provider)}</h3>`;
    html += `<div class="model-list">`;
    
    for (const m of models) {
      const checked = m.visible ? 'checked' : '';
      html += `
        <label style="display: block; margin: 4px 0;">
          <input type="checkbox" data-provider="${escapeHtml(provider)}" data-model-id="${escapeHtml(m.modelId)}" ${checked} style="margin-right: 8px;">
          ${escapeHtml(m.name)}
        </label>
      `;
    }
    
    html += `</div></div>`;
  }
  
  if (providers.length === 0) {
    html = '<div class="info-text">No models found in cache. Run <code>hermes model --refresh</code> to update.</div>';
  }
  
  container.innerHTML = html;
  
  // Wire up events for the checkboxes
  container.querySelectorAll('input[type="checkbox"][data-model-id]').forEach(cb => {
    cb.addEventListener('change', () => {
      // We don't need to update any UI here; the save button will read all checkboxes.
    });
  });
}

function updateProviderCount(group: HTMLElement | null): void {
  if (!group) return;
  const checkboxes = group.querySelectorAll('input[type="checkbox"][data-model-id]');
  let visible = 0;
  checkboxes.forEach(cb => { if ((cb as HTMLInputElement).checked) visible++; });
  const total = checkboxes.length;
  const countEl = group.querySelector('h3 span');
  if (countEl) countEl.textContent = '(' + visible + '/' + total + ')';
}

function saveModelVisibility(): void {
  const checkboxes = document.querySelectorAll('input[type="checkbox"][data-model-id]');
  const visibility: Record<string, boolean> = {};
  
  checkboxes.forEach(cb => {
    const provider = (cb as HTMLInputElement).dataset.provider;
    const modelId = (cb as HTMLInputElement).dataset.modelId;
    if (provider && modelId) {
      visibility[provider + '::' + modelId] = (cb as HTMLInputElement).checked;
    }
  });
  
  post({ type: 'saveModelVisibility', visibility });
  showToast('Model visibility saved');
}

// ── About buttons ─────────────────────────────────
document.getElementById('run-doctor')?.addEventListener('click', () => {
  post({ type: 'getConfig' });
  showToast('Refreshing...');
});

// ── Browse Hermes ─────────────────────────────────
document.getElementById('browse-hermes')?.addEventListener('click', () => {
  post({ type: 'setConfig', key: 'path', value: 'prompt-browse' });
});

// ── Helpers ───────────────────────────────────────


// ── Init ──────────────────────────────────────────
post({ type: 'ready' });
post({ type: 'getConfig' });
