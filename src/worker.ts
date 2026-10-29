import { parseRegion, type Blobs, type Region } from "agentic-identity";
import { createD1Store, createR2Blobs, D1_SCHEMA, type D1Like, type R2Like } from "agentic-identity/cloudflare";
import { Hono, type Context } from "hono";
import { CanvasError, type ErrorCode } from "./core/board.js";
import { principalSchema, type Principal } from "./core/principal.js";
import { CanvasService } from "./service.js";

export interface WorkerEnv {
  DB: D1Like;
  IMAGES: R2Like;
  /**
   * JSON: `{ "<token>": { "actor": "ada", "kind": "human" } }`. A token has 32 characters or more.
   * A grant needs an actor id and a kind. A token with a missing or bad part gets 401.
   * Without this setting, every request gets 401. Every token reaches every board.
   */
  CANVAS_API_TOKENS?: string;
  /**
   * "eu", "us", or "unknown": where the database and the bucket live. A real D1 reports where it served a query, and the
   * store refuses to serve if that is outside the claim. Local `wrangler dev` reports nothing, so it needs "unknown".
   * Without a valid value, every request gets 503.
   */
  CANVAS_REGION?: string;
  /** The largest image in bytes. Defaults to 1000000. */
  CANVAS_MAX_IMAGE_BYTES?: string;
}

const MIN_TOKEN_LENGTH = 32;
const DEFAULT_MAX_IMAGE_BYTES = 1_000_000;
const MAX_JSON_BYTES = 1_000_000;
type App = { Bindings: WorkerEnv; Variables: { service: CanvasService; blobs: Blobs; actor: Principal } };

const STATUS: Record<ErrorCode, number> = {
  INVALID: 422, DUPLICATE_ID: 409, NOT_FOUND: 404, BAD_REFERENCE: 422, LIMIT: 422, UNAVAILABLE: 503, FORBIDDEN: 403,
};

const fail = (code: string, message: string, status: number) =>
  new Response(JSON.stringify({ error: { code, message } }), { status, headers: { "content-type": "application/json" } });

function sameText(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** The principal for a bearer token, or null. The kind is never defaulted: a grant without a valid kind gets null. */
export function authenticate(request: Request, env: WorkerEnv): Principal | null {
  const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token || !env.CANVAS_API_TOKENS) return null;
  let grants: unknown;
  try {
    grants = JSON.parse(env.CANVAS_API_TOKENS);
  } catch {
    return null;
  }
  if (typeof grants !== "object" || grants === null || Array.isArray(grants)) return null;
  let found: unknown;
  for (const [candidate, grant] of Object.entries(grants)) {
    if (sameText(candidate, token) && candidate.length >= MIN_TOKEN_LENGTH) found = grant;
  }
  if (typeof found !== "object" || found === null) return null;
  const { actor, kind } = found as Record<string, unknown>;
  const parsed = principalSchema.safeParse({ kind, id: actor });
  return parsed.success ? parsed.data : null;
}

