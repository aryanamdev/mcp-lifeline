import { execFile } from "node:child_process";
import { getDescendants, isAlive, isWindows } from "./proc.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function trySignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone, or not ours */
  }
}

/**
 * Kill `pid` and everything below it. SIGTERM first, SIGKILL after `graceMs` for anything still alive.
 * On Windows uses `taskkill /T /F`, which has no graceful step.
 */
export async function killTree(pid: number, { graceMs = 1000, includeRoot = true } = {}): Promise<void> {
  if (isWindows) {
    const targets = includeRoot ? [pid] : (await getDescendants(pid)).map((p) => p.pid);
    await Promise.all(
      targets.map(
        (t) =>
          new Promise<void>((resolve) =>
            execFile("taskkill", ["/PID", String(t), "/T", "/F"], { windowsHide: true }, () => resolve()),
          ),
      ),
    );
    return;
  }
  // Snapshot descendants *before* signalling: once a parent dies its children get reparented and we lose them.
  const descendants = (await getDescendants(pid)).map((p) => p.pid);
  const targets = includeRoot ? [pid, ...descendants] : descendants;
  if (!targets.length) return;
  for (const t of targets) trySignal(t, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && targets.some(isAlive)) await sleep(50);
  for (const t of targets) if (isAlive(t)) trySignal(t, "SIGKILL");
}

/** Signal a whole process group (POSIX). Falls back to the single pid. */
export function signalGroup(pid: number, signal: NodeJS.Signals): void {
  if (isWindows) return trySignal(pid, signal);
  try {
    process.kill(-pid, signal);
  } catch {
    trySignal(pid, signal);
  }
}
