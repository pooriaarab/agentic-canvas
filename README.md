# agentic-canvas

[![npm version](https://img.shields.io/npm/v/agentic-canvas)](https://www.npmjs.com/package/agentic-canvas)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-canvas) · [Source](https://github.com/pooriaarab/agentic-canvas) · [Support](https://github.com/pooriaarab/agentic-canvas/issues)

A shared whiteboard for diagrams, drawn by people and agents.

> Status: early. The board model, the agent operations, and the CLI work. It is
> not on npm yet. The exporters, the MCP server, the HTTP API, and the web UI are
> not built yet.

## Install

Not on npm yet. Build from source:

```sh
npm ci
npm run build
```

## Quick start

```sh
export CANVAS_ACTOR=agent:helper          # who writes: <kind>:<id>
npx agentic-canvas new --id demo --title "Release flow"
npx agentic-canvas flow demo --text $'direction LR\nCode(Write code) -> Test{Tests pass?}: push\nTest -> Ship[Ship it]: yes'
npx agentic-canvas read demo              # nodes, edges, text as JSON
```

Other commands: `add`, `connect`, `move`, `rm`. Run `npx agentic-canvas --help`.
Boards live in `./.agentic-canvas` (or `--dir`, or `CANVAS_DIR`). Every write
needs an actor: `--actor` or `CANVAS_ACTOR`. The CLI has no default actor.

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
- A CLI over a local file store. Several processes can write at once.
- Yjs underneath: two copies of a board merge without conflicts.
- No UI code. The model runs in Node and in a Worker.

## Limits

- A board holds at most 10,000 elements. A flow holds at most 500 nodes and 2,000
  edges.
- Flow text has no chains (`A -> B -> C`). Write one edge per line.
- `readBoard` leaves out embedded image bytes.
- Images hold a `data:` PNG, JPEG, GIF, or WebP, or a `blob:` key. Remote URLs and
  SVG are refused.
- Two peers that make the same explicit id at the same time keep only one element, with no
  error. Explicit ids are safe with one writer. Leave `id` empty and the board picks a random one.
- A synced update is untrusted. An element that fails the write rules is hidden, and `repair()`
  deletes it. A board past the element cap refuses to load or read.
- `update` cannot clear a required field. Only `fill` and `stroke` accept `undefined`.
- Delete against connect can leave a connector with a missing end. Readers hide it. `repair()`
  removes it, and `Board.decode` runs `repair()` for you.
- `move` writes absolute positions. Two peers that move one shape at the same time do not add up:
  the last writer wins.
- Frames are plain shapes. They do not own the shapes inside them yet.
- Delete leaves no audit record yet. The caller logs it.

## License

MIT.
