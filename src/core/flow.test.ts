// Failure-mode list for the flow parser, the layout, and drawing. These tests
// were written before the code.
//
// Parser
//  1. Empty input, or only comments.
//  2. Unknown syntax: bad arrow, missing side, chain, bare words, open bracket,
//     text after a bracket, bad direction, control characters.
//  3. Duplicate ids: a second, different definition fails. A repeat is fine.
//  4. Cycles, self-loops, and parallel edges are legal input.
//  5. Colons and arrows inside a label or node text.
//  6. CRLF line ends, tabs, trailing spaces, a BOM.
//  7. Size limits: too many nodes, too many edges, too much text.
// Layout
//  8. A DAG ranks along its edges. A cycle and a self-loop do not crash.
//  9. No two nodes overlap, also across disconnected parts.
// 10. Same input, same output. Every number is finite and in range.
// 11. A graph at the node and edge limit finishes in time.
// Drawing
// 12. An id clash, a parse error, or the element cap leaves the board untouched.
// 13. Every drawn element carries the actor. Connectors bind to the node ids.
// 14. A second flow lands below the first. A prefix keeps ids apart.
// 16. Two agents draw at the same time on two docs: nothing is overwritten and
//     every edge binds the nodes of its own flow. Same text twice never clashes.
// 17. A node named like a connector id is refused with a clear message.
// 18. Node ids such as __proto__ and constructor parse, lay out, draw, and read.
// Reading
// 15. An empty board, the node and edge split, machine-made flags, no mutation.
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { Board, CanvasError, type Principal } from "../index.js";
import { MAX_FLOW_EDGES, MAX_FLOW_NODES, drawFlow, layoutFlow, parseFlow } from "./flow.js";
import { readBoard } from "./read.js";

const human: Principal = { kind: "human", id: "h1" };
const agent: Principal = { kind: "agent_of_human", id: "a1" };

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof CanvasError ? error.code : "OTHER";
  }
  return undefined;
}

describe("parser: bad input", () => {
  test.each([
    ["empty", ""],
    ["spaces only", "  \n \n"],
    ["comments only", "# a\n// b\n"],
    ["wrong arrow", "A => B"],
    ["missing right side", "A ->"],
    ["missing left side", "-> B"],
    ["chain", "A -> B -> C"],
    ["bare words", "A B"],
    ["open bracket", "A[Start -> B"],
    ["text after bracket", "A[x]y -> B"],
    ["mismatched bracket", "A[x) -> B"],
    ["empty id", "[x] -> B"],
    ["non-ASCII id", "é -> B"],
    ["id too long", `${"a".repeat(49)} -> B`],
    ["bad direction", "direction XY\nA -> B"],
    ["control character", "A[a\u0000b] -> B"],
  ])("refuses %s", (_name, source) => {
    expect(code(() => parseFlow(source))).toBe("INVALID");
  });
  test("names the line of the error", () => {
    expect(() => parseFlow("A -> B\nA => C")).toThrow(/line 2/);
  });
});

describe("parser: duplicates and legal shapes", () => {
  test("a conflicting second definition fails, a repeat or a bare use does not", () => {
    expect(code(() => parseFlow("A[x] -> B\nA[y] -> C"))).toBe("INVALID");
    expect(code(() => parseFlow("A[x] -> B\nA{x} -> C"))).toBe("INVALID");
    const g = parseFlow("A -> B\nA[x] -> B\nA[x] -> C\nC -> A");
    expect(g.nodes.find((n) => n.id === "A")).toMatchObject({ text: "x", shape: "rect" });
    expect(g.nodes.map((n) => n.id)).toEqual(["A", "B", "C"]);
  });
  test("keeps cycles, self-loops, and parallel edges", () => {
    const g = parseFlow("A -> B\nB -> A\nA -> A: again\nA -> B\nA -> B");
    expect(g.edges).toHaveLength(5);
    expect(g.edges[2]).toEqual({ from: "A", to: "A", text: "again" });
  });
  test("reads shapes, labels, and a node alone on a line", () => {
    const g = parseFlow("direction LR\nS(Start)\nS->D{Ok?}: go\nD -> E[Done: yes -> end]: a: b -> c\nLonely");
    expect(g.direction).toBe("LR");
    expect(g.nodes.map((n) => [n.id, n.shape, n.text])).toEqual([
      ["S", "ellipse", "Start"],
      ["D", "diamond", "Ok?"],
      ["E", "rect", "Done: yes -> end"],
      ["Lonely", "rect", "Lonely"],
    ]);
    expect(g.edges.map((e) => e.text)).toEqual(["go", "a: b -> c"]);
  });
  test("accepts CRLF, tabs, trailing spaces, and a BOM", () => {
    const g = parseFlow("﻿# c\r\nA\t->\tB: x  \r\n  B -> C\t\r\n");
    expect(g.edges).toEqual([
      { from: "A", to: "B", text: "x" },
      { from: "B", to: "C", text: "" },
    ]);
  });
});

