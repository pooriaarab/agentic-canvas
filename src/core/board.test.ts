// Failure-mode list for the board model. These tests were written before the code.
//
//  1. Bad input: NaN, Infinity, huge coordinates, zero or negative size,
//     unknown type, unknown field, unsafe colour, long text, bad id.
//  2. Duplicate id on add.
//  3. Image source: remote URL, script URL and SVG data are refused.
//  4. Connector: missing endpoint, endpoint that is a connector or a group.
//  5. Delete: missing id; a shape takes its connectors; a group takes its members.
//  6. Group: too few members, unknown member, mixed parents, repeated id.
//  7. Author: kind kept on add; an edit changes the editor, never the author.
//  8. Z-order: new on top; front and back; ties break by id.
//  9. Sync: concurrent edits converge; encode and decode round-trip.
// 10. Element cap.
// 11. Concurrent delete vs connect or retarget leaves a connector with a missing
//     end: readers hide it, repair removes it, both peers converge.
// 12. A peer group delete leaves members with a missing group: repair clears it.
// 13. A peer update past the element cap is refused on decode.
// 14. A peer plants a connector end that is a string, null, or a bad point:
//     readers do not throw, they hide the connector, and repair removes it.
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { Board, CanvasError, MAX_ELEMENTS, type Shape } from "./board.js";
import { PRINCIPAL_KINDS, isMachineMade, type Principal } from "./principal.js";

const human: Principal = { kind: "human", id: "h1" };
const agent: Principal = { kind: "agent_of_human", id: "a1" };
const rect = (x = 0, y = 0, extra: object = {}) => ({ type: "rect", x, y, ...extra });

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof CanvasError ? error.code : "OTHER";
  }
  return undefined;
}

describe("bad input", () => {
  test.each([
    ["NaN x", rect(Number.NaN)],
    ["Infinity y", rect(0, Number.POSITIVE_INFINITY)],
    ["huge x", rect(1e9)],
    ["zero width", rect(0, 0, { w: 0 })],
    ["negative height", rect(0, 0, { h: -5 })],
    ["unknown type", { type: "star", x: 0, y: 0 }],
    ["unknown field", rect(0, 0, { onclick: "x" })],
    ["colour with markup", rect(0, 0, { fill: 'red" onload="x' })],
    ["long text", rect(0, 0, { text: "a".repeat(10_001) })],
    ["id with a slash", rect(0, 0, { id: "a/b" })],
    ["id too long", rect(0, 0, { id: "a".repeat(65) })],
    ["connector given as a shape", { type: "connector", x: 0, y: 0 }],
  ])("refuses %s", (_name, input) => {
    expect(code(() => new Board().addShape(input, human))).toBe("INVALID");
  });

  test("refuses a bad principal and a missing principal", () => {
    expect(code(() => new Board().addShape(rect(), { kind: "robot", id: "x" } as never))).toBe("INVALID");
    expect(code(() => new Board().addShape(rect(), undefined as never))).toBe("INVALID");
  });

  test("keeps ids case-sensitive", () => {
    const board = new Board();
    board.addShape(rect(0, 0, { id: "Abc" }), human);
    board.addShape(rect(0, 0, { id: "abc" }), human);
    expect(board.list().map((e) => e.id).sort()).toEqual(["Abc", "abc"]);
  });
});

describe("duplicate id", () => {
  test("refuses a second element with the same id", () => {
    const board = new Board();
    board.addShape(rect(0, 0, { id: "a" }), human);
    expect(code(() => board.addShape(rect(5, 5, { id: "a" }), human))).toBe("DUPLICATE_ID");
    expect(board.list()).toHaveLength(1);
  });
});

