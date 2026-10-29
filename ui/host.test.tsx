// @vitest-environment jsdom
import { act } from "react";
import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Board } from "../src/core/board.js";
import { readBoard } from "../src/core/read.js";
import { mount, type BoardEditorOptions, type MountedBoard } from "./embed.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Ways the host mode can fail, listed before the tests:
// - the UI calls a client, polls, or opens a room when it has a host document
// - an edit in the UI does not reach the document, or carries the wrong author
// - a change another app makes in the document does not show
// - unmount leaves an observer on the app's document, or drops the document
// - a host with a client, a room, a bad document, or a principal that cannot stamp is accepted
// - an unrelated change in the app's document draws the board again

const ada = { kind: "human" as const, name: "Ada", id: "ada", role: "editor" as const };
const bot = { kind: "agent_of_human" as const, name: "Helper", id: "helper", role: "editor" as const };
let mounted: MountedBoard | undefined;
let el: HTMLElement;
const open = async (options: BoardEditorOptions) => {
  el = document.body.appendChild(document.createElement("div"));
  await act(async () => void (mounted = mount(el, options)));
  await act(async () => undefined);
};
afterEach(async () => {
  await act(async () => mounted?.unmount());
  mounted = undefined;
  el?.remove();
  vi.restoreAllMocks();
});
const button = (name: string) => el.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
const seeded = () => {
  const doc = new Y.Doc();
  const board = new Board(doc);
  board.setTitle("Plan", { kind: "human", id: "ada" });
  board.addShape({ id: "s1", type: "rect", x: 10, y: 10, text: "Start" }, { kind: "human", id: "ada" });
  return { doc, board };
};

