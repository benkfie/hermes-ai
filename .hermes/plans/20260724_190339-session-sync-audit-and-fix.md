# Session Synchronization Audit & Fix Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Fix session synchronization between the Hermes AI extension and the Hermes ACP agent. Currently: session list is full of "untitled" sessions with no messages, sessions don't appear in the Hermes desktop app, and opening a session shows empty history.

**Architecture:** Two separate session systems that should sync:
1. **Extension side (VS Code/Antigravity IDE):** `SessionStore` manages `ChatSession[]` in `workspaceState` + reads CLI sessions via `hermes sessions list`
2. **ACP Adapter side (Hermes Agent):** `SessionManager` manages `SessionState` in memory + persists to shared `state.db` (SQLite)

**Tech Stack:** TypeScript (extension), Python (ACP adapter), SQLite (shared DB), VS Code Extension API

---

## Root Cause Analysis

### Problem 1: Session ID Mismatch
- Extension creates sessions with IDs like `s1735000000000` (timestamp-based)
- ACP Adapter creates sessions with IDs like `acp-<uuid>` (UUID-based)
- They never match, so switching sessions never loads the correct ACP history

### Problem 2: "Untitled" Sessions Flood
- `readHermesSessions()` parses `hermes sessions list` output
- Parsing is fragile — `parseSessionList()` assumes fixed-width columns
- When title/preview is empty or missing, defaults to `"untitled"`
- CLI sessions and ACP sessions both appear in the list, creating duplicates

### Problem 3: No Bidirectional Sync
- Extension stores messages locally in `workspaceState` (300 max per session)
- ACP Adapter stores messages in `state.db` (unlimited, with FTS)
- They don't reconcile — local history ≠ server history
- `loadSessionHistory` streams from server but `finishReplayCapture()` replaces local blindly

### Problem 4: Session Lifecycle Confusion
- `switchSession()` creates a new extension session for ACP sessions (lines 107-119)
- This duplicates the session in `workspaceState`
- No cleanup of orphaned "untitled" sessions
- `MAX_SESSIONS=20` truncates, but keeps oldest — wrong policy

### Problem 5: ACP Server Doesn't Track Extension Sessions
- `ensureConnected()` in `extension.ts` tries to load stored ACP session
- But if user creates session in extension first, ACP server never knows about it
- First prompt creates `session/new` on server with no extension context

---

## Fix Strategy

| Layer | Fix |
|-------|-----|
| **ACP Adapter** | Use stable session IDs that can be shared; expose `list_sessions` with proper metadata |
| **Extension Store** | Stop parsing CLI output; use ACP `session/list` instead; deduplicate by `acpSessionId` |
| **ChatPanel** | Make server the source of truth; on switch, always load from server, then persist locally |
| **Extension Entry** | On connect, sync extension sessions → ACP server; on first prompt, reuse existing session |

---

## Task Breakdown

### Phase 1: ACP Adapter — Session Listing & Metadata API

#### Task 1.1: Add `session/list` method to ACP server
**Files:** `acp_adapter/server.py` (or wherever ACP methods are registered)

```python
# In the method dispatcher, add:
elif method == "session/list":
    return await self._handle_session_list(params)
```

**Implementation:**
```python
async def _handle_session_list(self, params: dict) -> dict:
    """Return all ACP sessions with metadata for the extension."""
    cwd = params.get("cwd", ".")
    manager = self.session_manager  # SessionManager instance
    sessions = manager.list_sessions(cwd=cwd)
    return {"sessions": sessions}
```

**Step 1: Write test** — `tests/acp/test_session.py::test_session_list_method`
**Step 2: Run test** — expect FAIL (method not implemented)
**Step 3: Implement** — add handler in `server.py`
**Step 4: Run test** — expect PASS
**Step 5: Commit** — `feat: add session/list ACP method for extension sync`

---

#### Task 1.2: Enhance `list_sessions()` to include title & preview from DB
**Files:** `acp_adapter/session.py` lines 285-357

