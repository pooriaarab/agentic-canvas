import dagre from "@dagrejs/dagre";
import * as Y from "yjs";
import { Board, CanvasError, type ShapeType } from "./board.js";
import type { Principal } from "./principal.js";

// A flowchart from text. One statement per line:
//   direction LR              (TB is the default)
//   A[Box] -> B{Choice}: label
//   C(Rounded)                (a node alone)
// [text] is a box, (text) an ellipse, {text} a diamond. A bare id is a box with
// the id as its text. Lines that start with # or // are comments.

export const MAX_FLOW_NODES = 500;
export const MAX_FLOW_EDGES = 2000;
const MAX_FLOW_CHARS = 200_000;

export interface FlowNode {
  id: string;
  text: string;
  shape: Extract<ShapeType, "rect" | "ellipse" | "diamond">;
}
export interface FlowEdge {
  from: string;
  to: string;
  text: string;
}
export interface FlowGraph {
  direction: "TB" | "LR";
  nodes: FlowNode[];
  edges: FlowEdge[];
}

const NODE = String.raw`([A-Za-z0-9_-]{1,48})(?:\[([^\]]*)\]|\(([^)]*)\)|\{([^}]*)\})?`;
const EDGE = new RegExp(String.raw`^${NODE}\s*->\s*${NODE}\s*(?::(.*))?$`);
const ALONE = new RegExp(String.raw`^${NODE}$`);
const SHAPES = ["rect", "ellipse", "diamond"] as const;

export function parseFlow(source: string): FlowGraph {
  if (source.length > MAX_FLOW_CHARS) throw new CanvasError("LIMIT", `flow text is over ${MAX_FLOW_CHARS} characters`);
  const graph: FlowGraph = { direction: "TB", nodes: [], edges: [] };
  const byId = new Map<string, FlowNode & { explicit: boolean }>();
  const fail = (line: number, message: string): never => {
    throw new CanvasError("INVALID", `line ${line}: ${message}`);
  };
  const node = (line: number, m: RegExpMatchArray, at: number): string => {
    const id = m[at];
    const brackets = m.slice(at + 1, at + 4);
    const open = brackets.findIndex((b) => b !== undefined);
    const shape = SHAPES[Math.max(open, 0)];
    const text = (open < 0 ? "" : brackets[open].trim()) || id;
    const known = byId.get(id);
    if (!known) {
      const created = { id, text, shape, explicit: open >= 0 };
      byId.set(id, created);
      graph.nodes.push(created);
    } else if (open >= 0) {
      if (known.explicit && (known.text !== text || known.shape !== shape)) fail(line, `"${id}" is defined twice with different text`);
      Object.assign(known, { text, shape, explicit: true });
    }
    return id;
  };
  source
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .forEach((raw, index) => {
      const line = index + 1;
      const text = raw.trim();
      if (text === "" || text.startsWith("#") || text.startsWith("//")) return;
      if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(text)) fail(line, "control characters are not allowed");
      const direction = /^direction\s+(\S+)$/.exec(text);
      if (direction) {
        if (direction[1] !== "TB" && direction[1] !== "LR") fail(line, `direction must be TB or LR, got "${direction[1]}"`);
        graph.direction = direction[1] as "TB" | "LR";
        return;
      }
      const edge = EDGE.exec(text);
      if (edge) {
        const from = node(line, edge, 1);
        const to = node(line, edge, 5);
        graph.edges.push({ from, to, text: (edge[9] ?? "").trim() });
      } else {
        const alone = ALONE.exec(text);
        if (!alone) fail(line, `cannot read "${text.slice(0, 40)}". Use "A -> B: label".`);
        else node(line, alone, 1);
      }
      if (graph.nodes.length > MAX_FLOW_NODES) throw new CanvasError("LIMIT", `a flow holds at most ${MAX_FLOW_NODES} nodes`);
      if (graph.edges.length > MAX_FLOW_EDGES) throw new CanvasError("LIMIT", `a flow holds at most ${MAX_FLOW_EDGES} edges`);
    });
  if (graph.nodes.length === 0) throw new CanvasError("INVALID", "the flow has no nodes");
  return { ...graph, nodes: graph.nodes.map(({ id, text, shape }) => ({ id, text, shape })) };
}

export interface Placement {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function sizeOf(n: FlowNode): { w: number; h: number } {
  const w = Math.min(360, Math.max(120, 24 + 8 * n.text.length));
  return n.shape === "diamond" ? { w: Math.min(360, Math.round(w * 1.5)), h: 90 } : { w, h: 60 };
}

/** Layered layout. The top-left of the result is (0, 0). The layout breaks cycles and handles self-loops. */
export function layoutFlow(graph: FlowGraph): Placement[] {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: graph.direction, nodesep: 40, ranksep: 70, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  const sizes = new Map(graph.nodes.map((n) => [n.id, sizeOf(n)]));
  for (const [id, { w, h }] of sizes) g.setNode(id, { width: w, height: h });
  graph.edges.forEach((e, i) => g.setEdge(e.from, e.to, {}, String(i)));
  dagre.layout(g);
  const boxes = graph.nodes.map((n) => {
    const { w, h } = sizes.get(n.id)!;
    const c = g.node(n.id);
    return { id: n.id, x: Math.round(c.x - w / 2), y: Math.round(c.y - h / 2), w, h };
  });
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  return boxes.map((b) => ({ ...b, x: b.x - minX, y: b.y - minY }));
}

export interface DrawOptions {
  /** Put in front of every id, so two flows can share a board. Up to 16 of A-Z, a-z, 0-9, _ and -. */
  idPrefix?: string;
  /** Top-left of the drawing. Default: below the shapes already on the board. */
  origin?: { x: number; y: number };
}

/** Draw a flow on the board. All or nothing: on any error the board stays as it was. */
export function drawFlow(
  board: Board,
  source: string,
  actor: Principal,
  options: DrawOptions = {},
): { nodes: string[]; edges: string[] } {
  const prefix = options.idPrefix ?? "";
  if (!/^[A-Za-z0-9_-]{0,16}$/.test(prefix)) throw new CanvasError("INVALID", "idPrefix must be up to 16 of A-Z, a-z, 0-9, _ and -");
  const graph = parseFlow(source);
  const placed = layoutFlow(graph);
  const shapes = board.list().flatMap((e) => (e.type === "connector" || e.type === "group" ? [] : [e]));
  const origin = options.origin ?? {
    x: shapes.length ? Math.min(...shapes.map((s) => s.x)) : 0,
    y: shapes.length ? Math.max(...shapes.map((s) => s.y + s.h)) + 80 : 0,
  };
  const work = board.clone();
  const text = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const p of placed) {
    const n = text.get(p.id)!;
    work.addShape({ id: prefix + p.id, type: n.shape, text: n.text, x: p.x + origin.x, y: p.y + origin.y, w: p.w, h: p.h }, actor);
  }
  const edges = graph.edges.map((e, i) => {
    const id = `${prefix}edge_${i + 1}`;
    work.addConnector({ id, from: { id: prefix + e.from }, to: { id: prefix + e.to }, text: e.text }, actor);
    return id;
  });
  Y.applyUpdate(board.doc, Y.encodeStateAsUpdate(work.doc, Y.encodeStateVector(board.doc)));
  return { nodes: placed.map((p) => prefix + p.id), edges };
}
