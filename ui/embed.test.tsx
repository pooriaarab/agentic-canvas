// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanvasClient } from "../src/client.js";
import type { BoardData } from "../src/core/read.js";
import { describe as words } from "./errors.js";
import { roomUrl } from "./presence.js";
import { mount, type BoardEditorOptions, type MountedBoard } from "./embed.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ada = { kind: "human" as const, name: "Ada", role: "editor" as const };
const stamp = { z: 1, author: { kind: "human" as const, id: "ada" }, editedBy: { kind: "human" as const, id: "ada" }, machineMade: false, lastEditMachineMade: false };
const data: BoardData & { id: string } = {
  id: "b1",
  title: "Plan",
  nodes: [{ ...stamp, id: "s1", type: "rect", x: 10, y: 10, w: 100, h: 60, text: "Start" } as never],
  edges: [],
  groups: [],
  texts: ["Start"],
};

function fakeClient(read: () => Promise<typeof data> = async () => data) {
  const readBoard = vi.fn(read);
  const addShape = vi.fn(async () => ({}) as never);
  return { client: { readBoard, addShape } as unknown as CanvasClient, readBoard, addShape };
}

let mounted: MountedBoard | undefined;
let host: HTMLElement;
const open = async (options: BoardEditorOptions) => {
  host = document.body.appendChild(document.createElement("div"));
  await act(async () => void (mounted = mount(host, options)));
  await act(async () => undefined);
};
afterEach(async () => {
  await act(async () => mounted?.unmount());
  mounted = undefined;
  host?.remove();
});

const button = (name: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);

describe("mount", () => {
  it("draws the board it reads from the client", async () => {
    const { client, readBoard } = fakeClient();
    await open({ boardId: "b1", client, principal: ada });
    expect(readBoard).toHaveBeenCalledWith("b1");
    expect(host.querySelector("h1")?.textContent).toBe("Plan");
    expect(host.textContent).toContain("Start");
    expect(button("Add rectangle")?.disabled).toBe(false);
  });

  it("adds a shape through the client when an editor clicks a tool", async () => {
    const { client, addShape } = fakeClient();
    await open({ boardId: "b1", client, principal: ada });
    await act(async () => button("Add rectangle")?.click());
    expect(addShape).toHaveBeenCalledTimes(1);
    expect(addShape).toHaveBeenCalledWith("b1", expect.objectContaining({ type: "rect" }));
  });

  it("opens read only for readOnly, for a viewer, and for a missing role", async () => {
    for (const options of [{ principal: ada, readOnly: true }, { principal: { ...ada, role: "viewer" as const } }, { principal: { kind: "human" as const, name: "Ada" } }]) {
      const { client } = fakeClient();
      await open({ boardId: "b1", client, ...options });
      expect(button("Add rectangle")?.disabled).toBe(true);
      expect(host.textContent).toContain("can read the board but not change it");
      await act(async () => mounted?.unmount());
      host.remove();
    }
  });

  it("shows a failed first read with a retry, and reads again on retry", async () => {
    const read = vi.fn<() => Promise<typeof data>>().mockRejectedValueOnce(new Error("down")).mockResolvedValue(data);
    const { client } = fakeClient(read);
    await open({ boardId: "b1", client, principal: ada });
    expect(host.querySelector("[role=alert]")?.textContent).toContain("down");
    await act(async () => void host.querySelector<HTMLButtonElement>("[role=alert] button")?.click());
    // The retry waits out the one-second limit between reads.
    await vi.waitFor(() => expect(host.querySelector("h1")?.textContent).toBe("Plan"), { timeout: 3000 });
  });

  it("rejects a principal with no kind or no name, and leaves the host empty", () => {
    const { client } = fakeClient();
    const el = document.createElement("div");
    expect(() => mount(el, { boardId: "b1", client, principal: { name: "Ada" } as never })).toThrow(TypeError);
    expect(() => mount(el, { boardId: "b1", client, principal: { kind: "robot", name: "Ada" } as never })).toThrow(TypeError);
    expect(() => mount(el, { boardId: "b1", client, principal: { kind: "human", name: " " } })).toThrow(TypeError);
    expect(el.innerHTML).toBe("");
  });

  it("update shows another board and keeps the board on a bad principal", async () => {
    const { client, readBoard } = fakeClient();
    await open({ boardId: "b1", client, principal: ada });
    expect(() => mounted?.update({ boardId: "b2", client, principal: { name: "x" } as never })).toThrow(TypeError);
    expect(host.querySelector("h1")?.textContent).toBe("Plan");
    await act(async () => mounted?.update({ boardId: "b2", client, principal: ada }));
    await vi.waitFor(() => expect(readBoard).toHaveBeenCalledWith("b2"), { timeout: 3000 });
  });

  it("unmount empties the host, stops the refresh timer, and is safe to call twice", async () => {
    vi.useFakeTimers();
    try {
      const { client, readBoard } = fakeClient();
      await open({ boardId: "b1", client, principal: ada });
      const calls = readBoard.mock.calls.length;
      await act(async () => mounted?.unmount());
      expect(host.innerHTML).toBe("");
      await act(async () => void vi.advanceTimersByTime(30_000));
      expect(readBoard.mock.calls.length).toBe(calls);
      expect(() => mounted?.unmount()).not.toThrow();
      expect(() => mounted?.update({ boardId: "b1", client, principal: ada })).not.toThrow();
      expect(host.innerHTML).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows an alert, not a blank page, for a board that gets a bad principal after mount", async () => {
    const { client } = fakeClient();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { BoardEditor } = await import("./embed.js");
    const { createRoot } = await import("react-dom/client");
    host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    await act(async () => root.render(<BoardEditor boardId="b1" client={client} principal={{ kind: "future" as never, name: "Ada" }} />));
    expect(host.querySelector("[role=alert]")?.textContent).toContain("The board stopped");
    await act(async () => root.unmount());
    quiet.mockRestore();
  });
});

describe("helpers", () => {
  it("builds the room address from a base with or without a trailing slash", () => {
    expect(roomUrl("https://c.example/api/v1/canvas/", "a b")).toBe("wss://c.example/api/v1/canvas/boards/a%20b/ws");
    expect(roomUrl("http://c.example/api", "b1")).toBe("ws://c.example/api/boards/b1/ws");
  });

  it("reads an error from any copy of the client class by its name and code", () => {
    class CanvasApiError extends Error {
      name = "CanvasApiError";
      constructor(readonly code: string, message: string, readonly status: number) {
        super(message);
      }
    }
    expect(words(new CanvasApiError("UNAUTHORIZED", "x", 401))).toBe("The server did not accept this token.");
    expect(words(new CanvasApiError("NOT_FOUND", "no board", 404))).toBe("no board");
    expect(words(new Error("plain"))).toBe("plain");
    expect(words({ name: "CanvasApiError", code: 1 })).toBe("Something went wrong.");
  });
});
