import { CanvasError } from "./core/board.js";

const MAX_SIDE = 16_384;

/**
 * Draw an SVG to PNG in a headless Chromium, through the optional
 * `playwright-core` package. Every network request is blocked, so nothing leaves
 * the machine. When the package or the browser is missing, this throws.
 */
export async function svgToPng(svg: string): Promise<Uint8Array> {
  const size = /width="(\d+)" height="(\d+)"/.exec(svg);
  const width = Number(size?.[1]);
  const height = Number(size?.[2]);
  if (!(width > 0 && height > 0) || width > MAX_SIDE || height > MAX_SIDE) {
    throw new CanvasError("LIMIT", `the board is too large for PNG: each side must be up to ${MAX_SIDE} px`);
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
    const page = await browser.newPage({ viewport: { width, height } });
    await page.route("**/*", (route) => route.abort());
    await page.setContent(`<!doctype html><body style="margin:0">${svg}</body>`);
    return await page.screenshot({ clip: { x: 0, y: 0, width, height } });
  } finally {
    await browser.close();
  }
}
