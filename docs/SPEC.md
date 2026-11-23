# mcp-lifeline: design spec

## Problem

A stdio MCP server is a child process. Its client (Claude Desktop, Claude Code, Cursor, Codex, ...) talks to it over stdin/stdout. The MCP spec has no cleanup hook beyond "close stdin". In practice clients crash, get SIGKILLed, reload windows, or launch servers through intermediaries (`npx`, `npm exec`, `sh -c`, `uvx`). Many of these paths leave the server running forever with PPID 1.

Public reports include Cursor (known issue: orphans on reload/restart), Claude Code (many issues: macOS, Windows, reconnect, scheduled tasks), Google Antigravity (1,706 orphaned processes using about 14 GB after 11 days), Amazon Q CLI and Codex. A long list of server repos have each shipped their own watchdog.

## Goals

1. A server author adds one call and the process reliably exits when its client is gone.
2. A user who can't change the server can get the same guarantee from config alone (wrapper CLI).
3. Existing leaks can be found and cleaned (`reap`).
4. Zero dependencies, no native code, ESM + CJS, Node ≥ 18 and Bun, Linux / macOS / Windows.
5. Never write to stdout. Never read stdin. Never keep the event loop alive by itself.

## Detection model

A shutdown is triggered by the first of:

| Trigger | Mechanism |
|---|---|
| `stdin-closed` | `end`/`close` on `process.stdin` (not on TTY). Passive listener only: no `resume()`, no `data` handler. |
| `stdout-broken` | `error` on `process.stdout` with `EPIPE` / `ERR_STREAM_DESTROYED` / `EOF`. |
| `signal` | SIGINT, SIGTERM, SIGHUP (POSIX) / SIGINT, SIGTERM, SIGBREAK (Windows). |
| `reparented` | POSIX: the live parent pid differs from the startup parent pid. Linux reads `/proc/self/stat` because Bun caches `process.ppid`. Skipped when the startup parent is ≤ 1 (Docker PID 1, tini). |
| `parent-exited` | Any watched ancestor fails `kill(pid, 0)`, is a zombie, or its start time changed (PID reuse). |
| `idle` | Optional: no `touch()` for `idleTimeoutMs`. |

### The ancestor chain

At startup we resolve, asynchronously:

```
self → parent → [launcher → launcher → ...] → client
```

We walk up from the parent. Each process is added to the watch list, and the walk continues only while the process is a **launcher**. The first non-launcher (the client) is added and the walk stops. It also stops at pid ≤ 1, Windows pid 4, `maxDepth`, or (Windows) when a stale `ParentProcessId` points at a process created later than its child.

This catches the most common real leak: client dies → `npm exec` gets reparented and keeps our stdin pipe open → no EOF, our own parent is still alive → a parent-only watchdog never fires.

**Launchers** (matched on the full command line, `node <script>` unwrapped):
`npx`, `pnpx`, `bunx`, `uvx`, `corepack`, `npm exec|x|run|start`, `pnpm dlx|exec|run|start`, `yarn dlx|exec|run|start`, `bun x|run`, `uv run`, `uv tool run`, `pipx run`, `sh|bash|zsh|dash|fish|ksh -c`, `cmd /c`, `powershell|pwsh -Command`, `env`, `nohup`, `timeout`, `setsid`, `tsx`, `ts-node`, and `mcp-lifeline` itself. Users can add more with `launchers: RegExp[]`.

### Liveness and identity

| Platform | Every tick (`intervalMs`) | Periodic identity check |
|---|---|---|
| Linux | `/proc/<pid>/stat`: exists, not `Z`, same `starttime` | (every tick, it's free) |
| macOS / BSD | `kill(pid, 0)` | `ps -o state=,lstart=` every ~15 s |
| Windows | `kill(pid, 0)` | CIM `CreationDate` every ~15 s |

## Shutdown sequence

1. Idempotent: the first trigger wins; all watchers are removed.
2. Log one line to stderr with the reason.
3. Arm a hard deadline (`gracePeriodMs`).
4. `await onShutdown(reason)` (errors logged, not thrown).
5. If `killChildren`: snapshot descendants, SIGTERM, then SIGKILL after 500 ms (Windows: `taskkill /T /F`). Bounded to 1.5 s.
6. `process.exit(exitCode)` unless `exit: false`.

## Wrapper CLI

`mcp-lifeline [--grace ms] [--idle ms] [--interval ms] [--quiet] -- cmd args...`

- Spawns the server with piped stdin/stdout (inherited stderr), in its own process group on POSIX (`detached`), via a shell on Windows (needed for `.cmd` shims).
- Forwards bytes both ways; any traffic counts as activity for `--idle`.
- On any trigger: forward the signal to the group, or end the server's stdin → wait `--grace` → SIGTERM the group → kill the tree.
- Exits with the server's exit code when the server exits on its own.

## `reap`

Lists processes that match `--match` (default `/mcp/i`), belong to the current user, and are orphaned (POSIX: PPID 1; Windows: the parent is missing or was created after the child). `--kill` kills each orphaned tree.

## Test matrix (real processes, no mocks)

| # | Scenario | Expected |
|---|---|---|
| 1 | Client closes stdin | exit 0, `stdin-closed` |
| 2 | SIGTERM | `onShutdown` runs, exit |
| 3 | Parent SIGKILLed, stdin held open by an unrelated process | exit within ~1 s (`reparented` / `parent-exited`) |
| 4 | Client SIGKILLed, `npx-cli.js` launcher survives, stdin held open | exit (`parent-exited` on the client) |
| 5 | Same as 4 with `watch: "parent"` | **still running** (control: proves 4 needs the chain) |
| 6 | Server spawned a child | child killed on shutdown |
| 7 | `idleTimeoutMs` | exit (`idle`) |
| 8 | `MCP_LIFELINE=off` | does nothing |
| 9 | Wrapper: JSON-RPC line echoes through | passthrough |
| 10 | Wrapper: server ignores EOF + SIGTERM and has a grandchild | both killed after grace |
| 11 | Wrapper: server exits 7 | wrapper exits 7 |
| 12 | Wrapper: missing command | non-zero exit |
| 13 | `reap` with no matches | lists nothing, kills nothing |
| 14 | `isLauncher` table | launchers vs real clients (Claude.app, Cursor Helper, `node build/index.js`, ...) |

CI runs the matrix on Ubuntu, macOS and Windows (scenarios 3–5 use `sh`, so they're POSIX-only), on Node 18/20/22/24 plus Bun.

## Non-goals

- Fixing clients. Clients should still kill their children properly; this is defence in depth.
- Daemons that are meant to outlive their launcher.
