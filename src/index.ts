import { isLauncher } from "./launchers.js";
import { killTree } from "./kill.js";
import {
  getProcess,
  getProcesses,
  isAlive,
  isLinux,
  isWindows,
  linuxInfo,
  linuxParentPid,
  type ProcInfo,
} from "./proc.js";

export type ShutdownReason =
  | { type: "stdin-closed" }
  | { type: "stdout-broken"; code?: string }
  | { type: "signal"; signal: NodeJS.Signals }
  | { type: "parent-exited"; pid: number; command?: string }
  | { type: "reparented"; from: number; to: number }
  | { type: "idle"; idleMs: number }
  | { type: "manual"; detail?: string };

export interface LifelineOptions {
  /** Called once, before exit. Close your MCP server, flush logs, release locks. Bounded by `gracePeriodMs`. */
  onShutdown?: (reason: ShutdownReason) => void | Promise<void>;
  /** How often to check that our parents are still alive. Default 1000 ms. */
  intervalMs?: number;
  /** Max time `onShutdown` + child cleanup may take before we exit anyway. Default 3000 ms. */
  gracePeriodMs?: number;
  /** Exit after this long without `touch()`. 0 = off (default). */
  idleTimeoutMs?: number;
  /** Shut down when stdin ends (the client closed the pipe). Ignored when stdin is a TTY. Default true. */
  watchStdin?: boolean;
  /** Shut down when writing to stdout fails with EPIPE (nobody is reading). Default true. */
  watchStdout?: boolean;
  /** Signals that trigger a graceful shutdown. Default SIGINT, SIGTERM, SIGHUP. Pass [] to leave signals alone. */
  signals?: NodeJS.Signals[];
  /**
   * Which ancestors to watch.
   * - "chain" (default): the parent, any launchers above it (npx, npm exec, pnpm dlx, sh -c, ...),
   *   and the first real process above those — normally the MCP client itself.
   * - "parent": only the direct parent.
   */
  watch?: "chain" | "parent";
  /** Max ancestors to watch in "chain" mode. Default 5. */
  maxDepth?: number;
  /** Extra command-line patterns to treat as launchers when walking up the tree. */
  launchers?: RegExp[];
  /** Kill our own child processes (and their children) on shutdown. Default true. */
  killChildren?: boolean;
  /** Exit code used when shutting down. Default 0. */
  exitCode?: number;
  /** Call `process.exit` after shutdown. Default true. Set false if you want to exit yourself. */
  exit?: boolean;
  /** `false` to silence, or a custom logger. Default writes one line to stderr (never stdout — that is the protocol channel). */
  log?: false | ((message: string) => void);
}

export interface Lifeline {
  /** Mark activity, resetting the idle timer. */
  touch(): void;
  /** Start a shutdown yourself. */
  shutdown(detail?: string): Promise<void>;
  /** Remove all watchers and timers without exiting. */
  stop(): void;
  /** The ancestors currently being watched (filled in asynchronously shortly after start). */
  readonly watching: readonly ProcInfo[];
  /** True once shutdown has begun. */
  readonly shuttingDown: boolean;
}

const DEFAULT_SIGNALS: NodeJS.Signals[] = isWindows ? ["SIGINT", "SIGTERM", "SIGBREAK" as NodeJS.Signals] : ["SIGINT", "SIGTERM", "SIGHUP"];

