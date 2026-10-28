# agentic-canvas

[![npm version](https://img.shields.io/npm/v/agentic-canvas)](https://www.npmjs.com/package/agentic-canvas)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-canvas) · [Source](https://github.com/pooriaarab/agentic-canvas) · [Support](https://github.com/pooriaarab/agentic-canvas/issues)

A shared whiteboard for diagrams, drawn by people and agents.

> Status: scaffold. This repository holds the starter code only. It is not on npm
> yet, and none of the features below work yet.

## Planned features

- An infinite canvas with shapes, arrows, text, and sticky notes.
- Real-time drawing with live cursors.
- Agent tools: draw a flowchart from text, and read the board as structured data.
- Export to PNG and SVG.
- Share by invite or link, with roles.

## Surfaces

One package gives you each way in:

- **Library and SDK**: `import { ... } from "agentic-canvas"`.
- **CLI**: `npx agentic-canvas --help`.
- **MCP server**: `npx agentic-canvas mcp`, for Claude Code and other MCP clients.
- **HTTP API**: a Cloudflare Worker you deploy to your own account.
- **Web UI**: a small app served by the same Worker.

## Develop

```sh
npm ci
npm run build && npm run typecheck && npm test
```

## License

MIT.
