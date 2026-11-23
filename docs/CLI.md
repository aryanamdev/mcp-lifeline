# CLI

```
mcp-lifeline [options] -- <command> [args...]   Wrap any stdio MCP server
mcp-lifeline reap [--kill] [--match <regex>]     Find (and kill) orphaned MCP servers
mcp-lifeline --help | --version
```

No install needed: `npx -y mcp-lifeline …`. For faster startup, install it globally (`npm i -g mcp-lifeline`) and use `mcp-lifeline` as the command.

---

## Wrap a server

Use the wrapper when you **can't change the server's code**: a third-party server, a Python server, a Docker image. Put `mcp-lifeline --` in front of the command your client already runs.

```jsonc
// before
{ "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }

// after
{ "command": "npx", "args": ["-y", "mcp-lifeline", "--", "npx", "-y", "@modelcontextprotocol/server-github"] }
```

It works the same with any language:

```jsonc
{ "command": "npx", "args": ["-y", "mcp-lifeline", "--", "uvx", "mcp-server-fetch"] }
{ "command": "npx", "args": ["-y", "mcp-lifeline", "--", "python", "-m", "my_server"] }
{ "command": "npx", "args": ["-y", "mcp-lifeline", "--", "docker", "run", "-i", "--rm", "mcp/time"] }
```

Copy-paste configs for each client are in [CLIENTS.md](CLIENTS.md).

### What the wrapper does

```
client ──stdin/stdout──▶ mcp-lifeline ──stdin/stdout──▶ server
                         (watches the client)            (own process group)
```

1. Starts the server with piped stdin/stdout. stderr is passed straight through, so server logs still reach the client. On macOS/Linux the server gets its own process group, so it and everything it spawns can be stopped together.
2. Copies bytes both ways unchanged. It doesn't parse JSON-RPC, so any protocol version works.
3. Watches the client the same way the library does: stdin EOF, EPIPE, signals, the parent/launcher/client chain.
4. When the client is gone:
   - **stdin closed / client died:** closes the server's stdin, the polite "we're done" signal. Well-behaved servers exit here.
   - **signal (Ctrl-C, SIGTERM):** forwards the signal to the server's process group.
   - If the server is still running after `--grace` ms: SIGTERM to the group, then SIGKILL anything left, including grandchildren.
5. If the server exits on its own, the wrapper exits with **the server's exit code**.

### Options

| Option | Default | |
|---|---|---|
| `--grace <ms>` | `2000` | How long the server gets to exit after stdin closes (or a signal is forwarded) before it's killed. |
| `--idle <ms>` | off | Kill the server after this long with **no traffic in either direction**. |
| `--interval <ms>` | `1000` | How often to check that the client is alive. |
| `--quiet` | | No `[mcp-lifeline wrapper]` lines on stderr. |

Options go **before** `--`. Everything after `--` is the server command, passed through untouched.

### Exit codes

| Code | Meaning |
|---|---|
| server's own code | The server exited by itself. |
| `0` | mcp-lifeline shut the server down because the client was gone. |
| `127` | The command couldn't be started (not found, not executable). |
| `2` | Bad mcp-lifeline options. |
| `128 + n` | The server was killed by signal *n*. |

### Logs

All logs go to stderr with a prefix, so the client's MCP log panel shows them:

```
[mcp-lifeline wrapper] stdin closed (client disconnected) — shutting down
[mcp-lifeline wrapper] server did not exit within 2000ms — killing it (stdin closed (client disconnected))
```

### Windows notes

- The server is started through a shell (needed for `npx.cmd` and other `.cmd` shims). Arguments containing spaces or shell characters are quoted for you.
- Windows has no process groups or graceful SIGTERM for console apps, so the kill step is `taskkill /T /F` on the server's tree.

---

## `reap`: clean up what's already leaked

```bash
npx mcp-lifeline reap                              # list, kill nothing
npx mcp-lifeline reap --kill                       # kill them (and their children)
npx mcp-lifeline reap --match "chroma|context7"    # custom pattern
```

```
Found 3 orphaned processes:

    PID  COMMAND
  48213  node /Users/me/.npm/_npx/1a2b/node_modules/.bin/mongodb-mcp-server
  48377  node /Users/me/.npm/_npx/1a2b/node_modules/.bin/mongodb-mcp-server
  51002  npm exec @modelcontextprotocol/server-github

Run again with --kill to terminate them.
```

A process is listed only if **all** of these are true:

- its command line matches `--match` (default `mcp`, case-insensitive);
- it belongs to **you** (same user id; on Windows, any user you can see);
- it's orphaned:
  - macOS/Linux: its parent pid is `1`;
  - Windows: its parent no longer exists, or the parent pid now belongs to a newer process.

`reap` without `--kill` never changes anything. With `--kill`, each process found is killed together with its children.

**Caveats**

- A long-running MCP server you started yourself on purpose with `nohup` or `&` also has parent pid 1 and matches. Check the list before adding `--kill`.
- On Linux with a user-level subreaper (some `systemd --user` setups), orphans are reparented to the subreaper rather than pid 1 and won't be listed.
- To run it regularly, use cron or launchd: `*/30 * * * * npx -y mcp-lifeline reap --kill`.
