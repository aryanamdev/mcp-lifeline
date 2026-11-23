# mcp-lifeline

**Stop stdio MCP servers from outliving the client that started them.**

[![npm](https://img.shields.io/npm/v/mcp-lifeline)](https://www.npmjs.com/package/mcp-lifeline)
[![CI](https://github.com/aryanamdev/mcp-lifeline/actions/workflows/ci.yml/badge.svg)](https://github.com/aryanamdev/mcp-lifeline/actions/workflows/ci.yml)
![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![node](https://img.shields.io/node/v/mcp-lifeline)
![license](https://img.shields.io/npm/l/mcp-lifeline)

One line for MCP server authors. A drop-in config wrapper for everyone else. A cleanup command for what has already leaked.

```ts
exitWhenOrphaned({ onShutdown: () => server.close() });
```

- [The problem](#the-problem)
- [For server authors: one line](#for-server-authors-one-line)
- [For everyone else: wrap any server](#for-everyone-else-wrap-any-server)
- [Clean up what has already leaked](#clean-up-what-has-already-leaked)
- [What it handles](#what-it-handles)
- [How it works](#how-it-works)
- [Options at a glance](#options-at-a-glance)
- [FAQ](#faq)
- Docs: [API](https://github.com/aryanamdev/mcp-lifeline/blob/main/docs/API.md) · [CLI](https://github.com/aryanamdev/mcp-lifeline/blob/main/docs/CLI.md) · [Client configs](https://github.com/aryanamdev/mcp-lifeline/blob/main/docs/CLIENTS.md) · [Troubleshooting](https://github.com/aryanamdev/mcp-lifeline/blob/main/docs/TROUBLESHOOTING.md) · [Design spec](https://github.com/aryanamdev/mcp-lifeline/blob/main/docs/SPEC.md)

## The problem

MCP clients (Claude Desktop, Claude Code, Cursor, Codex, Gemini CLI, VS Code, …) start local MCP servers as child processes and talk to them over stdin/stdout. When a client crashes, reloads a window, gets force-quit, or just forgets to clean up, those servers often **keep running**. Each new session starts a fresh set. A few days later:

```
$ ps -eo pid,ppid,rss,command | grep mcp
 48213     1  64M node .../mongodb-mcp-server
 48377     1  61M node .../mongodb-mcp-server
 51002     1  58M npm exec @modelcontextprotocol/server-github
 ... (hundreds more)
```

This has been reported against nearly every major client, and the MCP spec has no cleanup hook beyond "close stdin". So each server author ends up hand-writing a watchdog, and most of those miss the cases that actually leak (see [What it handles](#what-it-handles)).

`mcp-lifeline` is that watchdog, written once and tested against real process trees on Linux, macOS and Windows.

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

When the client is gone:

1. your `onShutdown` runs (async is fine, but it gets at most 3 s by default);
2. any child processes your server started are killed;
3. the process exits.

You get one line on **stderr**. stdout is never touched, because it carries the protocol.

```
[mcp-lifeline] ancestor process 41877 (/Applications/Claude.app/Contents/MacOS/Claude) exited — shutting down
```

Also works with CommonJS (`const { exitWhenOrphaned } = require("mcp-lifeline")`), Node 18+, Bun, Linux, macOS and Windows. Zero dependencies, 16 kB.

More examples (custom cleanup, idle timeouts, logging, metrics): [docs/API.md](https://github.com/aryanamdev/mcp-lifeline/blob/main/docs/API.md).

## For everyone else: wrap any server

If you can't change a server's code (third-party, Python, Docker), put `mcp-lifeline --` in front of it in your client config:

```jsonc
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "mcp-lifeline", "--", "npx", "-y", "@modelcontextprotocol/server-github"]
    }
  }
}
```

The wrapper passes traffic through byte for byte. When the client goes away it closes the server's stdin (the polite signal) and waits `--grace` ms. If the server is still running, it kills the server **and everything the server spawned**, even servers that ignore EOF and SIGTERM.

Works with any language: `-- uvx mcp-server-fetch`, `-- python server.py`, `-- docker run -i --rm mcp/time`.

Configs for Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, Codex and Gemini CLI: [docs/CLIENTS.md](https://github.com/aryanamdev/mcp-lifeline/blob/main/docs/CLIENTS.md). All flags and exit codes: [docs/CLI.md](https://github.com/aryanamdev/mcp-lifeline/blob/main/docs/CLI.md).

## Clean up what has already leaked

```bash
npx mcp-lifeline reap          # list orphaned MCP processes that belong to you
npx mcp-lifeline reap --kill   # kill them and their children
npx mcp-lifeline reap --match "chroma|context7" --kill
```

`reap` without `--kill` only lists. Nothing is changed.

## What it handles

| Situation | Typical hand-rolled fix | mcp-lifeline |
|---|---|---|
| Client closes the pipe (stdin EOF) | ✅ | ✅ |
| Client stops reading; writes fail with `EPIPE` | ❌ | ✅ |
| `SIGINT` / `SIGTERM` / `SIGHUP` (Windows: `SIGBREAK`) | sometimes | ✅ runs your cleanup first |
| Parent killed with `SIGKILL` while something else keeps stdin open | sometimes | ✅ |
| **Client dies but `npx` / `npm exec` / `pnpm dlx` / `uvx` / `sh -c` between it and the server survives.** This is the most common real leak. | ❌ only checks its own parent | ✅ walks up through launchers and watches the client itself |
| Bun: `process.ppid` is cached and never changes | ❌ | ✅ reads the live parent from `/proc` |
| Killed ancestor not reaped yet (a zombie still passes `kill(pid, 0)`) | ❌ | ✅ |
| PID reuse: the parent's pid now belongs to an unrelated process | ❌ | ✅ compares process start times |
| Windows: no reparenting, EOF not always delivered | ❌ | ✅ |
| `onShutdown` hangs | ❌ the orphan hangs too | ✅ hard deadline |
| Server spawned children (browsers, LSPs, Python) | ❌ they leak | ✅ whole subtree killed |
| Running in Docker as PID 1 or under `tini` (parent is legitimately pid 1) | ❌ often exits immediately | ✅ |
| Log says *why* it exited | rarely | ✅ |

The test suite reproduces these with real processes, not mocks. It SIGKILLs parents and fake clients while an unrelated process holds stdin open, then checks the server is gone. It also includes a **control test showing that a parent-only watcher leaks** in the `npx` case. CI runs it on Linux, macOS and Windows × Node 18/20/22/24, plus Bun.

## How it works

```
 MCP client (Claude, Cursor, …)          ◀── watched: the real client
   └─ sh -c "npx -y my-server"           ◀── watched: launcher
       └─ npm exec my-server             ◀── watched: launcher
           └─ node my-server             ◀── you: exitWhenOrphaned()
```

At startup mcp-lifeline walks up the process tree from your parent. It watches every **launcher** it passes through and the first real process above them, which is the client. Then, every second:

- is my live parent pid still the one I started with? (no → reparented → exit)
- is every watched ancestor alive, not a zombie, and still the *same* process (same start time)? (no → exit)

On top of that it listens for stdin EOF, stdout EPIPE and termination signals. The first trigger wins. Your cleanup runs under a deadline, children are killed, and the process exits.

Full detection model, launcher list and test matrix: [docs/SPEC.md](https://github.com/aryanamdev/mcp-lifeline/blob/main/docs/SPEC.md).

## Options at a glance

| Option | Default | |
|---|---|---|
| `onShutdown(reason)` | none | Your cleanup. May be async. |
| `gracePeriodMs` | `3000` | Hard deadline for cleanup. |
| `intervalMs` | `1000` | How often ancestors are checked. |
| `idleTimeoutMs` | `0` (off) | Exit after this long without `lifeline.touch()`. |
| `watch` | `"chain"` | `"chain"` = parent + launchers + client; `"parent"` = parent only. |
| `launchers` | `[]` | Extra `RegExp`s for custom wrapper scripts. |
| `killChildren` | `true` | Kill your descendants on shutdown. |
| `signals` | `SIGINT SIGTERM SIGHUP` | `[]` to handle signals yourself. |
| `log` | stderr | `false`, or `(msg) => void`. |

Plus `maxDepth`, `watchStdin`, `watchStdout`, `exitCode` and `exit`, and the `touch()` / `shutdown()` / `stop()` handle. See [docs/API.md](https://github.com/aryanamdev/mcp-lifeline/blob/main/docs/API.md).

| Env var | |
|---|---|
| `MCP_LIFELINE=off` | Disable (escape hatch for users). |
| `MCP_LIFELINE_DEBUG=1` | Log the ancestor chain being watched. |

## FAQ

**Will it kill my server when it shouldn't?** It only acts when the stdin pipe closes, stdout breaks, a termination signal arrives, or a watched process exits. If a custom wrapper script starts your server and then exits, use `watch: "parent"` or make the script `exec` the server. See [Troubleshooting](https://github.com/aryanamdev/mcp-lifeline/blob/main/docs/TROUBLESHOOTING.md).

**Does it change the protocol or stdout?** No. The library never touches stdout. The wrapper copies bytes unchanged.

**Overhead?** On Linux, a few tiny `/proc` reads per second. On macOS/Windows, a `kill(pid, 0)` per second, plus a background PID-reuse check every ~15 s.

**Shouldn't clients fix this?** Yes, and they should. This is defence in depth for when they crash, get SIGKILLed, or have bugs.

**Python / Go / Rust servers?** Use the [CLI wrapper](https://github.com/aryanamdev/mcp-lifeline/blob/main/docs/CLI.md). It works with any stdio server.

**Daemons?** If your process is *meant* to outlive its parent, don't use this.

## Contributing

Bug reports with `MCP_LIFELINE_DEBUG=1` output are very welcome, especially from Windows and from clients not listed above. See [CONTRIBUTING.md](https://github.com/aryanamdev/mcp-lifeline/blob/main/CONTRIBUTING.md).

## License

MIT © Aryan Namdev
