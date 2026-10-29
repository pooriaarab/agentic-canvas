import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";

// A hex color ignores the theme. Every color in the board styles must come from an agentic-design token.
test("ui.css holds no hex color", () => {
  const css = readFileSync(new URL("./ui.css", import.meta.url), "utf8");
  expect(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
});

// The old prefix matches ad blocker rules. The UI sources must use only agd- classes and tokens.
test("the UI sources hold no ad- class or token", () => {
  for (const file of readdirSync(new URL("./", import.meta.url)).filter((f) => /\.(css|html|tsx?)$/.test(f) && !f.includes(".test."))) {
    const text = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    expect(text.match(/(?<![\w-])(?:--)?ad-[a-z]/g) ?? [], file).toEqual([]);
  }
});
