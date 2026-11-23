// End-to-end tests with real processes. No mocks: every scenario spawns actual parents/children and kills them.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isLauncher } from "../dist/index.js";

const fx = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const posix = process.platform !== "win32";
// TEST_RUNTIME=bun runs every server/fixture under Bun instead of Node.
const RUNTIME = process.env.TEST_RUNTIME || process.execPath;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function run(args, opts = {}) {
  const child = spawn(RUNTIME, args, { stdio: ["pipe", "pipe", "pipe"], ...opts });
  child.err = "";
  child.out = "";
  child.stderr?.on("data", (d) => (child.err += d));
  child.stdout?.on("data", (d) => (child.out += d));
  return child;
}

async function waitFor(fn, ms = 5000, what = "condition") {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// Start `script` with its stdin held open by an unrelated process (a `sleep` feeding a pipe), so killing
// the script does NOT close the server's stdin — exactly the situation that leaks in real clients.
// (Plain spawn() won't do: Node destroys a child's stdin pipe when that child exits.)
function spawnHeld(script, env) {
  const child = spawn("sh", ["-c", 'sleep 20 2>/dev/null | exec "$0" "$1"', RUNTIME, script], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  child.err = "";
  child.stderr.on("data", (d) => (child.err += d));
  held.push(child);
  return child;
}
const held = [];
after(() => {
  for (const c of held) {
    c.stderr.destroy();
    c.unref();
  }
  spawn("pkill", ["-f", "^sleep 20$"], { stdio: "ignore" }).unref();
});

const match = (child, re) => () => re.exec(child.err);
const cleanup = (...pids) => pids.forEach((p) => p && alive(p) && process.kill(p, "SIGKILL"));

test("exits when stdin closes", async () => {
  const s = run([fx("server.mjs")]);
  await waitFor(match(s, /READY/), 5000, "ready");
  s.stdin.end();
  const code = await new Promise((r) => s.on("exit", r));
  assert.equal(code, 0);
  assert.match(s.err, /SHUTDOWN:stdin-closed/);
  assert.match(s.err, /\[mcp-lifeline\] stdin closed/);
});

test("runs onShutdown and exits on SIGTERM", { skip: !posix }, async () => {
  const s = run([fx("server.mjs")]);
  await waitFor(match(s, /READY/), 5000, "ready");
  s.kill("SIGTERM");
  await new Promise((r) => s.on("exit", r));
  assert.match(s.err, /SHUTDOWN:signal/);
});

test("exits when its parent is SIGKILLed while stdin is still held open", { skip: !posix }, async () => {
  // test (holds stdin pipe) -> middle (SIGKILLed) -> server
  const m = spawnHeld(fx("middle.mjs"), {});
  const pid = Number((await waitFor(match(m, /READY:(\d+)/), 5000, "ready"))[1]);
  process.kill(Number(match(m, /PARENT:(\d+)/)()[1]), "SIGKILL");
  try {
    await waitFor(() => !alive(pid), 4000, "server to exit");
    assert.match(m.err, /SHUTDOWN:(reparented|parent-exited)/);
  } finally {
    cleanup(pid);
  }
});

test("exits when the client dies but the npx launcher survives (the classic leak)", { skip: !posix }, async () => {
  // test (holds stdin) -> client (SIGKILLed) -> npx-cli.js (survives, reparented) -> server (parent unchanged!)
  const c = spawnHeld(fx("client.mjs"), {});
  const pid = Number((await waitFor(match(c, /READY:(\d+)/), 5000, "ready"))[1]);
  await sleep(600); // let the ancestor chain resolve
  process.kill(Number(match(c, /PARENT:(\d+)/)()[1]), "SIGKILL");
  try {
    await waitFor(() => !alive(pid), 4000, "server to exit");
    assert.match(c.err, /SHUTDOWN:parent-exited/);
  } finally {
    cleanup(pid);
  }
});

test("control: watching only the direct parent misses that leak", { skip: !posix }, async () => {
  const c = spawnHeld(fx("client.mjs"), { WATCH: "parent" });
  const pid = Number((await waitFor(match(c, /READY:(\d+)/), 5000, "ready"))[1]);
  await sleep(600);
  process.kill(Number(match(c, /PARENT:(\d+)/)()[1]), "SIGKILL");
  await sleep(2000);
  const stillAlive = alive(pid);
  cleanup(pid);
  // and the launcher it left behind
  assert.equal(stillAlive, true, "expected the parent-only watcher to leak (this proves the chain watch matters)");
});

test("kills its own child processes on shutdown", async () => {
  const s = run([fx("server.mjs")], { env: { ...process.env, SPAWN_CHILD: "1" } });
  const child = Number((await waitFor(match(s, /CHILD:(\d+)/), 5000, "child"))[1]);
  await waitFor(match(s, /READY/), 5000, "ready");
  assert.equal(alive(child), true);
  s.stdin.end();
  await new Promise((r) => s.on("exit", r));
  try {
    await waitFor(() => !alive(child), 3000, "grandchild to die");
  } finally {
    cleanup(child);
  }
});

test("idle timeout", async () => {
  const s = run([fx("server.mjs")], { env: { ...process.env, IDLE: "600" } });
  await new Promise((r) => s.on("exit", r));
  assert.match(s.err, /SHUTDOWN:idle/);
});

test("MCP_LIFELINE=off disables it", async () => {
  const s = run([fx("server.mjs")], { env: { ...process.env, MCP_LIFELINE: "off" } });
  await waitFor(match(s, /READY:(\d+)/), 5000, "ready");
  s.stdin.end();
  await sleep(800);
  assert.equal(s.exitCode, null);
  s.kill("SIGKILL");
});

// ------------------------------------------------------------------ CLI wrapper

test("wrapper passes traffic through both ways", async () => {
  const w = run([CLI, "--grace", "300", "--", process.execPath, fx("stubborn.mjs")]);
  const [, a, b] = await waitFor(match(w, /PIDS:(\d+),(\d+)/), 5000, "pids");
  w.stdin.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  await waitFor(() => w.out.includes('"method":"ping"'), 3000, "echo");
  w.stdin.end();
  await new Promise((r) => w.on("exit", r));
  cleanup(Number(a), Number(b));
});

test("wrapper kills a server (and its children) that ignores stdin EOF and SIGTERM", async () => {
  const w = run([CLI, "--grace", "300", "--", process.execPath, fx("stubborn.mjs")]);
  const [, a, b] = await waitFor(match(w, /PIDS:(\d+),(\d+)/), 5000, "pids");
  const server = Number(a);
  const grandchild = Number(b);
  w.stdin.end();
  await new Promise((r) => w.on("exit", r));
  try {
    await waitFor(() => !alive(server) && !alive(grandchild), 4000, "server tree to die");
    assert.match(w.err, /did not exit within 300ms/);
  } finally {
    cleanup(server, grandchild);
  }
});

test("wrapper exits with the server's exit code", async () => {
  const w = run([CLI, "--", process.execPath, "-e", "process.exit(7)"]);
  const code = await new Promise((r) => w.on("exit", r));
  assert.equal(code, 7);
});

test("wrapper: unknown command fails cleanly", async () => {
  const w = run([CLI, "--", "definitely-not-a-real-command-xyz"]);
  const code = await new Promise((r) => w.on("exit", r));
  assert.notEqual(code, 0);
});

test("reap lists without killing by default", async () => {
  const r = run([CLI, "reap", "--match", "zzz-no-such-process-zzz"]);
  await new Promise((res) => r.on("exit", res));
  assert.match(r.out, /No orphaned MCP server processes found/);
});

// ------------------------------------------------------------------ launcher detection

test("isLauncher recognises common launchers", () => {
  const yes = [
    "npx -y @modelcontextprotocol/server-github",
    "/usr/local/bin/node /usr/local/lib/node_modules/npm/bin/npx-cli.js -y foo",
    "node /usr/lib/node_modules/npm/bin/npm-cli.js exec -- foo",
    "npm exec foo",
    "npm run start",
    "pnpm dlx foo",
    "node /home/u/.cache/node/corepack/pnpm/9.0.0/bin/pnpm.cjs dlx foo",
    "yarn dlx foo",
    "bunx foo",
    "bun x foo",
    "uvx mcp-server-fetch",
    "uv run server.py",
    "uv tool run foo",
    "/bin/sh -c npx foo",
    "bash -lc 'npx foo'",
    'C:\\Windows\\system32\\cmd.exe /d /s /c "npx foo"',
    "\"C:\\Program Files\\nodejs\\npx.cmd\" -y foo",
    "pwsh -Command npx foo",
  ];
  const no = [
    "/Applications/Claude.app/Contents/MacOS/Claude",
    "/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin) --type=utility",
    "node /home/u/.local/share/claude/versions/2.1.0/cli.js",
    "claude",
    "bash",
    "-zsh",
    "python server.py",
    "node build/index.js",
    "npm install",
  ];
  for (const c of yes) assert.equal(isLauncher(c), true, `should be a launcher: ${c}`);
  for (const c of no) assert.equal(isLauncher(c), false, `should NOT be a launcher: ${c}`);
});
