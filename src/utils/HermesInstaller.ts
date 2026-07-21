/**
 * HermesInstaller — Auto-detect and install Hermes binary.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

/**
 * Detect Hermes binary location.
 * Checks: configured path -> PATH -> known locations.
 */
export function detectHermes(): string | null {
  // Check VS Code setting
  const configured = vscode.workspace.getConfiguration('hermes-ai').get<string>('path');
  if (configured && configured !== 'hermes' && fs.existsSync(configured)) {
    return configured;
  }

  // Check PATH
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    const result = execSync(`${whichCmd} hermes`, { encoding: 'utf8', timeout: 5000 }).trim();
    if (result && fs.existsSync(result)) {
      return result;
    }
  } catch {
    // Not in PATH
  }

  // Check known locations
  const knownPaths = process.platform === 'win32'
    ? [
        path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'hermes-agent', 'hermes.exe'),
        path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'hermes-agent', 'hermes'),
        path.join(os.homedir(), '.hermes', 'bin', 'hermes.exe'),
      ]
    : [
        path.join(os.homedir(), '.local', 'bin', 'hermes'),
        '/usr/local/bin/hermes',
        '/usr/bin/hermes',
      ];

  for (const candidate of knownPaths) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Get Hermes version string.
 */
export function getVersion(hermesPath?: string): string | null {
  try {
    const bin = hermesPath || detectHermes();
    if (!bin) return null;
    const output = execSync(`"${bin}" --version`, { encoding: 'utf8', timeout: 5000 }).trim();
    const match = output.match(/v(\d+\.\d+\.\d+)/);
    return match ? `v${match[1]}` : output;
  } catch {
    return null;
  }
}

/**
 * Check if Hermes is installed.
 */
export function isInstalled(): boolean {
  return detectHermes() !== null;
}

/**
 * Get the hermes binary path (resolved).
 * Returns the binary path or throws if not found.
 */
export function getBinaryPath(): string {
  const bin = detectHermes();
  if (!bin) {
    throw new Error(
      'Hermes binary not found. Install Hermes or configure the path in VS Code settings (hermes.path).',
    );
  }
  return bin;
}
