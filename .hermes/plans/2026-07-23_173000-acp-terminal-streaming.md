# ACP Live Terminal Streaming — Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add live terminal stdout/stderr streaming over ACP so the VS Code extension can show real-time command output (Option B from `ACP_TERMINAL_DIFF_OPTIONS.md`).

**Architecture:** Pipe subprocess stdout/stderr chunks through a progress callback from `terminal_tool.py` → `tool_executor.py` → `acp_adapter/events.py` → ACP wire → extension webview which appends to a persistent terminal block. The extension already has `renderTerminalBlock()` and `S.terminalBlocks` — it just needs input data to stream.

**Tech Stack:** Python 3.11+ (Hermes core), TypeScript (VS Code extension), JSON-RPC 2.0 over stdio (ACP transport), `uv` for Python venv management.

**Risk profile:** Medium. Core tool execution path changes must not break CLI/TUI/gateway surfaces. Streaming is additive — the existing `_polished_tools` formatting path remains the fallback.

---

## Side-by-Side Dev Setup (Prerequisite)

The official Hermes install lives at `C:\Users\Ben\AppData\Local\hermes\hermes-agent\` (a Python venv). We will run a development build from the source checkout without touching the production install.

### Setup Steps (run FIRST, before any code changes)

```
# 1. Source checkout: E:\Work\03_Projects\Hermes_Extension\Hermes_Full\hermes-agent
cd E:\Work\03_Projects\Hermes_Extension\Hermes_Full\hermes-agent

# 2. Create dev branch from upstream main
git checkout main && git pull origin main
git checkout -b feat/acp-terminal-streaming

# 3. Create dev venv (uv sync in the source tree)
uv sync

# 4. Verify the dev binary works with shared config
set HERMES_HOME=C:\Users\Ben\AppData\Local\hermes
.venv\Scripts\hermes.exe --version
# Expected: 0.19.0

