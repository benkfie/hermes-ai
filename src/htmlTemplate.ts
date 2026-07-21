/**
 * HTML/CSS template builder for the Hermes chat webview.
 *
 * Extracted from chatPanel.ts to isolate the ~600-line template
 * from the controller logic. All user-controlled content is
 * HTML-escaped via escapeHtml() before injection.
 */

import * as vscode from 'vscode';
import type { ModelMenuGroup } from './modelCatalog';

export interface TemplateConfig {
  extensionUri: vscode.Uri;
  webview: vscode.Webview;
  initialModel: string;
  modelGroups: ModelMenuGroup[];
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function initialModelLabel(config: TemplateConfig): string {
  for (const g of config.modelGroups) {
    for (const m of g.items) {
      if (m.id === config.initialModel || m.command === config.initialModel) return m.label;
    }
  }
  return config.initialModel;
}

function buildModelMenuItems(config: TemplateConfig): string {
  const { modelGroups, initialModel } = config;
  const allItems = modelGroups.flatMap(g => g.items);
  const currentInList = allItems.find(m => m.id === initialModel || m.command === initialModel);
  const extra = currentInList ? [] : [{ id: initialModel, label: initialModel, command: initialModel }];

  return modelGroups.map(group => {
    const items = group.items.map(m => {
      const active = (m.id === initialModel || m.command === initialModel) ? ' active' : '';
      const suffix = m.command === m.id
        ? ''
        : `<span style="opacity:0.45;font-size:0.82em"> ${escapeHtml(m.command)}</span>`;
      return `<div class="model-option${active}" data-command="${escapeHtml(m.command)}">${escapeHtml(m.label)}${suffix}</div>`;
    }).join('');
    return `<div class="model-group-label">${escapeHtml(group.group)}</div>${items}`;
  }).join('<div class="model-sep"></div>') +
  extra.map(m => `<div class="model-option active" data-command="${escapeHtml(m.command)}">${escapeHtml(m.label)}</div>`).join('');
}

export function buildChatHtml(config: TemplateConfig): string {
  const { webview, extensionUri } = config;

  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'),
  );
  const logoUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'resources', 'hermes-logo.png'),
  );

  const nonce = Array.from(
    { length: 32 },
    () => Math.random().toString(36)[2],
  ).join('');

  const modelLabel = initialModelLabel(config);
  const modelMenuHtml = buildModelMenuItems(config);

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src 'nonce-${nonce}';
             style-src 'unsafe-inline';
             img-src ${webview.cspSource} data:;">
  <title>Hermes AI</title>
  <style>
${CSS_TEMPLATE}
  </style>
