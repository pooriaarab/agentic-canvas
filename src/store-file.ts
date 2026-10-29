import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { link, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { FileStoreError } from "./store-errors.js";
import { assertCollection, assertId, createMemoryStore, parseRegion, StoreConflictError, type AdapterOptions, type Doc, type Query, type Store, type StoreOps } from "agentic-identity";

/** The file as it sits in memory: collection, then id. A Map, so an id such as "constructor" is plain data. */
type Snapshot = Map<string, Map<string, Doc>>;
type Change = [collection: string, id: string, doc: Doc | null];

const MAX_TRANSACTION_RUNS = 50;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export { FileStoreError };

export interface FileStoreOptions extends AdapterOptions {
  /** How long a write waits for the lock before it fails. Defaults to 10000. */
  lockTimeoutMs?: number;
  /** A lock older than this is stale, if its owner is alive. Defaults to 30000. */
  staleAfterMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return codeOf(error) === "EPERM";
  }
}

/**
 * A lock is stale only when its content is well formed and its owner is gone or it is old.
 * Content that does not parse, or has a bad pid or time, counts as a LIVE lock: never take it.
 */
function lockIsStale(text: string, staleAfterMs: number): boolean {
  let held: { pid?: unknown; at?: unknown };
  try {
    held = JSON.parse(text) as typeof held;
  } catch {
    return false;
  }
  if (typeof held !== "object" || held === null) return false;
  const { pid, at } = held;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1 || typeof at !== "number" || !Number.isFinite(at)) return false;
  return !processIsAlive(pid) || Date.now() - at > staleAfterMs;
}

/**
 * A Store kept in one JSON file. Node only. It is an adapter of the shared Store port and passes `runStoreContract`. Many processes may share the file, for example the CLI
 * and the MCP server. Each write takes a lock file, reads the file again, applies the change, and
 * replaces the file by an atomic rename. A read sees the last renamed file, so it takes no lock.
 * Each call reads the whole file and loads the docs it needs into the shared memory adapter, which runs the
 * queries and the transaction rules. Cost grows with the file. Use it for local work, not for scale.
 * The lock needs one machine: the process check and the clock do not work across hosts.
 */
