import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "ui/**/*.test.tsx"],
    environment: "node",
    // The CLI and MCP tests start real processes. A busy machine needs more than the 5 second default.
    testTimeout: 120_000,
  },
});
