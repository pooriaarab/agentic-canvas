---
name: agentic-canvas
description: A shared whiteboard for diagrams, drawn by people and agents. Keywords: whiteboard,canvas,diagrams,drawing,collaboration,agents,mcp,cli.
---

# agentic-canvas

A shared whiteboard for diagrams, drawn by people and agents.

## Use the SDK

```js
import { summarizeText, dispatchText } from "agentic-canvas";

summarizeText("some text");
await dispatchText("some text", { dryRun: true });
```

## Use the CLI

```sh
agentic-canvas summary --text "some text"
agentic-canvas dispatch --text "some text" --dry-run
```

## Use the MCP server

Start the server with `agentic-canvas mcp`. Call `summarize_text`
for stats, `dispatch_text` for routes, `get_cost_report` for costs.

## Rules

- Preview each route with dry run first.
- Report guard denials and adapter errors as failures.
- Read the cost report at the end.
