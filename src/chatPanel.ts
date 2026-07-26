/**
 * ChatPanel — the VS Code WebviewView provider.
 * Renders the chat UI and bridges messages between the webview and SessionManager.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from './sessionManager';
import { SessionStore } from './sessionStore';
import { loadHermesModelGroups, ModelMenuGroup } from './modelCatalog';
import { loadHermesSkills, SkillGroup } from './skillCatalog';
import { buildChatHtml, escapeHtml } from './htmlTemplate';
import type { StoredMessage, ChatSession, ToWebview, FromWebview } from './types';
import { showDiff } from './hosts/VscodeDiffViewProvider';

export class ChatPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'hermes-ai.chatView';

  private view?: vscode.WebviewView;
  private busy = false;
  private messageQueue: string[] = [];
  private lastTurnText = '';
  private lastTurnTools: StoredMessage[] = [];
  /** Set while an ACP session/load history replay is streaming. */
  private replayingHistory = false;
  private replayBuffer: StoredMessage[] = [];
  private replayTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly store: SessionStore;
  private get modelGroups(): ModelMenuGroup[] { return loadHermesModelGroups(); }
  private readonly skillGroups: SkillGroup[] = loadHermesSkills();

  private selectedSkills: string[] = [];
  private attachedFiles: { name: string; path: string }[] = [];
  private toolCallLocations = new Map<string, { kind: string; paths: string[] }>();
  /** Snapshot file contents before agent edits them (for diff display). */
  private editSnapshots = new Map<string, string>();
  private readonly mediaRoot: string;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly session: SessionManager,
    private readonly initialModel: string = '—',
    private readonly hermesVersion: string = '',
    private readonly context: vscode.ExtensionContext,
    private readonly log: (line: string) => void = () => {},
  ) {
    this.mediaRoot = path.join(this.context.globalStorageUri.fsPath, 'media');
    fs.mkdirSync(this.mediaRoot, { recursive: true });
    this.store = new SessionStore(context);
    // Wire the ACP client into the store so it can fetch server-side sessions
    this.store.setAcpClient(session.getClient());
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.extensionUri, 'resources'),
        vscode.Uri.file(this.mediaRoot),
      ],
    };

    webviewView.webview.html = this.buildHtml(webviewView.webview);

    // Create first session if none exist
    this.store.ensureSession();

    // Restore ACP session ID from persisted state (enables Hermes context resume)
    const active = this.store.active();
    if (active?.acpSessionId) {
      this.session.setStoredSessionId(active.acpSessionId);
      this.log(`[session] will attempt resume of ACP session ${active.acpSessionId}`);
    }

    // Emit initial state
    setTimeout(() => {
      this.post({ type: 'statusBar', model: this.initialModel, version: this.hermesVersion, skillGroups: this.skillGroups });
      this.broadcastSessions();
      // Restore last session's history into the view
      if (active && active.messages.length > 0) {
        this.post({ type: 'loadHistory', history: active.messages, activeSessionId: this.store.activeId });
      }
    }, 150);

    webviewView.webview.onDidReceiveMessage((msg: any) => {
      if (msg.type === 'error') {
        this.log(`[webview-error] ${msg.text}`);
      } else {
        void this.handleFromWebview(msg);
      }
    });

    // Route session updates to the webview
    this.session.onUpdate((event) => {
      if (event.text) {
        // Convert MEDIA:/path references to webview-safe img URIs
        const converted = this.convertMediaPaths(event.text, webviewView.webview);
        this.lastTurnText += event.text;
        this.post({ type: 'append', text: converted });
        if (this.replayingHistory) {
          this.replayBuffer.push({ role: 'agent', text: event.text });
        }
      }

      if ((event as any).userText) {
        const userText = (event as any).userText as string;
        this.post({ type: 'userMessage', text: userText });
        if (this.replayingHistory) {
          this.replayBuffer.push({ role: 'user', text: userText });
        }
      }
      if (event.thinkingText) {
        this.post({ type: 'thinking', text: event.thinkingText });
      }
      // Persist AI-generated session title from ACP session_info_update.
      // The ACP adapter auto-titles sessions (maybe_auto_title) and emits the
      // proper title; we must store it so the session picker shows the real
      // title instead of the raw first-message text or "untitled".
      if (event.sessionTitle) {
        const activeId = this.store.activeId;
        if (activeId) {
          this.store.rename(activeId, event.sessionTitle);
          this.post({ type: 'statusBar', sessionTitle: event.sessionTitle });
          this.broadcastSessions();
          this.log(`[session] title synced from ACP: ${event.sessionTitle}`);
        }
      }

      if (event.toolTitle !== undefined) {
        // Buffer tool events during history replay
        if (this.replayingHistory && event.toolTitle) {
          const detail = event.toolDetail ? `: ${event.toolDetail}` : '';
          this.replayBuffer.push({ role: 'tool', text: `${event.toolTitle}${detail}` });
        }
        // Check for streaming terminal chunks (toolOutput type from sessionManager)
        if ((event as any).type === 'toolOutput' && event.toolCallId) {
          this.post({
            type: 'toolOutput',
            toolCallId: event.toolCallId,
            text: (event as any).toolOutput || '',
          });
        } else if (event.toolTitle === '' && event.toolCallId) {
          // tool_call_update — status change + output for existing tool
          this.post({
            type: 'toolCall',
            toolCallId: event.toolCallId,
            toolStatus: event.toolStatus,
            toolKind: (event as any).toolKind,
            toolOutput: (event as any).toolOutput,
          });

          // Open edited/read files + show diff on completion
          if ((event.toolStatus === 'completed' || event.toolStatus === 'done') && event.toolCallId) {
            const info = this.toolCallLocations.get(event.toolCallId);
            if (info && info.paths.length > 0 && (info.kind === 'edit' || info.kind === 'read')) {
              for (const filePath of info.paths) {
                this.openFileInEditor(filePath, info.kind === 'edit');
                // Show diff for edit operations with accept/reject + feedback
                if (info.kind === 'edit') {
                  const original = this.editSnapshots.get(filePath);
                  if (original !== undefined) {
                    try {
                      const newContent = fs.readFileSync(filePath, 'utf8');
                      if (original !== newContent) {
                        // Async IIFE — the onUpdate callback is synchronous
                        void (async () => {
                          const accepted = await showDiff({ filePath, originalContent: original, newContent });
                          if (!accepted) {
                            const fb = await vscode.window.showInputBox({
                              prompt: `Rejected: ${path.basename(filePath)}. Tell the agent why:`,
                              placeHolder: 'e.g. Wrong approach — use X instead, or explain why this change is incorrect...',
                              ignoreFocusOut: true,
                            });
                            if (fb?.trim()) {
                              this.log(`[diff] rejected with feedback: ${fb.trim()}`);
                              this.store.addUserMessage(fb.trim());
                              // Defer sending so the current turn can fully complete
                              setTimeout(() => {
                                void this.runPrompt(fb.trim());
                              }, 300);
                            }
                          }
                        })();
                      }
                    } catch { /* file read failed */ }
                    this.editSnapshots.delete(filePath);
                  }
                }
              }
            }
            this.toolCallLocations.delete(event.toolCallId);
          }
        } else if (event.toolTitle) {
          const icon = event.toolStatus === 'done' || event.toolStatus === 'completed' ? '✓' : event.toolStatus === 'error' ? '✗' : '⋯';
          this.lastTurnTools.push({ role: 'tool', text: `${icon} ${event.toolTitle}${event.toolDetail ? ': ' + event.toolDetail : ''}` });
          // Store locations for file-open on completion
          if (event.toolCallId && event.toolLocations?.length && event.toolKind) {
            this.toolCallLocations.set(event.toolCallId, {
              kind: event.toolKind,
              paths: event.toolLocations,
            });
            // Snapshot file contents before agent edits (for diff display)
            if (event.toolKind === 'edit') {
              for (const filePath of event.toolLocations) {
                try {
                  this.editSnapshots.set(filePath, fs.readFileSync(filePath, 'utf8'));
                } catch { /* file may not exist yet */ }
              }
            }
          }
          this.post({
            type: 'toolCall',
            toolName: event.toolTitle,
            toolStatus: event.toolStatus,
            toolCallId: event.toolCallId,
            toolDetail: event.toolDetail,
            toolKind: event.toolKind,
            toolLocations: event.toolLocations,
            toolOutput: (event as any).toolOutput,
          });
        }
      }
      // Forward todo state updates to webview
      if (event.todoState) {
        this.post({ type: 'statusBar', todoState: event.todoState });
      }
      if (event.done) {
        // End any in-progress history replay capture
        if (this.replayingHistory) {
          // Give a tick for trailing chunks, then flush
          setTimeout(() => this.finishReplayCapture(), 50);
        }
        // Detect model-switch response and update status bar
        const modelMatch = /model (?:switched|changed) to:\s*([\w\-\.]+)/i.exec(this.lastTurnText);
        if (modelMatch) {
          this.post({ type: 'statusBar', model: modelMatch[1] });
        }
        // Persist ACP session ID so Hermes can resume context
        const acpId = this.session.getSessionId();
        if (acpId) this.store.setAcpSessionId(acpId);
        // Persist the turn into session history
        this.saveTurnToSession();
        this.post({ type: 'done' });
      }
      if (event.error) {
        this.lastTurnText = '';
        this.lastTurnTools = [];
        this.post({ type: 'error', text: event.error });
      }
      // Status bar live data
      if (event.model || event.sessionTitle || event.contextUsed !== undefined) {
        this.post({
          type: 'statusBar',
          model: event.model,
          sessionTitle: event.sessionTitle,
          contextUsed: event.contextUsed,
          contextSize: event.contextSize,
          cachedTokens: event.cachedTokens,
        });
      }
    });
  }

  post(msg: ToWebview): void {
    this.view?.webview.postMessage(msg);
  }

  /**
   * Begin capturing streamed session/load history replay into replayBuffer.
   * While active, user/agent/tool messages arriving via onUpdate are buffered
   * and persisted to the session store at the end of the replay so the local
   * history stays in sync with the ACP server (bidirectional sync).
   */
  startReplayCapture(): void {
    this.replayingHistory = true;
    this.replayBuffer = [];
    if (this.replayTimer) clearTimeout(this.replayTimer);
    // Safety: if no 'done' arrives, flush after 4s of inactivity.
    this.replayTimer = setTimeout(() => this.finishReplayCapture(), 4000);
  }

  private finishReplayCapture(): void {
      if (!this.replayingHistory) return;
      this.replayingHistory = false;
      if (this.replayTimer) { clearTimeout(this.replayTimer); this.replayTimer = null; }
      if (this.replayBuffer.length > 0) {
        const s = this.store.active();
        if (s) {
          const beforeCount = s.messages.length;
          // SAFETY: Only replace local messages if replay returned something meaningful
          if (this.replayBuffer.length === 0) {
            this.log('[session] replay returned 0 messages — keeping existing local history');
          } else {
            // Replace local messages with the synced replay (server is source of truth)
            s.messages = [...this.replayBuffer];
            this.store.persistActive();
            this.log(`[session] replay captured ${this.replayBuffer.length} messages into store (was ${beforeCount})`);
            // SAFETY: Warn if we're replacing a non-empty local history with fewer messages
            if (beforeCount > 0 && this.replayBuffer.length < beforeCount) {
              this.log(`[session] WARNING: replay has fewer messages (${this.replayBuffer.length}) than local history (${beforeCount}) — potential data loss`);
            }
          }
        }
      }
      this.replayBuffer = [];
      this.broadcastSessions();
    }

  /** Get the stored ACP session ID for auto-resume after connection. */
    getStoredAcpSessionId(): string | undefined {
      return this.store.getAcpSessionId();
    }

    /** Get local sessions that have messages but no acpSessionId, for ACP sync. */
    getLocalUnsyncedSessions(): ChatSession[] {
      return this.store.getLocalUnsyncedSessions();
    }

    /** Set the acpSessionId for a specific local session after ACP sync. */
    setAcpSessionIdForSession(sessionId: string, acpId: string): void {
      this.store.setAcpSessionIdForSession(sessionId, acpId);
    }

  /**
   * Re-read model visibility from disk and push updated model menu to webview.
   * Called by extension.ts when settings panel saves visibility changes.
   */
  refreshModelMenu(currentModel: string): void {
    const groups = this.modelGroups;
    this.post({ type: 'modelMenuUpdate', modelGroups: groups, currentModel });
  }

  /** Re-fetch sessions (including from ACP) and push to webview. */
  refreshSessions(): void {
    void this.broadcastSessions();
  }

  private saveTurnToSession(): void {
    this.store.addTurnMessages(this.lastTurnTools, this.lastTurnText);
    this.lastTurnText = '';
    this.lastTurnTools = [];
  }

  private resolveWorkingDirectory(): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceFolder) return workspaceFolder;

    const activeEditorPath = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (activeEditorPath) {
      return path.dirname(activeEditorPath);
    }

    return process.cwd();
  }

  private async handleFromWebview(msg: FromWebview): Promise<void> {
    if (msg.type === 'send' && msg.text) {
      this.log(`[ui] send (${msg.text.length} chars)`);
      // Store user message in history (skip slash commands)
      if (!msg.text.startsWith('/')) {
        const newTitle = this.store.autoTitle(msg.text);
        if (newTitle) {
          this.post({ type: 'statusBar', sessionTitle: newTitle });
          this.broadcastSessions();
        }
        this.store.addUserMessage(msg.text);
      } else {
        // Slash command — detect /title X and sync extension's local title
        // The adapter processes the command and updates its own state; we mirror it locally.
        const titleMatch = /^\/title\s+(.+?)\s*$/i.exec(msg.text);
        if (titleMatch) {
          const newTitle = titleMatch[1].trim();
          const activeId = this.store.activeId;
          if (activeId && newTitle) {
            this.store.rename(activeId, newTitle);
            this.post({ type: 'statusBar', sessionTitle: newTitle.slice(0, 60) });
            this.broadcastSessions();
            this.log(`[ui] /title synced locally: ${newTitle}`);
          }
        }
      }

      // Build context annotation — 1 item per line
      const lines: string[] = [];
      for (const f of this.attachedFiles) {
        lines.push(`<span class="ctx-line"><span class="ctx-icon">⊕</span>${f.name}</span>`);
      }
      for (const s of this.selectedSkills) {
        lines.push(`<span class="ctx-line"><span class="ctx-icon">✦</span>${s}</span>`);
      }
      if (lines.length > 0) {
        this.post({ type: 'statusBar', contextAnnotation: lines.join('') });
      }

      if (this.busy) {
        this.log('[ui] queue + interrupt');
        this.messageQueue.push(msg.text);
        this.post({ type: 'busy', active: true, queued: this.messageQueue.length });
        // Interrupt: cancel current prompt so queue drains immediately
        // (matches Hermes TUI busy_input_mode: interrupt)
        await this.session.cancel();
      } else {
        void this.runPrompt(msg.text);
      }

    } else if (msg.type === 'cancel') {
      this.log(`[ui] cancel (${this.messageQueue.length} queued kept)`);
      // Don't clear the queue — queued messages should be sent after cancel
      this.lastTurnText = '';
      this.lastTurnTools = [];
      await this.session.cancel();

    } else if (msg.type === 'switchModel' && msg.model) {
      this.log(`[ui] switch model ${msg.model}`);
      const command = `/model ${msg.model}`;
      this.messageQueue = [];
      this.lastTurnText = '';
      this.lastTurnTools = [];
      // Optimistic UI update — model selector reflects change immediately
      this.post({ type: 'statusBar', model: msg.model });
      if (this.busy) {
        await this.session.cancel();
      }
      void this.runPrompt(command);

    } else if (msg.type === 'newSession') {
      this.log('[ui] new session');
      this.messageQueue = [];
      this.lastTurnText = '';
      this.lastTurnTools = [];
      this.session.reset();
      this.store.createSession('new session');
      this.post({ type: 'clear' });
      this.broadcastSessions();

    } else if (msg.type === 'switchSession' && msg.sessionId) {
              this.log(`[ui] switch session ${msg.sessionId}`);
              const target = this.store.switchTo(msg.sessionId);
              if (!target) return;

              this.messageQueue = [];
              this.lastTurnText = '';
              this.lastTurnTools = [];
              this.session.reset();
          
              if (target.acpSessionId) {
                this.session.setStoredSessionId(target.acpSessionId);
                this.log(`[session] will attempt resume of ACP session ${target.acpSessionId}`);
              }

              this.post({ type: 'clear' });
              this.post({ type: 'statusBar', sessionTitle: target.title });
              this.broadcastSessions();

              // Always load from server for ACP sessions - server is source of truth
              if (target.acpSessionId) {
                this.log(`[session] switch: loading ACP session history ${target.acpSessionId}`);
                const cwd = this.resolveWorkingDirectory();
                try {
                  this.startReplayCapture();
                  const loaded = await this.session.loadSessionHistory(target.acpSessionId, cwd);
                  if (loaded) {
                    this.store.setAcpSessionId(target.acpSessionId);
                    this.log(`[session] switch: resumed ${target.acpSessionId}`);
                  } else {
                    this.log(`[session] switch: ACP session ${target.acpSessionId} not found, showing blank`);
                  }
                } catch (err) {
                  this.log(`[session] switch: failed to load ACP session history: ${err}`);
                }
              } else if (target.messages.length > 0) {
                // Pure local session (no ACP) - show local history
                this.post({ type: 'loadHistory', history: target.messages, activeSessionId: target.id });
              }

    } else if (msg.type === 'attachFile') {
      // Open file picker and send selected file info back to webview
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: 'Attach',
        filters: { 'All Files': ['*'] },
      });
      if (uris) {
        for (const uri of uris) this.setAttachedFile(uri.fsPath);
      }

    } else if (msg.type === 'pasteImage' && msg.data && msg.ext) {
      // Save pasted image to the extension's media cache so the webview never exposes arbitrary local paths.
      const tmpPath = path.join(this.mediaRoot, `hermes-paste-${Date.now()}.${msg.ext}`);
      try {
        fs.writeFileSync(tmpPath, Buffer.from(msg.data, 'base64'));
        this.log('[ui] pasted image cached');
        this.setAttachedFile(tmpPath);
      } catch (err) {
        this.log(`[ui] failed to save pasted image: ${err}`);
      }

    } else if (msg.type === 'dropFiles' && msg.uris?.length) {
      // Handle files dropped from VS Code explorer — attach ALL dropped files
      for (const uri of msg.uris) {
        try {
          const fsPath = vscode.Uri.parse(uri).fsPath;
          this.log(`[ui] dropped file ${path.basename(fsPath)}`);
          this.setAttachedFile(fsPath);
        } catch (err) {
          this.log(`[ui] failed to parse dropped URI: ${err}`);
        }
      }

    } else if (msg.type === 'clearAttachments') {
      this.attachedFiles = [];

    } else if (msg.type === 'renameSession' && msg.sessionId) {
          const sessions = await this.store.allSessions();
          const s = sessions.find(s => s.id === msg.sessionId);
          if (!s) return;
          const newName = await vscode.window.showInputBox({
            prompt: 'Rename session',
            value: s.title,
            placeHolder: 'Session name',
          });
          if (newName !== undefined && newName.trim()) {
            this.store.rename(msg.sessionId, newName.trim());
            this.broadcastSessions();
            if (msg.sessionId === this.store.activeId) {
              this.post({ type: 'statusBar', sessionTitle: newName.trim().slice(0, 60) });
              void this.runPrompt(`/title ${newName.trim().slice(0, 60)}`);
            }
          }

    } else if (msg.type === 'deleteSession' && msg.sessionId) {
      if (this.store.deleteSession(msg.sessionId)) {
        this.broadcastSessions();
      }

    } else if (msg.type === 'toggleSkill' && msg.text) {
      const idx = this.selectedSkills.indexOf(msg.text);
      if (idx >= 0) {
        this.selectedSkills.splice(idx, 1);
      } else {
        this.selectedSkills.push(msg.text);
      }
      this.log(`[ui] skills: [${this.selectedSkills.join(', ')}]`);
      this.post({ type: 'statusBar', selectedSkills: this.selectedSkills });
    }
  }

  private setAttachedFile(fsPath: string): void {
    const name = path.basename(fsPath);
    // Don't add duplicates
    if (!this.attachedFiles.find(f => f.path === fsPath)) {
      this.attachedFiles.push({ name, path: fsPath });
    }
    this.post({ type: 'statusBar', attachedFiles: this.attachedFiles.map(f => ({ name: f.name, path: f.path })) });
  }

  private async runPrompt(text: string): Promise<void> {
    this.log(`[ui] run prompt (${text.length} chars)`);
    this.busy = true;
    this.post({ type: 'busy', active: true, queued: this.messageQueue.length });
    const cwd = this.resolveWorkingDirectory();

    // Gate: if the ACP client is not running, show an error and bail.
    // This prevents silent hangs when the user sends a prompt before
    // the ACP connection is established (e.g. sidebar opened but not connected).
    if (!this.session.isReady()) {
      this.log('[ui] prompt rejected: ACP client not connected');
      this.post({ type: 'error', text: 'Not connected to Hermes. Click the Hermes status bar icon to connect.' });
      this.busy = false;
      this.post({ type: 'busy', active: false });
      // Drain queue
      if (this.messageQueue.length > 0) {
        const next = this.messageQueue.shift()!;
        void this.runPrompt(next);
      }
      return;
    }

    // Prepend IDE context + attached file for regular messages (not slash commands)
    let prompt = text;
    if (!text.startsWith('/')) {
      const ctx = this.collectIdeContext();
      if (ctx) {
        prompt = ctx + prompt;
        this.log(`[ui] attached IDE context (${ctx.length} chars)`);
      }

      // Inject selected skills as advice
      if (this.selectedSkills.length > 0) {
        prompt = `I advise you to use the following skills: ${this.selectedSkills.join(', ')}\n\n${prompt}`;
        this.log(`[ui] advised skills: ${this.selectedSkills.join(', ')}`);
        this.selectedSkills = [];
        this.post({ type: 'statusBar', selectedSkills: [] });
      }

      // Attach file paths as references (agent reads on demand via file tools)
      if (this.attachedFiles.length > 0) {
        const refs = this.attachedFiles.map(f => `[Referenced file: ${f.path}]`).join('\n');
        prompt = refs + '\n\n' + prompt;
        this.log(`[ui] attached ${this.attachedFiles.length} file ref(s)`);
        this.attachedFiles = [];
        this.post({ type: 'statusBar', attachedFiles: [] });
      }
    }

    try {
      await this.session.sendPrompt(prompt, cwd);
    } catch (err) {
      const msg = String(err);
      if (msg.includes('Cancelled')) {
        this.post({ type: 'done' });
      } else {
        this.log(`[ui] prompt error ${msg}`);
        this.post({ type: 'error', text: msg });
      }
    } finally {
      this.log('[ui] prompt finished');
      this.busy = false;
      if (this.messageQueue.length > 0) {
        const next = this.messageQueue.shift()!;
        this.post({ type: 'busy', active: true, queued: this.messageQueue.length });
        void this.runPrompt(next);
      }
      // busy:false now sent by webview 'done' handler — removed from here
    }
  }

  /** Collect current IDE context to prepend to user prompts. */
  private collectIdeContext(): string {
    const parts: string[] = [];

    // Active editor file + selection
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const filePath = vscode.workspace.asRelativePath(editor.document.uri);
      parts.push(`[Active file: ${filePath}]`);

      const selection = editor.selection;
      if (!selection.isEmpty) {
        const selectedText = editor.document.getText(selection);
        if (selectedText.length <= 2000) {
          const startLine = selection.start.line + 1;
          const endLine = selection.end.line + 1;
          parts.push(`[Selection lines ${startLine}-${endLine}]\n\`\`\`\n${selectedText}\n\`\`\``);
        } else {
          parts.push(`[Selection: ${selectedText.length} chars, lines ${selection.start.line + 1}-${selection.end.line + 1}]`);
        }
      }
    }

    // Open editor tabs (just filenames, not content)
    const openTabs = vscode.window.tabGroups.all
      .flatMap(g => g.tabs)
      .map(t => {
        if (t.input && typeof t.input === 'object' && 'uri' in (t.input as Record<string, unknown>)) {
          return vscode.workspace.asRelativePath((t.input as { uri: vscode.Uri }).uri);
        }
        return null;
      })
      .filter((p): p is string => p !== null);

    if (openTabs.length > 0) {
      parts.push(`[Open tabs: ${openTabs.join(', ')}]`);
    }

    return parts.length > 0 ? parts.join('\n') + '\n\n' : '';
  }

  /** Open a file in VS Code editor when Hermes edits/reads it. */
  private openFileInEditor(filePath: string, isEdit: boolean): void {
    try {
      const uri = vscode.Uri.file(filePath);
      vscode.workspace.openTextDocument(uri).then(doc => {
        vscode.window.showTextDocument(doc, {
          preserveFocus: true,  // keep focus on the chat panel
          preview: !isEdit,     // edits open as persistent tabs, reads as preview
          viewColumn: vscode.ViewColumn.One,
        });
        this.log(`[ui] opened ${isEdit ? 'edited' : 'read'} file ${path.basename(filePath)}`);
      }, err => {
        this.log(`[ui] failed to open file: ${err}`);
      });
    } catch (err) {
      this.log(`[ui] openFileInEditor error: ${err}`);
    }
  }

  /** Convert MEDIA:/absolute/path references to webview-safe <img> tags. */
  private convertMediaPaths(text: string, webview: vscode.Webview): string {
    return text.replace(/MEDIA:(\/[^\s\n]+)/g, (_match, filePath: string) => {
      if (!this.isAllowedMediaPath(filePath)) {
        return `[blocked image: ${path.basename(filePath)}]`;
      }
      const uri = webview.asWebviewUri(vscode.Uri.file(filePath));
      return `![image](${uri})`;
    });
  }

  private isAllowedMediaPath(filePath: string): boolean {
    const normalizedFile = path.resolve(filePath);
    const normalizedRoot = path.resolve(this.mediaRoot) + path.sep;
    const allowedExt = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
    return normalizedFile.startsWith(normalizedRoot) && allowedExt.has(path.extname(normalizedFile).toLowerCase());
  }


  /** Broadcast session list to webview (async, uses ACP sync). */
    private async broadcastSessions(): Promise<void> {
      const sessions = await this.store.allSessions();
      this.post({
        type: 'sessionList',
        sessions: sessions.reverse(),
        activeSessionId: this.store.activeId,
        sessionTitle: this.store.active()?.title,
      });
    }


  private buildHtml(webview: vscode.Webview): string {
    return buildChatHtml({
      extensionUri: this.extensionUri,
      webview,
      initialModel: this.initialModel,
      modelGroups: this.modelGroups,
    });
  }
}
