// End-to-end tests. They run the built binary (dist/cli.js) as a real process,
// so run `npm run build` first. `npm run ci:local` does.
//
// Failure-mode list. These were written before the CLI and the store.
//  1. No command, an unknown command, an unknown flag, wrong argument count: exit 2.
//  2. A write with no actor, or with a bad actor: exit 2.
//  3. Unknown board: exit 1. A board id that climbs out of the folder: exit 1,
//     and no file lands outside it.
//  4. A blank or non-numeric number: exit 1 with a clear message.
//  5. A board id that exists: exit 1.
//  6. Bad flow text: exit 1, and the board is unchanged.
//  7. A damaged stored file: exit 1, no stack trace.
//  8. Eight processes add at the same time: all eight shapes stay.
//  9. Round trip through new, add, connect, flow, move, rm, read.
// 10. Agent work reads back as machine-made.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const BIN = join(process.cwd(), "dist", "cli.js");
const root = mkdtempSync(join(tmpdir(), "canvas-e2e-"));
let n = 0;
const dirs: string[] = [];
const fresh = () => {
  const dir = join(root, `store${n++}`);
  dirs.push(dir);
  return dir;
};

interface Result {
  code: number;
  out: string;
  err: string;
}

function cli(dir: string, args: string[], env: Record<string, string> = {}): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, "--dir", dir, ...args], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

const agent = ["--actor", "agent_of_human:helper"];
const human = ["--actor", "human:ada"];
const json = (r: Result) => JSON.parse(r.out);

beforeAll(() => {
  if (!existsSync(BIN)) throw new Error("dist/cli.js is missing: run npm run build first");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("usage errors", () => {
  test.each([
    ["unknown command", ["frobnicate"]],
    ["unknown flag", ["read", "b", "--nope"]],
    ["too few arguments", ["connect", "b", "a"]],
    ["too many arguments", ["read", "a", "b"]],
    ["write without actor", ["new"]],
    ["bad actor kind", ["new", "--actor", "robot:x"]],
    ["actor without colon", ["new", "--actor", "human"]],
    ["flow with both text and file", ["flow", "b", "--text", "A -> B", "--file", "x", ...agent]],
  ])("%s exits 2 with nothing on stdout", async (_name, args) => {
    const r = await cli(fresh(), args);
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).not.toMatch(/\n\s+at /);
  });
  test("no command prints help and exits 0", async () => {
    const r = await cli(fresh(), []);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Usage:");
  });
});

describe("failures exit 1", () => {
  test("unknown board, duplicate board, bad number", async () => {
    const dir = fresh();
    expect((await cli(dir, ["read", "nope"])).err).toContain("NOT_FOUND");
    await cli(dir, ["new", "--id", "b", ...human]);
    expect((await cli(dir, ["new", "--id", "b", ...human])).err).toContain("DUPLICATE_ID");
    for (const x of ["abc", ""]) {
      const r = await cli(dir, ["add", "b", "--type", "rect", "--x", x, "--y", "0", ...agent]);
      expect([r.code, r.out]).toEqual([1, ""]);
      expect(r.err).toContain("INVALID");
    }
  });
  test("a board id cannot climb out of the folder", async () => {
    const dir = fresh();
    for (const id of ["../escape", "a/b", "..", "x".repeat(65)]) {
      const r = await cli(dir, ["new", "--id", id, ...human]);
      expect(r.code).toBe(1);
    }
    // A real board file one level above the collection folder must stay out of reach.
    await cli(dir, ["new", "--id", "ok", ...human]);
    copyFileSync(join(dir, "boards", "ok.json"), join(dir, "escape.json"));
    const r = await cli(dir, ["read", "../escape"]);
    expect([r.code, r.out]).toEqual([1, ""]);
    expect(readdirSync(root).filter((f) => f.includes("escape"))).toEqual([]);
  });
  test("bad flow text leaves the board unchanged", async () => {
    const dir = fresh();
    await cli(dir, ["new", "--id", "b", ...human]);
    await cli(dir, ["flow", "b", "--text", "A -> B", ...agent]);
    const before = (await cli(dir, ["read", "b"])).out;
    const r = await cli(dir, ["flow", "b", "--text", "C -> D\nE => F", "--prefix", "x-", ...agent]);
    expect([r.code, r.err]).toEqual([1, expect.stringContaining("line 2")]);
    expect((await cli(dir, ["read", "b"])).out).toBe(before);
  });
  test("a damaged stored file is a clean error", async () => {
    const dir = fresh();
    await cli(dir, ["new", "--id", "b", ...human]);
    writeFileSync(join(dir, "boards", "b.json"), "{not json");
    const r = await cli(dir, ["read", "b"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("damaged");
    expect(r.err).not.toMatch(/\n\s+at /);
  });
});

describe("concurrency", () => {
  test("eight processes adding at once lose nothing", async () => {
    const dir = fresh();
    await cli(dir, ["new", "--id", "b", ...human]);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => cli(dir, ["add", "b", "--type", "rect", "--x", String(i * 10), "--y", "0", "--id", `s${i}`, ...agent])),
    );
    expect(results.map((r) => r.code)).toEqual(Array(8).fill(0));
    const ids = json(await cli(dir, ["read", "b"])).nodes.map((s: { id: string }) => s.id).sort();
    expect(ids).toEqual(Array.from({ length: 8 }, (_, i) => `s${i}`));
  }, 60_000);
});

describe("round trip", () => {
  test("new, add, connect, flow, move, rm, read", async () => {
    const dir = fresh();
    expect(json(await cli(dir, ["new", "--id", "b", "--title", "Plan", ...human]))).toEqual({ id: "b", title: "Plan" });
    await cli(dir, ["add", "b", "--type", "sticky", "--x", "0", "--y", "0", "--text", "Idea", "--id", "idea", ...human]);
    await cli(dir, ["add", "b", "--type", "ellipse", "--x", "300", "--y", "0", "--text", "Plan", "--id", "plan", ...agent]);
    const link = json(await cli(dir, ["connect", "b", "idea", "plan", "--text", "leads to", ...agent]));
    expect(link).toMatchObject({ type: "connector", from: { id: "idea" }, to: { id: "plan" } });
    const flow = json(await cli(dir, ["flow", "b", "--text", "S(Start) -> D{Ok?}: go\nD -> E[Done]: yes", "--prefix", "f-", ...agent]));
    expect(flow.nodes).toEqual(["f-S", "f-D", "f-E"]);
    expect(json(await cli(dir, ["move", "b", "idea", "--dx", "-5", "--dy", "6", ...human]))).toEqual({ moved: ["idea"] });
    expect(json(await cli(dir, ["rm", "b", "f-E"])).removed).toEqual(["f-E", "f-edge_2"]);
    const read = json(await cli(dir, ["read", "b"]));
    expect(read.title).toBe("Plan");
    expect(read.nodes.map((s: { id: string }) => s.id)).toEqual(["idea", "plan", "f-S", "f-D"]);
    expect(read.nodes[0]).toMatchObject({ x: -5, y: 6, machineMade: false, lastEditMachineMade: false });
    expect(read.nodes[1]).toMatchObject({ machineMade: true });
    expect(read.edges).toHaveLength(2);
    expect(read.texts).toContain("leads to");
  });
});