describe("image source", () => {
  const image = (src?: string) => ({ type: "image", x: 0, y: 0, ...(src ? { src } : {}) });
  test.each([
    "https://example.org/a.png",
    "javascript:alert(1)",
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    "data:text/html;base64,PGI+",
    "blob:",
  ])("refuses %s", (src) => {
    expect(code(() => new Board().addShape(image(src), human))).toBe("INVALID");
  });
  test("refuses an image without a source and a source on another type", () => {
    expect(code(() => new Board().addShape(image(), human))).toBe("INVALID");
    expect(code(() => new Board().addShape(rect(0, 0, { src: "blob:k1" }), human))).toBe("INVALID");
  });
  test("accepts a PNG data URI and a blob key", () => {
    const board = new Board();
    board.addShape(image("data:image/png;base64,iVBORw0KGgo="), human);
    board.addShape(image("blob:boards-1.logo"), human);
    expect(board.list()).toHaveLength(2);
  });
});

describe("connectors", () => {
  function setup() {
    const board = new Board();
    board.addShape(rect(0, 0, { id: "a" }), human);
    board.addShape(rect(200, 0, { id: "b" }), human);
    return board;
  }
  test("refuses a missing endpoint", () => {
    expect(code(() => setup().addConnector({ from: { id: "a" }, to: { id: "zz" } }, human))).toBe("BAD_REFERENCE");
  });
  test("refuses a connector or a group as an endpoint", () => {
    const board = setup();
    const c = board.addConnector({ from: { id: "a" }, to: { id: "b" } }, human);
    const g = board.group(["a", "b"], human);
    expect(code(() => board.addConnector({ from: { id: c.id }, to: { id: "b" } }, human))).toBe("BAD_REFERENCE");
    expect(code(() => board.addConnector({ from: { id: g.id }, to: { id: "b" } }, human))).toBe("BAD_REFERENCE");
  });
  test("refuses a bad free point and a bad update", () => {
    const board = setup();
    expect(code(() => board.addConnector({ from: { x: Number.NaN, y: 0 }, to: { id: "b" } }, human))).toBe("INVALID");
    const c = board.addConnector({ from: { id: "a" }, to: { id: "b" } }, human);
    expect(code(() => board.update(c.id, { to: { id: "nope" } }, human))).toBe("BAD_REFERENCE");
  });
  test("allows a self-loop and a free end", () => {
    const board = setup();
    board.addConnector({ from: { id: "a" }, to: { id: "a" } }, human);
    board.addConnector({ from: { id: "a" }, to: { x: 50, y: 50 } }, human);
    expect(board.list().filter((e) => e.type === "connector")).toHaveLength(2);
  });
});

describe("delete", () => {
  test("refuses a missing id", () => {
    expect(code(() => new Board().remove("nope"))).toBe("NOT_FOUND");
  });
  test("a shape takes its connectors and no other element", () => {
    const board = new Board();
    for (const id of ["a", "b", "c"]) board.addShape(rect(0, 0, { id }), human);
    board.addConnector({ id: "ab", from: { id: "a" }, to: { id: "b" } }, human);
    board.addConnector({ id: "bc", from: { id: "b" }, to: { id: "c" } }, human);
    board.addConnector({ id: "free", from: { id: "c" }, to: { x: 1, y: 1 } }, human);
    expect(board.remove("a")).toEqual(["a", "ab"]);
    expect(board.list().map((e) => e.id).sort()).toEqual(["b", "bc", "c", "free"]);
  });
  test("a group takes its members and their connectors", () => {
    const board = new Board();
    for (const id of ["a", "b", "c"]) board.addShape(rect(0, 0, { id }), human);
    board.addConnector({ id: "ac", from: { id: "a" }, to: { id: "c" } }, human);
    const g = board.group(["a", "b"], human, "g");
    expect(board.remove(g.id)).toEqual(["a", "ac", "b", "g"]);
    expect(board.list().map((e) => e.id)).toEqual(["c"]);
  });
});

