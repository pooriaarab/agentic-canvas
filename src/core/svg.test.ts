// Failure-mode list for the SVG exporter. These tests were written before the code.
//
//  1. Markup, quotes, ampersands, control characters, and lone surrogates in
//     text, titles, ids, and author names cannot break out of the SVG.
//  2. A colour or an image source from a peer that the model would refuse
//     is replaced, never copied.
//  3. Same board, same bytes. A copy through encode and decode, too.
//  4. An empty board gives a valid, sized SVG.
//  5. A connector with a missing end is skipped. A self-loop, two shapes with
//     the same centre, and a free end never print NaN or Infinity.
//  6. Long words and long text wrap into a bounded number of lines.
//  7. Agent work is marked machine-made in the output.
//  8. Connectors between one pair of shapes, in either direction, and several
//     self-loops on one shape do not draw on top of each other.
//  9. A peer writes straight into the doc, past the write API. Every field it can
//     set is planted with markup, a wrong type, or a bad number. The output
//     keeps only known tags and attributes, and never throws.
// 10. A board past the element cap is refused.
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { Board, MAX_ELEMENTS, PRINCIPAL_KINDS, type Principal } from "../index.js";
import { toSvg } from "./svg.js";

const human: Principal = { kind: "human", id: "h1" };
const agent: Principal = { kind: "agent_of_human", id: "a1" };

describe("svg", () => {
  test("escapes hostile text, title, and ids", () => {
    const board = new Board();
    board.setTitle('"><script>alert(1)</script>', human);
    board.addShape({ id: "a", type: "rect", x: 0, y: 0, text: `<script>x</script> & "q" \u0000\u0007 \ud800 ok 😀` }, human);
    const svg = toSvg(board);
    expect(svg).not.toContain("<script");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("&amp;");
    expect(svg).toContain("ok 😀");
    expect(svg).not.toMatch(/[\u0000-\u0008\ud800-\udbff](?![\udc00-\udfff])/);
  });

  test("replaces a colour and an image source a peer could plant", () => {
    const board = new Board();
    board.addShape({ id: "a", type: "rect", x: 0, y: 0 }, human);
    board.addShape({ id: "i", type: "image", x: 0, y: 100, src: "blob:k1" }, human);
    const peer = Board.decode(board.encode());
    peer.doc.getMap<Y.Map<unknown>>("elements").get("a")!.set("fill", 'red" onload="x');
    peer.doc.getMap<Y.Map<unknown>>("elements").get("i")!.set("src", 'data:image/png;base64,AAAA"/><script>alert(1)</script>');
    const svg = toSvg(peer);
    expect(svg).not.toContain("onload");
    expect(svg).not.toContain("<script");
  });

  test("is deterministic, also across encode and decode", () => {
    const board = new Board();
    board.addShape({ id: "a", type: "ellipse", x: 3.14159, y: 2, text: "hello world" }, agent);
    board.addShape({ id: "b", type: "diamond", x: 300, y: 0 }, human);
    board.addConnector({ id: "k", from: { id: "a" }, to: { id: "b" }, text: "go" }, agent);
    expect(toSvg(board)).toBe(toSvg(board));
    expect(toSvg(Board.decode(board.encode()))).toBe(toSvg(board));
  });

  test("sizes an empty board", () => {
    expect(toSvg(new Board())).toMatch(/^<svg [^>]*width="\d+" height="\d+"/);
  });

  test("skips a dangling connector and never prints NaN", () => {
    const board = new Board();
    board.addShape({ id: "a", type: "rect", x: 0, y: 0 }, human);
    board.addShape({ id: "b", type: "rect", x: 0, y: 0 }, human);
    board.addShape({ id: "c", type: "frame", x: 500, y: 0, text: "Frame" }, human);
    board.addConnector({ id: "self", from: { id: "a" }, to: { id: "a" }, text: "loop" }, human);
    board.addConnector({ id: "same", from: { id: "a" }, to: { id: "b" } }, human);
    board.addConnector({ id: "free", from: { id: "a" }, to: { x: 90, y: 90 } }, human);
    board.addConnector({ id: "gone", from: { id: "a" }, to: { id: "b" } }, human);
    const peer = Board.decode(board.encode());
    peer.doc.getMap("elements").delete("b");
    const svg = toSvg(peer);
    expect(svg).not.toMatch(/NaN|Infinity|undefined/);
    expect(svg).toContain('data-id="self"');
    expect(svg).not.toContain('data-id="gone"');
  });

  test("wraps long words and long text", () => {
    const board = new Board();
    board.addShape({ id: "a", type: "rect", x: 0, y: 0, text: "x".repeat(5000) }, human);
    board.addShape({ id: "b", type: "rect", x: 0, y: 200, text: "word ".repeat(2000) }, human);
    const svg = toSvg(board);
    expect((svg.match(/<tspan/g) ?? []).length).toBeLessThanOrEqual(80);
    expect(svg.length).toBeLessThan(40_000);
  });

  test("marks agent work as machine-made", () => {
    const board = new Board();
    board.addShape({ id: "h", type: "rect", x: 0, y: 0 }, human);
    board.addShape({ id: "m", type: "rect", x: 0, y: 100 }, agent);
    const svg = toSvg(board);
    expect(svg).toMatch(/data-id="m"[^>]*data-machine-made="true"/);
    expect(svg).toMatch(/data-id="h"[^>]*data-machine-made="false"/);
  });

  test("spreads connectors that share a pair of shapes", () => {
    const board = new Board();
    board.addShape({ id: "a", type: "rect", x: 0, y: 0 }, human);
    board.addShape({ id: "b", type: "rect", x: 300, y: 0 }, human);
    for (const [id, from, to] of [["k1", "a", "b"], ["k2", "b", "a"], ["k3", "a", "b"], ["l1", "a", "a"], ["l2", "a", "a"]]) {
      board.addConnector({ id, from: { id: from }, to: { id: to }, text: id }, human);
    }
    const svg = toSvg(board);
    const paths = [...svg.matchAll(/<path d="([^"]+)" fill="none"/g)].map((m) => m[1]);
    expect(paths).toHaveLength(5);
    expect(new Set(paths).size).toBe(5);
    expect(svg).not.toMatch(/NaN|Infinity/);
  });
});

