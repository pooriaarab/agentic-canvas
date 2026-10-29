import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BRAND } from "./brand.js";
import type { BoardSharing } from "./client.js";
import { CanvasError, SHAPE_TYPES } from "./core/board.js";
import type { Principal } from "./core/principal.js";
import { svgToPng } from "./png.js";
import type { BoardAccess } from "./service.js";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

// The client bundle has its own CanvasApiError class, so an `instanceof` check would miss one from `agentic-canvas/client`.
const isApiError = (error: unknown): error is Error & { code: string } =>
  error instanceof Error && error.name === "CanvasApiError" && typeof (error as { code?: unknown }).code === "string";

// A CanvasError or a CanvasApiError is safe to show. Anything else may hold a path or a stack, so the caller gets a fixed message.
function failure(error: unknown) {
  const safe = error instanceof CanvasError || isApiError(error);
  if (!safe) console.error(error instanceof Error ? error.message : String(error));
  const body = safe ? { code: error.code, message: error.message } : { code: "INTERNAL", message: "the board operation failed" };
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
 * author, or kind, so a caller cannot choose who it writes as. The sharing tools run on a server, as the owner of its token:
 * with no `sharing` client they fail with UNAVAILABLE.
 */
export function createMcpServer(service: BoardAccess, actor: Principal, sharing?: BoardSharing): McpServer {
  const server = new McpServer({ name: BRAND.command, version: BRAND.version });
  const read = { readOnlyHint: true };

  server.registerTool(
    "create_board",
    { description: "Make a board.", inputSchema: { id: z.string().optional(), title: z.string().optional() } },
    tool(async (a) => json(await service.create(actor, a))),
  );
  server.registerTool(
    "list_boards",
    { description: "List the first 100 boards with their titles.", inputSchema: {}, annotations: read },
    tool(async () => json({ boards: await service.list() })),
  );
  server.registerTool(
    "read_board",
    { description: "Read a board as data: nodes, edges, groups, text, and who made what.", inputSchema: { board }, annotations: read },
    tool(async (a) => json(await service.read(a.board))),
  );
  server.registerTool(
    "delete_board",
    { description: "Delete a whole board for good. It cannot be undone.", inputSchema: { board }, annotations: { destructiveHint: true } },
    tool(async (a) => json(await service.delete(a.board))),
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
    "update_element",
    {
      description: "Change fields of a shape (x, y, w, h, text, fill, stroke) or a connector. Resize with w and h.",
      inputSchema: { board, element: z.string(), x: num.optional(), y: num.optional(), w: num.optional(), h: num.optional(), text: z.string().optional(), fill: z.string().optional(), stroke: z.string().optional() },
    },
    tool(async ({ board: b, element, ...patch }) => json(await service.update(b, element, patch, actor))),
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

  const shared = (): BoardSharing => {
    if (!sharing) throw new CanvasError("UNAVAILABLE", "sharing needs a server: set CANVAS_SERVER and CANVAS_TOKEN");
    return sharing;
  };
  const kind = z.enum(["human", "agent"]).describe("human or agent. A person and an agent can share one id, and hold separate roles.");
  server.registerTool(
    "list_access",
    { description: "List the grants and the open invites of a board. Needs the owner role.", inputSchema: { board }, annotations: read },
    tool(async (a) => json(await shared().access(a.board))),
  );
  server.registerTool(
    "grant_access",
    { description: "Give a person or an agent a role on a board. A lower role replaces a higher one. Needs the owner role.", inputSchema: { board, subjectKind: kind, subjectId: z.string(), role: z.enum(["viewer", "commenter", "editor", "owner"]) }, annotations: { destructiveHint: true } },
    tool(async ({ board: b, ...input }) => json(await shared().grant(b, input))),
  );
  server.registerTool(
    "revoke_access",
    { description: "Take a role back from a person or an agent. The last owner cannot be removed. Needs the owner role.", inputSchema: { board, subjectKind: kind, subjectId: z.string() }, annotations: { destructiveHint: true } },
    tool(async ({ board: b, ...input }) => json(await shared().revoke(b, input))),
  );
  server.registerTool(
    "create_invite",
    {
      description: "Invite a person by email or an agent by handle to a board. Give email or handle, not both. The role is not owner. Needs the owner role.",
      inputSchema: { board, role: z.enum(["viewer", "commenter", "editor"]), email: z.string().optional(), handle: z.string().optional(), expiresInMs: z.number().optional() },
    },
    tool(async ({ board: b, ...input }) => json(await shared().invite(b, input))),
  );
  server.registerTool(
    "list_links",
    { description: "List the share links of a board, without their tokens. Needs the owner role.", inputSchema: { board }, annotations: read },
    tool(async (a) => json(await shared().links(a.board))),
  );
  server.registerTool(
    "create_link",
    {
      description: "Make a share link. Anyone with the token can read the board, and only read: the role does not widen a link visit. With signedInOnly, only a signed-in visitor may use it. The token shows once: keep it. The role is not owner. Needs the owner role.",
      inputSchema: { board, role: z.enum(["viewer", "commenter", "editor"]), signedInOnly: z.boolean().optional(), expiresInMs: z.number().int().positive().optional() },
    },
    tool(async ({ board: b, ...input }) => json(await shared().createLink(b, input))),
  );
  server.registerTool(
    "revoke_link",
    { description: "Revoke a share link of a board. Needs the owner role.", inputSchema: { board, link: z.string() }, annotations: { destructiveHint: true } },
    tool(async (a) => json(await shared().revokeLink(a.board, a.link))),
  );
  return server;
}

/** Serve the tools on stdin and stdout. Stdout carries protocol frames only. */
export async function runMcp(service: BoardAccess, actor: Principal, sharing?: BoardSharing): Promise<void> {
  await createMcpServer(service, actor, sharing).connect(new StdioServerTransport());
}
