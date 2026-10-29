import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

const shared = {
  external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
  format: ["esm" as const],
  dts: true,
  define: {
    __PACK_VERSION__: JSON.stringify(pkg.version),
  },
};

// `npm run build` empties dist first: two configs build at once, so neither may clean.
export default defineConfig([
  // The client stands alone, with no import, so a browser or a Worker loads one file. It does not share a chunk with the CLI.
  { ...shared, entry: { client: "src/client.ts" }, splitting: false },
  {
    ...shared,
    // Named entries, so `ui/embed.tsx` lands next to the others as `dist/embed.js`.
    entry: {
      index: "src/index.ts",
      cli: "src/cli.ts",
      account: "src/account.ts",
      "store-file": "src/store-file.ts",
      worker: "src/worker.ts",
      "live-worker": "src/live-worker.ts",
      live: "src/live.ts",
      embed: "ui/embed.tsx",
    },
  },
]);
