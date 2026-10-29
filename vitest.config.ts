import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // The CLI and MCP tests start real processes. A busy machine needs more than the 5 second default.
    testTimeout: 30_000,
  },
});
