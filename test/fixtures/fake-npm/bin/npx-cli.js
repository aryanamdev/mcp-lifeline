// Named like npm's real npx entry point so mcp-lifeline recognises it as a launcher.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const server = fileURLToPath(new URL("../../server.mjs", import.meta.url));
const c = spawn(process.execPath, [server], { stdio: "inherit" });
c.on("exit", (code) => process.exit(code ?? 0));
