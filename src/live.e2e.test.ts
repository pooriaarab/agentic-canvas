// End to end: the live client and service against the real Worker under `wrangler dev`.
//
// Failure cases, written before the client:
//  1. A client edits as a kind it picked, not the kind of its token.
//  2. A missing board looks like a dead connection, or a bad token like a missing board.
//  3. Two clients, one of them the service an agent uses, do not converge on one board.
//  4. A viewer's edit is saved, or a viewer reads nothing.
//  5. A save that the server changed looks like a success, or the fix of another client's element fails a change.
//  6. A restart loses the board.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import * as Y from "yjs";
import { LiveBoard, LiveService, whoAmI } from "./live.js";
import { startWorker, type RunningWorker } from "./wrangler-harness.js";

const PORT = 18830;
const HUMAN = "human-token-".padEnd(40, "h");
const BOT = "agent-token-".padEnd(40, "a");
const VIEWER = "viewer-token-".padEnd(40, "v");
const vars = [`CANVAS_API_TOKENS:${JSON.stringify({ [HUMAN]: { actor: "ada", kind: "human" }, [BOT]: { actor: "helper", kind: "agent_of_human" }, [VIEWER]: { actor: "eve", kind: "human", role: "viewer" } })}`, "CANVAS_REGION:unknown"];
const persistTo = mkdtempSync(join(tmpdir(), "agentic-canvas-live-"));
let worker: RunningWorker | undefined;
const server = () => worker!.url.replace("/api/v1/canvas", "");
const ids = (data: { nodes: { id: string }[] }) => data.nodes.map((n) => n.id).sort();

/** Wait until `done` holds. The relay has no clock a test can read, so it polls with a limit. */
async function until(done: () => boolean, what: string): Promise<void> {
  for (const start = Date.now(); !done(); await new Promise((r) => setTimeout(r, 50))) {
    if (Date.now() - start > 10_000) throw new Error(`timed out waiting for ${what}`);
  }
}

afterEach(async () => {
  await worker?.stop();
  worker = undefined;
});
afterAll(() => rmSync(persistTo, { recursive: true, force: true }));

describe("live client", () => {
  test("a person and an agent edit one board, converge, and keep it over a restart", async () => {
    worker = await startWorker({ port: PORT, persistTo, vars });
    const human = new LiveService({ server: server(), token: HUMAN });
    const agent = new LiveService({ server: server(), token: BOT });

    expect(await whoAmI(server(), BOT)).toEqual({ actor: { kind: "agent_of_human", id: "helper" }, role: "editor" });
    expect(await human.create({ kind: "human", id: "ignored" }, { id: "b1", title: "Plan" })).toEqual({ id: "b1", title: "Plan" });
    await expect(human.create({ kind: "human", id: "x" }, { id: "b1" })).rejects.toMatchObject({ code: "DUPLICATE_ID" });
    await expect(human.read("nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(new LiveService({ server: server(), token: "x".repeat(40) }).read("b1")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(new LiveService({ server: "http://127.0.0.1:1", token: HUMAN }).read("b1")).rejects.toMatchObject({ code: "UNAVAILABLE" });

    // Two clients write at once. The actor is the token's, whatever the caller passes.
    const [a, b] = await Promise.all([
      human.add("b1", { id: "h1", type: "rect", x: 0, y: 0, text: "mine" }, { kind: "agent", id: "liar" }),
      agent.add("b1", { id: "a1", type: "ellipse", x: 100, y: 0 }),
    ]);
    expect([a.id, b.id]).toEqual(["h1", "a1"]);
    await agent.connect("b1", { id: "c1", from: { id: "h1" }, to: { id: "a1" }, text: "to" });
    await human.move("b1", "a1", 5, 5);
    await agent.flow("b1", "X -> Y", undefined, { idPrefix: "f-" });
    const data = await human.read("b1");
    expect(ids(data)).toEqual(["a1", "f-X", "f-Y", "h1"]);
    expect(data.edges.map((e) => e.id).sort()).toEqual(["c1", "f-edge_1"]);
    expect(data.nodes.find((n) => n.id === "h1")).toMatchObject({ machineMade: false, author: { kind: "human", id: "ada" } });
    expect(data.nodes.find((n) => n.id === "a1")).toMatchObject({ machineMade: true, lastEditMachineMade: false, author: { kind: "agent_of_human", id: "helper" }, x: 105 });
    expect(await agent.exportSvg("b1")).toContain("<svg");
    expect(await human.remove("b1", "f-X")).toMatchObject({ removed: expect.arrayContaining(["f-X"]) });

    // Two open rooms converge, and a viewer reads but cannot write.
    const one = await LiveBoard.join({ server: server(), board: "b1", token: HUMAN });
    const two = await LiveBoard.join({ server: server(), board: "b1", token: BOT });
    const eve = await LiveBoard.join({ server: server(), board: "b1", token: VIEWER });
    await one.edit((board, actor) => board.addShape({ id: "live1", type: "sticky", x: 1, y: 1 }, actor));
    await until(() => two.board.get("live1") !== undefined, "the agent's room to get the sticky");
    await two.edit((board, actor) => board.update("live1", { text: "agent was here" }, actor));
    for (const doc of [one.board, two.board, eve.board]) await until(() => (doc.get("live1") as { text?: string } | undefined)?.text === "agent was here", "the rooms to converge");
    await until(() => two.peers.some((p) => p.kind === "human"), "the agent to see the person in the room");
    await expect(eve.edit((board, actor) => board.addShape({ type: "rect", x: 0, y: 0 }, actor))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(eve.save()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(new LiveService({ server: server(), token: VIEWER }).add("b1", { type: "rect", x: 0, y: 0 })).rejects.toMatchObject({ code: "FORBIDDEN" });

    // A save the server changed is reported. Raw Yjs cannot put a person on an agent's element.
    two.board.doc.getMap<Y.Map<unknown>>("elements").get("a1")!.set("author", { kind: "human", id: "ada" });
    expect((await two.save()).fixed).toEqual(["a1"]);
    await one.save(); // the relay may have sent the forged stamp to this room too: its save is checked the same way
    // Another client's forged stamp is fixed by the next save, and that is no failure of a change that did not touch it.
    one.board.doc.getMap<Y.Map<unknown>>("elements").get("h1")!.set("editedBy", { kind: "human", id: "mallory" });
    await one.flush();
    expect(await agent.move("b1", "a1", 1, 1)).toEqual({ moved: ["a1"] });
    await Promise.all([one.leave(), two.leave(), eve.leave()]);
    expect((await human.read("b1")).nodes.find((n) => n.id === "a1")).toMatchObject({ machineMade: true });

    // A restart keeps the board, in the room and in the store.
    await worker.stop();
    worker = await startWorker({ port: PORT, persistTo, vars });
    const after = await agent.read("b1");
    expect(ids(after)).toEqual(["a1", "f-Y", "h1", "live1"]);
    expect(after.title).toBe("Plan");
  }, 240_000);
});
