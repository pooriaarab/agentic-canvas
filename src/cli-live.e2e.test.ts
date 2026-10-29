// End to end: the built CLI and MCP server join live rooms on the real Worker under `wrangler dev`.
// Run `npm run build` first. `npm run ci:local` does.
//
// Failure cases, written before the live mode:
//  1. Live mode starts with no token, with --dir (the board would be somewhere else), or with a CANVAS_ACTOR that
//     is not the token's actor. Each must exit 2 and write nothing. Repair is local only.
//  2. A person in an open room, a CLI process, and an MCP agent edit one board and do not converge.
//  3. The author kind is the one the caller set, not the one of its token, or an agent's edit reads as a person's.
//  4. A viewer token changes the board, or a bad token reads it.
//  5. A restart loses the board.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { LiveBoard } from "./live.js";
import { startWorker, type RunningWorker } from "./wrangler-harness.js";

const BIN = join(process.cwd(), "dist", "cli.js");
const PORT = 18840;
const HUMAN = "human-token-".padEnd(40, "h");
const BOT = "agent-token-".padEnd(40, "a");
const VIEWER = "viewer-token-".padEnd(40, "v");
const vars = [`CANVAS_API_TOKENS:${JSON.stringify({ [HUMAN]: { actor: "ada", kind: "human" }, [BOT]: { actor: "helper", kind: "agent_of_human" }, [VIEWER]: { actor: "eve", kind: "human", role: "viewer" } })}`, "CANVAS_REGION:unknown"];
const persistTo = mkdtempSync(join(tmpdir(), "agentic-canvas-cli-live-"));
let worker: RunningWorker | undefined;
const server = () => worker!.url.replace("/api/v1/canvas", "");
const env = (token: string | undefined, extra: Record<string, string> = {}) => ({ PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CANVAS_SERVER: server(), ...(token ? { CANVAS_TOKEN: token } : {}), ...extra });

afterEach(async () => {
  await worker?.stop();
  worker = undefined;
});
afterAll(() => rmSync(persistTo, { recursive: true, force: true }));

function cli(args: string[], environment: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: environment });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

async function until(done: () => boolean, what: string): Promise<void> {
  for (const start = Date.now(); !done(); await new Promise((r) => setTimeout(r, 50))) {
    if (Date.now() - start > 15_000) throw new Error(`timed out waiting for ${what}`);
  }
}

describe("live CLI and MCP", () => {
  test("refuse a bad setup before they touch the server", async () => {
    worker = await startWorker({ port: PORT, persistTo, vars });
    const base = ["add", "b0", "--type", "rect", "--x", "0", "--y", "0"];
    expect(await cli(base, env(undefined))).toMatchObject({ code: 2, err: expect.stringContaining("CANVAS_TOKEN") });
    expect(await cli(["--dir", "x", ...base], env(HUMAN))).toMatchObject({ code: 2, err: expect.stringContaining("--dir") });
    expect(await cli(base, env(HUMAN, { CANVAS_ACTOR: "human:mallory" }))).toMatchObject({ code: 2, err: expect.stringContaining("does not match") });
    expect(await cli(["repair", "b0"], env(HUMAN))).toMatchObject({ code: 2, err: expect.stringContaining("local store only") });
    expect(await cli(["new", "--id", "b0"], env("x".repeat(40)))).toMatchObject({ code: 1, out: "", err: expect.stringContaining("FORBIDDEN") });
    expect(await cli(["new", "--id", "b0"], env(VIEWER))).toMatchObject({ code: 1, err: expect.stringContaining("FORBIDDEN") });
  }, 120_000);

  test("a person in a room, a CLI process, and an MCP agent edit one board, converge, and keep it over a restart", async () => {
    worker = await startWorker({ port: PORT, persistTo, vars });
    // The CLI creates the board as the token's person. A matching CANVAS_ACTOR is fine.
    const made = await cli(["new", "--id", "b1", "--title", "Plan"], env(HUMAN, { CANVAS_ACTOR: "human:ada" }));
    expect(made).toMatchObject({ code: 0, out: '{"id":"b1","title":"Plan"}\n' });

    // A person keeps a room open. An MCP agent joins the same board through the real server process.
    const person = await LiveBoard.join({ server: server(), board: "b1", token: HUMAN });
    const mcp = new Client({ name: "test", version: "0" });
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, "mcp"], env: env(BOT), stderr: "pipe" }));
    const tool = async (name: string, args: Record<string, unknown>) => {
      const r = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      return { error: r.isError === true, value: JSON.parse(r.content[0].text) };
    };

    // All three write at once.
    const [cliAdd, agentAdd] = await Promise.all([
      cli(["add", "b1", "--type", "rect", "--x", "0", "--y", "0", "--id", "from-cli", "--text", "cli"], env(HUMAN)),
      tool("add_shape", { board: "b1", id: "from-agent", type: "ellipse", x: 200, y: 0 }),
      person.edit((board, actor) => board.addShape({ id: "from-room", type: "sticky", x: 0, y: 200 }, actor)),
    ]);
    expect(cliAdd.code).toBe(0);
    expect(agentAdd.error).toBe(false);
    await tool("connect", { board: "b1", from: "from-cli", to: "from-agent", id: "link" });

    // The open room sees the agent's and the CLI's edits without joining again.
    await until(() => ["from-cli", "from-agent"].every((id) => person.board.get(id) !== undefined), "the open room to get the edits");
    // The agent and the CLI read the person's room edit, saved or not.
    const viaMcp = (await tool("read_board", { board: "b1" })).value;
    const viaCli = JSON.parse((await cli(["read", "b1"], env(HUMAN))).out);
    for (const data of [viaMcp, viaCli]) {
      expect(data.nodes.map((n: { id: string }) => n.id).sort()).toEqual(["from-agent", "from-cli", "from-room"]);
      expect(data.edges.map((e: { id: string }) => e.id)).toEqual(["link"]);
    }
    // The author kind is the token's. The agent's work reads as machine-made, and the person's does not.
    const by = (id: string) => viaCli.nodes.find((n: { id: string }) => n.id === id);
    expect(by("from-agent")).toMatchObject({ machineMade: true, author: { kind: "agent_of_human", id: "helper" } });
    expect(by("from-cli")).toMatchObject({ machineMade: false, author: { kind: "human", id: "ada" } });
    expect(by("from-room")).toMatchObject({ machineMade: false, author: { kind: "human", id: "ada" } });

    // The agent moves the person's shape: the author stays, the last editor is the agent.
    await tool("move", { board: "b1", element: "from-cli", dx: 10, dy: 0 });
    expect((await cli(["read", "b1"], env(HUMAN))).out).toContain('"lastEditMachineMade":true');
    expect((await cli(["export", "b1"], env(VIEWER))).out).toContain("<svg");
    expect((await tool("add_shape", { board: "b1", type: "rect", x: 1, y: 1 })).error).toBe(false);
    await person.leave();
    await mcp.close();

    // A restart keeps the board, from the store and from the room.
    await worker.stop();
    worker = await startWorker({ port: PORT, persistTo, vars });
    const after = JSON.parse((await cli(["read", "b1"], env(BOT))).out);
    expect(after.title).toBe("Plan");
    expect(after.nodes.map((n: { id: string }) => n.id)).toEqual(expect.arrayContaining(["from-agent", "from-cli", "from-room"]));
    expect(after.nodes).toHaveLength(4);
  }, 240_000);
});
