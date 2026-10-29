import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// A hex color ignores the theme. Every color in the board styles must come from an agentic-design token.
test("ui.css holds no hex color", () => {
  const css = readFileSync(new URL("./ui.css", import.meta.url), "utf8");
  expect(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
});
