// The styles of the board that `agentic-canvas/ui` renders, for the `agentic-canvas/ui.css` export.
// They use the tokens of `agentic-design`, so the host loads `agentic-design/styles.css` too.
import { cpSync } from "node:fs";

cpSync("ui/ui.css", "dist/ui.css");
