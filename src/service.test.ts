// Service-level tests. They run the real service over the real file store, with no mock.
//
// Failure-mode list. These were written before the owner repair check on the actor.
//  1. A human actor with no id, an empty id, or an extra field is refused as INVALID.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import * as Y from "yjs";
import { Board } from "./core/board.js";
import type { Principal } from "./core/principal.js";
import { CanvasService } from "./service.js";
import { openLocalStore } from "./store-file.js";

const root = mkdtempSync(join(tmpdir(), "canvas-service-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const human: Principal = { kind: "human", id: "ada" };

describe("owner repair actor", () => {
  test.each([
    ["a missing id", { kind: "human" }],
    ["an empty id", { kind: "human", id: "" }],
    ["an extra field", { kind: "human", id: "ada", role: "owner" }],
  ])("%s is refused as INVALID", async (_name, actor) => {
    const service = new CanvasService(openLocalStore(join(root, `s${n++}`)));
    await service.create(human, { id: "b" });
    await expect(service.repair("b", actor as Principal)).rejects.toMatchObject({ code: "INVALID" });
  });
});

// Failure-mode list for the live checkpoint, written before `checkpoint` and `restamp`.
//  1. A client writes raw Yjs and stamps a new element with a human it is not: the element is deleted.
//  2. A client changes the author of an old element, or the editor to a principal the room never saw: the stamp is put back.
//  3. A client stamps the title with someone else: the prior title and stamp come back.
//  4. An honest edit by a principal the room saw is kept, with the author kind unchanged.
//  5. A checkpoint merges: a shape that an HTTP writer added after the room began is not lost.
//  6. A garbage update is INVALID and the board is unchanged. An unknown board is NOT_FOUND.
//  7. A connector whose shape was deleted by the checks goes too, and a board over the cap is refused.
describe("live checkpoint", () => {
  const bot: Principal = { kind: "agent_of_human", id: "helper" };
  const eve: Principal = { kind: "human", id: "eve" };
  const open = async () => {
    const service = new CanvasService(openLocalStore(join(root, `c${n++}`)));
    await service.create(human, { id: "b", title: "Plan" });
    await service.add("b", { id: "s1", type: "rect", x: 0, y: 0 }, human);
    return service;
  };
  /** The room's state: the stored board, changed by `edit` the way a client would. */
  const room = async (service: CanvasService, edit: (board: Board) => void) => {
    const board = Board.decode(await service.state("b"));
    edit(board);
    return board.encode();
  };
  const raw = (board: Board, id: string, fields: object) => board.doc.getMap<Y.Map<unknown>>("elements").set(id, new Y.Map(Object.entries(fields)));

  test("a new element stamped by someone the room never saw is deleted", async () => {
    const service = await open();
    const update = await room(service, (b) => raw(b, "fake", { id: "fake", type: "rect", x: 0, y: 0, w: 5, h: 5, text: "", z: 9, author: human, editedBy: human }));
    // The bot sent it, and the bot claims to be the human "ada".
    const result = await service.checkpoint("b", update, bot, [bot]);
    expect(result.fixed).toEqual(["fake"]);
    expect((await service.read("b")).nodes.map((n) => n.id)).toEqual(["s1"]);
  });

  test("an old element keeps its author, and a forged editor is put back", async () => {
    const service = await open();
    const update = await room(service, (b) => {
      const entry = b.doc.getMap<Y.Map<unknown>>("elements").get("s1")!;
      entry.set("author", bot);
      entry.set("editedBy", eve);
    });
    const result = await service.checkpoint("b", update, bot, [bot]);
    expect(result.fixed).toEqual(["s1"]);
    expect((await service.read("b")).nodes[0]).toMatchObject({ author: human, editedBy: human, machineMade: false });
  });

  test("a title stamped by an unseen principal gets the prior title back", async () => {
    const service = await open();
    const update = await room(service, (b) => b.setTitle("Hacked", eve));
    await service.checkpoint("b", update, bot, [bot]);
    expect((await service.read("b")).title).toBe("Plan");
  });

  test("an honest edit by a principal the room saw is kept, and an HTTP write made meanwhile is not lost", async () => {
    const service = await open();
    const update = await room(service, (b) => {
      b.addShape({ id: "s2", type: "ellipse", x: 5, y: 5 }, bot);
      b.move("s1", 3, 4, bot);
    });
    await service.add("b", { id: "s3", type: "rect", x: 9, y: 9 }, human); // after the room began
    const result = await service.checkpoint("b", update, bot, [bot, human]);
    expect(result.fixed).toEqual([]);
    const { nodes } = await service.read("b");
    expect(nodes.map((n) => n.id).sort()).toEqual(["s1", "s2", "s3"]);
    expect(nodes.find((n) => n.id === "s2")).toMatchObject({ author: bot, machineMade: true });
    expect(nodes.find((n) => n.id === "s1")).toMatchObject({ x: 3, author: human, editedBy: bot, machineMade: false, lastEditMachineMade: true });
  });

  test("a garbage update is INVALID, an unknown board is NOT_FOUND, and a connector on a deleted shape goes too", async () => {
    const service = await open();
    await expect(service.checkpoint("b", Uint8Array.from([1, 2, 3]), bot)).rejects.toMatchObject({ code: "INVALID" });
    await expect(service.checkpoint("nope", Y.encodeStateAsUpdate(new Y.Doc()), bot)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const update = await room(service, (b) => {
      b.addShape({ id: "s2", type: "rect", x: 5, y: 5 }, eve); // eve is not trusted
      b.addConnector({ id: "c1", from: { id: "s1" }, to: { id: "s2" } }, bot);
    });
    const result = await service.checkpoint("b", update, bot, [bot]);
    expect(result.fixed).toEqual(["c1", "s2"]);
    expect((await service.read("b")).edges).toEqual([]);
  });
});
