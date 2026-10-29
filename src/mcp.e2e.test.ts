// End-to-end test. It starts the built CLI as `mcp` with no usable CANVAS_ACTOR.
// Stdin stays open, so the process must exit on its own. A server that waited
// for stdin before it checked the actor would hang here. `npm run ci:local`
// builds first.
//
// Failure-mode list. Written before the check was pinned.
//  1. CANVAS_ACTOR unset, empty, blank, no colon, unknown kind, or empty id:
//     the process exits 2 within a few seconds, with stdin still open.
//  2. stderr names CANVAS_ACTOR and holds no stack trace.
//  3. stdout is empty, so no protocol frame goes out.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

const BIN = join(process.cwd(), "dist", "cli.js");
const root = mkdtempSync(join(tmpdir(), "canvas-mcp-start-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const EXIT_WITHIN_MS = 10_000;

/** Start `mcp` and leave stdin open. Resolve when the process exits, or kill it after the limit. */
function startWithStdinOpen(env: Record<string, string>): Promise<{ code: number | null; timedOut: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, "--dir", join(root, "store"), "mcp"], { env: { PATH: process.env.PATH ?? "", ...env } });
    let out = "";
    let err = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, EXIT_WITHIN_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, out, err });
    });
  });
}

describe("mcp start without a usable CANVAS_ACTOR", () => {
  test.each([
    ["unset", {}],
    ["empty", { CANVAS_ACTOR: "" }],
    ["blank", { CANVAS_ACTOR: "  " }],
    ["no colon", { CANVAS_ACTOR: "agent" }],
    ["unknown kind", { CANVAS_ACTOR: "robot:x" }],
    ["empty id", { CANVAS_ACTOR: "agent:" }],
  ])("CANVAS_ACTOR %s: exits 2 at once, names CANVAS_ACTOR, nothing on stdout", async (_name, env) => {
    const r = await startWithStdinOpen(env);
    expect(r.timedOut).toBe(false);
    expect([r.code, r.out]).toEqual([2, ""]);
    expect(r.err).toContain("CANVAS_ACTOR");
    expect(r.err).not.toMatch(/\n\s+at /);
  });
});
