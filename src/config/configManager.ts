/**
 * ConfigManager — Reads and writes Hermes Agent configuration via the CLI.
 *
 * All operations shell out to `hermes config ...` rather than parsing YAML directly.
 * The CLI validates values before writing and handles edge cases (in-place keys, etc.).
 */
import { execSync } from 'child_process';
import * as vscode from 'vscode';

/** Parsed representation of `hermes config show` output */
export interface HermesConfig {
  paths: {
    config: string;
    secrets: string;
    install: string;
  };
  apiKeys: Record<string, string>;
  model: {
    baseUrl?: string;
    default: string;
    provider: string;
  };
  maxTurns: number;
  display: {
    personality: string;
    reasoning: boolean;
    bell: boolean;
    userPreview: string;
  };
  terminal: {
    backend: string;
    workingDir: string;
    timeout: number;
  };
  timezone: string;
  contextCompression: {
    enabled: boolean;
    threshold: string;
    targetRatio: string;
    protectLast: number;
    protectFirst: number;
    model: string;
  };
}

/** Section headers from `hermes config show` → flat keys */
const SECTION_MAP: Record<string, string> = {
  '◆ Paths': 'paths',
  '◆ API Keys': 'apiKeys',
  '◆ Model': 'model',
  '◆ Display': 'display',
  '◆ Terminal': 'terminal',
  '◆ Timezone': 'timezone',
  '◆ Context Compression': 'contextCompression',
  '◆ Messaging Platforms': 'messaging',
};

/**
 * Find the Hermes binary path.
 * 1. Check VS Code setting `hermes.path`
 * 2. Fall back to "hermes" (rely on PATH)
 */
export function getHermesPath(): string {
  const configured = vscode.workspace.getConfiguration('hermes').get<string>('path');
  if (configured && configured !== 'hermes') {
    return configured;
  }
  return 'hermes';
}

/**
 * Run `hermes config show` and parse the output into a typed object.
 */
export function getConfig(): HermesConfig {
  const hermes = getHermesPath();
  let output: string;
  try {
    output = execSync(`"${hermes}" config show`, { encoding: 'utf8', timeout: 10_000 });
  } catch (err) {
    throw new Error(`Failed to run hermes config show: ${err}`);
  }
  return parseConfigShow(output);
}

/**
 * Run `hermes config set <key> <value>`.
 */
export function setConfig(key: string, value: string): void {
  const hermes = getHermesPath();
  try {
    execSync(`"${hermes}" config set ${key} ${quoteArg(value)}`, {
      encoding: 'utf8',
      timeout: 10_000,
    });
  } catch (err) {
    throw new Error(`Failed to set hermes config ${key}: ${err}`);
  }
}

/**
 * Run `hermes config path` — returns absolute path to config.yaml.
 */
export function getConfigPath(): string {
  const hermes = getHermesPath();
  return execSync(`"${hermes}" config path`, { encoding: 'utf8', timeout: 5_000 }).trim();
}

/**
 * Run `hermes config env-path` — returns absolute path to .env.
 */
export function getEnvPath(): string {
  const hermes = getHermesPath();
  return execSync(`"${hermes}" config env-path`, { encoding: 'utf8', timeout: 5_000 }).trim();
}

/**
 * Extract model info from config.
 */
export function getModel(): { provider: string; model: string; baseUrl?: string } {
  const config = getConfig();
  return {
    provider: config.model.provider,
    model: config.model.default,
    baseUrl: config.model.baseUrl,
  };
}

/**
 * Set the model provider and default model.
 */
export function setModel(provider: string, modelName: string): void {
  setConfig('model.provider', provider);
  setConfig('model.default', modelName);
}

/**
 * Get list of configured API keys (names only, values masked).
 */
export function getApiKeys(): Record<string, string> {
  const config = getConfig();
  return config.apiKeys;
}

/**
 * Set an API key via `hermes auth add`.
 */
export function setApiKey(provider: string, value: string): void {
  const hermes = getHermesPath();
  try {
    execSync(`"${hermes}" auth add ${quoteArg(provider)} ${quoteArg(value)}`, {
      encoding: 'utf8',
      timeout: 10_000,
    });
  } catch (err) {
    throw new Error(`Failed to set API key for ${provider}: ${err}`);
  }
}

/**
 * Remove an API key via `hermes auth remove`.
 */
export function removeApiKey(provider: string): void {
  const hermes = getHermesPath();
  try {
    execSync(`"${hermes}" auth remove ${quoteArg(provider)}`, {
      encoding: 'utf8',
      timeout: 10_000,
    });
  } catch (err) {
    throw new Error(`Failed to remove API key for ${provider}: ${err}`);
  }
}

