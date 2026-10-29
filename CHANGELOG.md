# Changelog

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
