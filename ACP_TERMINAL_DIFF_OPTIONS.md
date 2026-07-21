# Hermes Extension: Terminal Output + Diff Display Options

Date: 2026-07-21  
Context: Hermes AI VS Code/Antigravity extension (`hermes-ai`) talking to Hermes Agent over ACP.

## Current finding

The requested UI is **partly possible in the extension alone**, but **true live terminal streaming requires Hermes Agent core / ACP adapter changes**.

The extension can only render data it receives from ACP. Today Hermes ACP emits:

- `tool_call` when a tool starts
- `tool_call_update` when the tool finishes / reports completion
- `agent_thought_chunk` for thinking text
- `agent_message_chunk` for assistant response text

For terminal tools, Hermes currently sends command output mainly after completion, not continuously while the subprocess is running.

## Why previous attempts failed

### 1. Wrong ACP content shape assumption

Tool completion output is not always flat text:

```json
{ "type": "text", "text": "..." }
```

Actual ACP tool content commonly arrives nested:

```json
{
  "type": "content",
  "content": {
    "type": "text",
    "text": "..."
  }
}
```

So extension parsing must scan both:

```ts
block.text
block.content?.text
```

### 2. Terminal output is not live-streamed by ACP today

Hermes core currently behaves roughly like:

1. `tool.started` callback fires
2. terminal command runs inside Hermes
3. command completes
4. `step_callback(prev_tools)` receives final tool result
5. ACP sends `tool_call_update`

That means the extension cannot show true live stdout/stderr unless Hermes core emits live terminal chunks.

### 3. `rawOutput` is intentionally omitted for polished tools

In Hermes Agent `acp_adapter/tools.py`, tools in `_POLISHED_TOOLS` get:

```py
raw_output=None
```

`terminal`, `process`, `execute_code`, `write_file`, `patch`, etc. are polished tools. Their output is placed in structured `content`, often formatted/truncated.

### 4. Diffs are clean only for structured edit tools

Automatic diffs work reliably for:

- `write_file`
- `patch`
- possibly `skill_manage`

If a file is edited by a shell command, ACP sees only a `terminal` tool. The extension does not inherently know which files changed unless it snapshots/watches the workspace.

---

## Option A — Extension-only approximation

**Scope:** Keep changes inside `hermes-ai` extension.

### What it can provide

- Render terminal-like blocks after tool completion.
- Show final command output parsed from nested ACP content blocks.
- Show structured tool calls more clearly.
- Show diffs for structured edit tools (`write_file`, `patch`).
- Optionally detect file changes after terminal commands using git/filesystem snapshots.

### Implementation pieces

- Fix `src/protocol.ts::parseToolCallUpdate()` to parse nested ACP content blocks.
- In `src/webview/main.ts`, render execute-like tools as `.msg.terminal` blocks.
- Track command text by `toolCallId` from `tool_call` so `tool_call_update` can populate the matching block.
- For shell-based edits, snapshot `git status --porcelain` or file mtimes before/after terminal tool completion and open diffs for changed files.

### Pros

- Fastest path.
- No Hermes Agent core changes.
- Lower risk.
- Good enough for final-output visibility.

### Cons

- Not true live streaming.
- Output may still be truncated upstream by Hermes polished formatter.
- File diffs after terminal commands are heuristic.
- Cannot show terminal output that Hermes never sends.

### Verdict

Good short-term fallback. Not enough if the requirement is “watch the terminal as it runs”.

---

## Option B — Proper Hermes core + ACP implementation

**Scope:** Modify Hermes Agent itself plus extension renderer.

### Goal

Make Hermes Agent emit live terminal stdout/stderr chunks over ACP while a terminal/process tool is running.

### Required Hermes Agent changes

1. `tools/terminal_tool.py`
   - Add a streaming callback hook for stdout/stderr chunks.
   - Emit command start, stdout chunk, stderr chunk, exit code, completion.

2. `agent/tool_executor.py`
   - Pass a per-tool progress callback into terminal/process execution.
   - Preserve `toolCallId` association for the running command.

3. `acp_adapter/events.py`
   - Extend `make_tool_progress_cb()` to handle events beyond `tool.started`, e.g.:
     - `tool.output`
     - `tool.stderr`
     - `tool.completed`
   - Send incremental ACP updates for each chunk.

4. `acp_adapter/tools.py`
   - Avoid truncating terminal output intended for live display.
   - Put raw terminal chunks in a predictable content field or raw output field.

5. Extension (`hermes-ai`)
   - Append terminal chunks into persistent `.msg.terminal .term-body` blocks.
   - Keep command header visible.
   - Mark block complete on final update.

### Pros

- Correct architecture.
- Real live terminal streaming.
- Works for long-running commands.
- Extension UI can accurately show current activity.

### Cons

- Requires Hermes Agent core changes, not just extension changes.
- Needs tests across local/background/process tools.
- More invasive; must avoid breaking CLI/TUI/gateway surfaces.

### Verdict

Best long-term solution and closest to the requested UX.

---

## Option C — Extension-side command execution

**Scope:** Extension executes commands itself in VS Code/Antigravity terminal or child process, rather than Hermes Agent executing them.

### How it would work

- Hermes requests command execution through ACP/client-side custom method.
- Extension runs command in VS Code terminal or Node child process.
- Extension streams output directly to the webview.
- Results are sent back to Hermes.

### Pros

- Full live output control in the extension.
- Can integrate with VS Code terminal APIs.
- Better UI control over terminal lifecycle.

### Cons

- Requires protocol extension or nonstandard ACP behavior.
- More security-sensitive: client is now executing model-requested commands.
- Duplicates Hermes terminal backend logic.
- Harder to keep consistent with Hermes CLI/TUI/gateway.

### Verdict

Possible, but probably not the best first choice. Consider only if ACP/core streaming is impractical.

---

## Option D — Hybrid pragmatic path

Recommended staged path:

1. **Short term:** implement Option A correctly.
   - final output terminal blocks
   - nested ACP content parsing
   - structured edit diffs
   - optional git snapshot diff fallback

2. **Medium term:** implement Option B for terminal streaming in Hermes core.
   - live chunks from `terminal_tool.py`
   - ACP progress updates
   - extension append-only terminal renderer

3. **Only if needed:** explore Option C for client-side execution.

## Recommendation

Choose **Option D**.

It gives immediate useful UI while moving toward the proper architecture. The key decision tomorrow is whether “final output in terminal blocks” is acceptable temporarily, or whether true live streaming is mandatory before continuing.