/**
 * Check if Hermes is installed and reachable.
 */
export function isHermesInstalled(): boolean {
  try {
    execSync(`"${getHermesPath()}" --version`, { encoding: 'utf8', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get Hermes version string.
 */
export function getHermesVersion(): string {
  try {
    return execSync(`"${getHermesPath()}" --version`, { encoding: 'utf8', timeout: 5_000 }).trim();
  } catch {
    return '(not installed)';
  }
}

// ── Private helpers ──────────────────────────────────

/**
 * Parse the output of `hermes config show` into a HermesConfig object.
 */
function parseConfigShow(output: string): HermesConfig {
  const config: HermesConfig = {
    paths: { config: '', secrets: '', install: '' },
    apiKeys: {},
    model: { default: '', provider: '' },
    maxTurns: 200,
    display: { personality: 'none', reasoning: true, bell: false, userPreview: '' },
    terminal: { backend: 'local', workingDir: '.', timeout: 180 },
    timezone: '(server-local)',
    contextCompression: {
      enabled: true,
      threshold: '50%',
      targetRatio: '20% of threshold',
      protectLast: 20,
      protectFirst: 3,
      model: '(auto)',
    },
  };

  let currentSection = '';
  const lines = output.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect section headers
    for (const [header, key] of Object.entries(SECTION_MAP)) {
      if (trimmed.includes(header)) {
        currentSection = key;
        break;
      }
    }

    if (!currentSection) continue;

    // Parse key-value pairs
    const kvMatch = trimmed.match(/^(.+?):\s+(.+)$/);
    if (!kvMatch) continue;

    const key = kvMatch[1].trim();
    const value = kvMatch[2].trim();

    switch (currentSection) {
      case 'paths':
        if (key === 'Config') config.paths.config = value;
        else if (key === 'Secrets') config.paths.secrets = value;
        else if (key === 'Install') config.paths.install = value;
        break;

      case 'apiKeys':
        config.apiKeys[key] = value;
        break;

      case 'model':
        if (key === 'Model') {
          const modelInfo = parseModelDict(value);
          config.model = { ...config.model, ...modelInfo };
        } else if (key === 'Max turns') {
          config.maxTurns = parseInt(value, 10) || 200;
        }
        break;

      case 'display':
        if (key === 'Personality') config.display.personality = value;
        else if (key === 'Reasoning') config.display.reasoning = value === 'on';
        else if (key === 'Bell') config.display.bell = value === 'on';
        else if (key === 'User preview') config.display.userPreview = value;
        break;

      case 'terminal':
        if (key === 'Backend') config.terminal.backend = value;
        else if (key === 'Working dir') config.terminal.workingDir = value;
        else if (key === 'Timeout') config.terminal.timeout = parseInt(value, 10) || 180;
        break;

      case 'timezone':
        if (key === 'Timezone') config.timezone = value;
        break;

      case 'contextCompression':
        if (key === 'Enabled') config.contextCompression.enabled = value === 'yes';
        else if (key === 'Threshold') config.contextCompression.threshold = value;
        else if (key === 'Target ratio') config.contextCompression.targetRatio = value;
        else if (key === 'Protect last') config.contextCompression.protectLast = parseInt(value, 10) || 20;
        else if (key === 'Protect first') config.contextCompression.protectFirst = parseInt(value, 10) || 3;
        else if (key === 'Model') config.contextCompression.model = value;
        break;
    }
  }

  return config;
}

/**
 * Parse the model dict string like:
 *   {'base_url': 'http://127.0.0.1:1234/v1', 'default': 'gemma-4-26b-a4b-styletune-v2-apex', 'provider': 'custom:local-(127.0.0.1:1234)'}
 */
function parseModelDict(raw: string): { baseUrl?: string; default: string; provider: string } {
  const result: { baseUrl?: string; default: string; provider: string } = {
    default: '',
    provider: '',
  };

  const baseUrlMatch = raw.match(/'base_url':\s*'([^']*)'/);
  const defaultMatch = raw.match(/'default':\s*'([^']*)'/);
  const providerMatch = raw.match(/'provider':\s*'([^']*)'/);

  if (baseUrlMatch) result.baseUrl = baseUrlMatch[1];
  if (defaultMatch) result.default = defaultMatch[1];
  if (providerMatch) result.provider = providerMatch[1];

  return result;
}

/**
 * Quote an argument for shell safety. Handles spaces and special chars.
 */
function quoteArg(value: string): string {
  if (/["\s]/.test(value)) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}
