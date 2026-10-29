// The file store is an adapter of the shared Store port, so it runs the shared contract suite.
// `shared` names one file: two stores with the same name open the same file, as two processes do.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStoreContract } from "agentic-identity/testing";
import { afterAll, expect, test } from "vitest";
import { createFileStore } from "./store-file.js";

const dir = mkdtempSync(join(tmpdir(), "canvas-file-contract-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

runStoreContract(({ shared, region }) => createFileStore(join(dir, `${shared ?? randomUUID()}.json`), { region }));

test("a lock wait that is not a finite number is refused", () => {
  for (const bad of [Number.NaN, Infinity, -1, "abc" as unknown as number]) expect(() => createFileStore(join(dir, "x.json"), { lockTimeoutMs: bad })).toThrow(TypeError);
});
