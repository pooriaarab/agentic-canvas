import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { BoardData, EdgeData, NodeData } from "../src/core/read";

export interface View { x: number; y: number; k: number }
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 4;
const STEP = 10;

export const TYPE_NAME: Record<string, string> = { rect: "Rectangle", ellipse: "Ellipse", diamond: "Diamond", text: "Text", sticky: "Sticky note", frame: "Frame", image: "Image", connector: "Connector" };

/** Who made an item, in words, for a screen reader and for the inspector. */
export function byline(el: NodeData | EdgeData): string {
  const made = `${el.machineMade ? "agent " : ""}${el.author.id}`;
  const edit = el.lastEditMachineMade && !el.machineMade ? `, edited by agent ${el.editedBy.id}` : "";
  return `made by ${made}${edit}`;
}

export const label = (el: NodeData | EdgeData): string => `${TYPE_NAME[el.type] ?? el.type}${el.text ? `: ${el.text}` : ""}, ${byline(el)}`;

/** Break text into lines that fit a width. Characters are about 7.5 px wide at 14 px. */
export function wrap(text: string, width: number, maxLines: number): string[] {
  const per = Math.max(3, Math.floor(width / 7.5));
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      for (let w = word; ; ) {
        const room = per - (line ? line.length + 1 : 0);
        if (w.length <= room) {
          line = line ? `${line} ${w}` : w;
          break;
        }
        if (line) {
          lines.push(line);
          line = "";
        } else {
          lines.push(w.slice(0, per));
          w = w.slice(per);
        }
      }
    }
    lines.push(line);
  }
  if (lines.length > maxLines) {
    lines.length = Math.max(1, maxLines);
    lines[lines.length - 1] = `${lines[lines.length - 1].slice(0, Math.max(0, per - 1))}…`;
  }
  return lines;
}

type Draft = { id: string; kind: "move" | "resize"; dx: number; dy: number };
type Box = { x: number; y: number; w: number; h: number };

/** Where the line from the center of `box` toward (tx, ty) leaves the box. */
function edgePoint(box: Box, tx: number, ty: number): [number, number] {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const s = Math.min(box.w / 2 / (Math.abs(dx) || Infinity), box.h / 2 / (Math.abs(dy) || Infinity));
  return [cx + dx * s, cy + dy * s];
}

export interface CanvasProps {
  data: BoardData;
  selected: string | null;
  editable: boolean;
  view: View;
  onView: (view: View) => void;
  onSelect: (id: string | null) => void;
  onMove: (id: string, dx: number, dy: number) => void;
  onResize: (id: string, w: number, h: number) => void;
  onDelete: (id: string) => void;
}

