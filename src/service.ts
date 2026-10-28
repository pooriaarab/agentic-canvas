import { Board, CanvasError } from "./core/board.js";
import { drawFlow, type DrawOptions } from "./core/flow.js";
import type { Principal } from "./core/principal.js";
import { readBoard, type BoardData } from "./core/read.js";
import { toSvg } from "./core/svg.js";
import { svgToPng } from "./png.js";
import { fromBase64, toBase64, type BoardStore } from "./store.js";

const COLLECTION = "boards";
const BOARD_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** One place for every board operation. The CLI, the MCP server, and the Worker call it. */
export class CanvasService {
  constructor(private readonly store: BoardStore) {}

  async create(actor: Principal, options: { id?: string; title?: string } = {}): Promise<{ id: string; title: string }> {
    const id = options.id ?? crypto.randomUUID();
    if (!BOARD_ID.test(id)) throw new CanvasError("INVALID", "board id must be 1 to 64 of A-Z, a-z, 0-9, _ and -");
    const board = new Board();
    if (options.title !== undefined) board.setTitle(options.title, actor);
    return this.store.transaction(async (tx) => {
      if (await tx.get(COLLECTION, id)) throw new CanvasError("DUPLICATE_ID", `board "${id}" already exists`);
      await tx.put(COLLECTION, id, { update: toBase64(board.encode()) });
      return { id, title: board.title };
    });
  }

  async read(id: string): Promise<BoardData & { id: string }> {
    return this.store.transaction(async (tx) => ({ id, ...readBoard(await this.load(tx.get(COLLECTION, id), id)) }));
  }

  /** Run `change` on the board and save it, all inside one transaction. */
  async change<R>(id: string, change: (board: Board) => R): Promise<R> {
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
    return this.store.transaction(async (tx) => toSvg(await this.load(tx.get(COLLECTION, id), id)));
  }

  async exportPng(id: string): Promise<Uint8Array> {
    return svgToPng(await this.exportSvg(id));
  }

  private async load(read: Promise<{ update?: unknown } | null>, id: string): Promise<Board> {
    const doc = await read;
    if (!doc) throw new CanvasError("NOT_FOUND", `no board "${id}"`);
    try {
      return Board.decode(fromBase64(String(doc.update)));
    } catch {
      throw new CanvasError("INVALID", `stored board "${id}" is damaged`);
    }
  }
}