Current code already fetches `title` and `preview` from DB. Verify it works.
**Add test** to confirm `title` and `preview` are populated.

---

#### Task 1.3: Add `session/get` for single session metadata
**Files:** `acp_adapter/server.py`

```python
elif method == "session/get":
    return await self._handle_session_get(params)
```

---

### Phase 2: Extension — Replace CLI Parsing with ACP Calls

#### Task 2.1: Add `session/list` and `session/get` to `AcpClient`
**Files:** `src/acpClient.ts`

```typescript
async listSessions(cwd: string): Promise<AcpSessionInfo[]> {
  const result = await this.call('session/list', { cwd });
  return result?.sessions ?? [];
}

async getSession(sessionId: string): Promise<AcpSessionInfo | null> {
  const result = await this.call('session/get', { sessionId });
  return result ?? null;
}
```

**Test:** Write unit test mocking `call()`.
**Commit:** `feat: add session/list and session/get to AcpClient`

---

#### Task 2.2: Refactor `SessionStore.readHermesSessions()` to use ACP
**Files:** `src/sessionStore.ts` lines 76-87

```typescript
private async readHermesSessions(): Promise<HermesCliSession[]> {
  if (!this.acpClient) return [];
  try {
    const sessions = await this.acpClient.listSessions(this.getCwd());
    return sessions.map(s => ({
      id: s.session_id,
      title: s.title || s.preview || 'untitled',
      preview: s.preview || '',
      lastActive: s.updated_at || '',
    }));
  } catch {
    return [];
  }
}
```

**Need:** Store `AcpClient` reference in `SessionStore` (pass via constructor).

---

#### Task 2.3: Fix `allSessions()` deduplication logic
**Files:** `src/sessionStore.ts` lines 43-67

**Current bug:** Deduplicates by ID, but extension IDs (`s123`) ≠ ACP IDs (`acp-uuid`).

**Fix:** Deduplicate by `acpSessionId`. Keep the extension session if it has the same `acpSessionId` as an ACP session.

```typescript
allSessions(): ChatSession[] {
  const hermesSessions = await this.readHermesSessions();
  const byAcpId = new Map(hermesSessions.map(hs => [hs.id, hs]));
  
  // Start with extension sessions
  const merged = [...this.sessions];
  
  // Add ACP sessions that don't have a corresponding extension session
  for (const hs of hermesSessions) {
    const existing = this.sessions.find(s => s.acpSessionId === hs.id);
    if (!existing) {
      merged.push({
        id: `ext-${hs.id}`,  // prefix to avoid collision
        title: hs.title,
        createdAt: Date.now(),
        messages: [],
        acpSessionId: hs.id,
      });
    }
  }
  
  return merged.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
}
```

**Note:** `ChatSession` needs a `lastActive` field added.

---

#### Task 2.4: Add `lastActive` to `ChatSession` type
**Files:** `src/types.ts`

```typescript
export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  messages: StoredMessage[];
  acpSessionId?: string;
  lastActive?: number;  // NEW: for sorting
}
```

**Migration:** Update `createSession`, `switchTo`, `addTurnMessages` to set `lastActive = Date.now()`.

---

### Phase 3: ChatPanel — Server-First History Loading

#### Task 3.1: Fix `switchSession` to always load from server
**Files:** `src/chatPanel.ts` lines 422-458

**Current bug:** If `target.messages.length > 0`, it shows local messages and skips server load.

**Fix:** Always call `loadSessionHistory` for ACP sessions, then merge/replace.