export function Canvas({ data, selected, editable, view, onView, onSelect, onMove, onResize, onDelete }: CanvasProps) {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ kind: "move" | "resize" | "pan"; id?: string; sx: number; sy: number; vx: number; vy: number; moved: boolean } | undefined>(undefined);
  const [draft, setDraft] = useState<Draft>();
  const viewRef = useRef(view);
  viewRef.current = view;

  // A wheel turn zooms around the pointer. React's own wheel handler cannot stop the page from scrolling.
  useEffect(() => {
    const el = box.current!;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(event.clientX - rect.left, event.clientY - rect.top, event.deltaY < 0 ? 1.1 : 1 / 1.1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  function zoomAt(px: number, py: number, factor: number) {
    const v = viewRef.current;
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * factor));
    onView({ k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k });
  }

  const shown = (n: NodeData): Box => {
    if (draft?.id !== n.id) return n;
    return draft.kind === "move" ? { ...n, x: n.x + draft.dx, y: n.y + draft.dy } : { ...n, w: Math.max(20, n.w + draft.dx), h: Math.max(20, n.h + draft.dy) };
  };
  const nodes = new Map(data.nodes.map((n) => [n.id, n]));

  function begin(event: PointerEvent, kind: "move" | "resize" | "pan", id?: string) {
    event.stopPropagation();
    if (kind !== "pan") onSelect(id!);
    if (kind === "pan") onSelect(null);
    if (kind !== "pan" && !editable) return;
    box.current?.setPointerCapture(event.pointerId);
    drag.current = { kind, id, sx: event.clientX, sy: event.clientY, vx: view.x, vy: view.y, moved: false };
  }
  function track(event: PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const mx = event.clientX - d.sx;
    const my = event.clientY - d.sy;
    if (Math.abs(mx) + Math.abs(my) > 3) d.moved = true;
    if (d.kind === "pan") onView({ ...view, x: d.vx + mx, y: d.vy + my });
    else if (d.moved) setDraft({ id: d.id!, kind: d.kind, dx: mx / view.k, dy: my / view.k });
  }
  function end() {
    const d = drag.current;
    drag.current = undefined;
    if (!d || d.kind === "pan" || !draft || !d.moved) return setDraft(undefined);
    const node = nodes.get(draft.id);
    setDraft(undefined);
    if (!node) return;
    if (draft.kind === "move") onMove(draft.id, Math.round(draft.dx), Math.round(draft.dy));
    else onResize(draft.id, Math.round(Math.max(20, node.w + draft.dx)), Math.round(Math.max(20, node.h + draft.dy)));
  }

  function key(event: KeyboardEvent) {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select")) return;
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const el = selected ? (nodes.get(selected) ?? undefined) : undefined;
    if (event.key in arrows) {
      const [ax, ay] = arrows[event.key];
      event.preventDefault();
      if (el && editable) {
        if (event.shiftKey) onResize(el.id, Math.max(20, el.w + ax * STEP), Math.max(20, el.h + ay * STEP));
        else onMove(el.id, ax * STEP, ay * STEP);
      } else if (!selected) onView({ ...view, x: view.x - ax * 40, y: view.y - ay * 40 });
    } else if ((event.key === "Delete" || event.key === "Backspace") && selected && editable) {
      event.preventDefault();
      onDelete(selected);
    } else if (event.key === "Escape") {
      onSelect(null);
    } else if (event.key === "+" || event.key === "=" || event.key === "-") {
      const rect = box.current!.getBoundingClientRect();
      zoomAt(rect.width / 2, rect.height / 2, event.key === "-" ? 1 / 1.25 : 1.25);
    } else if (event.key === "0") onView({ x: 0, y: 0, k: 1 });
  }

  const itemProps = (el: NodeData | EdgeData) => ({
    className: `item${selected === el.id ? " selected" : ""}`,
    tabIndex: 0,
    role: "button" as const,
    "aria-pressed": selected === el.id,
    "aria-label": label(el),
    onFocus: () => onSelect(el.id),
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onSelect(el.id);
      }
    },
  });
  const badge = (el: NodeData | EdgeData, x: number, y: number) =>
    el.machineMade || el.lastEditMachineMade ? (
      <g className="agent-badge" data-badge-for={el.id} aria-hidden="true" pointerEvents="none">
        <rect x={x} y={y - 20} width={el.machineMade ? 50 : 82} height={18} rx={4} />
        <text x={x + 6} y={y - 7}>{el.machineMade ? "Agent" : "Agent edit"}</text>
      </g>
    ) : null;

  return (
    <div ref={box} className="canvas" role="group" aria-label="Board canvas. Tab moves between items. Arrow keys move the selected item, Shift with arrows resizes it, Delete removes it, Escape clears the selection." tabIndex={0} onKeyDown={key} onPointerMove={track} onPointerUp={end} onPointerCancel={end}>
      <svg width="100%" height="100%" onPointerDown={(e) => begin(e, "pan")}>
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" className="arrowhead" /></marker>
        </defs>
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {data.edges.map((e) => {
            const a = "id" in e.from ? nodes.get(e.from.id) : undefined;
            const b = "id" in e.to ? nodes.get(e.to.id) : undefined;
            if (("id" in e.from && !a) || ("id" in e.to && !b)) return null;
            const A = a ? shown(a) : null;
            const B = b ? shown(b) : null;
            const to0: [number, number] = B ? [B.x + B.w / 2, B.y + B.h / 2] : [(e.to as { x: number }).x, (e.to as { y: number }).y];
            const from0: [number, number] = A ? [A.x + A.w / 2, A.y + A.h / 2] : [(e.from as { x: number }).x, (e.from as { y: number }).y];
            const [x1, y1] = A ? edgePoint(A, ...to0) : from0;
            const [x2, y2] = B ? edgePoint(B, ...from0) : to0;
            return (
              <g key={e.id}>
              <g {...itemProps(e)} data-id={e.id} onPointerDown={(ev) => (ev.stopPropagation(), onSelect(e.id))}>
                <line x1={x1} y1={y1} x2={x2} y2={y2} className="hit" />
                <line x1={x1} y1={y1} x2={x2} y2={y2} className="edge" markerEnd={e.endArrow ? "url(#arrow)" : undefined} markerStart={e.startArrow ? "url(#arrow)" : undefined} />
                {e.text && <text aria-hidden="true" x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6} className="edge-text" textAnchor="middle">{e.text}</text>}
                {selected === e.id && <line x1={x1} y1={y1} x2={x2} y2={y2} className="ring-line" />}
              </g>
              {badge(e, (x1 + x2) / 2 - 25, (y1 + y2) / 2 - 14)}
              </g>
            );
          })}
          {data.nodes.map((n) => {
            const s = shown(n);
            const lines = wrap(n.text, s.w - 16, Math.floor((s.h - 8) / 18));
            const top = n.type === "frame" ? s.y + 18 : s.y + s.h / 2 - ((lines.length - 1) * 18) / 2 + 5;
            const anchor = n.type === "frame" ? "start" : "middle";
            const tx = n.type === "frame" ? s.x + 8 : s.x + s.w / 2;
            return (
              <g key={n.id}>
              <g {...itemProps(n)} data-id={n.id} onPointerDown={(ev) => begin(ev, "move", n.id)}>
                {n.type === "ellipse" ? <ellipse cx={s.x + s.w / 2} cy={s.y + s.h / 2} rx={s.w / 2} ry={s.h / 2} className="shape" />
                  : n.type === "diamond" ? <polygon points={`${s.x + s.w / 2},${s.y} ${s.x + s.w},${s.y + s.h / 2} ${s.x + s.w / 2},${s.y + s.h} ${s.x},${s.y + s.h / 2}`} className="shape" />
                  : <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={n.type === "sticky" ? 2 : 6} className={`shape ${n.type}`} />}
                <text aria-hidden="true" x={tx} y={top} textAnchor={anchor} className={n.type === "sticky" ? "label sticky-label" : "label"}>
                  {n.type === "image" && !n.text ? <tspan>Image</tspan> : lines.map((l, i) => <tspan key={i} x={tx} dy={i === 0 ? 0 : 18}>{i < lines.length - 1 ? `${l} ` : l}</tspan>)}
                </text>
                {selected === n.id && <rect x={s.x - 4} y={s.y - 4} width={s.w + 8} height={s.h + 8} rx={8} className="ring" />}
                {selected === n.id && editable && <circle cx={s.x + s.w + 4} cy={s.y + s.h + 4} r={7 / view.k} className="handle" onPointerDown={(ev) => begin(ev, "resize", n.id)} />}
              </g>
              {badge(n, s.x, s.y)}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
