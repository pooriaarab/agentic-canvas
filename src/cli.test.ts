// End-to-end tests. They run the built binary (dist/cli.js) as a real process,
// so run `npm run build` first. `npm run ci:local` does.
//
// Failure-mode list. These were written before the CLI and the store.
//  1. No command, an unknown command, an unknown flag, wrong argument count: exit 2.
//  2. A write with CANVAS_ACTOR unset, empty, blank, or not <kind>:<id> with a
//     valid kind: exit 2, and nothing is written. There is no --actor flag, so
//     a caller cannot pick its own kind (human included).
//  3. Unknown board: exit 1. A board id that climbs out of the folder: exit 1,
//     and no file lands outside it.
//  4. A blank or non-numeric number: exit 1 with a clear message.
//  5. A board id that exists: exit 1.
//  6. Bad flow text: exit 1, and the board is unchanged.
//  7. A damaged stored file: exit 1, no stack trace.
//  8. Eight processes add at the same time: all eight shapes stay.
//  9. Round trip through new, add, connect, flow, move, rm, read, export.
// 10. The same board exports to the same bytes twice. The run saves the SVG
//     and a hash as an artifact under artifacts/.
// 11. Agent work reads back as machine-made.
// 12. PNG: a real PNG with the size of the SVG. Hostile text still gives an SVG
//     that a browser parses as XML. Drawing makes no network request.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as Y from "yjs";
import { MAX_ELEMENTS } from "./core/board.js";
import { STORE_FILE } from "./store-file.js";

const BIN = join(process.cwd(), "dist", "cli.js");
const root = mkdtempSync(join(tmpdir(), "canvas-e2e-"));
let n = 0;
const dirs: string[] = [];
/** A board doc as the file store keeps it, or null. */
const stored = (dir: string, id: string): unknown =>
  (JSON.parse(readFileSync(join(dir, STORE_FILE), "utf8")) as { boards?: Record<string, unknown> }).boards?.[id] ?? null;
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

// The actor comes from CANVAS_ACTOR only. These are the operator environments.
const agent = { CANVAS_ACTOR: "agent_of_human:helper" };
const human = { CANVAS_ACTOR: "human:ada" };
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
    ["unknown export format", ["export", "b", "--format", "gif"]],
    ["png without --out", ["export", "b", "--format", "png"]],
    ["flow with both text and file", ["flow", "b", "--text", "A -> B", "--file", "x"]],
  ])("%s exits 2 with nothing on stdout", async (_name, args) => {
    const r = await cli(fresh(), args, agent);
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
    await cli(dir, ["new", "--id", "b"], human);
    expect((await cli(dir, ["new", "--id", "b"], human)).err).toContain("DUPLICATE_ID");
    for (const x of ["abc", ""]) {
      const r = await cli(dir, ["add", "b", "--type", "rect", "--x", x, "--y", "0"], agent);
      expect([r.code, r.out]).toEqual([1, ""]);
      expect(r.err).toContain("INVALID");
    }
  });
  test("a board id cannot climb out of the folder", async () => {
    const dir = fresh();
    for (const id of ["../escape", "a/b", "..", "x".repeat(65)]) {
      const r = await cli(dir, ["new", "--id", id], human);
      expect(r.code).toBe(1);
    }
    await cli(dir, ["new", "--id", "ok"], human);
    expect(await cli(dir, ["read", "../escape"])).toMatchObject({ code: 1, out: "" });
    expect(await cli(dir, ["read", "__x__"])).toMatchObject({ code: 1, out: "" });
  });
  test("bad flow text leaves the board unchanged", async () => {
    const dir = fresh();
    await cli(dir, ["new", "--id", "b"], human);
    await cli(dir, ["flow", "b", "--text", "A -> B"], agent);
    const before = (await cli(dir, ["read", "b"])).out;
    const r = await cli(dir, ["flow", "b", "--text", "C -> D\nE => F", "--prefix", "x-"], agent);
    expect([r.code, r.err]).toEqual([1, expect.stringContaining("line 2")]);
    expect((await cli(dir, ["read", "b"])).out).toBe(before);
  });
  test("a damaged stored file is a clean error", async () => {
    const dir = fresh();
    await cli(dir, ["new", "--id", "b"], human);
    writeFileSync(join(dir, STORE_FILE), "{not json");
    const r = await cli(dir, ["read", "b"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("INVALID: ");
    expect(r.err).toContain("not valid JSON");
    expect(r.err).not.toMatch(/\n\s+at /);
  });
});