describe("groups", () => {
  function setup() {
    const board = new Board();
    for (const id of ["a", "b", "c"]) board.addShape(rect(0, 0, { id }), human);
    return board;
  }
  test("refuses too few, unknown, and repeated members", () => {
    const board = setup();
    expect(code(() => board.group(["a"], human))).toBe("INVALID");
    expect(code(() => board.group(["a", "a"], human))).toBe("INVALID");
    expect(code(() => board.group(["a", "zz"], human))).toBe("NOT_FOUND");
  });
  test("refuses members from different parents", () => {
    const board = setup();
    board.group(["a", "b"], human);
    expect(code(() => board.group(["a", "c"], human))).toBe("BAD_REFERENCE");
  });
  test("nests, and ungroup hands members back to the parent group", () => {
    const board = setup();
    board.addShape(rect(0, 0, { id: "d" }), human);
    const inner = board.group(["a", "b"], human, "inner");
    const outer = board.group([inner.id, "c"], human, "outer");
    board.ungroup(inner.id, human);
    expect(board.get("a")?.groupId).toBe(outer.id);
    expect(board.get("inner")).toBeUndefined();
    board.ungroup(outer.id, human);
    expect(board.get("a")?.groupId).toBeUndefined();
  });
  test("moving a group moves members and free connector ends, not bound ends", () => {
    const board = setup();
    board.addConnector({ id: "k", from: { id: "a" }, to: { x: 10, y: 10 } }, human);
    const g = board.group(["a", "b", "k"], human);
    expect(board.move(g.id, 5, -5, human).sort()).toEqual(["a", "b", "k"]);
    expect(board.get("a")).toMatchObject({ x: 5, y: -5 });
    expect(board.get("k")).toMatchObject({ from: { id: "a" }, to: { x: 15, y: 5 } });
    expect(board.get("c")).toMatchObject({ x: 0, y: 0 });
  });
  test("refuses a move that leaves the allowed range", () => {
    const board = setup();
    expect(code(() => board.move("a", 2e7, 0, human))).toBe("INVALID");
    expect(board.get("a")).toMatchObject({ x: 0 });
  });
});

describe("author kind", () => {
  test("keeps the author kind on add and the editor kind on edit", () => {
    const board = new Board();
    board.addShape(rect(0, 0, { id: "a" }), agent);
    board.update("a", { text: "hi" }, human);
    const el = board.get("a") as Shape;
    expect(el.author).toEqual(agent);
    expect(el.editedBy).toEqual(human);
    expect(isMachineMade(el.author.kind)).toBe(true);
    expect(isMachineMade(el.editedBy.kind)).toBe(false);
  });
  test("every kind is stored as given", () => {
    const board = new Board();
    PRINCIPAL_KINDS.forEach((kind, i) => board.addShape(rect(i, 0, { id: `s${i}` }), { kind, id: `p${i}` }));
    expect(board.list().map((e) => e.author.kind)).toEqual([...PRINCIPAL_KINDS]);
  });
  test("an edit cannot change identity fields, and an empty patch fails", () => {
    const board = new Board();
    board.addShape(rect(0, 0, { id: "a" }), human);
    for (const patch of [{ id: "b" }, { type: "ellipse" }, { author: agent }, {}]) {
      expect(code(() => board.update("a", patch, agent))).toBe("INVALID");
    }
    expect(board.get("a")?.author).toEqual(human);
  });
  test("a move records the mover", () => {
    const board = new Board();
    board.addShape(rect(0, 0, { id: "a" }), human);
    board.move("a", 1, 1, agent);
    expect(board.get("a")?.editedBy).toEqual(agent);
  });
});

