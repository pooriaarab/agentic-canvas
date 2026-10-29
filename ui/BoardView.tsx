import { Button, EmptyState, Input, PresenceChip, PresenceStack, Select, Textarea, Toolbar, ToolbarButton, ToolbarSeparator, useToast, type PresenceEntry } from "agentic-design/react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { ShapeType } from "../src/core/board";
import type { BoardData, EdgeData, NodeData } from "../src/core/read";
import { CanvasApiError, clientFor, describe } from "./api";
import { Canvas, MAX_ZOOM, MIN_ZOOM, TYPE_NAME, byline, type View } from "./Canvas";
import { Failure } from "./Failure";
import { joinRoom, type Room } from "./presence";

type State = { state: "loading" } | { state: "error"; message: string; missing: boolean } | { state: "ready"; data: BoardData & { id: string } };
type Item = NodeData | EdgeData;

const icon = (d: ReactNode) => <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">{d}</svg>;
const TOOLS: { type: ShapeType; text: string; icon: ReactNode }[] = [
  { type: "rect", text: "Add rectangle", icon: icon(<rect x="3" y="5" width="14" height="10" rx="2" />) },
  { type: "ellipse", text: "Add ellipse", icon: icon(<ellipse cx="10" cy="10" rx="7" ry="5" />) },
  { type: "diamond", text: "Add diamond", icon: icon(<path d="M10 3l7 7-7 7-7-7z" />) },
  { type: "text", text: "Add text", icon: icon(<path d="M4 5h12M10 5v11" />) },
  { type: "sticky", text: "Add sticky note", icon: icon(<path d="M4 4h12v8l-4 4H4z M12 16v-4h4" />) },
];
const DEFAULT_SIZE: Record<string, [number, number]> = { rect: [140, 70], ellipse: [140, 70], diamond: [140, 90], text: [140, 40], sticky: [150, 120] };
const DEFAULT_TEXT: Record<string, string> = { rect: "Rectangle", ellipse: "Ellipse", diamond: "Decision", text: "Text", sticky: "Note" };

export function BoardView({ id, token, me }: { id: string; token: string; me: { actor: string; role: "editor" | "viewer" } }) {
  const client = useMemo(() => clientFor(token), [token]);
  const toast = useToast();
  const [board, setBoard] = useState<State>({ state: "loading" });
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<View>({ x: 40, y: 40, k: 1 });
  const [peers, setPeers] = useState<PresenceEntry[]>([]);
  const [live, setLive] = useState(false);
  const room = useRef<Room | undefined>(undefined);
  const rev = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const canvasBox = useRef<HTMLDivElement>(null);
  const editable = me.role === "editor";

  const load = useCallback(async () => {
    try {
      const data = await client.readBoard(id);
      setBoard({ state: "ready", data });
    } catch (e) {
      // A failed refresh keeps the board on screen. Only a first load shows the error page.
      setBoard((prev) => (prev.state === "ready" ? prev : { state: "error", message: describe(e), missing: e instanceof CanvasApiError && e.status === 404 }));
    }
  }, [client, id]);
  useEffect(() => {
    setBoard({ state: "loading" });
    void load();
  }, [load]);

  useEffect(() => {
    const joined = joinRoom({ board: id, token, name: me.actor, onPeers: setPeers, onChange: () => void load(), onStatus: setLive });
    room.current = joined;
    return () => (joined.leave(), (room.current = undefined));
  }, [id, token, me.actor, load]);
  // Without the room, the board still follows other editors by a slow refresh.
  useEffect(() => {
    if (live) return;
    const timer = setInterval(() => void load(), 8000);
    return () => clearInterval(timer);
  }, [live, load]);

  /** Run one write after the one before it, then read the board again and tell the room. */
  const write = useCallback(
    (change: () => Promise<unknown>, failure: string, select?: string) => {
      queue.current = queue.current.then(async () => {
        try {
          await change();
          room.current?.setRev(++rev.current);
        } catch (e) {
          toast({ title: failure, description: describe(e), tone: "danger" });
        }
        await load();
        if (select) setSelected(select);
      });
    },
    [load, toast],
  );

  const data = board.state === "ready" ? board.data : undefined;
  const item: Item | undefined = data && selected ? [...data.nodes, ...data.edges].find((i) => i.id === selected) : undefined;
  useEffect(() => {
    if (data && selected && !item) setSelected(null);
  }, [data, selected, item]);

  const patchLocal = (fn: (n: NodeData) => NodeData) => setBoard((b) => (b.state === "ready" ? { state: "ready", data: { ...b.data, nodes: b.data.nodes.map(fn) } } : b));
  const move = (target: string, dx: number, dy: number) => {
    patchLocal((n) => (n.id === target ? { ...n, x: n.x + dx, y: n.y + dy } : n));
    write(() => client.move(id, target, dx, dy), "Could not move the item");
  };
  const resize = (target: string, w: number, h: number) => {
    patchLocal((n) => (n.id === target ? { ...n, w, h } : n));
    write(() => client.update(id, target, { w, h }), "Could not resize the item");
  };
  const remove = (target: string) => {
    setSelected(null);
    write(() => client.remove(id, target), "Could not delete the item");
    canvasBox.current?.querySelector<HTMLElement>("[role=group]")?.focus();
  };
  const add = (type: ShapeType) => {
    const [w, h] = DEFAULT_SIZE[type];
    const n = data?.nodes.length ?? 0;
    const box = canvasBox.current?.getBoundingClientRect();
    const cx = ((box?.width ?? 600) / 2 - view.x) / view.k - w / 2 + (n % 6) * 24;
    const cy = ((box?.height ?? 400) / 2 - view.y) / view.k - h / 2 + (n % 6) * 24;
    const shapeId = `s-${crypto.randomUUID().slice(0, 8)}`;
    write(() => client.addShape(id, { id: shapeId, type, x: Math.round(cx), y: Math.round(cy), w, h, text: DEFAULT_TEXT[type] }), "Could not add the item", shapeId);
  };
  const zoom = (factor: number) => setView((v) => ({ ...v, k: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * factor)) }));

  if (board.state === "loading") return <p role="status">Loading board…</p>;
  if (board.state === "error") {
    return board.missing ? (
      <EmptyState title="This board does not exist" description={<a href="#/">Back to all boards</a>} />
    ) : (
      <Failure message={board.message} retry={() => (setBoard({ state: "loading" }), void load())} />
    );
  }
  const { data: d } = board;
  const empty = d.nodes.length === 0 && d.edges.length === 0;

  return (
    <section className="board" aria-labelledby="board-h">
      <div className="row">
        <h1 id="board-h">{d.title || d.id}</h1>
        <PresenceStack entries={[{ id: "me", name: me.actor, kind: "person" }, ...peers]} label={live ? "In this board" : "In this board (not live)"} />
      </div>
      <Toolbar label="Board tools">
        {TOOLS.map((t) => (
          <ToolbarButton key={t.type} label={t.text} icon={t.icon} disabled={!editable} onClick={() => add(t.type)} />
        ))}
        <ToolbarSeparator />
        <ToolbarButton label="Zoom out" icon={icon(<path d="M4 10h12" />)} onClick={() => zoom(1 / 1.25)} />
        <ToolbarButton label="Zoom in" icon={icon(<path d="M4 10h12M10 4v12" />)} onClick={() => zoom(1.25)} />
        <ToolbarButton label="Reset view" icon={icon(<path d="M4 4h5M4 4v5M16 16h-5M16 16v-5" />)} onClick={() => setView({ x: 40, y: 40, k: 1 })} />
      </Toolbar>
      {!editable && <p className="note">This token can read the board but not change it.</p>}
      <div className="stage" ref={canvasBox}>
        <Canvas data={d} selected={selected} editable={editable} view={view} onView={setView} onSelect={setSelected} onMove={move} onResize={resize} onDelete={remove} />
        {empty && (
          <div className="empty-overlay">
            <EmptyState title="This board is empty" description={editable ? "Add a shape or a note with the tools above." : "Nothing has been drawn yet."} />
          </div>
        )}
        <Inspector key={item?.id ?? "none"} item={item} nodes={d.nodes} editable={editable} onText={(text) => item && write(() => client.update(id, item.id, { text }), "Could not save the text")} onResize={resize} onDelete={remove} onConnect={(to) => item && write(() => client.addConnector(id, { from: { id: item.id }, to: { id: to } }), "Could not connect")} />
      </div>
    </section>
  );
}

