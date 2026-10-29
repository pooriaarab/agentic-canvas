import { Button, EmptyState, Input, PresenceChip, PresenceStack, Select, Textarea, Toolbar, ToolbarButton, ToolbarSeparator, useToast, type PresenceEntry } from "agentic-design/react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { ShapeType } from "../src/core/board";
import type { BoardData, EdgeData, NodeData } from "../src/core/read";
import type { CanvasClient } from "../src/client";
import { CanvasApiError, describe } from "./api";
import { Canvas, HOME, MAX_ZOOM, MIN_ZOOM, PAN_STEP, TYPE_NAME, byline, type View } from "./Canvas";
import { Failure } from "./Failure";
import { joinRoom, type Room, type RoomOptions } from "./presence";

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
const POLL_MS = 5000;
const DEFAULT_SIZE: Record<string, [number, number]> = { rect: [140, 70], ellipse: [140, 70], diamond: [140, 90], text: [140, 40], sticky: [150, 120] };
const DEFAULT_TEXT: Record<string, string> = { rect: "Rectangle", ellipse: "Ellipse", diamond: "Decision", text: "Text", sticky: "Note" };

export interface BoardViewProps {
  id: string;
  client: CanvasClient;
  /** The live room. Without one, the view shows no one else and reads the board by its timer only. */
  room?: RoomOptions;
  me: { actor: string; kind: string; role: "editor" | "viewer" };
  /** A link for a missing board to go back to. */
  backHref?: string;
}