describe("z-order", () => {
  function setup() {
    const board = new Board();
    for (const id of ["a", "b", "c"]) board.addShape(rect(0, 0, { id }), human);
    return board;
  }
  const order = (board: Board) => board.list().map((e) => e.id);
  test("new elements land on top", () => {
    expect(order(setup())).toEqual(["a", "b", "c"]);
  });
  test("front and back move one element", () => {
    const board = setup();
    board.reorder("a", "front", human);
    expect(order(board)).toEqual(["b", "c", "a"]);
    board.reorder("a", "back", human);
    expect(order(board)).toEqual(["a", "b", "c"]);
  });
  test("a group keeps its inner order when it moves", () => {
    const board = setup();
    board.group(["a", "b"], human, "g");
    board.reorder("g", "front", human);
    expect(order(board).filter((id) => id !== "g")).toEqual(["c", "a", "b"]);
  });
  test("equal z breaks ties by id", () => {
    const base = new Board();
    base.addShape(rect(0, 0, { id: "x" }), human);
    const left = Board.decode(base.encode());
    const right = Board.decode(base.encode());
    left.addShape(rect(0, 0, { id: "m" }), human);
    right.addShape(rect(0, 0, { id: "k" }), human);
    sync(left, right);
    expect(order(left)).toEqual(["x", "k", "m"]);
  });
  test("refuses a missing id", () => {
    expect(code(() => setup().reorder("zz", "front", human))).toBe("NOT_FOUND");
  });
});

function sync(a: Board, b: Board): void {
  const ua = a.encode();
  const ub = b.encode();
  Y.applyUpdate(a.doc, ub);
  Y.applyUpdate(b.doc, ua);
}

describe("sync", () => {
  test("concurrent edits converge to the same board", () => {
    const base = new Board();
    base.addShape(rect(0, 0, { id: "a" }), human);
    const left = Board.decode(base.encode());
    const right = Board.decode(base.encode());
    left.update("a", { text: "left" }, human);
    left.addShape(rect(9, 9, { id: "l" }), agent);
    right.update("a", { x: 40 }, agent);
    right.addShape(rect(8, 8, { id: "r" }), human);
    sync(left, right);
    expect(left.list()).toEqual(right.list());
    expect(left.get("a")).toMatchObject({ text: "left", x: 40 });
    expect(left.get("l")?.author).toEqual(agent);
  });
  test("encode and decode keep every field", () => {
    const board = new Board();
    board.setTitle("Plan", agent);
    board.addShape(rect(1, 2, { id: "a", text: "t", fill: "#fff" }), human);
    board.addConnector({ id: "k", from: { id: "a" }, to: { id: "a" } }, agent);
    const copy = Board.decode(board.encode());
    expect(copy.list()).toEqual(board.list());
    expect(copy.title).toBe("Plan");
    expect(copy.titleBy).toEqual(agent);
  });
});

