import { assertId, type Store } from "agentic-identity";
import { Board, CanvasError } from "./core/board.js";
import { drawFlow, type DrawOptions } from "./core/flow.js";
import { principalSchema, type Principal } from "./core/principal.js";
import { readBoard, type BoardData } from "./core/read.js";
import { toSvg } from "./core/svg.js";
import { svgToPng } from "./png.js";

const COLLECTION = "boards";
const BOARD_ID = /^[A-Za-z0-9_-]{1,64}$/;

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}

const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** The store refuses some ids, and its error text holds the id. Refuse them first, with a fixed message. */
function boardKey(id: string): string {
  try {
    if (!BOARD_ID.test(id)) throw new Error();
    assertId(id);
  } catch {
    throw new CanvasError("INVALID", "board id must be 1 to 64 of A-Z, a-z, 0-9, _ and -, and not like __x__");
  }
  return id;
}

/** One place for every board operation. The CLI, the MCP server, and the Worker call it. */
export class CanvasService {
  constructor(private readonly store: Store) {}

  async create(actor: Principal, options: { id?: string; title?: string } = {}): Promise<{ id: string; title: string }> {
    const id = boardKey(options.id ?? crypto.randomUUID());
    const board = new Board();
    if (options.title !== undefined) board.setTitle(options.title, actor);
    return this.store.transaction(async (tx) => {
      if (await tx.get(COLLECTION, id)) throw new CanvasError("DUPLICATE_ID", `board "${id}" already exists`);
      await tx.put(COLLECTION, id, { update: toBase64(board.encode()) });
      return { id, title: board.title };
    });
  }

  async read(id: string): Promise<BoardData & { id: string }> {
    boardKey(id);
    return this.store.transaction(async (tx) => ({ id, ...readBoard(await this.load(tx.get(COLLECTION, id), id)) }));
  }

  /** Run `change` on the board and save it, all inside one transaction. */
  async change<R>(id: string, change: (board: Board) => R): Promise<R> {
    boardKey(id);
    return this.store.transaction(async (tx) => {
      const board = await this.load(tx.get(COLLECTION, id), id);
      const result = change(board);
      await tx.put(COLLECTION, id, { update: toBase64(board.encode()) });
      return result;
    });
  }

  add(id: string, shape: unknown, actor: Principal) {
    return this.change(id, (b) => b.addShape(shape, actor));
  }

  connect(id: string, connector: unknown, actor: Principal) {
    return this.change(id, (b) => b.addConnector(connector, actor));
  }

  move(id: string, elementId: string, dx: number, dy: number, actor: Principal) {
    return this.change(id, (b) => ({ moved: b.move(elementId, dx, dy, actor) }));
  }

  remove(id: string, elementId: string) {
    return this.change(id, (b) => ({ removed: b.remove(elementId) }));
  }

  flow(id: string, text: string, actor: Principal, options?: DrawOptions) {
    return this.change(id, (b) => drawFlow(b, text, actor, options));
  }

  async exportSvg(id: string): Promise<string> {
    boardKey(id);
    return this.store.transaction(async (tx) => toSvg(await this.load(tx.get(COLLECTION, id), id)));
  }

  async exportPng(id: string): Promise<Uint8Array> {
    return svgToPng(await this.exportSvg(id));
  }

  /** Owner only. Repair a board and delete the named elements. Only a human actor may call it. */
  async repair(id: string, actor: Principal, drop: string[] = []): Promise<{ id: string; fixed: string[]; elements: number }> {
    const by = principalSchema.safeParse(actor);
    if (!by.success) throw new CanvasError("INVALID", "the actor must be a valid principal");
    if (by.data.kind !== "human") throw new CanvasError("FORBIDDEN", "only a human owner can repair a board");
    boardKey(id);
    return this.store.transaction(async (tx) => {
      const doc = await tx.get(COLLECTION, id);
      if (!doc) throw new CanvasError("NOT_FOUND", `no board "${id}"`);
      const board = decodeStored(doc, id, Board.open);
      const fixed = board.repair(drop);
      await tx.put(COLLECTION, id, { update: toBase64(board.encode()) });
      return { id, fixed, elements: board.list().length };
    });
  }

  private async load(read: Promise<{ update?: unknown } | null>, id: string): Promise<Board> {
    const doc = await read;
    if (!doc) throw new CanvasError("NOT_FOUND", `no board "${id}"`);
    return decodeStored(doc, id, Board.decode);
  }
}

/** A cap error is shown as it is. Anything else from a stored update means the file is damaged. */
function decodeStored(doc: { update?: unknown }, id: string, decode: (bytes: Uint8Array) => Board): Board {
  try {
    return decode(fromBase64(String(doc.update)));
  } catch (error) {
    if (error instanceof CanvasError) throw error;
    throw new CanvasError("INVALID", `stored board "${id}" is damaged`);
  }
}
