# agentic-canvas

[![npm version](https://img.shields.io/npm/v/agentic-canvas)](https://www.npmjs.com/package/agentic-canvas)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-canvas) · [Source](https://github.com/pooriaarab/agentic-canvas) · [Support](https://github.com/pooriaarab/agentic-canvas/issues)

A shared whiteboard for diagrams, drawn by people and agents.

> Status: 0.12.0. The board model, the agent operations, the exports, the CLI, the
> MCP server, a small Worker API, and live co-editing work. The CLI, the MCP server,
> and the SDK can join a live room. A remote client calls the Worker API. A small web UI, served by the Worker, is new in 0.4.0.
> The package exports `agentic-canvas/ui`, a board view you can mount in your own app, new in 0.5.0.

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

Other commands: `list`, `add`, `connect`, `update`, `move`, `rm`, `delete` (a whole board), and `access`, `grant`, `revoke`, `invite` (sharing, server only). Run `npx agentic-canvas --help`.
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
`delete_board`, `list_boards`, `read_board`, `add_shape`, `connect`, `update_element`, `move`, `remove`, `draw_flow`, `export_svg`, `export_png`, and the sharing tools `list_access`, `grant_access`, `revoke_access`, and `create_invite`. `repair` is not a tool. Only a human operator runs it, from the CLI. The server will not start unless `CANVAS_ACTOR` is set to a valid
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

There is one method per route: `me`, `listBoards`, `createBoard`, `readBoard`, `deleteBoard`, `exportSvg`, `addShape`, `addConnector`,
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
npx wrangler secret put CANVAS_API_TOKENS -c wrangler.demo.jsonc   # only to set or rotate the demo tokens
```

`wrangler.demo.jsonc` holds the config. The demo is a throwaway: it turns on the dev fallback (see "Auth") and
signs in with a static token list. The tokens are a Worker secret and are not in the repo. To run your
own copy, create a D1 database and an R2 bucket (both in the EU), put their names and id in a copy of that
file, and deploy it the same way. Remove `CANVAS_UNSAFE_STATIC_TOKENS` from your copy unless it is a throwaway.

## Auth

The Worker signs requests in with `agentic-identity` (`agentic-identity/http`). A bearer key (an `api_key` or
`pat` credential) is a credential in the same Store as the boards (D1). A `session` credential works as a
bearer key too, and as the `session` cookie for reads. A write or a socket that rides on the cookie gets 401,
because the Worker lists no allowed origins. A credential names a principal, and the principal's scopes set the role:

- Any scope that covers `canvas:write`, such as `canvas:write`, `canvas:admin`, `*:write`, or `*:admin`, is an editor.
- Any scope that covers `canvas:read`, such as `canvas:read` or `*:read`, is a viewer. A viewer reads and cannot change a board, over HTTP or in a live room.
- A principal with neither scope, an unknown, expired, or revoked credential, or a revoked parent in the
  delegation chain, gets 401.

Make principals and credentials in the database of this Worker with `agentic-identity` (its Worker, or
`issueCredential` from its SDK). The two must share one D1 database and its schema (`D1_SCHEMA`). A credential
that lives in another database gets 401 here. The author kind of every write is the kind of the principal.
A browser sends its credential as the WebSocket sub-protocol `agentic-canvas.bearer.<token in base64url>`.

**Dev fallback.** `CANVAS_API_TOKENS` is a static list of tokens, as JSON: `{ "<token>": { "actor": "ada", "kind": "human", "role": "viewer" } }`.
It is read only when `CANVAS_UNSAFE_STATIC_TOKENS=1` is set too. Then it adds to the identity credentials: a
token that is not a credential is looked up in the list. A static token reaches every board and cannot be
revoked without a new deploy. It ignores revocation in the Store: a static grant named `ada` still writes as
`ada` after the identity credential of `ada` is revoked. Use it for local work and throwaway demos only. If `CANVAS_API_TOKENS` is set
and the switch is not, every API request gets 503 `NOT_CONFIGURED`, so a deploy never trusts the list by accident.

## Sharing

A board is an `agentic-identity` resource of type `canvas`. The person or agent that makes a board owns it.
Roles, from least to most: `viewer`, `commenter`, `editor`, `owner`.

| Role | May do |
|---|---|
| viewer, commenter | Read the board, its SVG, and join its live room to read. A board has no comments yet, so a commenter reads as a viewer. |
| editor | Also draw: add, update, move, and remove elements. |
| owner | Also delete the board, grant and revoke roles, list access, invite, and make or revoke share links. |

A role never exceeds the scopes of the credential. An agent of an owner holds the owner's role only inside its own
scopes: it needs `canvas:admin` to share, and `canvas:write` to draw. A caller with no role on a board gets 404, so a read or a write tells a stranger nothing. (A create with an id that is taken answers 409.) A caller with a role that is too low gets 403. `GET /boards` lists the boards you hold a role on.

HTTP routes, under `/api/v1/canvas`. Each needs a bearer token, except the link read:

| Route | Does |
|---|---|
| `GET /boards/:id/access` | Owner. The grants and the invites. An invite shows no email. |
| `POST /boards/:id/grants` | Owner. Body `{ subjectKind: "human" or "agent", subjectId, role }`. |
| `DELETE /boards/:id/grants?subjectKind=&subjectId=` | Owner. Revoke. The last owner cannot be removed. |
| `POST /boards/:id/invites` | Owner. Body `{ role, email }` or `{ role, handle }`, and optional `expiresInMs`. The role is not `owner`. Returns `{ id }`. |
| `POST /invites/accept` | Body `{ id }`. The caller must be the person (verified email) or the agent (handle) the invite names. |
| `POST /boards/:id/links` | Owner. Body `{ role, signedInOnly?, expiresInMs? }`. Returns `{ id, token }`. The token shows once. |
| `DELETE /boards/:id/links/:link` | Owner. Revoke a link of this board. |
| `GET /shared/:id` and `GET /shared/:id/svg` | No bearer token needed. Send the link token in `x-link-token`. Read only. |

### Share from the client, the CLI, and MCP

Sharing lives on the server, so these need a Worker and a token with `canvas:admin` that owns the board.
A local store has no owners: the CLI commands exit 2 there, and the MCP tools fail with `UNAVAILABLE`.

```ts
const canvas = createClient({ baseUrl, token });
await canvas.grant("demo", { subjectKind: "agent", subjectId: "helper", role: "editor" });
await canvas.invite("demo", { role: "viewer", email: "ada@example.com", expiresInMs: 86_400_000 });
const { grants, invites } = await canvas.access("demo"); // an invite shows no email
await canvas.revoke("demo", { subjectKind: "agent", subjectId: "helper" });
```

```sh
export CANVAS_SERVER=https://canvas.example.com CANVAS_TOKEN=...
npx agentic-canvas access demo
npx agentic-canvas grant demo agent:helper --role editor
npx agentic-canvas invite demo --role viewer --handle helper --expires-in-ms 86400000
npx agentic-canvas revoke demo agent:helper
```

With `CANVAS_SERVER` set, `npx agentic-canvas mcp` serves `list_access`, `grant_access`, `revoke_access`, and `create_invite` as well.
Each prints or returns the server's JSON. A refusal has the server's code, such as `NOT_FOUND`, `FORBIDDEN`, or `INVALID`.
Share links and invite acceptance stay on the HTTP API.

A live MCP server with an admin token can share boards: an agent that holds it can grant `owner` and revoke grants. Give an agent a token with `canvas:write` only, unless it must share.

The static dev fallback holds no board roles. Its tokens reach every board and cannot share.

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
CANVAS_UNSAFE_STATIC_TOKENS=1
CANVAS_API_TOKENS={"ada-token-0123456789-0123456789-0123456789":{"actor":"ada","kind":"human"}}
EOF2
WRANGLER_SEND_METRICS=false npx wrangler dev
```

`CANVAS_UNSAFE_STATIC_TOKENS=1` turns on the dev fallback: see "Auth". Open the address that wrangler prints and paste the token. A static token has 32 characters or more. Its
grant sets the name, the kind (a person or an agent), and the role. A `viewer` token reads and
cannot change a board. The token stays in the tab's session storage.

What it does:

- Lists boards, makes a board, and opens one. Empty, loading, and error states have a retry.
- Draws shapes, connectors, text, and sticky notes. Select, move, resize, connect, and delete an
  item. Pan by dragging the background, zoom with the wheel or the zoom controls on the canvas.
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

### Mount the board in your app

`agentic-canvas/ui` renders the same board UI into any element. It needs no framework in your app.
React and react-dom (version 19 or later) are peer dependencies. The Worker's own page uses this code.

```ts
import "agentic-design/styles.css";   // tokens and fonts
import "agentic-canvas/ui.css";       // the board styles
import { createClient } from "agentic-canvas/client";
import { mount } from "agentic-canvas/ui";

const baseUrl = "https://canvas.example.com/api/v1/canvas";
const token = "...";
const board = mount(document.getElementById("board")!, {
  boardId: "b1",
  client: createClient({ baseUrl, token }),
  principal: { kind: "human", name: "Ada", role: "editor" },
  readOnly: false,
  room: { baseUrl, token },           // optional: shows who else is in the board
});

board.update({ /* same options, for another board */ });
board.unmount();                      // leaves the room and stops the refresh timer
```

The principal needs a known `kind` and a `name`. `mount` throws a `TypeError` without them. Only the
role `editor` can change the board, and `readOnly: true` opens it read only for an editor too. The
server still checks every write against the token. The host page owns the theme. `ui.css` uses CSS nesting under `.cv-root`, so it does not change the rest of your page. It needs a browser from 2023 or later.
For a React app, `BoardEditor` is the same component without a root. Wrap it in the providers of
`agentic-design/react`.

### Use your own Yjs document

An app that keeps the board in its own Yjs room gives it as `host`. The UI then reads and writes that document as a
board (its `elements` and `meta` maps, the shape this package stores) and redraws as soon as the document changes.
It makes no HTTP call, does not poll, and opens no live room. `client` is not needed. The default is still client
mode: without `host`, the UI works as described above.

```ts
const board = mount(element, {
  boardId: "b1",
  principal: { kind: "human", name: "Ada", id: "ada", role: "editor" }, // id is stamped on what Ada writes; the default is name
  host: {
    doc,                       // a Y.Doc
    presence: sync,            // optional: a SyncClient of agentic-realtime, or { peers, onPeers }
    status: () => status,      // optional: "connecting" | "connected" | "disconnected"
    onStatus: (listener) => stop, // optional: tell the UI when the status changes
  },
});
```

- Use the same `yjs` copy as the UI. A document from another copy is refused with a `TypeError`.
- Each element the UI creates or edits is stamped with the principal's `id` and `kind`. A delete has no stamp. The `id` follows the identity rule of the
  SDK (letters, digits, `.`, `_`, `-`). An agent kind marks its elements as machine-made. A refused write shows a message
  and leaves the document alone. The server does not check these writes: your app and its room decide who may write.
- In host mode `boardId` only keys the view. The UI shows the one board that the document holds (its `elements` and `meta` maps), so keep one board in each document.
- A document pushed past the element cap (10,000) can no longer be read. If that happens after the first draw, the UI keeps the last board it drew. At mount it shows the error page with Retry. Your app should stop a peer from writing that far.
- `client` or `room` together with `host` throws a `TypeError`, so a board never half-writes to a server. (`BoardEditor` shows an alert for these, as it does for a bad principal.) Give presence in `host.presence`.
- The principal's `id` (default: `name`) must pass the identity rule, so a display name with a space needs an explicit `id`. A bad one throws a `TypeError` at mount.
- The UI redraws only for changes in the document's `elements` and `meta` maps. Other data in the same document is left alone.
- `status` and `onStatus` are read when the UI opens `doc`. A new function on `update()` does not open it again. `onStatus` alone starts as not live, until it reports "connected". With neither, the board shows as live. Give `onStatus` at mount to follow later changes. It is not picked up by a later `update()` for the same `doc`.
- With `presence`, the UI shows the peers. It never sends a cursor, and never closes your room or your document.
- On `unmount` the UI removes its observers from your document and leaves it as it is.

Develop and test the UI:

```sh
npm run build                      # UI and library
npx playwright-core install chromium
npm run test:e2e                   # Playwright against `wrangler dev`, with axe (WCAG 2.2 AA)
```

`E2E_PORT` sets the port of the E2E server (default 18900). The E2E run creates a board, adds a shape and a note, moves them, reloads, and checks each view
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
  (EU jurisdiction), through the shared `Store` and `Blobs` ports. Set `CANVAS_REGION`. Callers sign in with
  `agentic-identity` credentials (see "Auth" below). `CANVAS_API_TOKENS` is a dev fallback only.
  Routes: `POST /boards`, `GET /boards/:id`, `DELETE /boards/:id`, `GET /boards/:id/svg`, `POST /boards/:id/shapes`,
  `/connectors`, `/flow`, `/move`, `GET /boards`, `PATCH /boards/:id/elements/:element`, `DELETE /boards/:id/elements/:element`, `POST /images`,
  `GET /images/:id`. An editor may delete a board. The Worker also erases its live room. An image is stored under the SHA-256 of its bytes, and the reply gives
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
| `PRINCIPAL_KINDS`, `PrincipalKind` (type), `Principal` (type), `principalSchema`, `isMachineMade` | The principal kinds, the schema of a principal, and the rule that marks machine-made kinds. `principalSchema` uses the identity rule below. |
| `operatorActor(env?)`, `ActorConfigError` | Read the actor from `CANVAS_ACTOR` as `<kind>:<id>`. It throws `ActorConfigError` when the value is missing or bad. |
| `CanvasService` | The board operations that the CLI, the MCP server and the Worker share. It takes a `Store`. |
| `createMcpServer(service, actor, sharing?)`, `runMcp(service, actor, sharing?)` | Make the MCP server, or run it on stdio. `sharing` is a client from `agentic-canvas/client`: it turns on the sharing tools. |
| `createFileStore`, `openLocalStore`, `FileStoreOptions` (type) | Stores on one local file. See `agentic-canvas/file-store`. |

### Actor ids

One rule names an actor in every new write, in the SDK, the CLI, the MCP server and the Worker. The kind must be
one of `PRINCIPAL_KINDS`. The id has 1 to 128 characters from `A-Z`, `a-z`, `0-9`, `.`, `_` and `-`, and starts
with a letter, digit, `_` or `-`. The rule comes from `parsePrincipal` in `agentic-identity`. A write with another
id fails with `INVALID`. A board that was stored with an older, looser id (up to 200 characters) still opens. The
old author stays on its elements. Only new writes follow the strict rule.

### `agentic-canvas/client`

| Name | What it is |
|---|---|
| `createClient(options)`, `CanvasApiError` | The remote client. See Remote client above. |
| `parseSubject(text)` | Reads `human:<id>` or `agent:<id>` as `{ subjectKind, subjectId }`. It throws a `TypeError` for any other text. |
| `BoardSharing` (type), `BoardRole` (type), `SubjectKind` (type), `Subject` (type), `BoardGrant` (type), `BoardInvite` (type), `InviteInput` (type) | Types for sharing. |
| `ClientOptions` (type), `CallOptions` (type), `CanvasClient` (type), `ShapeInput` (type), `ConnectorInput` (type), `ShapePatch` (type), `ConnectorPatch` (type), `ImageInfo` (type), `ApiErrorCode` (type) | Types for the client. `ApiErrorCode` adds the client's own codes, such as `NETWORK`, to `ErrorCode`. |

### `agentic-canvas/file-store`

| Name | What it is |
|---|---|
| `createFileStore(path, options?)`, `openLocalStore(dir)` | A store on one JSON file, or on `canvas.json` in a directory. It is the file store of agentic-identity. |
| `FileStoreError` | The error for a file that is not a store file, or a lock that stays held. Its `code` is `DAMAGED` or `LOCKED`. |
| `FileStoreOptions` (type) | The adapter options. The lock options `lockTimeoutMs` and `staleAfterMs` are gone. |
| `STORE_FILE` | The file name that `openLocalStore` uses, `canvas.json`. |

### `agentic-canvas/live`

| Name | What it is |
|---|---|
| `LiveBoard.join(options)` | Join one board's live room. Read the board, change it, `save` to the stored board, then `leave`. |
| `LiveService` | The CLI and MCP commands, run in a live room. A change joins the room, runs as the token's actor, saves, and leaves. `read` and `exportSvg` join and leave without a save. `create` and `list` call the HTTP API. |
| `whoAmI(server, token)`, `Me` (type) | Ask the Worker who a token is. It returns the actor and the role. |
| `LiveOptions` (type) | The server, the board id, the token, and the optional name and reconnect settings. |

### `agentic-canvas/ui`

| Name | What it is |
|---|---|
| `mount(element, options)` | Render the board UI into an element. It returns `update(options)` and `unmount()`. See Mount the board in your app. |
| `BoardEditor(options)` | The same board UI as a React component, without a root. |
| `BoardEditorOptions` (type), `BoardPrincipal` (type), `MountedBoard` (type) | Types for the options, the principal, and the object that `mount` returns. |
| `HostBoard` (type) | The `host` option: `doc`, and optionally `presence`, `status`, and `onStatus`. |
| `CanvasClient` (type), `RoomOptions` (type) | The client type, as in `agentic-canvas/client`, and the live room's base URL and token for the `room` option. |

The stylesheet is a separate export, `agentic-canvas/ui.css`. Load `agentic-design/styles.css` too, for the tokens.

### `agentic-canvas/worker`

| Name | What it is |
|---|---|
| `createApp(options?)` | Make the Hono app for the Worker. Pass `live` to turn on the live-room socket. |
| `default` | The Worker, without live rooms. |
| `authenticate(request, env)` | Read a bearer token from the `Authorization` header, or from a WebSocket sub-protocol. Return a promise of the actor and the role, or `null`. |
| `identify(request, env, store?)` | Like `authenticate`, with the whole caller: its actor, role, principal context, and whether the dev fallback signed it in. Return a promise of the caller, or `null`. |
| `sniffImage(bytes)` | Find the image type from the first bytes, or return `null`. The client's claim of a type is not trusted. |
| `WS_PROTOCOL` | The sub-protocol name for a WebSocket: `agentic-canvas`. The token travels in the entry `agentic-canvas.bearer.<token in base64url>`. |
| `WorkerEnv` (type), `AppOptions` (type), `Role` (type), `Caller` (type) | Types for the Worker bindings, the app options, the role, `editor` or `viewer`, and the caller that `identify` returns. |

### `agentic-canvas/live-worker`

| Name | What it is |
|---|---|
| `default` | The Worker with live rooms. Bind the `SyncRoom` class as `SYNC_ROOM`. |
| `SyncRoom` | The Durable Object class of the live rooms, re-exported from `agentic-realtime/worker`. |
| `LiveEnv` (type) | The Worker bindings, plus `SYNC_ROOM`. |

## Limits

- Canvas takes principal kinds, regions, and the Store and Blobs ports from `agentic-identity` 0.7.
- A board made before sharing has no owner. Identity credentials get 404 on it. Only the dev fallback reaches it. Make it again, or add its
  `canvas` resource and an owner grant with `agentic-identity`.
- An image is stored under the hash of its bytes, not under a board. Any credential with `canvas:read` can fetch an image if it knows the hash.
- A link visitor reads the stored board, which a live room saves at its next save. It cannot load `blob:` images.
- A revoke, or a grant of viewer or commenter, closes the live sockets of the person or agent whose role changed. An agent that acts for that person keeps its socket until it joins again.
- A link visitor reads. A link never writes. Links are not listed: the token shows once, at creation.
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
- The store is one file, `canvas.json`, in the store folder. It is the file store of
  agentic-identity: a write takes `canvas.json.lock`, and a lock older than 3 seconds is taken
  over, so a writer that is paused for longer can lose its lock and the write then fails with
  `UNAVAILABLE`. A write that clashes with another process is run again, for up to 10 seconds.
  Remove the lock by hand if no process runs. A file written by an older agentic-canvas is
  upgraded in place the first time a store opens it, and an older agentic-canvas cannot read
  the upgraded file. Stop older agentic-canvas processes before you upgrade.
- Node 22 or newer is needed. `agentic-canvas/file-store` exports `createFileStore(path)` and
  `openLocalStore(dir)`.
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
