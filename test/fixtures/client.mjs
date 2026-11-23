// A pretend MCP client (Claude, Cursor, ...) that launches the server through `npx`.
process.stderr.write(`PARENT:${process.pid}\n`);
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const npx = fileURLToPath(new URL("./fake-npm/bin/npx-cli.js", import.meta.url));
spawn(process.execPath, [npx], { stdio: "inherit" });
setInterval(() => {}, 1000);
