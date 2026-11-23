/**
 * Decides whether an ancestor process is a "launcher" — something that sits between
 * the MCP client and the real server (npx, npm exec, pnpm dlx, bunx, uvx, sh -c, cmd /c ...).
 *
 * Launchers are transparent: when we walk up the process tree we skip through them and
 * also watch the first non-launcher ancestor (the actual client). That is what catches the
 * classic leak where the client dies but `npm exec` survives, holding our stdin open.
 */

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ash", "fish", "ksh"]);
const RUNTIMES = new Set(["node", "nodejs", "bun", "deno"]);

/** Split a command line into tokens, honouring simple double/single quotes. */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command))) tokens.push(m[1] ?? m[2] ?? m[3] ?? "");
  return tokens;
}

/** "C:\\Program Files\\nodejs\\npx.cmd" -> "npx" */
export function baseName(token: string): string {
  const last = token.split(/[\\/]/).pop() ?? token;
  return last.replace(/\.(exe|cmd|bat|ps1|c?js|mjs)$/i, "").toLowerCase();
}

function isLauncherExe(exe: string, args: string[]): boolean {
  const sub = args[0]?.toLowerCase();
  switch (exe) {
    case "npx":
    case "pnpx":
    case "bunx":
    case "uvx":
    case "npx-cli":
    case "corepack":
    case "mcp-lifeline":
    case "nohup":
    case "env":
    case "timeout":
    case "setsid":
    case "tsx":
    case "ts-node":
      return true;
    case "npm":
    case "npm-cli":
    case "pnpm":
    case "yarn":
      return ["exec", "x", "dlx", "run", "run-script", "start", "rum", "urn"].includes(sub ?? "");
    case "bun":
      return ["x", "run", "start"].includes(sub ?? "");
    case "uv":
      return sub === "run" || (sub === "tool" && args[1] === "run");
    case "pipx":
      return sub === "run";
    case "cmd":
      return args.some((a) => /^\/[cks]$/i.test(a));
    case "powershell":
    case "pwsh":
      return args.some((a) => /^-(c|command|file|f)$/i.test(a));
    default:
      if (SHELLS.has(exe)) return args.some((a) => /^-[a-z]*c[a-z]*$/i.test(a));
      return false;
  }
}

export function isLauncher(command: string, extra: RegExp[] = []): boolean {
  if (extra.some((re) => re.test(command))) return true;
  const tokens = tokenize(command);
  if (!tokens.length) return false;
  let exe = baseName(tokens[0]!);
  let rest = tokens.slice(1);
  // `node /path/to/npx-cli.js ...`, `bun /path/pnpm.cjs dlx ...`
  if (RUNTIMES.has(exe)) {
    const scriptIdx = rest.findIndex((t) => !t.startsWith("-"));
    if (scriptIdx === -1) return false;
    const script = rest[scriptIdx]!;
    const scriptBase = baseName(script);
    rest = rest.slice(scriptIdx + 1);
    // bun/deno subcommands: `bun x foo`, `bun run start`, `deno run ...` is the server itself, not a launcher
    if (exe === "bun" && ["x", "run", "start"].includes(script)) return true;
    if (/[\\/]mcp-lifeline[\\/]/.test(script)) return true;
    exe = scriptBase;
  }
  return isLauncherExe(exe, rest);
}
