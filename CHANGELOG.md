# Changelog

## 0.1.1

Docs-only release.

- New docs: API reference, CLI guide with exit codes, copy-paste configs for Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, Codex and Gemini CLI, and a troubleshooting/FAQ page.
- README: "How it works" diagram, options table, FAQ, links that work on npm.
- CONTRIBUTING, SECURITY and bug-report template.
- CI: Node 18 and Windows runs fixed (test-harness only; no library changes).

## 0.1.0

First release.

- `exitWhenOrphaned()`: exits on stdin EOF, stdout EPIPE, signals, parent death, reparenting, idle timeout.
- Ancestor-chain watching through launchers (`npx`, `npm exec`, `pnpm dlx`, `uvx`, `sh -c`, ...).
- PID-reuse and zombie-aware liveness checks; Bun-safe parent detection on Linux.
- Kills the server's own child processes on shutdown.
- `mcp-lifeline -- <cmd>` wrapper for servers you don't control.
- `mcp-lifeline reap` to list and kill already-orphaned MCP servers.
