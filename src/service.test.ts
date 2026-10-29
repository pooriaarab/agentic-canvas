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

describe("delete", () => {
  test("removes one board, keeps the others, refuses a missing or bad id, and lets the id be used again", async () => {
    const service = new CanvasService(openLocalStore(join(root, `d${n++}`)));
    await service.create(human, { id: "a", title: "A" });
    await service.create(human, { id: "b" });
    await service.add("a", { id: "s", type: "rect", x: 0, y: 0 }, human);
    expect(await service.delete("a")).toEqual({ deleted: "a" });
    expect((await service.list()).map((x) => x.id)).toEqual(["b"]);
    await expect(service.read("a")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.delete("a")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.delete("../x")).rejects.toMatchObject({ code: "INVALID" });
    await service.create(human, { id: "a" });
    expect((await service.read("a")).nodes).toEqual([]);
  });
});

// Failure-mode list for the live checkpoint, written before `checkpoint` and `restamp`. A save must undo:
//  1. A new element, or a title, stamped by a principal the room never saw.
//  2. A changed author, a forged editor, or a content change that keeps an old stamp.
//  3. Data no check reads: an unknown element key, a meta key, a root type, a title that fails its check,
//     and an update that lacks its earlier part. Each would grow the stored board.
//  A save must also refuse a stored board over the byte cap: Yjs keeps the keys of deleted entries.
//  And it must keep an honest edit, merge with an HTTP write made meanwhile, and answer garbage with INVALID.
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

  test("a content change that keeps the old stamp is undone, for an element and for the title", async () => {
    const service = await open();
    const update = await room(service, (b) => {
      const entry = b.doc.getMap<Y.Map<unknown>>("elements").get("s1")!;
      entry.set("x", 500);
      entry.set("text", "by the bot");
      b.doc.getMap("meta").set("title", "Changed");
    });
    const result = await service.checkpoint("b", update, bot, [bot]);
    expect(result.fixed).toEqual(["s1", "title"]);
    const read = await service.read("b");
    expect(read.title).toBe("Plan");
    expect(read.nodes[0]).toMatchObject({ x: 0, text: "", editedBy: human, lastEditMachineMade: false });
  });

  test("an extra root type is refused and an extra meta key is deleted", async () => {
    const service = await open();
    const strange = await room(service, (b) => void b.doc.getText("junk").insert(0, "x".repeat(100)));
    await expect(service.checkpoint("b", strange, bot, [bot])).rejects.toMatchObject({ code: "INVALID" });
    const key = await room(service, (b) => b.doc.getMap("meta").set("junk", "x"));
    expect((await service.checkpoint("b", key, bot, [bot])).fixed).toEqual(["meta:junk"]);
  });

  test("a key the board does not know is deleted from an old element and from a new trusted one", async () => {
    const service = await open();
    const update = await room(service, (b) => {
      b.addShape({ id: "s2", type: "rect", x: 1, y: 1 }, bot);
      for (const id of ["s1", "s2"]) b.doc.getMap<Y.Map<unknown>>("elements").get(id)!.set("junk", "x".repeat(1000));
    });
    const result = await service.checkpoint("b", update, bot, [bot, human]);
    expect(result.fixed).toEqual(["s1", "s2"]);
    const stored = Board.open(await service.state("b")).doc.getMap<Y.Map<unknown>>("elements");
    expect([...stored.get("s1")!.keys()]).not.toContain("junk");
    expect([...stored.get("s2")!.keys()]).not.toContain("junk");
  });

  test("a title value that fails its check is undone, even with a trusted stamp", async () => {
    const service = await open();
    const huge = await room(service, (b) => {
      b.doc.getMap("meta").set("title", "x".repeat(100_000));
      b.doc.getMap("meta").set("titleBy", bot);
    });
    expect((await service.checkpoint("b", huge, bot, [bot])).fixed).toEqual(["title"]);
    const bare = new CanvasService(openLocalStore(join(root, `c${n++}`)));
    await bare.create(human, { id: "b" });
    const junk = await room(bare, (b) => {
      b.doc.getMap("meta").set("title", { big: "x".repeat(100_000) });
      b.doc.getMap("meta").set("titleBy", "junk");
    });
    expect((await bare.checkpoint("b", junk, bot, [bot])).fixed).toEqual(["title"]);
    for (const [s, title] of [[service, "Plan"], [bare, ""]] as const) {
      expect((await s.read("b")).title).toBe(title);
      expect((await s.state("b")).length).toBeLessThan(1000);
    }
  });

  test("a nested Yjs type hides data from the checks: it is deleted with the element, or the title is undone", async () => {
    const service = await open();
    const before = (await service.state("b")).length;
    const update = await room(service, (b) => {
      for (const [map, key] of [[b.doc.getMap<Y.Map<unknown>>("elements").get("s1")!, "text"], [b.doc.getMap("meta"), "title"]] as const) {
        const text = new Y.Text();
        map.set(key, text);
        text.insertEmbed(0, { big: "x".repeat(100_000) });
      }
      b.doc.getMap("meta").set("titleBy", bot);
    });
    const result = await service.checkpoint("b", update, bot, [bot, human]);
    expect(result.fixed).toEqual(["s1", "title"]);
    expect((await service.read("b")).nodes).toEqual([]);
    expect((await service.state("b")).length).toBeLessThan(before + 500);
  });

  test("set-and-delete updates cannot grow the stored board past the cap", async () => {
    const service = await open();
    const before = (await service.state("b")).length;
    const update = await room(service, (b) => {
      const meta = b.doc.getMap("meta");
      for (let i = 0; i < 1000; i++) {
        meta.set(`${"k".repeat(2000)}${i}`, 1);
        meta.delete(`${"k".repeat(2000)}${i}`);
      }
    });
    await expect(service.checkpoint("b", update, bot, [bot])).rejects.toMatchObject({ code: "LIMIT" });
    expect((await service.state("b")).length).toBe(before);
  });

  test("an update that lacks its earlier part is refused and the board does not grow", async () => {
    const service = await open();
    const before = (await service.state("b")).length;
    const sender = new Y.Doc();
    sender.getText("evil").insert(0, "first");
    const base = Y.encodeStateVector(sender);
    sender.getText("evil").insert(5, "x".repeat(10_000));
    const second = Y.encodeStateAsUpdate(sender, base); // the half that needs "first"
    await expect(service.checkpoint("b", second, bot, [bot])).rejects.toMatchObject({ code: "INVALID" });
    expect((await service.state("b")).length).toBe(before);
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

// Failure cases for `missingFrom`: a room that has all of the board must get nothing, even when the board has deletes
// (the delete set is always in a diff), and a room that is behind must get what it lacks.
describe("missingFrom", () => {
  test("is null for a room with the whole board, deletes included, and the missing part for one that is behind", async () => {
    const service = new CanvasService(openLocalStore(join(root, `m${n++}`)));
    await service.create(human, { id: "b" });
    await service.add("b", { id: "s1", type: "rect", x: 0, y: 0 }, human);
    const early = await service.state("b");
    await service.add("b", { id: "s2", type: "rect", x: 1, y: 1 }, human);
    await service.remove("b", "s1");
    expect(await service.missingFrom("b", await service.state("b"))).toBeNull();
    const behind = await service.missingFrom("b", early);
    const room = Board.decode(early);
    Y.applyUpdate(room.doc, behind!);
    expect(room.list().map((e) => e.id)).toEqual(["s2"]);
    expect(await service.missingFrom("b")).not.toBeNull();
  });
});

// Failure cases for server-stamped authors, written before `writer` was read. The room's log says who sent each Yjs
// item. A save must not let a client:
//  1. Put another principal, or a person, on an element it created, even a principal that is in the room.
//  2. Keep an old editor on content it changed, or claim another editor for it.
//  3. Put another principal on the title.
//  4. Keep a person's stamp on content an agent changed by deleting a key, which leaves no item in the log.
//  5. Hide an agent's change behind a person's later edit, or keep a change that no one can be named for.
//  6. Keep a new element, or a title, that no one can be named for (a range the log dropped, content the room never had).
//  A hand save is posted by one actor, so for content the room never had, that actor is the sender.
describe("stamps from the writer", () => {
  const bot: Principal = { kind: "agent_of_human", id: "helper" };
  const ada: Principal = { kind: "human", id: "ada" };
  const BOT_CLIENT = 777;
  const writer = ({ client }: { client: number }) => (client === BOT_CLIENT ? bot : undefined);
  const open = async () => {
    const service = new CanvasService(openLocalStore(join(root, `w${n++}`)));
    await service.create(ada, { id: "b", title: "Plan" });
    await service.add("b", { id: "s1", type: "rect", x: 0, y: 0 }, ada);
    return service;
  };
  const room = async (service: CanvasService, edit: (board: Board) => void) => {
    const board = Board.decode(await service.state("b"));
    board.doc.clientID = BOT_CLIENT;
    edit(board);
    return board.encode();
  };
  const raw = (board: Board, id: string, fields: object) => board.doc.getMap<Y.Map<unknown>>("elements").set(id, new Y.Map(Object.entries(fields)));

  test("a new element gets its sender as author and editor, even when it names a person in the room", async () => {
    const service = await open();
    const update = await room(service, (b) => raw(b, "fake", { id: "fake", type: "rect", x: 0, y: 0, w: 5, h: 5, text: "", z: 9, author: ada, editedBy: ada }));
    const result = await service.checkpoint("b", update, null, [ada, bot], writer);
    expect(result.fixed).toEqual(["fake"]);
    expect((await service.read("b")).nodes.find((n) => n.id === "fake")).toMatchObject({ author: bot, editedBy: bot, machineMade: true });
  });

  test("changed content gets its sender as editor, and the author stays", async () => {
    const service = await open();
    const update = await room(service, (b) => {
      const entry = b.doc.getMap<Y.Map<unknown>>("elements").get("s1")!;
      entry.set("text", "changed");
      entry.set("editedBy", ada);
    });
    expect((await service.checkpoint("b", update, null, [ada, bot], writer)).fixed).toEqual(["s1"]);
    expect((await service.read("b")).nodes[0]).toMatchObject({ text: "changed", author: ada, editedBy: bot, lastEditMachineMade: true });
  });

  test("an element with an honest stamp is no fix", async () => {
    const service = await open();
    const update = await room(service, (b) => b.update("s1", { text: "mine" }, bot));
    expect((await service.checkpoint("b", update, null, [ada, bot], writer)).fixed).toEqual([]);
  });

  test("a title stamped with a person in the room is stamped with its sender", async () => {
    const service = await open();
    const update = await room(service, (b) => {
      b.doc.getMap("meta").set("title", "Hacked");
      b.doc.getMap("meta").set("titleBy", ada);
    });
    expect((await service.checkpoint("b", update, null, [ada, bot], writer)).fixed).toEqual(["title"]);
    expect((await service.read("b")).title).toBe("Hacked");
    expect(Board.decode(await service.state("b")).doc.getMap("meta").get("titleBy")).toEqual(bot);
  });

  const fake = { id: "fake", type: "rect", x: 0, y: 0, w: 5, h: 5, text: "", z: 9, author: ada, editedBy: ada };

  test("a new element that no one can be named for is deleted, even when its stamp names a person in the room", async () => {
    const service = await open();
    const update = await room(service, (b) => raw(b, "fake", fake));
    const result = await service.checkpoint("b", update, null, [ada, bot], () => undefined);
    expect(result.fixed).toEqual(["fake"]);
    expect((await service.read("b")).nodes.map((n) => n.id)).toEqual(["s1"]);
  });

  test("a hand save does not restamp what the store already had", async () => {
    const service = await open();
    const update = await room(service, () => undefined);
    expect((await service.checkpoint("b", update, bot, [ada, bot], () => undefined)).fixed).toEqual([]);
    expect((await service.read("b")).nodes[0]).toMatchObject({ author: ada, editedBy: ada });
  });

  test("an agent's edit of a new element shows, though the stamp names the person who made it", async () => {
    const service = await open();
    const update = await room(service, (b) => {
      b.doc.clientID = 888;
      b.addShape({ id: "n1", type: "rect", x: 0, y: 0 }, ada);
      b.doc.clientID = BOT_CLIENT;
      b.doc.getMap<Y.Map<unknown>>("elements").get("n1")!.set("text", "agent text");
    });
    const who = ({ client }: { client: number }) => (client === BOT_CLIENT ? bot : client === 888 ? ada : undefined);
    await service.checkpoint("b", update, null, [ada, bot], who);
    expect((await service.read("b")).nodes.find((n) => n.id === "n1")).toMatchObject({ text: "agent text", author: ada, editedBy: bot, lastEditMachineMade: true });
  });

  test("a new element with a key that no one can be named for is deleted", async () => {
    const service = await open();
    const update = await room(service, (b) => {
      b.doc.clientID = 888;
      b.addShape({ id: "n1", type: "rect", x: 0, y: 0 }, ada);
      b.doc.clientID = 999;
      b.doc.getMap<Y.Map<unknown>>("elements").get("n1")!.set("text", "who wrote this");
    });
    const who = ({ client }: { client: number }) => (client === 888 ? ada : undefined);
    expect((await service.checkpoint("b", update, null, [ada], who)).fixed).toEqual(["n1"]);
    expect((await service.read("b")).nodes.map((n) => n.id)).toEqual(["s1"]);
  });

  test("the last editor of two people keeps the stamp", async () => {
    const service = await open();
    const bob: Principal = { kind: "human", id: "bob" };
    const update = await room(service, (b) => {
      b.doc.clientID = 111;
      b.update("s1", { text: "bob one" }, bob);
      b.doc.clientID = 222;
      b.update("s1", { x: 5 }, ada);
      b.doc.clientID = 111;
      b.update("s1", { y: 7 }, bob);
    });
    const who = ({ client }: { client: number }) => (client === 111 ? bob : client === 222 ? ada : undefined);
    expect((await service.checkpoint("b", update, null, [ada, bob], who)).fixed).toEqual([]);
    expect((await service.read("b")).nodes[0]).toMatchObject({ text: "bob one", x: 5, y: 7, editedBy: bob });
  });

  test("a title author changed alone to a person in the room is stamped with its sender", async () => {
    const service = await open();
    await service.checkpoint("b", await room(service, (b) => b.setTitle("Agent title", bot)), null, [ada, bot], writer);
    const update = await room(service, (b) => b.doc.getMap("meta").set("titleBy", ada));
    expect((await service.checkpoint("b", update, null, [ada, bot], writer)).fixed).toEqual(["title"]);
    expect(Board.decode(await service.state("b")).doc.getMap("meta").get("titleBy")).toEqual(bot);
  });

  test("a deleted key leaves no item: the old editor does not keep the credit, and the change is undone if no one stamped it", async () => {
    const service = await open();
    await service.update("b", "s1", { fill: "#ff0000" }, ada);
    // The agent deletes `fill` and leaves the stamp alone.
    const silent = await room(service, (b) => b.doc.getMap<Y.Map<unknown>>("elements").get("s1")!.delete("fill"));
    expect((await service.checkpoint("b", silent, null, [ada, bot], writer)).fixed).toEqual(["s1"]);
    expect((await service.read("b")).nodes[0]).toMatchObject({ fill: "#ff0000", editedBy: ada });
    // The agent's own update also writes the stamp in the same window, so the stamp names it.
    const stamped = await room(service, (b) => b.update("s1", { fill: undefined }, bot));
    expect((await service.checkpoint("b", stamped, null, [ada, bot], writer)).fixed).toEqual([]);
    expect((await service.read("b")).nodes[0]).toMatchObject({ editedBy: bot, lastEditMachineMade: true });
    expect((await service.read("b")).nodes[0]!.fill).toBeUndefined();
  });

  test("an agent's change shows when a person edits another key after it", async () => {
    const service = await open();
    const update = await room(service, (b) => {
      b.update("s1", { text: "agent text" }, bot);
      b.doc.clientID = 888;
      b.update("s1", { x: 40 }, ada);
    });
    const who = ({ client }: { client: number }) => (client === BOT_CLIENT ? bot : client === 888 ? ada : undefined);
    await service.checkpoint("b", update, null, [ada, bot], who);
    expect((await service.read("b")).nodes[0]).toMatchObject({ text: "agent text", x: 40, editedBy: bot, lastEditMachineMade: true });
  });

  test("a change that no one can be named for is undone", async () => {
    const service = await open();
    const update = await room(service, (b) => {
      const entry = b.doc.getMap<Y.Map<unknown>>("elements").get("s1")!;
      entry.set("text", "unknown hand");
      entry.set("editedBy", ada);
    });
    const result = await service.checkpoint("b", update, null, [ada, bot], () => undefined);
    expect(result.fixed).toEqual(["s1"]);
    expect((await service.read("b")).nodes[0]).toMatchObject({ text: "", editedBy: ada });
  });

  test("a deleted title comes back, and a new title takes the sender as its author", async () => {
    const service = await open();
    const gone = await room(service, (b) => b.doc.getMap("meta").delete("title"));
    expect((await service.checkpoint("b", gone, null, [ada, bot], writer)).fixed).toEqual(["title"]);
    expect((await service.read("b")).title).toBe("Plan");
    const renamed = await room(service, (b) => b.setTitle("Hacked", bot));
    expect((await service.checkpoint("b", renamed, null, [ada, bot], writer)).fixed).toEqual([]);
    expect((await service.read("b")).title).toBe("Hacked");
  });
});
