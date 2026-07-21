/**
 * Model catalog — dynamically loads available models from the Hermes config
 * and model cache. Shows whatever providers the user has configured.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ModelMenuItem {
  id: string;
  label: string;
  command: string;
}

export interface ModelMenuGroup {
  group: string;
  items: ModelMenuItem[];
}

// ── Config parsing ─────────────────────────────────

/**
 * Read the currently active model from config.yaml.
 */
function readCurrentModel(): string {
  try {
    const configPath = path.join(os.homedir(), '.hermes', 'config.yaml');
    const content = fs.readFileSync(configPath, 'utf8');
    const lines = content.split(/\r?\n/);
    let inModelBlock = false;
    let baseIndent = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const modelMatch = /^(\s*)model:\s*(.*)$/.exec(line);
      if (!modelMatch) continue;

      const inlineValue = modelMatch[2].trim();
      if (inlineValue) {
        const defaultMatch = /'default':\s*'([^']*)'/.exec(inlineValue);
        if (defaultMatch) return defaultMatch[1];
        return inlineValue;
      }

      baseIndent = modelMatch[1].length;
      for (let j = i + 1; j < lines.length; j++) {
        const childLine = lines[j];
        if (!childLine.trim() || childLine.trimStart().startsWith('#')) continue;
        const childIndent = (childLine.match(/^\s*/)?.[0].length) ?? 0;
        if (childIndent <= baseIndent) break;
        const defaultMatch = /^\s*default:\s*(\S+)/.exec(childLine);
        if (defaultMatch) return defaultMatch[1];
      }
      break;
    }
  } catch { /* ignore */ }
  return '';
}

/**
 * Read the configured provider name from config.yaml.
 * e.g. "custom:local-(127.0.0.1:1234)" or "openrouter"
 */
function readProviderName(): string {
  try {
    const configPath = path.join(os.homedir(), '.hermes', 'config.yaml');
    const content = fs.readFileSync(configPath, 'utf8');
    const match = /'provider':\s*'([^']+)'/.exec(content);
    if (match) return match[1];
  } catch { /* ignore */ }
  return '';
}

// ── Model cache ────────────────────────────────────

interface CacheEntry {
  id: string;
  name?: string;
  models?: Record<string, { id: string; name?: string }>;
}

interface ModelCache {
  [providerId: string]: CacheEntry;
}

function readModelCache(): ModelCache | null {
  const cachePath = path.join(os.homedir(), '.hermes', 'models_dev_cache.json');
  try {
    const raw = fs.readFileSync(cachePath, 'utf8');
    return JSON.parse(raw) as ModelCache;
  } catch {
    return null;
  }
}

// ── Env parsing (which providers have keys) ─────────

function readConfiguredProviders(): Set<string> {
  const providers = new Set<string>();
  const envPath = path.join(os.homedir(), '.hermes', '.env');
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.substring(0, eqIdx).trim().toUpperCase();
      const value = trimmed.substring(eqIdx + 1).trim();
      if (!value || value === '(not set)') continue;

      // Map env var names to provider ids
      if (key === 'OPENROUTER_API_KEY') providers.add('openrouter');
      else if (key === 'ANTHROPIC_API_KEY') providers.add('anthropic');
      else if (key === 'OPENAI_API_KEY') providers.add('openai');
      else if (key === 'GOOGLE_API_KEY' || key === 'GEMINI_API_KEY') providers.add('google');
      else if (key === 'DEEPSEEK_API_KEY') providers.add('deepseek');
      else if (key === 'MISTRAL_API_KEY') providers.add('mistral');
      else if (key === 'GROQ_API_KEY') providers.add('groq');
      else if (key === 'COHERE_API_KEY') providers.add('cohere');
      else if (key === 'TOGETHER_API_KEY') providers.add('together');
      else if (key === 'FIREWORKS_API_KEY') providers.add('fireworks');
      else if (key === 'PERPLEXITY_API_KEY') providers.add('perplexity');
      else if (key === 'LM_BASE_URL') providers.add('local');
    }
  } catch { /* ignore */ }

  // Also add the current active provider
  const active = readProviderName();
  if (active) {
    // Strip "custom:" prefix if present
    const clean = active.startsWith('custom:') ? active.substring(7) : active;
    providers.add(clean);
  }

  // Also add local if there's a base_url pointing to localhost or LM_BASE_URL set
  try {
    const configPath = path.join(os.homedir(), '.hermes', 'config.yaml');
    const content = fs.readFileSync(configPath, 'utf8');
    if (content.includes("'base_url': 'http://127.0.0.1") ||
        content.includes("'base_url': 'http://localhost") ||
        content.includes('localhost')) {
      providers.add('local');
    }
  } catch { /* ignore */ }

  // Also check LM_BASE_URL env var
  if (process.env.LM_BASE_URL) {
    providers.add('local');
  }

  return providers;
}