export function BoardView({ id, client, room: roomOptions, me, backHref }: BoardViewProps) {
  const roomUrl = roomOptions?.baseUrl;
  const roomToken = roomOptions?.token;
  const toast = useToast();
  const [board, setBoard] = useState<State>({ state: "loading" });
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<View>(HOME);
  const [peers, setPeers] = useState<PresenceEntry[]>([]);
  const [live, setLive] = useState(false);
  const room = useRef<Room | undefined>(undefined);
  const rev = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const canvasBox = useRef<HTMLDivElement>(null);
  const editable = me.role === "editor";

  const [saving, setSaving] = useState(0);
  const pending = useRef(0);
  const generation = useRef(0);
  const lastRead = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const read = useCallback(async () => {
    try {
      const started = generation.current;
      const data = await client.readBoard(id);
      // A write that began while this read ran makes the read old: its values would undo the write on screen.
      if (started !== generation.current || pending.current > 0) return;
      setBoard({ state: "ready", data });
    } catch (e) {
      // A failed refresh keeps the board on screen. Only a first load shows the error page.
      setBoard((prev) => (prev.state === "ready" ? prev : { state: "error", message: describe(e), missing: e instanceof CanvasApiError && e.status === 404 }));
    }
  }, [client, id]);
  /**
   * Read the board again, at most once a second, and never while a write is waiting: the screen is ahead of the
   * server then, and an older read would put old values back. The last write reads when the queue is empty.
   */
  const load = useCallback(async () => {
    if (pending.current > 0) return;
    const wait = lastRead.current + 1000 - Date.now();
    if (wait > 0) {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void load(), wait);
      return;
    }
    lastRead.current = Date.now();
    await read();
  }, [read]);
  useEffect(() => {
    setBoard({ state: "loading" });
    lastRead.current = 0;
    void load();
    return () => clearTimeout(timer.current);
  }, [load]);
  useEffect(() => {
    if (saving === 0) return;
    const guard = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [saving]);

  useEffect(() => {
    if (roomUrl === undefined || roomToken === undefined) return;
    const joined = joinRoom({ board: id, baseUrl: roomUrl, token: roomToken, name: me.actor, onPeers: setPeers, onChange: () => void load(), onStatus: setLive });
    room.current = joined;
    return () => (joined.leave(), (room.current = undefined));
  }, [id, roomUrl, roomToken, me.actor, load]);
  // A change made outside this UI (the HTTP API, the CLI, an agent) raises no presence counter, so a slow refresh finds it.
  useEffect(() => {
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  /** Run one write after the one before it, then read the board again and tell the room. */
  const write = useCallback(
    (change: () => Promise<unknown>, failure: string, select?: string) => {
      pending.current++;
      generation.current++;
      setSaving((n) => n + 1);
      queue.current = queue.current.then(async () => {
        try {
          await change();
          room.current?.setRev(++rev.current);
        } catch (e) {
          toast({ title: failure, description: describe(e), tone: "danger" });
        }
        pending.current--;
        // The last write of a run reads the server's board. An earlier one leaves the screen as it is.
        lastRead.current = 0;
        await load();
        if (select) setSelected(select);
        setSaving((n) => n - 1);
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
  const resize = (target: string, w: number, h: number) => place(target, { w, h });
  /** Set the position or the size of a shape. A person who cannot drag uses this from the side panel. */
  const place = (target: string, patch: { x?: number; y?: number; w?: number; h?: number }) => {
    patchLocal((n) => (n.id === target ? { ...n, ...patch } : n));
    write(() => client.update(id, target, patch), "Could not change the item");
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
      <EmptyState title="This board does not exist" description={backHref ? <a href={backHref}>Back to all boards</a> : undefined} />
    ) : (
      <Failure message={board.message} retry={() => (setBoard({ state: "loading" }), void load())} />
    );
  }
  const { data: d } = board;
  const status = saving > 0 ? "Saving…" : "All changes saved";
  const empty = d.nodes.length === 0 && d.edges.length === 0;

  return (
    <section className="board" aria-labelledby="board-h">
      <div className="row">
        <h1 id="board-h">{d.title || d.id}</h1>
        <PresenceStack entries={[{ id: "me", name: me.actor, kind: me.kind === "human" ? "person" : "agent" }, ...peers]} label={live ? "In this board" : "In this board (not live)"} />
      </div>
      <Toolbar label="Board tools">
        {TOOLS.map((t) => (
          <ToolbarButton key={t.type} label={t.text} icon={t.icon} disabled={!editable} onClick={() => add(t.type)} />
        ))}
        <ToolbarSeparator />
        <ToolbarButton label="Zoom out" icon={icon(<path d="M4 10h12" />)} onClick={() => zoom(1 / 1.25)} />
        <ToolbarButton label="Zoom in" icon={icon(<path d="M4 10h12M10 4v12" />)} onClick={() => zoom(1.25)} />
        <ToolbarButton label="Pan left" icon={icon(<path d="M12 4l-6 6 6 6" />)} onClick={() => setView((v) => ({ ...v, x: v.x + PAN_STEP }))} />
        <ToolbarButton label="Pan right" icon={icon(<path d="M8 4l6 6-6 6" />)} onClick={() => setView((v) => ({ ...v, x: v.x - PAN_STEP }))} />
        <ToolbarButton label="Pan up" icon={icon(<path d="M4 12l6-6 6 6" />)} onClick={() => setView((v) => ({ ...v, y: v.y + PAN_STEP }))} />
        <ToolbarButton label="Pan down" icon={icon(<path d="M4 8l6 6 6-6" />)} onClick={() => setView((v) => ({ ...v, y: v.y - PAN_STEP }))} />
        <ToolbarButton label="Reset view" icon={icon(<path d="M4 4h5M4 4v5M16 16h-5M16 16v-5" />)} onClick={() => setView(HOME)} />
      </Toolbar>
      <p className="note" role="status">{editable ? status : ""}</p>
      {!editable && <p className="note">This token can read the board but not change it.</p>}
      <div className="stage" ref={canvasBox}>
        <Canvas data={d} selected={selected} editable={editable} view={view} onView={setView} onSelect={setSelected} onMove={move} onResize={resize} onDelete={remove} />
        {empty && (
          <div className="empty-overlay">
            <EmptyState title="This board is empty" description={editable ? "Add a shape or a note with the tools above." : "Nothing has been drawn yet."} />
          </div>
        )}
        <Inspector key={item?.id ?? "none"} item={item} nodes={d.nodes} editable={editable} onText={(text) => item && write(() => client.update(id, item.id, { text }), "Could not save the text")} onPlace={place} onDelete={remove} onConnect={(to) => item && write(() => client.addConnector(id, { from: { id: item.id }, to: { id: to } }), "Could not connect")} />
      </div>
    </section>
  );
}

const asEntry = (p: { kind: string; id: string }): PresenceEntry => ({ id: p.id, name: p.id, kind: p.kind === "human" ? "person" : "agent" });

type Field = "text" | "x" | "y" | "w" | "h";

/**
 * A field shows what the person typed, or else the item's current value. A field the person did not touch follows
 * the board, so a save never writes an old value over a newer one, such as an agent's edit of the text.
 */
function Inspector({ item, nodes, editable, onText, onPlace, onDelete, onConnect }: { item?: Item; nodes: NodeData[]; editable: boolean; onText: (text: string) => void; onPlace: (id: string, patch: { x?: number; y?: number; w?: number; h?: number }) => void; onDelete: (id: string) => void; onConnect: (to: string) => void }) {
  const [draft, setDraft] = useState<Partial<Record<Field, string>>>({});
  const node = item && item.type !== "connector" ? (item as NodeData) : undefined;
  if (!item) return <aside className="inspector" aria-label="Selected item"><p>Select an item to edit it.</p></aside>;
  const value = (k: Field): string => draft[k] ?? String(k === "text" ? item.text : node?.[k] ?? "");
  const edit = (k: Field) => (e: { target: { value: string } }) => setDraft({ ...draft, [k]: e.target.value });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (draft.text !== undefined && draft.text !== item.text) onText(draft.text);
    if (node) {
      const patch: { x?: number; y?: number; w?: number; h?: number } = {};
      for (const k of ["x", "y", "w", "h"] as const) {
        const typed = draft[k];
        if (typed === undefined || typed.trim() === "") continue;
        const n = Number(typed);
        if (Number.isFinite(n) && (k === "x" || k === "y" || n > 0) && n !== node[k]) patch[k] = n;
      }
      if (Object.keys(patch).length > 0) onPlace(node.id, patch);
    }
    setDraft({});
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
        <Textarea label="Text" value={value("text")} onChange={edit("text")} rows={3} maxLength={10000} disabled={!editable} />
        {node && (
          <div className="sizes">
            <Input label="X" type="number" value={value("x")} onChange={edit("x")} disabled={!editable} />
            <Input label="Y" type="number" value={value("y")} onChange={edit("y")} disabled={!editable} />
            <Input label="Width" type="number" min={20} value={value("w")} onChange={edit("w")} disabled={!editable} />
            <Input label="Height" type="number" min={20} value={value("h")} onChange={edit("h")} disabled={!editable} />
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
