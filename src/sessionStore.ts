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

  constructor(
      private readonly context: vscode.ExtensionContext,
      private readonly getCwd: () => string = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
    ) {
      const saved = context.workspaceState.get<ChatSession[]>(SESSIONS_KEY);
      if (saved && saved.length > 0) {
        // Filter out sessions with non-ACP acpSessionId (old TUI sessions that got mixed in)
        // Only keep sessions with no acpSessionId (pure local) or valid ACP IDs (acp-...)
        this.sessions = saved
          .map(s => ({ ...s, messages: s.messages ?? [], lastActive: s.lastActive ?? 0 }))
          .filter(s => !s.acpSessionId || s.acpSessionId.startsWith('acp-'));
        // Find the most recently active session
        this.activeSessionId = this.sessions
          .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))[0]?.id ?? '';
      }
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
    if (!this.acpClient) {
      return [...this.sessions].sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
    }

    try {
      const acpSessions = await this.acpClient.listSessions(this.getCwd());
      const byAcpId = new Map(acpSessions.map(s => [s.session_id, s]));
      
      // Start with extension sessions (they have local messages)
      const merged = [...this.sessions];
      
      // Add ACP sessions that don't have a corresponding extension session
      for (const acp of acpSessions) {
        const existing = this.sessions.find(s => s.acpSessionId === acp.session_id);
        if (!existing) {
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
            existing.title = acp.title;
            existing.lastActive = new Date(acp.updated_at).getTime();
          }
        }
      }
      
      // Sort by lastActive descending (newest first)
      return merged.sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
    } catch (err) {
      console.error('[SessionStore] Failed to fetch ACP sessions:', err);
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
      // Check extension sessions first
      let target = this.sessions.find(s => s.id === sessionId);
      if (!target) {
        // Only try to find by acpSessionId if it's a valid ACP ID
        if (sessionId.startsWith('acp-')) {
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
    if (!DEFAULT_TITLES.has(s.title)) return s.title;
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