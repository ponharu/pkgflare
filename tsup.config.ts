import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: "esm",
    dts: true,
    sourcemap: true,
    clean: true,
  },
  {
    entry: ["src/cli.ts"],
    format: "esm",
    dts: false,
    sourcemap: true,
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
  {
    entry: { worker: "src/worker.ts" },
    format: "esm",
    platform: "browser",
    noExternal: ["semver"],
    sourcemap: true,
  },
]);
