/**
 * Webview rendering functions — markdown, tool calls, todo overlay, history.
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { StoredMessage, TodoItem } from '../types';

// ── Markdown ─────────────────────────────────────────

export function renderMarkdown(el: HTMLElement, text: string): void {
  el.innerHTML = DOMPurify.sanitize(marked.parse(text) as string, {
    ALLOWED_TAGS: ['p','br','strong','em','del','code','pre','ul','ol','li',
      'blockquote','h1','h2','h3','h4','h5','h6','a','hr','table','thead','tbody','tr','th','td',
      'img'],
    ALLOWED_ATTR: ['href', 'title', 'class', 'src', 'alt'],
  });
  el.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  // Copy buttons on code blocks
  el.querySelectorAll('pre').forEach(pre => {
    const btn = document.createElement('button');
    btn.className = 'copy-btn'; btn.textContent = 'Copy';
    btn.addEventListener('click', () => {
      const code = pre.querySelector('code')?.textContent ?? pre.textContent ?? '';
      navigator.clipboard.writeText(code).then(() => {
        btn.textContent = '✓'; btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
      });
    });
    pre.appendChild(btn);
  });
}

// ── DOM helpers ──────────────────────────────────────

export function appendDiv(container: HTMLElement, className: string): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  container.appendChild(el);
  return el;
}

export function appendMessage(container: HTMLElement, role: 'user' | 'agent' | 'tool' | 'error', text: string): HTMLElement {
  const el = appendDiv(container, `msg ${role}`);
  el.textContent = text;
  el.scrollIntoView({ block: 'end' });
  return el;
}

export function showWaiting(container: HTMLElement): void {
  const el = appendDiv(container, 'status-line');
  el.id = 'waiting';
  const startTime = Date.now();

  function formatElapsed(): string {
    const secs = Math.floor((Date.now() - startTime) / 1000);
    if (secs < 30) return `Thinking… ${secs}s`;
    if (secs < 60) return `Taking a while… ${secs}s — you can Cancel if needed`;
    const mins = Math.floor(secs / 60);
    const rem = secs % 60;
    return `Still working… ${mins}m ${rem}s`;
  }

  el.textContent = 'Thinking…';

  // Tick every second to update the elapsed counter
  const interval = setInterval(() => {
    if (!document.contains(el)) {
      // Element was removed — stop the timer
      clearInterval(interval);
      return;
    }
    el.textContent = formatElapsed();
  }, 1000);

  el.scrollIntoView({ block: 'end' });
}

// ── Tool display ─────────────────────────────────────

const KIND_LABELS: Record<string, string> = {
  read: 'Read', edit: 'Edit', delete: 'Delete', move: 'Move',
  search: 'Search', execute: 'Bash', think: 'Think',
  fetch: 'Fetch', switch_mode: 'Mode', other: 'Tool',
};

export function formatToolDisplay(
  title: string, kind?: string, locations?: string[], detail?: string
): { label: string; info: string } {
  const label = KIND_LABELS[kind ?? ''] ?? title.split(':')[0]?.trim() ?? 'Tool';
  if (locations?.length) {
    const shortPath = locations[0].replace(/^\/home\/[^/]+\//, '~/');
    return { label, info: shortPath };
  }
  const colonIdx = title.indexOf(':');
  if (colonIdx > 0) {
    const info = title.slice(colonIdx + 1).trim();
    return { label, info: info.length > 70 ? info.slice(0, 67) + '…' : info };
  }
  return { label, info: detail ?? '' };
}


// ── Terminal block rendering ──────────────────────────

/** Render or update a collapsible terminal block for an execute tool call. */
export function renderTerminalBlock(
  container: HTMLElement,
  toolId: string,
  command: string,
  outputChunk: string,
  isDone: boolean,
  append: boolean = false,
): HTMLElement {
  const chatToggle = document.getElementById('autoscroll-chat') as HTMLInputElement | null;
  const chatAutoScrollEnabled = chatToggle ? chatToggle.checked : true;
  const isChatNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 120;

  let block = container.querySelector(`[data-term-id="${toolId}"]`);
  if (!block) {
    block = appendDiv(container, 'msg terminal');
    (block as HTMLElement).setAttribute('data-term-id', toolId);
    const header = document.createElement('div');
    header.className = 'term-header';
    header.innerHTML = `<span class="term-icon">$</span><span class="term-cmd">${escapeTerm(command)}</span><div class="term-scroll-wrap" style="display: flex; align-items: center; gap: 4px; font-size: 0.85em; opacity: 0.8; user-select: none; margin-left: 8px;"><input type="checkbox" class="term-autoscroll" checked style="margin: 0; cursor: pointer;" /><span style="font-size: 0.95em;">Auto-scroll</span></div>`;
    const autoscrollCb = header.querySelector('.term-autoscroll') as HTMLInputElement | null;
    if (autoscrollCb) {
      autoscrollCb.addEventListener('click', (e) => {
        e.stopPropagation();
      });
    }
    block.appendChild(header);
    const body = document.createElement('pre');
    body.className = 'term-body';
    block.appendChild(body);
  } else {
    // Update header command text if it changed (e.g. from 'pending...' to real command)
    const cmdEl = block.querySelector('.term-cmd') as HTMLElement;
    if (cmdEl) {
      cmdEl.innerHTML = escapeTerm(command);
    }
  }

  const body = block.querySelector('.term-body') as HTMLElement;
  const autoscrollCb = block.querySelector('.term-autoscroll') as HTMLInputElement | null;
  const termAutoScrollEnabled = autoscrollCb ? autoscrollCb.checked : true;

  if (body && outputChunk !== undefined) {
    const isTermNearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 50;

    // Normalize newlines to prevent carriage return issues collapsing lines
    const normalizedChunk = outputChunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    let raw = body.getAttribute('data-raw') || '';
    if (append) {
      raw += normalizedChunk;
    } else {
      raw = normalizedChunk;
    }
    body.setAttribute('data-raw', raw);
    body.innerHTML = ansiToHtml(raw);

    if (termAutoScrollEnabled && (isTermNearBottom || !append)) {
      body.scrollTop = body.scrollHeight;
    }
  }

  if (isDone) {
    block.classList.add('term-done');
  } else {
    block.classList.remove('term-done');
  }

  if (chatAutoScrollEnabled && isChatNearBottom) {
    container.scrollTop = container.scrollHeight;
  }
  return block as HTMLElement;
}

