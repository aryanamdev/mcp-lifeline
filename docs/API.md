# API reference

```ts
import exitWhenOrphaned, {
  exitWhenOrphaned,
  describeReason,
  resolveAncestors,
  isLauncher,
  killTree,
  listProcesses,
  getDescendants,
  isAlive,
  type LifelineOptions,
  type Lifeline,
  type ShutdownReason,
  type ProcInfo,
} from "mcp-lifeline";
```

Works with ESM (`import`) and CommonJS (`require`). Ships its own TypeScript types. Zero runtime dependencies.

---

## `exitWhenOrphaned(options?)`

```ts
function exitWhenOrphaned(options?: LifelineOptions): Lifeline;
```

Starts watching for "the client that launched me is gone" and shuts the process down when that happens. Call it **once**, after your MCP transport is connected. Calling it again returns the same instance.

It never reads stdin, never writes stdout, and never keeps the event loop alive by itself (its timer is `unref`'d).

### Minimal

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { exitWhenOrphaned } from "mcp-lifeline";

const server = new McpServer({ name: "my-server", version: "1.0.0" });
await server.connect(new StdioServerTransport());

exitWhenOrphaned({ onShutdown: () => server.close() });
```

### CommonJS

```js
const { exitWhenOrphaned } = require("mcp-lifeline");

exitWhenOrphaned({
  onShutdown: async (reason) => {
    await db.end();
    await browser?.close();
  },
});
```

### Options

#### `onShutdown?: (reason: ShutdownReason) => void | Promise<void>`

Your cleanup: close the MCP server, flush logs, close DB pools, release lock files. It runs once. It can be async, but it is bounded by `gracePeriodMs`. If it throws, the error is logged and shutdown carries on.

Don't call `process.exit()` in here; mcp-lifeline exits for you (unless `exit: false`).

#### `gracePeriodMs?: number` (default `3000`)

Hard deadline for `onShutdown` plus child-process cleanup. When it passes, mcp-lifeline logs `cleanup did not finish within …ms` and exits anyway. An orphan that hangs in its cleanup is still an orphan.

#### `intervalMs?: number` (default `1000`)

How often ancestors are checked. Lower means faster detection and slightly more work. On Linux each check reads a few small files in `/proc`. On macOS and Windows it is a `kill(pid, 0)` per watched process.

#### `idleTimeoutMs?: number` (default `0`, off)

Exit after this long without a call to `lifeline.touch()`. Useful for servers that hold expensive resources and are cheap to restart. Call `touch()` on every request:

```ts
const lifeline = exitWhenOrphaned({ idleTimeoutMs: 30 * 60_000 });

server.tool("search", schema, async (args) => {
  lifeline.touch();
  return doSearch(args);
});
```

mcp-lifeline can't count traffic for you because it never reads stdin. (The CLI wrapper does count traffic, since it proxies the bytes.)

#### `watch?: "chain" | "parent"` (default `"chain"`)

- `"chain"` watches the direct parent, every **launcher** above it (`npx`, `npm exec`, `pnpm dlx`, `uvx`, `sh -c`, …), and the first real process above those, which is normally the MCP client.
- `"parent"` watches only the direct parent.

`"chain"` is what catches the most common real leak: the client dies, `npm exec` gets reparented and survives holding our stdin open, and our own parent never changes. See [SPEC.md](SPEC.md#the-ancestor-chain).

Use `"parent"` only if `"chain"` gives you a false positive (see [Troubleshooting](TROUBLESHOOTING.md#the-server-exits-right-away-or-at-random)).

#### `maxDepth?: number` (default `5`)

The most ancestors that will be watched in `"chain"` mode.

#### `launchers?: RegExp[]` (default `[]`)

Extra command-line patterns to treat as launchers, for a custom wrapper script that sits between the client and your server:

```ts
exitWhenOrphaned({ launchers: [/my-company-mcp-runner/] });
```

#### `watchStdin?: boolean` (default `true`)

Shut down when stdin ends. Ignored when stdin is a TTY, so running the server by hand in a terminal works. This only fires if *something* reads stdin. The MCP SDK's `StdioServerTransport` always does.

#### `watchStdout?: boolean` (default `true`)

Shut down when writing stdout fails with `EPIPE` / `ERR_STREAM_DESTROYED`, meaning the client stopped reading.

#### `signals?: NodeJS.Signals[]` (default `SIGINT`, `SIGTERM`, `SIGHUP`; Windows: `SIGINT`, `SIGTERM`, `SIGBREAK`)

Signals that trigger a graceful shutdown (with `onShutdown`). Pass `[]` if you already handle signals yourself.

#### `killChildren?: boolean` (default `true`)

On shutdown, kill every process this one spawned, and their children: headless browsers, language servers, Python subprocesses. SIGTERM first, SIGKILL 500 ms later (Windows: `taskkill /T /F`).

#### `exitCode?: number` (default `0`)

Exit code used for the shutdown.

#### `exit?: boolean` (default `true`)

Set `false` to run cleanup without calling `process.exit()`, for example in tests or if you have your own exit path.

#### `log?: false | ((message: string) => void)` (default: one line to stderr)

```ts
exitWhenOrphaned({ log: false });                         // silent
exitWhenOrphaned({ log: (m) => logger.info({ m }, "lifeline") });
```

Default output looks like:

```
[mcp-lifeline] ancestor process 41877 (/Applications/Claude.app/Contents/MacOS/Claude) exited — shutting down
```

Never route this to stdout: stdout is the JSON-RPC channel.

---

## `Lifeline`

The object returned by `exitWhenOrphaned()`.

| Member | |
|---|---|
| `touch(): void` | Mark activity; resets the idle timer. |
| `shutdown(detail?: string): Promise<void>` | Start a shutdown yourself (`reason.type === "manual"`). |
| `stop(): void` | Remove every listener and timer without exiting. |
| `watching: readonly ProcInfo[]` | The ancestors being watched. Starts as just the parent; the full chain is filled in asynchronously a few ms after start. |
| `shuttingDown: boolean` | `true` once shutdown has begun. |

---

## `ShutdownReason`

```ts
type ShutdownReason =
  | { type: "stdin-closed" }
  | { type: "stdout-broken"; code?: string }
  | { type: "signal"; signal: NodeJS.Signals }
  | { type: "parent-exited"; pid: number; command?: string }
  | { type: "reparented"; from: number; to: number }
  | { type: "idle"; idleMs: number }
  | { type: "manual"; detail?: string };
```

`describeReason(reason)` turns one into the human-readable sentence used in the log line.

```ts
exitWhenOrphaned({
  onShutdown(reason) {
    metrics.increment("mcp.shutdown", { reason: reason.type });
  },
});
```

---

## Helpers

These are the building blocks mcp-lifeline uses itself. They're exported because they're useful on their own, for example in an MCP *client* that wants to clean up its servers properly.

### `isLauncher(commandLine: string, extra?: RegExp[]): boolean`

```ts
isLauncher("npx -y @modelcontextprotocol/server-github"); // true
isLauncher("/bin/sh -c npx foo");                          // true
isLauncher("/Applications/Claude.app/Contents/MacOS/Claude"); // false
```

### `resolveAncestors(ppid: number, maxDepth?: number, extra?: RegExp[]): Promise<ProcInfo[]>`

The chain that `"chain"` mode would watch, starting from `ppid`.

### `killTree(pid: number, opts?: { graceMs?: number; includeRoot?: boolean }): Promise<void>`

Kill a process and all of its descendants: SIGTERM, wait `graceMs` (default 1000), then SIGKILL what's left. On Windows: `taskkill /T /F`. Descendants are snapshotted *before* signalling, so children that get reparented mid-kill aren't lost.

```ts
// In an MCP client: take a server down properly.
await killTree(serverProcess.pid);
```

### `getDescendants(pid: number): Promise<ProcInfo[]>`

All children, grandchildren, and so on, in breadth-first order.

### `listProcesses(): Promise<ProcInfo[]>`

Every visible process. Linux reads `/proc`, macOS uses `ps`, Windows uses PowerShell + CIM.

### `isAlive(pid: number): boolean`

`kill(pid, 0)`, treating `EPERM` (exists, but not ours) as alive.

### `ProcInfo`

```ts
interface ProcInfo {
  pid: number;
  ppid: number;
  start: string;    // opaque start-time token; same pid + different start = PID reuse
  command: string;  // full command line, best effort
  uid?: number;     // POSIX only
  zombie?: boolean; // exited but not yet reaped
}
```

---

## Environment variables

| Variable | Effect |
|---|---|
| `MCP_LIFELINE=off` (also `0`, `false`, `disabled`) | Disable entirely. An escape hatch for your users if they ever need it. |
| `MCP_LIFELINE_DEBUG=1` | Log the ancestor chain being watched at startup. |

```
$ MCP_LIFELINE_DEBUG=1 node build/index.js
[mcp-lifeline] watching 51022 (npm exec @acme/mcp) <- 50990 (/Applications/Claude.app/Contents/MacOS/Claude)
```

## Runtime support

| | Linux | macOS | Windows |
|---|---|---|---|
| Node 18 / 20 / 22 / 24 | ✅ CI | ✅ CI | ✅ CI |
| Bun | ✅ CI | should work, not in CI | should work, not in CI |
| Deno (npm: specifier) | untested | untested | untested |
