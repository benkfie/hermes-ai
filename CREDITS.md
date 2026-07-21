# Credits & Attribution

## Upstream Source

This extension is a fork of **hermes-vscode** (v3.0.0) by João Paulo Fernandes ([joaompfp](https://github.com/joaompfp)):
- Repository: https://github.com/joaompfp/hermes-vscode
- License: MIT
- Commit used as base: 0cb302c ("Update copyright holder in LICENSE file")

The original hermes-vscode is a VS Code extension implementing the ACP (Agent Client Protocol) client for the Hermes Agent.

## Open Source Dependencies

### Runtime Dependencies
- **dompurify** (v3.3.3) - XSS sanitization for webview content
  - License: MPL-2.0
  - https://github.com/cure53/DOMPurify

- **marked** (v17.0.5) - Markdown parser for rendering agent responses
  - License: MIT
  - https://github.com/markedjs/marked

### Development Dependencies
- **TypeScript** (v5.3.0) - Type-safe JavaScript
  - License: Apache-2.0
  - https://www.typescriptlang.org/

- **webpack** (v5.89.0) - Module bundler
  - License: MIT
  - https://webpack.js.org/

- **ts-loader** (v9.5.0) - TypeScript loader for webpack
  - License: MIT
  - https://github.com/TypeStrong/ts-loader

- **@vscode/vsce** (v2.22.0) - VS Code Extension packaging tool
  - License: MIT
  - https://github.com/microsoft/vscode-vsce

- **@types/node**, **@types/vscode**, **@types/dompurify** - Type definitions
  - License: MIT

## Inspiration & Borrowed Patterns

### Cline (saoudrizwan/cline)
Several UI patterns and architectural approaches were adapted from Cline (formerly Claude Dev):
- Diff view provider pattern (`VscodeDiffViewProvider.ts`)
- Rich permission approval UI
- Context menu commands (Add to Chat, Explain, Fix, Improve)
- Session management
- Smart workspace context gathering

Repository: https://github.com/saoudrizwan/cline
License: Apache-2.0

### VS Code ACP Extension (formulahendry/vscode-acp)
Reference implementation for ACP protocol handling in VS Code.

Repository: https://github.com/formulahendry/vscode-acp
License: MIT

## Hermes Agent

This extension communicates with the **Hermes Agent** (by Nous Research):
- Website: https://hermes-agent.nousresearch.com
- ACP Protocol: https://agentclientprotocol.com
- The extension is a UI client; the agent itself is a separate binary/runtime.

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
