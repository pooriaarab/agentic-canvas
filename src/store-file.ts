import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createFileStore as createIdentityFileStore } from "agentic-identity/file";
import { StoreConflictError, type AdapterOptions, type Doc, type Store } from "agentic-identity";
import { FileStoreError } from "./store-errors.js";

export { FileStoreError };

export interface FileStoreOptions extends AdapterOptions {}

/** The identity file store gives up when another process wrote at the same moment. Run the call again, for a short time. */
const RETRY_FOR_MS = 10_000;
/** The identity store takes over a lock older than this. */
const LOCK_STALE_MS = 3_000;
const LOCK_WAIT_MS = 5_000;

// The identity store has no error classes for these two cases, so they are told apart by message.
// store-file.contract.test.ts fails if a release of agentic-identity words them differently.
const HELD = /locked by another process/;
const NOT_A_STORE_FILE = /is not an agentic-identity store file/;

async function retried<R>(run: () => Promise<R>): Promise<R> {
  const deadline = Date.now() + RETRY_FOR_MS;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      // A lock that stays held already waited in the store. Do not wait again.
      const clash = error instanceof StoreConflictError && !HELD.test(error.message);
      if (!clash || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 20));
    }
  }
}

const isDoc = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const sleep = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The collections of a file in the older layout, `{ collection: { id: doc } }`, or undefined for any other file. */
function legacyCollections(path: string): Record<string, unknown> | undefined {
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    const current = isDoc(data) && data.format === 1 && isDoc(data.collections);
    const old = isDoc(data) && !current && Object.values(data).every((docs) => isDoc(docs) && Object.values(docs).every(isDoc));
    return old ? data : undefined;
  } catch {
    return undefined;
  }
}

/** Hold `${path}.lock`, the lock the identity store takes for each write, while `fn` runs. False if it was not got in 5 seconds. */
function withLock(path: string, fn: (owned: () => boolean) => void): boolean {
  const lock = `${path}.lock`;
  const mine = `${process.pid}:${randomUUID()}`;
  for (const start = Date.now(); ; ) {
    try {
      writeFileSync(lock, mine, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
      } catch {
        // Gone already, or taken over by another process.
      }
      if (Date.now() - start > LOCK_WAIT_MS) return false;
      sleep(10);
    }
  }
  const owned = (): boolean => {
    try {
      return readFileSync(lock, "utf8") === mine;
    } catch {
      return false;
    }
  };
  try {
    fn(owned);
  } finally {
    if (owned()) rmSync(lock, { force: true });
  }
  return true;
}

/**
 * Older versions kept `{ collection: { id: doc } }` in the file. The identity store keeps
 * `{ format: 1, collections }`. Rewrite an old file in place by an atomic rename, with the write lock held,
 * so no commit of another process falls between the read and the rename. Returns false if the file is still
 * in the older layout afterwards: the folder cannot be written, or the lock stayed held.
 */
function upgradeLegacyFile(path: string): boolean {
  if (legacyCollections(path) === undefined) return true;
  try {
    withLock(path, (owned) => {
      const data = legacyCollections(path);
      if (data === undefined) return;
      const temp = `${path}.${process.pid}.upgrade`;
      try {
        const fd = openSync(temp, "w", 0o600);
        try {
          writeSync(fd, JSON.stringify({ format: 1, collections: data }));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        if (owned()) renameSync(temp, path);
      } finally {
        rmSync(temp, { force: true });
      }
    });
  } catch {
    // The check below says what is left.
  }
  return legacyCollections(path) === undefined;
}

/** A Store kept in one JSON file. Node only. It is the file adapter of agentic-identity, with a retry on a write clash. */
export function createFileStore(path: string, options: FileStoreOptions = {}): Store {
  upgradeLegacyFile(path);
  const inner = createIdentityFileStore({ ...options, path });
  /** Run one call. A file in the older layout is upgraded and the call run again: an older process may have made it since the store opened. */
  const guard = async <R>(run: () => Promise<R>): Promise<R> => {
    for (let upgraded = false; ; upgraded = true) {
      try {
        return await retried(run);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        if (HELD.test(error.message)) throw new FileStoreError("LOCKED", "the database file is locked. If no agentic-canvas process runs, remove the .lock file next to it");
        if (!NOT_A_STORE_FILE.test(error.message)) throw error;
        if (legacyCollections(path) === undefined) throw new FileStoreError("DAMAGED", "the database file is not valid JSON. Repair or remove it");
        if (upgraded || !upgradeLegacyFile(path)) throw new FileStoreError("DAMAGED", "the database file is in the older layout and could not be upgraded. Try again, and check that its folder is writable");
      }
    }
  };
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