describe("parser: limits", () => {
  test("refuses too many nodes, too many edges, and too much text", () => {
    const nodes = Array.from({ length: MAX_FLOW_NODES + 1 }, (_, i) => `n${i}`).join("\n");
    const edges = Array.from({ length: MAX_FLOW_EDGES + 1 }, () => "A -> B").join("\n");
    expect(code(() => parseFlow(nodes))).toBe("LIMIT");
    expect(code(() => parseFlow(edges))).toBe("LIMIT");
    expect(code(() => parseFlow(`A[${"x".repeat(250_000)}]`))).toBe("LIMIT");
  });
  test("reads a line of 100,000 spaces in a label without a stall", () => {
    const started = Date.now();
    const g = parseFlow(`A -> B:${" ".repeat(100_000)}x`);
    expect(g.edges[0].text).toBe("x");
    expect(Date.now() - started).toBeLessThan(1000);
  });
  test("accepts exactly the limits", () => {
    const nodes = Array.from({ length: MAX_FLOW_NODES }, (_, i) => `n${i}`).join("\n");
    expect(parseFlow(nodes).nodes).toHaveLength(MAX_FLOW_NODES);
  });
});

function overlaps(boxes: { x: number; y: number; w: number; h: number }[]): boolean {
  return boxes.some((a, i) => boxes.slice(i + 1).some((b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h));
}

describe("layout", () => {
  test("a DAG ranks along its edges in both directions", () => {
    for (const [dir, axis] of [["TB", "y"], ["LR", "x"]] as const) {
      const g = parseFlow(`direction ${dir}\nA -> B\nA -> C\nB -> D\nC -> D`);
      const at = new Map(layoutFlow(g).map((p) => [p.id, p]));
      for (const e of g.edges) expect(at.get(e.to)![axis]).toBeGreaterThan(at.get(e.from)![axis]);
    }
  });
  test("a cycle, a self-loop, and parallel edges do not crash", () => {
    for (const src of ["A -> B\nB -> C\nC -> A", "A -> A", "A -> B\nA -> B\nB -> A", "A"]) {
      const g = parseFlow(src);
      const out = layoutFlow(g);
      expect(out.map((p) => p.id)).toEqual(g.nodes.map((n) => n.id));
      expect(overlaps(out)).toBe(false);
    }
  });
  test("separate parts and many nodes never overlap", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `n${i} -> n${(i * 7 + 3) % 60}`);
    lines.push("lonely1", "lonely2[a long label for an isolated node that is wide]", "x{d} -> y{e}");
    const out = layoutFlow(parseFlow(lines.join("\n")));
    expect(overlaps(out)).toBe(false);
  });
  test("is deterministic and keeps every number finite and in range", () => {
    const g = parseFlow("A -> B\nB -> C\nC -> A\nA -> D\nD{q}");
    const first = layoutFlow(g);
    expect(layoutFlow(g)).toEqual(first);
    for (const p of first) for (const v of [p.x, p.y, p.w, p.h]) expect(Math.abs(v)).toBeLessThan(1e6);
    for (const p of first) for (const v of [p.x, p.y, p.w, p.h]) expect(Number.isFinite(v)).toBe(true);
  });
  test("wide text makes a wide node, with a cap", () => {
    const [short, long, huge] = layoutFlow(parseFlow(`a[x]\nb[${"w".repeat(40)}]\nc[${"w".repeat(900)}]`));
    expect(long.w).toBeGreaterThan(short.w);
    expect(huge.w).toBeLessThanOrEqual(360);
  });
  test("a graph at the limits finishes in time", () => {
    const lines = Array.from({ length: MAX_FLOW_EDGES }, (_, i) => `n${i % MAX_FLOW_NODES} -> n${(i * 13 + 1) % MAX_FLOW_NODES}`);
    const started = Date.now();
    const out = layoutFlow(parseFlow(lines.join("\n")));
    expect(out.length).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);
});