function escapeTerm(s: string): string {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML;
}

// ── Todo overlay ─────────────────────────────────────

const TODO_ICONS: Record<string, string> = {
  completed: '✓', in_progress: '■', pending: '□', cancelled: '✗',
};

export function renderTodoOverlay(container: HTMLElement, todos: TodoItem[]): void {
  if (!todos.length) { container.style.display = 'none'; return; }
  const completed = todos.filter(t => t.status === 'completed').length;
  const items = todos.map(t => {
    const icon = TODO_ICONS[t.status] ?? '□';
    const text = t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content;
    return `<div class="todo-item">
      <span class="todo-icon ${t.status}">${icon}</span>
      <span class="todo-text ${t.status}">${DOMPurify.sanitize(text)}</span>
    </div>`;
  }).join('');
  container.innerHTML = `<div class="todo-header">Tasks ${completed}/${todos.length}</div>${items}`;
  container.style.display = 'block';
}

export function detectTodoUpdate(text: string, container: HTMLElement): boolean {
  const match = /\{[\s\S]*"todos"\s*:\s*\[[\s\S]*\][\s\S]*\}/.exec(text);
  if (!match) return false;
  try {
    const data = JSON.parse(match[0]);
    if (Array.isArray(data.todos) && data.todos.length > 0) {
      renderTodoOverlay(container, data.todos);
      return true;
    }
  } catch { /* not valid JSON */ }
  return false;
}

// ── History loading ──────────────────────────────────

export function loadHistory(
  container: HTMLElement, history: StoredMessage[], isSwitched = false
): void {
  if (history.length === 0) return;
  const emptyState = document.getElementById('empty-state');
  if (emptyState) emptyState.style.display = 'none';

  for (const m of history) {
    if (m.role === 'user') {
      appendMessage(container, 'user', m.text);
    } else if (m.role === 'agent') {
      const el = appendDiv(container, 'msg agent');
      renderMarkdown(el, m.text);
      el.scrollIntoView({ block: 'end' });
    } else if (m.role === 'tool') {
      const toolEl = appendDiv(container, 'msg tool');
      const isError = m.text.startsWith('✗');
      const isPending = m.text.startsWith('⋯');
      const icon = isError ? '✗' : isPending ? '⋯' : '✓';
      const cls = isError ? ' error' : isPending ? '' : ' done';
      const cleaned = DOMPurify.sanitize(m.text.replace(/^[✓✗⋯]\s*/, ''));
      const colonIdx = cleaned.indexOf(':');
      const name = colonIdx > 0 ? cleaned.slice(0, colonIdx).trim() : cleaned;
      const detail = colonIdx > 0 ? `<span class="tool-detail">${cleaned.slice(colonIdx + 1).trim()}</span>` : '';
      toolEl.innerHTML = `<span class="tool-status${cls}">${icon}</span><span class="tool-name">${name}</span>${detail}`;
    } else if (m.role === 'error') {
      appendMessage(container, 'error', m.text);
    }
  }
  if (isSwitched) {
    const divider = appendDiv(container, 'history-divider');
    divider.textContent = '— Hermes context reset — new messages start fresh —';
    divider.scrollIntoView({ block: 'end' });
  }
}