const TAGS = new Set(["svg", "title", "defs", "marker", "path", "rect", "g", "text", "tspan", "ellipse", "polygon", "image"]);
const ATTRS = new Set(
  ("xmlns width height viewBox font-family font-size fill role aria-label id refX refY markerWidth markerHeight orient d x y " +
    "stroke stroke-width rx ry cx cy points href preserveAspectRatio marker-start marker-end stroke-dasharray paint-order " +
    "text-anchor dominant-baseline data-id data-type data-author-kind data-machine-made").split(" "),
);
const TYPES = new Set(["rect", "ellipse", "diamond", "text", "sticky", "frame", "image", "connector"]);
const KINDS = new Set<string>(PRINCIPAL_KINDS);

/** Split the SVG into tags and text. Fail when any byte is outside a well-formed, allowed tag. */
function inspect(svg: string): string[] {
  const problems: string[] = [];
  let seen = 0;
  for (const m of svg.matchAll(/<(\/?)([a-zA-Z]+)((?:\s+[a-zA-Z:-]+="[^"<]*")*)\s*(\/?)>|[^<]+/g)) {
    if (m.index !== seen) problems.push(`stray markup at ${seen}`);
    seen = m.index! + m[0].length;
    if (m[2] === undefined) continue;
    if (!TAGS.has(m[2])) problems.push(`tag ${m[2]}`);
    for (const a of m[3].matchAll(/\s+([a-zA-Z:-]+)="([^"]*)"/g)) {
      if (!ATTRS.has(a[1])) problems.push(`attribute ${a[1]}`);
      if (a[1] === "data-type" && !TYPES.has(a[2])) problems.push(`data-type ${a[2]}`);
      if (a[1] === "data-author-kind" && !KINDS.has(a[2])) problems.push(`data-author-kind ${a[2]}`);
      if (a[1] === "data-machine-made" && a[2] !== "true" && a[2] !== "false") problems.push(`data-machine-made ${a[2]}`);
      if (a[1] === "href" && !/^(data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*)$/.test(a[2])) problems.push("href");
    }
  }
  if (seen !== svg.length) problems.push("trailing bytes");
  return problems;
}

const QUOTE = 'x" onload="alert(1)';
const SCRIPT = '"/><script>alert(1)</script><g a="';
const bad = { kind: QUOTE, id: SCRIPT };

describe("svg: a peer plants every field", () => {
  function planted(set: (shape: Y.Map<unknown>, connector: Y.Map<unknown>, doc: Y.Doc) => void): string {
    const board = new Board();
    board.addShape({ id: "a", type: "rect", x: 0, y: 0, text: "A" }, human);
    board.addShape({ id: "b", type: "image", x: 200, y: 0, src: "blob:k1" }, human);
    board.addConnector({ id: "k", from: { id: "a" }, to: { id: "b" }, text: "go" }, human);
    const peer = Board.decode(board.encode());
    const map = peer.doc.getMap<Y.Map<unknown>>("elements");
    set(map.get("a")!, map.get("k")!, peer.doc);
    return toSvg(peer);
  }
  const shapeFields: [string, unknown][] = [
    ["type", QUOTE],
    ["type", SCRIPT],
    ["type", 7],
    ["author", bad],
    ["author", "text"],
    ["author", null],
    ["author", { kind: { a: 1 }, id: 3 }],
    ["editedBy", bad],
    ["id", QUOTE],
    ["id", { a: 1 }],
    ["groupId", SCRIPT],
    ["text", SCRIPT],
    ["text", { a: 1 }],
    ["text", 12],
    ["fill", SCRIPT],
    ["fill", ["#fff"]],
    ["stroke", QUOTE],
    ["x", "1\" onload=\"x"],
    ["x", "NaN"],
    ["y", Number.POSITIVE_INFINITY],
    ["y", Number.NaN],
    ["w", "0"],
    ["w", 0],
    ["w", -5],
    ["h", 1e308],
    ["h", { a: 1 }],
    ["z", SCRIPT],
  ];
  test.each(shapeFields)("shape field %s = %j", (field, value) => {
    const svg = planted((shape) => shape.set(field, value));
    expect(inspect(svg)).toEqual([]);
    expect(svg).not.toMatch(/NaN|Infinity|undefined|\[object/);
  });
  test.each([
    ["from", SCRIPT],
    ["to", { id: QUOTE }],
    ["to", { x: "1", y: "2" }],
    ["from", { x: Number.NaN, y: 0 }],
    ["text", SCRIPT],
    ["stroke", QUOTE],
    ["startArrow", SCRIPT],
    ["author", bad],
  ])("connector field %s = %j", (field, value) => {
    const svg = planted((_s, connector) => connector.set(field, value));
    expect(inspect(svg)).toEqual([]);
    expect(svg).not.toMatch(/NaN|Infinity|undefined|\[object/);
  });
  test("image src and the board title", () => {
    const svg = planted((_s, _c, doc) => {
      doc.getMap<Y.Map<unknown>>("elements").get("b")!.set("src", `data:image/png;base64,AAAA${QUOTE}`);
      doc.getMap("meta").set("title", SCRIPT);
    });
    expect(inspect(svg)).toEqual([]);
  });
  test("a planted author kind drops the element, because the board hides it", () => {
    const svg = planted((shape) => shape.set("author", bad));
    expect(svg).not.toContain('data-id="a"');
    expect(inspect(svg)).toEqual([]);
  });
  test("a planted type is dropped", () => {
    const svg = planted((shape) => shape.set("type", QUOTE));
    expect(svg).not.toContain('data-id="a"');
  });
  test("refuses a board past the element cap", () => {
    const doc = new Y.Doc();
    const map = doc.getMap<Y.Map<unknown>>("elements");
    doc.transact(() => {
      for (let i = 0; i <= MAX_ELEMENTS; i++) map.set(`s${i}`, new Y.Map(Object.entries({ id: `s${i}`, type: "rect", z: i, x: i, y: 0, w: 1, h: 1, text: "", author: human, editedBy: human })));
    });
    expect(() => toSvg(new Board(doc))).toThrowError(/at most/);
  });
});