export function createFileStore(path: string, options: FileStoreOptions = {}): Store {
  const region = parseRegion(options.region ?? "unknown");
  const lockPath = `${path}.lock`;
  const timeoutMs = options.lockTimeoutMs ?? 10_000;
  const staleAfterMs = options.staleAfterMs ?? 30_000;
  // NaN or a string would make the lock wait never end, so refuse them here.
  for (const ms of [timeoutMs, staleAfterMs]) if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) throw new TypeError("lockTimeoutMs and staleAfterMs must be finite numbers of 0 or more");
  let queue: Promise<unknown> = Promise.resolve();

  async function load(): Promise<Snapshot> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (codeOf(error) === "ENOENT") return new Map();
      throw error;
    }
    try {
      const data: unknown = JSON.parse(text);
      if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error();
      return new Map(
        Object.entries(data).map(([name, docs]) => {
          if (typeof docs !== "object" || docs === null || Array.isArray(docs)) throw new Error();
          // A doc that is not an object would read as a missing doc. Fail closed instead.
          for (const doc of Object.values(docs)) if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new Error();
          return [name, new Map(Object.entries(docs as Record<string, Doc>))];
        }),
      );
    } catch {
      // Never replace a file that does not parse: that would erase data an operator may repair.
      throw new FileStoreError("DAMAGED", `the database file is not valid JSON. Repair or remove it`);
    }
  }

  async function save(snapshot: Snapshot): Promise<void> {
    const text = JSON.stringify(Object.fromEntries([...snapshot].map(([name, docs]) => [name, Object.fromEntries(docs)])));
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, "w");
      try {
        await handle.writeFile(text);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, path);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }

  /** Move a stale lock aside. Put it back if it changed hands in the meantime. */
  async function takeOverIfStale(): Promise<void> {
    let seen: string;
    try {
      seen = await readFile(lockPath, "utf8");
    } catch {
      return;
    }
    if (!lockIsStale(seen, staleAfterMs)) return;
    const aside = `${lockPath}.stale.${randomUUID()}`;
    try {
      await rename(lockPath, aside);
    } catch {
      return;
    }
    if ((await readFile(aside, "utf8").catch(() => "")) !== seen) await link(aside, lockPath).catch(() => undefined);
    await unlink(aside).catch(() => undefined);
  }

  async function acquire(): Promise<string> {
    const token = randomUUID();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const handle = await open(lockPath, "wx");
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now(), token }));
        } finally {
          await handle.close();
        }
        return token;
      } catch (error) {
        if (codeOf(error) !== "EEXIST") throw error;
      }
      await takeOverIfStale();
      if (Date.now() > deadline) throw new FileStoreError("LOCKED", `the database file is locked. If no agentic-canvas process runs, remove the .lock file next to it`);
      await sleep(5 + Math.random() * 15);
    }
  }

  async function release(token: string): Promise<void> {
    // Remove the lock only if it is still ours. A takeover may have replaced it.
    const text = await readFile(lockPath, "utf8").catch(() => "");
    if (text.includes(`"token":"${token}"`)) await unlink(lockPath).catch(() => undefined);
  }

  /** A memory store that holds the named collections of the file, or all of them. */
  async function memoryOf(snapshot: Snapshot, only?: string): Promise<Store> {
    const memory = createMemoryStore({ region });
    for (const [name, docs] of snapshot) if (only === undefined || only === name) for (const [id, doc] of docs) await memory.put(name, id, doc);
    return memory;
  }

  /** Pass each write through to `inner`, which checks it, and keep it in `log`. */
  const recording = (inner: StoreOps, log: Change[]): StoreOps => ({
    get: (collection, id) => inner.get(collection, id),
    query: (collection, query) => inner.query(collection, query),
    put: async (collection, id, doc) => {
      await inner.put(collection, id, doc);
      log.push([collection, id, clone(doc)]);
    },
    delete: async (collection, id) => {
      await inner.delete(collection, id);
      log.push([collection, id, null]);
    },
  });

  /** Run `body` with the lock held, one at a time in this process. */
  const locked = <R>(body: () => Promise<R>): Promise<R> => {
    const run = queue.then(async () => {
      const token = await acquire();
      try {
        return await body();
      } finally {
        await release(token);
      }
    });
    queue = run.catch(() => undefined);
    return run;
  };

  /** Apply the writes to the file as it is now, and save it if anything changed. */
  async function commit(snapshot: Snapshot, log: Change[]): Promise<void> {
    for (const [name, id, doc] of log) {
      if (doc === null) snapshot.get(name)?.delete(id);
      else snapshot.set(name, (snapshot.get(name) ?? new Map()).set(id, doc));
    }
    if (log.length > 0) await save(snapshot);
  }

  /** One write: the empty memory store checks the names and the doc, then the file takes it under the lock. */
  const writeOne = (write: (ops: StoreOps) => Promise<void>): Promise<void> =>
    locked(async () => {
      const log: Change[] = [];
      await write(recording(createMemoryStore({ region }), log));
      await commit(await load(), log);
    });

  /** Remember what a transaction read, as the doc text, so a commit can tell if another store changed it. */
  const watching = (inner: StoreOps, seen: Map<string, string>): StoreOps => ({
    ...inner,
    async get(collection, id) {
      const doc = await inner.get(collection, id);
      if (!seen.has(`${collection}/${id}`)) seen.set(`${collection}/${id}`, JSON.stringify(doc));
      return doc as never;
    },
    async query(collection, query) {
      const page = await inner.query(collection, query);
      for (const item of page.items) if (!seen.has(`${collection}/${item.id}`)) seen.set(`${collection}/${item.id}`, JSON.stringify(item.data));
      return page as never;
    },
  });

  const unchanged = (snapshot: Snapshot, seen: Map<string, string>): boolean =>
    [...seen].every(([key, text]) => {
      const slash = key.indexOf("/");
      return JSON.stringify(snapshot.get(key.slice(0, slash))?.get(key.slice(slash + 1)) ?? null) === text;
    });

  return {
    region,
    async get<T extends Doc>(collection: string, id: string) {
      assertCollection(collection);
      assertId(id);
      const doc = (await load()).get(collection)?.get(id);
      return doc ? (clone(doc) as T) : null;
    },
    async query<T extends Doc>(collection: string, query?: Query) {
      assertCollection(collection);
      return (await memoryOf(await load(), collection)).query<T>(collection, query);
    },
    put: (collection, id, doc) => writeOne((ops) => ops.put(collection, id, doc)),
    delete: (collection, id) => writeOne((ops) => ops.delete(collection, id)),
    // Optimistic, as the port requires: run on a copy of the file with no lock, then take the lock and commit
    // only if every doc the run read is unchanged. Else run again. The memory adapter keeps the rule that
    // every read comes before the first write.
    async transaction(fn) {
      for (let run = 0; run < MAX_TRANSACTION_RUNS; run++) {
        const log: Change[] = [];
        const seen = new Map<string, string>();
        const result = await (await memoryOf(await load())).transaction(async (tx) => {
          log.length = 0;
          seen.clear();
          return fn(watching(recording(tx, log), seen));
        });
        const done = log.length === 0 ? unchanged(await load(), seen) : await locked(async () => {
          const current = await load();
          if (!unchanged(current, seen)) return false;
          await commit(current, log);
          return true;
        });
        if (done) return result;
      }
      throw new StoreConflictError();
    },
  };
}

/** The store the CLI and the MCP server share: one file in `dir`, which is made if it is missing. */
export function openLocalStore(dir: string): Store {
  mkdirSync(dir, { recursive: true });
  return createFileStore(join(dir, STORE_FILE));
}

export const STORE_FILE = "canvas.json";