</head>
<body>
  <div id="header">
    <div id="header-session">
      <span class="sessions-label">Sessions</span>
      <button id="status-session" title="Switch session">new session</button>
      <div id="status-right">
        <div id="ctx-bar-wrap" style="display:none"><div id="ctx-bar"></div><div id="ctx-bar-fresh"></div></div>
        <span id="status-context"></span>
      </div>
    </div>
    <div id="session-picker" class="status-dropdown" style="display:none"></div>
  </div>
  <div id="messages">
    <div id="empty-state">
      <div class="empty-logo">✦</div>
      <div class="empty-title">What can I help you with?</div>
      <div class="prompt-chips">
        <div class="prompt-chip" data-prompt="Review this file">Review this file</div>
        <div class="prompt-chip" data-prompt="Explain the selected code">Explain the selected code</div>
        <div class="prompt-chip" data-prompt="Find bugs in this project">Find bugs in this project</div>
        <div class="prompt-chip" data-prompt="Write tests for this module">Write tests for this module</div>
      </div>
    </div>
  </div>
  <div id="todo-overlay"></div>
  <div id="input-drag"></div>
  <div id="composer">
  <div id="context-row">
    <div id="attach-chip"></div>
  </div>
  <div id="input-row">
    <textarea id="input" rows="2" placeholder="Message Hermes…"></textarea>
  </div>
  <div id="queue-status"></div>
  <div id="bottom-bar">
    <div class="btn-wrap" style="position:relative">
      <button class="cmd-btn" id="model-btn-header" title="Switch model" style="width:auto;padding:0 8px;font-size:0.75em;gap:4px;">
        <span style="opacity:0.5;font-size:0.9em;">🧠</span>${escapeHtml(modelLabel)} ▾
      </button>
      <div id="model-menu" style="display:none">
        <input type="text" id="model-search" placeholder="Search models..." style="width:100%;padding:6px 8px;border:none;border-bottom:1px solid var(--vscode-dropdown-border, #3c3c3c);background:var(--vscode-input-background);color:var(--vscode-input-foreground);font-size:0.82em;font-family:var(--ui-font);outline:none;box-sizing:border-box;">
        <div id="model-menu-items">${modelMenuHtml}</div>
      </div>
    </div>
    <button class="cmd-btn" id="attach-btn" title="Attach file"><span class="btn-icon">📎</span></button>
    <div class="btn-wrap">
      <button class="cmd-btn" id="skills-btn" title="Skills"><span class="btn-icon">✦</span></button>
      <div id="skills-menu" style="display:none"></div>
    </div>
    <div class="btn-wrap">
      <button class="cmd-btn" id="overflow-btn" title="Slash commands"><span class="btn-icon">/</span></button>
      <div id="overflow-menu" style="display:none">
      <div class="menu-group-label">Session</div>
      <div class="menu-item" data-cmd="/title" data-mode="prompt" data-arg-label="Session title"><span class="cmd-name">/title</span> Rename session…</div>
      <div class="menu-item" data-cmd="/new" data-mode="execute"><span class="cmd-name">/new</span> Fresh session</div>
      <div class="menu-item" data-cmd="/retry" data-mode="execute"><span class="cmd-name">/retry</span> Retry last message</div>
      <div class="menu-item" data-cmd="/compact" data-mode="execute"><span class="cmd-name">/compact</span> Compress context</div>
      <div class="menu-item" data-cmd="/save" data-mode="prompt" data-arg-label="Filename (optional)"><span class="cmd-name">/save</span> Save conversation…</div>

      <div class="menu-group-label">Info</div>
      <div class="menu-item" data-cmd="/context" data-mode="execute"><span class="cmd-name">/context</span> Context info</div>
      <div class="menu-item" data-cmd="/usage" data-mode="execute"><span class="cmd-name">/usage</span> Token usage</div>
      <div class="menu-item" data-cmd="/tools" data-mode="execute"><span class="cmd-name">/tools</span> List tools</div>
      <div class="menu-item" data-cmd="/help" data-mode="execute"><span class="cmd-name">/help</span> All commands</div>

      <div class="menu-group-label">Configuration</div>
      <div class="menu-item" data-cmd="/yolo" data-mode="execute"><span class="cmd-name">/yolo</span> Toggle YOLO mode</div>
      <div class="menu-item" data-cmd="/reasoning" data-mode="prompt" data-arg-label="Reasoning level (none|low|medium|high|xhigh)"><span class="cmd-name">/reasoning</span> Set effort…</div>

      <div class="menu-group-label danger-label">Danger</div>
      <div class="menu-item danger" data-cmd="/reset" data-mode="confirm" data-confirm="Clear the entire conversation history? This cannot be undone."><span class="cmd-name">/reset</span> Reset conversation</div>
      </div>
      <div id="cmd-arg-popover" style="display:none">
        <div class="cmd-arg-label" id="cmd-arg-label">Argument</div>
        <input type="text" id="cmd-arg-input" autocomplete="off" spellcheck="false"/>
        <div class="cmd-arg-hint">Enter to confirm · Esc to cancel</div>
      </div>
    </div>
    <div class="bar-spacer"></div>
    <div id="input-btns">
      <div id="action-area">
        <button id="send-btn">Send</button>
        <div id="busy-btns">
          <button id="stop-btn">■</button>
          <button id="queue-btn">▶</button>
        </div>
      </div>
    </div>
  </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>
