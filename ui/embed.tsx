// The board UI for an app that embeds it: `agentic-canvas/ui`. The app gives a client, a board id, and the principal who
// uses the board. React and react-dom are peer dependencies. The styles are in `agentic-canvas/ui.css`. The host owns the theme.
import { ToastProvider, TooltipProvider } from "agentic-design/react";
import { createRoot } from "react-dom/client";
import type { CanvasClient } from "../src/client.js";
import { PRINCIPAL_KINDS, type PrincipalKind } from "../src/core/principal.js";
import { BoardView } from "./BoardView.js";
import type { RoomOptions } from "./presence.js";

export type { CanvasClient, RoomOptions };

/** Who uses the board. The server still checks every write against its own token. */
export interface BoardPrincipal {
  kind: PrincipalKind;
  name: string;
  /** Only `editor` can change the board. Any other value, or no value, opens it read only. */
  role?: "editor" | "viewer";
}

export interface BoardEditorOptions {
  /** The board id. */
  boardId: string;
  /** Loads and changes the board. A client from `createClient` in `agentic-canvas/client` works. */
  client: CanvasClient;
  principal: BoardPrincipal;
  /** Open the board read only, even for an editor. */
  readOnly?: boolean;
  /** The live room. With one, the board shows who else is here and reads again when they save. */
  room?: RoomOptions;
  /** A link for a missing board to go back to. */
  backHref?: string;
}

/** A principal must have a known kind and a name. A missing kind is an error, never a default. */
function checkPrincipal(principal: BoardPrincipal): void {
  if (!principal || !PRINCIPAL_KINDS.includes(principal.kind) || typeof principal.name !== "string" || principal.name.trim() === "") {
    throw new TypeError(`the board needs a principal with a kind (${PRINCIPAL_KINDS.join(", ")}) and a name`);
  }
}

/** The board for one id, with its toolbar, presence, and side panel. It needs the providers of `agentic-design`. */
export function BoardEditor({ boardId, client, principal, readOnly, room, backHref }: BoardEditorOptions) {
  checkPrincipal(principal);
  const role = principal.role === "editor" && !readOnly ? "editor" : "viewer";
  return <BoardView key={boardId} id={boardId} client={client} room={room} backHref={backHref} me={{ actor: principal.name, kind: principal.kind, role }} />;
}

export interface MountedBoard {
  /** Show another board, principal, or room in the same place. A bad principal throws and keeps the board as it is. */
  update(options: BoardEditorOptions): void;
  /** Remove the board, leave the live room, and stop its timers. */
  unmount(): void;
}

/** Render the board into an element, for an app that does not use React itself. */
export function mount(element: HTMLElement, options: BoardEditorOptions): MountedBoard {
  checkPrincipal(options.principal);
  const root = createRoot(element);
  const render = (next: BoardEditorOptions) =>
    root.render(
      <TooltipProvider>
        <ToastProvider>
          <BoardEditor {...next} />
        </ToastProvider>
      </TooltipProvider>,
    );
  render(options);
  let open = true;
  return {
    update: (next) => (checkPrincipal(next.principal), open && render(next)),
    unmount: () => {
      if (!open) return;
      open = false;
      root.unmount();
    },
  };
}