/** The image types we accept, found by their first bytes. The client's claim of a type is not trusted. */
export function sniffImage(bytes: Uint8Array): string | null {
  const at = (offset: number, ...sig: number[]) => sig.every((b, i) => bytes[offset + i] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const IMAGE_ID = /^[0-9a-f]{64}$/;

/** The database is ready once its table exists. The check runs once per binding. */
const schemas = new WeakMap<object, Promise<unknown>>();

async function ready(db: D1Like): Promise<void> {
  let run = schemas.get(db);
  if (!run) {
    run = db.prepare(D1_SCHEMA).run().catch((error: unknown) => {
      schemas.delete(db);
      throw error;
    });
    schemas.set(db, run);
  }
  await run;
}

/** Read a body, and stop as soon as it passes `max` bytes. Returns null for a body that is too big. */
async function readLimited(request: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) bytes.set(chunk, (at += chunk.byteLength) - chunk.byteLength);
  return bytes;
}

async function jsonBody(c: Context<App>): Promise<Record<string, unknown>> {
  const bytes = await readLimited(c.req.raw, MAX_JSON_BYTES);
  if (!bytes) throw new CanvasError("INVALID", `the body must be at most ${MAX_JSON_BYTES} bytes`);
  let body: unknown;
  try {
    body = bytes.byteLength === 0 ? {} : JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new CanvasError("INVALID", "the body must be a JSON object");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new CanvasError("INVALID", "the body must be a JSON object");
  return body as Record<string, unknown>;
}

const text = (value: unknown, name: string): string => {
  if (typeof value !== "string") throw new CanvasError("INVALID", `${name} must be a string`);
  return value;
};
const num = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new CanvasError("INVALID", `${name} must be a number`);
  return value;
};

/**
 * What may reach a log: the known store failures, cut short. Any other message could hold a caller's
 * input, such as an id, so only the error type is written.
 */
const LOGGABLE = /^(D1_ERROR[^"]{0,150}|transaction kept conflicting)/;
/** Failures of D1 and R2 that pass by themselves. Any other failure is a bug or a bad setup: it is a 500, not a reason to retry. */
const TEMPORARY = /commit token|busy|locked|reset|overloaded|time ?out|timed out|temporar|unspecified error|network/i;
const loggable = (error: unknown): string => (error instanceof Error ? (LOGGABLE.exec(error.message)?.[0] ?? error.name) : "unknown");

export function createApp(): Hono<App> {
  const app = new Hono<App>();
  app.get("/health", (c) => c.json({ ok: true }));

  const api = new Hono<App>();
  api.use("*", async (c, next) => {
    let region: Region;
    try {
      region = parseRegion(c.env.CANVAS_REGION ?? "");
    } catch {
      return fail("NOT_CONFIGURED", 'set CANVAS_REGION to "eu", "us", or "unknown"', 503);
    }
    if (!c.env.DB || !c.env.IMAGES) return fail("NOT_CONFIGURED", "bind DB (D1) and IMAGES (R2)", 503);
    const actor = authenticate(c.req.raw, c.env);
    if (!actor) return fail("UNAUTHORIZED", "send a valid bearer token", 401);
    c.set("actor", actor);
    await ready(c.env.DB);
    c.set("service", new CanvasService(createD1Store(c.env.DB, { region })));
    // The Worker serves image bytes itself and never makes a signed URL, so this secret signs nothing. It must exist, and it is new each time.
    c.set("blobs", createR2Blobs(c.env.IMAGES, { region, urlBase: new URL(c.req.url).origin, urlSecret: `${crypto.randomUUID()}${crypto.randomUUID()}` }));
    await next();
  });

  api.post("/boards", async (c) => {
    const b = await jsonBody(c);
    const id = b.id === undefined ? undefined : text(b.id, "id");
    const title = b.title === undefined ? undefined : text(b.title, "title");
    return c.json(await c.var.service.create(c.var.actor, { id, title }), 201);
  });
  api.get("/boards/:id", async (c) => c.json(await c.var.service.read(c.req.param("id"))));
  api.get("/boards/:id/svg", async (c) =>
    new Response(await c.var.service.exportSvg(c.req.param("id")), { headers: { "content-type": "image/svg+xml", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:" } }));
  api.post("/boards/:id/shapes", async (c) => c.json(await c.var.service.add(c.req.param("id"), await jsonBody(c), c.var.actor), 201));
  api.post("/boards/:id/connectors", async (c) => c.json(await c.var.service.connect(c.req.param("id"), await jsonBody(c), c.var.actor), 201));
  api.post("/boards/:id/flow", async (c) => c.json(await c.var.service.flow(c.req.param("id"), text((await jsonBody(c)).text, "text"), c.var.actor)));
  api.post("/boards/:id/move", async (c) => {
    const b = await jsonBody(c);
    return c.json(await c.var.service.move(c.req.param("id"), text(b.element, "element"), num(b.dx, "dx"), num(b.dy, "dy"), c.var.actor));
  });
  api.delete("/boards/:id/elements/:element", async (c) => {
    const removed = await c.var.service.remove(c.req.param("id"), c.req.param("element"));
    // The board keeps no record of a delete, so the Worker logs who did it. Only the kind: ids and names stay out of logs.
    console.log(JSON.stringify({ level: "info", op: "remove", actorKind: c.var.actor.kind }));
    return c.json(removed);
  });

  // An image is stored under the SHA-256 of its bytes. The same bytes make the same ref, and a second upload changes nothing.
  api.post("/images", async (c) => {
    const max = Number(c.env.CANVAS_MAX_IMAGE_BYTES ?? DEFAULT_MAX_IMAGE_BYTES);
    if (!Number.isFinite(max) || max < 0) return fail("NOT_CONFIGURED", "CANVAS_MAX_IMAGE_BYTES must be a number of 0 or more", 503);
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > max) return fail("TOO_LARGE", `the image is over the limit of ${max} bytes`, 413);
    const bytes = await readLimited(c.req.raw, max);
    if (!bytes) return fail("TOO_LARGE", `the image is over the limit of ${max} bytes`, 413);
    const type = sniffImage(bytes);
    if (!type) return fail("UNSUPPORTED_TYPE", "the image must be PNG, JPEG, GIF, or WebP", 415);
    const id = hex(await crypto.subtle.digest("SHA-256", bytes));
    let stored: { version: string } | null;
    try {
      stored = await c.var.blobs.put(id, bytes, { contentType: type, ifNoneMatch: "*" });
    } catch (error) {
      console.error(JSON.stringify({ level: "error", message: loggable(error) }));
      // The bucket may fail for a moment, for example when two writes race. Nothing was stored, so the caller may try again.
      if (error instanceof Error && TEMPORARY.test(error.message)) return fail("UNAVAILABLE", "the image store is busy. Try again", 503);
      throw error;
    }
    return c.json({ id, ref: `blob:${id}`, type, size: bytes.byteLength, created: stored !== null }, stored ? 201 : 200);
  });
  api.get("/images/:id", async (c) => {
    const id = c.req.param("id");
    const blob = IMAGE_ID.test(id) ? await c.var.blobs.get(id) : null;
    if (!blob) return fail("NOT_FOUND", "no such image", 404);
    return new Response(blob.data as BodyInit, { headers: { "content-type": blob.contentType ?? "application/octet-stream", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "content-disposition": "attachment", "cache-control": "private, no-store" } });
  });

  app.route("/api/v1/canvas", api);
  app.notFound(() => fail("NOT_FOUND", "no such route", 404));
  app.onError((error) => {
    if (error instanceof Error && error.message.startsWith("D1_ERROR")) {
      console.error(JSON.stringify({ level: "error", message: loggable(error) }));
      // A value over the D1 limit never succeeds, so it is no reason to try again.
      if (/too big|too large/i.test(error.message)) return fail("LIMIT", "the board is too big to store", 422);
      if (TEMPORARY.test(error.message)) return fail("UNAVAILABLE", "the database is busy. Try again", 503);
    }
    if (error instanceof CanvasError) return fail(error.code, error.message, STATUS[error.code]);
    console.error(JSON.stringify({ level: "error", message: loggable(error) }));
    return fail("INTERNAL", "the server could not finish the request", 500);
  });
  return app;
}

const app = createApp();
export default { fetch: (request: Request, env: WorkerEnv, ctx: unknown) => app.fetch(request, env, ctx as never) };
