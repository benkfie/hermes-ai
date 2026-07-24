# Session Overwrite Bug — Debug & Fix Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Identify and fix the bug that caused the "ACP Terminal Streaming Plan Summary" session's messages (IDs 1–37220) to be replaced with a completely different conversation (bloat analysis, IDs 37221+), and add safeguards to prevent recurrence.

**Architecture:** The session data flows through three layers: (1) the Hermes ACP adapter (`acp_adapter/session.py`) manages in-memory `SessionState` + persists to `state.db` via `SessionDB`, (2) the extension's `SessionStore` (`sessionStore.ts`) manages a local copy in VS Code `workspaceState`, and (3) the extension's `SessionManager` (`sessionManager.ts`) bridges ACP protocol calls. The bug likely involves a destructive `replace_messages` call on the Hermes side or a replay-capture overwrite on the extension side.

**Tech Stack:** TypeScript (extension), Python (Hermes agent/ACP adapter), SQLite (`state.db`), VS Code Extension API

---

## Context: What We Know

1. Session `20260723_175034_04fd43` ("ACP Terminal Streaming Plan Summary") should have contained hundreds of messages about terminal streaming implementation
2. It now contains only 21 messages (IDs 37221–37241) about bloat analysis — a completely different topic
3. Message IDs start at 37221, meaning messages 1–37220 were deleted from the SQLite DB
4. The session title was NOT changed — it still says "ACP Terminal Streaming Plan Summary"
5. The surviving messages were sourced from "tui" (not "acp"), suggesting the TUI session and ACP session may share the same DB session ID

## Hypothesis Matrix

| # | Hypothesis | Where | Likelihood |
|---|-----------|-------|------------|
| H1 | `_persist()` called `replace_messages()` with empty/incomplete `state.history`, wiping the DB | `acp_adapter/session.py:491` | HIGH |
| H2 | `finishReplayCapture()` replaced local messages with incomplete replay, then `persistActive()` wrote that to `workspaceState` | `chatPanel.ts:291` | MEDIUM |
| H3 | TUI and ACP shared the same session ID in `state.db`, and TUI's `_persist` overwrote ACP's messages | `hermes_state.py` | HIGH |
| H4 | Session ID rotation during context compression created a new session, and the old session's messages were orphaned then overwritten | `acp_adapter/session.py` | MEDIUM |
| H5 | Extension `switchTo` created a new local `ChatSession` with `messages: []` for an ACP session, and this empty session was persisted over the existing one | `sessionStore.ts:110-118` | LOW |

---

## Task 1: Verify which sessions exist in `state.db` and their message counts

**Objective:** Determine the ground truth of what's in the database for session `20260723_175034_04fd43` and nearby sessions.

**Files:**
- Read-only: `~/.hermes/state.db`

**Step 1: Query the session record**

```bash
sqlite3 ~/.hermes/state.db "SELECT id, source, title, message_count, tool_call_count, started_at, last_active FROM sessions WHERE id = '20260723_175034_04fd43';"
```

Expected: One row showing the session exists with `message_count` reflecting only the 21 surviving messages.

**Step 2: Query actual message count and ID range**

```bash
sqlite3 ~/.hermes/state.db "SELECT COUNT(*), MIN(id), MAX(id), MIN(timestamp), MAX(timestamp) FROM messages WHERE session_id = '20260723_175034_04fd43';"
```

Expected: Count ~21, min ID near 37221, confirming messages 1–37220 are gone.

**Step 3: Check for archived (compacted) messages**

```bash
sqlite3 ~/.hermes/state.db "SELECT active, compacted, COUNT(*) FROM messages WHERE session_id = '20260723_175034_04fd43' GROUP BY active, compacted;"
```

Expected: If messages were archived before deletion, we might see `active=0` rows. If they're completely gone, only `active=1` rows for the 21 surviving messages.

**Step 4: Check for other sessions with similar titles or overlapping timestamps**

```bash
sqlite3 ~/.hermes/state.db "SELECT id, source, title, message_count, started_at, last_active FROM sessions WHERE title LIKE '%Terminal%' OR title LIKE '%streaming%' OR title LIKE '%ACP%' ORDER BY started_at DESC LIMIT 20;"
```

**Step 5: Commit**

```bash
git add -A && git commit -m "debug: investigate session overwrite — document state.db findings"
```

