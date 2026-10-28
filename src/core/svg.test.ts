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
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { Board, type Principal } from "../index.js";
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
