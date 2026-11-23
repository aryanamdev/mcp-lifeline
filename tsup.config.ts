import { defineConfig } from "tsup";
import pkg from "./package.json" with { type: "json" };

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    target: "node18",
    sourcemap: false,
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    target: "node18",
    define: { __VERSION__: JSON.stringify(pkg.version) },
  },
]);
