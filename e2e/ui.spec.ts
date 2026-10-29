// End to end: the built UI, served by the real Worker under `wrangler dev`.
//
// Failure cases, written before the UI:
//  1. A wrong token signs in, or shows no error.
//  2. A shape or a note that was added is lost on reload.
//  3. A move changes the screen only: after a reload the item is back where it was.
//  4. A missing board, or a failed list, shows a blank page and no way to retry.
//  5. Delete in the text field removes the selected item.
//  6. The keyboard cannot move, delete, or clear an item.
//  7. An item an agent wrote looks like a person's item (no marker, no word in its name).
//  8. A second editor's change never shows, and presence does not show the second editor.
//  9. A viewer can change the board.
// 10. A view has an axe violation in the light or the dark theme.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createClient } from "../src/client.js";
import { TOKENS } from "./playwright.config.js";

const API = `http://127.0.0.1:${process.env.E2E_PORT ?? 18900}/api/v1/canvas`;
// The committed set in docs/ui is refreshed on purpose (UPDATE_SCREENSHOTS=1). A normal run writes to test-results.
const shots = (name: string) => `${process.env.UPDATE_SCREENSHOTS ? "docs/ui" : "test-results/screens"}/${name}.png`;
/** Edits are saved when the page says so. A reload before that would drop the last ones. */
const saved = (page: Page) => expect(page.getByText("All changes saved")).toBeVisible();

async function signIn(page: Page, token: string) {
  await page.goto("/");
  await page.getByLabel("Access token").fill(token);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Boards", exact: true })).toBeVisible();
}

