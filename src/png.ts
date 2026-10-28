import { CanvasError } from "./core/board.js";

const MAX_SIDE = 16_384;
// One raw RGBA frame of this area is about 64 MB. A larger board exports as SVG.
const MAX_PIXELS = 16_000_000;
const TIMEOUT_MS = 20_000;

/**
 * Draw an SVG to PNG in a headless Chromium, through the optional
 * `playwright-core` package. The page runs with JavaScript off and service
 * workers blocked, and every network request is aborted, so a script planted in
 * the SVG cannot run and nothing leaves the machine. When the package or the
 * browser is missing, this throws.
 */
export async function svgToPng(svg: string): Promise<Uint8Array> {
  const size = /^<svg [^>]*?width="(\d+)" height="(\d+)"/.exec(svg);
  const width = Number(size?.[1]);
  const height = Number(size?.[2]);
  if (!(width > 0 && height > 0) || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    throw new CanvasError("LIMIT", `the board is too large for PNG: up to ${MAX_SIDE} px a side and ${MAX_PIXELS / 1e6} million pixels`);
  }
  let chromium: typeof import("playwright-core").chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    throw new CanvasError("UNAVAILABLE", "PNG export needs the playwright-core package. Install it, or export SVG.");
  }
  const browser = await chromium.launch().catch(() => {
    throw new CanvasError("UNAVAILABLE", "PNG export needs Chromium. Run: npx playwright-core install chromium");
  });
  try {
    const context = await browser.newContext({ viewport: { width, height }, javaScriptEnabled: false, serviceWorkers: "block" });
    context.setDefaultTimeout(TIMEOUT_MS);
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    await page.setContent(`<!doctype html><body style="margin:0">${svg}</body>`);
    return await page.screenshot({ clip: { x: 0, y: 0, width, height } });
  } finally {
    await browser.close();
  }
}
