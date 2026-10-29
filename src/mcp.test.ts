// End-to-end tests. They start the built binary (dist/cli.js mcp) as a real
// process and talk to it over stdio with the MCP client. `npm run ci:local`
// builds first.
//
// Failure-mode list. These were written before the server.
//  1. CANVAS_ACTOR unset, empty, blank, or bad: the server exits 2 before it
//     reads a byte, and prints nothing on stdout.
//  2. A tool call carries an actor, author, or kind argument: it is ignored.
//     The operator's actor stamps the work, never the caller's.
//  3. The operator runs as human: work reads back as human, not machine-made.
//  4. Unknown board, bad input, duplicate board: a tool error with a code and
//     no stack trace. The server stays up for the next call.
//  5. Every CLI write has a tool: create, add, connect, move, remove, flow.
//     Every read has one: read, export svg, export png.
//  6. Stdout carries only protocol frames, so a log line cannot break a client.
//  7. Two server processes on one store lose no write.
//  8. A tool call with a wrong argument type is refused by the schema.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { STORE_FILE } from "./store-file.js";

const BIN = join(process.cwd(), "dist", "cli.js");
const root = mkdtempSync(join(tmpdir(), "canvas-mcp-"));
let n = 0;
const fresh = () => join(root, `store${n++}`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function connect(dir: string, actor = "agent:bot"): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, "--dir", dir, "mcp"], env: { CANVAS_ACTOR: actor }, stderr: "pipe" });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text?: string; data?: string; mimeType?: string }[] };
  const first = result.content[0];
  return { error: result.isError === true, content: result.content, value: first.type === "text" && /^[{[]/.test(first.text!) ? JSON.parse(first.text!) : undefined };
}

function start(dir: string, env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, "--dir", dir, "mcp"], { env: { PATH: process.env.PATH ?? "", ...env } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
    child.stdin.end();
  });
}

describe("start", () => {
  test.each([
    ["unset", {}],
    ["empty", { CANVAS_ACTOR: "" }],
    ["blank", { CANVAS_ACTOR: "  " }],
    ["no colon", { CANVAS_ACTOR: "agent" }],
    ["unknown kind", { CANVAS_ACTOR: "robot:x" }],
    ["empty id", { CANVAS_ACTOR: "agent:" }],
  ])("CANVAS_ACTOR %s: exit 2, nothing on stdout", async (_name, env) => {
    const dir = fresh();
    const r = await start(dir, env);
    expect([r.code, r.out]).toEqual([2, ""]);
    expect(r.err).toContain("CANVAS_ACTOR");
    expect(r.err).not.toMatch(/\n\s+at /);
  });
});

