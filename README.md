# agentic-canvas

[![npm version](https://img.shields.io/npm/v/agentic-canvas)](https://www.npmjs.com/package/agentic-canvas)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-canvas) · [Source](https://github.com/pooriaarab/agentic-canvas) · [Support](https://github.com/pooriaarab/agentic-canvas/issues)

A shared whiteboard for diagrams, drawn by people and agents.

> Status: 0.4.0. The board model, the agent operations, the exports, the CLI, the
> MCP server, a small Worker API, and live co-editing work. The CLI, the MCP server,
> and the SDK can join a live room. A remote client calls the Worker API. A small web UI, served by the Worker, is new in 0.4.0.

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

## Live demo

A demo Worker runs on workers.dev: <https://agentic-canvas-demo.hello-fd1.workers.dev>. `GET /health` answers 200
and the web UI is at the root. The API needs a token, so a request without one gets 401. The demo's D1
database and R2 bucket are in the EU, and its live rooms use the EU jurisdiction. The demo data can be
reset at any time.

To redeploy it, a maintainer with a Cloudflare token runs this from the repo root. The deploy is manual and
no CI secret is used:

```sh
npm ci && npm run build
WRANGLER_SEND_METRICS=false CLOUDFLARE_API_TOKEN=... npx wrangler deploy -c wrangler.demo.jsonc
npx wrangler secret put CANVAS_API_TOKENS -c wrangler.demo.jsonc   # only to set or rotate tokens
```

`wrangler.demo.jsonc` holds the config. The tokens are a Worker secret and are not in the repo. To run your
own copy, create a D1 database and an R2 bucket (both in the EU), put their names and id in a copy of that
file, and deploy it the same way.

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
  board again. The page also reads the board again every 5 seconds, so a change made through the API, the CLI, or an agent shows without a reload, a few seconds late.
- Works with a keyboard. Tab moves between items. Arrow keys move the selected item, Shift with an
  arrow resizes it, Delete removes it, Escape clears the selection. With nothing selected, arrow
  keys pan, `+` and `-` zoom, and `0` resets the view. The side panel also sets text, position, and size,
  and connects shapes, with fields, and the toolbar has pan buttons. A person who cannot drag
  can do everything a drag does.

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
  opens a room, `GET /me` says who a token is. The Worker seeds a room from the stored board when a client
  joins, and saves the room to the stored board before it serves any board read or write. A raw WebSocket
  client needs no seed and no save call. A room that no request reaches stays unsaved in the Store until the
  next request, and it is safe in the room's own storage. `GET /boards/:id/state` and
  `POST /boards/:id/checkpoint` still work for a client that saves by hand. Every save checks author stamps,
  and the Worker sets them from the room's log of who sent each update (the token's actor and kind): a client
  cannot claim another principal, and an agent cannot pass as a person, even by naming one who is in the room.
  A new item that the log lacks (it keeps a capped number of ranges, and a hand save may hold content the room never had) has no sender: the save deletes a new element and undoes a change. A hand save puts the part of its update that the room lacks into the room as the poster, so the room refuses a client id that it holds for someone else and its log names the poster. It drops the part the room holds, saves the room, and fails if the room cannot be saved. It is one message of 1,000,000 bytes at most. A stored board over 1,000,000 bytes cannot seed a room: a live join answers 422 for it.
- The SDK joins a room: `import { LiveBoard, LiveService } from "agentic-canvas/live"`. The CLI and the MCP
  server join when `CANVAS_SERVER` and `CANVAS_TOKEN` are set. The token sets the actor, so
  `CANVAS_ACTOR` is not needed. `--dir`, `CANVAS_DIR`, and `repair` stay local.
- Yjs underneath: two copies of a board merge without conflicts.
- The board model has no UI code. It is plain TypeScript on Yjs, with no outbound calls.

## Exports

Every name that each entry point exports is listed here. A name marked (type) exists only at compile time.

### `agentic-canvas`

| Name | What it is |
|---|---|
| `VERSION`, `BRAND` | The package version. `BRAND` holds the command name, the description and the version that the CLI and the MCP server show. |
| `Board`, `CanvasElement` (type), `Shape` (type), `Connector` (type), `Group` (type), `Endpoint` (type), `ShapeType` (type) | The board model. `Board` holds the elements. Each element records its `author`, which never changes, and its `editedBy`. |
| `SHAPE_TYPES` | The shape kinds: `rect`, `ellipse`, `diamond`, `text`, `sticky`, `frame` and `image`. |
| `MAX_ELEMENTS`, `MAX_TEXT` | The limits: 10,000 elements on a board, and 10,000 UTF-16 code units in one text. |
| `CanvasError`, `ErrorCode` (type) | The error that the board throws, with a `code` such as `INVALID`, `NOT_FOUND` or `LIMIT`. |
| `parseFlow(source)`, `layoutFlow(graph)`, `drawFlow(board, source, actor, options?)` | `parseFlow` reads the flow text. `layoutFlow` returns placements with the top-left at (0, 0). `drawFlow` draws the flow onto the board as the actor. |
| `MAX_FLOW_NODES`, `MAX_FLOW_EDGES` | The flow limits: 500 nodes and 2000 edges. |
| `FlowGraph` (type), `FlowNode` (type), `FlowEdge` (type), `Placement` (type), `DrawOptions` (type) | Types for a flow and its layout. |
| `readBoard`, `BoardData` (type), `NodeData` (type), `EdgeData` (type) | Read a board as plain data. |
| `toSvg(board)`, `svgToPng(svg)` | `toSvg` returns the board as SVG. `svgToPng` turns an SVG string into PNG through Chromium. |
| `PRINCIPAL_KINDS`, `PrincipalKind` (type), `Principal` (type), `principalSchema`, `isMachineMade` | The principal kinds, the schema of a principal, and the rule that marks machine-made kinds. |
| `operatorActor(env?)`, `ActorConfigError` | Read the actor from `CANVAS_ACTOR` as `<kind>:<id>`. It throws `ActorConfigError` when the value is missing or bad. |
| `CanvasService` | The board operations that the CLI, the MCP server and the Worker share. It takes a `Store`. |
| `createMcpServer(service, actor)`, `runMcp(service, actor)` | Make the MCP server, or run it on stdio. |
| `createFileStore`, `openLocalStore`, `FileStoreOptions` (type) | Stores on one local file. See `agentic-canvas/file-store`. |

### `agentic-canvas/client`

| Name | What it is |
|---|---|
| `createClient(options)`, `CanvasApiError` | The remote client. See Remote client above. |
| `ClientOptions` (type), `CallOptions` (type), `CanvasClient` (type), `ShapeInput` (type), `ConnectorInput` (type), `ShapePatch` (type), `ConnectorPatch` (type), `ImageInfo` (type), `ApiErrorCode` (type) | Types for the client. `ApiErrorCode` adds the client's own codes, such as `NETWORK`, to `ErrorCode`. |

### `agentic-canvas/file-store`

| Name | What it is |
|---|---|
| `createFileStore(path, options?)`, `openLocalStore(dir)` | A store on one JSON file, or on `canvas.json` in a directory. |
| `FileStoreError` | The error that the store throws. Its `code` is `LOCKED` or `DAMAGED`. |
| `FileStoreOptions` (type) | `lockTimeoutMs` (default 10000) and `staleAfterMs` (default 30000), plus the adapter options. |
| `STORE_FILE` | The file name that `openLocalStore` uses, `canvas.json`. |

### `agentic-canvas/live`

| Name | What it is |
|---|---|
| `LiveBoard.join(options)` | Join one board's live room. Read the board, change it, `save` to the stored board, then `leave`. |
| `LiveService` | The CLI and MCP commands, run in a live room. A change joins the room, runs as the token's actor, saves, and leaves. `read` and `exportSvg` join and leave without a save. `create` and `list` call the HTTP API. |
| `whoAmI(server, token)`, `Me` (type) | Ask the Worker who a token is. It returns the actor and the role. |
| `LiveOptions` (type) | The server, the board id, the token, and the optional name and reconnect settings. |

### `agentic-canvas/worker`

| Name | What it is |
|---|---|
| `createApp(options?)` | Make the Hono app for the Worker. Pass `live` to turn on the live-room socket. |
| `default` | The Worker, without live rooms. |
| `authenticate(request, env)` | Read a bearer token from the `Authorization` header, or from a WebSocket sub-protocol. Return the actor and the role, or `null`. |
| `sniffImage(bytes)` | Find the image type from the first bytes, or return `null`. The client's claim of a type is not trusted. |
| `WS_PROTOCOL` | The sub-protocol name that carries a token on a WebSocket: `agentic-canvas.bearer`. |
| `WorkerEnv` (type), `AppOptions` (type), `Role` (type) | Types for the Worker bindings, the app options and the role, `editor` or `viewer`. |

### `agentic-canvas/live-worker`

| Name | What it is |
|---|---|
| `default` | The Worker with live rooms. Bind the `SyncRoom` class as `SYNC_ROOM`. |
| `SyncRoom` | The Durable Object class of the live rooms, re-exported from `agentic-realtime/worker`. |
| `LiveEnv` (type) | The Worker bindings, plus `SYNC_ROOM`. |

## Limits

- Canvas takes principal kinds, regions, and the Store and Blobs ports from `agentic-identity` 0.5.
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
