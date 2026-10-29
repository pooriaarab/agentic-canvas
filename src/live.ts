import { SyncClient, type Peer } from "agentic-realtime/client";
import * as Y from "yjs";
import { Board, CanvasError, type ErrorCode } from "./core/board.js";
import { drawFlow, type DrawOptions } from "./core/flow.js";
import { principalSchema, type Principal } from "./core/principal.js";
import { readBoard, type BoardData } from "./core/read.js";
import { toSvg } from "./core/svg.js";
import type { BoardAccess } from "./service.js";

const CODES: readonly ErrorCode[] = ["INVALID", "DUPLICATE_ID", "NOT_FOUND", "BAD_REFERENCE", "LIMIT", "UNAVAILABLE", "FORBIDDEN"];

export interface LiveOptions {
  /** The Worker address, such as `https://canvas.example.com`. */
  server: string;
  /** Board id. */
  board: string;
  /** A bearer token. The server maps it to the actor, the kind, and the role. */
  token: string;
  /** The name other people see in presence. Defaults to the actor id. */
  name?: string;
  /** Reconnect after a drop. Edits made offline merge when the socket returns. */
  reconnect?: { initialMs?: number; maxMs?: number };
}

/** Who the server says the token is. */
export interface Me {
  actor: Principal;
  role: "editor" | "viewer";
}

const base = (server: string) => server.replace(/\/$/, "") + "/api/v1/canvas";

/** The server's error as a CanvasError. A code this package does not know becomes UNAVAILABLE for a 5xx and INVALID otherwise. */
async function refusal(response: Response, fallback: string): Promise<CanvasError> {
  const { error } = (await response.json().catch(() => ({}))) as { error?: { code?: unknown; message?: unknown } };
  const code = CODES.find((known) => known === error?.code) ?? (response.status === 401 || response.status === 403 ? "FORBIDDEN" : response.status >= 500 ? "UNAVAILABLE" : "INVALID");
  return new CanvasError(code, typeof error?.message === "string" ? error.message : `${fallback} (${response.status})`);
}

/** A JSON body, or a CanvasError: a server that answers 200 with anything else is no server this client knows. */
async function json(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json().catch(() => undefined);
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new CanvasError("INVALID", "the server sent a body this client does not know");
  return body as Record<string, unknown>;
}

const unreachable = (error: unknown): CanvasError =>
  error instanceof CanvasError ? error : new CanvasError("UNAVAILABLE", `could not reach the live server: ${error instanceof Error ? error.message : String(error)}`);

async function call(server: string, token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base(server)}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } }).catch((error: unknown) => {
    throw unreachable(error);
  });
}

export async function whoAmI(server: string, token: string): Promise<Me> {
  const response = await call(server, token, "/me");
  if (!response.ok) throw await refusal(response, "the server refused the token");
  const { actor, kind, role } = await json(response);
  const principal = principalSchema.safeParse({ kind, id: actor });
  if (!principal.success || (role !== "editor" && role !== "viewer")) throw new CanvasError("INVALID", "the server sent an identity this client does not know");
  return { actor: principal.data, role };
}

/**
 * One board, open in a live room. The actor of every edit is the one the server reads from the token, so an agent
 * token always writes agent edits. `save` writes the room to the stored board. The server checks the stamps then.
 */
export class LiveBoard {
  private constructor(
    readonly board: Board,
    readonly me: Me,
    private readonly client: SyncClient,
    private readonly id: string,
    private readonly options: LiveOptions,
    private readonly refusedAtStart: number,
  ) {}

  private changed = new Set<string>();

  /** The ids of the elements that the last `edit` added, changed, or removed. */
  get touched(): ReadonlySet<string> {
    return this.changed;
  }

