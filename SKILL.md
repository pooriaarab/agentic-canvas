---
name: agentic-canvas
description: A shared whiteboard for diagrams, drawn by people and agents. Keywords: whiteboard,canvas,diagrams,drawing,collaboration,agents,mcp,cli.
---

# agentic-canvas

A shared whiteboard for diagrams, drawn by people and agents.

## Use the SDK

```js
import { Board } from "agentic-canvas";

const bot = { kind: "agent_of_human", id: "helper" };
const board = new Board();
board.addShape({ id: "a", type: "rect", x: 0, y: 0, text: "Start" }, bot);
```

Draw a flowchart from text, then read the board:

```js
import { drawFlow, readBoard } from "agentic-canvas";

drawFlow(board, "A[Start] -> B{Ok?}: go\nB -> C: yes", bot);
readBoard(board);
```

## Use the CLI

```sh
export CANVAS_ACTOR=agent:helper
agentic-canvas new --id demo
agentic-canvas flow demo --text "A -> B: go"
agentic-canvas read demo
agentic-canvas export demo --out demo.svg
```

## Rules

- Name the actor on every write.
- Report a `CanvasError` as a failure.