```typescript
} else if (msg.type === 'switchSession' && msg.sessionId) {
  const target = this.store.switchTo(msg.sessionId);
  if (!target) return;
  
  this.session.reset();
  if (target.acpSessionId) {
    this.session.setStoredSessionId(target.acpSessionId);
    this.startReplayCapture();
    const cwd = this.resolveWorkingDirectory();
    try {
      const loaded = await this.session.loadSessionHistory(target.acpSessionId, cwd);
      if (loaded) {
        this.store.setAcpSessionId(target.acpSessionId);
        // Replay will populate via onUpdate → finishReplayCapture()
      } else {
        // Session not on server — show local if any, else blank
        if (target.messages.length > 0) {
          this.post({ type: 'loadHistory', history: target.messages, activeSessionId: target.id });
        }
      }
    } catch (err) { /* log error */ }
  } else if (target.messages.length > 0) {
    // Pure local session (no ACP)
    this.post({ type: 'loadHistory', history: target.messages, activeSessionId: target.id });
  }
}
```

---

#### Task 3.2: Fix `finishReplayCapture()` to merge intelligently
**Files:** `src/chatPanel.ts` lines 283-308

**Current:** Blindly replaces `s.messages = [...replayBuffer]`

**Fix:** Merge by message content/hash, don't duplicate. Keep server as source of truth but preserve local-only messages (e.g., user messages sent but not yet acknowledged).

```typescript
private finishReplayCapture(): void {
  if (!this.replayingHistory) return;
  this.replayingHistory = false;
  if (this.replayTimer) { clearTimeout(this.replayTimer); this.replayTimer = null; }
  
  if (this.replayBuffer.length > 0) {
    const s = this.store.active();
    if (s) {
      // Merge: server messages are canonical. Local-only messages (unacked user messages)
      // should be preserved at the end.
      const serverMsgs = this.replayBuffer;
      const localMsgs = s.messages;
      
      // Find divergence point: last message that exists in both
      // For simplicity: replace entirely but warn if local had more
      if (localMsgs.length > serverMsgs.length) {
        this.log(`[session] WARNING: local history (${localMsgs.length}) > server (${serverMsgs.length})`);
      }
      s.messages = serverMsgs;
      this.store.persistActive();
    }
  }
  this.replayBuffer = [];
  this.broadcastSessions(this.store);
}
```

---

#### Task 3.3: Persist ACP session title from `session_info_update`
**Files:** `src/chatPanel.ts` lines 116-128

Already implemented — verify it calls `this.store.rename(activeId, event.sessionTitle)`.

**Add:** Update `lastActive` timestamp when title changes.

---

### Phase 4: Extension Entry — Connect-Time Sync

#### Task 4.1: On connect, push extension sessions to ACP server
**Files:** `src/extension.ts` lines 419-439 (`ensureConnected`)

```typescript
// After client.start():
const sessions = panel.getAllExtensionSessions();
for (const s of sessions) {
  if (!s.acpSessionId && s.messages.length > 0) {
    // Create ACP session with this history
    const acpId = await session.createSessionWithHistory(s.messages, cwd);
    s.acpSessionId = acpId;
    panel.store.setAcpSessionId(acpId);
    panel.store.rename(s.id, s.title);
  }
}
```

**Need:** Add `createSessionWithHistory(messages, cwd)` to `SessionManager`.

---

#### Task 4.2: Add `createSessionWithHistory` to `SessionManager`
**Files:** `src/sessionManager.ts`

```typescript
async createSessionWithHistory(messages: StoredMessage[], cwd: string): Promise<string> {
  const sessionId = await this.ensureSession(cwd);
  // Send messages to server to populate history
  // Could use session/prompt with special flag, or batch insert via custom method
  // For now: convert to prompt format and send
  for (const msg of messages) {
    if (msg.role === 'user') {
      await this.sendPrompt(msg.text, cwd);  // This will create history
    }
  }
  return sessionId;
}
```

**Better approach:** Add `session/create_with_history` ACP method.

---

### Phase 5: Cleanup & Deduplication

#### Task 5.1: Remove "untitled" sessions on load
**Files:** `src/sessionStore.ts` constructor or `ensureSession`

```typescript
// In constructor, after loading saved sessions:
this.sessions = saved.filter(s => 
  s.title !== 'untitled' && s.title !== 'new session' && s.messages.length > 0
);
```