  static async join(options: LiveOptions): Promise<LiveBoard> {
    const me = await whoAmI(options.server, options.token);
    const id = encodeURIComponent(options.board);
    // Read the stored board first: it tells a missing board from a failed connection, and the room starts from it.
    const stored = await call(options.server, options.token, `/boards/${id}/state`);
    if (!stored.ok) throw await refusal(stored, "could not read the stored board");
    const state = new Uint8Array(await stored.arrayBuffer());
    const url = new URL(`${base(options.server)}/boards/${id}/ws`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    let client: SyncClient;
    try {
      client = await SyncClient.connect({ url: url.toString(), headers: { authorization: `Bearer ${options.token}` }, presence: { name: options.name ?? me.actor.id }, reconnect: options.reconnect });
    } catch (error) {
      throw unreachable(error);
    }
    try {
      Y.applyUpdate(client.doc, state);
      await client.flush();
      // A room drops a viewer's seed, and that is no refusal of an edit. An editor's refused seed is an error.
      if (me.role === "editor" && client.denied.length > 0) throw new CanvasError("FORBIDDEN", `the room refused the stored board: ${client.denied[0]}`);
    } catch (error) {
      // Never leave the client open: with reconnect it would retry the seed for ever.
      await client.disconnect();
      throw unreachable(error);
    }
    return new LiveBoard(new Board(client.doc), me, client, options.board, options, client.denied.length);
  }

  /** The other people and agents in the room. `machine` is true for an agent. */
  get peers(): Peer[] {
    return this.client.peers;
  }

  /** Why the room dropped an update, in order. */
  get denied(): string[] {
    return this.client.denied.slice(this.refusedAtStart);
  }

  /**
   * Run one change as the token's actor and wait until the room has it. A viewer fails before the change.
   * After a refusal the local copy still holds the change: leave and join again.
   */
  async edit<T>(run: (board: Board, actor: Principal) => T): Promise<T> {
    if (this.me.role === "viewer") throw new CanvasError("FORBIDDEN", "this token is a viewer; it cannot change a board");
    const seen = this.denied.length;
    const snapshot = () => new Map(this.board.list().map((e) => [e.id, JSON.stringify(e)]));
    const before = snapshot();
    const result = run(this.board, this.me.actor);
    const after = snapshot();
    this.changed = new Set([...before.keys(), ...after.keys()].filter((id) => before.get(id) !== after.get(id)));
    await this.client.flush();
    if (this.denied.length > seen) throw new CanvasError("FORBIDDEN", `the room refused the edit: ${this.denied[seen]}`);
    return result;
  }

  /** Wait until the room has every change made so far. */
  flush(): Promise<void> {
    return this.client.flush();
  }

  /**
   * Save the room to the stored board. `fixed` lists the elements the server's checks changed. After that the
   * room still holds the client's version, so leave and join again.
   */
  async save(): Promise<{ elements: number; fixed: string[] }> {
    if (this.me.role === "viewer") throw new CanvasError("FORBIDDEN", "this token is a viewer; it cannot change a board");
    await this.client.flush();
    const saved = await call(this.options.server, this.options.token, `/boards/${encodeURIComponent(this.id)}/checkpoint`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: this.board.encode() as BodyInit });
    if (!saved.ok) throw await refusal(saved, "the server did not save the board");
    const { elements, fixed } = await json(saved);
    if (typeof elements !== "number" || !Array.isArray(fixed) || !fixed.every((id) => typeof id === "string")) throw new CanvasError("INVALID", "the server sent a save result this client does not know");
    return { elements, fixed: fixed as string[] };
  }

  async leave(): Promise<void> {
    await this.client.disconnect();
  }
}

/**
 * The commands of the CLI and the MCP server, run in a live room. Each call joins the room, runs one change as the
 * token's actor, saves to the stored board, and leaves. The `actor` argument is ignored: the server decides who writes.
 * A read shows the room, which the server checks only when it saves: a forged stamp can show until then.
 */
export class LiveService implements BoardAccess {
  constructor(private readonly options: Omit<LiveOptions, "board">) {}

  private join(board: string): Promise<LiveBoard> {
    return LiveBoard.join({ ...this.options, board });
  }

  async create(_actor: Principal, options: { id?: string; title?: string } = {}): Promise<{ id: string; title: string }> {
    const response = await call(this.options.server, this.options.token, "/boards", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(options) });
    if (!response.ok) throw await refusal(response, "the server refused the request");
    const { id, title } = await json(response);
    if (typeof id !== "string" || typeof title !== "string") throw new CanvasError("INVALID", "the server sent a board this client does not know");
    return { id, title };
  }

  async read(id: string): Promise<BoardData & { id: string }> {
    return this.use(id, async (live) => ({ id, ...readBoard(live.board) }));
  }

  async exportSvg(id: string): Promise<string> {
    return this.use(id, async (live) => toSvg(live.board));
  }

  add(id: string, shape: unknown, _actor?: Principal) {
    return this.write(id, (board, actor) => board.addShape(shape, actor));
  }

  connect(id: string, connector: unknown, _actor?: Principal) {
    return this.write(id, (board, actor) => board.addConnector(connector, actor));
  }

  move(id: string, element: string, dx: number, dy: number, _actor?: Principal) {
    return this.write(id, (board, actor) => ({ moved: board.move(element, dx, dy, actor) }));
  }

  remove(id: string, element: string) {
    return this.write(id, (board) => ({ removed: board.remove(element) }));
  }

  flow(id: string, text: string, _actor?: Principal, options?: DrawOptions) {
    return this.write(id, (board, actor) => drawFlow(board, text, actor, options));
  }

  private async use<T>(id: string, run: (live: LiveBoard) => Promise<T>): Promise<T> {
    const live = await this.join(id);
    try {
      return await run(live);
    } finally {
      await live.leave();
    }
  }

  private write<T>(id: string, change: (board: Board, actor: Principal) => T): Promise<T> {
    return this.use(id, async (live) => {
      const result = await live.edit(change);
      const saved = await live.save().catch((error: unknown) => {
        throw new CanvasError(error instanceof CanvasError ? error.code : "UNAVAILABLE", `the room has the change, but it is not saved: ${error instanceof Error ? error.message : String(error)}. Do not repeat the change.`);
      });
      // The checks cover the whole room. Another client's forged element is no failure of this change.
      if (saved.fixed.some((id) => live.touched.has(id))) throw new CanvasError("FORBIDDEN", "the server undid the change because of its author checks. Do not repeat the change.");
      return result;
    });
  }
}
