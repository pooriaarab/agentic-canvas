// End to end: the remote client against the real Worker under `wrangler dev`.
//
// Failure cases, written before the client:
//  1. A wrong token or a missing token comes back as a generic error, not code UNAUTHORIZED with status 401.
//  2. A missing board comes back as a success, or as an error without the code NOT_FOUND and status 404.
//  3. An id with a slash reaches another route.
//  4. An abort is turned into an API error, or does not stop the call.
//  5. A network failure is not told apart from an API error.
//  6. A viewer's write is not refused with FORBIDDEN.
//  7. The client retries a write, so one call adds two shapes.
//  8. The built client imports a Node module and fails in a browser or a Worker.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Board } from "./core/board.js";
import { CanvasApiError, createClient } from "./client.js";
import { startWorker, type RunningWorker } from "./wrangler-harness.js";

const PORT = 18850;
const HUMAN = "human-token-".padEnd(40, "h");
const BOT = "agent-token-".padEnd(40, "a");
const VIEWER = "viewer-token-".padEnd(40, "v");
const tokens = JSON.stringify({
  [HUMAN]: { actor: "ada", kind: "human" },
  [BOT]: { actor: "helper", kind: "agent_of_human" },
  [VIEWER]: { actor: "vic", kind: "human", role: "viewer" },
});
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const persistTo = mkdtempSync(join(tmpdir(), "agentic-canvas-client-"));
let worker: RunningWorker;

beforeAll(async () => {
  worker = await startWorker({ port: PORT, persistTo, vars: [`CANVAS_API_TOKENS:${tokens}`, "CANVAS_REGION:unknown"] });
}, 120_000);

afterAll(async () => {
  await worker?.stop();
  rmSync(persistTo, { recursive: true, force: true });
});

const failure = async (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error);

