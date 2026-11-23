# mcp-lifeline

**Stop stdio MCP servers from outliving the client that started them.**

[![npm](https://img.shields.io/npm/v/mcp-lifeline)](https://www.npmjs.com/package/mcp-lifeline)
[![CI](https://github.com/aryanamdev/mcp-lifeline/actions/workflows/ci.yml/badge.svg)](https://github.com/aryanamdev/mcp-lifeline/actions/workflows/ci.yml)
![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

When Claude Desktop, Claude Code, Cursor, Codex, Gemini CLI or any other MCP client crashes, reloads, or just forgets to clean up, the stdio MCP servers it launched often keep running. Every new session starts another set. A few days later you have hundreds of orphaned `node` processes and gigabytes of RAM gone.

```
$ ps -eo pid,ppid,rss,command | grep mcp
 48213     1  64M node .../mongodb-mcp-server
 48377     1  61M node .../mongodb-mcp-server
 51002     1  58M node .../server-github
 ... (1,700 more)
```

Every MCP server author ends up hand-writing the same watchdog, and most versions miss a case (see [what it handles](#what-it-handles)). `mcp-lifeline` is that watchdog, done once, tested against real process trees.

## For server authors: one line

```bash
npm i mcp-lifeline
```

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { exitWhenOrphaned } from "mcp-lifeline";

const server = new McpServer({ name: "my-server", version: "1.0.0" });
// ...register tools...
await server.connect(new StdioServerTransport());

exitWhenOrphaned({ onShutdown: () => server.close() });
```

That's it. When the client is gone, your `onShutdown` runs (bounded by a timeout), any child processes you spawned are killed, and the process exits. One line goes to **stderr**, never stdout, which belongs to the protocol:

```
[mcp-lifeline] ancestor process 41877 (/Applications/Claude.app/Contents/MacOS/Claude) exited — shutting down
```

Works with ESM and CommonJS, on Node 18+ and Bun, on Linux, macOS and Windows. Zero dependencies.

## For everyone else: wrap any server

You don't control the server's code? Put `mcp-lifeline` in front of it in your client config:

```jsonc
// claude_desktop_config.json, .cursor/mcp.json, .mcp.json, ...
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "mcp-lifeline", "--", "npx", "-y", "@modelcontextprotocol/server-github"]
    }
  }
}
```

The wrapper passes traffic through untouched. When the client goes away it closes the server's stdin (the polite signal), waits `--grace` ms, then kills the server **and everything it spawned**, even servers that ignore EOF and SIGTERM.

```
mcp-lifeline [options] -- <command> [args...]

  --grace <ms>      Time the server gets to exit after stdin closes (default 2000)
  --idle <ms>       Kill it after this long with no traffic either way (default off)
  --interval <ms>   How often to check the client is alive (default 1000)
  --quiet           No logging
```

## Clean up what's already leaked

```bash
npx mcp-lifeline reap          # list orphaned MCP processes (yours only)
npx mcp-lifeline reap --kill   # kill them and their children
npx mcp-lifeline reap --match "chroma|context7" --kill
```

## What it handles

| Situation | Typical hand-rolled fix | mcp-lifeline |
|---|---|---|
| Client closes the pipe (stdin EOF) | ✅ | ✅ |
| Client stops reading, writes fail with `EPIPE` | ❌ | ✅ |
| `SIGINT` / `SIGTERM` / `SIGHUP` (Windows: `SIGBREAK`) | sometimes | ✅ runs your cleanup first |
| Parent killed with `SIGKILL` while something else keeps stdin open | sometimes | ✅ |
| **Client dies but `npx` / `npm exec` / `pnpm dlx` / `uvx` / `sh -c` in between survives** (the most common real leak) | ❌ only checks its own parent | ✅ walks up through launchers and watches the client itself |
| Bun: `process.ppid` is cached and never changes | ❌ | ✅ reads the live parent from `/proc` |
| Killed ancestor that hasn't been reaped yet (zombie still passes `kill(pid, 0)`) | ❌ | ✅ |
| PID reuse: the parent's PID now belongs to an unrelated process | ❌ | ✅ compares process start times |
| Windows: no reparenting, EOF not always delivered | ❌ | ✅ |
| `onShutdown` hangs | ❌ the orphan hangs too | ✅ hard deadline (`gracePeriodMs`) |
| Server spawned its own children (browsers, LSPs, Python) | ❌ they leak | ✅ whole subtree killed |
| Running inside Docker as PID 1, or under `tini` (parent is legitimately PID 1) | ❌ often exits immediately | ✅ |
| Log says why it exited | rarely | ✅ |

The test suite reproduces these with real processes, not mocks: it SIGKILLs parents and fake clients while a separate process holds stdin open, and checks the server is gone. It also includes a control test that shows a parent-only watcher **does** leak in the `npx` case.

## API

```ts
exitWhenOrphaned(options?: LifelineOptions): Lifeline
```

| Option | Default | |
|---|---|---|
| `onShutdown(reason)` | none | Your cleanup. May be async. |
| `gracePeriodMs` | `3000` | Hard deadline for `onShutdown` + child cleanup. |
| `intervalMs` | `1000` | How often ancestors are checked. The timer is `unref`'d. |
| `idleTimeoutMs` | `0` (off) | Exit after this long without `lifeline.touch()`. |
| `watch` | `"chain"` | `"chain"`: parent + launchers + the client. `"parent"`: only the direct parent. |
| `maxDepth` | `5` | Max ancestors watched. |
| `launchers` | `[]` | Extra `RegExp`s for command lines to treat as launchers. |
| `watchStdin` | `true` | Exit on stdin EOF (ignored on a TTY). |
| `watchStdout` | `true` | Exit on `EPIPE` writing stdout. |
| `signals` | `SIGINT SIGTERM SIGHUP` | `[]` to leave signal handling to you. |
| `killChildren` | `true` | Kill our descendant processes on shutdown. |
| `exitCode` | `0` | |
| `exit` | `true` | Set `false` to skip `process.exit` and exit yourself. |
| `log` | stderr | `false`, or `(msg) => void`. |

The returned `Lifeline` has `touch()`, `shutdown(detail?)`, `stop()`, `watching` (the ancestors being watched) and `shuttingDown`.

`reason.type` is one of `stdin-closed`, `stdout-broken`, `signal`, `parent-exited`, `reparented`, `idle`, `manual`.

Also exported: `isLauncher(commandLine)`, `killTree(pid)`, `listProcesses()`, `getDescendants(pid)`, `isAlive(pid)`.

### Environment variables

- `MCP_LIFELINE=off` disables it (escape hatch for users).
- `MCP_LIFELINE_DEBUG=1` logs the ancestor chain being watched.

### Notes

- **stdin EOF needs someone reading stdin.** The MCP SDK's `StdioServerTransport` always does. mcp-lifeline never reads stdin itself, so it can't steal protocol bytes. Parent death is detected either way.
- **Cost:** on Linux each check reads a few files in `/proc`. On macOS and Windows liveness is a `kill(pid, 0)` per tick, and a `ps` / PowerShell PID-reuse check runs about every 15 s.
- If your process is *meant* to outlive its parent (a daemon), don't use this.

## How it works

See [docs/SPEC.md](docs/SPEC.md) for the detection model, the launcher list, and the edge-case test matrix.

## License

MIT
