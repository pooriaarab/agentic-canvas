import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFileStore as createIdentityFileStore } from "agentic-identity/file";
import { StoreConflictError, type AdapterOptions, type Doc, type Store } from "agentic-identity";
import { FileStoreError } from "./store-errors.js";

export { FileStoreError };

export interface FileStoreOptions extends AdapterOptions {}

/** The identity file store gives up when another process wrote at the same moment. Run the call again, for a short time. */
const RETRY_FOR_MS = 10_000;

async function retried<R>(run: () => Promise<R>): Promise<R> {
  const deadline = Date.now() + RETRY_FOR_MS;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      // A lock that stays held already waited in the store. Do not wait again.
      const clash = error instanceof StoreConflictError && !/locked by another process/.test(error.message);
      if (!clash || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 20));
    }
  }
}

const isDoc = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const sleep = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Hold `${path}.lock`, the lock the identity store takes for each write, while `fn` runs. Gives up after 5 seconds. */
function withLock(path: string, fn: () => void): boolean {
  const lock = `${path}.lock`;
  const mine = `${process.pid}:${randomUUID()}`;
  for (const start = Date.now(); ; ) {
    try {
      writeFileSync(lock, mine, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
      if (Date.now() - start > 5_000) return false;
      sleep(10);
    }
  }
  try {
    fn();
  } finally {
    try {
      if (readFileSync(lock, "utf8") === mine) unlinkSync(lock);
    } catch {
      // The lock is already gone.
    }
  }
  return true;
}

/**
 * Older versions kept `{ collection: { id: doc } }` in the file. The identity store keeps
 * `{ format: 1, collections }`. Rewrite an old file in place by an atomic rename, with the write lock held,
 * so no commit of another process falls between the read and the rename. A file that does not parse is left
 * alone, and the store then reports it as damaged. A folder that cannot be written is left alone too.
 */
function upgradeLegacyFile(path: string): void {
  const legacy = (): unknown => {
    try {
      const data: unknown = JSON.parse(readFileSync(path, "utf8"));
      const old = isDoc(data) && !("format" in data) && Object.values(data).every((docs) => isDoc(docs) && Object.values(docs).every(isDoc));
      return old ? data : undefined;
    } catch {
      return undefined;
    }
  };
  if (legacy() === undefined) return;
  try {
    withLock(path, () => {
      const data = legacy();
      if (data === undefined) return;
      const temp = `${path}.${process.pid}.upgrade`;
      try {
        writeFileSync(temp, JSON.stringify({ format: 1, collections: data }), { mode: 0o600 });
        renameSync(temp, path);
      } finally {
        rmSync(temp, { force: true });
      }
    });
  } catch {
    // Leave the file as it is. The store reports what it cannot read.
  }
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
