# Hermes AI — VS Code Extension

**Hermes AI** is a VS Code extension that brings the [Hermes Agent](https://hermes-agent.nousresearch.com) into your editor. Chat, configure, manage MCP servers, and let the agent edit your code — all through the ACP protocol.

## Features

- **AI Chat** — Stream conversations with Hermes in a sidebar panel
- **Settings Panel** — 6-tab settings UI: General, Model, API Keys, MCP, Terminal, About
- **Diff Preview** — See file changes before applying them
- **Permission Control** — Rich approval UI for tool calls
- **Context Menu** — Right-click → Explain, Fix, Improve code with Hermes
- **Commit Generation** — Generate conventional commits from staged changes
- **MCP Management** — Add, remove, test MCP servers from settings
- **Keyboard Shortcuts** — Ctrl+` for chat, Ctrl+Shift+` for settings

## Installation

1. Install [Hermes Agent](https://hermes-agent.nousresearch.com) on your system
2. Install this extension from the VSIX file
3. Open the command palette (`Ctrl+Shift+P`) → **Hermes: Open Chat**

### Auto-detection

The extension auto-detects Hermes from:
- The configured `hermes.path` setting
- System PATH
- Known locations (`~/.local/bin/hermes`, etc.)

## Setup

Open the Hermes sidebar (click the Hermes icon in the activity bar), then click the **Settings** tab to configure:

- **General**: Binary path, auto-connect, debug logging
- **Model**: Provider, model, base URL, max turns
- **API Keys**: Add/remove API keys with masked display
- **MCP**: Add/remove/test MCP servers
- **Terminal**: Backend, working directory, timeout
- **About**: Version info, config paths, doctor command

## Usage

| Action | How |
|---|---|
| Open chat | Click Hermes icon → Chat tab, or `Ctrl+\`` |
| Open settings | Click Hermes icon → Settings tab, or `Ctrl+Shift+\`` |
| Add code to chat | Select code → right-click → **Hermes: Add to Chat** |
| Explain code | Select code → right-click → **Hermes: Explain Code** |
| Fix code | Select code → right-click → **Hermes: Fix Code** |
| Generate commit | Click Hermes button in SCM title bar |

## Development

### Build

```bash
npm install
npm run build    # production build (extension + chat webview + settings webview)
npm run dev      # development watch mode
```

### Package

```bash
npm run package  # creates hermes-ai-1.0.0.vsix
```

## Repository

- **GitHub**: <https://github.com/benkfie/hermes-ai>
- **Upstream**: <https://github.com/joaompfp/hermes-vscode> (v3.0.0 fork base)

## License

MIT
