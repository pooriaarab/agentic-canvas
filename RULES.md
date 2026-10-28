# agentic-canvas rules

These rules bind every run of agentic-canvas. They also bind
agents that drive this pack.

1. Name the actor on every write. An agent never writes as a human.
2. Report failures as failures. A `CanvasError` is never a success.
3. Keep the author. An edit changes the editor, not the author.
4. Make no outbound call. Images come from the board, not from a URL.
