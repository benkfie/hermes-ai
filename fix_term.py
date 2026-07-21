p = 'src/webview/main.ts'
with open(p, encoding='utf-8') as f:
    s = f.read()

old = '''    case 'toolCall': {
      if (!msg.toolName && msg.toolCallId) {
        const existing = document.querySelector''' + '''(`[data-tool-id="${msg.toolCallId}"]`);
        if (existing) {
          const isDone = msg.toolStatus === 'done' || msg.toolStatus === 'completed';
          const isError = msg.toolStatus === 'error';
          const statusEl = existing.querySelector('.tool-status');
          if (statusEl) {
            statusEl.textContent = isDone ? ''' + "'✓'" + ''' : isError ? ''' + "'✗'" + ''' : ''' + "'⋯'" + ''';
            statusEl.className = `tool-status${isDone ? ''' + "' done'" + ''' : isError ? ''' + "' error'" + ''' : ''' + "''" + '''}`;
          }
        }
        break;
      }
      if (S.pendingText) flushPending();
      if (S.currentAgentEl && S.currentAgentText) renderMarkdown(S.currentAgentEl, S.currentAgentText);
      S.currentAgentEl = null; S.currentAgentText = ''' + "''" + ''';
      document.getElementById('waiting')?.remove();
      const isDone = msg.toolStatus === ''' + "'done'" + ''' || msg.toolStatus === ''' + "'completed'" + ''';
      const isError = msg.toolStatus === ''' + "'error'" + ''';
      const statusIcon = isDone ? ''' + "'✓'" + ''' : isError ? ''' + "'✗'" + ''' : ''' + "'⋯'" + ''';
      const statusClass = isDone ? ''' + "' done'" + ''' : isError ? ''' + "' error'" + ''' : ''' + "''" + ''';
      const toolEl = appendDiv(messagesEl, ''' + "'msg tool'" + ''');
      if (msg.toolCallId) toolEl.dataset.toolId = msg.toolCallId;
      const { label, info } = formatToolDisplay(msg.toolName ?? ''' + "''" + ''', msg.toolKind, msg.toolLocations, msg.toolDetail);
      const infoHtml = info ? `<span class="tool-detail">${DOMPurify.sanitize(info)}</span>` : ''' + "''" + ''';
      toolEl.innerHTML = `<span class="tool-status${statusClass}">${statusIcon}</span><span class="tool-name">${label}</span>${infoHtml}`;
      autoScroll();
      break;
    }'''

if old in s:
    print('OLD HANDLER FOUND')
else:
    print('OLD HANDLER NOT FOUND - checking for partial match')
    for line in old.split(chr(10))[:3]:
        if line.strip() in s:
            print(f'  FOUND: {line.strip()[:60]}')
        else:
            print(f'  MISSING: {line.strip()[:60]}')
