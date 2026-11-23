#!/usr/bin/env node
import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { exitWhenOrphaned, describeReason } from "./index.js";
import { killTree, signalGroup } from "./kill.js";
import { isAlive, isWindows, listProcesses, type ProcInfo } from "./proc.js";

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "dev";

const HELP = `mcp-lifeline ${VERSION}
Stop stdio MCP servers from outliving the client that started them.

Usage
  mcp-lifeline [options] -- <command> [args...]   Wrap any stdio MCP server
  mcp-lifeline reap [--kill] [--match <regex>]     Find (and kill) orphaned MCP servers

Wrap options
  --grace <ms>      Time the server gets to exit after stdin closes, before it is killed (default 2000)
  --idle <ms>       Kill the server after this long with no traffic in either direction (default off)
  --interval <ms>   How often to check the client is alive (default 1000)
  --quiet           Don't log to stderr

Reap options
  --kill            Actually kill what was found (default: just list)
  --match <regex>   Command-line pattern to match (default: "mcp", case-insensitive)

Example mcp.json entry
  { "command": "npx", "args": ["-y", "mcp-lifeline", "--", "npx", "-y", "some-mcp-server"] }
`;

function parseMs(v: string | undefined, flag: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) fail(`${flag} expects a number of milliseconds, got "${v}"`);
  return n;
}

function fail(msg: string): never {
  process.stderr.write(`mcp-lifeline: ${msg}\n`);
  process.exit(2);
}

async function main(argv: string[]) {
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (argv[0] === "reap") return reap(argv.slice(1));
  return wrap(argv);
}

// ---------------------------------------------------------------- wrap

async function wrap(argv: string[]) {
  let grace = 2000;
  let idle = 0;
  let interval = 1000;
  let quiet = false;
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      i++;
      break;
    }
    if (a === "--grace") grace = parseMs(argv[++i], a);
    else if (a === "--idle") idle = parseMs(argv[++i], a);
    else if (a === "--interval") interval = parseMs(argv[++i], a);
    else if (a === "--quiet") quiet = true;
    else if (a.startsWith("-")) fail(`unknown option ${a} (did you forget "--" before the command?)`);
    else break;
  }
  const [command, ...args] = argv.slice(i);
  if (!command) fail("no command given. Usage: mcp-lifeline [options] -- <command> [args...]");

  const log = quiet ? () => {} : (m: string) => process.stderr.write(`[mcp-lifeline wrapper] ${m}\n`);

  // With shell:true (Windows) Node joins argv with spaces, so quote anything that needs it.
  const winQuote = (a: string) => (/[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
  const child = spawn(isWindows ? winQuote(command) : command, isWindows ? args.map(winQuote) : args, {
    stdio: ["pipe", "pipe", "inherit"],
    // Own process group on POSIX so we can take down the server *and* anything it spawned.
    detached: !isWindows,
    // npx/npm are .cmd shims on Windows, which need a shell since Node 20.12.
    shell: isWindows,
    windowsHide: true,
    env: process.env,
  });

  let childExited = false;
  const childGone = new Promise<void>((resolve) => child.once("close", () => resolve()));

  child.once("error", (err) => {
    log(`failed to start ${command}: ${err.message}`);
    process.exit(127);
  });

  const lifeline = exitWhenOrphaned({
    intervalMs: interval,
    idleTimeoutMs: idle,
    gracePeriodMs: grace + 3000,
    log: quiet ? false : log,
    exitCode: 0,
    async onShutdown(reason) {
      if (childExited) return;
      if (reason.type === "signal") signalGroup(child.pid!, reason.signal);
      else child.stdin?.end(); // the polite way to tell a stdio server it's over
      const exitedInTime = await Promise.race([childGone.then(() => true), sleep(grace).then(() => false)]);
      if (!exitedInTime && !childExited) {
        log(`server did not exit within ${grace}ms — killing it (${describeReason(reason)})`);
        if (!isWindows) signalGroup(child.pid!, "SIGTERM");
        await killTree(child.pid!, { graceMs: 1000 });
      }
    },
  });

  // ---- pipe traffic, counting it as activity
  process.stdin.on("data", (chunk) => {
    lifeline.touch();
    if (child.stdin?.writable) child.stdin.write(chunk);
  });
  process.stdin.on("end", () => child.stdin?.end());
  child.stdin?.on("error", () => {}); // EPIPE if the server already quit
  child.stdout?.on("data", (chunk) => {
    lifeline.touch();
    process.stdout.write(chunk);
  });

  child.once("close", (code, signal) => {
    childExited = true;
    if (lifeline.shuttingDown) return; // lifeline will exit for us
    lifeline.stop();
    const exitCode = code ?? (signal ? 128 + (signalNumber(signal) ?? 1) : 1);
    // Let stdout drain before exiting.
    process.stdout.write("", () => process.exit(exitCode));
  });
}

function signalNumber(signal: NodeJS.Signals): number | undefined {
  const map: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };
  return map[signal];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- reap

async function reap(argv: string[]) {
  let kill = false;
  let match = /mcp/i;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--kill") kill = true;
    else if (a === "--match") {
      const src = argv[++i];
      if (!src) fail("--match expects a regex");
      try {
        match = new RegExp(src, "i");
      } catch (e) {
        fail(`invalid regex: ${(e as Error).message}`);
      }
    } else fail(`unknown option ${a}`);
  }

  const all = await listProcesses();
  const byPid = new Map(all.map((p) => [p.pid, p]));
  const myUid = isWindows ? undefined : userInfo().uid;

  const orphans = all.filter((p) => {
    if (p.pid === process.pid || p.pid <= 4) return false;
    if (!match.test(p.command)) return false;
    if (/mcp-lifeline(\.js)?\s+reap/.test(p.command)) return false;
    if (myUid !== undefined && p.uid !== undefined && p.uid !== myUid) return false;
    if (isWindows) {
      // Windows doesn't reparent: an orphan's ParentProcessId points at a dead (or recycled, newer) process.
      const parent = byPid.get(p.ppid);
      return !parent || (!!parent.start && !!p.start && Number(parent.start) > Number(p.start));
    }
    return p.ppid === 1;
  });

  // Only report the top of each orphaned tree; killing it takes the rest down.
  if (!orphans.length) {
    process.stdout.write("No orphaned MCP server processes found.\n");
    return;
  }

  const rows = orphans.map((p: ProcInfo) => `${String(p.pid).padStart(7)}  ${truncate(p.command, 110)}`);
  process.stdout.write(`Found ${orphans.length} orphaned process${orphans.length === 1 ? "" : "es"}:\n\n    PID  COMMAND\n${rows.join("\n")}\n\n`);

  if (!kill) {
    process.stdout.write("Run again with --kill to terminate them.\n");
    return;
  }
  for (const p of orphans) await killTree(p.pid, { graceMs: 1500 });
  const survivors = orphans.filter((p) => isAlive(p.pid));
  process.stdout.write(
    survivors.length
      ? `Killed ${orphans.length - survivors.length}; could not kill: ${survivors.map((p) => p.pid).join(", ")}\n`
      : `Killed ${orphans.length}.\n`,
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`mcp-lifeline: ${err?.stack ?? err}\n`);
  process.exit(1);
});
