/**
 * Session persistence layer.
 *
 * Manages ChatSession[] in VS Code workspaceState.
 * Also reads sessions from ACP server (`session/list`) to show
 * sessions created via the CLI/TUI/desktop app.
 */

import * as vscode from 'vscode';
import type { ChatSession, StoredMessage } from './types';
import type { AcpClient, AcpSessionInfo } from './acpClient';

const SESSIONS_KEY = 'hermes-ai.sessions';
const MAX_SESSIONS = 20;
const MAX_MESSAGES_PER_SESSION = 300;

export class SessionStore {
  private sessions: ChatSession[] = [];
  private activeSessionId = '';
  private acpClient: AcpClient | null = null;

  private logger: (line: string) => void = console.warn;

  constructor(
      private readonly context: vscode.ExtensionContext,
      private readonly getCwd: () => string = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
    ) {
      const saved = context.workspaceState.get<ChatSession[]>(SESSIONS_KEY);
      if (saved && saved.length > 0) {
        // Filter out only backup sessions (which start with 'backup-').
        // Keep pure local, TUI (timestamp-based), and UUID-based ACP sessions.
        this.sessions = saved
          .map(s => ({ ...s, messages: s.messages ?? [], lastActive: s.lastActive ?? 0 }))
          .filter(s => !s.acpSessionId || !s.acpSessionId.startsWith('backup-'));
        // Find the most recently active session
        this.activeSessionId = this.sessions
          .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))[0]?.id ?? '';
      }
    }

  setLogger(logFn: (line: string) => void): void {
    this.logger = logFn;
  }

  setAcpClient(client: AcpClient): void {
    this.acpClient = client;
  }

  // ── Getters ────────────────────────────────────────────

  get activeId(): string { return this.activeSessionId; }

  active(): ChatSession | undefined {
    return this.sessions.find(s => s.id === this.activeSessionId);
  }

  async allSessions(): Promise<ChatSession[]> {
    this.logger('[SessionStore] allSessions called, acpClient exists: ' + !!this.acpClient);
    if (!this.acpClient) {
      this.logger('[SessionStore] returning local sessions only: ' + this.sessions.length);
      return [...this.sessions].sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
    }

    this.logger('[SessionStore] calling listSessions globally');
    try {
      const acpSessions = await this.acpClient.listSessions(undefined);
      this.logger('[SessionStore] listSessions returned count: ' + acpSessions.length);
      for (const s of acpSessions) {
        this.logger(`[SessionStore] ACP session: ID=${s.session_id}, title=${s.title}, cwd=${s.cwd}, updated_at=${s.updated_at}`);
      }
      
      const byAcpId = new Map(acpSessions.map(s => [s.session_id, s]));
      
      // Start with extension sessions (they have local messages)
      const merged = [...this.sessions];
      this.logger('[SessionStore] initial local sessions count: ' + this.sessions.length);
      
      // Add ACP sessions that don't have a corresponding extension session
      for (const acp of acpSessions) {
        const existing = this.sessions.find(s => s.acpSessionId === acp.session_id);
        if (!existing) {
          this.logger('[SessionStore] merging new ACP session: ' + acp.session_id);
          merged.push({
            id: `ext-${acp.session_id}`,  // prefix to avoid collision
            title: acp.title || acp.session_id.slice(0, 8),
            createdAt: Date.now(),
            messages: [],
            acpSessionId: acp.session_id,
            lastActive: acp.updated_at ? new Date(acp.updated_at).getTime() : 0,
          });
        } else {
          // Update title from server if it's more recent
          if (acp.updated_at && acp.title && existing.title !== acp.title) {
            this.logger('[SessionStore] updating existing session title: ' + existing.id + ' -> ' + acp.title);
            existing.title = acp.title;
            existing.lastActive = new Date(acp.updated_at).getTime();
          }
        }
      }
      
      // Sort by lastActive descending (newest first)
      const sorted = merged.sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
      this.logger('[SessionStore] total merged sessions count: ' + sorted.length);
      return sorted;
    } catch (err: any) {
      this.logger('[SessionStore] Failed to fetch ACP sessions: ' + err.message);
      return [...this.sessions].sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
    }
  }

  allSessionsReversed(): ChatSession[] {
    // For backwards compatibility - sync version
    // Note: this won't include ACP sessions, call async allSessions() instead
    return [...this.sessions].reverse();
  }

  // ── Create / Switch / Delete ───────────────────────

  createSession(title: string): string {
    const id = `s${Date.now()}`;
    this.sessions.push({ id, title, createdAt: Date.now(), messages: [], lastActive: Date.now() });
    this.activeSessionId = id;
    if (this.sessions.length > MAX_SESSIONS) {
      // Keep newest by lastActive
      this.sessions.sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
      this.sessions = this.sessions.slice(0, MAX_SESSIONS);
    }
    this.persist();
    return id;
  }

  switchTo(sessionId: string): ChatSession | undefined {
    // Check extension sessions first by local id
    let target = this.sessions.find(s => s.id === sessionId);
    if (!target) {
      // If it starts with ext-, extract the acpSessionId
      if (sessionId.startsWith('ext-')) {
        const acpId = sessionId.slice(4);
        target = this.sessions.find(s => s.acpSessionId === acpId);
        if (!target) {
          // It's a server session we haven't wrapped locally yet.
          // Create a local session wrapping it!
          target = {
            id: sessionId,
            title: acpId.slice(0, 8),
            createdAt: Date.now(),
            messages: [],
            acpSessionId: acpId,
            lastActive: Date.now(),
          };
          this.sessions.push(target);
          this.persist();
        }
      } else if (sessionId.startsWith('acp-')) {
        // Fallback for raw ACP IDs
        target = this.sessions.find(s => s.acpSessionId === sessionId);
      }
    }
    if (!target || target.id === this.activeSessionId) return undefined;
    this.activeSessionId = target.id;
    target.lastActive = Date.now();
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
    s.lastActive = Date.now();
    this.persist();
    return true;
  }

  // ── Auto-title ─────────────────────────────────────

  autoTitle(text: string): string | null {
    const s = this.active();
    if (!s) return null;
    if (s.messages.some(m => m.role === 'user')) return null;
    // Don't overwrite a meaningful title (e.g. one synced from the ACP server).
    // Only auto-title when the session is still on its default placeholder.
    const DEFAULT_TITLES = new Set(['new session', 'untitled', '']);
    if (!DEFAULT_TITLES.has(s.title)) return null;  // title already set by ACP sync
    s.title = text.slice(0, 38).replace(/\s+/g, ' ').trim();
    if (text.length > 38) s.title = s.title.slice(0, 35) + '\u2026';
    s.lastActive = Date.now();
    this.persist();
    return s.title;
  }

  // ── Message storage ────────────────────────────────

  addUserMessage(text: string): void {
    const s = this.active();
    if (s) {
      s.messages.push({ role: 'user', text });
      s.lastActive = Date.now();
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
    s.lastActive = Date.now();
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

  /** Get local sessions that have messages but no acpSessionId (unsynced to ACP). */
  getLocalUnsyncedSessions(): ChatSession[] {
    return this.sessions.filter(s => s.messages.length > 0 && !s.acpSessionId);
  }

  /** Set acpSessionId for a specific session by its local id. */
  setAcpSessionIdForSession(sessionId: string, acpId: string): void {
    const s = this.sessions.find(s => s.id === sessionId);
    if (s) {
      s.acpSessionId = acpId;
      this.persist();
    }
  }

  // ── Ensure first session ───────────────────────────

  ensureSession(): void {
    if (this.sessions.length === 0) {
      this.createSession('new session');
    }
  }

  // ── Persistence ────────────────────────────────────
  
  /** Persist the currently active session (used after replay sync). */
  persistActive(): void {
    this.persist();
  }

  private persist(): void {
    void this.context.workspaceState.update(SESSIONS_KEY, this.sessions);
  }
}