describe("the remote client", () => {
  test("reaches every route, and keeps the author kind", async () => {
    const human = createClient({ baseUrl: worker.url, token: HUMAN });
    const bot = createClient({ baseUrl: worker.url, token: BOT });
    expect(await human.me()).toEqual({ actor: "ada", kind: "human", role: "editor" });

    expect(await human.createBoard({ id: "c1", title: "Plan" })).toEqual({ id: "c1", title: "Plan" });
    const a = await human.addShape("c1", { id: "a", type: "rect", x: 0, y: 0, text: "Start" });
    expect(a).toMatchObject({ id: "a", author: { kind: "human", id: "ada" } });
    const b = await bot.addShape("c1", { id: "b", type: "diamond", x: 200, y: 0, text: "Ok?" });
    expect(b.author).toEqual({ kind: "agent_of_human", id: "helper" });
    expect(await bot.addConnector("c1", { id: "e", from: { id: "a" }, to: { id: "b" }, text: "next" })).toMatchObject({ type: "connector", id: "e" });
    const flow = await bot.drawFlow("c1", "X -> Y: go");
    expect(flow.nodes).toHaveLength(2);
    expect(flow.edges).toHaveLength(1);
    expect(await human.move("c1", "a", 5, 5)).toEqual({ moved: ["a"] });
    expect(await human.update("c1", "a", { w: 240, text: "Begin" })).toMatchObject({ w: 240, text: "Begin", author: { kind: "human" }, editedBy: { kind: "human" } });
    expect(await human.listBoards()).toEqual({ boards: [{ id: "c1", title: "Plan" }] });

    const read = await human.readBoard("c1");
    expect(read.title).toBe("Plan");
    expect(read.nodes.find((n) => n.id === "b")).toMatchObject({ machineMade: true });
    expect(read.nodes.find((n) => n.id === "a")).toMatchObject({ machineMade: false, lastEditMachineMade: false });
    expect(await human.exportSvg("c1")).toContain("<svg");

    expect(await human.remove("c1", "e")).toEqual({ removed: ["e"] });
    expect((await human.readBoard("c1")).edges.find((e) => e.id === "e")).toBeUndefined();

    const image = await human.uploadImage(PNG);
    expect(image).toMatchObject({ type: "image/png", size: PNG.length, created: true });
    expect(await human.uploadImage(PNG)).toMatchObject({ id: image.id, created: false });
    const got = await human.getImage(image.id);
    expect([...got.bytes]).toEqual([...PNG]);
    expect(got.type).toBe("image/png");
    expect(await human.addShape("c1", { type: "image", x: 0, y: 0, w: 20, h: 20, src: image.ref })).toMatchObject({ src: image.ref });
  }, 120_000);

  test("refuses an empty patch, a missing element, and a viewer's edit", async () => {
    const human = createClient({ baseUrl: worker.url, token: HUMAN });
    const viewer = createClient({ baseUrl: worker.url, token: VIEWER });
    expect(await failure(human.update("c1", "a", {}))).toMatchObject({ code: "INVALID", status: 422 });
    expect(await failure(human.update("c1", "nope", { w: 5 }))).toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(await failure(viewer.update("c1", "a", { w: 5 }))).toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect((await viewer.listBoards()).boards.length).toBeGreaterThan(0);
  }, 120_000);

  test("reads the Yjs state and saves a room back", async () => {
    const human = createClient({ baseUrl: worker.url, token: HUMAN });
    await human.createBoard({ id: "c2" });
    await human.addShape("c2", { id: "s", type: "rect", x: 0, y: 0 });
    const state = await human.state("c2");
    const doc = Board.open(state);
    expect(doc.list().map((e) => e.id)).toEqual(["s"]);
    expect(await human.checkpoint("c2", doc.encode())).toEqual({ elements: 1, fixed: [] });
  }, 120_000);

  test("throws a typed error for a bad token, a missing board, a bad value, and a viewer write", async () => {
    const human = createClient({ baseUrl: worker.url, token: HUMAN });
    const bad = await failure(createClient({ baseUrl: worker.url, token: "x".repeat(40) }).readBoard("c1"));
    expect(bad).toBeInstanceOf(CanvasApiError);
    expect(bad).toMatchObject({ code: "UNAUTHORIZED", status: 401 });

    const missing = await failure(human.readBoard("nope"));
    expect(missing).toBeInstanceOf(CanvasApiError);
    expect(missing).toMatchObject({ code: "NOT_FOUND", status: 404, message: expect.stringContaining("nope") });
    expect(await failure(human.getImage("0".repeat(64)))).toMatchObject({ code: "NOT_FOUND", status: 404 });

    expect(await failure(human.createBoard({ id: "c1" }))).toMatchObject({ code: "DUPLICATE_ID", status: 409 });
    expect(await failure(human.addShape("c1", { type: "bogus" as never, x: 0, y: 0 }))).toMatchObject({ code: "INVALID", status: 422 });
    // An id with a slash stays one path segment: the Worker refuses it as a bad id, and it never reaches another route.
    expect(await failure(human.readBoard("a/svg"))).toMatchObject({ status: 422 });

    const viewer = createClient({ baseUrl: worker.url, token: VIEWER });
    expect((await viewer.readBoard("c1")).title).toBe("Plan");
    expect(await failure(viewer.addShape("c1", { type: "rect", x: 0, y: 0 }))).toMatchObject({ code: "FORBIDDEN", status: 403 });

    expect(await failure(human.state("nope"))).toMatchObject({ code: "NOT_FOUND", status: 404 });
  }, 120_000);

  test("stops on an abort, tells a network failure apart, and never retries", async () => {
    const human = createClient({ baseUrl: worker.url, token: HUMAN });
    const controller = new AbortController();
    controller.abort();
    const aborted = await failure(human.readBoard("c1", { signal: controller.signal }));
    expect(aborted).not.toBeInstanceOf(CanvasApiError);
    expect((aborted as Error).name).toBe("AbortError");

    const down = await failure(createClient({ baseUrl: "http://127.0.0.1:1", token: HUMAN }).me());
    expect(down).toMatchObject({ code: "NETWORK", status: 0 });

    let calls = 0;
    const flaky = createClient({
      baseUrl: worker.url,
      token: HUMAN,
      fetch: async () => (calls++, new Response(JSON.stringify({ error: { code: "UNAVAILABLE", message: "busy" } }), { status: 503 })),
    });
    expect(await failure(flaky.addShape("c1", { type: "rect", x: 0, y: 0 }))).toMatchObject({ code: "UNAVAILABLE", status: 503 });
    expect(calls).toBe(1);
    const html = createClient({ baseUrl: worker.url, token: HUMAN, fetch: async () => new Response("<html>", { status: 200 }) });
    expect(await failure(html.me())).toMatchObject({ code: "HTTP_ERROR", status: 200 });
    const odd = createClient({ baseUrl: worker.url, token: HUMAN, fetch: async () => new Response("<html>", { status: 502 }) });
    expect(await failure(odd.me())).toMatchObject({ code: "HTTP_ERROR", status: 502 });
  });

  test("the built client has no Node imports", () => {
    // `ci:local` builds first, so a missing file is a failure.
    const built = readFileSync(new URL("../dist/client.js", import.meta.url), "utf8");
    expect(built).not.toMatch(/\bimport\b/);
    expect(built).not.toMatch(/\brequire\(/);
  });
});
