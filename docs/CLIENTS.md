# Client configs

Copy-paste setups for wrapping a server with `mcp-lifeline` in each MCP client. The pattern is always the same: the command becomes `npx`, and the args become `-y mcp-lifeline --` followed by your original command and args.

The examples wrap the GitHub server. Swap in your own.

> If you maintain the server, the better fix is the one-line library call (see the [README](../README.md#for-server-authors-one-line)). Then nobody has to change their config.

Config file locations change between client versions. If a path below doesn't match yours, the client's own MCP docs have the current one; the JSON shape is what matters.

---

## Claude Desktop

`claude_desktop_config.json` (Settings → Developer → Edit Config)

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "mcp-lifeline", "--", "npx", "-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "…" }
    }
  }
}
```

Restart Claude Desktop afterwards.

## Claude Code

From a terminal. The first `--` ends `claude mcp add`'s own options, and the second ends mcp-lifeline's:

```bash
claude mcp add github -e GITHUB_PERSONAL_ACCESS_TOKEN=… -- npx -y mcp-lifeline -- npx -y @modelcontextprotocol/server-github
```

Or in a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "mcp-lifeline", "--", "npx", "-y", "@modelcontextprotocol/server-github"]
    }
  }
}
```

## Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project)

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "mcp-lifeline", "--", "npx", "-y", "@modelcontextprotocol/server-github"]
    }
  }
}
```

## VS Code (GitHub Copilot)

`.vscode/mcp.json`. Note the top-level key is `servers`, not `mcpServers`.

```json
{
  "servers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-lifeline", "--", "npx", "-y", "@modelcontextprotocol/server-github"]
    }
  }
}
```

## Windsurf

`~/.codeium/windsurf/mcp_config.json`

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "mcp-lifeline", "--", "npx", "-y", "@modelcontextprotocol/server-github"]
    }
  }
}
```

## OpenAI Codex CLI

`~/.codex/config.toml`

```toml
[mcp_servers.github]
command = "npx"
args = ["-y", "mcp-lifeline", "--", "npx", "-y", "@modelcontextprotocol/server-github"]
```

## Gemini CLI

`~/.gemini/settings.json`

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "mcp-lifeline", "--", "npx", "-y", "@modelcontextprotocol/server-github"]
    }
  }
}
```

---

## Non-Node servers

```jsonc
// Python via uvx
"args": ["-y", "mcp-lifeline", "--", "uvx", "mcp-server-fetch"]

// Python script
"args": ["-y", "mcp-lifeline", "--", "python", "/path/to/server.py"]

// Docker (keep -i, drop -t)
"args": ["-y", "mcp-lifeline", "--", "docker", "run", "-i", "--rm", "mcp/time"]

// A compiled binary
"args": ["-y", "mcp-lifeline", "--", "/usr/local/bin/my-mcp-server", "--stdio"]
```

## Tuning

```jsonc
// give a slow server 5s to shut down, and kill it after 30 min with no traffic
"args": ["-y", "mcp-lifeline", "--grace", "5000", "--idle", "1800000", "--", "npx", "-y", "some-server"]
```

## Faster startup

`npx -y mcp-lifeline` checks the registry on each launch. To skip that, install it once and call it directly:

```bash
npm i -g mcp-lifeline
```

```json
{ "command": "mcp-lifeline", "args": ["--", "npx", "-y", "@modelcontextprotocol/server-github"] }
```

On Windows, if a client can't find `mcp-lifeline`, use `"command": "cmd", "args": ["/c", "mcp-lifeline", "--", …]`.
