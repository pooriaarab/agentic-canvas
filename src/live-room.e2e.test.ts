// End to end: the live room of a board, under `wrangler dev`.
//
// Failure cases, written before the Worker:
//  1. A room opens for a board that does not exist, or without a valid token.
//  2. A viewer writes to a board, or a token with an unknown role gets in as an editor.
//  3. Two clients in one room do not converge.
//  4. A peer's kind comes from its token, never from the client.
//  5. A room is not saved to the board, a save keeps an element stamped with a person who never wrote, or a viewer saves.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
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

/** Wait until `done` holds. The relay has no clock a test can read, so it polls with a limit. */
async function until(done: () => boolean, what: string): Promise<void> {
  for (const start = Date.now(); !done(); await new Promise((r) => setTimeout(r, 50))) {
    if (Date.now() - start > 10_000) throw new Error(`timed out waiting for ${what}`);
  }
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

    expect(await (await call("/me", BOT)).json()).toEqual({ actor: "helper", kind: "agent_of_human", role: "editor" });
    expect((await call("/me", BAD_ROLE)).status).toBe(401);
    expect((await call("/me", null)).status).toBe(401);

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
    const ids = (doc: Y.Doc) => new Board(doc).list().map((e) => e.id).sort().join();
    await until(() => [ada.doc, bot.doc, eve.doc].every((doc) => ids(doc) === "s1,s2"), "the three clients to converge");

    // The viewer's write is dropped: nobody else sees it, and the client is told.
    new Board(eve.doc).addShape({ id: "s3", type: "rect", x: 9, y: 9 }, { kind: "human", id: "eve" });
    await eve.flush();
    await until(() => eve.denied.length > 0, "the room to refuse the viewer");
    await ada.flush();
    expect(eve.denied.length).toBeGreaterThan(0);
    expect(new Board(ada.doc).get("s3")).toBeUndefined();

    // The peers show the kind of the token, which a client cannot choose.
    expect(ada.peers.some((p) => p.kind === "agent_of_human" && p.machine)).toBe(true);

    // Saving the room puts both shapes in the stored board. A viewer cannot save.
    const save = (token: string, doc: Y.Doc) => call("/boards/b1/checkpoint", token, { method: "POST", body: Y.encodeStateAsUpdate(doc) as BodyInit });
    expect((await save(VIEWER, eve.doc)).status).toBe(403);
    expect((await save(HUMAN, ada.doc)).status).toBe(200);
    const stored = await (await call("/boards/b1", HUMAN)).json();
    expect(stored.nodes.map((n: { id: string }) => n.id).sort()).toEqual(["s1", "s2"]);
    expect(stored.nodes.find((n: { id: string }) => n.id === "s2")).toMatchObject({ machineMade: true, author: { kind: "agent_of_human", id: "helper" } });

    // A client that writes raw Yjs puts a person on an element it made. The save stamps the element with the principal the room heard it from.
    bot.doc.getMap<Y.Map<unknown>>("elements").set("fake", new Y.Map(Object.entries({ id: "fake", type: "rect", x: 0, y: 0, w: 5, h: 5, text: "", z: 9, author: { kind: "human", id: "mallory" }, editedBy: { kind: "human", id: "mallory" } })));
    // It also claims Ada's edit on her shape: Ada is in the room, so the old rule would have trusted the claim.
    bot.doc.getMap<Y.Map<unknown>>("elements").get("s1")!.set("text", "bot text");
    bot.doc.getMap<Y.Map<unknown>>("elements").get("s1")!.set("editedBy", { kind: "human", id: "ada" });
    await bot.flush();
    const forged = await save(BOT, bot.doc);
    expect((await forged.json()).fixed).toEqual(["fake", "s1"]);
    const nodes = (await (await call("/boards/b1", HUMAN)).json()).nodes;
    expect(nodes.map((n: { id: string }) => n.id).sort()).toEqual(["fake", "s1", "s2"]);
    expect(nodes.find((n: { id: string }) => n.id === "fake")).toMatchObject({ machineMade: true, author: { kind: "agent_of_human", id: "helper" }, editedBy: { kind: "agent_of_human", id: "helper" } });
    expect(nodes.find((n: { id: string }) => n.id === "s1")).toMatchObject({ text: "bot text", author: { kind: "human", id: "ada" }, editedBy: { kind: "agent_of_human", id: "helper" }, lastEditMachineMade: true });
    expect((await call("/boards/nope/checkpoint", BOT, { method: "POST", body: Y.encodeStateAsUpdate(bot.doc) as BodyInit })).status).toBe(404);
  }, 120_000);

  test("the Worker seeds a room from the Store and saves the room back, with no help from the client", async () => {
    worker = await startWorker({ port: PORT + 1, persistTo, vars: OPEN });
    await call("/boards", HUMAN, { method: "POST", body: JSON.stringify({ id: "b2" }) });
    // A change over HTTP, before any room exists.
    await call("/boards/b2/shapes", HUMAN, { method: "POST", body: JSON.stringify({ id: "rest1", type: "rect", x: 0, y: 0 }) });

    // A raw client joins and sees it: the Worker seeded the room. The seed is no author of the board.
    const ada = await enter("b2", HUMAN);
    await until(() => new Board(ada.doc).get("rest1") !== undefined, "the room to hold the stored shape");
    expect(new Board(ada.doc).get("rest1")).toMatchObject({ author: { kind: "human", id: "ada" } });
    new Board(ada.doc).addShape({ id: "live1", type: "ellipse", x: 5, y: 5 }, { kind: "human", id: "ada" });
    await ada.flush();

    // The next HTTP call sees the room's edit, with no checkpoint. Then it changes the board, and the room gets that.
    const read = await (await call("/boards/b2", HUMAN)).json();
    expect(read.nodes.map((n: { id: string }) => n.id).sort()).toEqual(["live1", "rest1"]);
    await call("/boards/b2/shapes", BOT, { method: "POST", body: JSON.stringify({ id: "rest2", type: "rect", x: 9, y: 9 }) });
    await call("/boards/b2/elements/rest1", HUMAN, { method: "DELETE" });
    await clients.splice(0)[0]!.disconnect();
    const bob = await enter("b2", BOT);
    await until(() => new Board(bob.doc).list().map((e) => e.id).sort().join() === "live1,rest2", "the room to take the HTTP changes");
    new Board(bob.doc).addShape({ id: "live2", type: "rect", x: 1, y: 1 }, { kind: "agent_of_human", id: "helper" });
    await bob.flush();

    // The seeder is in the room's log, but it is no author: a hand save refuses a stamp that names it.
    bob.doc.getMap<Y.Map<unknown>>("elements").set("seedfake", new Y.Map(Object.entries({ id: "seedfake", type: "rect", x: 0, y: 0, w: 5, h: 5, text: "", z: 9, author: { kind: "agent", id: "canvas-room" }, editedBy: { kind: "agent", id: "canvas-room" } })));
    await bob.flush();
    const forgedSave = await call("/boards/b2/checkpoint", BOT, { method: "POST", body: Y.encodeStateAsUpdate(bob.doc) as BodyInit });
    expect((await forgedSave.json()).fixed).toContain("seedfake");

    // Restart: the edit that only the room has (live2) is in the Store after the next request, and the seeder never shows as an author.
    await worker.stop();
    worker = await startWorker({ port: PORT + 1, persistTo, vars: OPEN });
    const after = await (await call("/boards/b2", HUMAN)).json();
    expect(after.nodes.map((n: { id: string }) => n.id).sort()).toEqual(["live1", "live2", "rest2", "seedfake"]);
    // The forged seeder stamp is the sender's own: the save stamped it with the agent that wrote it.
    expect(after.nodes.find((n: { id: string }) => n.id === "seedfake")).toMatchObject({ author: { kind: "agent_of_human", id: "helper" } });
    expect(JSON.stringify(after)).not.toContain("canvas-room");
    expect(after.nodes.find((n: { id: string }) => n.id === "live2")).toMatchObject({ machineMade: true, author: { kind: "agent_of_human", id: "helper" } });
  }, 180_000);

  test("a room that fails its checks does not lock the board or keep a client out", async () => {
    worker = await startWorker({ port: PORT + 2, persistTo, vars: OPEN });
    await call("/boards", HUMAN, { method: "POST", body: JSON.stringify({ id: "b3" }) });
    const bot = await enter("b3", BOT);
    // A root type of its own makes every save of this room fail, and the room keeps it.
    bot.doc.getMap("junk").set("a", 1);
    await bot.flush();
    await call("/boards/b3/shapes", HUMAN, { method: "POST", body: JSON.stringify({ id: "rest1", type: "rect", x: 0, y: 0 }) });
    expect((await call("/boards/b3", HUMAN)).status).toBe(200);
    const late = await enter("b3", HUMAN);
    await until(() => new Board(late.doc).get("rest1") !== undefined, "the room to take the HTTP change");
  }, 120_000);

  test("a join is refused, not opened empty, when the stored board is too big to seed", async () => {
    worker = await startWorker({ port: PORT + 3, persistTo, vars: OPEN });
    await call("/boards", HUMAN, { method: "POST", body: JSON.stringify({ id: "b4" }) });
    // Random text does not compress: 110 elements of 10,000 characters pass the 1,000,000 bytes one seed message may hold.
    const big = new Board();
    const random = () => Array.from(crypto.getRandomValues(new Uint8Array(5000)), (v) => v.toString(16).padStart(2, "0")).join("");
    for (let i = 0; i < 110; i++) big.addShape({ id: `s${i}`, type: "sticky", x: 0, y: 0, text: random() }, { kind: "human", id: "ada" });
    expect((await call("/boards/b4/checkpoint", HUMAN, { method: "POST", body: big.encode() as BodyInit })).status).toBe(200);
    await expect(enter("b4", HUMAN)).rejects.toThrow();
    expect((await call("/boards/b4", HUMAN)).status).toBe(200);
  }, 120_000);
});
