# Contributing

Thanks for helping! The most valuable contributions are **reports of leaks it doesn't catch** and **false positives** (a server shut down when it shouldn't have been), especially on Windows and with clients the docs don't cover yet.

## Setup

```bash
git clone https://github.com/aryanamdev/mcp-lifeline
cd mcp-lifeline
npm ci
npm test          # builds, then runs the real-process test suite
npm run typecheck
```

Run the suite under Bun:

```bash
npm run build && TEST_RUNTIME=$(which bun) node --test test/lifeline.test.mjs
```

## Layout

| Path | |
|---|---|
| `src/index.ts` | `exitWhenOrphaned()`: triggers, ancestor watching, shutdown sequence |
| `src/proc.ts` | Cross-platform process table (`/proc`, `ps`, PowerShell/CIM) |
| `src/launchers.ts` | Which command lines count as launchers (`npx`, `sh -c`, …) |
| `src/kill.ts` | Tree and process-group killing |
| `src/cli.ts` | The `mcp-lifeline` wrapper and `reap` |
| `test/lifeline.test.mjs` | End-to-end tests with real processes |
| `test/fixtures/` | Fake servers, launchers and clients used by the tests |
| `docs/` | API, CLI, client configs, troubleshooting, design spec |

## Rules of thumb

- **Never write to stdout, never read stdin** in the library. stdout belongs to the MCP protocol.
- **Never keep the event loop alive**: timers are `unref`'d.
- **No runtime dependencies.**
- **Every new detection path gets a real-process test.** No mocks of `process.kill` or `/proc`. If a scenario can't be reproduced on CI, describe how you tested it by hand in the PR.
- If you add a launcher to `src/launchers.ts`, add yes/no cases to the `isLauncher` test, including a near-miss that must *not* match.

## Reporting a bug

Use the issue template. The things that make a bug fixable:

- OS, runtime + version, MCP client + version
- the exact `command` / `args` from your client config
- stderr output with `MCP_LIFELINE_DEBUG=1`
- the process tree: `ps -eo pid,ppid,command | grep -i mcp` (macOS/Linux) or Process Explorer (Windows)

## Releasing (maintainers)

1. Update `CHANGELOG.md` and bump `version` in `package.json`.
2. Commit, then tag and push: `git tag vX.Y.Z && git push origin main vX.Y.Z`.
3. `.github/workflows/release.yml` checks the tag matches `package.json`, runs the tests, and publishes to npm with provenance through npm Trusted Publishing. No tokens.