# 5. Configure the VS Code extension to use the dev binary
# Open VS Code settings.json, set:
#   "hermes-ai.path": "E:\\Work\\03_Projects\\Hermes_Extension\\Hermes_Full\\hermes-agent\\.venv\\Scripts\\hermes.exe"
```

**Key design decisions for side-by-side:**
- Dev venv at `.venv/` in the source tree (gitignored)
- `HERMES_HOME` shared with production (`C:\Users\Ben\AppData\Local\hermes`) — same config.yaml, .env, API keys, sessions DB, skills, memories
- Extension `hermes-ai.path` setting switches between dev and official binary
- `hermes-ai` extension changes are compiled and installed via `dev-install.bat` (already exists)
- The Python source uses `set_hermes_home_override()` ContextVar for per-task profile scoping — this is unaffected

**Upstream rebase strategy:**
- All changes on branch `feat/acp-terminal-streaming`, tracking upstream `main`
- Changes are isolated to 4-5 files (see below). A rebase on upstream will produce conflicts only in those files
- After feature is stable, consider submitting as PR to upstream
- Commit each logical change separately for bisectability

---

## Phase 1: Hermes Core — Streaming Terminal Output

### Task 1: Add streaming callback parameter to `terminal_tool()`

**Objective:** Add an optional `output_callback` parameter to `terminal_tool()` that receives stdout/stderr chunks in real-time.

**Files:**
- Modify: `tools/terminal_tool.py` (around line 2100 where `def terminal_tool(` is defined)

**Step 1: Add parameter to function signature**

Find the `terminal_tool` function definition (currently at line 2100):

```python
def terminal_tool(
    command: str,
    background: bool = False,
    # ... existing params ...
```

Add the new parameter before the existing ones:

```python
def terminal_tool(
    command: str,
    background: bool = False,
    # ... existing params ...
    output_callback: Optional[Callable[[str, str], None]] = None,
    # output_callback(event_type: str, data: str) where event_type is 'stdout' or 'stderr'
```

**Step 2: Import Optional and Callable at the top** (if not already imported):

At line ~44 add (check existing imports first):
```python
from typing import Optional, Dict, Any, List, Callable
```
`Callable` may need to be added if not present.

**Step 3: Find the subprocess execution loop**

Search for where the terminal tool reads stdout/stderr from the subprocess in `_execute_command_foreground` or similar. The key pattern to find is the `subprocess.Popen` call and its `stdout.readline()` / `communicate()` loops.

In the foreground execution path (~line 2400+), find where `process.stdout.readline()` is called in a loop. Before/after the existing line-buffer append, add:

```python
if output_callback and line:
    output_callback('stdout', line)
```

Similarly for stderr (if captured separately).

**Step 4: For background mode**, the callback would need to be stored and called from `process(action='poll')` — this is a follow-up. For now, only foreground mode needs streaming.

**Step 5: Commit**

```bash
git add tools/terminal_tool.py
git commit -m "feat(terminal): add output_callback parameter for live stdout/stderr streaming

Add optional Callable parameter to terminal_tool() that receives
('stdout', chunk) and ('stderr', chunk) events during foreground
command execution. Non-breaking: callback is None by default,
preserving all existing behavior."
```

---

### Task 2: Pass output_callback from tool_executor to terminal_tool

**Objective:** Wire the agent's tool progress callback through to `terminal_tool()` and `process` tool calls as a streaming hook.

**Files:**
- Modify: `agent/tool_executor.py`
- Read: `agent/run_agent.py` (to understand `_invoke_tool` dispatch)

**Step 1: Find `_invoke_tool` method**

Search for `def _invoke_tool` in `run_agent.py`. This is where tool functions are called. We need to understand what kwargs it passes.

**Step 2: In `tool_executor.py`, after the tool is invoked, check if we can wrap the call**

The key section is around line 625-638 in `tool_executor.py`:
```python
result = agent._invoke_tool(
    function_name,
    function_args,
    effective_task_id,
    tool_call.id,
    ...
)
```

For the `terminal` and `process` tools specifically, we need to inject an `output_callback` that pushes events through the agent's progress callback chain.

**Step 3: Create a helper function in `tool_executor.py`:**

```python
def _make_terminal_streaming_cb(agent, tool_call_id: str):
    """Build a terminal output_callback that emits streaming chunks via the agent's progress callback."""
    def _on_output(event_type: str, data: str) -> None:
        if agent.tool_progress_callback:
            try:
                agent.tool_progress_callback(
                    f"tool.{event_type}",  # 'tool.stdout' or 'tool.stderr'
                    "terminal",
                    None,
                    None,
                    tool_call_id=tool_call_id,
                    output_chunk=data,
                )
            except Exception:
                pass
    return _on_output
```

**Step 4: Inject the callback into function_args before dispatch**

In the concurrent execution section, just before calling `agent._invoke_tool()`, check if the function is 'terminal' or 'process':

```python
if function_name in {'terminal', 'process'} and not function_args.get('background'):
    function_args = dict(function_args)  # don't mutate original
    function_args['output_callback'] = _make_terminal_streaming_cb(agent, tool_call.id)
```

Also add the same logic in the sequential execution path (`execute_tool_calls_sequential`).

**Step 5: Commit**

```bash
git add agent/tool_executor.py
git commit -m "feat(tool_executor): inject output_callback for terminal/process tools

When executing terminal or process tool calls (foreground), inject an
output_callback that routes real-time stdout/stderr chunks through the
agent's tool_progress_callback chain. The callback uses event types
'tool.stdout' and 'tool.stderr' to distinguish from 'tool.started' and
'tool.completed'. Background terminal calls are excluded from streaming."
```

---

### Task 3: Update ACP adapter to emit live terminal chunk events

**Objective:** Extend `acp_adapter/events.py` `make_tool_progress_cb()` to handle `tool.stdout` and `tool.stderr` events by sending `ToolCallProgress` (ACP `session_update`) with incremental content.

**Files:**
- Modify: `acp_adapter/events.py`

**Step 1: In `make_tool_progress_cb()`, extend the event_type switch**

Currently the callback only handles `tool.started` (line 134-137):
```python
def _tool_progress(event_type, name, preview, args, **kwargs):
    if event_type != "tool.started":
        return
```

Change to handle `tool.started`, `tool.stdout`, `tool.stderr`, `tool.completed`:

```python
def _tool_progress(event_type, name, preview, args, **kwargs):
    if event_type == "tool.started":
        # ... existing logic ...
    
    elif event_type in ("tool.stdout", "tool.stderr"):
        tool_call_id = kwargs.get("tool_call_id")
        output_chunk = kwargs.get("output_chunk")
        if not tool_call_id or output_chunk is None:
            return
        
        # Find or create an ACP tc_id for this streaming update
        # We need the ACP-level tool_call_id that was created during tool.started
        queue = tool_call_ids.get(name)
        if not queue:
            return
        # Use the most recent (last) entry for the running command
        acp_tc_id = queue[-1] if queue else None
        if not acp_tc_id:
            return
        
        # Build a progress update with the chunk as content
        kind = get_tool_kind(name) if name else "execute"
        content = [_text(output_chunk)]
        update = acp.update_tool_call(
            acp_tc_id,
            kind=kind,
            status="in_progress",
            content=content,
        )
        _send_update(conn, session_id, loop, update)
    
    elif event_type == "tool.completed":
        # ... handled by step_callback, but we could add early completion signal ...
        pass  # step_callback already handles this
```

**Step 2: Import `get_tool_kind` and `_text` from `.tools`**

Add to the existing import from `.tools` at line 19-23:
```python
from .tools import (
    build_tool_complete,
    build_tool_start,
    make_tool_call_id,
    get_tool_kind,   # ADD
)
```

And import `_text` — either from `.tools` or define inline. Check if `_text` is defined in `tools.py` — it is, at line 191:
```python
def _text(content: str) -> Any:
    return acp.tool_content(acp.text_block(content))
```

But it's a private function. We need to either make it public or define a local equivalent. Define locally in events.py:

```python
def _text(content: str):
    return acp.tool_content(acp.text_block(content))
```

**Step 3: Commit**

```bash
git add acp_adapter/events.py
git commit -m "feat(acp): emit live terminal stdout/stderr as ToolCallProgress events

Extend make_tool_progress_cb() to handle 'tool.stdout' and 'tool.stderr'
event types. Each chunk is sent as an ACP session_update with
ToolCallProgress (status='in_progress') containing the raw chunk as a
text content block. The extension can append these to its terminal
display block. Event types 'tool.started' and existing 'tool.completed'
(step_callback) are unchanged."
```

---

### Task 4: Preserve raw terminal output in ACP tool completion

**Objective:** Ensure `acp_adapter/tools.py` `build_tool_complete()` does NOT strip raw terminal output for the `terminal` and `process` tools when a streaming session is active. Currently `raw_output=None` for polished tools — we need to preserve it for terminal tools so the extension can show the final output block.

**Files:**
- Modify: `acp_adapter/tools.py`

**Step 1: In `build_tool_complete()` (line 1305-1330), modify the `raw_output` logic**

Current code:
```python
return acp.update_tool_call(
    tool_call_id,
    kind=kind,
    status="failed" if _tool_result_failed(result, tool_name) else "completed",
    content=content,
    raw_output=None if tool_name in _POLISHED_TOOLS or _is_structured_json_result(result) else result,
)
```

Change to:
```python
# Terminal/process: always pass raw output for the extension to display
_preserve_raw = tool_name in {'terminal', 'process', 'execute_code'}
_raw = None
if _preserve_raw:
    _raw = result if isinstance(result, str) else None
elif tool_name not in _POLISHED_TOOLS and not _is_structured_json_result(result):
    _raw = result

return acp.update_tool_call(
    tool_call_id,
    kind=kind,
    status="failed" if _tool_result_failed(result, tool_name) else "completed",
    content=content,
    raw_output=_raw,
)
```

**Step 2: Add a `_format_terminal_result` formatter**

In the `_build_polished_completion_content` function, add a formatter for `terminal` that includes the full output:

```python
"terminal": lambda: _format_terminal_result(result, function_args),
```

And define `_format_terminal_result`:
```python
def _format_terminal_result(result, args):
    """Format terminal output for ACP display — includes command + output."""
    data = _json_loads_maybe(result)
    cmd = str((args or {}).get("command", "")).strip()
    if isinstance(data, dict):
        output = str(data.get("output") or data.get("stdout") or "")
        exit_code = data.get("exit_code")
        header = f"$ {cmd}" if cmd else "Terminal output"
        if exit_code is not None:
            header += f"\nExit code: {exit_code}"
        if output:
            return f"{header}\n\n{_fenced_text(output)}"
        return header
    # Fallback: return raw result
    return f"$ {cmd}\n\n{_fenced_text(str(result))}" if cmd else str(result)
```

**Step 3: Commit**

```bash
git add acp_adapter/tools.py
git commit -m "feat(acp): preserve raw terminal output in ToolCallProgress

Modify build_tool_complete() to pass raw_output for terminal, process,
and execute_code tools instead of setting it to None (polished tool
behavior). Add _format_terminal_result to display command + exit code +
fenced output. The extension relies on raw_output or content blocks to
populate its terminal display."
```

---

## Phase 2: Extension — Render Live Terminal Blocks

### Task 5: Handle incremental terminal chunks in the webview

**Objective:** Extend the webview message handler to append stdout/stderr chunks into the existing terminal block instead of waiting for the final `tool_call_update`.

**Files:**
- Modify: `src/webview/main.ts` (message handler section, ~line 436+)
- Modify: `src/webview/renderers.ts` (`renderTerminalBlock` function)
- Modify: `src/webview/state.ts` (add streaming terminal chunk accumulator)
- Read: `src/protocol.ts` (parseToolCallUpdate for ACP parsing)

**Step 1: Add chunk accumulator to WebviewState**

In `src/webview/state.ts`, add:
```typescript
export interface WebviewState {
  // ... existing fields ...
  
  /** Accumulates streaming terminal chunks keyed by toolCallId */
  terminalChunks: Map<string, string>;
}
```

In `createInitialState()`:
```typescript
terminalChunks: new Map(),
```

**Step 2: Update `renderTerminalBlock()` to support append mode**

In `src/webview/renderers.ts`, modify `renderTerminalBlock`:

```typescript
export function renderTerminalBlock(
  container: HTMLElement,
  toolId: string,
  command: string,
  outputChunk: string,
  isDone: boolean,
  append: boolean = false,  // NEW: append mode vs replace mode
): HTMLElement {
  let block = container.querySelector(`[data-term-id="${toolId}"]`);
  if (!block) {
    block = appendDiv(container, 'msg terminal');
    (block as HTMLElement).setAttribute('data-term-id', toolId);
    const header = document.createElement('div');
    header.className = 'term-header';
    header.innerHTML = `<span class="term-icon">$</span><span class="term-cmd">${escapeTerm(command)}</span>`;
    block.appendChild(header);
    const body = document.createElement('pre');
    body.className = 'term-body';
    block.appendChild(body);
  }

  const body = block.querySelector('.term-body') as HTMLElement;
  if (body && outputChunk) {
    if (append) {
      // Streaming: append chunk to existing content
      body.textContent = (body.textContent || '') + outputChunk;
    } else {
      // Final/static: replace content
      body.textContent = outputChunk;
    }
  }

  if (isDone) {
    block.classList.add('term-done');
  } else {
    block.classList.remove('term-done');
  }

  (block as HTMLElement).scrollIntoView({ block: 'end' });
  return block as HTMLElement;
}
```

**Step 3: Handle new message type `toolOutput` in main.ts**

In the message handler's `switch (msg.type)` block, add a new case BEFORE the existing `toolCall` case:

```typescript
case 'toolOutput': {
  // Live streaming chunk for a terminal/execute tool
  const toolId = (msg as any).toolCallId as string;
  const chunk = (msg as any).text as string;
  if (!toolId || !chunk) break;
  
  // Get stored command for this tool
  const cmd = S.toolCommandMap.get(toolId);
  if (!cmd) break;
  
  // Accumulate chunks
  const prev = S.terminalChunks.get(toolId) || '';
  S.terminalChunks.set(toolId, prev + chunk);
  
  renderTerminalBlock(messagesEl, toolId, cmd, chunk, false, true);
  autoScroll();
  break;
}
```

**Step 4: Add `toolOutput` to ToWebview type**

In `src/types.ts`, add to the `ToWebview` type:
```typescript
export interface ToWebview {
  type:
    | 'append' | 'thinking' | 'toolCall' | 'toolOutput' | 'done'  // ADD toolOutput
    | 'error' | 'status' | 'clear' | 'busy'
    | 'statusBar' | 'sessionList' | 'loadHistory'
    | 'modelMenuUpdate';
  // ... existing fields
}
```

**Step 5: Update `flushPending()` and `send()` to clear terminal chunks**

In `main.ts`, in the `send()` function and the `case 'clear'` handler, add:
```typescript
S.terminalChunks.clear();
```

**Step 6: Commit**

```bash
git add src/webview/main.ts src/webview/renderers.ts src/webview/state.ts src/types.ts
git commit -m "feat(webview): support live terminal chunk streaming with append mode

Add 'toolOutput' message type for incremental stdout/stderr chunks.
renderTerminalBlock() gains append parameter — chunks append to existing
terminal body text instead of replacing. WebviewState.terminalChunks
accumulates streaming content per toolCallId. Cleared on new send/clear."
```

---

### Task 6: Wire extension host to forward `tool.stdout`/`tool.stderr` ACP events

**Objective:** The extension host (Node.js side) receives ACP `session_update` notifications. When the update contains `ToolCallProgress` with `status='in_progress'` and a content block, forward it to the webview as a `toolOutput` message.

**Files:**
- Modify: `src/chatPanel.ts` (or whichever file handles ACP notifications)
- Read: `src/protocol.ts` (for parsing helpers)

**Step 1: Find where `tool_call_update` is handled in the extension host**

Search `chatPanel.ts` for where `session_update` notifications are processed. Look for the `onNotification` handler or where `toolCallUpdate` events are dispatched to the webview.

The relevant pattern is in the notification handler that looks for `tool_call` and `tool_call_update` methods from ACP.

**Step 2: Detect streaming tool updates**

When a `session_update` notification arrives with:
- `update.type` = `'tool_call'` and `status` = `'in_progress'` (or `'running'`)
- Content blocks are present and look like terminal chunks

...forward as `toolOutput` to the webview.

Add logic in the notification handler (pseudocode):

```typescript
function handleSessionUpdate(update: any): void {
  // ... existing tool call handling ...
  
  // Check if this is a streaming terminal chunk
  if (update.type === 'tool_call' && update.status === 'in_progress') {
    const content = update.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        const text = block.text || block.content?.text;
        if (typeof text === 'string' && text.trim()) {
          this.webview.postMessage({
            type: 'toolOutput',
            toolCallId: update.toolCallId,
            text: text,
          } as ToWebview);
        }
      }
    }
  }
  
  // ... existing tool_call_update handling for completion ...
}
```

**Step 3: Commit**

```bash
git add src/chatPanel.ts
git commit -m "feat(host): forward ACP streaming tool chunks as toolOutput messages

Detect ACP session_update notifications with tool_call status='in_progress'
and content blocks. Forward them to the webview as 'toolOutput' messages
so the terminal block appends chunks in real-time. Completion messages
(tool_call_update) are unchanged."
```

---

## Phase 3: Integration Testing

### Task 7: End-to-end smoke test

**Objective:** Verify the full pipeline: dev hermes → ACP → extension → webview terminal block shows live output.

**Files:**
- No changes — verification only

**Step 1: Build and install the extension**

```bash
cd E:\Work\03_Projects\Hermes_Extension\hermes-ai
npm run build
```

**Step 2: Bump version in `package.json`**

Change version from current to next patch (e.g., `1.1.0` → `1.1.1`).

**Step 3: Package and install**

```bash
npx @vscode/vsce package --no-dependencies
antigravity-ide.cmd --install-extension --force hermes-ai-1.1.1.vsix
```

**Step 4: Reload VS Code window** (Ctrl+Shift+P → Reload Window)

**Step 5: Test with a slow command**

Send a message to the agent: "Run `ping -n 5 127.0.0.1` and tell me the result"

**Expected behavior:**
1. Terminal block appears with `$ ping -n 5 127.0.0.1` header
2. Output lines appear incrementally (not all at once at the end)
3. Block marks as done (checkmark or styling change) when complete
4. Agent responds with the result

**Step 6: Test with `execute_code`**

Send: "Run this Python code: `for i in range(5): print(i); import time; time.sleep(1)`"

**Step 7: Test with non-terminal tools to verify no regression**

Send: "Read the file at src/webview/main.ts" — should still show as a read tool, not a terminal block.

**Step 8: Commit any fixes**

```bash
git add -A
git commit -m "fix: integration test corrections"
```

---

## Phase 4: Polish & Documentation

### Task 8: Terminal block styling improvements

**Objective:** Make the live terminal block visually distinct and usable.

**Files:**
- Modify: Extension CSS file (wherever `.msg.terminal` styles are defined)
- Modify: `src/webview/renderers.ts` (maybe add ANSI color parsing)

**Step 1: Add a subtle pulse animation on in-progress terminal blocks**

```css
.msg.terminal:not(.term-done) .term-header {
  animation: term-pulse 2s infinite;
}
@keyframes term-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}
```

**Step 2: Scroll terminal body to bottom on append** (in `renderTerminalBlock`):
```typescript
if (append && body) {
  body.scrollTop = body.scrollHeight;
}
```

**Step 3: Commit**

```bash
git add -A
git commit -m "style: pulse animation on live terminal blocks, auto-scroll body"
```

---

### Task 9: Handle `process` tool actions (poll, log, kill)

**Objective:** `process` tool calls also execute terminal operations. Ensure `process(action='poll')` etc. also stream when applicable.

**Files:**
- Read: `tools/process_tool.py` or wherever process tool is defined
- Modify: `agent/tool_executor.py` (if needed)

**Step 1: Audit the process tool**

The `process` tool uses terminal backends. Check if it calls `terminal_tool` internally or has its own execution path.

**Step 2: If process tool uses terminal_tool internally**, the streaming callback should already propagate. Verify.

**Step 3: If process tool has its own subprocess**, add the same `output_callback` pattern.

**Step 4: Commit**

```bash
git add -A
git commit -m "feat(process): ensure process tool actions stream where applicable"
```

---

### Task 10: Add `HERMES_STREAM_TERMINAL` feature flag

**Objective:** Gate the streaming behavior behind an env var so it can be disabled if it causes issues in production. Default: enabled.

**Files:**
- Modify: `tools/terminal_tool.py`
- Modify: `agent/tool_executor.py`

**Step 1: In `terminal_tool.py`, check for env var**

```python
_STREAM_TERMINAL = os.environ.get("HERMES_STREAM_TERMINAL", "1") not in ("0", "false", "no", "off")
```

**Step 2: Only invoke the callback if streaming is enabled**

```python
if output_callback and _STREAM_TERMINAL and line:
    output_callback('stdout', line)