async function axe(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => `${n.target.join(" ")}`).join(", ")}`)).toEqual([]);
}

/** Check one view in both themes, and save a screenshot of each. */
async function check(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator("html")).toHaveCSS("color-scheme", scheme);
    await axe(page);
    await page.screenshot({ path: shots(`${scheme}-${name}`) });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

const item = (page: Page, text: string) => page.getByRole("button", { name: new RegExp(`^${text}`) });
const box = async (page: Page, text: string) => (await item(page, text).locator(".shape").boundingBox())!;

test("a wrong token is refused", async ({ page }) => {
  await page.goto("/");
  await check(page, "sign-in");
  await page.getByLabel("Access token").fill("x".repeat(40));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("The server did not accept this token.")).toBeVisible();
  await axe(page);
});

test("create a board, add a shape and a note, move them, reload", async ({ page }) => {
  await signIn(page, TOKENS.ada);
  await expect(page.getByText("No boards yet")).toBeVisible();
  await check(page, "boards-empty");

  await page.getByRole("button", { name: "New board" }).click();
  await page.getByLabel("Title").fill("Launch plan");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Launch plan" })).toBeVisible();
  await expect(page.getByText("This board is empty")).toBeVisible();
  await check(page, "board-empty");

  await page.getByRole("button", { name: "Add rectangle" }).click();
  await expect(item(page, "Rectangle: Rectangle")).toBeVisible();
  await page.getByRole("button", { name: "Add sticky note" }).click();
  await expect(item(page, "Sticky note: Note")).toBeVisible();
  await expect(page.getByText("This board is empty")).toBeHidden();

  // Edit the note text in the inspector.
  await page.getByLabel("Text", { exact: true }).fill("Ship it");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(item(page, "Sticky note: Ship it")).toBeVisible();

  // Move the rectangle with the pointer.
  const before = await box(page, "Rectangle");
  // The note overlaps the rectangle's middle, so grab the rectangle by its corner.
  await page.mouse.move(before.x + 8, before.y + 8);
  await page.mouse.down();
  await page.mouse.move(before.x - 292, before.y + 98, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await box(page, "Rectangle")).x - before.x)).toBe(-300);
  const moved = await box(page, "Rectangle");

  // Connect the two shapes, then resize with the fields.
  await item(page, "Rectangle").focus();
  await page.getByLabel("Connect to").selectOption({ label: "Sticky note: Ship it" });
  await expect(page.getByRole("button", { name: /^Connector/ })).toBeVisible();
  await item(page, "Rectangle").focus();
  await page.getByLabel("Width").fill("220");
  await page.getByRole("button", { name: "Save changes" }).click();
  // The box includes the stroke.
  await expect.poll(async () => Math.round((await box(page, "Rectangle")).width / 5)).toBe(44);

  await saved(page);
  await page.reload();
  await expect(item(page, "Sticky note: Ship it")).toBeVisible();
  const after = await box(page, "Rectangle");
  expect(Math.round(after.x - moved.x)).toBe(0);
  expect(Math.round(after.width / 5)).toBe(44);
  await expect(page.getByRole("button", { name: /^Connector/ })).toBeVisible();
  await check(page, "board");

  await page.goto("/#/");
  await expect(page.getByRole("link", { name: "Launch plan" }).first()).toBeVisible();
  await check(page, "boards");
});

test("the keyboard moves, resizes, deletes, and clears", async ({ page }) => {
  await signIn(page, TOKENS.ada);
  const client = createClient({ baseUrl: API, token: TOKENS.ada });
  await client.createBoard({ id: "keys", title: "Keys" });
  await client.addShape("keys", { id: "k1", type: "rect", x: 100, y: 100, text: "First" });
  await client.addShape("keys", { id: "k2", type: "ellipse", x: 400, y: 100, text: "Second" });
  await page.goto("/#/b/keys");
  await expect(item(page, "Rectangle: First")).toBeVisible();

  // Both toolbars come before the canvas, so Tab reaches them before any item.
  const order = await page.evaluate(() => {
    const canvas = document.querySelector(".canvas")!;
    return ["Shape palette", "Zoom and pan"].map((name) => !!(document.querySelector(`[role=toolbar][aria-label="${name}"]`)!.compareDocumentPosition(canvas) & Node.DOCUMENT_POSITION_FOLLOWING));
  });
  expect(order).toEqual([true, true]);
  await page.keyboard.press("Tab"); // the first toolbar
  await page.locator(".canvas").focus();
  await page.keyboard.press("Tab");
  await expect(item(page, "Rectangle: First")).toBeFocused();
  await expect(item(page, "Rectangle: First")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Tab");
  await expect(item(page, "Ellipse: Second")).toBeFocused();
  await page.keyboard.press("Shift+Tab");

  const start = await box(page, "Rectangle");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await expect.poll(async () => Math.round((await box(page, "Rectangle")).x - start.x)).toBe(20);
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(async () => Math.round((await box(page, "Rectangle")).width - start.width)).toBe(10);
  await saved(page);
  await page.reload();
  const kept = await box(page, "Rectangle");
  expect([Math.round(kept.x - start.x), Math.round(kept.width - start.width)]).toEqual([20, 10]);

  // Without a drag (WCAG 2.5.7): the position fields move an item, and the pan buttons move the view.
  await item(page, "Rectangle: First").focus();
  const x = await box(page, "Rectangle");
  await page.getByLabel("X", { exact: true }).fill("500");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(async () => Math.round(Math.abs((await box(page, "Rectangle")).x - x.x))).toBeGreaterThan(100);
  await saved(page);
  expect((await client.readBoard("keys")).nodes.find((n) => n.id === "k1")?.x).toBe(500);
  const panned = await box(page, "Rectangle");
  await page.getByRole("button", { name: "Pan left" }).click();
  await expect.poll(async () => Math.round((await box(page, "Rectangle")).x - panned.x)).toBe(80);

  await item(page, "Rectangle: First").focus();
  await page.keyboard.press("Escape");
  await expect(item(page, "Rectangle: First")).toHaveAttribute("aria-pressed", "false");
  // Focus stays on the item, so its ring must show.
  await expect(item(page, "Rectangle: First")).toBeFocused();
  await expect(item(page, "Rectangle: First").locator(".ring")).toHaveCSS("stroke", /rgb/);
  await item(page, "Ellipse: Second").focus();
  await page.keyboard.press("Delete");
  await expect(item(page, "Ellipse: Second")).toHaveCount(0);
  expect((await client.readBoard("keys")).nodes.map((n) => n.id)).toEqual(["k1"]);

  // Delete in a text field edits text. It never removes the item.
  await item(page, "Rectangle: First").focus();
  await page.getByLabel("Text", { exact: true }).press("Delete");
  await expect(item(page, "Rectangle: First")).toBeVisible();
});

test("an agent's item carries a marker, and a viewer cannot change the board", async ({ page }) => {
  const bot = createClient({ baseUrl: API, token: TOKENS.bot });
  await bot.createBoard({ id: "agent", title: "Agent work" });
  await bot.addShape("agent", { id: "a1", type: "sticky", x: 80, y: 80, text: "Draft by agent" });
  await createClient({ baseUrl: API, token: TOKENS.ada }).addShape("agent", { id: "h1", type: "rect", x: 300, y: 80, text: "Mine" });
  await signIn(page, TOKENS.viewer);
  await page.goto("/#/b/agent");
  const note = item(page, "Sticky note: Draft by agent");
  await expect(note).toHaveAccessibleName(/made by agent helper/);
  await expect(page.locator("[data-badge-for=a1]")).toContainText("Agent");
  await expect(page.locator("[data-badge-for=h1]")).toHaveCount(0);
  await expect(page.getByText("This token can read the board but not change it.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add rectangle" })).toBeDisabled();
  await note.focus();
  await page.keyboard.press("Delete");
  await expect(note).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Selected item" })).toContainText("Agent");
  await check(page, "board-agent");
});

test("a missing board and a failed list show a way out", async ({ page }) => {
  await signIn(page, TOKENS.ada);
  await page.goto("/#/b/nope");
  await expect(page.getByText("This board does not exist")).toBeVisible();
  await axe(page);

  await page.route("**/api/v1/canvas/boards", (route) => route.abort());
  await page.goto("/#/");
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("cannot be reached");
  await check(page, "error");
  await page.unroute("**/api/v1/canvas/boards");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Boards", exact: true })).toBeVisible();
});

test("two editors see each other and each other's changes", async ({ browser }) => {
  const client = createClient({ baseUrl: API, token: TOKENS.ada });
  await client.createBoard({ id: "duo", title: "Duo" });
  const [a, b] = await Promise.all([browser.newContext(), browser.newContext()]);
  const [pa, pb] = [await a.newPage(), await b.newPage()];
  await signIn(pa, TOKENS.ada);
  await signIn(pb, TOKENS.bea);
  await pa.goto("/#/b/duo");
  await pb.goto("/#/b/duo");
  await expect(pa.getByRole("list", { name: /In this board/ })).toContainText("AB");
  await pb.getByRole("button", { name: "Add ellipse" }).click();
  await expect(item(pa, "Ellipse: Ellipse")).toBeVisible();
  // A change made outside the UI, such as an agent's call to the API, shows without a reload.
  await createClient({ baseUrl: API, token: TOKENS.bot }).addShape("duo", { id: "from-api", type: "sticky", x: 10, y: 10, text: "From the API" });
  await expect(item(pa, "Sticky note: From the API")).toBeVisible({ timeout: 15_000 });

  // A field the person did not touch follows the board: a save never writes an old text over an agent's edit.
  await item(pa, "Sticky note: From the API").focus();
  await expect(pa.getByLabel("Text", { exact: true })).toHaveValue("From the API");
  await createClient({ baseUrl: API, token: TOKENS.bot }).update("duo", "from-api", { text: "Agent v2" });
  await expect(pa.getByLabel("Text", { exact: true })).toHaveValue("Agent v2", { timeout: 15_000 });
  await pa.getByLabel("Width").fill("200");
  await pa.getByRole("button", { name: "Save changes" }).click();
  await saved(pa);
  await expect.poll(async () => (await createClient({ baseUrl: API, token: TOKENS.ada }).readBoard("duo")).nodes.find((n) => n.id === "from-api")?.text).toBe("Agent v2");
  await a.close();
  await b.close();
});
