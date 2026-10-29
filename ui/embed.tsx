// The board UI for an app that embeds it: `agentic-canvas/ui`. The app gives a client, a board id, and the principal who
// uses the board. React and react-dom are peer dependencies. The styles are in `agentic-canvas/ui.css`. The host owns the theme.
import { ToastProvider, TooltipProvider } from "agentic-design/react";
import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { CanvasClient } from "../src/client.js";
import { PRINCIPAL_KINDS, principalSchema, type PrincipalKind } from "../src/core/principal.js";
import { BoardView } from "./BoardView.js";
import { checkHost, type HostBoard } from "./host.js";
import type { RoomOptions } from "./presence.js";

export type { CanvasClient, HostBoard, RoomOptions };

/** Who uses the board. The server still checks every write against its own token. */
export interface BoardPrincipal {
  kind: PrincipalKind;
  name: string;
  /** Stamped on each element the principal writes in host mode. The default is `name`, which must then be a valid id. A client mode board takes the actor from its token. */
  id?: string;
  /** Only `editor` can change the board. Any other value, or no value, opens it read only. */
  role?: "editor" | "viewer";
}

export interface BoardEditorOptions {
  /** The board id. */
  boardId: string;
  /** Loads and changes the board. A client from `createClient` in `agentic-canvas/client` works. Needed unless `host` is given. */
  client?: CanvasClient;
  /**
   * The board in your own Yjs document. The UI then reads and writes that document, and calls no client, does not poll, and
   * opens no live room. `client` or `room` together with `host` throws a `TypeError`.
   */
  host?: HostBoard;
  principal: BoardPrincipal;
  /** Open the board read only, even for an editor. */
  readOnly?: boolean;
  /** The live room. With one, the board shows who else is here and reads again when they save. */
  room?: RoomOptions;
  /** A link for a missing board to go back to. */
  backHref?: string;
}

/** A principal must have a known kind and a name. A missing kind is an error, never a default. */
function checkPrincipal(principal: BoardPrincipal, options?: BoardEditorOptions): void {
  if (!principal || !PRINCIPAL_KINDS.includes(principal.kind) || typeof principal.name !== "string" || principal.name.trim() === "") {
    throw new TypeError(`the board needs a principal with a kind (${PRINCIPAL_KINDS.join(", ")}) and a name`);
  }
  if (!options) return;
  if (options.host) {
    checkHost(options.host);
    if (options.client) throw new TypeError("a host board writes to its own document, not through a `client`: give one of them");
    const stamp = principalSchema.safeParse({ kind: options.principal.kind, id: options.principal.id ?? options.principal.name });
    if (!stamp.success) throw new TypeError(`the principal needs an \`id\` of letters, digits, ".", "_" and "-" to stamp its writes: ${stamp.error.issues[0]?.message}`);
    if (options.room) throw new TypeError("a host board has no live room of its own: give its presence in `host.presence`, not `room`");
  } else if (!options.client) throw new TypeError("the board needs a `client`, or a `host` board");
}

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div role="alert" className="failure"><p><strong>The board stopped.</strong> It has content this page cannot show, or a principal it does not know. Reload to try again.</p></div>
    ) : this.props.children;
  }
}

function Board({ boardId, client, host, principal, readOnly, room, backHref }: BoardEditorOptions) {
  checkPrincipal(principal, { boardId, client, host, principal, room });
  const role = principal.role === "editor" && !readOnly ? "editor" : "viewer";
  return <BoardView key={boardId} id={boardId} client={client} host={host} room={room} backHref={backHref} me={{ actor: principal.name, id: principal.id, kind: principal.kind, role }} />;
}

/** The board for one id, with its toolbar, presence, and side panel. It needs the providers of `agentic-design`. A bad principal shows an alert. */
export function BoardEditor(options: BoardEditorOptions) {
  return (
    <div className="cv-root">
      <Boundary>
        <Board {...options} />
      </Boundary>
    </div>
  );
}

export interface MountedBoard {
  /** Show another board, principal, or room in the same place. A bad principal throws and keeps the board as it is. */
  update(options: BoardEditorOptions): void;
  /** Remove the board, leave the live room, and stop its timers. */
  unmount(): void;
}

/** Render the board into an element, for an app that does not use React itself. */
export function mount(element: HTMLElement, options: BoardEditorOptions): MountedBoard {
  checkPrincipal(options.principal, options);
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
    update: (next) => (checkPrincipal(next.principal, next), open && render(next)),
    unmount: () => {
      if (!open) return;
      open = false;
      root.unmount();
    },
  };
}
