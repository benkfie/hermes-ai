/**
 * McpManager — Wraps the `hermes mcp` CLI for managing MCP servers.
 *
 * All operations shell out to hermes CLI for validation and persistence.
 */
import { execSync } from 'child_process';
import { getHermesPath } from './configManager';

export interface McpServer {
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  status: 'connected' | 'disconnected' | 'error' | 'unknown';
  toolCount?: number;
  errorMessage?: string;
}

/**
 * List all configured MCP servers.
 */
export function listMcpServers(): McpServer[] {
  const hermes = getHermesPath();
  let output: string;
  try {
    output = execSync(`"${hermes}" mcp list`, { encoding: 'utf8', timeout: 10_000 });
  } catch {
    return [];
  }
  return parseMcpList(output);
}

/**
 * Add a new MCP server.
 *
 * @param name   Server name
 * @param config Transport-specific config (command+args for stdio, url for sse/http)
 */
export function addMcpServer(
  name: string,
  config: { type: 'stdio'; command: string; args?: string[] } | { type: 'sse' | 'http'; url: string },
): void {
  const hermes = getHermesPath();

  try {
    if (config.type === 'stdio') {
      const args = config.args ? config.args.join(' ') : '';
      execSync(`"${hermes}" mcp add ${quoteArg(name)} --stdio ${quoteArg(config.command)} ${args}`, {
        encoding: 'utf8',
        timeout: 15_000,
      });
    } else {
      execSync(`"${hermes}" mcp add ${quoteArg(name)} --url ${quoteArg(config.url)}`, {
        encoding: 'utf8',
        timeout: 15_000,
      });
    }
  } catch (err) {
    throw new Error(`Failed to add MCP server "${name}": ${err}`);
  }
}

/**
 * Remove an MCP server.
 */
export function removeMcpServer(name: string): void {
  const hermes = getHermesPath();
  try {
    execSync(`"${hermes}" mcp remove ${quoteArg(name)}`, {
      encoding: 'utf8',
      timeout: 10_000,
    });
  } catch (err) {
    throw new Error(`Failed to remove MCP server "${name}": ${err}`);
  }
}

/**
 * Test connection to an MCP server.
 */
export function testMcpServer(name: string): { ok: boolean; message: string } {
  const hermes = getHermesPath();
  try {
    const output = execSync(`"${hermes}" mcp test ${quoteArg(name)}`, {
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { ok: true, message: output.trim() || 'Connected successfully' };
  } catch (err: any) {
    return { ok: false, message: err.stderr || err.message || 'Connection failed' };
  }
}

// ── Private helpers ──────────────────────────────────

/**
 * Parse `hermes mcp list` output into McpServer objects.
 *
 * The exact output format depends on the hermes CLI version.
 * We attempt several parsing strategies.
 */
function parseMcpList(output: string): McpServer[] {
  const servers: McpServer[] = [];

  // Strategy 1: Try to find JSON output
  try {
    const jsonStart = output.indexOf('[');
    const jsonEnd = output.lastIndexOf(']');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      const jsonStr = output.substring(jsonStart, jsonEnd + 1);
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed)) {
        return parsed.map((s: any) => ({
          name: s.name || 'unknown',
          transport: s.transport || 'stdio',
          command: s.command,
          args: s.args,
          url: s.url,
          status: s.status || 'unknown',
          toolCount: s.toolCount || s.tools?.length,
          errorMessage: s.errorMessage || s.error,
        }));
      }
    }
  } catch {
    // Fall through to manual parsing
  }

  // Strategy 2: Parse human-readable table (fallback)
  const lineArray = output.split('\n');
  let current: Partial<McpServer> | null = null;

  for (const line of lineArray) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Detect server name (indented or prefixed)
    const nameMatch = trimmed.match(/^[-•*]\s+(.+?)(?:\s+\[(connected|disconnected|error)\])?\s*$/);
    if (nameMatch) {
      if (current && current.name) {
        servers.push(current as McpServer);
      }
      current = {
        name: nameMatch[1],
        transport: 'stdio',
        status: (nameMatch[2] as McpServer['status']) || 'unknown',
      };
      continue;
    }

    // Simple line-based: "name: status"
    const simpleMatch = trimmed.match(/^(.+?):\s+(connected|disconnected|error|unknown)$/i);
    if (simpleMatch) {
      servers.push({
        name: simpleMatch[1],
        transport: 'stdio',
        status: simpleMatch[2].toLowerCase() as McpServer['status'],
      });
      continue;
    }

    // Any other non-empty, non-box-drawing line — assume it's a server name
    if (trimmed && !trimmed.startsWith('◆') && !trimmed.startsWith('─')
        && !trimmed.startsWith('┌') && !trimmed.startsWith('└') && !trimmed.startsWith('│')) {
      servers.push({
        name: trimmed,
        transport: 'stdio',
        status: 'unknown',
      });
    }
  }

  // Flush last entry
  if (current && current.name) {
    servers.push(current as McpServer);
  }

  return servers;
}

function quoteArg(value: string): string {
  if (/["\s]/.test(value)) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}
