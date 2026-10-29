# Changelog

## 0.11.0

**Added**

- Share links on every surface. The client has `links`, `createLink`, and `revokeLink`. The CLI has `links`, `link`, and `revoke-link`. The MCP server has `list_links`, `create_link`, and `revoke_link`. They need `CANVAS_SERVER` and `CANVAS_TOKEN`, as the other sharing commands do.
- `GET /boards/:id/links` lists the links of a board for an owner. A summary shows the id, role, sign-in option, expiry, and revoke time. It never shows the token. The list holds up to 200 links, and `truncated: true` says there are more, and `skipped` counts damaged records left out. Live links come first.

## 0.10.0

**Added**

- Sharing on every surface. The client has `access`, `grant`, `revoke`, and `invite`. The CLI has `access`, `grant`, `revoke`, and `invite`. The MCP server has `list_access`, `grant_access`, `revoke_access`, and `create_invite`. They call the HTTP API as the owner of the token, so they need `CANVAS_SERVER` and `CANVAS_TOKEN`. A local store has no owners: the CLI commands exit 2 there, and the tools fail with `UNAVAILABLE`.
- `parseSubject` and the sharing types in `agentic-canvas/client`.
- The CLI and MCP server show a `CanvasApiError` with the server's code.

**Changed**

- Depend on `agentic-identity` 0.8 (was 0.7).

## 0.9.0

**Breaking changes**

- BREAKING: design class prefix is now agd-. The UI reads the `--agd-*` tokens from `agentic-design` ^0.4.0. The old prefix matches EasyList cosmetic rules, so ad blockers hid design-styled controls. Migration: load `agentic-design/styles.css` from `agentic-design` ^0.4.0, and set your own tokens with the `--agd-` prefix.

## 0.8.0

**Added**

- Board sharing on the HTTP API, built on `agentic-identity`: roles (owner, editor, commenter, viewer), grant, revoke, list access, invite by email or handle, accept, and share links with an expiry and a sign-in option. A link token reads one board.

**Breaking changes**

- The local file store is the file store of `agentic-identity` (^0.7.0). A `canvas.json` from an earlier version is upgraded in place the first time a store opens it, and an earlier version cannot read the upgraded file. `lockTimeoutMs` and `staleAfterMs` are removed from `FileStoreOptions`. A lock older than 3 seconds is taken over.
- Every board route checks the caller's role on the board. A caller with no role gets 404. A board made before this change has no owner (see Limits in the README). The static dev list is not affected.
- `GET /boards` lists the boards the caller holds a role on.
- A new board is registered as an identity resource, with its maker as owner. Deleting a board removes its sharing records.

**Fixed**

- A board id, link id, invite id, or subject id that the Store refuses gets a 4xx error with a code, not a 500, on the role gate and the sharing routes.

**Changed**

- Depend on `agentic-design` 0.3 (was 0.2).

## 0.7.0

**Breaking changes**

- The Worker signs requests in with `agentic-identity` credentials in the Store by default. The principal's scopes set the role: `canvas:write` is an editor, `canvas:read` a viewer. A deploy that relied on `CANVAS_API_TOKENS` alone must issue `agentic-identity` credentials before it upgrades.
- `CANVAS_API_TOKENS` is a dev fallback. It is read only with `CANVAS_UNSAFE_STATIC_TOKENS=1`. A Worker that sets the list without the switch answers 503 `NOT_CONFIGURED` on every API request until you set the switch or remove the list.
- `authenticate(request, env)` from `agentic-canvas/worker` reads the static list only with `CANVAS_UNSAFE_STATIC_TOKENS=1`. Its new optional third argument is the Store.
- A write or a live socket that rides on the `session` cookie gets 401. A bearer credential is needed for writes.
- A Store that fails during sign-in answers 503 or 500, not 401, so a caller does not think its credential is wrong.

**Added**

- Delete a whole board for good: the `delete <board>` CLI command, the `delete_board` MCP tool, `deleteBoard(id)` in `agentic-canvas/client`, and `DELETE /boards/:id` in the Worker. The Worker also erases the board's live room. The SDK's `LiveService` has `delete(id)`.

**Changed**

- Depend on `agentic-realtime` 0.4 (was 0.3).
- The sticky note colors come from `agentic-design` tokens, so they follow the theme. The board styles hold no hex color.
- The README "Auth" section describes the identity credentials and the dev fallback.

## 0.6.1

**Changed**

- `principalSchema` and every new SDK write use the identity kernel rule for an actor id: 1 to 128 characters of letters, digits, `.`, `_` and `-`. An id of 129 to 200 characters, or with a space or other character, now fails with `INVALID`. Boards that hold older ids still read.

**Added**

