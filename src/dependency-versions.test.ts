import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("shared package coverage", () => {
  for (const name of ["agentic-design", "agentic-identity", "agentic-realtime"]) {
    it(`tests the current ${name} release`, () => {
      const version = (directory: string): string =>
        JSON.parse(readFileSync(new URL(`../node_modules/${directory}/package.json`, import.meta.url), "utf8")).version;
      expect(version(name)).toBe(version(`${name}-current`));
    });
  }
});