describe("host document mode", () => {
  it("draws the document and writes an edit into it with the principal's stamp, with no fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { doc } = seeded();
    await open({ boardId: "b1", principal: bot, host: { doc } });
    expect(el.querySelector("h1")?.textContent).toBe("Plan");
    expect(el.textContent).toContain("Start");
    await act(async () => button("Add sticky note")?.click());
    const added = readBoard(new Board(doc)).nodes.find((n) => n.type === "sticky")!;
    expect(added.author).toEqual({ kind: "agent_of_human", id: "helper" });
    expect(added.machineMade).toBe(true);
    expect(el.textContent).toContain("Note");
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("shows a change another app makes in the document at once, and does not poll or open a socket", async () => {
    vi.useFakeTimers();
    const socket = vi.fn();
    vi.stubGlobal("WebSocket", socket);
    try {
      const { doc, board } = seeded();
      await open({ boardId: "b1", principal: ada, host: { doc } });
      await act(async () => void board.addShape({ id: "s2", type: "ellipse", x: 200, y: 20, text: "Remote" }, { kind: "human", id: "bea" }));
      expect(el.textContent).toContain("Remote");
      const reads = vi.spyOn(Board.prototype, "list");
      await act(async () => void vi.advanceTimersByTime(30_000));
      expect(reads).not.toHaveBeenCalled();
      expect(socket).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("does not draw again for data the app keeps in the same document", async () => {
    const { doc } = seeded();
    await open({ boardId: "b1", principal: ada, host: { doc } });
    const reads = vi.spyOn(Board.prototype, "list");
    await act(async () => void doc.getMap("chat").set("m1", "hello"));
    expect(reads).not.toHaveBeenCalled();
  });

  it("shows the peers of the host's presence and its connection state", async () => {
    const { doc } = seeded();
    let listener: (list: never[]) => void = () => undefined;
    const presence = { peers: [] as never[], onPeers: (fn: typeof listener) => ((listener = fn), () => undefined) };
    await open({ boardId: "b1", principal: ada, host: { doc, presence: presence as never, status: () => "disconnected" } });
    expect(el.querySelector("[aria-label*='not live']")).not.toBeNull();
    await act(async () => listener([{ clientId: 7, name: "Bea", machine: false }] as never[]));
    expect(el.textContent).toContain("2 people");
  });

  it("follows the list the presence passes, and keeps the board when the principal changes", async () => {
    const { doc } = seeded();
    let listener: (list: never[]) => void = () => undefined;
    const presence = { peers: [] as never[], onPeers: (fn: typeof listener) => ((listener = fn), () => undefined) };
    await open({ boardId: "b1", principal: ada, host: { doc, presence: presence as never } });
    await act(async () => listener([{ clientId: 7, name: "Bea", machine: false }] as never[]));
    expect(el.textContent).toContain("2 people");
    await act(async () => mounted?.update({ boardId: "b1", principal: bot, host: { doc, presence: presence as never } }));
    expect(el.textContent).not.toContain("Loading board");
    await act(async () => button("Add text")?.click());
    expect(readBoard(new Board(doc)).nodes.find((n) => n.type === "text")?.author).toEqual({ kind: "agent_of_human", id: "helper" });
  });

  it("follows onStatus when there is no status function", async () => {
    const { doc } = seeded();
    let report: (status: string) => void = () => undefined;
    const onStatus = (fn: typeof report) => ((report = fn), () => undefined);
    await open({ boardId: "b1", principal: ada, host: { doc, onStatus: onStatus as never } });
    expect(el.querySelector("[aria-label*='not live']")).not.toBeNull();
    await act(async () => report("connected"));
    expect(el.querySelector("[aria-label='In this board']")).not.toBeNull();
    await act(async () => report("disconnected"));
    expect(el.querySelector("[aria-label*='not live']")).not.toBeNull();
  });

  it("keeps the live state when update gives a new onStatus function", async () => {
    const { doc } = seeded();
    let report: (status: string) => void = () => undefined;
    const make = () => (fn: typeof report) => ((report = fn), () => undefined);
    await open({ boardId: "b1", principal: ada, host: { doc, onStatus: make() as never } });
    await act(async () => report("connected"));
    await act(async () => mounted?.update({ boardId: "b1", principal: ada, host: { doc, onStatus: make() as never } }));
    expect(el.querySelector("[aria-label='In this board']")).not.toBeNull();
  });

  it("opens read only for a viewer and refuses nothing in the document", async () => {
    const { doc } = seeded();
    await open({ boardId: "b1", principal: { ...ada, role: "viewer" }, host: { doc } });
    expect(button("Add rectangle")?.disabled).toBe(true);
    expect(el.textContent).toContain("This board is read only.");
    expect(el.textContent).not.toContain("token");
  });

  it("leaves no observer on the document after unmount, and keeps the document", async () => {
    const { doc } = seeded();
    const handlers = () => {
      const elements = doc.getMap("elements") as unknown as { _dEH: { l: unknown[] } };
      const meta = doc.getMap("meta") as unknown as { _eH: { l: unknown[] } };
      return [elements._dEH.l.length, meta._eH.l.length];
    };
    const before = handlers();
    await open({ boardId: "b1", principal: ada, host: { doc } });
    expect(handlers()).toEqual([before[0] + 1, before[1] + 1]);
    await act(async () => mounted?.unmount());
    expect(handlers()).toEqual(before);
    expect(readBoard(new Board(doc)).nodes).toHaveLength(1);
  });

  it("does not keep the live state of a host after the app swaps to a client", async () => {
    const { doc } = seeded();
    const client = { readBoard: vi.fn(async () => ({ id: "b1", title: "Plan", nodes: [], edges: [], groups: [], texts: [] })) } as never;
    await open({ boardId: "b1", principal: ada, host: { doc } });
    expect(el.querySelector("[aria-label='In this board']")).not.toBeNull();
    await act(async () => mounted?.update({ boardId: "b1", principal: ada, client }));
    await vi.waitFor(() => expect(el.querySelector("[aria-label*='not live']")).not.toBeNull(), { timeout: 3000 });
  });

  it("rejects a bad document, a room with a host, and a mount with neither client nor host", () => {
    const e = document.createElement("div");
    const { doc } = seeded();
    expect(() => mount(e, { boardId: "b1", principal: ada, host: { doc: {} as never } })).toThrow(TypeError);
    expect(() => mount(e, { boardId: "b1", principal: ada, host: { doc, presence: {} as never } })).toThrow(TypeError);
    expect(() => mount(e, { boardId: "b1", principal: ada, host: { doc }, room: { baseUrl: "http://x", token: "t" } })).toThrow(TypeError);
    expect(() => mount(e, { boardId: "b1", principal: ada })).toThrow(TypeError);
    expect(() => mount(e, { boardId: "b1", principal: ada, host: { doc }, client: {} as never })).toThrow(TypeError);
    // A display name is no id: the stamp needs one that the identity rule accepts.
    expect(() => mount(e, { boardId: "b1", principal: { kind: "human", name: "Ada Lovelace", role: "editor" }, host: { doc } })).toThrow(TypeError);
    expect(e.innerHTML).toBe("");
  });

  it("accepts a display name that has an explicit id", async () => {
    const { doc } = seeded();
    await open({ boardId: "b1", principal: { kind: "human", name: "Ada Lovelace", id: "ada", role: "editor" }, host: { doc } });
    expect(el.querySelector("h1")?.textContent).toBe("Plan");
  });
});
