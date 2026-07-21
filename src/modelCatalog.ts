/**
 * Model catalog — loads available models for the model switcher dropdown.
 * Reads from Hermes config to determine the active provider and model,
 * then builds appropriate model groups.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

export interface ModelMenuItem {
  id: string;
  label: string;
  command: string;
}

export interface ModelMenuGroup {
  group: string;
  items: ModelMenuItem[];
}

// Common OpenRouter models (user's default provider)
const OPENROUTER_MODEL_IDS = [
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v4-pro',
  'google/gemma-4-26b-a4b-it',
  'google/gemini-2.5-pro',
  'google/gemini-2.5-flash',
  'anthropic/claude-sonnet-4-6',
  'anthropic/claude-opus-4-6',
  'anthropic/claude-haiku-4-5-20251001',
  'openai/gpt-4.1',
  'openai/gpt-4.1-mini',
  'openai/gpt-5.4',
  'meta-llama/llama-4-maverick',
  'meta-llama/llama-4-scout',
  'mistral/mistral-large',
  'qwen/qwen3-235b-a22b',
];

// Label overrides for cleaner display
const LABEL_OVERRIDES: Record<string, string> = {
  'deepseek/deepseek-v4-flash': 'DeepSeek V4 Flash (fast)',
  'deepseek/deepseek-v4-pro': 'DeepSeek V4 Pro (smart)',
  'google/gemma-4-26b-a4b-it': 'Gemma 4 26B',
  'google/gemini-2.5-pro': 'Gemini 2.5 Pro',
  'google/gemini-2.5-flash': 'Gemini 2.5 Flash',
  'anthropic/claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'anthropic/claude-opus-4-6': 'Claude Opus 4.6',
  'anthropic/claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
  'openai/gpt-4.1': 'GPT-4.1',
  'openai/gpt-4.1-mini': 'GPT-4.1 Mini',
  'openai/gpt-5.4': 'GPT-5.4',
  'meta-llama/llama-4-maverick': 'Llama 4 Maverick',
  'meta-llama/llama-4-scout': 'Llama 4 Scout',
  'mistral/mistral-large': 'Mistral Large',
  'qwen/qwen3-235b-a22b': 'Qwen3 235B',
};

function formatLabel(modelId: string): string {
  return LABEL_OVERRIDES[modelId] || modelId;
}

/**
 * Read the currently configured model from Hermes config.
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
        // Inline dict — try to extract 'default'
        const defaultMatch = /'default':\s*'([^']*)'/.exec(inlineValue);
        if (defaultMatch) return defaultMatch[1];
        return inlineValue;
      }

      // Multi-line: scan children for 'default:'
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
  } catch {
    // Config not readable
  }
  return '';
}

export function loadHermesModelGroups(): ModelMenuGroup[] {
  const currentModel = readCurrentModel();
  const groups: ModelMenuGroup[] = [];

  // Always add a "Current" group showing the active model
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

  // Add OpenRouter group (most common provider for Hermes users)
  groups.push({
    group: 'OpenRouter',
    items: OPENROUTER_MODEL_IDS.map(id => ({
      id,
      label: formatLabel(id),
      command: id,
    })),
  });

  // Always add a Custom group for manual model entry
  groups.push({
    group: 'Custom',
    items: [
      { id: 'custom', label: 'Type a model ID...', command: '__custom__' },
    ],
  });

  return groups;
}
