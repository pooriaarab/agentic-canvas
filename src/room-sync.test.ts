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
import { pull, seed, SEEDER, writers } from "./room-sync.js";
import { CanvasService } from "./service.js";
import { openLocalStore } from "./store-file.js";

const root = mkdtempSync(join(tmpdir(), "agentic-canvas-room-sync-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const ada = { kind: "human", id: "ada" } as const;
let n = 0;

class FakeSocket {
  listeners: Record<string, ((event: { data?: ArrayBuffer }) => void)[]> = {};
  sent: Uint8Array[] = [];
  constructor(private readonly reply: (message: Uint8Array) => Uint8Array | null) {}
  accept() {}
  close() {}
  addEventListener(type: string, listener: (event: { data?: ArrayBuffer }) => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  send(message: Uint8Array) {
    this.sent.push(message);
    // The room answers the query (the second message) after it handled the first.
    const answer = this.sent.length === 2 ? this.reply(message) : null;
    if (answer) queueMicrotask(() => this.listeners.message?.forEach((l) => l({ data: answer.buffer as ArrayBuffer })));
  }
}

/** A room that holds `doc`, exports it in chunks of 7 bytes, and counts its calls. */
function fakeRoom(doc: Y.Doc, reply: (message: Uint8Array) => Uint8Array | null = () => new Uint8Array([0, 1, 0])) {
  const calls = { exports: 0, updates: 1 };
  const sockets: FakeSocket[] = [];
  const live = {
    meta: async () => ({ updates: calls.updates, compactions: 0, contributors: [{ ...ada, machine: false }] }),
    // Ada sent every item in the room.
    attribution: async () => ({ authors: [{ ...ada, machine: false }], ranges: [...doc.store.clients.keys()].map((client) => ({ client, clock: 0, length: 1e9, author: 0, at: 0 })), dropped: 0, lost: false }),
    exportHistory: async () => {
      calls.exports++;
      const text = new TextEncoder().encode(`${JSON.stringify({ type: "meta" })}\n${JSON.stringify({ type: "state", base64: btoa(String.fromCharCode(...Y.encodeStateAsUpdate(doc))) })}\n`);
      let at = 0;
      return new ReadableStream<Uint8Array>({ pull: (c) => (at >= text.length ? c.close() : c.enqueue(text.slice(at, (at += 7)))) });
    },
    connect: async () => {
      const webSocket = new FakeSocket(reply);
      sockets.push(webSocket);
      return { webSocket } as unknown as Response;
    },
  } as unknown as Realtime;
  return { live, calls, sockets };
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
});
