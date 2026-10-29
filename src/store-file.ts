import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFileStore as createIdentityFileStore } from "agentic-identity/file";
import { StoreConflictError, type AdapterOptions, type Doc, type Store } from "agentic-identity";
import { FileStoreError } from "./store-errors.js";

export { FileStoreError };

export interface FileStoreOptions extends AdapterOptions {}

/** The file store of agentic-identity gives up when another process wrote at the same moment. Run the call again. */
const MAX_RUNS = 50;

async function retried<R>(run: () => Promise<R>): Promise<R> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof StoreConflictError) || attempt >= MAX_RUNS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 20));
    }
  }
}

const isDoc = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Older versions kept `{ collection: { id: doc } }` in the file. The identity store keeps
 * `{ format: 1, collections }`. Rewrite an old file in place by an atomic rename. A file that does not
 * parse is left alone, and the store then reports it as damaged.
 */
function upgradeLegacyFile(path: string): void {
  let seen: string;
  let before: string;
  try {
    seen = readFileSync(path, "utf8");
    const stat = statSync(path);
    before = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return;
  }
  let data: unknown;
  try {
    data = JSON.parse(seen);
  } catch {
    return;
  }
  if (!isDoc(data) || "format" in data) return;
  if (!Object.values(data).every((docs) => isDoc(docs) && Object.values(docs).every(isDoc))) return;
  const temp = `${path}.${process.pid}.upgrade`;
  writeFileSync(temp, JSON.stringify({ format: 1, collections: data }), { mode: 0o600 });
  // Another process may have upgraded and written since we read. Then the file is no longer ours to replace.
  const stat = statSync(path, { throwIfNoEntry: false });
  if (stat && `${stat.ino}:${stat.size}:${stat.mtimeMs}` === before) renameSync(temp, path);
  else renameSync(temp, `${temp}.discarded`);
}

/** Give a file that is not a store file the error the CLI and the MCP server report. */
function damaged(error: unknown): never {
  if (error instanceof Error && /is not an agentic-identity store file/.test(error.message)) throw new FileStoreError("DAMAGED", "the database file is not valid JSON. Repair or remove it");
  throw error;
}

/** A Store kept in one JSON file. Node only. It is the file adapter of agentic-identity, with a retry on a write clash. */
export function createFileStore(path: string, options: FileStoreOptions = {}): Store {
  upgradeLegacyFile(path);
  const inner = createIdentityFileStore({ ...options, path });
  const guard = <R>(run: () => Promise<R>): Promise<R> => retried(run).catch(damaged);
  return {
    region: inner.region,
    get: (collection, id) => guard(() => inner.get(collection, id)),
    query: (collection, query) => guard(() => inner.query(collection, query)),
    put: (collection, id, doc: Doc) => guard(() => inner.put(collection, id, doc)),
    delete: (collection, id) => guard(() => inner.delete(collection, id)),
    transaction: (fn) => guard(() => inner.transaction(fn)),
  };
}

/** The store the CLI and the MCP server share: one file in `dir`, which is made if it is missing. */
export function openLocalStore(dir: string): Store {
  mkdirSync(dir, { recursive: true });
  return createFileStore(join(dir, STORE_FILE));
}

export const STORE_FILE = "canvas.json";
