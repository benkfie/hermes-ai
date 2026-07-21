p = 'src/webview/main.ts'
with open(p, encoding='utf-8') as f:
    s = f.read()

old = """    case 'toolCall': {
      if (!msg.toolName && msg.toolCallId) {
        const existing = document.querySelector(`[data-tool-id="${msg.toolCallId}"]`);
        if (existing) {
          const isDone = msg.toolStatus === 'done' || msg.toolStatus === 'completed';
          const isError = msg.toolStatus === 'error';
          const statusEl = existing.querySelector('.tool-status');
          if (statusEl) {
            statusEl.textContent = isDone ? '✓' : isError ? '✗' : '⋯';
            statusEl.className = `tool-status${isDone ? ' done' : isError ? ' error' : ''}`;
          }
        }
        break;
      }
      if (S.pendingText) flushPending();
      if (S.currentAgentEl && S.currentAgentText) renderMarkdown(S.currentAgentEl, S.currentAgentText);
      S.currentAgentEl = null; S.currentAgentText = '';
      document.getElementById('waiting')?.remove();
      const isDone = msg.toolStatus === 'done' || msg.toolStatus === 'completed';
      const isError = msg.toolStatus === 'error';
      const statusIcon = isDone ? '✓' : isError ? '✗' : '⋯';
      const statusClass = isDone ? ' done' : isError ? ' error' : '';
      const toolEl = appendDiv(messagesEl, 'msg tool');
      if (msg.toolCallId) toolEl.dataset.toolId = msg.toolCallId;
      const { label, info } = formatToolDisplay(msg.toolName ?? '', msg.toolKind, msg.toolLocations, msg.toolDetail);
      const infoHtml = info ? `<span class="tool-detail">${DOMPurify.sanitize(info)}</span>` : '';
      toolEl.innerHTML = `<span class="tool-status${statusClass}">${statusIcon}</span><span class="tool-name">${label}</span>${infoHtml}`;
      autoScroll();
      break;
    }"""

new = """    case 'toolCall': {
      // tool_call_update
      if (!msg.toolName && msg.toolCallId) {
        const existing = document.querySelector(`[data-tool-id="${msg.toolCallId}"]`);
        if (existing) {
          const upDone = msg.toolStatus === 'done' || msg.toolStatus === 'completed';
          const upErr = msg.toolStatus === 'error';
          const statusEl = existing.querySelector('.tool-status');
          if (statusEl) {
            statusEl.textContent = upDone ? '✓' : upErr ? '✗' : '⋯';
            statusEl.className = `tool-status${upDone ? ' done' : upErr ? ' error' : ''}`;
          }
        }
        let termBlock = document.querySelector(`[data-term-id="${msg.toolCallId}"]`);
        if (!termBlock && (msg as any).toolOutput) {
          const info = S.toolCommandMap.get(msg.toolCallId);
          if (info) termBlock = renderTerminalBlock(messagesEl, msg.toolCallId, info, '', false);
        }
        if (termBlock && (msg as any).toolOutput) {
          const body = termBlock.querySelector('.term-body') as HTMLElement;
          if (body) body.textContent = (msg as any).toolOutput;
          const upDone2 = msg.toolStatus === 'done' || msg.toolStatus === 'completed';
          if (upDone2 || msg.toolStatus === 'error') termBlock.classList.add('term-done');
        }
        break;
      }
      if (S.pendingText) flushPending();
      if (S.currentAgentEl && S.currentAgentText) renderMarkdown(S.currentAgentEl, S.currentAgentText);
      S.currentAgentEl = null; S.currentAgentText = '';
      document.getElementById('waiting')?.remove();
      const isDone = msg.toolStatus === 'done' || msg.toolStatus === 'completed';
      const isError = msg.toolStatus === 'error';
      const statusIcon = isDone ? '✓' : isError ? '✗' : '⋯';
      const statusClass = isDone ? ' done' : isError ? ' error' : '';

      const isNonTerminal = msg.toolKind === 'read'
        || msg.toolKind === 'search' || msg.toolKind === 'fetch'
        || msg.toolKind === 'think' || msg.toolKind === 'delete'
        || msg.toolKind === 'move';
      const hasOutput = !!(msg as any).toolOutput;
      const isTerminal = !isNonTerminal && (hasOutput
        || msg.toolKind === 'execute' || msg.toolKind === 'bash'
        || msg.toolKind === 'terminal' || msg.toolKind === 'shell'
        || /bash|terminal|shell|command|execute|run|cmd/i.test(msg.toolName ?? ''));

      if (isTerminal && msg.toolName) {
        const cmd = msg.toolName.replace(/^(Bash|Terminal|Shell|Command):\s*/i, '').trim() || msg.toolName;
        if (msg.toolCallId) S.toolCommandMap.set(msg.toolCallId, cmd);
        renderTerminalBlock(messagesEl, msg.toolCallId ?? '', cmd, (msg as any).toolOutput ?? '', isDone);
      } else {
        const toolEl = appendDiv(messagesEl, 'msg tool');
        if (msg.toolCallId) toolEl.dataset.toolId = msg.toolCallId;
        const { label, info } = formatToolDisplay(msg.toolName ?? '', msg.toolKind, msg.toolLocations, msg.toolDetail);
        const infoHtml = info ? `<span class="tool-detail">${DOMPurify.sanitize(info)}</span>` : '';
        toolEl.innerHTML = `<span class="tool-status${statusClass}">${statusIcon}</span><span class="tool-name">${label}</span>${infoHtml}`;
      }
      autoScroll();
      break;
    }"""

assert old in s, 'OLD NOT FOUND'
s = s.replace(old, new)

# Fix clear handler
s = s.replace(
    "S.currentAgentEl = null; S.currentAgentText = ''; S.thinkingStatusEl = null; S.pendingText = '';\n      setBusy(false);",
    "S.currentAgentEl = null; S.currentAgentText = ''; S.thinkingStatusEl = null; S.pendingText = '';\n      S.terminalBlocks.clear();\n      S.toolCommandMap.clear();\n      setBusy(false);"
)

with open(p, 'w', encoding='utf-8') as f:
    f.write(s)

print('TERMINAL HANDLER APPLIED')
