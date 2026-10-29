# Changelog

## Unreleased

- Add a web UI served by the Worker, built on `agentic-design`: board list, canvas view, select, move, resize,
  delete, pan, zoom, live presence, and a marker on agent items. The browser joins the live room with the token
  as a WebSocket sub-protocol (`agentic-canvas.bearer`), because a browser cannot set a header on a socket.
  Playwright E2E with axe checks run in `npm run ci:local`.
- Add `GET /boards` and `PATCH /boards/:id/elements/:element`, the client methods `listBoards` and `update`, the CLI
  commands `list` and `update`, and the MCP tools `list_boards` and `update_element`. They work on the local store
  and in a live room. A list shows the first 100 boards.

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
