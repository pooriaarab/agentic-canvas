import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 18900);
export const TOKENS = {
  ada: "ada-human-token-".padEnd(40, "a"),
  bea: "bea-human-token-".padEnd(40, "b"),
  bot: "helper-agent-token-".padEnd(40, "h"),
  viewer: "vic-viewer-token-".padEnd(40, "v"),
};
const grants = JSON.stringify({
  [TOKENS.ada]: { actor: "ada", kind: "human" },
  [TOKENS.bea]: { actor: "bea", kind: "human" },
  [TOKENS.bot]: { actor: "helper", kind: "agent_of_human" },
  [TOKENS.viewer]: { actor: "vic", kind: "human", role: "viewer" },
});

// The real Worker under `wrangler dev`, with the built UI. Each run starts from an empty database.
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  outputDir: "../test-results",
  workers: 1,
  timeout: 60_000,
  use: { baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 1280, height: 800 } },
  webServer: {
    command: `rm -rf ../test-results/.state && node ../node_modules/wrangler/bin/wrangler.js dev --ip 127.0.0.1 --port ${PORT} --inspector-port ${PORT + 100} --persist-to ../test-results/.state --var CANVAS_REGION:unknown --var CANVAS_UNSAFE_STATIC_TOKENS:1 --var 'CANVAS_API_TOKENS:${grants}'`,
    url: `http://127.0.0.1:${PORT}/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: { WRANGLER_SEND_METRICS: "false", CI: "1" },
  },
});