describe("actor", () => {
  const add = ["add", "b", "--type", "rect", "--x", "0", "--y", "0"];
  const nodeCount = async (dir: string) => json(await cli(dir, ["read", "b"])).nodes.length;
  test.each([
    ["unset", {}],
    ["empty", { CANVAS_ACTOR: "" }],
    ["blank", { CANVAS_ACTOR: "   " }],
    ["no colon", { CANVAS_ACTOR: "human" }],
    ["unknown kind", { CANVAS_ACTOR: "robot:x" }],
    ["empty id", { CANVAS_ACTOR: "agent:" }],
    ["empty kind", { CANVAS_ACTOR: ":x" }],
  ])("a write with CANVAS_ACTOR %s exits 2 and writes nothing", async (_name, env) => {
    const dir = fresh();
    await cli(dir, ["new", "--id", "b"], human);
    const r = await cli(dir, add, env);
    expect([r.code, r.out]).toEqual([2, ""]);
    expect(r.err).toContain("CANVAS_ACTOR");
    expect(await nodeCount(dir)).toBe(0);
    const made = await cli(dir, ["new", "--id", "c"], env);
    expect(made.code).toBe(2);
    expect(stored(dir, "c")).toBeNull();
  });
  test("--actor does not exist: it cannot set a kind, human or other", async () => {
    const dir = fresh();
    await cli(dir, ["new", "--id", "b"], human);
    for (const env of [{}, { CANVAS_ACTOR: "" }, agent]) {
      for (const flag of ["human:mallory", "agent:bot"]) {
        const r = await cli(dir, [...add, "--actor", flag], env);
        expect([r.code, r.out]).toEqual([2, ""]);
      }
    }
    expect(await nodeCount(dir)).toBe(0);
  });
  test("the kind comes from CANVAS_ACTOR and labels the work", async () => {
    const dir = fresh();
    await cli(dir, ["new", "--id", "b"], human);
    await cli(dir, add, { CANVAS_ACTOR: "agent:bot" });
    await cli(dir, add, human);
    const nodes = json(await cli(dir, ["read", "b"])).nodes;
    expect(nodes.map((n: { author: { kind: string }; machineMade: boolean }) => [n.author.kind, n.machineMade])).toEqual([["agent", true], ["human", false]]);
  });
  test("a read needs no actor", async () => {
    const dir = fresh();
    await cli(dir, ["new", "--id", "b"], human);
    expect((await cli(dir, ["read", "b"], {})).code).toBe(0);
  });
});

describe("concurrency", () => {
  test("eight processes adding at once lose nothing", async () => {
    const dir = fresh();
    await cli(dir, ["new", "--id", "b"], human);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => cli(dir, ["add", "b", "--type", "rect", "--x", String(i * 10), "--y", "0", "--id", `s${i}`], agent)),
    );
    expect(results.map((r) => r.code)).toEqual(Array(8).fill(0));
    const ids = json(await cli(dir, ["read", "b"])).nodes.map((s: { id: string }) => s.id).sort();
    expect(ids).toEqual(Array.from({ length: 8 }, (_, i) => `s${i}`));
  }, 60_000);
});

