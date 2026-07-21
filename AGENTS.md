# Agent Rules for hermes-ai

## Task Priorities
1. **Settings UI** — Phase 1-2: Config manager backend + settings webview (7 tabs)
2. **Permission and Diff** — Phase 3: Rich permission approval + diff viewing
3. **Smart Context** — Phase 4: Context menu commands + workspace context
4. **Installer** — Phase 5: Hermes auto-installer
5. **Chat Polish** — Phase 6: Model switcher, context bar, etc.
6. **MCP UI** — Phase 7: MCP server management
7. **Polish** — Phase 8: Testing, docs, packaging

## Build Commands
- Build: npm run build (webpack --mode production)
- Dev: npm run dev (webpack --mode development --watch)
- Package: npm run package (vsce package)
- Test: (manual for now, no test framework)

## Key Architecture
- ACP protocol via src/acpClient.ts + src/protocol.ts
- Dual webview: chat + settings
- Config via CLI: hermes config set, hermes mcp add, etc.
- Borrow UI patterns from Cline, adapt to Hermes ACP

## Critical Rules
- NEVER delete files — move to archive/ or pending_delete/
- Git commit every logical change
- Always verify with actual build/test run
