# agentic-canvas

[![npm version](https://img.shields.io/npm/v/agentic-canvas)](https://www.npmjs.com/package/agentic-canvas)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-canvas) · [Source](https://github.com/pooriaarab/agentic-canvas) · [Support](https://github.com/pooriaarab/agentic-canvas/issues)

A shared whiteboard for diagrams, drawn by people and agents.

> Status: 0.3.0. The board model, the agent operations, the exports, the CLI, the
> MCP server, a small Worker API, and live co-editing work. The CLI, the MCP server,
> and the SDK can join a live room. A remote client calls the Worker API. A small web UI, served by the Worker, is new and unreleased.

## Install

Node 22 or newer.

```sh
npm install agentic-canvas
```

To build from source instead, run `npm ci` and `npm run build`.

PNG export is optional. It needs the `playwright-core` package (Apache-2.0) and a
Chromium: `npm i playwright-core && npx playwright-core install chromium`.
The Chromium download is a one-time call to the Playwright CDN at install time. PNG export
itself makes no network call.

## Quick start

```sh
export CANVAS_ACTOR=agent:helper          # who writes: <kind>:<id>
npx agentic-canvas new --id demo --title "Release flow"
npx agentic-canvas flow demo --text $'direction LR\nCode(Write code) -> Test{Tests pass?}: push\nTest -> Ship[Ship it]: yes'
npx agentic-canvas read demo              # nodes, edges, text as JSON
npx agentic-canvas export demo --out demo.svg
npx agentic-canvas export demo --format png --out demo.png
```

Other commands: `list`, `add`, `connect`, `update`, `move`, `rm`. Run `npx agentic-canvas --help`.
`repair` is for the owner only. It needs `CANVAS_ACTOR=human:<id>`.
Boards live in `./.agentic-canvas` (or `--dir`, or `CANVAS_DIR`). Every write
needs an actor in `CANVAS_ACTOR`, as `<kind>:<id>`. The operator sets it. A write
fails when it is unset, empty, or has a bad kind. The CLI has no `--actor` flag and no
default actor, so a caller cannot pick its own kind. Only the operator can set `human`.

## MCP server

```sh
CANVAS_ACTOR=agent:helper npx agentic-canvas --dir ./boards mcp
```

The server speaks MCP on stdio. It has one tool for each CLI command: `create_board`,
`list_boards`, `read_board`, `add_shape`, `connect`, `update_element`, `move`, `remove`, `draw_flow`, `export_svg`, and
`export_png`. `repair` is not a tool. Only a human operator runs it, from the CLI. The server will not start unless `CANVAS_ACTOR` is set to a valid
`<kind>:<id>`. That actor stamps every write. No tool takes an actor, author, or kind, so a
caller cannot choose who it writes as. An error comes back as a tool error with a code.

## SDK

```ts
import { Board } from "agentic-canvas";

const me = { kind: "human", id: "ada" } as const;
const bot = { kind: "agent_of_human", id: "helper" } as const;

const board = new Board();
board.addShape({ id: "a", type: "rect", x: 0, y: 0, text: "Start" }, me);
board.addShape({ id: "b", type: "diamond", x: 240, y: 0, text: "Ok?" }, bot);
board.addConnector({ from: { id: "a" }, to: { id: "b" }, text: "next" }, bot);
board.list(); // every element, back to front
```

Read the board as data, and draw a flowchart from text:

```ts
import { drawFlow, readBoard } from "agentic-canvas";

drawFlow(board, "direction LR\nS(Start) -> D{Ok?}: go\nD -> E[Done]: yes", bot);
readBoard(board); // { title, nodes, edges, groups, texts }
```

The flow text takes one statement per line: `A -> B: label`. Use `[text]` for a
box, `(text)` for an ellipse, and `{text}` for a diamond. `direction LR` sets
the direction. Lines that start with `#` or `//` are comments.

### Remote client

Call a running Worker from a browser, a Worker, or Node 22. The client uses only `fetch`.

```ts
import { createClient, CanvasApiError } from "agentic-canvas/client";

const canvas = createClient({ baseUrl: "https://canvas.example.com/api/v1/canvas", token });
await canvas.createBoard({ id: "plan", title: "Plan" });
await canvas.addShape("plan", { type: "rect", x: 0, y: 0, text: "Start" });
await canvas.drawFlow("plan", "A -> B: go");
const board = await canvas.readBoard("plan");

try {
  await canvas.readBoard("missing");
} catch (error) {
  if (error instanceof CanvasApiError) console.log(error.code, error.status); // NOT_FOUND 404
}
```

There is one method per route: `me`, `listBoards`, `createBoard`, `readBoard`, `exportSvg`, `addShape`, `addConnector`,
`drawFlow`, `update`, `move`, `remove`, `uploadImage`, `getImage`, `state`, and `checkpoint`. Each takes
`{ signal }` last, so an `AbortSignal` can stop a call. The token sets the actor. A failed call throws
`CanvasApiError` with the API `code` and the HTTP `status`. A call that gets no reply has code `NETWORK`
and status 0. The client never retries. A 503 means "try again", and the caller decides, because a
repeated write can change a board twice. Pass `fetch` to use your own.

## UI

The Worker serves a small web UI at its root. It uses the published `agentic-design` package for
tokens, controls, and overlays, and the typed `agentic-canvas/client` for every call. It is
bundled at build time, so a build needs `agentic-design` from npm and the browser loads nothing
from another site.

Run it on your machine:

```sh
npm ci
npm run build                      # writes the UI to ui-dist/
cat > .dev.vars <<'EOF2'
CANVAS_REGION=unknown
CANVAS_API_TOKENS={"ada-token-0123456789-0123456789-0123456789":{"actor":"ada","kind":"human"}}
EOF2
WRANGLER_SEND_METRICS=false npx wrangler dev
```

Open the address that wrangler prints and paste the token. A token has 32 characters or more. Its
grant sets the name, the kind (a person or an agent), and the role. A `viewer` token reads and
cannot change a board. The token stays in the tab's session storage.

What it does:

- Lists boards, makes a board, and opens one. Empty, loading, and error states have a retry.
- Draws shapes, connectors, text, and sticky notes. Select, move, resize, connect, and delete an
  item. Pan by dragging the background, zoom with the wheel or the toolbar.
- Marks an item an agent wrote with an "Agent" tag and in its accessible name. The side panel shows
  who made the item and who last edited it.
- Shows who is in the board, from the live room (`agentic-realtime`). Edits go over the HTTP API.
  After a save, the editor raises a counter in its room presence, and the other editors read the
  board again. Without the room, the page reads the board again every 8 seconds.
- Works with a keyboard. Tab moves between items. Arrow keys move the selected item, Shift with an
  arrow resizes it, Delete removes it, Escape clears the selection. With nothing selected, arrow
  keys pan, `+` and `-` zoom, and `0` resets the view. The side panel also sets text and size,
  and connects shapes, with fields.

Develop and test the UI:

```sh
npm run build                      # UI and library
npx playwright-core install chromium
npm run test:e2e                   # Playwright against `wrangler dev`, with axe (WCAG 2.2 AA)
```

The E2E run creates a board, adds a shape and a note, moves them, reloads, and checks each view
with axe in the light and the dark theme. It saves screenshots to `test-results/screens/`. The committed set in `docs/ui/` shows the UI at this release. Run `UPDATE_SCREENSHOTS=1 npm run test:e2e` to refresh it.

A browser cannot set a header on a WebSocket, so the UI sends its token to the live room as a WebSocket sub-protocol (`Sec-WebSocket-Protocol`). A proxy that logs request headers can record it. The API itself takes the token only in an `Authorization` header, and the sub-protocol only on a WebSocket upgrade.

The UI saves each edit in order, and shows "Saving…" until the last one is stored. It asks the browser to confirm before you leave a page with unsaved edits. It reads the board again at most once a second.

UI limits: the UI draws with the theme colors and ignores the `fill` and `stroke` of an element.
It shows no image pixels. A text field of a shape is plain text. Two editors who move one item
at the same time keep the last write. The board list shows the first 100 boards.

## Features

- Shapes: rectangle, ellipse, diamond, text, sticky note, frame, image.
- Connectors that bind to shapes and follow them when they move.
- Z-order, and groups that nest.
- Every element keeps the kind of its author and of its last editor. An agent
  edit stays visible as machine-made.
- `readBoard`: nodes, edges, groups, and text as plain data, with a machine-made
  flag on each.
- `drawFlow`: a flowchart from text with a layered layout. It adds nothing when
  anything fails.
- `toSvg`: a deterministic SVG. It fetches nothing and marks machine-made work
  with `data-machine-made`.
- `svgToPng`: PNG through a headless Chromium with JavaScript off, service workers blocked,
  and every network request blocked. A board over 16 million pixels exports as SVG only.
- A CLI over a local file store. Several processes can write at once.
- An MCP server (stdio) over the same service as the CLI.
- A Worker (`agentic-canvas/worker`) under `/api/v1/canvas`. Boards live in D1 and images in R2
  (EU jurisdiction), through the shared `Store` and `Blobs` ports. Set `CANVAS_API_TOKENS`
  (a JSON map of token to `{ actor, kind }`, tokens of 32 characters or more) and `CANVAS_REGION`.
  Routes: `POST /boards`, `GET /boards/:id`, `GET /boards/:id/svg`, `POST /boards/:id/shapes`,
  `/connectors`, `/flow`, `/move`, `GET /boards`, `PATCH /boards/:id/elements/:element`, `DELETE /boards/:id/elements/:element`, `POST /images`,
  `GET /images/:id`. An image is stored under the SHA-256 of its bytes, and the reply gives
  the `blob:` ref for a shape. A busy database or bucket answers 503: try again.
- Live rooms (`agentic-canvas/live-worker`, on `agentic-realtime`). One Durable Object holds one
  board. A token may carry `"role": "viewer"`: a viewer reads and cannot write. `GET /boards/:id/ws`
  opens a room, `GET /me` says who a token is, `GET /boards/:id/state` and
  `POST /boards/:id/checkpoint` seed a room from the stored board and save it back, as a merge. A save
  checks author stamps: a client cannot put another author on its work.
- The SDK joins a room: `import { LiveBoard, LiveService } from "agentic-canvas/live"`. The CLI and the MCP
  server join when `CANVAS_SERVER` and `CANVAS_TOKEN` are set. The token sets the actor, so
  `CANVAS_ACTOR` is not needed. `--dir`, `CANVAS_DIR`, and `repair` stay local.
- Yjs underneath: two copies of a board merge without conflicts.
- No UI code. The model is plain TypeScript on Yjs, with no outbound calls.

## Limits

- Canvas takes principal kinds, regions, and the Store and Blobs ports from `agentic-identity` 0.4.
  It does not use the sharing API yet. Its editor and viewer tokens are a separate table in
  `CANVAS_API_TOKENS`. It has no board delete or erase. When it adopts sharing, grants are keyed
  on kind and id, and a delete calls `deleteResource`.
- A board holds at most 10,000 elements. A flow holds at most 500 nodes and 2,000
  edges.
- Flow text has no chains (`A -> B -> C`). Write one edge per line.
- `readBoard` leaves out embedded image bytes.
- Images hold a `data:` PNG, JPEG, GIF, or WebP, or a `blob:` key. Remote URLs and
  SVG are refused.
- Two peers that make the same explicit id at the same time keep only one element, with no
  error. Explicit ids are safe with one writer. Leave `id` empty and the board picks a random one.
- A synced update is untrusted. An element that fails the write rules is hidden, and `repair()`
  deletes it. A board past the element cap refuses to load or read. A human operator runs
  `repair --drop <element>` to delete elements until it fits.
- `update` cannot clear a required field. Only `fill` and `stroke` accept `undefined`.
- Z values stop at ±1e9. New elements that pass the limit land at the limit and tie with it.
  While an element sits at +1e9, a front move fails with `LIMIT`. While one sits at -1e9, a back
  move fails. Remove every element at the limit to clear it.
- Delete against connect can leave a connector with a missing end. Readers hide it. `repair()`
  removes it, and `Board.decode` runs `repair()` for you.
- `move` writes absolute positions. Two peers that move one shape at the same time do not add up:
  the last writer wins.
- Frames are plain shapes. They do not own the shapes inside them yet.
- The store is one file, `canvas.json`, in the store folder. A write takes `canvas.json.lock`.
  A lock whose owner is gone, or that is older than 30 seconds, is taken over. A lock that
  cannot be read counts as held: the call then waits 10 seconds and fails with `UNAVAILABLE`.
  Remove the lock by hand if no process runs.
- Node 22 or newer is needed. `agentic-canvas/file-store` exports `createFileStore(path)` and
  `openLocalStore(dir)`. A writer that is paused for more than 30 seconds can lose its lock
  and then still write.
- A room remembers its authors for good, so a client can stamp an element with the name of anyone who
  once sent an update in that room. A save corrects the stored board and not the room: after a save that
  reports `fixed`, join again. A client that adds a root Yjs type of its own blocks later saves of that room.
- Every Worker token reaches every board. A token has an editor or viewer role, and nothing finer yet. Local
  `wrangler dev` cannot confirm a region, so run it with `CANVAS_REGION=unknown`. The region claim covers D1 only: R2 reports no region, so the bucket is in
  the EU jurisdiction only if you create it so. A real D1
  confirms `eu` or `us` on each query. The Worker has no PNG export.
- Delete leaves no audit record yet. The Worker logs the actor kind of each delete, and no ids.
- PNG needs the optional `playwright-core` and a Chromium. Without them it fails with
  `UNAVAILABLE`. SVG always works.

## License

MIT.
