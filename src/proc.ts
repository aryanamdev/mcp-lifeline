/**
 * Cross-platform process-table helpers.
 *
 * Linux reads /proc directly (cheap, synchronous, no child processes).
 * macOS/BSD shells out to `ps`. Windows shells out to PowerShell + CIM.
 */
import { execFile } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";

export interface ProcInfo {
  pid: number;
  ppid: number;
  /** Opaque start-time token. Two infos with the same pid but different `start` are different processes (PID reuse). */
  start: string;
  /** Full command line (best effort). */
  command: string;
  /** Numeric uid on POSIX, undefined on Windows. */
  uid?: number;
  /** True if the process has exited but not been reaped yet (POSIX zombie). */
  zombie?: boolean;
}

const platform = process.platform;
export const isLinux = platform === "linux";
export const isWindows = platform === "win32";

/** True if a process with this pid currently exists (EPERM means it exists but belongs to someone else). */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// ---------------------------------------------------------------- Linux

export function linuxInfo(pid: number): ProcInfo | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm (field 2) is wrapped in parens and may itself contain spaces or parens.
    const close = stat.lastIndexOf(")");
    const rest = stat.slice(close + 2).split(" ");
    const state = rest[0];
    const ppid = Number(rest[1]);
    const start = rest[19] ?? "";
    let command = "";
    try {
      command = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
    } catch {
      /* kernel threads / zombies have no cmdline */
    }
    if (!command) command = stat.slice(stat.indexOf("(") + 1, close);
    let uid: number | undefined;
    try {
      uid = statSync(`/proc/${pid}`).uid;
    } catch {
      /* ignore */
    }
    return { pid, ppid, start, command, uid, zombie: state === "Z" || state === "X" };
  } catch {
    return undefined;
  }
}

/** Live parent pid. Unlike `process.ppid` under Bun, this is never cached. Linux only. */
export function linuxParentPid(pid: number = process.pid): number | undefined {
  return linuxInfo(pid)?.ppid;
}

function linuxAll(): ProcInfo[] {
  const out: ProcInfo[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const info = linuxInfo(Number(name));
    if (info) out.push(info);
  }
  return out;
}

// ---------------------------------------------------------------- helpers

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { env: env ?? process.env, windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 15_000 },
      // `ps -p <dead pid>` exits 1 but still prints the live ones, so ignore the error.
      (_err, stdout) => resolve(String(stdout ?? "")),
    );
  });
}

// ---------------------------------------------------------------- macOS / BSD

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s(.*)$/;

async function psList(pids?: number[]): Promise<ProcInfo[]> {
  const args = ["-ww", "-o", "pid=,ppid=,uid=,state=,lstart=,command="];
  if (pids) args.push("-p", pids.join(","));
  else args.push("-A");
  const stdout = await run("ps", args, { ...process.env, LC_ALL: "C", LANG: "C" });
  const out: ProcInfo[] = [];
  for (const line of stdout.split("\n")) {
    const m = PS_LINE.exec(line);
    if (!m) continue;
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      uid: Number(m[3]),
      zombie: m[4]!.startsWith("Z"),
      start: m[5]!,
      command: m[6]!.trim(),
    });
  }
  return out;
}

// ---------------------------------------------------------------- Windows

async function winList(pids?: number[]): Promise<ProcInfo[]> {
  const filter = pids && pids.length ? ` -Filter "${pids.map((p) => `ProcessId=${Math.trunc(p)}`).join(" OR ")}"` : "";
  const script =
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
    `Get-CimInstance Win32_Process${filter} | ForEach-Object {` +
    ' $c = if ($_.CommandLine) { $_.CommandLine } else { $_.Name };' +
    ' $t = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 };' +
    ' "$($_.ProcessId)`t$($_.ParentProcessId)`t$t`t$c" }';
  const stdout = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  const out: ProcInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [pid, ppid, start, ...cmd] = line.split("\t");
    if (!pid || !/^\d+$/.test(pid)) continue;
    out.push({ pid: Number(pid), ppid: Number(ppid), start: start ?? "", command: cmd.join("\t").trim() });
  }
  return out;
}

// ---------------------------------------------------------------- public

/** Look up specific pids. Missing pids are simply absent from the map. */
export async function getProcesses(pids: number[]): Promise<Map<number, ProcInfo>> {
  const map = new Map<number, ProcInfo>();
  const wanted = pids.filter((p) => Number.isInteger(p) && p > 0);
  if (!wanted.length) return map;
  let list: ProcInfo[];
  if (isLinux) list = wanted.map(linuxInfo).filter((x): x is ProcInfo => !!x);
  else if (isWindows) list = await winList(wanted);
  else list = await psList(wanted);
  for (const p of list) map.set(p.pid, p);
  return map;
}

export async function getProcess(pid: number): Promise<ProcInfo | undefined> {
  return (await getProcesses([pid])).get(pid);
}

/** Every process visible to us. */
export async function listProcesses(): Promise<ProcInfo[]> {
  if (isLinux) return linuxAll();
  if (isWindows) return winList();
  return psList();
}

/** All descendants of `root` (children, grandchildren, ...), deepest last. */
export async function getDescendants(root: number): Promise<ProcInfo[]> {
  const all = await listProcesses();
  const byParent = new Map<number, ProcInfo[]>();
  for (const p of all) {
    if (p.pid === p.ppid) continue;
    const list = byParent.get(p.ppid) ?? [];
    list.push(p);
    byParent.set(p.ppid, list);
  }
  const out: ProcInfo[] = [];
  const queue = [root];
  const seen = new Set<number>([root]);
  while (queue.length) {
    const pid = queue.shift()!;
    for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}