---

## Task 2: Add diagnostic logging to `_persist()` to catch destructive replace_messages calls

**Objective:** Instrument the ACP adapter's `_persist` method to log when `replace_messages` is called and what it would do, so we can catch the bug in real-time next time.

**Files:**
- Modify: `acp_adapter/session.py:412-495` (the `_persist` method)

**Step 1: Add logging before the `replace_messages` call**

In `acp_adapter/session.py`, add logging at line ~491 (before the `db.replace_messages` call):

```python
if not agent_owns_persistence:
    try:
        has_archived = db.has_archived_messages(state.session_id)
    except Exception:
        has_archived = False

    # DIAGNOSTIC: Log the replace_messages call with context
    existing_msg_count = 0
    try:
        existing_row = db.get_session(state.session_id)
        if existing_row:
            existing_msg_count = int(existing_row.get("message_count") or 0)
    except Exception:
        pass

    logger.warning(
        "ACP _persist: replace_messages session=%s existing_db_msgs=%d "
        "in_memory_history=%d has_archived=%s active_only=%s agent_owns=%s "
        "agent_session_id=%s state_session_id=%s",
        state.session_id,
        existing_msg_count,
        len(state.history),
        has_archived,
        has_archived,
        agent_owns_persistence,
        getattr(state.agent, "session_id", "?"),
        state.session_id,
    )

    # SAFETY: Do NOT replace if in-memory history is shorter than DB history
    # unless the agent owns persistence (which means it handles its own writes).
    # This prevents a stale/empty in-memory history from wiping a full DB transcript.
    if len(state.history) < existing_msg_count and existing_msg_count > 0:
        logger.error(
            "ACP _persist: REFUSING replace_messages — in-memory history (%d) "
            "is shorter than DB history (%d). This would cause data loss. "
            "Session: %s",
            len(state.history),
            existing_msg_count,
            state.session_id,
        )
        # Still update metadata (model, cwd) but NOT messages
        return

    db.replace_messages(
        state.session_id, state.history, active_only=has_archived
    )
```

**Step 2: Verify the change compiles**

```bash
cd /c/Users/Ben/AppData/Local/hermes/hermes-agent
python -c "from acp_adapter.session import SessionManager; print('OK')"
```

**Step 3: Commit**

```bash
git add acp_adapter/session.py
git commit -m "fix: refuse replace_messages when in-memory history is shorter than DB (prevents data loss)"
```

---

## Task 3: Add diagnostic logging to `finishReplayCapture()` in the extension

**Objective:** Log when the extension replaces local session messages with replay data, including counts.

**Files:**
- Modify: `hermes-ai/src/chatPanel.ts:283-298` (the `finishReplayCapture` method)

**Step 1: Add logging with before/after counts**

```typescript
private finishReplayCapture(): void {
    if (!this.replayingHistory) return;
    this.replayingHistory = false;
    if (this.replayTimer) { clearTimeout(this.replayTimer); this.replayTimer = null; }
    if (this.replayBuffer.length > 0) {
      const s = this.store.active();
      if (s) {
        const beforeCount = s.messages.length;
        // Replace local messages with the synced replay (server is source of truth)
        s.messages = [...this.replayBuffer];
        this.store.persistActive();
        this.log(`[session] replay captured: replaced ${beforeCount} local msgs with ${this.replayBuffer.length} replay msgs`);
        // SAFETY: Warn if we're replacing a non-empty local history with fewer messages
        if (beforeCount > 0 && this.replayBuffer.length < beforeCount) {
          this.log(`[session] WARNING: replay has fewer messages (${this.replayBuffer.length}) than local (${beforeCount}) — potential data loss`);
        }
      }
    }
    this.replayBuffer = [];
    this.broadcastSessions(this.store);
  }
```

**Step 2: Build and verify**

```bash
cd /e/Work/03_Projects/Hermes_Extension/hermes-ai
npm run build
```

**Step 3: Commit**

```bash
git add src/chatPanel.ts
git commit -m "fix: add replay data-loss guard — warn when replay replaces more messages with fewer"
```

---

## Task 4: Investigate TUI/ACP session ID collision

**Objective:** Determine if the TUI and ACP adapter are writing to the same session ID in `state.db`, which would cause one to overwrite the other's messages.