describe("drawing", () => {
  const src = "direction LR\nS(Start) -> D{Ok?}: go\nD -> E[End]: yes";
  const bytes = (b: Board) => Buffer.from(b.encode()).toString("base64");
  test("leaves the board untouched on an id clash, a parse error, or the cap", () => {
    const board = new Board(new Y.Doc(), { maxElements: 4 });
    board.addShape({ id: "S", type: "rect", x: 0, y: 0 }, human);
    const before = bytes(board);
    expect(code(() => drawFlow(board, src, agent, { idPrefix: "" }))).toBe("DUPLICATE_ID");
    expect(code(() => drawFlow(board, "A => B", agent))).toBe("INVALID");
    expect(code(() => drawFlow(board, "A -> B\nB -> C", agent))).toBe("LIMIT");
    expect(code(() => drawFlow(board, "A -> B", agent, { idPrefix: "bad id" }))).toBe("INVALID");
    expect(bytes(board)).toBe(before);
  });
  test("marks every element with the actor and binds connectors to node ids", () => {
    const board = new Board();
    const result = drawFlow(board, src, agent, { idPrefix: "" });
    expect(result.nodes).toEqual(["S", "D", "E"]);
    const all = board.list();
    expect(all).toHaveLength(5);
    for (const el of all) expect(el.author).toEqual(agent);
    const edge = board.get(result.edges[0]);
    expect(edge).toMatchObject({ type: "connector", from: { id: "S" }, to: { id: "D" }, text: "go", endArrow: true });
    expect(board.get("D")).toMatchObject({ type: "diamond", text: "Ok?" });
  });
  test("places a second flow below the first and keeps ids apart with a prefix", () => {
    const board = new Board();
    drawFlow(board, "A -> B", agent, { idPrefix: "" });
    drawFlow(board, "A -> B", agent, { idPrefix: "two-" });
    const shapes = board.list().flatMap((e) => (e.type === "connector" || e.type === "group" ? [] : [e]));
    expect(shapes).toHaveLength(4);
    expect(overlaps(shapes)).toBe(false);
    expect(board.get("two-A")!.type).toBe("rect");
    const first = board.get("A") as { y: number; h: number };
    expect((board.get("two-A") as { y: number }).y).toBeGreaterThan(first.y + first.h);
  });
});