describe("round trip", () => {
  test("new, add, connect, flow, move, rm, read, export", async () => {
    const dir = fresh();
    expect(json(await cli(dir, ["new", "--id", "b", "--title", "Plan"], human))).toEqual({ id: "b", title: "Plan" });
    await cli(dir, ["add", "b", "--type", "sticky", "--x", "0", "--y", "0", "--text", "Idea", "--id", "idea"], human);
    await cli(dir, ["add", "b", "--type", "ellipse", "--x", "300", "--y", "0", "--text", "Plan", "--id", "plan"], agent);
    const link = json(await cli(dir, ["connect", "b", "idea", "plan", "--text", "leads to"], agent));
    expect(link).toMatchObject({ type: "connector", from: { id: "idea" }, to: { id: "plan" } });
    const flow = json(await cli(dir, ["flow", "b", "--text", "S(Start) -> D{Ok?}: go\nD -> E[Done]: yes", "--prefix", "f-"], agent));
    expect(flow.nodes).toEqual(["f-S", "f-D", "f-E"]);
    expect(json(await cli(dir, ["move", "b", "idea", "--dx", "-5", "--dy", "6"], human))).toEqual({ moved: ["idea"] });
    expect(json(await cli(dir, ["rm", "b", "f-E"])).removed).toEqual(["f-E", "f-edge_2"]);
    const read = json(await cli(dir, ["read", "b"]));
    expect(read.title).toBe("Plan");
    expect(read.nodes.map((s: { id: string }) => s.id)).toEqual(["idea", "plan", "f-S", "f-D"]);
    expect(read.nodes[0]).toMatchObject({ x: -5, y: 6, machineMade: false, lastEditMachineMade: false });
    expect(read.nodes[1]).toMatchObject({ machineMade: true });
    expect(read.edges).toHaveLength(2);
    expect(read.texts).toContain("leads to");
  });

  test("exports the same SVG twice and saves it as an artifact", async () => {
    const dir = fresh();
    await cli(dir, ["new", "--id", "b", "--title", "Release flow"], human);
    await cli(dir, ["flow", "b", "--text", "direction LR\nCode(Write code) -> Test{Tests pass?}: push\nTest -> Ship[Ship it]: yes\nTest -> Code: no"], agent);
    const first = await cli(dir, ["export", "b"]);
    const second = await cli(dir, ["export", "b"]);
    expect(first.code).toBe(0);
    expect(first.out).toBe(second.out);
    expect(first.out).toMatch(/^<svg /);
    expect(first.out).toContain('data-machine-made="true"');
    mkdirSync(join(process.cwd(), "artifacts"), { recursive: true });
    writeFileSync(join(process.cwd(), "artifacts", "release-flow.svg"), first.out);
    const hash = createHash("sha256").update(first.out).digest("hex");
    writeFileSync(join(process.cwd(), "artifacts", "release-flow.sha256"), `${hash}  release-flow.svg\n`);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("png", () => {
  test("writes a PNG with the size of the SVG, and hostile text stays well-formed", async () => {
    const dir = fresh();
    await cli(dir, ["new", "--id", "b"], human);
    await cli(dir, ["add", "b", "--type", "rect", "--x", "0", "--y", "0", "--text", '<script>alert(1)</script> & "x" \u0007 😀'], agent);
    await cli(dir, ["flow", "b", "--text", "A -> B: go"], agent);
    const svg = (await cli(dir, ["export", "b"])).out;
    const [, w, h] = /width="(\d+)" height="(\d+)"/.exec(svg)!.map(Number);
    const file = join(root, "board.png");
    const r = await cli(dir, ["export", "b", "--format", "png", "--out", file]);
    expect(r.code).toBe(0);
    const png = readFileSync(file);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([w, h]);
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const parsed = await page.evaluate((s) => {
        const doc = new DOMParser().parseFromString(s, "image/svg+xml");
        return { error: doc.querySelector("parsererror")?.textContent ?? null, scripts: doc.querySelectorAll("script").length };
      }, svg);
      expect(parsed).toEqual({ error: null, scripts: 0 });
    } finally {
      await browser.close();
    }
    mkdirSync(join(process.cwd(), "artifacts"), { recursive: true });
    writeFileSync(join(process.cwd(), "artifacts", "board.png"), png);
  }, 60_000);
});

describe("png network", () => {
  test("drawing a PNG makes no network request", async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits++;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/a.png`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><image href="${url}" width="50" height="50"/></svg>`;
    try {
      const { svgToPng } = await import("./png.js");
      await svgToPng(svg);
    } finally {
      server.close();
    }
    expect(hits).toBe(0);
  }, 60_000);
});

describe("png limits", () => {
  test("refuses a board past the pixel cap before it starts a browser", async () => {
    const { svgToPng } = await import("./png.js");
    const big = '<svg xmlns="http://www.w3.org/2000/svg" width="4001" height="4001"></svg>';
    await expect(svgToPng(big)).rejects.toMatchObject({ code: "LIMIT" });
  });
  test("a script in the SVG does not run", async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits++;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`;
    const frame = (script: string) =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><rect id="r" width="60" height="60" fill="#00aa00"/>${script}</svg>`;
    const attack = `<script>document.getElementById("r").setAttribute("fill","#ff0000");fetch("${url}");new WebSocket("ws://127.0.0.1:1/");</script>`;
    try {
      const { svgToPng } = await import("./png.js");
      const clean = await svgToPng(frame(""));
      const hostile = await svgToPng(frame(attack));
      expect(Buffer.from(hostile).equals(Buffer.from(clean))).toBe(true);
    } finally {
      server.close();
    }
    expect(hits).toBe(0);
  }, 60_000);
});

describe("owner repair", () => {
  const file = (dir: string, id: string) => stored(dir, id);
  let bytes: string | undefined;
  /** A peer past the cap. Writes the store file the way the service does. Built once: it is large. */
  function overCap(dir: string, id: string): unknown {
    if (!bytes) {
      const doc = new Y.Doc();
      const elements = doc.getMap("elements");
      doc.transact(() => {
        for (let i = 0; i <= MAX_ELEMENTS; i++) {
          const fields = { id: `s${i}`, type: "rect", z: i, x: 0, y: 0, w: 10, h: 10, text: "", author: { kind: "human", id: "ada" }, editedBy: { kind: "human", id: "ada" } };
          elements.set(`s${i}`, new Y.Map(Object.entries(fields)));
        }
      });
      bytes = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, STORE_FILE), JSON.stringify({ boards: { [id]: { update: bytes } } }));
    return file(dir, id);
  }
  test("an agent cannot repair, and the file is unchanged", async () => {
    const dir = fresh();
    const before = overCap(dir, "big");
    const r = await cli(dir, ["repair", "big"], agent);
    expect([r.code, r.out]).toEqual([1, ""]);
    expect(r.err).toContain("FORBIDDEN");
    expect(file(dir, "big")).toEqual(before);
  }, 60_000);
  test("read says the board is past the cap, not that it is damaged", async () => {
    const dir = fresh();
    overCap(dir, "big");
    const r = await cli(dir, ["read", "big"], human);
    expect(r.code).toBe(1);
    expect(r.err).toContain("LIMIT");
    expect(r.err).not.toContain("damaged");
  });
  test("a human repair with no drop leaves the over-cap board unchanged", async () => {
    const dir = fresh();
    const before = overCap(dir, "big");
    const r = await cli(dir, ["repair", "big"], human);
    expect(r.code).toBe(1);
    expect(r.err).toContain("LIMIT");
    expect(file(dir, "big")).toEqual(before);
  }, 60_000);
  test("dropping one element brings the board under the cap, and it reads again", async () => {
    const dir = fresh();
    overCap(dir, "big");
    const r = await cli(dir, ["repair", "big", "--drop", "s0"], human);
    expect([r.code, json(r)]).toEqual([0, { id: "big", fixed: ["s0"], elements: MAX_ELEMENTS }]);
    const read = await cli(dir, ["read", "big"]);
    expect(read.code).toBe(0);
    expect(json(read).nodes).toHaveLength(MAX_ELEMENTS);
  });
  test("a drop that names no element exits 1 and changes nothing", async () => {
    const dir = fresh();
    await cli(dir, ["new", "--id", "small"], human);
    const before = file(dir, "small");
    const r = await cli(dir, ["repair", "small", "--drop", "nope"], human);
    expect(r.code).toBe(1);
    expect(r.err).toContain("NOT_FOUND");
    expect(file(dir, "small")).toEqual(before);
  });
  test("repair on a healthy board fixes nothing", async () => {
    const dir = fresh();
    await cli(dir, ["new", "--id", "small"], human);
    expect(json(await cli(dir, ["repair", "small"], human))).toEqual({ id: "small", fixed: [], elements: 0 });
  });
});
