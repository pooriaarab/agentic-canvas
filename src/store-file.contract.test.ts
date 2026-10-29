// The file store is an adapter of the shared Store port, so it runs the shared contract suite.
// `shared` names one file: two stores with the same name open the same file, as two processes do.
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStoreContract } from "agentic-identity/testing";
import { afterAll, expect, test } from "vitest";
import { createFileStore } from "./store-file.js";

const dir = mkdtempSync(join(tmpdir(), "canvas-file-contract-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

runStoreContract(({ shared, region }) => createFileStore(join(dir, `${shared ?? randomUUID()}.json`), { region }));

test("a file in the older layout is upgraded in place and its boards still read", async () => {
  const path = join(dir, "legacy.json");
  writeFileSync(path, JSON.stringify({ boards: { b: { update: "AAA" } } }));
  const store = createFileStore(path);
  expect(await store.get("boards", "b")).toEqual({ update: "AAA" });
  await store.put("boards", "c", { update: "BBB" });
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ format: 1, collections: { boards: { b: {}, c: {} } } });
});

test("a file that does not parse is a damaged-file error and is left as it is", async () => {
  const path = join(dir, "damaged.json");
  writeFileSync(path, "{not json");
  await expect(createFileStore(path).get("boards", "b")).rejects.toMatchObject({ code: "DAMAGED" });
  expect(readFileSync(path, "utf8")).toBe("{not json");
});
