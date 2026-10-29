import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  // Named entries, so `ui/embed.tsx` lands next to the others as `dist/embed.js`.
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
    "store-file": "src/store-file.ts",
    worker: "src/worker.ts",
    "live-worker": "src/live-worker.ts",
    live: "src/live.ts",
    client: "src/client.ts",
    embed: "ui/embed.tsx",
  },
  external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
  format: ["esm"],
  dts: true,
  clean: true,
  // Each entry stands alone: `dist/client.js` must not import a shared chunk.
  splitting: false,
  define: {
    __PACK_VERSION__: JSON.stringify(pkg.version),
  },
});