describe("concurrent delete", () => {
  function pair() {
    const base = new Board();
    base.addShape(rect(0, 0, { id: "s" }), human);
    base.addShape(rect(200, 0, { id: "t" }), human);
    return [Board.decode(base.encode()), Board.decode(base.encode())] as const;
  }
  const ids = (b: Board) => b.list().map((e) => e.id);
  test("delete on one doc, connect on the other: no orphan connector is readable", () => {
    const [a, b] = pair();
    a.remove("s");
    b.addConnector({ id: "k", from: { id: "s" }, to: { id: "t" } }, agent);
    sync(a, b);
    expect(ids(a)).toEqual(["t"]);
    expect(ids(b)).toEqual(["t"]);
    expect(a.get("k")).toBeUndefined();
  });
  test("delete vs retarget of an existing connector", () => {
    const base = new Board();
    for (const id of ["s", "t", "u"]) base.addShape(rect(0, 0, { id }), human);
    base.addConnector({ id: "k", from: { id: "s" }, to: { id: "t" } }, human);
    const a = Board.decode(base.encode());
    const b = Board.decode(base.encode());
    a.remove("u");
    b.update("k", { to: { id: "u" } }, agent);
    sync(a, b);
    expect(ids(a)).toEqual(["s", "t"]);
    expect(ids(b)).toEqual(["s", "t"]);
  });
  test("repair removes the orphan the same way on both docs", () => {
    const [a, b] = pair();
    a.remove("s");
    b.addConnector({ id: "k", from: { id: "s" }, to: { id: "t" } }, agent);
    sync(a, b);
    expect(a.repair()).toEqual(["k"]);
    expect(b.repair()).toEqual(["k"]);
    sync(a, b);
    expect(a.repair()).toEqual([]);
    expect([...a.doc.getMap("elements").keys()].sort()).toEqual(["t"]);
    expect([...b.doc.getMap("elements").keys()].sort()).toEqual(["t"]);
  });
  test("decode repairs a doc that holds an orphan", () => {
    const [a, b] = pair();
    a.remove("s");
    b.addConnector({ id: "k", from: { id: "s" }, to: { id: "t" } }, agent);
    sync(a, b);
    const loaded = Board.decode(a.encode());
    expect([...loaded.doc.getMap("elements").keys()]).toEqual(["t"]);
  });
  test("remove takes a hidden orphan bound to the shape and does not throw", () => {
    const [a, b] = pair();
    a.remove("s");
    b.addConnector({ id: "k", from: { id: "s" }, to: { id: "t" } }, agent);
    sync(a, b);
    expect(a.remove("t")).toEqual(["k", "t"]);
    expect(a.list()).toEqual([]);
  });
  test("a member whose group a peer deleted reads as ungrouped after repair", () => {
    const base = new Board();
    for (const id of ["a", "b"]) base.addShape(rect(0, 0, { id }), human);
    base.group(["a", "b"], human, "g");
    const x = Board.decode(base.encode());
    const y = Board.decode(base.encode());
    x.doc.getMap<Y.Map<unknown>>("elements").delete("g");
    y.update("a", { text: "edit" }, agent);
    sync(x, y);
    expect(x.repair().sort()).toEqual(["a", "b"]);
    expect(x.get("a")?.groupId).toBeUndefined();
    expect(x.get("b")?.groupId).toBeUndefined();
  });
  test.each([
    ["a string", "<script>"],
    ["null", null],
    ["a number", 7],
    ["an object with no id and no point", { z: 1 }],
    ["a point with a string", { x: "1", y: 2 }],
    ["a point with NaN", { x: Number.NaN, y: 0 }],
    ["an id that is not a string", { id: 5 }],
  ])("a connector end that is %s is hidden, never thrown on, and repaired", (_name, value) => {
    const [a, b] = pair();
    b.addConnector({ id: "k", from: { id: "s" }, to: { id: "t" } }, agent);
    sync(a, b);
    a.doc.getMap<Y.Map<unknown>>("elements").get("k")!.set("to", value);
    expect(ids(a)).toEqual(["s", "t"]);
    expect(a.get("k")).toBeUndefined();
    expect(() => a.remove("t")).not.toThrow();
    expect(a.repair()).toEqual(["k"]);
  });
  test("decode refuses an update past the element cap", () => {
    const doc = new Y.Doc();
    const big = new Board(doc, { maxElements: MAX_ELEMENTS });
    doc.transact(() => {
      for (let i = 0; i <= MAX_ELEMENTS; i++) {
        doc.getMap<Y.Map<unknown>>("elements").set(`s${i}`, new Y.Map(Object.entries({ id: `s${i}`, type: "rect", z: i, x: 0, y: 0, w: 1, h: 1, text: "", author: human, editedBy: human })));
      }
    });
    expect(code(() => Board.decode(big.encode()))).toBe("LIMIT");
  });
});

describe("element cap", () => {
  test("refuses an element past the cap and keeps the board intact", () => {
    const board = new Board(new Y.Doc(), { maxElements: 50 });
    for (let i = 0; i < 50; i++) board.addShape(rect(0, 0, { id: `s${i}` }), human);
    expect(code(() => board.addShape(rect(), human))).toBe("LIMIT");
    expect(board.list()).toHaveLength(50);
  });
});
