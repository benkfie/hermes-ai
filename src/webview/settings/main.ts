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

// --- Init -------------------------------------------------
post({ type: 'ready' });
post({ type: 'getConfig' });