describe("tools", () => {
  test("lists a tool for every CLI command and the exports", async () => {
    const client = await connect(fresh());
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    await client.close();
    expect(names).toEqual(["add_shape", "connect", "create_board", "draw_flow", "export_png", "export_svg", "move", "read_board", "remove"]);
  });

  test("round trip: create, add, connect, flow, move, remove, read, export", async () => {
    const client = await connect(fresh());
    try {
      expect((await call(client, "create_board", { id: "b", title: "Plan" })).value).toEqual({ id: "b", title: "Plan" });
      await call(client, "add_shape", { board: "b", id: "idea", type: "sticky", x: 0, y: 0, text: "Idea" });
      await call(client, "add_shape", { board: "b", id: "plan", type: "ellipse", x: 300, y: 0, text: "Plan" });
      const link = await call(client, "connect", { board: "b", from: "idea", to: "plan", text: "leads to" });
      expect(link.value).toMatchObject({ type: "connector", from: { id: "idea" }, to: { id: "plan" } });
      const flow = await call(client, "draw_flow", { board: "b", text: "S(Start) -> D{Ok?}: go\nD -> E[Done]: yes", idPrefix: "f-" });
      expect(flow.value.nodes).toEqual(["f-S", "f-D", "f-E"]);
      expect((await call(client, "move", { board: "b", element: "idea", dx: -5, dy: 6 })).value).toEqual({ moved: ["idea"] });
      expect((await call(client, "remove", { board: "b", element: "f-E" })).value.removed).toEqual(["f-E", "f-edge_2"]);
      const read = (await call(client, "read_board", { board: "b" })).value;
      expect(read.title).toBe("Plan");
      expect(read.nodes.map((s: { id: string }) => s.id)).toEqual(["idea", "plan", "f-S", "f-D"]);
      expect(read.nodes[0]).toMatchObject({ x: -5, y: 6, machineMade: true, author: { kind: "agent", id: "bot" } });
      const svg = await call(client, "export_svg", { board: "b" });
      expect(svg.content[0].text).toMatch(/^<svg /);
      expect(svg.content[0].text).toContain('data-machine-made="true"');
      const png = await call(client, "export_png", { board: "b" });
      expect(png.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
      expect([...Buffer.from(png.content[0].data!, "base64").subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    } finally {
      await client.close();
    }
  }, 60_000);

  test("an actor, author, or kind argument is ignored: the operator's actor stamps the work", async () => {
    const client = await connect(fresh(), "agent_of_human:helper");
    try {
      await call(client, "create_board", { id: "b", actor: "human:mallory", kind: "human" });
      await call(client, "add_shape", { board: "b", id: "a", type: "rect", x: 0, y: 0, actor: "human:mallory", kind: "human", author: { kind: "human", id: "mallory" } });
      const node = (await call(client, "read_board", { board: "b" })).value.nodes[0];
      expect(node.author).toEqual({ kind: "agent_of_human", id: "helper" });
      expect(node).toMatchObject({ machineMade: true, lastEditMachineMade: true });
    } finally {
      await client.close();
    }
  });

  test("a human operator labels the work human", async () => {
    const client = await connect(fresh(), "human:ada");
    try {
      await call(client, "create_board", { id: "b" });
      await call(client, "add_shape", { board: "b", id: "a", type: "rect", x: 0, y: 0 });
      expect((await call(client, "read_board", { board: "b" })).value.nodes[0]).toMatchObject({ author: { kind: "human", id: "ada" }, machineMade: false });
    } finally {
      await client.close();
    }
  });

  test("errors come back as tool errors with a code, and the server stays up", async () => {
    const client = await connect(fresh());
    try {
      const missing = await call(client, "read_board", { board: "nope" });
      expect([missing.error, missing.value.code]).toEqual([true, "NOT_FOUND"]);
      await call(client, "create_board", { id: "b" });
      expect((await call(client, "create_board", { id: "b" })).value.code).toBe("DUPLICATE_ID");
      expect((await call(client, "add_shape", { board: "b", type: "rect", x: 0, y: 0, fill: 'red" onload="x' })).value.code).toBe("INVALID");
      expect((await call(client, "connect", { board: "b", from: "x", to: "y" })).value.code).toBe("BAD_REFERENCE");
      expect((await call(client, "draw_flow", { board: "b", text: "A => B" })).value.code).toBe("INVALID");
      expect((await call(client, "read_board", { board: "../escape" })).error).toBe(true);
      const bad = JSON.stringify((await call(client, "read_board", { board: "nope" })).value);
      expect(bad).not.toMatch(/\n\s+at |node_modules|\/work\//);
      expect((await call(client, "read_board", { board: "b" })).error).toBe(false);
    } finally {
      await client.close();
    }
  });

  test("a wrong argument type is refused by the schema", async () => {
    const client = await connect(fresh());
    try {
      await call(client, "create_board", { id: "b" });
      for (const [name, args] of [
        ["move", { board: "b", element: "a", dx: "left", dy: 0 }],
        ["add_shape", { board: "b", type: "rect", x: 0 }],
        ["add_shape", { board: "b", type: "blob", x: 0, y: 0 }],
      ] as const) {
        const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
        expect(r.isError).toBe(true);
        expect(r.content[0].text).not.toMatch(/\n\s+at /);
      }
      expect((await call(client, "read_board", { board: "b" })).value.nodes).toEqual([]);
    } finally {
      await client.close();
    }
  });

  test("a damaged stored file is a clean tool error", async () => {
    const dir = fresh();
    const client = await connect(dir);
    try {
      await call(client, "create_board", { id: "b" });
      writeFileSync(join(dir, STORE_FILE), "{not json");
      const r = await call(client, "read_board", { board: "b" });
      expect(r.error).toBe(true);
      expect(JSON.stringify(r.value)).not.toMatch(/\n\s+at /);
    } finally {
      await client.close();
    }
  });

  test("two server processes on one store lose no write", async () => {
    const dir = fresh();
    const [one, two] = await Promise.all([connect(dir, "agent:one"), connect(dir, "agent:two")]);
    try {
      await call(one, "create_board", { id: "b" });
      await Promise.all(
        Array.from({ length: 10 }, (_, i) => call(i % 2 ? one : two, "add_shape", { board: "b", id: `s${i}`, type: "rect", x: i * 10, y: 0 })),
      );
      const ids = (await call(one, "read_board", { board: "b" })).value.nodes.map((s: { id: string }) => s.id).sort();
      expect(ids).toEqual(Array.from({ length: 10 }, (_, i) => `s${i}`));
    } finally {
      await Promise.all([one.close(), two.close()]);
    }
  }, 60_000);
});
