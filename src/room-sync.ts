import type { Realtime } from "agentic-realtime";
import * as Y from "yjs";
import { CanvasError } from "./core/board.js";
import type { Principal } from "./core/principal.js";
import type { CanvasService, Writer } from "./service.js";

/**
 * The room is the live copy of a board and the Store is the saved copy. The Worker keeps them together, with no help
 * from a client: it saves the room to the Store (`pull`) and seeds an empty or behind room from the Store (`seed`).
 *
 * Limits: a room that no request reaches stays unsaved in the Store until the next request. It is safe in the
 * room's own storage, so a restart loses nothing. A stored board over one WebSocket message (1 MiB) cannot seed a room, so a client cannot join that board live: the join answers 422.
 */

/** The principal the Worker uses to put the stored board in a room. A save never trusts it as an author. */
export const SEEDER: Principal = { kind: "agent", id: "canvas-room" };
const MAX_SEED_BYTES = 1_000_000;
const SYNC = 0;
const AUTH = 2;
const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;

const same = (a: Principal, b: Principal) => a.kind === b.kind && a.id === b.id;

function varUint(value: number): number[] {
  const out: number[] = [];
  for (; value > 127; value = Math.floor(value / 128)) out.push(128 | (value % 128));
  return [...out, value];
}

/** The whole state of a room as one Yjs update, read from its export. Null when the room holds nothing. */
async function roomState(live: Realtime, id: string): Promise<Uint8Array | null> {
  const meta = await live.meta(id);
  if (meta.updates === 0 && meta.compactions === 0) return null;
  const reader = (await live.exportHistory(id)).getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) text += decoder.decode(value, { stream: true });
      // A record is one line. The first is `meta`, and the next is the `state` this needs.
      for (let end = text.indexOf("\n"); end >= 0; end = text.indexOf("\n")) {
        let record: { type?: string; base64?: string };
        try {
          record = JSON.parse(text.slice(0, end));
        } catch {
          throw new CanvasError("UNAVAILABLE", "the room sent an export this server cannot read");
        }
        text = text.slice(end + 1);
        if (record.type === "state" && typeof record.base64 === "string") return Uint8Array.from(atob(record.base64), (c) => c.charCodeAt(0));
      }
      if (done) throw new CanvasError("UNAVAILABLE", "the room sent no state");
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Put an update in a room as `who`, and wait until the room has handled it. The room's own checks apply to `who`. A refusal fails with `refusal`. */
async function send(live: Realtime, id: string, update: Uint8Array, roomVector: Uint8Array, who: { principal: Principal; refusal: "UNAVAILABLE" | "FORBIDDEN" }): Promise<void> {
  if (update.length > MAX_SEED_BYTES) throw new CanvasError("LIMIT", "the update is too big to put in a room");
  const upgrade = new Request("https://room.internal/ws", { headers: { upgrade: "websocket" } });
  const response = await live.connect(id, upgrade, { principal: who.principal, role: "editor", name: who.principal.id });
  const socket = (response as Response & { webSocket?: WebSocket & { accept(): void } }).webSocket;
  if (!socket) throw new CanvasError("UNAVAILABLE", "the room did not open");
  socket.accept();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => fail(new CanvasError("UNAVAILABLE", "the room did not answer")), 10_000);
    const fail = (error: CanvasError) => (clearTimeout(timer), reject(error));
    socket.addEventListener("message", ({ data }) => {
      const bytes = new Uint8Array(data as ArrayBuffer);
      // The room answers a state query only after it handled the update before it. Type 2 is auth, and its first body byte 0 means "permission denied".
      if (bytes[0] === AUTH && bytes[1] === 0) fail(new CanvasError(who.refusal, "the room refused the update"));
      else if (bytes[0] === SYNC && bytes[1] === SYNC_STEP2) (clearTimeout(timer), resolve());
    });
    socket.addEventListener("close", () => fail(new CanvasError("UNAVAILABLE", "the room closed before it took the update")));
    socket.send(new Uint8Array([SYNC, SYNC_UPDATE, ...varUint(update.length), ...update]));
    // The query holds the room's own state vector, so the answer is empty and the room has no big reply to send.
    socket.send(new Uint8Array([SYNC, 0, ...varUint(roomVector.length), ...roomVector]));
  }).finally(() => socket.close(1000, "done"));
}

/**
 * Who sent each Yjs item, from the room's log of updates. The principal is the one the token named, so no client picks it.
 * The seeder is no author. An item the log lacks (a range it dropped, or an item the room never had) has no writer.
 */