---

#### Task 5.2: Add periodic cleanup of empty sessions
**Files:** `src/sessionStore.ts`

```typescript
pruneEmptySessions(): void {
  this.sessions = this.sessions.filter(s => s.messages.length > 0);
  this.persist();
}
```

Call from `deleteSession`, `switchTo`, and on extension startup.

---

#### Task 5.3: Fix `MAX_SESSIONS` truncation to keep most recent
**Files:** `src/sessionStore.ts` lines 95-97

```typescript
if (this.sessions.length > MAX_SESSIONS) {
  // Sort by lastActive descending, keep newest
  this.sessions.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
  this.sessions = this.sessions.slice(0, MAX_SESSIONS);
}
```

---

### Phase 6: Testing & Verification

#### Task 6.1: Integration test — Full session sync cycle
**Files:** `tests/integration/session_sync.test.ts`

```typescript
// 1. Start extension
// 2. Create session, send message
// 3. Verify ACP session created with same history
// 4. Restart extension
// 4. Verify session appears in list with correct title
// 5. Switch to session — verify history loads from server
```

---

#### Task 6.2: Manual verification checklist
- [ ] Open extension → session list shows meaningful titles (not "untitled")
- [ ] Create session → send message → appears in Hermes desktop app
- [ ] Switch sessions → history loads correctly
- [ ] Close/reopen VS Code → sessions persist with correct titles
- [ ] `hermes sessions list` in terminal matches extension list
- [ ] No duplicate sessions for same conversation

---

## Files Likely to Change

| File | Changes |
|------|---------|
| `acp_adapter/server.py` | Add `session/list`, `session/get`, `session/create_with_history` |
| `acp_adapter/session.py` | Enhance `list_sessions`, add `create_session_with_history` |
| `src/acpClient.ts` | Add `listSessions()`, `getSession()`, `createSessionWithHistory()` |
| `src/sessionStore.ts` | Replace CLI parsing with ACP calls; fix dedup; add `lastActive` |
| `src/types.ts` | Add `lastActive` to `ChatSession` |
| `src/chatPanel.ts` | Fix `switchSession`, `finishReplayCapture`, title sync |
| `src/extension.ts` | Connect-time sync of extension sessions to ACP |
| `src/sessionManager.ts` | Add `createSessionWithHistory` |

---

## Risks & Tradeoffs

| Risk | Mitigation |
|------|------------|
| ACP `session/list` not implemented yet | Implement in Phase 1 first |
| Server-side history creation is slow | Batch insert via new ACP method |
| Extension sessions without ACP ID | Generate deterministic UUID from first message hash |
| Webview shows stale data during replay | Show loading spinner; only render after `finishReplayCapture` |
| `workspaceState` size limit | Prune aggressively; keep only 20 sessions × 300 msgs |

---

## Acceptance Criteria

1. **Session list shows real titles** — no "untitled" unless genuinely new
2. **Bidirectional sync** — message sent in extension → appears in desktop app, and vice versa
3. **History loads on switch** — switching to any session shows full server history
4. **Persists across restarts** — close VS Code, reopen → sessions intact with history
5. **No duplicates** — one conversation = one session entry

---

## Execution Order

```
Phase 1 (ACP Adapter) → Phase 2 (Extension Store) → Phase 3 (ChatPanel) 
  → Phase 4 (Extension Entry) → Phase 5 (Cleanup) → Phase 6 (Testing)
```

Each task is 2-5 minutes. Total ~40-60 minutes for full implementation.

---

## Open Questions

1. **Should extension sessions without ACP ID be migrated automatically?** Yes — on first connect, create ACP sessions for any local sessions with messages.

2. **What about sessions created in Hermes desktop app?** They already have ACP IDs. Extension will pick them up via `session/list`.

3. **How to handle concurrent edits?** Last-write-wins on server. Extension shows warning if local diverges.

4. **Delete behavior** — delete in extension → delete in server? Add `session/delete` ACP method.