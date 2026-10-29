// The file store is an adapter of the shared Store port, so it runs the shared contract suite.
// `shared` names one file: two stores with the same name open the same file, as two processes do.
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

test("a lock left by a crash does not stop the upgrade of an older file", async () => {
  const path = join(dir, "stale.json");
  writeFileSync(path, JSON.stringify({ boards: { b: { update: "AAA" } } }));
  writeFileSync(`${path}.lock`, "999999:gone");
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(`${path}.lock`, old, old);
  expect(await createFileStore(path).get("boards", "b")).toEqual({ update: "AAA" });
});

test("an older file that cannot be upgraded is not called damaged", async () => {
  // Root can write to a folder with no write bit.
  if (process.getuid?.() === 0) return;
  const folder = join(dir, "readonly");
  mkdirSync(folder);
  const path = join(folder, "canvas.json");
  writeFileSync(path, JSON.stringify({ boards: { b: { update: "AAA" } } }));
  chmodSync(folder, 0o500);
  try {
    await expect(createFileStore(path).get("boards", "b")).rejects.toThrow(/older layout/);
  } finally {
    chmodSync(folder, 0o700);
  }
});

test("an older process that makes the file after the store opened does not leave it damaged", async () => {
  const path = join(dir, "late.json");
  const store = createFileStore(path);
  expect(await store.get("boards", "b")).toBeNull();
  writeFileSync(path, JSON.stringify({ boards: { b: { update: "AAA" } } }));
  expect(await store.get("boards", "b")).toEqual({ update: "AAA" });
});

test("the identity store words its two errors as this wrapper expects", async () => {
  writeFileSync(join(dir, "junk.json"), "[1]");
  await expect(createFileStore(join(dir, "junk.json")).get("boards", "b")).rejects.toMatchObject({ code: "DAMAGED" });
  const dist = join(process.cwd(), "node_modules", "agentic-identity", "dist");
  const source = readdirSync(dist).filter((name) => name.endsWith(".js")).map((name) => readFileSync(join(dist, name), "utf8")).join("\n");
  expect(source).toContain("locked by another process");
});