export async function writers(live: Realtime, id: string): Promise<Writer> {
  const log = await live.attribution(id);
  // No log is no answer. A save that guessed would delete or undo honest work, so it waits for the next request.
  if (!log) throw new CanvasError("UNAVAILABLE", "the room has no log of who sent its updates");
  const ranges = new Map<number, typeof log.ranges>();
  for (const range of log.ranges) ranges.set(range.client, [...(ranges.get(range.client) ?? []), range]);
  // Per client: ranges by start, and the furthest end so far, so a lookup stops once no earlier range can reach the clock.
  const reach = new Map<number, number[]>();
  for (const [client, list] of ranges) {
    list.sort((a, b) => a.clock - b.clock);
    reach.set(client, list.map((r) => r.clock + r.length));
    const ends = reach.get(client)!;
    for (let i = 1; i < ends.length; i++) ends[i] = Math.max(ends[i]!, ends[i - 1]!);
  }
  return ({ client, clock }) => {
    const list = ranges.get(client) ?? [];
    // The last range that starts at or before the clock, found by bisection.
    let low = 0;
    let high = list.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (list[mid]!.clock <= clock) low = mid + 1;
      else high = mid;
    }
    // The room logs only structs that were new to it, so ranges do not overlap. If they ever did, the one that starts last would win:
    // the walk goes back only while an earlier range can still reach the clock.
    let first: (typeof list)[number] | undefined;
    for (let i = low - 1; i >= 0 && reach.get(client)![i]! > clock && !first; i--) {
      const r = list[i]!;
      if (clock < r.clock + r.length) first = r;
    }
    const who = first ? log.authors[first.author] : undefined;
    return who && !same(who, SEEDER) ? { id: who.id, kind: who.kind } : undefined;
  };
}

/**
 * A save by hand. The part of the posted update that the room lacks goes into the room as the poster, so the room's own checks
 * apply: it refuses an update under a client id that it holds for someone else, and its log names the poster as the sender. The
 * part that the room holds is dropped. Then the room is saved as always, and a room that cannot be saved fails the hand save.
 */
export async function handSave(live: Realtime, service: CanvasService, id: string, update: Uint8Array, poster: Principal): Promise<{ elements: number; fixed: string[] }> {
  const state = await roomState(live, id);
  const vector = Y.encodeStateVectorFromUpdate(state ?? Y.encodeStateAsUpdate(new Y.Doc()));
  let missing: Uint8Array;
  try {
    missing = Y.diffUpdate(update, vector);
  } catch {
    throw new CanvasError("INVALID", "the update is not a Yjs update");
  }
  const { structs, ds } = Y.decodeUpdate(missing);
  if (structs.length > 0 || ds.clients.size > 0) await send(live, id, missing, vector, { principal: poster, refusal: "FORBIDDEN" });
  const saved = await pull(live, service, id, true);
  if (saved) return saved;
  const board = await service.read(id);
  return { elements: board.nodes.length + board.edges.length + board.groups.length, fixed: [] };
}

/** The principals the room saw send updates, except the seeder, which is no author. Only these may stamp a save. */
export async function roomAuthors(live: Realtime, id: string): Promise<Principal[]> {
  return (await live.meta(id)).contributors.filter((c) => !same(c, SEEDER)).map(({ id: who, kind }) => ({ id: who, kind }));
}

/** Where the last save of each room stood: its update and compaction counts. A room that has not moved needs no save. */
const saved = new Map<string, string>();

function remember(id: string, mark: string): void {
  if (saved.size > 500) saved.clear();
  saved.set(id, mark);
}

/** Save the room to the Store. The room's own contributors are the only authors it trusts. A room that has not changed since the last save is skipped. Returns the save, or null when none was needed. `force` saves even when the room has not changed since a save that failed. */
export async function pull(live: Realtime, service: CanvasService, id: string, force = false): Promise<{ elements: number; fixed: string[] } | null> {
  const { updates, compactions } = await live.meta(id);
  const mark = `${updates}:${compactions}`;
  // A save by hand forces a real save: a remembered failure is no save.
  if (!force && saved.get(id) === mark) return null;
  const state = await roomState(live, id);
  if (!state) return null;
  let result: { elements: number; fixed: string[] };
  try {
    result = await service.checkpoint(id, state, null, await roomAuthors(live, id), await writers(live, id));
  } catch (error) {
    // A room that fails its checks fails them again until it changes. A busy store is another matter: try that again.
    if (error instanceof CanvasError && error.code !== "UNAVAILABLE") remember(id, mark);
    throw error;
  }
  remember(id, mark);
  return result;
}

/** Give the room what the Store has and it lacks. A room that is not behind gets nothing. It is read as it is, saved or not. Throws when the room cannot take it. */
export async function seed(live: Realtime, service: CanvasService, id: string): Promise<void> {
  const state = await roomState(live, id);
  const missing = await service.missingFrom(id, state ?? undefined);
  if (!missing) return;
  const known = new Y.Doc();
  if (state) Y.applyUpdate(known, state);
  await send(live, id, missing, Y.encodeStateVector(known), { principal: SEEDER, refusal: "UNAVAILABLE" });
}