**Files:**
- Read-only: `~/.hermes/state.db`
- Read: `acp_adapter/session.py` (session ID format)
- Read: `hermes_cli/` (TUI session ID format)

**Step 1: Check session sources for the affected session**

```bash
sqlite3 ~/.hermes/state.db "SELECT id, source, title, message_count FROM sessions WHERE id = '20260723_175034_04fd43';"
```

If `source` is 'tui' but the session was used via ACP, that confirms a collision.

**Step 2: Check how TUI creates session IDs**

```bash
grep -n "session_id\|create_session\|uuid\|strftime" /c/Users/Ben/AppData/Local/hermes/hermes-agent/hermes_cli/active_sessions.py 2>/dev/null | head -20
```

**Step 3: Check if ACP and TUI share the same SessionDB path**

```bash
grep -n "state.db\|db_path\|SessionDB" /c/Users/Ben/AppData/Local/hermes/hermes-agent/acp_adapter/session.py /c/Users/Ben/AppData/Local/hermes/hermes-agent/hermes_cli/active_sessions.py 2>/dev/null | head -20
```

**Step 4: Document findings**

Create `.hermes/plans/20260724_session_collision_investigation.md` with findings.

**Step 5: Commit**

```bash
git add -A && git commit -m "debug: document TUI/ACP session ID collision investigation"
```

---

## Task 5: Add session ID namespace isolation between TUI and ACP

**Objective:** If Task 4 confirms TUI and ACP share session IDs, add namespace prefixes to prevent collisions.

**Files:**
- Modify: `acp_adapter/session.py` (session ID generation)
- Modify: `hermes_state.py` (if needed for ID handling)

**Step 1: Prefix ACP session IDs**

In `acp_adapter/session.py`, change `create_session`:

```python
def create_session(self, cwd: str = ".") -> SessionState:
    cwd = _translate_acp_cwd(cwd)
    session_id = f"acp-{uuid.uuid4()}"  # Namespace to prevent TUI collision
    ...
```

**Step 2: Update all references to handle the new prefix**

The `session_id` is used as a key throughout — verify all lookups handle the prefix.

**Step 3: Add migration for existing sessions**

Existing ACP sessions have UUID-based IDs without the prefix. Add a fallback lookup:

```python
def get_session(self, session_id: str) -> Optional[SessionState]:
    # Try direct lookup first
    ...
    # If not found and no prefix, try with acp- prefix
    if not session_id.startswith("acp-"):
        prefixed = f"acp-{session_id}"
        ...
```

**Step 4: Test**

```bash
cd /c/Users/Ben/AppData/Local/hermes/hermes-agent
python -m pytest tests/acp/test_session.py -v
```

**Step 5: Commit**

```bash
git add acp_adapter/session.py
git commit -m "fix: namespace ACP session IDs with acp- prefix to prevent TUI collision"
```

---

## Task 6: Add a session integrity check to the extension's auto-resume flow

**Objective:** Before the extension replaces local messages with replay data, verify the replay is complete and non-empty.

**Files:**
- Modify: `hermes-ai/src/chatPanel.ts` (the `switchSession` handler and `ensureConnected` flow)

**Step 1: Add replay completeness check**

In `finishReplayCapture`, add a guard:

```typescript
private finishReplayCapture(): void {
    if (!this.replayingHistory) return;
    this.replayingHistory = false;
    if (this.replayTimer) { clearTimeout(this.replayTimer); this.replayTimer = null; }

    const s = this.store.active();
    if (!s) { this.replayBuffer = []; return; }

    // SAFETY: Only replace local messages if replay returned something meaningful
    if (this.replayBuffer.length === 0) {
      this.log('[session] replay returned 0 messages — keeping existing local history');
      this.replayBuffer = [];
      this.broadcastSessions(this.store);
      return;
    }

    if (this.replayBuffer.length > 0) {
      const beforeCount = s.messages.length;
      s.messages = [...this.replayBuffer];
      this.store.persistActive();
      this.log(`[session] replay: replaced ${beforeCount} → ${this.replayBuffer.length} messages`);
    }
    this.replayBuffer = [];
    this.broadcastSessions(this.store);
  }
```

**Step 2: Build and verify**

```bash
cd /e/Work/03_Projects/Hermes_Extension/hermes-ai && npm run build
```

**Step 3: Commit**

