// A pretend MCP server: busy forever (like one with open DB pools / timers), protected by mcp-lifeline.
import { spawn } from "node:child_process";
import { exitWhenOrphaned } from "../../dist/index.js";

const env = process.env;
exitWhenOrphaned({
  intervalMs: 200,
  watch: env.WATCH || "chain",
  idleTimeoutMs: Number(env.IDLE || 0),
  onShutdown: (r) => process.stderr.write(`SHUTDOWN:${r.type}\n`),
});
if (env.SPAWN_CHILD) {
  const c = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  process.stderr.write(`CHILD:${c.pid}\n`);
}
process.stdin.on("data", () => {}); // like the MCP SDK StdioServerTransport
setInterval(() => {}, 1000); // keeps the event loop alive, as real servers do
process.stderr.write(`READY:${process.pid}\n`);