```

**Step 3: In `tool_executor.py`, only inject the callback if enabled**

```python
if function_name in {'terminal', 'process'} and _STREAM_TERMINAL and not function_args.get('background'):
```

**Step 4: Commit**

```bash
git add tools/terminal_tool.py agent/tool_executor.py
git commit -m "feat: add HERMES_STREAM_TERMINAL env var feature flag

Gate live terminal streaming behind HERMES_STREAM_TERMINAL env var.
Defaults to enabled ('1'). Set to '0'/'false'/'no'/'off' to disable.
Allows quick production rollback without code changes."
```

---

## Summary of Changes by File

### Hermes Source (`E:\Work\03_Projects\Hermes_Extension\Hermes_Full\hermes-agent`)

| File | Change Type | Tasks |
|------|-------------|-------|
| `tools/terminal_tool.py` | Modify (~20 lines) | Task 1, 10 |
| `agent/tool_executor.py` | Modify (~30 lines) | Task 2, 9, 10 |
| `acp_adapter/events.py` | Modify (~30 lines) | Task 3 |
| `acp_adapter/tools.py` | Modify (~40 lines) | Task 4 |

### Extension (`E:\Work\03_Projects\Hermes_Extension\hermes-ai`)

| File | Change Type | Tasks |
|------|-------------|-------|
| `src/webview/main.ts` | Modify (~20 lines) | Task 5 |
| `src/webview/renderers.ts` | Modify (~10 lines) | Task 5, 8 |
| `src/webview/state.ts` | Modify (~5 lines) | Task 5 |
| `src/types.ts` | Modify (~3 lines) | Task 5 |
| `src/chatPanel.ts` | Modify (~25 lines) | Task 6 |
| `package.json` | Bump version | Task 7 |
| CSS file | Modify (~10 lines) | Task 8 |

---

## Rollback Plan

If streaming causes issues:
1. Set `HERMES_STREAM_TERMINAL=0` to disable the feature flag (no code change needed)
2. The extension `toolOutput` handler is a no-op when no chunks arrive — existing `tool_call_update` completion path still works
3. Revert the extension to the previous VSIX if needed
4. Switch `hermes-ai.path` back to the official `hermes.exe`

---

## Risks & Open Questions

1. **ACP message rate limiting**: Streaming every line could flood the ACP stdio pipe. Consider batching chunks (e.g., send every 50ms or every 256 bytes).
2. **Background terminal commands**: Not yet supported for streaming. The `process` tool's `action='poll'` could return accumulated output, but true streaming for background processes requires a different approach (push notifications from the background process).
3. **Gateway sessions**: The gateway relay between remote client and agent process may need separate handling for streaming events.
4. **Large output**: If a command produces megabytes of output, streaming all of it through ACP could be expensive. The existing `tool_output_limits` module should apply.
5. **`execute_code` tool**: This also produces terminal-like output. Should it also stream? (Yes — it uses `terminal_tool` internally or has its own subprocess path.)