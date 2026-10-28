# agentic-canvas agent guide

A shared whiteboard for diagrams, drawn by people and agents.

## Mental model

A board is a set of elements: shapes, connectors, and groups. Each element
has an id, a z value, an author, and a last editor. Every write names the
actor. The author kind never changes.

## Faces

- SDK: `import { Board } from "agentic-canvas"`.
- CLI and MCP: not built yet.

Keywords: whiteboard,canvas,diagrams,drawing,collaboration,agents,mcp,cli.

## Rules

- Name the actor on every write. Use `agent_of_human` or `agent` for an agent.
- Ids are case-sensitive. Never change their case.
- Treat a `CanvasError` as a failure. Its `code` tells you why.
- Never place a remote image URL on a board. Use a `blob:` key.
