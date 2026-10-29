import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BRAND } from "./brand.js";
import { CanvasError, SHAPE_TYPES } from "./core/board.js";
import type { Principal } from "./core/principal.js";
import { svgToPng } from "./png.js";
import type { CanvasService } from "./service.js";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

// A CanvasError is safe to show. Anything else may hold a path or a stack, so the caller gets a fixed message.
function failure(error: unknown) {
  if (!(error instanceof CanvasError)) console.error(error instanceof Error ? error.message : String(error));
  const body = error instanceof CanvasError ? { code: error.code, message: error.message } : { code: "INTERNAL", message: "the board operation failed" };
  return { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify(body) }] };
}

function tool<A, R extends { content: unknown[] }>(run: (args: A) => Promise<R>) {
  return async (args: A) => {
    try {
      return await run(args);
    } catch (error) {
      return failure(error);
    }
  };
}

const board = z.string().describe("Board id.");
const num = z.number();

/**
 * The tools mirror the CLI. The actor is fixed here by the operator. No tool takes an actor,
 * author, or kind, so a caller cannot choose who it writes as.
 */
export function createMcpServer(service: CanvasService, actor: Principal): McpServer {
  const server = new McpServer({ name: BRAND.command, version: BRAND.version });
  const read = { readOnlyHint: true };

  server.registerTool(
    "create_board",
    { description: "Make a board.", inputSchema: { id: z.string().optional(), title: z.string().optional() } },
    tool(async (a) => json(await service.create(actor, a))),
  );
  server.registerTool(
    "read_board",
    { description: "Read a board as data: nodes, edges, groups, text, and who made what.", inputSchema: { board }, annotations: read },
    tool(async (a) => json(await service.read(a.board))),
  );
  server.registerTool(
    "add_shape",
    {
      description: "Add a shape. Image shapes need src.",
      inputSchema: {
        board,
        id: z.string().optional(),
        type: z.enum(SHAPE_TYPES),
        x: num,
        y: num,
        w: num.optional(),
        h: num.optional(),
        text: z.string().optional(),
        fill: z.string().optional(),
        stroke: z.string().optional(),
        src: z.string().optional(),
      },
    },
    tool(async ({ board: b, ...shape }) => json(await service.add(b, shape, actor))),
  );
  server.registerTool(
    "connect",
    { description: "Join two shapes with an arrow.", inputSchema: { board, from: z.string(), to: z.string(), id: z.string().optional(), text: z.string().optional() } },
    tool(async (a) => json(await service.connect(a.board, { id: a.id, from: { id: a.from }, to: { id: a.to }, text: a.text }, actor))),
  );
  server.registerTool(
    "move",
    { description: "Move an element, or a whole group.", inputSchema: { board, element: z.string(), dx: num, dy: num } },
    tool(async (a) => json(await service.move(a.board, a.element, a.dx, a.dy, actor))),
  );
  server.registerTool(
    "remove",
    { description: "Delete an element. A shape takes its connectors, a group its members.", inputSchema: { board, element: z.string() }, annotations: { destructiveHint: true } },
    tool(async (a) => json(await service.remove(a.board, a.element))),
  );
  server.registerTool(
    "draw_flow",
    {
      description: 'Draw a flowchart from text, one statement per line: "A[Box] -> B{Choice}: label". [] box, () ellipse, {} diamond.',
      inputSchema: { board, text: z.string(), idPrefix: z.string().optional() },
    },
    tool(async (a) => json(await service.flow(a.board, a.text, actor, { idPrefix: a.idPrefix }))),
  );
  server.registerTool(
    "export_svg",
    { description: "Export the board as SVG text.", inputSchema: { board }, annotations: read },
    tool(async (a) => ({ content: [{ type: "text" as const, text: await service.exportSvg(a.board) }] })),
  );
  server.registerTool(
    "export_png",
    { description: "Export the board as a PNG image. Needs the optional playwright-core and a Chromium.", inputSchema: { board }, annotations: read },
    tool(async (a) => ({ content: [{ type: "image" as const, data: Buffer.from(await svgToPng(await service.exportSvg(a.board))).toString("base64"), mimeType: "image/png" }] })),
  );
  return server;
}

/** Serve the tools on stdin and stdout. Stdout carries protocol frames only. */
export async function runMcp(service: CanvasService, actor: Principal): Promise<void> {
  await createMcpServer(service, actor).connect(new StdioServerTransport());
}
