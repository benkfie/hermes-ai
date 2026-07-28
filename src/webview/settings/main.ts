/**
 * Settings webview — vanilla JS that communicates with SettingsPanelProvider.
 */

declare function acquireVsCodeApi(): { postMessage(msg: any): void; getState(): any; setState(state: any): void };

const vscode = acquireVsCodeApi();

// --- Escape HTML helper ---------------------------------
function escapeHtml(text: string): string {
  const el = document.createElement('span');
  el.textContent = text;
  return el.innerHTML;
}

// --- State ------------------------------------------------
let currentTab = 'general';
let modelCatalogData: Array<{ provider: string; providerId?: string; modelId: string; name: string; visible: boolean }> = [];

// --- Tab navigation ---------------------------------------
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

  if (name === 'model') loadModelCatalog();
}

// --- Toast ------------------------------------------------
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(message: string, type: 'success' | 'error' = 'success'): void {
  const toast = document.getElementById('toast')!;
  toast.textContent = message;
  toast.className = `toast ${type}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = 'toast hidden'; }, 3000);
}

// --- Message handling --------------------------------------
window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'config':
      populateConfig(msg.data);
      break;
    case 'error':
      showToast(msg.message, 'error');
      break;
  }
});

function post(msg: Record<string, unknown>): void {
  vscode.postMessage(msg);
}

// --- Config population -------------------------------------
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

// --- Save buttons -----------------------------------------
document.getElementById('save-general')?.addEventListener('click', () => {
  showToast('Settings saved');
});

document.getElementById('save-model')?.addEventListener('click', () => {
  saveModelVisibility();
});

document.getElementById('save-terminal')?.addEventListener('click', () => {
  showToast('Terminal settings saved');
});

// --- Model Catalog ----------------------------------------
function loadModelCatalog(): void {
  if (modelCatalogData && modelCatalogData.length > 0) {
    renderModelCatalog(modelCatalogData);
  }
}

function renderModelCatalog(catalog: Array<{ provider: string; providerId?: string; modelId: string; name: string; visible: boolean }>): void {
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
    const safeProvider = escapeHtml(provider);
    
    const safeProviderId = escapeHtml(models[0]?.providerId || provider);
    html += `<div class="provider-section" data-provider="${safeProviderId}">`;
    html += `<div class="provider-header">`;
    html += `<h3>${safeProvider}</h3>`;
    html += `<div class="provider-actions">`;
    html += `<button class="small secondary select-all" data-provider="${safeProviderId}">Select All</button>`;
    html += `<button class="small secondary deselect-all" data-provider="${safeProviderId}">Deselect All</button>`;
    html += `</div></div>`;
    html += `<div class="model-list">`;
    
    for (const m of models) {
      const checked = m.visible ? 'checked' : '';
      html += `
        <label style="display: block; margin: 4px 0;">
          <input type="checkbox" data-provider="${safeProviderId}" data-model-id="${escapeHtml(m.modelId)}" ${checked} style="margin-right: 8px;">
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
  
  // Wire up Select All / Deselect All buttons
  container.querySelectorAll('.select-all').forEach(btn => {
    btn.addEventListener('click', () => {
      const provider = (btn as HTMLElement).dataset.provider;
      container.querySelectorAll(`input[type="checkbox"][data-provider="${provider}"]`).forEach(cb => {
        (cb as HTMLInputElement).checked = true;
      });
    });
  });
  
  container.querySelectorAll('.deselect-all').forEach(btn => {
    btn.addEventListener('click', () => {
      const provider = (btn as HTMLElement).dataset.provider;
      container.querySelectorAll(`input[type="checkbox"][data-provider="${provider}"]`).forEach(cb => {
        (cb as HTMLInputElement).checked = false;
      });
    });
  });
}


// --- Model visibility saving ---------------------------
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

// --- About buttons ----------------------------------------
document.getElementById('run-doctor')?.addEventListener('click', () => {
  post({ type: 'getConfig' });
  showToast('Refreshing...');
});

// --- Browse Hermes ----------------------------------------
document.getElementById('browse-hermes')?.addEventListener('click', () => {
  post({ type: 'setConfig', key: 'path', value: 'prompt-browse' });
});

// --- Model visibility search --------------------------------
// Uses a CSS class (.search-hidden) instead of touching inline display,
// so the labels keep their inline `display:block` and never bunch up.
const modelVisSearch = document.getElementById('model-vis-search') as HTMLInputElement;
if (modelVisSearch) {
  modelVisSearch.addEventListener('input', () => {
    const q = modelVisSearch.value.toLowerCase().trim();
    const container = document.getElementById('model-catalog');
    if (!container) return;
    container.querySelectorAll('.provider-section').forEach(section => {
      let anyVisible = false;
      section.querySelectorAll('.model-list label').forEach(label => {
        const text = (label.textContent || '').toLowerCase();
        const match = text.includes(q);
        (label as HTMLElement).classList.toggle('search-hidden', !match);
        if (match) anyVisible = true;
      });
      (section as HTMLElement).classList.toggle('search-hidden', !anyVisible);
    });
  });
}

