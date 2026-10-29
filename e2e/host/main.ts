// A host app that keeps the board in its own Yjs documents, and gives them to `agentic-canvas/ui` as `host`.
// Two documents stand for two apps: the page passes each update from one to the other, as a room would.
import { mount } from "../../ui/embed.js";
import * as Y from "yjs";
import { Board } from "../../src/core/board.js";

const params = new URLSearchParams(location.hash.slice(1));
const principal = { kind: (params.get("kind") ?? "human") as "human", name: params.get("name") ?? "Ada", id: params.get("id") ?? "ada", role: "editor" as const };
const doc = new Y.Doc();
const peerDoc = new Y.Doc();
doc.on("update", (update: Uint8Array, origin: unknown) => origin !== "peer" && Y.applyUpdate(peerDoc, update, "peer"));
peerDoc.on("update", (update: Uint8Array, origin: unknown) => origin !== "peer" && Y.applyUpdate(doc, update, "peer"));

const requests: string[] = [];
const watch = new PerformanceObserver((list) => list.getEntries().forEach((e) => requests.push(e.name)));
watch.observe({ type: "resource", buffered: true });

const board = mount(document.getElementById("board")!, { boardId: "mine", principal, host: { doc } });
Object.assign(window, {
  unmountBoard: () => board.unmount(),
  // What the host's own storage holds: the elements of the document and the one of its second copy.
  hostElements: () => [...(peerDoc.getMap("elements") as Y.Map<Y.Map<unknown>>).values()].map((m) => m.toJSON()),
  // A peer app writes into its copy.
  peerAdd: (id: string, text: string) => void new Board(peerDoc).addShape({ id, type: "rect", x: 300, y: 40, text }, { kind: "human", id: "bea" }),
  // Every resource the page loaded, except the two files the host page serves itself.
  requests: () => requests.filter((r) => !/\/(app\.js|app\.css)$/.test(r)),
});