describe("drawing at the same time", () => {
  const shapesOf = (b: Board) => b.list().flatMap((e) => (e.type === "connector" || e.type === "group" ? [] : [e]));
  const edgesOf = (b: Board) => b.list().flatMap((e) => (e.type === "connector" ? [e] : []));
  const merge = (a: Board, b: Board) => {
    const ua = a.encode();
    const ub = b.encode();
    Y.applyUpdate(a.doc, ub);
    Y.applyUpdate(b.doc, ua);
  };
  test("two agents drawing A -> B and A -> C keep both flows whole", () => {
    const base = new Board();
    const left = Board.decode(base.encode());
    const right = Board.decode(base.encode());
    const one = drawFlow(left, "A -> B", agent);
    const two = drawFlow(right, "A -> C", { kind: "agent", id: "a2" });
    merge(left, right);
    expect(left.list()).toEqual(right.list());
    expect(shapesOf(left)).toHaveLength(4);
    expect(edgesOf(left)).toHaveLength(2);
    expect(new Set([...one.nodes, ...one.edges, ...two.nodes, ...two.edges]).size).toBe(6);
    const texts = (ids: string[]) => ids.map((i) => (left.get(i) as { text: string }).text);
    expect(texts(one.nodes)).toEqual(["A", "B"]);
    expect(texts(two.nodes)).toEqual(["A", "C"]);
    expect(left.get(one.edges[0])).toMatchObject({ from: { id: one.nodes[0] }, to: { id: one.nodes[1] } });
    expect(left.get(two.edges[0])).toMatchObject({ from: { id: two.nodes[0] }, to: { id: two.nodes[1] } });
    expect(left.get(two.nodes[0])!.author.id).toBe("a2");
  });
  test("the same text twice on one board does not clash", () => {
    const board = new Board();
    drawFlow(board, "A -> B", agent);
    drawFlow(board, "A -> B", agent);
    expect(shapesOf(board)).toHaveLength(4);
    expect(edgesOf(board)).toHaveLength(2);
  });
  test("a prefix chosen by the caller is used as given", () => {
    expect(drawFlow(new Board(), "A -> B", agent, { idPrefix: "mine-" }).nodes).toEqual(["mine-A", "mine-B"]);
  });
  test("a node named like a connector id is refused with a clear message", () => {
    const err = (() => {
      try {
        parseFlow("edge_1 -> B");
      } catch (e) {
        return e as CanvasError;
      }
    })();
    expect(err?.code).toBe("INVALID");
    expect(err?.message).toContain("edge_");
  });
  test.each(["__proto__", "constructor", "hasOwnProperty", "toString", "valueOf", "prototype"])(
    "node id %s survives parse, layout, draw, and read",
    (name) => {
      const src = `${name}[Hello] -> B: go\nB -> ${name}`;
      const graph = parseFlow(src);
      expect(graph.nodes.map((n) => n.id)).toEqual([name, "B"]);
      expect(layoutFlow(graph).map((p) => p.id)).toEqual([name, "B"]);
      const board = new Board();
      const result = drawFlow(board, src, agent, { idPrefix: "" });
      expect(result.nodes).toEqual([name, "B"]);
      expect(readBoard(board).nodes.map((n) => n.id).sort()).toEqual([name, "B"].sort());
      expect(board.get(name)).toMatchObject({ text: "Hello" });
      expect(({} as Record<string, unknown>).text).toBeUndefined();
      expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    },
  );
});

describe("reading", () => {
  test("reads an empty board", () => {
    expect(readBoard(new Board())).toEqual({ title: "", nodes: [], edges: [], groups: [], texts: [] });
  });
  test("splits nodes and edges, keeps text order, flags machine-made work, and does not write", () => {
    const board = new Board();
    board.setTitle("Plan", human);
    board.addShape({ id: "a", type: "sticky", x: 0, y: 0, text: "first" }, human);
    board.addShape({ id: "b", type: "ellipse", x: 200, y: 0, text: "second" }, agent);
    board.addConnector({ id: "k", from: { id: "a" }, to: { id: "b" }, text: "link" }, agent);
    board.addShape({ id: "n", type: "rect", x: 0, y: 90 }, human);
    board.group(["a", "b"], human, "g");
    board.update("a", { text: "first!" }, agent);
    const before = Buffer.from(board.encode()).toString("base64");
    const data = readBoard(board);
    expect(Buffer.from(board.encode()).toString("base64")).toBe(before);
    expect(data.title).toBe("Plan");
    expect(data.nodes.map((n) => n.id)).toEqual(["a", "b", "n"]);
    expect(data.edges).toEqual([
      expect.objectContaining({ id: "k", from: { id: "a" }, to: { id: "b" }, text: "link", machineMade: true }),
    ]);
    expect(data.groups).toEqual([{ id: "g", members: ["a", "b"] }]);
    expect(data.texts).toEqual(["first!", "second", "link"]);
    const a = data.nodes[0];
    expect(a).toMatchObject({ machineMade: false, lastEditMachineMade: true, groupId: "g" });
    expect(data.nodes[1].machineMade).toBe(true);
  });
});
