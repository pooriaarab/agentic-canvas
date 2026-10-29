// Failure cases for the room and Store sync, written against a fake room (the Worker path is in live-room.e2e.test.ts):
//  1. The room's export arrives in chunks that split a line, and the state is lost.
//  2. A room that has not changed is saved again, or a room that fails its checks is retried on every request.
//  3. The room refuses the seed with an auth message and the seed counts as done, or the room never answers.
//  4. A stored board over one message is sent to the room.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Realtime } from "agentic-realtime";
import { afterAll, describe, expect, test } from "vitest";
import * as Y from "yjs";
import { Board } from "./core/board.js";
import { handSave, pull, seed, SEEDER, writers } from "./room-sync.js";
import { CanvasService } from "./service.js";
import { openLocalStore } from "./store-file.js";

const root = mkdtempSync(join(tmpdir(), "agentic-canvas-room-sync-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const ada = { kind: "human", id: "ada" } as const;
let n = 0;

class FakeSocket {
  listeners: Record<string, ((event: { data?: ArrayBuffer }) => void)[]> = {};
  sent: Uint8Array[] = [];
  constructor(private readonly reply: (message: Uint8Array) => Uint8Array | null, private readonly onUpdate: (update: Uint8Array) => void = () => undefined) {}
  accept() {}
  close() {}
  addEventListener(type: string, listener: (event: { data?: ArrayBuffer }) => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  send(message: Uint8Array) {
    this.sent.push(message);
    // The first message is an update: two type bytes, the length as a varint, then the update. The room applies it.
    if (this.sent.length === 1 && message[0] === 0 && message[1] === 2) {
      let at = 2;
      while (message[at]! > 127) at++;
      this.onUpdate(message.slice(at + 1));
    }
    // The room answers the query (the second message) after it handled the first.
    const answer = this.sent.length === 2 ? this.reply(message) : null;
    if (answer) queueMicrotask(() => this.listeners.message?.forEach((l) => l({ data: answer.buffer as ArrayBuffer })));
  }
}

/** A room that holds `doc`, exports it in chunks of 7 bytes, and counts its calls. */
function fakeRoom(doc: Y.Doc, reply: (message: Uint8Array) => Uint8Array | null = () => new Uint8Array([0, 1, 0])) {
  const grants: unknown[] = [];
  const started = [...doc.store.clients.keys()].map((client) => [client, Y.getState(doc.store, client)] as const);
  const taken: { principal: { id: string; kind: string }; ranges: { client: number; clock: number; length: number }[] }[] = [];
  const calls = { exports: 0, updates: 1 };
  const sockets: FakeSocket[] = [];
  const live = {
    meta: async () => ({ updates: calls.updates, compactions: 0, contributors: [{ ...ada, machine: false }, ...taken.map((t) => ({ ...t.principal, machine: true }))] }),
    // Ada sent every item the room started with. The room's log then names the principal of each update it takes.
    attribution: async () => ({ authors: [{ ...ada, machine: false }, ...taken.map((t) => ({ ...t.principal, machine: true }))], ranges: [...started.map(([client, length]) => ({ client, clock: 0, length, author: 0, at: 0 })), ...taken.flatMap((t, i) => t.ranges.map((r) => ({ ...r, author: i + 1, at: 0 })))], dropped: 0, lost: false }),
    exportHistory: async () => {
      calls.exports++;
      const text = new TextEncoder().encode(`${JSON.stringify({ type: "meta" })}\n${JSON.stringify({ type: "state", base64: btoa(String.fromCharCode(...Y.encodeStateAsUpdate(doc))) })}\n`);
      let at = 0;
      return new ReadableStream<Uint8Array>({ pull: (c) => (at >= text.length ? c.close() : c.enqueue(text.slice(at, (at += 7)))) });
    },
    connect: async (_id: string, _request: Request, grant: unknown) => {
      grants.push(grant);
      const webSocket = new FakeSocket(reply, (update) => {
        // The room logs the structs that are new to it, under the principal of the socket.
        const before = Y.encodeStateVector(doc);
        Y.applyUpdate(doc, update);
        calls.updates++;
        const fresh = Y.decodeUpdate(Y.diffUpdate(Y.encodeStateAsUpdate(doc), before)).structs;
        taken.push({ principal: (grant as { principal: { id: string; kind: string } }).principal, ranges: fresh.map((st) => ({ client: st.id.client, clock: st.id.clock, length: st.length })) });
      });
      sockets.push(webSocket);
      return { webSocket } as unknown as Response;
    },
  } as unknown as Realtime;
  return { live, calls, sockets, grants };
}

const open = async () => {
  const service = new CanvasService(openLocalStore(join(root, `s${n++}`)));
  await service.create(ada, { id: "b" });
  return service;
};

describe("pull", () => {
  test("reads a state split across chunks, and skips a room that has not changed", async () => {
    const service = await open();
    const room = Board.decode(await service.state("b"));
    room.addShape({ id: "s1", type: "rect", x: 0, y: 0 }, ada);
    const { live, calls } = fakeRoom(room.doc);
    await pull(live, service, "b");
    expect((await service.read("b")).nodes.map((e) => e.id)).toEqual(["s1"]);
    await pull(live, service, "b");
    expect(calls.exports).toBe(1);
    calls.updates++;
    await pull(live, service, "b");
    expect(calls.exports).toBe(2);
  });

  test("does not retry a room that failed its checks until the room changes", async () => {
    const service = await open();
    const room = Board.decode(await service.state("b"));
    room.doc.getMap("junk").set("a", 1);
    const { live, calls } = fakeRoom(room.doc);
    await expect(pull(live, service, "b")).rejects.toMatchObject({ code: "INVALID" });
    await pull(live, service, "b");
    expect(calls.exports).toBe(1);
    calls.updates++;
    await expect(pull(live, service, "b")).rejects.toMatchObject({ code: "INVALID" });
    expect(calls.exports).toBe(2);
  });
});

describe("seed", () => {
  test("sends the missing part, and asks with the room's own state vector", async () => {
    const service = await open();
    await service.add("b", { id: "s1", type: "rect", x: 0, y: 0 }, ada);
    const { live, sockets } = fakeRoom(new Y.Doc());
    await seed(live, service, "b");
    expect(sockets).toHaveLength(1);
    expect([...sockets[0]!.sent[0]!.slice(0, 2)]).toEqual([0, 2]);
    expect([...sockets[0]!.sent[1]!]).toEqual([0, 0, 1, 0]);
  });

  test("sends nothing to a room that has the whole board", async () => {
    const service = await open();
    await service.add("b", { id: "s1", type: "rect", x: 0, y: 0 }, ada);
    const { live, sockets } = fakeRoom(Board.decode(await service.state("b")).doc);
    await seed(live, service, "b");
    expect(sockets).toHaveLength(0);
  });

  test("a refusal from the room fails the seed", async () => {
    const service = await open();
    await service.add("b", { id: "s1", type: "rect", x: 0, y: 0 }, ada);
    const { live } = fakeRoom(new Y.Doc(), () => new Uint8Array([2, 0, 1, 120]));
    await expect(seed(live, service, "b")).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  test("a stored board over one message fails with LIMIT and sends nothing", async () => {
    const service = await open();
    // Random text does not compress, so 110 elements of 10,000 characters pass one message.
    const big = Board.decode(await service.state("b"));
    const random = () => Array.from(crypto.getRandomValues(new Uint8Array(5000)), (v) => v.toString(16).padStart(2, "0")).join("");
    for (let i = 0; i < 110; i++) big.addShape({ id: `s${i}`, type: "sticky", x: 0, y: 0, text: random() }, ada);
    await service.checkpoint("b", big.encode(), ada);
    const { live, sockets } = fakeRoom(new Y.Doc());
    await expect(seed(live, service, "b")).rejects.toMatchObject({ code: "LIMIT" });
    expect(sockets).toHaveLength(0);
  });
});

describe("writers", () => {
  test("no log is no answer, so a save does not guess", async () => {
    const live = { attribution: async () => null } as unknown as Realtime;
    await expect(writers(live, "b")).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  test("names the principal of the range that holds an item, and no one for the seeder or a gap", async () => {
    const authors = [{ ...ada, machine: false }, { ...SEEDER, machine: true }];
    const ranges = [{ client: 1, clock: 5, length: 5, author: 1, at: 0 }, { client: 1, clock: 20, length: 5, author: 0, at: 0 }, { client: 1, clock: 0, length: 5, author: 0, at: 0 }];
    const live = { attribution: async () => ({ authors, ranges, dropped: 0, lost: false }) } as unknown as Realtime;
    const who = await writers(live, "b");
    expect(who({ client: 1, clock: 4 })).toEqual(ada);
    expect(who({ client: 1, clock: 0 })).toEqual(ada);
    expect(who({ client: 1, clock: 5 })).toBeUndefined();
    expect(who({ client: 1, clock: 10 })).toBeUndefined();
    expect(who({ client: 2, clock: 0 })).toBeUndefined();
    expect(who({ client: 1, clock: 22 })).toEqual(ada);
    expect(who({ client: 1, clock: 25 })).toBeUndefined();
  });

  test("a range that starts far back still names its writer, and a log marked lost or with drops still answers", async () => {
    const bot = { kind: "agent_of_human", id: "helper", machine: true } as const;
    const ranges = [{ client: 1, clock: 0, length: 100, author: 0, at: 1 }, { client: 1, clock: 5, length: 5, author: 1, at: 9 }];
    const live = { attribution: async () => ({ authors: [{ ...ada, machine: false }, bot], ranges, dropped: 3, lost: true }) } as unknown as Realtime;
    const who = await writers(live, "b");
    expect(who({ client: 1, clock: 50 })).toEqual(ada);
    expect(who({ client: 1, clock: 100 })).toBeUndefined();
  });
});

// Failure cases for a save by hand: the poster reuses the Yjs ids of a person's unsaved edit in the room to put its own content
// under that person's name, posts under a client id that the room holds for someone else, the room cannot be saved but the hand
// save goes on, or content the room never had keeps a person's stamp.
describe("handSave", () => {
  const poster = { kind: "agent_of_human", id: "helper" } as const;

  test("reused ids are dropped, and content the room never had goes into the room as the poster", async () => {
    const service = await open();
    const base = Y.encodeStateAsUpdate(Board.decode(await service.state("b")).doc);
    const room = Board.decode(base);
    room.addShape({ id: "s4", type: "rect", x: 0, y: 0, text: "ada text" }, ada);
    const { live, sockets, grants } = fakeRoom(room.doc, undefined);
    // The poster's twin of Ada's edit: the same client id and clocks, other content, and a stamp that names Ada.
    const twin = Board.decode(base);
    twin.doc.clientID = room.doc.clientID;
    twin.addShape({ id: "s4", type: "rect", x: 0, y: 0, text: "bot text" }, ada);
    twin.doc.clientID = 424242;
    twin.addShape({ id: "ghost", type: "rect", x: 1, y: 1 }, ada);
    // The room's log names the poster for what it takes from the poster: here, every client it does not know as Ada's.
    const result = await handSave(live, service, "b", twin.encode(), poster);
    expect(grants).toEqual([{ principal: poster, role: "editor", name: "helper" }]);
    expect(sockets).toHaveLength(1);
    expect(result.fixed).toEqual(["ghost"]);
    const nodes = (await service.read("b")).nodes;
    expect(nodes.find((n) => n.id === "s4")).toMatchObject({ text: "ada text", author: ada });
    expect(nodes.find((n) => n.id === "ghost")).toMatchObject({ author: poster, editedBy: poster, machineMade: true });
  });

  test("a refusal by the room fails the hand save with FORBIDDEN, and the store keeps its board", async () => {
    const service = await open();
    const room = Board.decode(await service.state("b"));
    const { live } = fakeRoom(room.doc, () => new Uint8Array([2, 0, 1, 120]));
    const fresh = new Board();
    fresh.addShape({ id: "h1", type: "rect", x: 0, y: 0 }, ada);
    await expect(handSave(live, service, "b", fresh.encode(), poster)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await service.read("b")).nodes).toEqual([]);
  });

  test("a room that cannot be saved fails the hand save", async () => {
    const service = await open();
    const room = Board.decode(await service.state("b"));
    room.doc.getMap("junk").set("a", 1);
    const { live } = fakeRoom(room.doc);
    await expect(handSave(live, service, "b", new Board().encode(), poster)).rejects.toMatchObject({ code: "INVALID" });
  });

  test("an update that holds nothing new sends nothing", async () => {
    const service = await open();
    const room = Board.decode(await service.state("b"));
    const { live, sockets } = fakeRoom(room.doc);
    await handSave(live, service, "b", Y.encodeStateAsUpdate(room.doc), poster);
    expect(sockets).toHaveLength(0);
  });
});
