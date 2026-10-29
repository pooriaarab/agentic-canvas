// @vitest-environment jsdom
import { act } from "react";
import * as Y from "yjs";
import { afterEach, expect, it, vi } from "vitest";
import type { CanvasClient } from "../src/client.js";
import { mount, type MountedBoard } from "./embed.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A left room closes late and reports "disconnected" and its old peers. That must not reach the host mode that replaced it.
type Joined = { onPeers: (list: never[]) => void; onStatus: (up: boolean) => void };
const rooms: Joined[] = [];
vi.mock("./presence.js", async (original) => ({
  ...(await original<typeof import("./presence.js")>()),
  joinRoom: (options: Joined) => (rooms.push(options), { setRev: () => undefined, leave: () => undefined }),
}));

let mounted: MountedBoard | undefined;
let el: HTMLElement;
afterEach(async () => {
  await act(async () => mounted?.unmount());
  el?.remove();
  rooms.length = 0;
});

it("keeps the host board live, with no old peers, after a swap from a client with a room", async () => {
  const client = { readBoard: async () => ({ id: "b1", title: "Plan", nodes: [], edges: [], groups: [], texts: [] }) } as unknown as CanvasClient;
  el = document.body.appendChild(document.createElement("div"));
  const principal = { kind: "human" as const, name: "Ada", role: "editor" as const };
  await act(async () => void (mounted = mount(el, { boardId: "b1", principal, client, room: { baseUrl: "http://x/api", token: "t" } })));
  await act(async () => rooms[0].onPeers([{ id: "3", name: "Bea", kind: "person" }] as never[]));
  expect(el.textContent).toContain("2 people");
  await act(async () => mounted?.update({ boardId: "b1", principal, host: { doc: new Y.Doc() } }));
  await act(async () => {
    rooms[0].onStatus(false);
    rooms[0].onPeers([{ id: "3", name: "Bea", kind: "person" }] as never[]);
  });
  expect(el.querySelector("[aria-label='In this board']")).not.toBeNull();
  expect(el.textContent).not.toContain("2 people");
});
