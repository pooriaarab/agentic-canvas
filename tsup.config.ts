import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts", "src/store-file.ts", "src/worker.ts", "src/live-worker.ts", "src/live.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  define: {
    __PACK_VERSION__: JSON.stringify(pkg.version),
  },
});
