import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { build } from "esbuild";

// Ways the host mode can fail, listed before the tests:
// - an edit in the UI does not reach the host's document, or a peer's edit does not show
// - the page calls the package API in host mode
// - unmount drops the host's document
// - a toolbar container adds a tab stop, or a named button cannot be reached
// - the board on a host page has an axe violation of WCAG 2.2 AA in light or dark

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
let script = "";
let styles = "";
test.beforeAll(async () => {
  const out = await build({ entryPoints: ["e2e/host/main.ts"], bundle: true, format: "esm", target: "es2022", write: false, outdir: "out", define: { "process.env.NODE_ENV": '"production"' }, logLevel: "warning", external: [] });
  script = out.outputFiles.find((f) => f.path.endsWith(".js"))!.text;
  styles = (await build({ entryPoints: ["node_modules/agentic-design/dist/styles.css", "dist/ui.css"], bundle: true, write: false, outdir: "out", loader: { ".woff2": "dataurl" }, logLevel: "warning" })).outputFiles.map((f) => f.text).join("\n");
});

const sockets: string[] = [];
const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
});
async function host(browser: Browser, who: Record<string, string>, theme: "light" | "dark" = "light"): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  contexts.push(context);
  // From the first request on: a room opened at mount must not be missed.
  page.on("websocket", (socket) => sockets.push(socket.url()));
  await page.route("https://host.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: script });
    if (path.endsWith(".css")) return route.fulfill({ contentType: "text/css", body: styles });
    return route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><title>Host board</title><link rel="stylesheet" href="/app.css"><style>body { margin: 1rem; background: var(--agd-color-bg); color: var(--agd-color-text); }</style></head><body><main><div id="board"></div></main><script type="module" src="/app.js"></script></body></html>` });
  });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.goto(`https://host.test/#${new URLSearchParams(who)}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  return page;
}

const axe = async (page: Page) => {
  const result = await new AxeBuilder({ page }).withTags([...TAGS, "best-practice"]).options({ rules: { "focus-order-semantics": { enabled: true } } }).analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
};

test("a host page edits its own document, sees a peer's edit, calls no API, and keeps the document after unmount", async ({ browser }) => {
  const page = await host(browser, { kind: "agent_of_human", name: "Helper", id: "helper" });
  await page.getByRole("button", { name: "Add rectangle" }).click();
  await expect.poll(() => page.evaluate(() => (window as never as { hostElements(): { type: string; author: { id: string; kind: string } }[] }).hostElements())).toMatchObject([{ type: "rect", author: { kind: "agent_of_human", id: "helper" } }]);
  await page.evaluate(() => (window as never as { peerAdd(i: string, t: string): void }).peerAdd("p1", "From a peer"));
  await expect(page.getByRole("button", { name: /^Rectangle: From a peer/ })).toBeVisible();
  await page.waitForTimeout(6000);
  expect(await page.evaluate(() => (window as never as { requests(): string[] }).requests())).toEqual([]);
  expect(sockets).toEqual([]);
  await page.evaluate(() => (window as never as { unmountBoard(): void }).unmountBoard());
  await expect(page.locator("#board")).toBeEmpty();
  expect(await page.evaluate(() => (window as never as { hostElements(): unknown[] }).hostElements())).toHaveLength(2);
});

for (const theme of ["light", "dark"] as const) {
  test(`the host board has no axe violation in the ${theme} theme`, async ({ browser }) => {
    const page = await host(browser, { name: "Ada" }, theme);
    // The groups label their native buttons without adding container tab stops.
    const palette = page.getByRole("group", { name: "Shape palette", exact: true });
    const zoom = page.getByRole("group", { name: "Zoom and pan", exact: true });
    for (const group of [palette, zoom]) {
      expect(await group.evaluate((el) => (el as HTMLElement).tabIndex)).toBe(-1);
    }
    const buttons = [...await palette.getByRole("button").all(), ...await zoom.getByRole("button").all()];
    await page.keyboard.press("Tab");
    for (const button of buttons) {
      await expect(button).toBeFocused();
      await expect(button).toHaveAccessibleName(/\S/);
      await page.keyboard.press("Tab");
    }
    await page.keyboard.press("Shift+Tab");
    await expect(buttons.at(-1)!).toBeFocused();
    await axe(page);
    await page.getByRole("button", { name: "Add sticky note" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Note").first()).toBeVisible();
    await axe(page);
  });
}
