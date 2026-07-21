# Hermes AI — VS Code / Antigravity IDE Extension

**Hermes AI** is a VS Code-family extension that brings the [Hermes Agent](https://hermes-agent.nousresearch.com) into your editor. Chat, configure, manage MCP servers, and let the agent edit your code — all through the **Agent Client Protocol (ACP)**.

> Works in Visual Studio Code and Antigravity IDE (a VS Code fork).

## Features

- **AI Chat** — Stream conversations with Hermes in a sidebar panel
- **Multi-Model Selector** — Pick any model from your Hermes config; includes a search box
- **Model Visibility** — Toggle which models appear in the chat selector (searchable list, changes apply instantly to the dropdown)
- **Settings Panel** — 6-tab settings UI: General, Model, API Keys, MCP, Terminal, About
- **Diff Preview** — See file changes before applying them
- **Permission Control** — Rich approval UI for tool calls
- **Context Menu** — Right-click → Explain, Fix, Improve code with Hermes
- **Terminal Output** — Send terminal output straight into the chat
- **Commit Generation** — Generate conventional commits from staged changes
- **MCP Management** — Add, remove, test MCP servers from settings

## Supported Models

This extension exposes the models configured in your Hermes Agent. The default
configuration is built around the following models (with thanks to their creators):

- **Tencent Hunyuan `hy3`** — Default reasoning/agentic model for this project.
- **DeepSeek `deepseek-v4-flash`** — Fast fallback model via OpenRouter.
- **Xiaomi `Mimi v2.5`** — Additional model available through Hermes.

Models are read live from `~/.hermes/models_dev_cache.json`, so any provider/model
you add in Hermes (OpenRouter, local LM Studio, etc.) shows up automatically in the
chat selector. Use the **Model Visibility** page to hide the ones you don't use.

## Installation

1. Install [Hermes Agent](https://hermes-agent.nousresearch.com) on your system.
2. Install this extension from the VSIX file (`hermes-ai-<version>.vsix`):
   - VS Code: Extensions view -> `...` -> **Install from VSIX...**
   - Antigravity IDE: `antigravity-ide --install-extension hermes-ai-<version>.vsix`
     (or use the bundled `dev-install.bat` after a build).
3. Open the command palette (`Ctrl+Shift+P`) -> **Hermes: Open Chat**.

### Auto-detection

The extension auto-detects Hermes from:

- The configured `hermes-ai.path` setting
- System PATH
- Known locations (`~/.local/bin/hermes`, etc.)

## Setup

Open the Hermes sidebar (click the Hermes icon in the activity bar), then click the
**Settings** tab to configure:

- **General**: Binary path, auto-connect, debug logging
- **Model**: Provider, model, base URL, max turns, and **Model Visibility**
- **API Keys**: Add/remove API keys with masked display
- **MCP**: Add/remove/test MCP servers
- **Terminal**: Backend, working directory, timeout
- **About**: Version info, config paths, doctor command

> **Model Visibility** is applied immediately. After saving, switch to the chat
> panel and open the model selector — the dropdown only lists the models you kept
> visible. The chat selector also has its own search box.

## Usage

| Action | How |
|---|---|
| Open chat | Click Hermes icon -> Chat tab, or `Ctrl+`` |
| Open settings | Click Hermes icon -> Settings tab, or `Ctrl+Shift+`` |
| Add code to chat | Select code -> right-click -> **Hermes: Add to Chat** |
| Explain code | Select code -> right-click -> **Hermes: Explain Code** |
| Fix code | Select code -> right-click -> **Hermes: Fix Code** |
| Improve code | Select code -> right-click -> **Hermes: Improve Code** |
| Add terminal output | Terminal -> right-click -> **Hermes: Add Terminal Output to Chat** |
| Generate commit | Click Hermes button in SCM title bar |

### Commands

- `hermes-ai.openChat` — Hermes: Open Chat
- `hermes-ai.newSession` — Hermes: New Session
- `hermes-ai.openSettings` — Hermes: Open Settings
- `hermes-ai.addToChat` — Hermes: Add to Chat
- `hermes-ai.explainCode` — Hermes: Explain Code
- `hermes-ai.fixCode` — Hermes: Fix Code
- `hermes-ai.improveCode` — Hermes: Improve Code
- `hermes-ai.addTerminalOutput` — Hermes: Add Terminal Output to Chat
- `hermes-ai.generateCommitMsg` — Hermes: Generate Commit Message

## Development

### Build

```bash
npm install
npm run build    # production build (extension + chat webview + settings webview)
npm run dev      # development watch mode
```

### Package

```bash
npm run package  # creates hermes-ai-<version>.vsix (version from package.json)
```

### Install into Antigravity IDE

```bash
# After building + packaging:
"antigravity-ide" \
  --install-extension hermes-ai-1.0.2.vsix
```

(On Windows you can also run the bundled `dev-install.bat`, which builds, packages,
and installs in one step. Then **Reload Window** in the editor.)

## Repository

- **GitHub**: <https://github.com/benkfie/hermes-ai>
- **Upstream**: <https://github.com/joaompfp/hermes-vscode> (v3.0.0 fork base)

## Credits

- Built on the [hermes-vscode](https://github.com/joaompfp/hermes-vscode) ACP client
  by joaompfp, layered on the [Agent Client Protocol](https://agentclientprotocol.com).
- Models powered by **Tencent Hunyuan (`hy3`)**, **DeepSeek (`deepseek-v4-flash`)**,
  and **Xiaomi (`Mimi v2.5`)**, accessed through the Hermes Agent.

## License

MIT
