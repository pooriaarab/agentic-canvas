import { COLOR_PATTERN, IMAGE_PATTERN, MAX_ELEMENTS, CanvasError, SHAPE_TYPES, type Board, type Connector, type Endpoint, type Shape } from "./board.js";

// Pure and deterministic: the same board gives the same bytes. Fonts are the
// system sans-serif, so the output fetches nothing.
//
// The doc is shared, so a peer can write any value into any field, past the
// write API. Nothing read from the doc is trusted: text goes through esc(),
// the type and the author kind are printed only from a fixed list, and a number
// that is not finite and in range drops its element.

const LINE = 17;
const num = (n: number): string => String(Math.round(n * 100) / 100);
const esc = (value: unknown): string =>
  (typeof value === "string" ? value : "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const paint = (value: unknown, fallback: string): string => (typeof value === "string" && COLOR_PATTERN.test(value) ? value : fallback);
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const within = (n: unknown, low: number, high: number): n is number => typeof n === "number" && Number.isFinite(n) && n >= low && n <= high;
const LIMIT_COORD = 1e7;
const TYPES: ReadonlySet<unknown> = new Set([...SHAPE_TYPES, "connector", "group"]);
const sane = (s: Shape): boolean => within(s.x, -LIMIT_COORD, LIMIT_COORD) && within(s.y, -LIMIT_COORD, LIMIT_COORD) && within(s.w, 1e-6, LIMIT_COORD) && within(s.h, 1e-6, LIMIT_COORD);

type Pt = { x: number; y: number };
const isShape = (v: Shape | Pt): v is Shape => "w" in v;
const center = (s: Shape): Pt => ({ x: s.x + s.w / 2, y: s.y + s.h / 2 });

/** Where a line from the centre of `s` toward `toward` leaves the outline. */
function edgePoint(s: Shape, toward: Pt): Pt {
  const c = center(s);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const a = s.w / 2;
  const b = s.h / 2;
  const k =
    s.type === "ellipse"
      ? 1 / Math.hypot(dx / a, dy / b)
      : s.type === "diamond"
        ? 1 / (Math.abs(dx) / a + Math.abs(dy) / b)
        : Math.min(a / Math.abs(dx), b / Math.abs(dy));
  return { x: c.x + dx * k, y: c.y + dy * k };
}

function wrap(text: string, width: number): string[] {
  const max = Math.max(4, Math.floor((width - 16) / 7.5));
  const out: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const chars = [...word];
      while (chars.length > max) {
        if (line) out.push(line);
        line = "";
        out.push(chars.splice(0, max).join(""));
      }
      const rest = chars.join("");
      if (line && [...line].length + 1 + chars.length > max) {
        out.push(line);
        line = rest;
      } else line = line ? `${line} ${rest}` : rest;
    }
    out.push(line);
  }
  return out.slice(0, 40);
}

function label(text: string, cx: number, cy: number, width: number, extra = ""): string {
  if (text === "") return "";
  const lines = wrap(text, width);
  const top = cy - ((lines.length - 1) * LINE) / 2;
  const spans = lines.map((l, i) => `<tspan x="${num(cx)}" y="${num(top + i * LINE)}">${esc(l)}</tspan>`);
  return `<text text-anchor="middle" dominant-baseline="central"${extra}>${spans.join("")}</text>`;
}

function shapeBody(s: Shape): string {
  const { x, y, w, h } = s;
  const stroke = paint(s.stroke, "#1f2937");
  const look = (fill: string, more = "") => `fill="${paint(s.fill, fill)}" stroke="${stroke}" stroke-width="2"${more}`;
  const text = label(str(s.text), x + w / 2, y + h / 2, w);
  switch (s.type) {
    case "ellipse":
      return `<ellipse cx="${num(x + w / 2)}" cy="${num(y + h / 2)}" rx="${num(w / 2)}" ry="${num(h / 2)}" ${look("#ffffff")}/>${text}`;
    case "diamond": {
      const pts = [[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]];
      return `<polygon points="${pts.map(([px, py]) => `${num(px)},${num(py)}`).join(" ")}" ${look("#ffffff")}/>${text}`;
    }
    case "text":
      return text;
    case "frame":
      return `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" ${look("none", ' stroke-dasharray="8 6"')}/>${label(str(s.text), x + w / 2, y - 12, w)}`;
    case "image":
      if (typeof s.src === "string" && s.src.startsWith("data:") && IMAGE_PATTERN.test(s.src)) {
        return `<image href="${s.src}" x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" preserveAspectRatio="xMidYMid meet"/>`;
      }
      return `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" ${look("#f3f4f6", ' stroke-dasharray="4 4"')}/>${label("image", x + w / 2, y + h / 2, w)}`;
    default:
      return `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="${s.type === "sticky" ? 2 : 6}" ${look(s.type === "sticky" ? "#fde68a" : "#ffffff")}/>${text}`;
  }
}

type Lane = { index: number; count: number };
const endKey = (e: Endpoint): string => ("id" in e ? e.id : `${e.x},${e.y}`);
const wellFormed = (e: unknown): e is Endpoint =>
  typeof e === "object" && e !== null && (typeof (e as { id?: unknown }).id === "string" || (within((e as Pt).x, -LIMIT_COORD, LIMIT_COORD) && within((e as Pt).y, -LIMIT_COORD, LIMIT_COORD)));

