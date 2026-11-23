// A launcher that shares its stdio with the server and waits (like `npm exec`).
process.stderr.write(`PARENT:${process.pid}\n`);
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const server = fileURLToPath(new URL("./server.mjs", import.meta.url));
const c = spawn(process.execPath, [server], { stdio: "inherit" });
c.on("exit", (code) => process.exit(code ?? 0));
