# Troubleshooting & FAQ

Start with `MCP_LIFELINE_DEBUG=1`. It logs which processes are being watched:

```
[mcp-lifeline] watching 51022 (npm exec @acme/mcp) <- 50990 (/Applications/Claude.app/Contents/MacOS/Claude)
```

Every shutdown also logs **why** it happened, in one line on stderr. Your client's MCP log panel shows it (Claude Desktop: `~/Library/Logs/Claude/mcp-server-*.log`).

---

## The server exits right away, or at random

Look at the reason in the log line.

**`ancestor process … exited`**: something in the watched chain really did exit. The usual cause is a launcher that **starts your server and then exits itself** (a "fire and forget" wrapper script). mcp-lifeline sees the ancestor die and assumes the client is gone. Fixes:

- make the wrapper `exec` the server instead of spawning it (`exec node server.js` in shell scripts), or
- use `watch: "parent"`, or
- if the wrapper is named something unusual, it may have been treated as the *client*. Add it to `launchers: [/my-wrapper/]` so the chain walks through it.

**`parent process … went away (reparented …)`**: same idea, for the direct parent.

**`stdin closed`**: the client really closed the pipe. That isn't mcp-lifeline's doing.

**`idle for …s`**: you set `idleTimeoutMs` / `--idle` and nothing called `touch()` (or there was no traffic through the wrapper).

As an emergency switch, `MCP_LIFELINE=off` disables everything without a code change.

## The server still doesn't exit

1. **Is it actually running mcp-lifeline?** Check stderr for `[mcp-lifeline]` lines with `MCP_LIFELINE_DEBUG=1`.
2. **Did `exitWhenOrphaned()` run?** It has to be called after the transport connects. If startup throws first, it never runs.
3. **Does anything read stdin?** Stdin EOF can only be detected if someone reads stdin. The MCP SDK transport does. A custom transport might not. Parent-death detection works either way.
4. **Is it the *client* that's still alive?** If the client process is alive (just idle or hidden), the server is correctly not an orphan. Use `idleTimeoutMs` if you want idle servers gone too.
5. **Is the process a zombie?** `ps` showing `Z` / `<defunct>` means it has already exited and is waiting for its parent to reap it. It uses no memory or CPU. The init process cleans it up.

## `reap` lists a server I want to keep

`reap` lists processes whose parent is pid 1, which includes anything you deliberately started with `nohup` / `&` / `setsid`. Narrow it with `--match`, and always run it without `--kill` first.

## Does it work with Docker?

- **Server inside a container:** if the server is PID 1 (or a child of `tini` / `dumb-init`), the "parent is pid 1" check is skipped automatically, so it doesn't exit at startup. stdin EOF still works, and `docker run -i` closes it when the client goes away.
- **Wrapping `docker run`** on the host with the CLI: this works. Note that killing the `docker` CLI process doesn't always stop the container; use `--rm` and keep `-i` so stdin EOF reaches the container.

## Does it work with Bun?

Yes. Bun caches `process.ppid` at startup (Node updates it live), which breaks most hand-written watchdogs. On Linux mcp-lifeline reads the real parent from `/proc`. On macOS it relies on watching the ancestors' liveness, which doesn't depend on `ppid`.

## What does it cost?

- **Linux:** each check (every 1 s) reads two or three tiny files in `/proc` per watched ancestor. Effectively free.
- **macOS / Windows:** a `kill(pid, 0)` system call per ancestor per check, plus a `ps` / PowerShell call about every 15 s to detect PID reuse. PowerShell takes about half a second to start; it runs in the background and doesn't block your server.
- Memory: a few closures and a timer.

## Will it kill my child processes unexpectedly?

Only during shutdown, and only processes your server spawned (descendants of its pid). Set `killChildren: false` to keep them.

## Does it change stdout or the MCP protocol?

No. The library never touches stdout. The wrapper copies bytes unchanged and doesn't parse JSON-RPC.

## Shouldn't clients fix this instead?

Yes. Clients should spawn servers in a process group and kill the whole group on exit. mcp-lifeline is defence in depth: clients crash, get SIGKILLed, and have bugs, and when that happens your server shouldn't leak. Both fixes can exist together.

## Python / Go / Rust servers?

The library is for JavaScript/TypeScript. For anything else, use the [CLI wrapper](CLI.md), which works with any stdio server. The detection model in [SPEC.md](SPEC.md) is language-neutral if you want to port it.

## Reporting a bug

Please include your OS, your runtime and version, the client, how the server is launched (the exact `command` / `args`), and the output with `MCP_LIFELINE_DEBUG=1`. An `ps -o pid,ppid,command` (or Process Explorer) view of the tree helps a lot.
