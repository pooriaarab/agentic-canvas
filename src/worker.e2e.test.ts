// End to end: two Workers on one local D1 database and one local R2 bucket, under `wrangler dev`.
//
// Failure cases, written before the Worker:
//  1. Data written through one Worker is not visible through the other.
//  2. A restart loses boards or images.
//  3. Many writes at once through two Workers lose a shape.
//  4. A Worker without a region, or with "EU", serves requests anyway. A Worker that claims "eu" serves from a local
//     database that cannot confirm where it runs.
//  5. No token, a short token, or a grant without a kind gets in.
//  6. An agent's edit loses its author kind, or the board labels it as made by a person.
//  7. An image of another type, or one over the limit, is stored. Two uploads of the same bytes make two objects, or the second fails.
//  8. A board id or an image id the store would refuse ends as a 500.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { startWorker, type RunningWorker } from "./wrangler-harness.js";

const A = 18810;
const B = 18811;
const HUMAN = "human-token-".padEnd(40, "h");
const BOT = "agent-token-".padEnd(40, "a");
const NO_KIND = "nokind-token-".padEnd(40, "n");
const SHORT = "short";
const tokens = JSON.stringify({
  [HUMAN]: { actor: "ada", kind: "human" },
  [BOT]: { actor: "helper", kind: "agent_of_human" },
  [NO_KIND]: { actor: "x" },
  [SHORT]: { actor: "s", kind: "human" },
});
const OPEN = [`CANVAS_API_TOKENS:${tokens}`, "CANVAS_REGION:unknown", "CANVAS_MAX_IMAGE_BYTES:2000"];
const persistTo = mkdtempSync(join(tmpdir(), "agentic-canvas-worker-"));
let running: RunningWorker[] = [];
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

async function call(worker: RunningWorker, method: string, path: string, options: { token?: string | null; json?: unknown; body?: Uint8Array } = {}) {
  const token = options.token === undefined ? HUMAN : options.token;
  const response = await fetch(`${worker.url}${path}`, {
    method,
    signal: AbortSignal.timeout(30_000),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(options.json === undefined ? {} : { "content-type": "application/json" }) },
    body: options.json === undefined ? (options.body as BodyInit | undefined) : JSON.stringify(options.json),
  });
  const raw = new Uint8Array(await response.arrayBuffer());
  let body: any;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    body = undefined;
  }
  return { status: response.status, body, raw, headers: response.headers };
}

afterEach(async () => {
  await Promise.all(running.map((w) => w.stop()));
  running = [];
});

afterAll(async () => {
  rmSync(persistTo, { recursive: true, force: true });
});

