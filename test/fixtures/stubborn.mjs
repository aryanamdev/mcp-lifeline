// A badly behaved server: echoes lines, ignores stdin EOF and SIGTERM, and spawns a grandchild.
import { spawn } from "node:child_process";
process.on("SIGTERM", () => {});
const g = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
process.stderr.write(`PIDS:${process.pid},${g.pid}\n`);
process.stdin.on("data", (d) => process.stdout.write(d));
process.stdin.on("end", () => {}); // ignores it
setInterval(() => {}, 1000);