// --- Gateway / Provider Management ----------------------------
let gatewayUrl = 'http://localhost:3100';
let gatewayConnected = false;
let providersCache: any[] = [];
const PROVIDER_TYPES = ['openai','anthropic','google','ollama','openrouter','custom'];

function escHtml(text: string): string {
  const el = document.createElement('span');
  el.textContent = text;
  return el.innerHTML;
}

async function connectGateway(): Promise<void> {
  const urlInput = document.getElementById('gateway-url') as HTMLInputElement;
  const statusEl = document.getElementById('gateway-status')!;
  gatewayUrl = (urlInput?.value || 'http://localhost:3100').replace(/\/+$/, '');
  statusEl.textContent = 'Connecting...';
  statusEl.className = 'status-badge';
  try {
    const res = await fetch(gatewayUrl + '/health', { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    gatewayConnected = true;
    statusEl.textContent = 'Connected ✓ ' + (data.nodes || 0) + ' nodes';
    statusEl.className = 'status-badge ok';
    loadProviders();
  } catch (e: any) {
    gatewayConnected = false;
    statusEl.textContent = 'Failed: ' + (e.message || 'unreachable');
    statusEl.className = 'status-badge err';
  }
}

async function loadProviders(): Promise<void> {
  if (!gatewayConnected) return;
  try {
    const res = await fetch(gatewayUrl + '/api/providers');
    providersCache = await res.json();
    renderProviders();
  } catch (e: any) {
    const list = document.getElementById('providers-list');
    if (list) list.innerHTML = '<div class="info-text" style="color:var(--error-fg)">Failed to load providers: ' + escHtml(e.message) + '</div>';
  }
}

function renderProviders(): void {
  const el = document.getElementById('providers-list');
  if (!el) return;
  if (providersCache.length === 0) {
    el.innerHTML = '<div class="info-text">No providers configured. Click "+ Add Provider" or connect to the Pou gateway.</div>';
    return;
  }
  let html = '';
  for (const p of providersCache) {
    const enabled = p.enabled !== false;
    const models = (p.models || []).map((m: string) => '<span style="display:inline-block;background:var(--input-bg);border:1px solid var(--border);padding:1px 6px;border-radius:3px;font-size:11px;margin:2px;">' + escHtml(m) + '</span>').join(' ');
    html += '<div style="border:1px solid var(--border);border-radius:4px;margin-bottom:8px;overflow:hidden;">';
    html += '<div style="padding:8px 10px;background:var(--tab-hover);cursor:pointer;display:flex;align-items:center;gap:8px;" class="prov-header" data-pid="' + escHtml(p.id) + '">';
    html += '<strong style="flex:1;font-size:13px;">' + escHtml(p.name) + '</strong>';
    html += '<span style="font-size:11px;color:var(--vscode-descriptionForeground);">' + escHtml(p.type) + '</span>';
    html += '<span style="font-size:11px;color:' + (enabled ? 'var(--ok-fg)' : 'var(--error-fg)') + ';">' + (enabled ? '● On' : '● Off') + '</span>';
    html += '<span class="arrow" style="font-size:10px;">▼</span>';
    html += '</div>';
    html += '<div class="prov-body" style="display:none;padding:10px;">';
    html += '<div class="field"><label>Name</label><input type="text" data-pid="' + escHtml(p.id) + '" data-f="name" value="' + escHtml(p.name) + '" /></div>';
    html += '<div class="field"><label>Type</label><select data-pid="' + escHtml(p.id) + '" data-f="type">' + PROVIDER_TYPES.map(t => '<option value="'+t+'"'+(p.type===t?' selected':'')+'>'+t+'</option>').join('') + '</select></div>';
    html += '<div class="field"><label>Base URL</label><input type="text" data-pid="' + escHtml(p.id) + '" data-f="baseUrl" value="' + escHtml(p.baseUrl||'') + '" placeholder="http://localhost:1234/v1" /></div>';
    html += '<div class="field"><label>API Key</label><input type="password" data-pid="' + escHtml(p.id) + '" data-f="apiKey" value="' + escHtml(p.apiKey||'') + '" placeholder="sk-..." /></div>';
    html += '<div class="field"><label>Default Model</label><input type="text" data-pid="' + escHtml(p.id) + '" data-f="defaultModel" value="' + escHtml(p.defaultModel||'') + '" /></div>';
    html += '<div class="field"><label>Models (comma-separated)</label><input type="text" data-pid="' + escHtml(p.id) + '" data-f="modelsStr" value="' + escHtml((p.models||[]).join(', ')) + '" /></div>';
    html += '<div class="field"><label><input type="checkbox" data-pid="' + escHtml(p.id) + '" data-f="enabled" '+(enabled?'checked':'')+' /> Enabled</label></div>';
    html += '<div style="margin-bottom:8px;">' + (models || '<span class="info-text">No models</span>') + '</div>';
    html += '<div style="display:flex;gap:6px;">';
    html += '<button class="small fetch-models-btn" data-pid="' + escHtml(p.id) + '" style="background:#1a4a2a;color:#66bb6a;">Fetch Models</button>';
    html += '<button class="small save-prov-btn" data-pid="' + escHtml(p.id) + '">Save</button>';
    html += '<button class="small danger del-prov-btn" data-pid="' + escHtml(p.id) + '">Delete</button>';
    html += '</div></div></div>';
  }
  el.innerHTML = html;
  wireProviderEvents();
}

function wireProviderEvents(): void {
  // Toggle expand/collapse
  document.querySelectorAll('.prov-header').forEach(header => {
    header.addEventListener('click', () => {
      const body = (header as HTMLElement).nextElementSibling as HTMLElement;
      const arrow = (header as HTMLElement).querySelector('.arrow') as HTMLElement;
      if (body.style.display === 'none') {
        body.style.display = 'block';
        if (arrow) arrow.style.transform = 'rotate(180deg)';
      } else {
        body.style.display = 'none';
        if (arrow) arrow.style.transform = '';
      }
    });
  });
  // Save buttons
  document.querySelectorAll('.save-prov-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = (btn as HTMLElement).dataset.pid!;
      const inputs = document.querySelectorAll('[data-pid="'+id+'"]');
      const data: any = { id };
      inputs.forEach(el => {
        const f = (el as HTMLElement).dataset.f;
        if (f === 'modelsStr') data.models = (el as HTMLInputElement).value.split(',').map(s=>s.trim()).filter(Boolean);
        else if (f === 'enabled') data.enabled = (el as HTMLInputElement).checked;
        else if (f === 'apiKey') { if ((el as HTMLInputElement).value) data.apiKey = (el as HTMLInputElement).value; }
        else if (f) data[f] = (el as HTMLInputElement).value;
      });
      try {
        await fetch(gatewayUrl + '/api/providers/' + encodeURIComponent(id), { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
        showToast('Provider saved');
        loadProviders();
      } catch(e: any) { showToast('Save failed: ' + e.message, 'error'); }
    });
  });
  // Delete buttons
  document.querySelectorAll('.del-prov-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = (btn as HTMLElement).dataset.pid!;
      if (!confirm('Delete provider "' + id + '"?')) return;
      try {
        await fetch(gatewayUrl + '/api/providers/' + encodeURIComponent(id), { method: 'DELETE' });
        showToast('Provider deleted');
        loadProviders();
      } catch(e: any) { showToast('Delete failed: ' + e.message, 'error'); }
    });
  });
  // Fetch Models buttons
  document.querySelectorAll('.fetch-models-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = (btn as HTMLElement).dataset.pid!;
      (btn as HTMLButtonElement).textContent = 'Fetching...';
      (btn as HTMLButtonElement).disabled = true;
      try {
        const res = await fetch(gatewayUrl + '/api/providers/' + encodeURIComponent(id) + '/fetch-models', { method: 'POST' });
        const data = await res.json();
        if (data.error) showToast('Error: ' + data.error, 'error');
        else { showToast('Found ' + data.models.length + ' models'); loadProviders(); }
      } catch(e: any) { showToast('Fetch failed: ' + e.message, 'error'); }
      (btn as HTMLButtonElement).textContent = 'Fetch Models';
      (btn as HTMLButtonElement).disabled = false;
    });
  });
}

// Wire gateway buttons
document.getElementById('gateway-connect')?.addEventListener('click', connectGateway);
document.getElementById('refresh-providers')?.addEventListener('click', loadProviders);
document.getElementById('add-provider')?.addEventListener('click', async () => {
  if (!gatewayConnected) { showToast('Connect to gateway first', 'error'); return; }
  const id = 'provider-' + Date.now();
  try {
    await fetch(gatewayUrl + '/api/providers', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id, name: 'New Provider', type: 'openai', models: [], enabled: true }) });
    showToast('Provider added');
    loadProviders();
  } catch(e: any) { showToast('Add failed: ' + e.message, 'error'); }
});

// Auto-connect on load
setTimeout(connectGateway, 500);

// --- Init -------------------------------------------------
post({ type: 'ready' });
post({ type: 'getConfig' });