describe("two Workers on one D1 database and one R2 bucket", () => {
  test("share boards and images, keep the author kind, survive a restart, and lose no concurrent write", async () => {
    running = [await startWorker({ port: A, persistTo, vars: OPEN }), await startWorker({ port: B, persistTo, vars: OPEN })];
    const [one, two] = running as [RunningWorker, RunningWorker];

    expect((await call(one, "POST", "/boards", { json: { id: "b1", title: "Plan" } })).status).toBe(201);
    expect((await call(two, "POST", "/boards", { json: { id: "b1" } })).status).toBe(409);
    expect((await call(two, "GET", "/boards/b1")).body.title).toBe("Plan");

    // An agent draws. The label says machine-made, and the author kind stays.
    const shape = { type: "rect", x: 0, y: 0, w: 50, h: 30, text: "hi" };
    const added = await call(two, "POST", "/boards/b1/shapes", { token: BOT, json: shape });
    expect(added.status).toBe(201);
    const mine = await call(one, "POST", "/boards/b1/shapes", { json: { ...shape, text: "mine" } });
    const read = (await call(one, "GET", "/boards/b1")).body;
    const byId = (id: string) => read.nodes.find((n: any) => n.id === id);
    expect(byId(added.body.id)).toMatchObject({ machineMade: true, author: { kind: "agent_of_human", id: "helper" } });
    expect(byId(mine.body.id)).toMatchObject({ machineMade: false, author: { kind: "human" } });
    const moved = await call(two, "POST", "/boards/b1/move", { token: BOT, json: { element: mine.body.id, dx: 5, dy: 5 } });
    expect(moved.status).toBe(200);
    expect((await call(one, "GET", "/boards/b1")).body.nodes.find((n: any) => n.id === mine.body.id)).toMatchObject({ machineMade: false, lastEditMachineMade: true, author: { kind: "human" } });

    // Six adds at once, three through each Worker (local D1 refuses more than that at once). Every one lands.
    // A busy database answers 503, and the caller tries again. A try that got 201 must show on the board.
    const retrying = async (worker: RunningWorker, path: string, options: Parameters<typeof call>[3]) => {
      for (let tries = 0; ; tries++) {
        const r = await call(worker, "POST", path, options);
        if (r.status !== 503 || tries === 10) return r;
      }
    };
    const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => retrying(i % 2 ? one : two, "/boards/b1/shapes", { json: { ...shape, text: `n${i}` } })));
    expect(burst.map((r) => r.status)).toEqual(Array(6).fill(201));
    expect((await call(one, "GET", "/boards/b1")).body.nodes).toHaveLength(8);

    // Images: the bytes go to R2 once, and a board shape points at them.
    const first = await call(one, "POST", "/images", { body: PNG });
    expect(first).toMatchObject({ status: 201, body: { created: true, type: "image/png", size: PNG.length } });
    const again = await call(two, "POST", "/images", { body: PNG });
    expect(again).toMatchObject({ status: 200, body: { id: first.body.id, created: false } });
    const race = await Promise.all(Array.from({ length: 6 }, (_, i) => retrying(i % 2 ? one : two, "/images", { body: Uint8Array.from([...PNG, 9]) })));
    expect(race.filter((r) => r.status === 201)).toHaveLength(1);
    expect(race.filter((r) => r.status === 200)).toHaveLength(5);
    expect((await call(one, "POST", "/boards/b1/shapes", { json: { type: "image", x: 0, y: 0, w: 20, h: 20, src: first.body.ref } })).status).toBe(201);
    const fetched = await call(two, "GET", `/images/${first.body.id}`);
    expect(fetched.status).toBe(200);
    expect([...fetched.raw]).toEqual([...PNG]);
    expect(fetched.headers.get("content-type")).toBe("image/png");
    expect(fetched.headers.get("x-content-type-options")).toBe("nosniff");

    // A restart keeps boards and images.
    await Promise.all(running.map((w) => w.stop()));
    running = [await startWorker({ port: A, persistTo, vars: OPEN })];
    const [again1] = running as [RunningWorker];
    expect((await call(again1, "GET", "/boards/b1")).body.nodes).toHaveLength(9);
    expect([...(await call(again1, "GET", `/images/${first.body.id}`)).raw]).toEqual([...PNG]);
  }, 240_000);

  test("refuse a bad image, a bad id, a bad token, and a missing region", async () => {
    const [w] = (running = [await startWorker({ port: A, persistTo, vars: OPEN })]);
    expect((await call(w, "POST", "/images", { body: new TextEncoder().encode("<svg onload=alert(1)>") })).status).toBe(415);
    expect((await call(w, "POST", "/images", { body: new Uint8Array(3000).fill(1) })).status).toBe(413);
    expect((await call(w, "GET", "/images/..%2f..%2fx")).status).toBe(404);
    expect((await call(w, "GET", "/images/" + "0".repeat(64))).status).toBe(404);
    expect((await call(w, "GET", "/boards/__x__")).status).toBe(422);
    expect((await call(w, "GET", "/boards/nope")).status).toBe(404);
    for (const token of [null, "wrong", SHORT, NO_KIND]) expect((await call(w, "GET", "/boards/b1", { token })).status).toBe(401);
    await w.stop();
    for (const region of [undefined, "EU"]) {
      const vars = OPEN.filter((v) => !v.startsWith("CANVAS_REGION")).concat(region === undefined ? [] : [`CANVAS_REGION:${region}`]);
      const [bad] = (running = [await startWorker({ port: A, persistTo, vars })]);
      expect((await call(bad, "GET", "/boards/b1")).status).toBe(503);
      await bad.stop();
    }
    // Local D1 does not say where it runs, so a claim of "eu" cannot be confirmed. The adapter refuses, and so does the Worker.
    const [claim] = (running = [await startWorker({ port: A, persistTo, vars: OPEN.filter((v) => !v.startsWith("CANVAS_REGION")).concat("CANVAS_REGION:eu") })]);
    expect((await call(claim, "GET", "/boards/b1")).status).toBe(500);
    expect(claim.log()).not.toContain("b1");
  }, 240_000);
});
