import type { Peer, Status, SyncClient } from "agentic-realtime/client";
import * as Y from "yjs";
import type { CanvasClient } from "../src/client.js";
import { Board } from "../src/core/board.js";
import type { Principal } from "../src/core/principal.js";
import { readBoard } from "../src/core/read.js";

/** The presence of a room: who is here. A `SyncClient` of agentic-realtime has these. */
export type RoomPresence = Pick<SyncClient, "peers" | "onPeers">;

/**
 * A board that the app keeps itself, in its own Yjs room. The UI reads and writes it, and does not call a client, poll, or
 * open a live room. The app keeps the document and its room.
 */
export interface HostBoard {
  /** The Yjs document. The UI opens it as a `Board`: its `elements` and `meta` maps, as this package stores them. */
  doc: Y.Doc;
  /** The presence of the app's room. With it, the UI shows who else is here. */
  presence?: RoomPresence;
  /** The connection state now. With neither `status` nor `onStatus`, the UI shows the board as live. With only `onStatus`, it shows not live until the room reports "connected". */
  status?: () => Status;
  /** A way to hear when the connection state changes. It returns a function that stops the listener. The UI reads it once each time it opens `doc`. */
  onStatus?: (listener: (status: Status) => void) => () => void;
}

/** The calls the board UI makes. A client from `createClient` has them, and so does a host board. */
export type BoardCalls = Pick<CanvasClient, "readBoard" | "addShape" | "addConnector" | "update" | "move" | "remove">;

/**
 * A host document must be a Yjs document of the same Yjs copy as the UI, since a document from another copy cannot be read.
 * Its presence must have peers and onPeers.
 */
export function checkHost(host: HostBoard): void {
  if (!host || !(host.doc instanceof Y.Doc)) throw new TypeError("a host board needs a Yjs document in `doc`");
  const presence = host.presence;
  if (presence !== undefined && (!Array.isArray(presence?.peers) || typeof presence.onPeers !== "function")) {
    throw new TypeError("a host presence needs peers and onPeers, as a SyncClient has");
  }
  if ((host.status !== undefined && typeof host.status !== "function") || (host.onStatus !== undefined && typeof host.onStatus !== "function")) {
    throw new TypeError("a host status and onStatus must be functions");
  }
}

/**
 * The UI's calls, made on a board in this tab. Each write is stamped with `who()`, so an element an agent writes is
 * machine-made. A refused write throws a `CanvasError`.
 */
export function boardCalls(board: Board, who: () => Principal): BoardCalls {
  return {
    readBoard: async (id) => ({ id, ...readBoard(board) }),
    addShape: async (_id, shape) => board.addShape(shape, who()),
    addConnector: async (_id, connector) => board.addConnector(connector, who()),
    update: async (_id, element, patch) => board.update(element, patch, who()) as never,
    move: async (_id, element, dx, dy) => ({ moved: board.move(element, dx, dy, who()) }),
    remove: async (_id, element) => ({ removed: board.remove(element) }),
  };
}

export type { Peer, Status };