- Tests for the `/boards/:id/ws` handshake (101 and 401), the 512-character token limit, the token charset, and the 128-character actor id limit.

## 0.6.0

**Changed**

- `authenticate(request, env)` returns a promise. It now uses the `agentic-identity/http` helpers.
- The WebSocket token sub-protocol is now `agentic-canvas` plus `agentic-canvas.bearer.<token in base64url>`. `WS_PROTOCOL` is `agentic-canvas`. The bundled UI sends the new form.
- A bearer token may hold only letters, digits, `_` and `-`, and at most 512 characters.
- An actor id (`CANVAS_ACTOR`, a token grant) must match the identity kernel rule: letters, digits, `.`, `_`, `-`, at most 128 characters.

## 0.5.0

No breaking changes.

**Added**

- Export `agentic-canvas/ui`. `mount(element, options)` renders the board UI into any element, with no framework. It returns `update` and `unmount`. `BoardEditor` is the same view as a React component. Import `agentic-canvas/ui.css` for the styles. The live room is an option, so an embed runs without one.
- The npm package now includes the board UI, built at publish time. Version 0.4.0 did not include it.
- Document every export of each entry point in the README, with an `agentic-canvas/ui` entry.

**Changed**

- The Worker page renders the same `BoardEditor` that the embed uses.
- The `./ui` entry shares no code with `dist/client.js`, so a client-only import does not load the UI.
- The board styles are scoped under `.cv-root`, so they do not change the rest of a host page.

## 0.4.0

**Breaking changes**

- A live client needs a Worker of 0.4.0. The client no longer seeds a room. The Worker seeds the room from the stored board when a client connects. An older Worker does not seed it, so a new client joins an empty room. The Worker refuses a live join when it cannot seed the room, usually with `UNAVAILABLE`.
- The Worker refuses the token actor `canvas-room` of kind `agent`. The Worker uses this actor to seed rooms. The Worker refuses a token that names it.
- The Worker stamps authors on save. A save takes the author of a new element, the last editor of a changed one, and the title author from the room's log of who sent each update. The save corrects a wrong stamp and reports the element in `fixed`. The save deletes an element, or undoes a change, that it cannot name a writer for. A raw Yjs client cannot claim another principal or a person.
- Depend on `agentic-realtime` 0.3 (was 0.1) and `agentic-identity` 0.5 (was 0.4).

**Added**

- Add a web UI served by the Worker, built on `agentic-design`: board list, canvas view, select, move, resize,
  delete, pan, zoom, live presence, and a marker on agent items. The browser joins the live room with the token
  as a WebSocket sub-protocol (`agentic-canvas.bearer`), because a browser cannot set a header on a socket.
  Playwright E2E with axe checks run in `npm run ci:local`. The UI is built from source with `npm run build`. The npm package does not include it.
- Add a demo Worker config (`wrangler.demo.jsonc`) and the `deploy:demo` script, with a Live demo section in the README.
- Add `GET /boards` and `PATCH /boards/:id/elements/:element`, the client methods `listBoards` and `update`, the CLI
  commands `list` and `update`, and the MCP tools `list_boards` and `update_element`. They work on the local store
  and in a live room. A list shows the first 100 boards.

**Changed**

- Save a live room back to the Store in the Worker. A raw WebSocket client needs no seed or checkpoint call, and room
  edits reach the Store before the next board read or write.
- A hand save (`POST /boards/:id/checkpoint`) puts the part of the posted update that the room lacks into the room, so
  every peer gets it. It stamps that content with its poster. It fails with `FORBIDDEN` when the update uses a client id
  that the room holds for another principal, and with `UNAVAILABLE` when the room has no log or cannot be saved.
- Publish to `npm.ants.land` as well as npm. The publish step writes its auth line with `printf`.

## 0.3.0

- Add a typed remote client for the Worker API (`agentic-canvas/client`). `createClient({ baseUrl, token, fetch? })`
  has one method per route. A failed call throws `CanvasApiError` with the API `code` and the HTTP `status`.
  Every call takes an `AbortSignal`. The client uses only `fetch` and never retries.
- Run the publish workflow on Node 22 and stop `wrangler dev` cleanly in the tests.

## 0.2.0

- Add live co-editing. A room holds one board. A client saves the room back to the
  stored board, and the save checks authors and board size.
- Add a live client to the SDK (`agentic-canvas/live`).
- Join live rooms from the CLI and the MCP server with `CANVAS_SERVER` and `CANVAS_TOKEN`.
- Move to `agentic-identity` 0.4, which is a breaking release for grants. Canvas does not
  use the sharing API yet, so no canvas code changed.

## 0.1.0

- First release: the board model, the agent operations, SVG export, the CLI, the MCP
  server, and the Worker API.
