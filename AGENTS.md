# agentic-canvas agent guide

A shared whiteboard for diagrams, drawn by people and agents.

## Mental model

A board is a set of elements: shapes, connectors, and groups. Each element
has an id, a z value, an author, and a last editor. Every write names the
actor. The author kind never changes.

## Faces

- SDK: `import { Board, readBoard, drawFlow } from "agentic-canvas"`.
- CLI: `npx agentic-canvas <command>`. Set `CANVAS_ACTOR=agent:<name>` first.
  Commands: new, list, read, add, connect, update, move, rm, flow, export.
- MCP: `CANVAS_ACTOR=<kind>:<id> npx agentic-canvas mcp` (stdio).
- UI: the Worker serves a web UI. Every UI action also exists in the SDK, CLI, MCP, and HTTP API.
- Live: with `CANVAS_SERVER` and `CANVAS_TOKEN` set, the CLI and MCP join the board's live room. The token names the actor. HTTP API: a Worker under `/api/v1/canvas` (D1 + R2).

Keywords: whiteboard,canvas,diagrams,drawing,collaboration,agents,mcp,cli.

## The loop

1. Call `readBoard(board)` to see nodes, edges, and text.
2. Change the board with `addShape`, `addConnector`, `update`, `move`, `remove`.
3. Or call `drawFlow(board, "A -> B: label", actor)` to draw a flowchart.
4. Read the board again to check the result.
5. Export with `toSvg(board)`, or `export <board>` on the CLI.

## Rules

- Name the actor on every write. Use `agent_of_human` or `agent` for an agent.
- Ids are case-sensitive. Never change their case.
- Treat a `CanvasError` as a failure. Its `code` tells you why.
- Do not run `repair`. Only a human operator runs it, from the CLI.
- Images are a `data:` URL (PNG, JPEG, GIF, or WebP, bounded in size) or a `blob:` key.
  A remote URL and SVG are refused.