// ── Formatting ───────────────────────────────────────

export function fmtTok(n: number): string {
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}M`;
  }
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

export function fmtAge(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

export function ansiToHtml(text: string): string {
  const fgMap: Record<number, string> = {
    30: 'var(--vscode-terminal-ansiBlack)',
    31: 'var(--vscode-terminal-ansiRed)',
    32: 'var(--vscode-terminal-ansiGreen)',
    33: 'var(--vscode-terminal-ansiYellow)',
    34: 'var(--vscode-terminal-ansiBlue)',
    35: 'var(--vscode-terminal-ansiMagenta)',
    36: 'var(--vscode-terminal-ansiCyan)',
    37: 'var(--vscode-terminal-ansiWhite)',
    90: 'var(--vscode-terminal-ansiBrightBlack)',
    91: 'var(--vscode-terminal-ansiBrightRed)',
    92: 'var(--vscode-terminal-ansiBrightGreen)',
    93: 'var(--vscode-terminal-ansiBrightYellow)',
    94: 'var(--vscode-terminal-ansiBrightBlue)',
    95: 'var(--vscode-terminal-ansiBrightMagenta)',
    96: 'var(--vscode-terminal-ansiBrightCyan)',
    97: 'var(--vscode-terminal-ansiBrightWhite)',
  };

  const bgMap: Record<number, string> = {
    40: 'var(--vscode-terminal-ansiBlack)',
    41: 'var(--vscode-terminal-ansiRed)',
    42: 'var(--vscode-terminal-ansiGreen)',
    43: 'var(--vscode-terminal-ansiYellow)',
    44: 'var(--vscode-terminal-ansiBlue)',
    45: 'var(--vscode-terminal-ansiMagenta)',
    46: 'var(--vscode-terminal-ansiCyan)',
    47: 'var(--vscode-terminal-ansiWhite)',
    100: 'var(--vscode-terminal-ansiBrightBlack)',
    101: 'var(--vscode-terminal-ansiBrightRed)',
    102: 'var(--vscode-terminal-ansiBrightGreen)',
    103: 'var(--vscode-terminal-ansiBrightYellow)',
    104: 'var(--vscode-terminal-ansiBrightBlue)',
    105: 'var(--vscode-terminal-ansiBrightMagenta)',
    106: 'var(--vscode-terminal-ansiBrightCyan)',
    107: 'var(--vscode-terminal-ansiBrightWhite)',
  };

  let html = '';
  let i = 0;
  let bold = false;
  let italic = false;
  let underline = false;
  let fg: string | null = null;
  let bg: string | null = null;
  let openSpan = false;

  function closeSpanIfOpen() {
    if (openSpan) {
      html += '</span>';
      openSpan = false;
    }
  }

  function openNewSpan() {
    closeSpanIfOpen();
    const styles: string[] = [];
    if (bold) styles.push('font-weight: bold');
    if (italic) styles.push('font-style: italic');
    if (underline) styles.push('text-decoration: underline');
    if (fg) styles.push(`color: ${fg}`);
    if (bg) styles.push(`background-color: ${bg}`);

    if (styles.length > 0) {
      html += `<span style="${styles.join('; ')}">`;
      openSpan = true;
    }
  }

  while (i < text.length) {
    if (text[i] === '\u001b' || text[i] === '\x1b') {
      let j = i + 1;
      if (text[j] === '[') {
        j++;
        while (j < text.length && !/[a-zA-Z]/.test(text[j])) {
          j++;
        }
        if (j < text.length) {
          const sequence = text.slice(i + 2, j);
          const commandType = text[j];
          i = j + 1;

          if (commandType === 'm') {
            const codes = sequence.split(';').map(Number);
            let cIdx = 0;
            while (cIdx < codes.length) {
              const code = codes[cIdx];
              if (code === 0) {
                bold = false;
                italic = false;
                underline = false;
                fg = null;
                bg = null;
                cIdx++;
              } else if (code === 1) {
                bold = true;
                cIdx++;
              } else if (code === 3) {
                italic = true;
                cIdx++;
              } else if (code === 4) {
                underline = true;
                cIdx++;
              } else if (code === 22) {
                bold = false;
                cIdx++;
              } else if (code === 23) {
                italic = false;
                cIdx++;
              } else if (code === 24) {
                underline = false;
                cIdx++;
              } else if (fgMap[code] !== undefined) {
                fg = fgMap[code];
                cIdx++;
              } else if (code === 39) {
                fg = null;
                cIdx++;
              } else if (bgMap[code] !== undefined) {
                bg = bgMap[code];
                cIdx++;
              } else if (code === 49) {
                bg = null;
                cIdx++;
              } else if (code === 38) {
                if (cIdx + 1 < codes.length) {
                  const type = codes[cIdx + 1];
                  if (type === 5 && cIdx + 2 < codes.length) {
                    const colorIndex = codes[cIdx + 2];
                    fg = getAnsiColorByIndex(colorIndex);
                    cIdx += 3;
                  } else if (type === 2 && cIdx + 4 < codes.length) {
                    const r = codes[cIdx + 2];
                    const g = codes[cIdx + 3];
                    const b = codes[cIdx + 4];
                    fg = `rgb(${r},${g},${b})`;
                    cIdx += 5;
                  } else {
                    cIdx++;
                  }
                } else {
                  cIdx++;
                }
              } else if (code === 48) {
                if (cIdx + 1 < codes.length) {
                  const type = codes[cIdx + 1];
                  if (type === 5 && cIdx + 2 < codes.length) {
                    const colorIndex = codes[cIdx + 2];
                    bg = getAnsiColorByIndex(colorIndex);
                    cIdx += 3;
                  } else if (type === 2 && cIdx + 4 < codes.length) {
                    const r = codes[cIdx + 2];
                    const g = codes[cIdx + 3];
                    const b = codes[cIdx + 4];
                    bg = `rgb(${r},${g},${b})`;
                    cIdx += 5;
                  } else {
                    cIdx++;
                  }
                } else {
                  cIdx++;
                }
              } else {
                cIdx++;
              }
            }
            openNewSpan();
          }
          continue;
        }
      }
    }

    const char = text[i];
    if (char === '<') {
      html += '&lt;';
    } else if (char === '>') {
      html += '&gt;';
    } else if (char === '&') {
      html += '&amp;';
    } else {
      html += char;
    }
    i++;
  }

  closeSpanIfOpen();
  return html;
}

function getAnsiColorByIndex(index: number): string {
  const standard = [
    'var(--vscode-terminal-ansiBlack)',
    'var(--vscode-terminal-ansiRed)',
    'var(--vscode-terminal-ansiGreen)',
    'var(--vscode-terminal-ansiYellow)',
    'var(--vscode-terminal-ansiBlue)',
    'var(--vscode-terminal-ansiMagenta)',
    'var(--vscode-terminal-ansiCyan)',
    'var(--vscode-terminal-ansiWhite)',
    'var(--vscode-terminal-ansiBrightBlack)',
    'var(--vscode-terminal-ansiBrightRed)',
    'var(--vscode-terminal-ansiBrightGreen)',
    'var(--vscode-terminal-ansiBrightYellow)',
    'var(--vscode-terminal-ansiBrightBlue)',
    'var(--vscode-terminal-ansiBrightMagenta)',
    'var(--vscode-terminal-ansiBrightCyan)',
    'var(--vscode-terminal-ansiBrightWhite)'
  ];
  if (index < 16) {
    return standard[index];
  }
  if (index >= 16 && index <= 231) {
    const adjusted = index - 16;
    const r = Math.floor(adjusted / 36) * 51;
    const g = Math.floor((adjusted % 36) / 6) * 51;
    const b = (adjusted % 6) * 51;
    return `rgb(${r},${g},${b})`;
  }
  if (index >= 232 && index <= 255) {
    const val = 8 + (index - 232) * 10;
    return `rgb(${val},${val},${val})`;
  }
  return 'initial';
}