export function describeReason(r: ShutdownReason): string {
  switch (r.type) {
    case "stdin-closed":
      return "stdin closed (client disconnected)";
    case "stdout-broken":
      return `stdout is broken${r.code ? ` (${r.code})` : ""} (client stopped reading)`;
    case "signal":
      return `received ${r.signal}`;
    case "parent-exited":
      return `ancestor process ${r.pid}${r.command ? ` (${truncate(r.command, 80)})` : ""} exited`;
    case "reparented":
      return `parent process ${r.from} went away (reparented to ${r.to})`;
    case "idle":
      return `idle for ${Math.round(r.idleMs / 1000)}s`;
    case "manual":
      return r.detail ?? "shutdown requested";
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

let active: Lifeline | undefined;

/**
 * Make this process exit when the MCP client that started it is gone.
 *
 * ```ts
 * await server.connect(new StdioServerTransport());
 * exitWhenOrphaned({ onShutdown: () => server.close() });
 * ```
 *
 * Calling it twice returns the existing instance.
 */
export function exitWhenOrphaned(options: LifelineOptions = {}): Lifeline {
  if (active) return active;

  const {
    onShutdown,
    intervalMs = 1000,
    gracePeriodMs = 3000,
    idleTimeoutMs = 0,
    watchStdin = true,
    watchStdout = true,
    signals = DEFAULT_SIGNALS,
    watch = "chain",
    maxDepth = 5,
    launchers = [],
    killChildren = true,
    exitCode = 0,
    exit = true,
  } = options;

  const log =
    options.log === false
      ? () => {}
      : (options.log ??
        ((m: string) => {
          try {
            process.stderr.write(`[mcp-lifeline] ${m}\n`);
          } catch {
            /* stderr gone too */
          }
        }));
  const debug = process.env.MCP_LIFELINE_DEBUG ? log : () => {};

  const disabled = /^(0|off|false|disabled?)$/i.test(process.env.MCP_LIFELINE ?? "");

  const cleanups: Array<() => void> = [];
  let watching: ProcInfo[] = [];
  let shuttingDown = false;
  let lastActivity = Date.now();

  const initialPpid = isLinux ? (linuxParentPid() ?? process.ppid) : process.ppid;

  const lifeline: Lifeline = {
    touch() {
      lastActivity = Date.now();
    },
    shutdown(detail?: string) {
      return shutdown({ type: "manual", detail });
    },
    stop,
    get watching() {
      return watching;
    },
    get shuttingDown() {
      return shuttingDown;
    },
  };
  active = lifeline;

  function stop() {
    while (cleanups.length) {
      try {
        cleanups.pop()!();
      } catch {
        /* ignore */
      }
    }
    if (active === lifeline) active = undefined;
  }

  async function shutdown(reason: ShutdownReason): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    stop();
    active = lifeline; // keep returning this instance while we exit
    log(`${describeReason(reason)} — shutting down`);

    let finished = false;
    const finish = async () => {
      if (finished) return;
      finished = true;
      if (killChildren) {
        try {
          await Promise.race([killTree(process.pid, { includeRoot: false, graceMs: 500 }), sleep(1500)]);
        } catch {
          /* best effort */
        }
      }
      if (exit) process.exit(exitCode);
    };

    // Hard deadline: never let a stuck onShutdown keep an orphan alive.
    const hard = setTimeout(() => {
      log(`cleanup did not finish within ${gracePeriodMs}ms — exiting anyway`);
      void finish();
    }, gracePeriodMs);

    try {
      await onShutdown?.(reason);
    } catch (err) {
      log(`onShutdown threw: ${(err as Error)?.message ?? err}`);
    }
    clearTimeout(hard);
    await finish();
  }

  if (disabled) {
    debug("disabled via MCP_LIFELINE env var");
    return lifeline;
  }

  // ------------------------------------------------------------ stdin
  if (watchStdin && process.stdin && !process.stdin.isTTY) {
    // Only listen for end/close. Never attach 'data' or call resume(): that would steal
    // bytes from the MCP transport if it has not started reading yet.
    const onEnd = () => void shutdown({ type: "stdin-closed" });
    process.stdin.on("end", onEnd);
    process.stdin.on("close", onEnd);
    cleanups.push(() => {
      process.stdin.off("end", onEnd);
      process.stdin.off("close", onEnd);
    });
  }

  // ------------------------------------------------------------ stdout
  if (watchStdout && process.stdout) {
    const onError = (err: NodeJS.ErrnoException) => {
      if (err?.code === "EPIPE" || err?.code === "ERR_STREAM_DESTROYED" || err?.code === "EOF") {
        void shutdown({ type: "stdout-broken", code: err.code });
      }
    };
    process.stdout.on("error", onError);
    cleanups.push(() => process.stdout.off("error", onError));
  }

  // ------------------------------------------------------------ signals
  for (const signal of signals) {
    const handler = () => void shutdown({ type: "signal", signal });
    try {
      process.on(signal, handler);
      cleanups.push(() => process.off(signal, handler));
    } catch {
      /* signal not supported on this platform */
    }
  }

  // ------------------------------------------------------------ ancestors
  // Start by watching just the direct parent; the full chain is resolved asynchronously.
  if (initialPpid > 1) watching = [{ pid: initialPpid, ppid: -1, start: "", command: "" }];

  void (async () => {
    try {
      watching = await resolveAncestors(initialPpid, watch === "parent" ? 1 : maxDepth, launchers);
      debug(`watching ${watching.map((p) => `${p.pid} (${truncate(p.command, 60)})`).join(" <- ") || "nothing"}`);
    } catch (err) {
      debug(`could not resolve ancestors: ${(err as Error).message}`);
    }
  })();

  let ticks = 0;
  // Identity checks (PID reuse) are free on Linux; elsewhere they spawn `ps`/PowerShell, so do them rarely.
  const identityEvery = isLinux ? 1 : Math.max(1, Math.round(15_000 / intervalMs));
  let identityInFlight = false;

  const timer = setInterval(() => {
    if (shuttingDown) return;
    ticks++;

    // 1. Were we reparented? (Live ppid; process.ppid is cached under Bun, so read /proc on Linux.)
    if (!isWindows && initialPpid > 1) {
      const now = isLinux ? linuxParentPid() : process.ppid;
      if (now !== undefined && now !== initialPpid) {
        void shutdown({ type: "reparented", from: initialPpid, to: now });
        return;
      }
    }

    // 2. Is every watched ancestor still alive?
    for (const p of watching) {
      if (!isAlive(p.pid)) {
        void shutdown({ type: "parent-exited", pid: p.pid, command: p.command || undefined });
        return;
      }
      if (isLinux && p.start) {
        const cur = linuxInfo(p.pid);
        // A SIGKILLed ancestor nobody has reaped yet is a zombie: kill(pid, 0) still succeeds on it.
        if (!cur || cur.zombie || cur.start !== p.start) {
          void shutdown({ type: "parent-exited", pid: p.pid, command: p.command || undefined });
          return;
        }
      }
    }

    // 3. Off Linux: periodically make sure those pids weren't recycled by unrelated processes.
    if (!isLinux && ticks % identityEvery === 0 && !identityInFlight && watching.some((p) => p.start)) {
      identityInFlight = true;
      getProcesses(watching.map((p) => p.pid))
        .then((now) => {
          for (const p of watching) {
            if (!p.start) continue;
            const cur = now.get(p.pid);
            if (!cur || cur.zombie || cur.start !== p.start) {
              void shutdown({ type: "parent-exited", pid: p.pid, command: p.command || undefined });
              return;
            }
          }
        })
        .catch(() => {})
        .finally(() => {
          identityInFlight = false;
        });
    }

    // 4. Idle timeout.
    if (idleTimeoutMs > 0 && Date.now() - lastActivity >= idleTimeoutMs) {
      void shutdown({ type: "idle", idleMs: Date.now() - lastActivity });
    }
  }, intervalMs);
  timer.unref(); // never keep a process alive just to watch it
  cleanups.push(() => clearInterval(timer));

  return lifeline;
}

/**
 * Walk up from `ppid`: include the parent, every launcher above it, and the first
 * non-launcher (the client). Stops at pid 1 / system roots.
 */
export async function resolveAncestors(ppid: number, maxDepth = 5, extraLaunchers: RegExp[] = []): Promise<ProcInfo[]> {
  const chain: ProcInfo[] = [];
  let pid = ppid;
  while (chain.length < maxDepth && pid > 1 && !(isWindows && pid === 4)) {
    const info = await getProcess(pid);
    if (!info) break;
    if (isWindows && info.ppid && chain.length) {
      // Windows never reparents: a stale ParentProcessId may point at a recycled pid that started later than us.
      const prev = chain[chain.length - 1]!;
      if (info.start && prev.start && Number(info.start) > Number(prev.start)) break;
    }
    chain.push(info);
    if (!isLauncher(info.command, extraLaunchers)) break;
    if (info.ppid === pid) break;
    pid = info.ppid;
  }
  return chain;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

export { isLauncher } from "./launchers.js";
export { killTree } from "./kill.js";
export { isAlive, listProcesses, getDescendants, type ProcInfo } from "./proc.js";

export default exitWhenOrphaned;
