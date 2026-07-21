/**
 * Session persistence layer.
 *
 * Manages ChatSession[] in VS Code workspaceState.
 * Also reads sessions from Hermes CLI (`hermes sessions list`) to show
 * sessions created via the CLI/TUI.
 */
import * as vscode from 'vscode';
import { execSync } from 'child_process';
import type { ChatSession, StoredMessage } from './types';

const SESSIONS_KEY = 'hermes-ai.sessions';
const MAX_SESSIONS = 20;
const MAX_MESSAGES_PER_SESSION = 300;

export interface HermesCliSession {
  id: string;
  title: string;
  preview: string;
  lastActive: string;
}

export class SessionStore {
  private sessions: ChatSession[] = [];
  private activeSessionId = '';

  constructor(private readonly context: vscode.ExtensionContext) {
    const saved = context.workspaceState.get<ChatSession[]>(SESSIONS_KEY);
    if (saved && saved.length > 0) {
      this.sessions = saved.map(s => ({ ...s, messages: s.messages ?? [] }));
      this.activeSessionId = this.sessions[this.sessions.length - 1].id;
    }
  }

  // ── Getters ────────────────────────────────────────

  get activeId(): string { return this.activeSessionId; }

  active(): ChatSession | undefined {
    return this.sessions.find(s => s.id === this.activeSessionId);
  }

  allSessions(): ChatSession[] {
    // Merge extension sessions with Hermes CLI sessions
    const hermesSessions = this.readHermesSessions();
    // Convert Hermes sessions to ChatSession format
    const converted: ChatSession[] = hermesSessions.map(hs => ({
      id: hs.id,
      title: hs.title || hs.preview || 'untitled',
      createdAt: Date.now(), // approximate
      messages: [],
      acpSessionId: hs.id,
    }));

    // Deduplicate by ID, preferring existing extension sessions
    const existingIds = new Set(this.sessions.map(s => s.id));
    const merged = [...this.sessions];
    for (const cs of converted) {
      if (!existingIds.has(cs.id)) {
        merged.push(cs);
        existingIds.add(cs.id);
      }
    }

    // Sort: newest first (approximate by ID order)
    return merged;
  }

  allSessionsReversed(): ChatSession[] {
    return [...this.allSessions()].reverse();
  }

  /**
   * Read Hermes CLI sessions via `hermes sessions list`.
   */
  private readHermesSessions(): HermesCliSession[] {
    try {
      const output = execSync('hermes sessions list', {
        encoding: 'utf8',
        timeout: 5000,
        env: { ...process.env },
      });
      return parseSessionList(output);
    } catch {
      return [];
    }
  }

  // ── Create / Switch / Delete ───────────────────────

  createSession(title: string): string {
    const id = `s${Date.now()}`;
    this.sessions.push({ id, title, createdAt: Date.now(), messages: [] });
    this.activeSessionId = id;
    if (this.sessions.length > MAX_SESSIONS) {
      this.sessions = this.sessions.slice(-MAX_SESSIONS);
    }
    this.persist();
    return id;
  }

  switchTo(sessionId: string): ChatSession | undefined {
    // Check extension sessions first, then Hermes sessions
    let target = this.sessions.find(s => s.id === sessionId);
    if (!target) {
      // It might be a Hermes CLI session — create an extension session for it
      const hermesSessions = this.readHermesSessions();
      const hs = hermesSessions.find(h => h.id === sessionId);
      if (hs) {
        target = {
          id: hs.id,
          title: hs.title || hs.preview || 'untitled',
          createdAt: Date.now(),
          messages: [],
          acpSessionId: hs.id,
        };
        this.sessions.push(target);
        this.persist();
      }
    }
    if (!target || target.id === this.activeSessionId) return undefined;
    this.activeSessionId = sessionId;
    this.persist();
    return target;
  }

  deleteSession(sessionId: string): boolean {
    if (sessionId === this.activeSessionId) return false;
    this.sessions = this.sessions.filter(s => s.id !== sessionId);
    this.persist();
    return true;
  }

  rename(sessionId: string, newTitle: string): boolean {
    const s = this.sessions.find(s => s.id === sessionId);
    if (!s) return false;
    s.title = newTitle.slice(0, 60);
    this.persist();
    return true;
  }