```bash
git add src/chatPanel.ts
git commit -m "fix: refuse empty replay that would wipe local session history"
```

---

## Task 7: Add a session backup mechanism before destructive operations

**Objective:** Before any `replace_messages` call, create a timestamped backup of the current messages so data loss is recoverable.

**Files:**
- Modify: `hermes_state.py` (add backup method)
- Modify: `acp_adapter/session.py` (call backup before replace)

**Step 1: Add backup method to SessionDB**

In `hermes_state.py`, add:

```python
def backup_messages(self, session_id: str, reason: str = "") -> str | None:
    """Create a timestamped copy of a session's messages before destructive operations.
    
    Returns the backup session ID, or None if no messages to back up.
    """
    import json
    from datetime import datetime, timezone
    
    messages = self.get_messages_as_conversation(session_id)
    if not messages:
        return None
    
    backup_id = f"backup-{session_id}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')}"
    
    # Create a new session record for the backup
    self.create_session(
        session_id=backup_id,
        source="backup",
        model=None,
        model_config={"original_session": session_id, "reason": reason, "message_count": len(messages)},
    )
    
    # Insert all messages into the backup session
    self._insert_message_rows(None, backup_id, messages)  # Need to wrap in transaction
    
    logger.info("Backed up session %s (%d messages) to %s", session_id, len(messages), backup_id)
    return backup_id
```

**Step 2: Call backup before replace_messages in _persist**

In `acp_adapter/session.py`, before the `db.replace_messages` call:

```python
# Create backup before destructive replace
try:
    backup_id = db.backup_messages(state.session_id, reason="acp_persist_replace")
    if backup_id:
        logger.info("ACP _persist: backed up to %s before replace", backup_id)
except Exception:
    logger.debug("Failed to backup messages before replace", exc_info=True)
```

**Step 3: Test**

```bash
cd /c/Users/Ben/AppData/Local/hermes/hermes-agent
python -m pytest tests/acp/test_session.py -v -k "persist"
```

**Step 4: Commit**

```bash
git add hermes_state.py acp_adapter/session.py
git commit -m "feat: backup session messages before destructive replace_messages"
```

---

## Task 8: Build, package, and deploy the fix

**Objective:** Build the extension with the safety guards and deploy.

**Files:**
- Modify: `hermes-ai/package.json` (version bump)

**Step 1: Bump version**

```bash
cd /e/Work/03_Projects/Hermes_Extension/hermes-ai
# Bump version in package.json
```

**Step 2: Build and package**

```bash
npm run build
npx @vscode/vsce package --no-dependencies
```

**Step 3: Install**

```bash
"/c/Users/Ben/AppData/Local/Programs/Antigravity IDE/bin/antigravity-ide.cmd" --install-extension hermes-ai-<new-version>.vsix --force
```

**Step 4: Commit**

```bash
git add -A && git commit -m "chore: bump version for session safety guards"
```

---

## Verification

After deploying, verify:

1. **Existing sessions are intact** — Open the session picker, confirm "ACP Terminal Streaming Plan Summary" still has its 21 surviving messages
2. **New sessions work** — Start a new session, send a message, verify it persists
3. **Session switching works** — Switch between sessions, verify messages are preserved
4. **Reconnect works** — Reload the extension window, verify the stored session resumes correctly
5. **Logs show safety guards** — Check the output channel for the new diagnostic messages

---

## Risks & Tradeoffs

| Risk | Mitigation |
|------|------------|
| Refusing `replace_messages` when in-memory < DB could prevent legitimate compaction | The guard only fires when `agent_owns_persistence` is False AND in-memory is shorter. Compaction happens when the agent owns persistence, so it bypasses this guard. |
| Backup mechanism increases DB size | Backups are clearly labeled with `source="backup"` and can be pruned with a cron job |
| ACP session ID prefix breaks existing sessions | Fallback lookup handles unprefixed IDs |
| Empty replay guard could prevent legitimate empty sessions | Only blocks when replay returns 0 messages AND local history is non-empty |

---

## Open Questions

1. **Was the bloat analysis sent from the TUI to the same session ID?** Task 4 will determine this.
2. **Did context compression trigger a session ID rotation?** Check the agent logs for compression events around July 23.
3. **Is there a race condition between the extension's `ensureConnected` and a concurrent TUI session?** Both could call `_persist` on the same session ID simultaneously.
