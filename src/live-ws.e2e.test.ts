// End to end: the WebSocket handshake of `/boards/:id/ws`, under `wrangler dev`.
//
// Failure cases, written before the tests: a good sub-protocol token does not get 101, a missing or bad token gets
// in, a token over 512 characters or with a character outside the charset gets in, or an actor id over 128 characters
// is stamped on a board.
import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { startWorker, type RunningWorker } from "./wrangler-harness.js";

const PORT = 18860;
const b64 = (text: string) => btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const TOKEN = "human-token-".padEnd(40, "h");
const LONG_OK = "L".repeat(512);
const LONG_BAD = "L".repeat(513);
const ODD = "odd.token-".padEnd(40, "o");
const ACTOR_OK = "a".repeat(128);
const ACTOR_BAD = "a".repeat(129);
const LONG_ACTOR_OK = "actor-ok-".padEnd(40, "k");
const LONG_ACTOR_BAD = "actor-bad-".padEnd(40, "x");
const tokens = JSON.stringify({
  [TOKEN]: { actor: "ada", kind: "human" },
  [LONG_OK]: { actor: "long", kind: "human" },
  [LONG_BAD]: { actor: "toolong", kind: "human" },
  [ODD]: { actor: "odd", kind: "human" },
  [LONG_ACTOR_OK]: { actor: ACTOR_OK, kind: "human" },
  [LONG_ACTOR_BAD]: { actor: ACTOR_BAD, kind: "human" },
});
const persistTo = mkdtempSync(join(tmpdir(), "agentic-canvas-ws-"));
let worker: RunningWorker | undefined;

afterEach(async () => {
  await worker?.stop();
  worker = undefined;
});
afterAll(() => rmSync(persistTo, { recursive: true, force: true }));

/** Ask for the upgrade by hand and return the status of the answer: 101 when the socket opens. */
function handshake(protocol: string | null): Promise<{ status: number; protocol?: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      port: PORT,
      host: "127.0.0.1",
      path: "/api/v1/canvas/boards/b1/ws",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": Buffer.from("0123456789abcdef").toString("base64"),
        ...(protocol === null ? {} : { "sec-websocket-protocol": protocol }),
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode ?? 0, protocol: res.headers["sec-websocket-protocol"] as string | undefined });
    });
    req.on("response", (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
    });
    req.on("error", reject);
    req.end();
  });
}
const offer = (token: string) => `agentic-canvas, agentic-canvas.bearer.${b64(token)}`;

describe("live room handshake", () => {
  test("answers 101 for a good token, and 401 for a missing, bad, long or odd token", async () => {
    worker = await startWorker({ port: PORT, persistTo, vars: [`CANVAS_API_TOKENS:${tokens}`, "CANVAS_REGION:unknown"] });
    const made = await fetch(`${worker.url}/boards`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ id: "b1" }) });
    expect(made.status).toBe(201);

    const good = await handshake(offer(TOKEN));
    expect(good.status).toBe(101);
    expect(good.protocol).toBe("agentic-canvas");

    expect((await handshake(null)).status).toBe(401);
    expect((await handshake("agentic-canvas")).status).toBe(401);
    expect((await handshake(offer("u".repeat(40)))).status).toBe(401);

    // The token limit is 512 characters. The charset is A-Z, a-z, 0-9, "_" and "-".
    expect((await handshake(offer(LONG_OK))).status).toBe(101);
    expect((await handshake(offer(LONG_BAD))).status).toBe(401);
    expect((await handshake(offer(ODD))).status).toBe(401);

    // The actor id limit is 128 characters. A longer id denies the token.
    expect((await handshake(offer(LONG_ACTOR_OK))).status).toBe(101);
    expect((await handshake(offer(LONG_ACTOR_BAD))).status).toBe(401);
  }, 60_000);
});
