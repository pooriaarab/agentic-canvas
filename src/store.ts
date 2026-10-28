import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CanvasError } from "./core/board.js";

// A small local store with the shape of the `Store` port in the identity
// kernel: plain JSON docs in named collections, and a transaction. Swap it for
// that port once the package is on npm. Do not grow a second storage idea here.

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type Doc = { [key: string]: Json };

export interface StoreOps {
  get(collection: string, id: string): Promise<Doc | null>;
  put(collection: string, id: string, doc: Doc): Promise<void>;
  delete(collection: string, id: string): Promise<void>;
}
export interface BoardStore extends StoreOps {
  /** Run `fn` alone: no other transaction on this store runs at the same time. */
  transaction<R>(fn: (tx: StoreOps) => Promise<R>): Promise<R>;
}

function check(collection: string, id: string): void {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(collection)) throw new CanvasError("INVALID", `invalid collection name "${collection}"`);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new CanvasError("INVALID", `invalid id "${id.slice(0, 40)}"`);
}

export function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}

export function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

class Queue {
  private tail: Promise<unknown> = Promise.resolve();
  run<R>(fn: () => Promise<R>): Promise<R> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export function memoryStore(): BoardStore {
  const tables = new Map<string, Map<string, string>>();
  const queue = new Queue();
  const ops: StoreOps = {
    async get(collection, id) {
      check(collection, id);
      const text = tables.get(collection)?.get(id);
      return text === undefined ? null : (JSON.parse(text) as Doc);
    },
    async put(collection, id, doc) {
      check(collection, id);
      if (!tables.has(collection)) tables.set(collection, new Map());
      tables.get(collection)!.set(id, JSON.stringify(doc));
    },
    async delete(collection, id) {
      check(collection, id);
      tables.get(collection)?.delete(id);
    },
  };
  return { ...ops, transaction: (fn) => queue.run(() => fn(ops)) };
}

/** One JSON file per doc under `dir`. A lock directory keeps several processes apart. */
export function fileStore(dir: string): BoardStore {
  const queue = new Queue();
  const path = (collection: string, id: string) => {
    check(collection, id);
    return join(dir, collection, `${id}.json`);
  };
  const ops: StoreOps = {
    async get(collection, id) {
      try {
        return JSON.parse(await readFile(path(collection, id), "utf8")) as Doc;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        if (error instanceof SyntaxError) throw new CanvasError("INVALID", `stored doc "${id}" is damaged`);
        throw error;
      }
    },
    async put(collection, id, doc) {
      const file = path(collection, id);
      await mkdir(join(dir, collection), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(doc));
      await rename(temp, file);
    },
    async delete(collection, id) {
      await rm(path(collection, id), { force: true });
    },
  };
  const lock = join(dir, ".lock");
  async function locked<R>(fn: () => Promise<R>): Promise<R> {
    await mkdir(dir, { recursive: true });
    for (let waited = 0; ; waited += 20) {
      try {
        await mkdir(lock);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (waited >= 10_000) throw new CanvasError("UNAVAILABLE", `store is locked: remove ${lock} if no other process runs`);
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    try {
      return await fn();
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }
  return { ...ops, transaction: (fn) => queue.run(() => locked(() => fn(ops))) };
}