  // ── Auto-title ─────────────────────────────────────

  autoTitle(text: string): string | null {
    const s = this.active();
    if (!s) return null;
    if (s.messages.some(m => m.role === 'user')) return null;
    s.title = text.slice(0, 38).replace(/\s+/g, ' ').trim();
    if (text.length > 38) s.title = s.title.slice(0, 35) + '\u2026';
    this.persist();
    return s.title;
  }

  // ── Message storage ────────────────────────────────

  addUserMessage(text: string): void {
    const s = this.active();
    if (s) {
      s.messages.push({ role: 'user', text });
      this.persist();
    }
  }

  addTurnMessages(tools: StoredMessage[], agentText: string): void {
    const s = this.active();
    if (!s) return;
    for (const t of tools) s.messages.push(t);
    if (agentText.trim()) s.messages.push({ role: 'agent', text: agentText });
    if (s.messages.length > MAX_MESSAGES_PER_SESSION) {
      s.messages = s.messages.slice(-MAX_MESSAGES_PER_SESSION);
    }
    this.persist();
  }

  // ── ACP session ID ─────────────────────────────────

  setAcpSessionId(acpId: string): void {
    const s = this.active();
    if (s && s.acpSessionId !== acpId) {
      s.acpSessionId = acpId;
      this.persist();
    }
  }

  getAcpSessionId(): string | undefined {
    return this.active()?.acpSessionId;
  }

  // ── Ensure first session ───────────────────────────

  ensureSession(): void {
    if (this.sessions.length === 0) {
      this.createSession('new session');
    }
  }

  // ── Persistence ────────────────────────────────────

  private persist(): void {
    void this.context.workspaceState.update(SESSIONS_KEY, this.sessions);
  }
}

/**
 * Parse `hermes sessions list` output into HermesCliSession[].
 *
 * Output format:
 *   Title                    Preview                    Last Active   ID
 *   ────────────────────────────────────────────────────────────────
 *   My Session               Hi Hermes...              just now      abc123...
 *   —                        ...                       1h ago        def456...
 */
function parseSessionList(output: string): HermesCliSession[] {
  const sessions: HermesCliSession[] = [];
  const lines = output.split('\n');
  let headerFound = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Skip the header and separator lines
    if (!headerFound) {
      if (trimmed.startsWith('Title')) {
        headerFound = true;
      }
      continue;
    }
    if (trimmed.startsWith('─') || trimmed.startsWith('┌') || trimmed.startsWith('└') || trimmed.startsWith('│')) continue;

    // Parse session line: "Title    Preview    Last Active    ID"
    // The ID is always the last column. Format: UUID or timestamp-based ID
    const idMatch = trimmed.match(/\s+([\w-]{8,}(?:[\w-]{4,})*)$/);
    if (!idMatch) continue;

    const id = idMatch[1];
    const beforeId = trimmed.substring(0, trimmed.length - idMatch[0].length).trim();

    // Split remaining into title + preview + lastActive
    // Last active patterns: "just now", "5m ago", "1h ago", "2026-07-13", "yesterday"
    const lastActiveMatch = beforeId.match(/\s+(just now|\d+[mhd] ago|yesterday|\d{4}-\d{2}-\d{2}|\d{1,2}h ago)$/);
    let titleAndPreview = beforeId;
    let lastActive = '';
    if (lastActiveMatch) {
      lastActive = lastActiveMatch[1];
      titleAndPreview = beforeId.substring(0, beforeId.length - lastActiveMatch[0].length).trim();
    }

    // Title is the first 20-30 chars, preview is the rest
    // The table format: "Title (30) Preview (40) Last Active (12) ID (40)"
    let title = '';
    let preview = '';

    if (titleAndPreview.length > 38) {
      // If it's long enough, split at ~30 chars for title
      title = titleAndPreview.substring(0, 30).trim();
      preview = titleAndPreview.substring(30).trim();
    } else {
      title = titleAndPreview;
    }

    // Clean up title
    if (title === '—' || title === '') {
      title = preview.substring(0, 40) || 'untitled';
      preview = preview.length > 40 ? preview.substring(40) : '';
    }

    sessions.push({
      id,
      title: title || 'untitled',
      preview: preview || '',
      lastActive,
    });
  }

  return sessions;
}