const asEntry = (p: { kind: string; id: string }): PresenceEntry => ({ id: p.id, name: p.id, kind: p.kind === "human" ? "person" : "agent" });

function Inspector({ item, nodes, editable, onText, onResize, onDelete, onConnect }: { item?: Item; nodes: NodeData[]; editable: boolean; onText: (text: string) => void; onResize: (id: string, w: number, h: number) => void; onDelete: (id: string) => void; onConnect: (to: string) => void }) {
  const [text, setText] = useState(item?.text ?? "");
  const node = item && item.type !== "connector" ? (item as NodeData) : undefined;
  const [size, setSize] = useState({ w: String(node?.w ?? ""), h: String(node?.h ?? "") });
  if (!item) return <aside className="inspector" aria-label="Selected item"><p>Select an item to edit it.</p></aside>;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (text !== item.text) onText(text);
    if (node) {
      const w = Number(size.w);
      const h = Number(size.h);
      if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 && (w !== node.w || h !== node.h)) onResize(node.id, w, h);
    }
  };
  return (
    <aside className="inspector" aria-label="Selected item">
      <h2>{TYPE_NAME[item.type] ?? item.type}</h2>
      <p className="by">Made by</p>
      <PresenceChip entry={asEntry(item.author)} />
      {item.lastEditMachineMade && !item.machineMade && (
        <>
          <p className="by">Last edit</p>
          <PresenceChip entry={asEntry(item.editedBy)} />
        </>
      )}
      <span className="sr-only">{byline(item)}</span>
      <form onSubmit={submit}>
        <Textarea label="Text" value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={10000} disabled={!editable} />
        {node && (
          <div className="sizes">
            <Input label="Width" type="number" min={20} value={size.w} onChange={(e) => setSize({ ...size, w: e.target.value })} disabled={!editable} />
            <Input label="Height" type="number" min={20} value={size.h} onChange={(e) => setSize({ ...size, h: e.target.value })} disabled={!editable} />
          </div>
        )}
        {editable && <Button type="submit" variant="secondary">Save changes</Button>}
      </form>
      {editable && node && nodes.length > 1 && (
        <Select label="Connect to" value="" onChange={(e) => e.target.value && onConnect(e.target.value)}>
          <option value="">Choose a shape…</option>
          {nodes.filter((n) => n.id !== node.id).map((n) => <option key={n.id} value={n.id}>{TYPE_NAME[n.type]}{n.text ? `: ${n.text.slice(0, 30)}` : ""}</option>)}
        </Select>
      )}
      {editable && <Button variant="danger" onClick={() => onDelete(item.id)}>Delete</Button>}
    </aside>
  );
}