`;}

// ── CSS ──────────────────────────────────────────────
// Extracted as a template literal constant for readability.
// All colors use --vscode-* variables with blue accent overrides.

const CSS_TEMPLATE = /* css */ `
    * { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --ui-font: 'Segoe UI', system-ui, -apple-system, sans-serif;
      --accent: var(--vscode-focusBorder, #007acc);
      --accent-dim: var(--vscode-textLink-foreground, #3794ff);
      --accent-subtle: rgba(0, 122, 204, 0.12);
      --accent-border: rgba(0, 122, 204, 0.3);
      --toolbar-height: 28px;
      --space-xs: 2px;
      --space-sm: 4px;
      --space-md: 8px;
      --space-lg: 12px;
      --space-xl: 16px;
      --radius-sm: 3px;
      --radius-md: 6px;
      --radius-lg: 8px;
    }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* ── Top bar (compact session selector) ──────────── */
    #header {
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
      background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.06));
      font-family: var(--ui-font);
      flex-shrink: 0;
      position: relative;
      z-index: 10;
      padding: 3px 8px;
      display: flex; align-items: center; gap: 8px;
    }
    #header-session {
      display: flex; align-items: center; gap: 6px;
      flex: 1; min-width: 0;
    }
    #header-session .sessions-label {
      font-size: 0.7em; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.05em; color: var(--vscode-descriptionForeground);
      opacity: 0.6; flex-shrink: 0;
    }
    #status-session {
      flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      cursor: pointer; background: none; border: none;
      color: var(--vscode-foreground); font: inherit;
      font-family: var(--ui-font); font-size: 0.82em;
      padding: 2px 6px; text-align: left; min-width: 0;
      border-radius: var(--radius-sm);
      transition: background 0.15s;
    }
    #status-session:hover { background: var(--accent-subtle); }
    #status-session::before { content: '💬 '; font-size: 0.9em; }
    *:focus-visible {
      outline: 1px solid var(--vscode-focusBorder, var(--accent));
      outline-offset: 1px;
    }
    #status-right {
      display: flex; align-items: center; gap: 6px;
      flex-shrink: 0; font-size: 0.78em;
      font-family: var(--ui-font);
      color: var(--vscode-descriptionForeground);
    }
    #status-context {
      white-space: nowrap; font-variant-numeric: tabular-nums;
    }
    #status-context.warn { color: #e5a000; opacity: 1; }
    #status-context.crit { color: var(--vscode-errorForeground, #f44747); }

    /* Token bar */
    #ctx-bar-wrap {
      width: 48px; height: 5px;
      background: rgba(255,255,255,0.1);
      border-radius: 2px; overflow: hidden; flex-shrink: 0;
      position: relative;
    }
    #ctx-bar {
      position: absolute; top: 0; left: 0;
      height: 100%; width: 0%;
      border-radius: 2px;
      background: var(--accent);
      opacity: 0.3;
      transition: width 0.4s ease;
    }
    #ctx-bar-fresh {
      position: absolute; top: 0; left: 0;
      height: 100%; width: 0%;
      border-radius: 2px;
      background: var(--accent);
      transition: width 0.4s ease;
    }
    #ctx-bar.warn, #ctx-bar-fresh.warn { background: #e5a000; }
    #ctx-bar.crit, #ctx-bar-fresh.crit { background: var(--vscode-errorForeground, #f44747); }

    /* ── Dropdowns ──────────────────────────────────── */
    .status-dropdown {
      position: absolute; top: calc(100% + 1px); left: 0; right: 0;
      background: var(--vscode-dropdown-background, var(--vscode-sideBar-background));
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-sideBarSectionHeader-border));
      border-radius: 0 0 var(--radius-md) var(--radius-md); z-index: 200; overflow: hidden;
      box-shadow: 0 4px 16px rgba(0,0,0,0.3);
    }
    .status-dropdown .menu-item {
      padding: 6px 10px; font-size: 0.82em; font-family: var(--ui-font);
      color: var(--vscode-foreground); cursor: pointer;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      display: flex; align-items: center; gap: 6px;
    }
    .status-dropdown .menu-item:hover { background: var(--accent-subtle); }
    .status-dropdown .menu-item.active { color: var(--accent); font-weight: 600; }
    .status-dropdown .menu-item .item-meta {
      opacity: 0.4; font-size: 0.85em; margin-left: auto; flex-shrink: 0;
    }
    .status-dropdown .menu-footer {
      padding: 6px 10px; font-size: 0.82em; font-family: var(--ui-font);
      color: var(--vscode-descriptionForeground); cursor: pointer;
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border);
    }
    .status-dropdown .menu-footer:hover { background: var(--accent-subtle); color: var(--accent); }
    .session-action {
      opacity: 0; cursor: pointer; font-size: 0.9em; flex-shrink: 0;
      padding: 0 3px; transition: opacity 0.15s;
    }
    .menu-item:hover .session-action { opacity: 0.5; }
    .session-action:hover { opacity: 1 !important; }
    .delete-session:hover { color: var(--vscode-errorForeground); }

    /* ── Messages area ──────────────────────────────── */
    #messages {
      flex: 1;
      min-height: 80px;
      overflow-y: auto;
      padding: var(--space-lg) var(--space-md);
      display: flex;
      flex-direction: column;
      gap: var(--space-md);
    }
    .msg {
      padding: 5px 8px;
      border-radius: var(--radius-sm);
      line-height: 1.35;
      word-break: break-word;
    }
    .msg.user {
      align-self: flex-end;
      max-width: 88%;
      white-space: pre-wrap;
      background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.12));
      border-left: 3px solid var(--accent);
      color: var(--vscode-foreground);
      border-radius: var(--radius-sm);
      padding: 6px 10px;
    }
    .msg.user::before {
      content: 'You';
      display: block;
      font-family: var(--ui-font);
      font-size: 0.7em;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      opacity: 0.55;
      margin-bottom: 3px;
    }
    .msg.user .context-annotation {
      font-family: var(--ui-font);
      font-size: 0.72em;
      opacity: 0.55;
      margin-top: 4px;
      padding-top: 4px;
      border-top: 1px solid rgba(255,255,255,0.1);
    }
    .msg.user .context-annotation .ctx-line {
      display: block;
      padding: 1px 0;
    }
    .msg.agent {
      background: transparent;
      white-space: pre-wrap;
      padding-left: 2px;
    }
    .msg.agent p { margin: 0.5em 0; white-space: normal; }
    .msg.agent p:first-child { margin-top: 0; }
    .msg.agent p:last-child { margin-bottom: 0; }
    .msg.system {
      align-self: center;
      max-width: 92%;
      background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.06));
      border: 1px solid var(--vscode-input-border);
      border-radius: var(--radius-md);
      padding: 8px 12px;
      font-family: var(--ui-font);
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      white-space: pre-wrap;
      margin: var(--space-sm) auto;
      text-align: left;
    }
    .msg.tool {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.8em;
      color: var(--vscode-foreground);
      background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.08));
      border-radius: var(--radius-sm);
      padding: 5px 10px;
      display: flex;
      align-items: baseline;
      gap: 6px;
      min-height: 22px;
      clear: both;
    }
    .msg.tool + .msg.tool { margin-top: -8px; }
    .msg.agent + .msg.tool { margin-top: var(--space-xs); }
    .msg.tool + .msg.agent { margin-top: var(--space-md); }
    .msg.tool .tool-status {
      color: var(--accent); flex-shrink: 0; width: 1.2em; text-align: center;
      font-size: 1.1em; font-weight: 700;
    }
    .msg.tool .tool-status.done { color: #4ec9b0; }
    .msg.tool .tool-status.error { color: var(--vscode-errorForeground, #f44747); }
    .msg.tool .tool-name { font-weight: 700; white-space: nowrap; }
    .msg.tool .tool-detail { opacity: 0.6; word-break: break-all; overflow-wrap: anywhere; min-width: 0; }
    .msg.error {
      font-family: var(--ui-font);
      color: var(--vscode-errorForeground);
      font-size: 0.85em;
    }
    .thinking-status { font-style: italic; color: var(--accent-dim); opacity: 0.7; }
    .thinking-status + .msg.tool { margin-top: var(--space-xs); }

    /* ── Empty state ────────────────────────────────── */
    #empty-state {
      display: flex; flex-direction: column; align-items: center;
      justify-content: center; gap: 12px; padding: 24px 16px;
      flex: 1; text-align: center;
    }
    #empty-state .empty-logo {
      font-size: 3em; opacity: 0.2;
      /* Caduceus replaced with a clean sparkle */
      content: '✦';
    }
    #empty-state .empty-title {
      font-family: var(--ui-font); font-size: 0.95em;
      color: var(--vscode-descriptionForeground);
    }
    #empty-state .prompt-chips {
      display: flex; flex-direction: column; gap: 6px; width: 100%; max-width: 260px;
    }
    .prompt-chip {
      background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.08));
      border: 1px solid var(--vscode-input-border);
      border-radius: var(--radius-md); padding: 8px 12px;
      font-family: var(--ui-font); font-size: 0.85em;
      color: var(--vscode-foreground); cursor: pointer;
      text-align: left; transition: border-color 0.15s;
    }
    .prompt-chip:hover { border-color: var(--accent); color: var(--accent); }
    .history-divider {
      text-align: center;
      font-family: var(--ui-font);
      font-size: 0.72em;
      opacity: 0.35;
      padding: 4px 0;
      border-top: 1px solid rgba(128,128,128,0.2);
      margin-top: 4px;
    }
    .status-line {
      font-family: var(--ui-font);
      font-size: 0.78em;
      color: var(--vscode-descriptionForeground);
      padding: 1px 4px;
    }

    /* ── Markdown ───────────────────────────────────── */
    .msg.agent h1, .msg.agent h2, .msg.agent h3,
    .msg.agent h4, .msg.agent h5, .msg.agent h6 {
      margin: 0.6em 0 0.2em; line-height: 1.2; font-weight: 600;
    }
    .msg.agent h1 { font-size: 1.2em; }
    .msg.agent h2 { font-size: 1.1em; }
    .msg.agent h3 { font-size: 1em; }
    .msg.agent ul, .msg.agent ol { padding-left: 1.4em; margin-bottom: 0.4em; }
    .msg.agent li { margin-bottom: 0.1em; white-space: normal; }
    .msg.agent blockquote {
      border-left: 3px solid var(--vscode-textBlockQuote-border, #555);
      padding-left: 0.75em; margin: 0.3em 0; opacity: 0.8; white-space: normal;
    }
    .msg.agent code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.87em;
      background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
      padding: 0.1em 0.3em; border-radius: 3px;
    }
    .msg.agent pre {
      background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
      border-radius: var(--radius-sm); padding: 0.6em 0.8em; margin: 0.4em 0;
      overflow-x: auto; white-space: pre;
    }
    .msg.agent pre code { background: none; padding: 0; font-size: 0.85em; border-radius: 0; }
    .msg.agent pre .copy-btn {
      position: absolute; top: 4px; right: 4px;
      background: rgba(128,128,128,0.25); border: none; border-radius: 3px;
      color: var(--vscode-foreground); font-family: var(--ui-font);
      font-size: 0.7em; padding: 2px 6px; cursor: pointer;
      opacity: 0; transition: opacity 0.15s;
    }
    .msg.agent pre:hover .copy-btn { opacity: 0.7; }
    .msg.agent pre .copy-btn:hover { opacity: 1; background: var(--accent-subtle); }
    .msg.agent pre .copy-btn.copied { color: #4ec9b0; }
    .msg.agent pre { position: relative; }
    .msg.agent img { max-width: 100%; border-radius: var(--radius-md); margin: 0.4em 0; }
    .msg.agent a { color: var(--vscode-textLink-foreground); text-decoration: none; }
    .msg.agent a:hover { text-decoration: underline; }
    .msg.agent hr {
      border: none;
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border);
      margin: 0.5em 0;
    }
    .msg.agent table { border-collapse: collapse; margin: 0.4em 0; font-size: 0.9em; white-space: normal; }
    .msg.agent th, .msg.agent td {
      border: 1px solid var(--vscode-sideBarSectionHeader-border);
      padding: 0.2em 0.45em;
    }
    .msg.agent th { font-weight: 600; background: rgba(128,128,128,0.1); }

    /* ── Drag handle ────────────────────────────────── */
    #input-drag {
      height: 5px; cursor: ns-resize;
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border);
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
    }
    #input-drag::after {
      content: ''; width: 28px; height: 2px; border-radius: 2px;
      background: var(--vscode-sideBarSectionHeader-border); opacity: 0.6;
    }

    /* ── Context row ────────────────────────────────── */
    #context-row {
      display: flex; align-items: center; gap: 4px;
      padding: 2px 8px 0; flex-shrink: 0;
    }
    #attach-chip {
      font-family: var(--ui-font); font-size: 0.72em;
      color: var(--accent);
      display: flex; align-items: center; gap: 4px;
      flex-wrap: wrap; flex: 1; min-width: 0;
    }
    #attach-chip .chip-name {
      background: var(--accent-subtle); border-radius: 3px;
      padding: 1px 6px; max-width: 160px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    #attach-chip .chip-x { cursor: pointer; opacity: 0.6; font-size: 1.1em; }
    #attach-chip .chip-x:hover { opacity: 1; }

    /* ── Composer ───────────────────────────────────── */
    #composer {
      margin: 4px 8px 8px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: var(--radius-lg);
      overflow: visible;
      transition: border-color 0.2s;
    }
    #composer:focus-within { border-color: var(--accent); }
    #composer.busy-glow { border-color: var(--accent); box-shadow: 0 0 8px rgba(0,122,204,0.25); }
    #composer.yolo { border-color: rgba(244, 135, 113, 0.7); }
    #composer.yolo.busy-glow { border-color: rgba(244, 135, 113, 0.7); box-shadow: 0 0 8px rgba(244,135,113,0.25); }

    #input-row { display: flex; align-items: stretch; padding: 8px 8px 2px; }
    #input {
      flex: 1;
      background: transparent;
      color: var(--vscode-input-foreground);
      border: none; padding: 2px 2px;
      font-family: inherit; font-size: inherit;
      resize: none; min-height: 0; height: 100%; overflow-y: auto;
    }
    #input:focus { outline: none; }
    #input::placeholder { color: var(--vscode-input-placeholderForeground); }

    /* Send / Stop */
    #input-btns { display: flex; align-items: center; flex-shrink: 0; }
    #action-area { display: flex; align-items: center; }
    #input-btns button {
      font-family: var(--ui-font); font-size: 0.78em; font-weight: 600;
      letter-spacing: 0.02em; border: none; border-radius: var(--radius-sm);
      cursor: pointer; padding: 4px 14px; height: var(--toolbar-height);
    }
    #send-btn { background: var(--accent); color: #fff; min-width: 56px; }
    #send-btn:hover { opacity: 0.85; }
    #busy-btns { display: none; gap: 2px; }
    #busy-btns button { min-width: 32px; font-size: 1em; padding: 4px 8px; }
    #stop-btn { background: var(--vscode-errorForeground, #f44747); color: #fff; }
    #stop-btn:hover { opacity: 0.85; }
    #queue-btn { background: var(--accent); color: #fff; }
    #queue-btn:hover { opacity: 0.8; }

    #queue-status {
      font-family: var(--ui-font); font-size: 0.72em;
      color: var(--accent); opacity: 0.8; padding: 0 8px 2px; display: none;
    }

    /* ── Bottom toolbar ─────────────────────────────── */
    #bottom-bar {
      display: flex; align-items: center; gap: 5px;
      padding: 5px 8px 6px;
      flex-shrink: 0; font-family: var(--ui-font);
    }
    #bottom-bar .btn-wrap { position: relative; display: flex; }

    /* Model button in bottom bar */
    #model-btn-header {
      background: transparent;
      border: 1px solid var(--vscode-input-border);
      border-radius: var(--radius-sm);
      color: var(--vscode-descriptionForeground);
      font-family: var(--ui-font); font-size: 0.78em;
      padding: 2px 8px;
      cursor: pointer; white-space: nowrap;
      height: var(--toolbar-height);
      display: inline-flex; align-items: center;
      transition: border-color 0.15s, color 0.15s;
    }
    #model-btn-header:hover { color: var(--accent); border-color: var(--accent-border); }

    #model-menu {
      position: absolute; bottom: calc(100% + 4px); left: 0;
      background: var(--vscode-dropdown-background, var(--vscode-sideBar-background));
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-sideBarSectionHeader-border));
      border-radius: var(--radius-md);
      min-width: 220px; z-index: 200; overflow: hidden;
      max-height: 350px; overflow-y: auto;
      box-shadow: 0 -2px 16px rgba(0,0,0,0.4);
    }
    .model-option {
      padding: 6px 12px; font-size: 0.82em; font-family: var(--ui-font);
      color: var(--vscode-foreground); cursor: pointer; white-space: nowrap;
    }
    .model-option:hover { background: var(--accent-subtle); }
    .model-option.active { color: var(--accent); font-weight: 600; }
    .model-option.active::before { content: '✓ '; }
    .model-group-label {
      padding: 5px 12px 2px; font-size: 0.68em; font-family: var(--ui-font);
      color: var(--vscode-descriptionForeground); opacity: 0.7;
      text-transform: uppercase; letter-spacing: 0.06em;
    }
    .model-sep { border-top: 1px solid var(--vscode-sideBarSectionHeader-border); margin: 2px 0; }

    /* Toolbar buttons */
    .cmd-btn {
      background: transparent;
      border: 1px solid var(--vscode-input-border);
      border-radius: var(--radius-sm);
      color: var(--vscode-descriptionForeground);
      font-family: var(--ui-font); font-size: 0.9em; font-weight: 500; padding: 0;
      cursor: pointer; white-space: nowrap; flex-shrink: 0;
      display: inline-flex; align-items: center; justify-content: center;
      width: var(--toolbar-height); height: var(--toolbar-height);
      transition: border-color 0.15s, color 0.15s;
    }
    .cmd-btn:hover { color: var(--accent); border-color: var(--accent-border); }
    .cmd-btn .btn-icon { font-size: 1.1em; }
    #skills-btn.has-skills { color: var(--accent); border-color: var(--accent-border); }

    .bar-spacer { flex: 1; min-width: 0; }

    /* Overflow/slash menu */
    #overflow-menu {
      position: absolute; bottom: calc(100% + 4px); left: 0;
      background: var(--vscode-dropdown-background, var(--vscode-sideBar-background));
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-sideBarSectionHeader-border));
      border-radius: var(--radius-md); min-width: 260px; z-index: 100; overflow: hidden;
      padding: 4px 0;
      box-shadow: 0 -2px 16px rgba(0,0,0,0.4);
    }
    #overflow-menu .menu-group-label {
      padding: 6px 10px 2px; font-size: 0.66em; font-family: var(--ui-font);
      color: var(--accent); opacity: 0.8;
      text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;
    }
    #overflow-menu .menu-group-label.danger-label { color: var(--vscode-errorForeground); }
    #overflow-menu .menu-group-label:not(:first-child) {
      margin-top: 4px;
      border-top: 1px solid var(--vscode-dropdown-border, var(--vscode-sideBarSectionHeader-border));
      padding-top: 6px;
    }
    #overflow-menu .menu-item {
      padding: 5px 12px; font-size: 0.85em; font-family: var(--ui-font);
      color: var(--vscode-foreground); cursor: pointer;
    }
    #overflow-menu .menu-item .cmd-name {
      display: inline-block; min-width: 72px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.92em; color: var(--accent); opacity: 0.9;
    }
    #overflow-menu .menu-item:hover { background: var(--accent-subtle); }
    #overflow-menu .menu-item.danger { color: var(--vscode-errorForeground); }
    #overflow-menu .menu-item.danger:hover { background: rgba(244, 135, 113, 0.12); }

    /* Cmd arg popover */
    #cmd-arg-popover {
      position: absolute; bottom: calc(100% + 4px); left: 0;
      background: var(--vscode-dropdown-background, var(--vscode-sideBar-background));
      border: 1px solid var(--accent-border);
      border-radius: var(--radius-md); min-width: 260px; z-index: 110;
      padding: 8px 10px;
      box-shadow: 0 -2px 12px rgba(0,0,0,0.4);
    }
    #cmd-arg-popover .cmd-arg-label {
      font-size: 0.7em; font-family: var(--ui-font);
      color: var(--accent); text-transform: uppercase;
      letter-spacing: 0.05em; margin-bottom: 4px;
    }
    #cmd-arg-popover input {
      width: 100%; box-sizing: border-box;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 3px; padding: 4px 6px;
      font-family: var(--ui-font); font-size: 0.9em;
    }
    #cmd-arg-popover input:focus { outline: 1px solid var(--accent); outline-offset: -1px; }
    #cmd-arg-popover .cmd-arg-hint {
      font-size: 0.7em; opacity: 0.5;
      margin-top: 4px; font-family: var(--ui-font);
    }

    /* Skills menu */
    #skills-menu {
      position: absolute; bottom: calc(100% + 4px); left: 0;
      background: var(--vscode-dropdown-background, var(--vscode-sideBar-background));
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-sideBarSectionHeader-border));
      border-radius: var(--radius-md); min-width: 240px; max-width: 320px;
      max-height: 350px; overflow-y: auto; z-index: 100;
      box-shadow: 0 -2px 16px rgba(0,0,0,0.4);
    }
    .skill-group-label {
      padding: 4px 10px 2px; font-size: 0.68em; font-family: var(--ui-font);
      color: var(--vscode-descriptionForeground); opacity: 0.7;
      text-transform: uppercase; letter-spacing: 0.06em;
      position: sticky; top: 0;
      background: var(--vscode-dropdown-background, var(--vscode-sideBar-background));
    }
    .skill-option {
      padding: 3px 10px; font-size: 0.78em; font-family: var(--ui-font);
      color: var(--vscode-foreground); cursor: pointer; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis;
      display: flex; align-items: center; gap: 6px;
    }
    .skill-option:hover { background: var(--accent-subtle); }
    .skill-option.selected { color: var(--accent); font-weight: 600; }
    .skill-option.selected::before { content: '✓ '; flex-shrink: 0; }
    .skill-option .skill-desc { opacity: 0.4; font-size: 0.85em; overflow: hidden; text-overflow: ellipsis; }

    /* Todo overlay */
    #todo-overlay {
      font-family: var(--ui-font); font-size: 0.82em;
      margin: 0 8px 4px; padding: 6px 10px;
      background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.05));
      border: 1px solid var(--vscode-input-border);
      border-radius: var(--radius-lg);
      flex-shrink: 0; display: none;
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
    }
    #todo-overlay .todo-header {
      font-weight: 700; font-size: 0.78em;
      text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }
    #todo-overlay .todo-item {
      display: flex; align-items: flex-start; gap: 6px;
      padding: 2px 0;
    }
    #todo-overlay .todo-icon { flex-shrink: 0; width: 1.2em; text-align: center; }
    #todo-overlay .todo-icon.completed { color: #4ec9b0; }
    #todo-overlay .todo-icon.in_progress { color: var(--accent); }
    #todo-overlay .todo-icon.pending { opacity: 0.4; }
    #todo-overlay .todo-text { flex: 1; }
    #todo-overlay .todo-text.completed { text-decoration: line-through; opacity: 0.5; }
    #todo-overlay .todo-text.in_progress { color: var(--accent); font-weight: 500; }
    #todo-overlay .todo-summary { font-size: 0.8em; opacity: 0.5; margin-top: 3px; }

    #messages { overflow-x: hidden; }
    /* ── Thinking block ────────────────────────────── */
    .thinking-block {
      font-style: italic;
      color: var(--vscode-descriptionForeground);
      opacity: 0.85;
      padding: 6px 10px;
      border-left: 3px solid var(--accent);
      margin: 2px 0;
      background: var(--accent-subtle);
      border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
      font-family: var(--ui-font);
      font-size: 0.85em;
      line-height: 1.4;
      max-height: 400px;
      overflow-y: auto;
    }
    .thinking-block p { margin: 0.2em 0; }
    .thinking-block blockquote {
      margin: 0; padding: 0; border: none; opacity: 1;
      font-style: italic;
    }
    .thinking-collapsed {
      max-height: 2em;
      overflow: hidden;
      opacity: 0.5;
      cursor: pointer;
      padding: 4px 10px;
      border-left: 3px solid var(--accent);
      background: var(--accent-subtle);
      border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
      font-family: var(--ui-font);
      font-size: 0.8em;
      font-style: italic;
      color: var(--vscode-descriptionForeground);
      transition: max-height 0.3s, opacity 0.2s;
      user-select: none;
    }
    .thinking-collapsed:hover { opacity: 0.7; }
    .thinking-collapsed::after { content: ' (click to expand)'; font-size: 0.8em; opacity: 0.5; }

`;
