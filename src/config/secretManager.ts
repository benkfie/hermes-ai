/**
 * SecretManager — Reads and writes the Hermes .env file.
 *
 * The .env file stores API keys and other secrets as KEY=VALUE pairs.
 * Values are masked in memory — only the last 4 characters are ever shown.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getEnvPath } from './configManager';

export interface EnvEntry {
  key: string;
  value: string;       // plaintext value (loaded, not transmitted)
  masked: string;      // display-safe: "sk-o...example"
  isSet: boolean;
}

/**
 * Read and parse the .env file into a list of entries with masked values.
 */
export function readEnv(): EnvEntry[] {
  const envPath = getEnvPath();
  if (!fs.existsSync(envPath)) {
    return [];
  }

  const content = fs.readFileSync(envPath, 'utf8');
  const entries: EnvEntry[] = [];
  const lineArray = content.split('\n');

  for (const line of lineArray) {
    const trimmed = line.trim();
    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const key = trimmed.substring(0, eqIdx).trim();
    const value = trimmed.substring(eqIdx + 1).trim();

    entries.push({
      key,
      value,
      masked: maskSecret(value),
      isSet: value.length > 0,
    });
  }

  return entries;
}

/**
 * Write or update entries in the .env file.
 * Existing entries with the same key are updated; new entries are appended.
 * Comments and other content are preserved.
 */
export function writeEnv(updates: Array<{ key: string; value: string }>): void {
  const envPath = getEnvPath();

  // Read existing content
  let content = '';
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf8');
  }

  const lineArray = content.split('\n');
  const updatedKeys = new Set<string>();

  // Update existing lines in-place
  for (let i = 0; i < lineArray.length; i++) {
    const trimmed = lineArray[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const key = trimmed.substring(0, eqIdx).trim();
    const update = updates.find((u) => u.key === key);
    if (update) {
      lineArray[i] = `${key}=${update.value}`;
      updatedKeys.add(key);
    }
  }

  // Append new keys
  for (const update of updates) {
    if (!updatedKeys.has(update.key)) {
      lineArray.push(`${update.key}=${update.value}`);
    }
  }

  // Ensure trailing newline
  fs.writeFileSync(envPath, lineArray.join('\n') + '\n', 'utf8');
}

/**
 * Remove an entry from the .env file by key.
 */
export function removeEnvEntry(key: string): void {
  const envPath = getEnvPath();
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, 'utf8');
  const lines = content.split('\n').filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return true;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) return true;

    const lineKey = trimmed.substring(0, eqIdx).trim();
    return lineKey !== key;
  });

  fs.writeFileSync(envPath, lines.join('\n'), 'utf8');
}

/**
 * Check if the .env file exists.
 */
export function envFileExists(): boolean {
  return fs.existsSync(getEnvPath());
}

/**
 * Mask a secret value for display.
 * "sk-or-...example" → "sk-o...example"
 * "(not set)" → "(not set)"
 */
export function maskSecret(value: string): string {
  if (!value || value === '(not set)') return '(not set)';

  if (value.length <= 8) {
    return value.substring(0, 2) + '...' + value.substring(value.length - 2);
  }

  // Show first 4 + "..." + last 4
  return value.substring(0, 4) + '...' + value.substring(value.length - 4);
}