// ── Label helpers ──────────────────────────────────

const PROVIDER_LABELS: Record<string, string> = {
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Gemini',
  deepseek: 'DeepSeek',
  mistral: 'Mistral',
  groq: 'Groq',
  cohere: 'Cohere',
  together: 'Together AI',
  fireworks: 'Fireworks',
  perplexity: 'Perplexity',
  google: 'Gemini',
  local: 'Local',
};

function providerLabel(providerId: string): string {
  return PROVIDER_LABELS[providerId] || providerId;
}

function formatLabel(modelId: string, record?: { id: string; name?: string }): string {
  // Use the cache's name if available
  if (record?.name) return record.name;
  // Otherwise clean up the model ID
  return modelId
    .replace(/^.*\//, '')        // strip provider prefix (openrouter/, anthropic/, etc.)
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

// ── Build the model menu ───────────────────────────

export function loadHermesModelGroups(): ModelMenuGroup[] {
  const currentModel = readCurrentModel();
  const cache = readModelCache();
  const configuredProviders = readConfiguredProviders();
  const groups: ModelMenuGroup[] = [];

  // 1. Current model group
  if (currentModel) {
    groups.push({
      group: 'Current',
      items: [{
        id: currentModel,
        label: formatLabel(currentModel),
        command: currentModel,
      }],
    });
  }

  // 2. For each configured provider, show its models from the cache
  for (const providerId of configuredProviders) {
    const providerCache = cache?.[providerId];
    const models = providerCache?.models;

    let items: ModelMenuItem[] = [];

    if (models && Object.keys(models).length > 0) {
      // Sort alphabetically by name
      items = Object.entries(models)
        .sort(([, a], [, b]) => {
          const aName = (a.name || '').toLowerCase();
          const bName = (b.name || '').toLowerCase();
          return aName.localeCompare(bName);
        })
        .map(([id, record]) => ({
          id,
          label: formatLabel(id, record),
          command: id,
        }));
    }

    // For providers without a cache (e.g. local/custom), show the current model
    if (items.length === 0 && currentModel) {
      // Check if this model belongs to this provider
      // For local providers, always show the current model
      if (providerId === 'local' || (providerId === 'google' && currentModel.includes('gemini'))) {
        items = [{
          id: currentModel,
          label: formatLabel(currentModel),
          command: currentModel,
        }];
      }
    }

    if (items.length > 0) {
      groups.push({
        group: providerLabel(providerId),
        items: items.slice(0, 30),  // Show up to 30 models per provider
      });
    }
  }

  // 3. If no providers detected, show a helpful message + custom
  if (groups.length <= 1) {
    groups.push({
      group: 'No providers configured?',
      items: [
        { id: 'setup', label: 'Run: hermes model', command: 'setup' },
        { id: 'custom', label: 'Type a model ID...', command: '__custom__' },
      ],
    });
  }

  // 4. Always add Custom entry at the bottom
  groups.push({
    group: 'Custom',
    items: [
      { id: 'custom', label: 'Type a model ID...', command: '__custom__' },
    ],
  });

  return groups;
}