function connectorBody(c: Connector, shapes: Map<string, Shape>, lane: Lane): string {
  const resolve = (e: Endpoint): Shape | Pt | undefined => ("id" in e ? shapes.get(e.id) : e);
  const a = resolve(c.from);
  const b = resolve(c.to);
  if (!a || !b) return "";
  let d: string;
  let at: Pt;
  if (isShape(a) && a === b) {
    const x0 = a.x + a.w * 0.35;
    const x1 = a.x + a.w * 0.65;
    const lift = 45 + 32 * lane.index;
    d = `M${num(x0)} ${num(a.y)}C${num(x0)} ${num(a.y - lift)} ${num(x1)} ${num(a.y - lift)} ${num(x1)} ${num(a.y)}`;
    at = { x: a.x + a.w / 2, y: a.y - lift * 0.75 - 6 };
  } else {
    const ca = isShape(a) ? center(a) : a;
    const cb = isShape(b) ? center(b) : b;
    // Side by side: the same normal for both directions, so A to B and B to A part ways.
    const flip = endKey(c.from) > endKey(c.to);
    const dx = (flip ? ca.x - cb.x : cb.x - ca.x) || 0;
    const dy = (flip ? ca.y - cb.y : cb.y - ca.y) || 0;
    const len = Math.hypot(dx, dy) || 1;
    const offset = (lane.index - (lane.count - 1) / 2) * 44;
    const mid = { x: (ca.x + cb.x) / 2, y: (ca.y + cb.y) / 2 };
    const ctrl = { x: mid.x - (dy / len) * 2 * offset, y: mid.y + (dx / len) * 2 * offset };
    const p = isShape(a) ? edgePoint(a, ctrl) : a;
    const q = isShape(b) ? edgePoint(b, ctrl) : b;
    d = offset === 0 ? `M${num(p.x)} ${num(p.y)}L${num(q.x)} ${num(q.y)}` : `M${num(p.x)} ${num(p.y)}Q${num(ctrl.x)} ${num(ctrl.y)} ${num(q.x)} ${num(q.y)}`;
    at = offset === 0 ? { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 } : { x: (p.x + q.x) / 4 + ctrl.x / 2, y: (p.y + q.y) / 4 + ctrl.y / 2 };
  }
  const marks = `${c.startArrow ? ' marker-start="url(#arrow)"' : ""}${c.endArrow ? ' marker-end="url(#arrow)"' : ""}`;
  const halo = ' stroke="#ffffff" stroke-width="4" paint-order="stroke"';
  return `<path d="${d}" fill="none" stroke="${paint(c.stroke, "#1f2937")}" stroke-width="2"${marks}/>${label(str(c.text), at.x, at.y, 160, halo)}`;
}

const drawable = (el: { type: unknown } & Record<string, unknown>): boolean =>
  TYPES.has(el.type) &&
  (el.type === "connector" ? wellFormed(el.from) && wellFormed(el.to) : el.type === "group" || sane(el as unknown as Shape));

/** Draw the board, back to front, on a white background. */
export function toSvg(board: Board): string {
  const listed = board.list();
  if (listed.length > MAX_ELEMENTS) throw new CanvasError("LIMIT", `a board holds at most ${MAX_ELEMENTS} elements`);
  const all = listed.filter((el) => drawable(el as never));
  const shapes = new Map<string, Shape>();
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const grow = (x: number, y: number): void => {
    box.minX = Math.min(box.minX, x);
    box.minY = Math.min(box.minY, y);
    box.maxX = Math.max(box.maxX, x);
    box.maxY = Math.max(box.maxY, y);
  };
  for (const el of all) {
    if (el.type === "connector") {
      for (const e of [el.from, el.to]) if (!("id" in e)) grow(e.x, e.y);
    } else if (el.type !== "group") {
      shapes.set(el.id, el);
      grow(el.x, el.y);
      grow(el.x + el.w, el.y + el.h);
    }
  }
  const pad = 80;
  const any = box.minX !== Infinity;
  const minX = any ? box.minX - pad : 0;
  const minY = any ? box.minY - pad : 0;
  const width = any ? Math.ceil(box.maxX + pad - minX) : 240;
  const height = any ? Math.ceil(box.maxY + pad - minY) : 120;
  const lanes = new Map<string, Lane>();
  const groups = new Map<string, string[]>();
  for (const el of all) {
    if (el.type !== "connector") continue;
    const key = [endKey(el.from), endKey(el.to)].sort().join("|");
    groups.set(key, [...(groups.get(key) ?? []), el.id]);
  }
  for (const ids of groups.values()) ids.forEach((id, index) => lanes.set(id, { index, count: ids.length }));
  const body = all.map((el) => {
    if (el.type === "group") return "";
    const inner = el.type === "connector" ? connectorBody(el, shapes, lanes.get(el.id)!) : shapeBody(el);
    if (inner === "") return "";
    const kind = el.author.kind;
    const mark = `data-id="${esc(el.id)}" data-type="${el.type}" data-author-kind="${kind}" data-machine-made="${kind !== "human"}"`;
    return `<g ${mark}>${inner}</g>`;
  });
  const title = esc(board.title) || "Whiteboard";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${num(minX)} ${num(minY)} ${width} ${height}" font-family="sans-serif" font-size="14" fill="#111827" role="img" aria-label="${title}">`,
    `<title>${title}</title>`,
    '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1f2937"/></marker></defs>',
    `<rect x="${num(minX)}" y="${num(minY)}" width="${width}" height="${height}" fill="#ffffff"/>`,
    ...body.filter(Boolean),
    "</svg>",
  ].join("\n");
}
