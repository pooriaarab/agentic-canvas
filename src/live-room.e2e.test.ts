// End to end: the live room of a board, under `wrangler dev`.
//
// Failure cases, written before the Worker:
//  1. A room opens for a board that does not exist, or without a valid token.
//  2. A viewer token writes to a board, over HTTP or in the room.
//  3. A token with a role the Worker does not know is let in as an editor.
//  4. Two clients in one room do not converge.
//  5. A peer's kind is the kind it claims, not the kind of its token.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncClient } from "agentic-realtime/client";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { Board } from "./core/board.js";
import { startWorker, type RunningWorker } from "./wrangler-harness.js";

const PORT = 18820;
const HUMAN = "human-token-".padEnd(40, "h");
const BOT = "agent-token-".padEnd(40, "a");
const VIEWER = "viewer-token-".padEnd(40, "v");
const BAD_ROLE = "badrole-token-".padEnd(40, "b");
const tokens = JSON.stringify({
  [HUMAN]: { actor: "ada", kind: "human" },
  [BOT]: { actor: "helper", kind: "agent_of_human" },
  [VIEWER]: { actor: "eve", kind: "human", role: "viewer" },
  [BAD_ROLE]: { actor: "x", kind: "human", role: "owner" },
});
const OPEN = [`CANVAS_API_TOKENS:${tokens}`, "CANVAS_REGION:unknown"];
const persistTo = mkdtempSync(join(tmpdir(), "agentic-canvas-room-"));
let worker: RunningWorker | undefined;
const clients: SyncClient[] = [];

const call = (path: string, token: string | null, init: RequestInit = {}) =>
  fetch(`${worker!.url}${path}`, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" } });

async function enter(board: string, token: string): Promise<SyncClient> {
  const url = new URL(`${worker!.url}/boards/${board}/ws`);
  url.protocol = "ws:";
  const client = await SyncClient.connect({ url: url.toString(), headers: { authorization: `Bearer ${token}` }, presence: { name: "t" } });
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.disconnect()));
  await worker?.stop();
  worker = undefined;
});
afterAll(() => rmSync(persistTo, { recursive: true, force: true }));

describe("live room", () => {
  test("opens for known tokens and boards, converges, and keeps a viewer read-only", async () => {
    worker = await startWorker({ port: PORT, persistTo, vars: OPEN });
    expect((await call("/boards", HUMAN, { method: "POST", body: JSON.stringify({ id: "b1" }) })).status).toBe(201);

    // Who the token stands for.
    expect(await (await call("/me", BOT)).json()).toEqual({ actor: "helper", kind: "agent_of_human", role: "editor" });
    expect((await call("/me", BAD_ROLE)).status).toBe(401);
    expect((await call("/me", null)).status).toBe(401);

    // A viewer cannot write over HTTP.
    expect((await call("/boards/b1/shapes", VIEWER, { method: "POST", body: JSON.stringify({ type: "rect", x: 0, y: 0 }) })).status).toBe(403);

    // No room for a missing board, a bad id, or a bad token.
    await expect(enter("nope", HUMAN)).rejects.toThrow();
    await expect(enter("b1", "short")).rejects.toThrow();
    expect((await call("/boards/b1/ws", HUMAN)).status).toBe(426);

    const ada = await enter("b1", HUMAN);
    const bot = await enter("b1", BOT);
    const eve = await enter("b1", VIEWER);
    const adaBoard = new Board(ada.doc);
    const botBoard = new Board(bot.doc);
    adaBoard.addShape({ id: "s1", type: "rect", x: 0, y: 0 }, { kind: "human", id: "ada" });
    botBoard.addShape({ id: "s2", type: "ellipse", x: 50, y: 0 }, { kind: "agent_of_human", id: "helper" });
    await Promise.all([ada.flush(), bot.flush()]);
    await ada.flush();
    await bot.flush();
    for (const doc of [ada.doc, bot.doc, eve.doc]) expect(new Board(doc).list().map((e) => e.id).sort()).toEqual(["s1", "s2"]);

    // The viewer's write is dropped: nobody else sees it, and the client is told.
    new Board(eve.doc).addShape({ id: "s3", type: "rect", x: 9, y: 9 }, { kind: "human", id: "eve" });
    await eve.flush();
    await ada.flush();
    expect(eve.denied.length).toBeGreaterThan(0);
    expect(new Board(ada.doc).get("s3")).toBeUndefined();

    // The peers show the kind of the token, which a client cannot choose.
    expect(ada.peers.some((p) => p.kind === "agent_of_human" && p.machine)).toBe(true);
  }, 120_000);
});
