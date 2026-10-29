import { createStoreAuth, hasScope, parsePrincipal, parseRegion, type Action, type Auth, type Blobs, type PrincipalContext, type Region, type Store } from "agentic-identity";
import type { Realtime } from "agentic-realtime";
import { createD1Store, createR2Blobs, D1_SCHEMA, type D1Like, type R2Like } from "agentic-identity/cloudflare";
import { acceptWebSocketProtocol, principalFromWebSocketRequest } from "agentic-identity/http";
import { Hono, type Context } from "hono";
import { CanvasAccess } from "./access.js";
import { CanvasError, type ErrorCode } from "./core/board.js";
import type { Principal } from "./core/principal.js";
import { forget, handSave, pull, roomAuthors, seed, SEEDER } from "./room-sync.js";
import { CanvasService, MAX_LIVE_BYTES } from "./service.js";

export interface WorkerEnv {
  DB: D1Like;
  IMAGES: R2Like;
  /**
   * Dev fallback. Set it to "1" to let `CANVAS_API_TOKENS` sign requests in. Without it, `CANVAS_API_TOKENS` is not read,
   * and a request that sets it gets 503, so a deploy never trusts a static list by accident. Never set it in production.
   */
  CANVAS_UNSAFE_STATIC_TOKENS?: string;
  /**
   * Dev fallback, read only when `CANVAS_UNSAFE_STATIC_TOKENS` is "1". It is tried after the identity credentials.
   * JSON: `{ "<token>": { "actor": "ada", "kind": "human", "role": "viewer" } }`. A token has 32 characters or more.
   * A grant needs an actor id and a kind. A token with a missing or bad part gets 401.
   * The role is "editor" (the default) or "viewer". A viewer reads and cannot write, over HTTP or in a live room.
   * Every token reaches every board, and a token cannot be revoked without a new deploy.
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
export type Role = "editor" | "viewer";
/** The caller. `dev` is true for a token of the static list: it holds no board roles and reaches every board. */
export interface Caller {
  actor: Principal;
  role: Role;
  principal: PrincipalContext;
  dev: boolean;
}
type App = { Bindings: WorkerEnv; Variables: { service: CanvasService; access: CanvasAccess; blobs: Blobs; actor: Principal; role: Role; caller: Caller } };

export interface AppOptions {
  /** Makes the live-room server from the Worker bindings. Without it, the ws route answers 404. */
  live?: (env: WorkerEnv) => Realtime;
}

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

/** A browser cannot set a header on a WebSocket. It offers the sub-protocols `agentic-canvas` and `agentic-canvas.bearer.<token in base64url>`. */
export const WS_PROTOCOL = "agentic-canvas";

/** The token table as an `Auth` port. A viewer holds `canvas:read`. An editor holds `canvas:read` and `canvas:write`. */
function tokenAuth(env: WorkerEnv): Auth {
  return {
    async authenticate(request) {
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
      const { actor, kind, role = "editor" } = found as Record<string, unknown>;
      let step: Principal;
      try {
        step = parsePrincipal({ kind, id: actor });
      } catch {
        return null;
      }
      // A role that is not one we know denies the token. It never falls back to editor.
      // The id of the room's own seeder is taken: a token under it would pass for the Worker in a room's list of authors.
      if (step.kind === SEEDER.kind && step.id === SEEDER.id) return null;
      if (role !== "editor" && role !== "viewer") return null;
      return { principalId: step.id, kind: step.kind, chain: [step], scopes: role === "viewer" ? ["canvas:read"] : ["canvas:read", "canvas:write"] };
    },
  };
}

const staticTokensOn = (env: WorkerEnv) => env.CANVAS_UNSAFE_STATIC_TOKENS === "1";

/** The default: credentials and principals in the Store (agentic-identity). The static list, when it is on, is tried after them. */
function workerAuth(env: WorkerEnv, store?: Store): { auth: Auth; failure(): unknown; dev(): boolean } {
  const auths: Auth[] = [];
  if (store) auths.push(createStoreAuth(store));
  const devAuth = staticTokensOn(env) ? tokenAuth(env) : undefined;
  if (devAuth) auths.push(devAuth);
  let dev = false;
  // The http helper turns a throw into a 401. A store that fails is no wrong credential: keep the error so the caller can raise it.
  let failure: unknown;
  const auth: Auth = {
    async authenticate(request) {
      for (const auth of auths) {
        let found: Awaited<ReturnType<Auth["authenticate"]>>;
        try {
          found = await auth.authenticate(request);
        } catch (error) {
          failure = error;
          return null;
        }
        if (!found) continue;
        dev = auth === devAuth;
        // The kind and the id must pass the principal rules. The room's own seeder name is never a caller.
        let step: Principal;
        try {
          step = parsePrincipal({ kind: found.kind, id: found.principalId });
        } catch {
          return null;
        }
        if (step.kind === SEEDER.kind && step.id === SEEDER.id) return null;
        return found;
      }
      return null;
    },
  };
  return { auth, failure: () => failure, dev: () => dev };
}

/**
 * The principal and role for a request, or null. A credential issued by agentic-identity (a bearer key or an access token in the
 * store) signs in. Its scopes set the role: `canvas:write` is an editor, `canvas:read` a viewer, and none is denied.
 * The static list signs in only with `CANVAS_UNSAFE_STATIC_TOKENS=1`. The kind is never defaulted: a principal without a valid kind gets null.
 * Without `store` only the static list is read.
 */
export async function authenticate(request: Request, env: WorkerEnv, store?: Store): Promise<{ actor: Principal; role: Role } | null> {
  const found = await identify(request, env, store);
  return found && { actor: found.actor, role: found.role };
}

/** Like `authenticate`, with the whole principal context that board roles are checked against. */
export async function identify(request: Request, env: WorkerEnv, store?: Store): Promise<Caller | null> {
  const { auth, failure, dev } = workerAuth(env, store);
  const found = await principalFromWebSocketRequest(request, auth, { protocol: WS_PROTOCOL, scope: "canvas:read" });
  // A store that failed is a 503 or a 500, never a 401: the caller must not think its credential is wrong.
  if (failure() !== undefined) throw failure();
  if (found instanceof Response) return null;
  return { actor: { kind: found.kind, id: found.principalId }, role: hasScope(found.scopes, "canvas:write") ? "editor" : "viewer", principal: found, dev: dev() };
}

const svgResponse = (svg: string) =>
  new Response(svg, { headers: { "content-type": "image/svg+xml", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:" } });

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

export function createApp(options: AppOptions = {}): Hono<App> {
  const app = new Hono<App>();
  app.get("/health", (c) => c.json({ ok: true }));

  // The store, or the answer that stops the request: the Worker is not set up, or the database is not ready.
  const open = async (c: Context): Promise<Store | Response> => {
    let region: Region;
    try {
      region = parseRegion(c.env.CANVAS_REGION ?? "");
    } catch {
      return fail("NOT_CONFIGURED", 'set CANVAS_REGION to "eu", "us", or "unknown"', 503);
    }
    if (!c.env.DB || !c.env.IMAGES) return fail("NOT_CONFIGURED", "bind DB (D1) and IMAGES (R2)", 503);
    // A static list that is set but not switched on is a setup mistake. Refuse it loudly: it never signs anyone in.
    if (c.env.CANVAS_API_TOKENS && !staticTokensOn(c.env)) return fail("NOT_CONFIGURED", "CANVAS_API_TOKENS is a dev fallback. Set CANVAS_UNSAFE_STATIC_TOKENS=1 to use it, or remove it and issue agentic-identity credentials", 503);
    await ready(c.env.DB);
    return createD1Store(c.env.DB, { region });
  };

  // A visitor with a link token reads one board. It sits before the bearer check of `api`, so that check does not run here.
  // A bearer token, if one is sent, must be valid. The link token is in `x-link-token`.
  const shared = new Hono<App>();
  const visit = async (c: Context<App>, route: (service: CanvasService) => Promise<Response>) => {
    const store = await open(c);
    if (store instanceof Response) return store;
    const who = await identify(c.req.raw, c.env, store);
    if (!who && c.req.header("authorization")) return fail("UNAUTHORIZED", "send a valid bearer token", 401);
    const id = c.req.param("id")!;
    await new CanvasAccess(store).require(who?.principal ?? null, "read", id, c.req.header("x-link-token") ?? "");
    return route(new CanvasService(store));
  };
  shared.get("/:id", (c) => visit(c, async (service) => c.json(await service.read(c.req.param("id")!))));
  shared.get("/:id/svg", (c) => visit(c, async (service) => svgResponse(await service.exportSvg(c.req.param("id")!))));
  app.route("/api/v1/canvas/shared", shared);

  const api = new Hono<App>();
  api.use("*", async (c, next) => {
    const store = await open(c);
    if (store instanceof Response) return store;
    const who = await identify(c.req.raw, c.env, store);
    if (!who) return fail("UNAUTHORIZED", "send a valid bearer token", 401);
    // Accepting an invite writes no board: a read-only credential may still take its share.
    if (who.role === "viewer" && c.req.method !== "GET" && !(c.req.method === "POST" && c.req.path === "/api/v1/canvas/invites/accept")) return fail("FORBIDDEN", "this token is a viewer; it cannot change a board", 403);
    c.set("actor", who.actor);
    c.set("role", who.role);
    c.set("caller", who);
    c.set("service", new CanvasService(store));
    c.set("access", new CanvasAccess(store));
    // The Worker serves image bytes itself and never makes a signed URL, so this secret signs nothing. It must exist, and it is new each time.
    c.set("blobs", createR2Blobs(c.env.IMAGES, { region: parseRegion(c.env.CANVAS_REGION ?? ""), urlBase: new URL(c.req.url).origin, urlSecret: `${crypto.randomUUID()}${crypto.randomUUID()}` }));
    await next();
  });

  // Who the token stands for. A live client reads its actor here, so it never claims one.
  api.get("/me", (c) => c.json({ actor: c.var.actor.id, kind: c.var.actor.kind, role: c.var.role }));

  // A room and the Store hold one board. Before a request reads or changes a board, the Worker saves the room to the Store,
  // so a board read or write sees what the room has. Live rooms only. A room that fails its checks is skipped: it must not lock the board.
  const saveRoom = async (c: Context<App>, seeding: boolean) => {
    if (!options.live) return;
    const id = c.req.param("id")!;
    await c.var.service.assertExists(id);
    const live = options.live(c.env);
    // A failed save is logged and skipped: a bad room must not lock the board. A failed seed refuses the join, because a client
    // that joins a room without the stored board would see a board with parts missing and could draw over it.
    await pull(live, c.var.service, id).catch((error: unknown) => console.error(JSON.stringify({ level: "error", op: "save-room", message: loggable(error) })));
    if (seeding) {
      await seed(live, c.var.service, id).catch((error: unknown) => {
        console.error(JSON.stringify({ level: "error", op: "seed-room", message: loggable(error) }));
        throw error instanceof CanvasError ? error : new CanvasError("UNAVAILABLE", "the room could not take the stored board. Try again");
      });
    }
  };
  const sync = async (c: Context<App>, next: () => Promise<void>) => {
    if (!/\/(ws|checkpoint)$/.test(new URL(c.req.url).pathname)) {
      // A delete that finishes an earlier delete finds no board. It has no room to save.
      await saveRoom(c, false).catch((error: unknown) => {
        if (!(c.req.method === "DELETE" && error instanceof CanvasError && error.code === "NOT_FOUND")) throw error;
      });
    }
    await next();
  };
  // The role a route needs on its board. This runs before the room is saved, so a stranger learns nothing from the cost of a request.
  // A token of the static dev list holds no board roles and passes.
  const ADMIN = new Set(["access", "grants", "invites", "links"]);
  const WRITE = new Set(["shapes", "connectors", "flow", "move", "elements", "checkpoint"]);
  // A route that is not listed fails closed: a read needs read, and any other method needs write.
  const needs = (method: string, path: string): Action => {
    // The router matches the decoded path, so the gate reads that one. A path that does not decode needs the highest role.
    let decoded: string;
    try {
      decoded = decodeURI(path);
    } catch {
      return "admin";
    }
    const part = decoded.split("/boards/")[1]!.split("/");
    if (part.length === 1) return method === "DELETE" ? "admin" : method === "GET" ? "read" : "write";
    if (ADMIN.has(part[1]!)) return "admin";
    return WRITE.has(part[1]!) || method !== "GET" ? "write" : "read";
  };
  api.use("/boards/:id/*", async (c, next) => {
    if (!c.var.caller.dev) await c.var.access.require(c.var.caller.principal, needs(c.req.method, new URL(c.req.url).pathname), c.req.param("id")!);
    await next();
  });
  api.use("/boards/:id/*", sync);

  // The live room. The token sets the actor, the kind, and the role. The room opens only for a board that exists.
  // A viewer joins and reads, and the room drops its writes.
  api.get("/boards/:id/ws", async (c) => {
    if (!options.live) return fail("NOT_FOUND", "this server hosts no live rooms", 404);
    if (c.req.header("upgrade") !== "websocket") return fail("UPGRADE_REQUIRED", "open this route as a WebSocket", 426);
    const id = c.req.param("id");
    // Save the room, then give it any part of the stored board that it lacks, so a client that joins needs no seed of its own.
    await saveRoom(c, true);
    const { actor, caller } = c.var;
    // The room holds a reader to reading. An editor or owner on this board writes.
    const role: Role = caller.dev ? c.var.role : (await c.var.access.allowed(caller.principal, "write", id)) ? "editor" : "viewer";
    const opened = await options.live(c.env).connect(id, c.req.raw, { principal: { id: actor.id, kind: actor.kind }, role, name: actor.id });
    // A browser closes a socket whose answer does not pick one of the sub-protocols it offered.
    return acceptWebSocketProtocol(c.req.raw, opened, WS_PROTOCOL);
  });

  // A client may read the stored board here and post a room back. The Worker does both itself now. These stay for clients that save by hand, and are sync plumbing, not board commands.
  // Without live rooms these routes answer 404, so a plain Worker has no raw-Yjs write path.
  api.get("/boards/:id/state", async (c) => !options.live ? fail("NOT_FOUND", "this server hosts no live rooms", 404) : c.body(new Uint8Array(await c.var.service.state(c.req.param("id"))), 200, { "content-type": "application/octet-stream" }));
  api.post("/boards/:id/checkpoint", async (c) => {
    if (!options.live) return fail("NOT_FOUND", "this server hosts no live rooms", 404);
    const id = c.req.param("id");
    // Ask the room who wrote only for a board that exists. The room would make a Durable Object for any id.
    await c.var.service.assertExists(id);
    const update = await readLimited(c.req.raw, MAX_LIVE_BYTES);
    if (!update) throw new CanvasError("INVALID", `the update must be at most ${MAX_LIVE_BYTES} bytes`);
    return c.json(await handSave(options.live(c.env), c.var.service, id, update, c.var.actor));
  });

  // A person or agent sees the boards it holds a role on. The static dev list sees all.
  api.get("/boards", async (c) => c.json({ boards: c.var.caller.dev ? await c.var.service.list() : await c.var.service.summaries(await c.var.access.readable(c.var.caller.principal)) }));

  api.post("/boards", async (c) => {
    const b = await jsonBody(c);
    const id = b.id === undefined ? undefined : text(b.id, "id");
    const title = b.title === undefined ? undefined : text(b.title, "title");
    // A dev-list token cannot take an id that still has sharing records: the old owners would reach the new board.
    if (c.var.caller.dev && id !== undefined && (await c.var.access.registered(id))) throw new CanvasError("DUPLICATE_ID", `board "${id}" already exists`);
    const created = await c.var.service.create(c.var.actor, { id, title });
    if (!c.var.caller.dev) {
      // The creator owns the board. A board that fails to register is removed, so none is left that nobody can reach.
      await c.var.access.register(c.var.caller.principal, created.id).catch(async (error: unknown) => {
        await c.var.service.delete(created.id).catch((failed: unknown) => console.error(JSON.stringify({ level: "error", op: "undo-create", message: loggable(failed) })));
        throw error;
      });
    }
    return c.json(created, 201);
  });
  api.get("/boards/:id", async (c) => c.json(await c.var.service.read(c.req.param("id"))));
  // `sync` saves the room first, and a room that fails its checks is skipped, so its unsaved edits may be lost here.
  // The room is erased, then the board. The room is erased again after the delete: a client that joined in between
  // would have seeded it from the stored board, and a new board of the same id must not refill from it.
  // If the first erase fails, the board stays.
  // The sharing records go last, and the erase of them may fail (for example, a board with over 100 owners). The board is gone
  // by then, so the owner may call delete again: it finishes the cleanup. A token of the dev list never deletes a board that has owners.
  api.delete("/boards/:id", async (c) => {
    const id = c.req.param("id");
    const { dev, principal } = c.var.caller;
    if (dev && (await c.var.access.registered(id))) throw new CanvasError("FORBIDDEN", "this board has owners: only an owner deletes it");
    const present = await c.var.service.assertExists(id).then(() => true, (error: unknown) => {
      if (error instanceof CanvasError && error.code === "NOT_FOUND" && !dev) return false;
      throw error;
    });
    const live = options.live?.(c.env);
    if (live) await live.erase(id);
    const deleted = present ? await c.var.service.delete(id) : { deleted: id };
    if (!dev) await c.var.access.unregister(principal, id);
    if (live) {
      await live.erase(id);
      forget(id);
    }
    console.log(JSON.stringify({ level: "info", op: "delete-board", actorKind: c.var.actor.kind }));
    return c.json(deleted);
  });
  api.get("/boards/:id/svg", async (c) => svgResponse(await c.var.service.exportSvg(c.req.param("id"))));

  // Sharing. Only an owner of the board shares it (the gate above). A link lists without its token: a token shows once.
  api.get("/boards/:id/access", async (c) => c.json(await c.var.access.list(c.var.caller.principal, c.req.param("id"))));
  api.post("/boards/:id/grants", async (c) => {
    const id = c.req.param("id");
    const input = await jsonBody(c);
    const done = await c.var.access.grant(c.var.caller.principal, id, input);
    // A socket keeps the role it joined with. A role below editor closes the subject's sockets, so a join again gets the new role.
    if (options.live && (input.role === "viewer" || input.role === "commenter") && typeof input.subjectId === "string") {
      await options.live(c.env).revoke(id, input.subjectId).catch((error: unknown) => console.error(JSON.stringify({ level: "error", op: "revoke-room", message: loggable(error) })));
    }
    return c.json(done);
  });
  api.delete("/boards/:id/grants", async (c) => {
    const id = c.req.param("id");
    const subjectKind = c.req.query("subjectKind");
    const subjectId = c.req.query("subjectId");
    const done = await c.var.access.revoke(c.var.caller.principal, id, { subjectKind, subjectId });
    // Close the sockets the subject holds in the room. An agent that acts for the subject keeps its socket until it joins again,
    // and the gate then refuses it.
    if (options.live && subjectId) await options.live(c.env).revoke(id, subjectId).catch((error: unknown) => console.error(JSON.stringify({ level: "error", op: "revoke-room", message: loggable(error) })));
    return c.json(done);
  });
  api.post("/boards/:id/invites", async (c) => c.json(await c.var.access.invite(c.var.caller.principal, c.req.param("id"), await jsonBody(c)), 201));
  api.get("/boards/:id/links", async (c) => c.json(await c.var.access.listLinks(c.var.caller.principal, c.req.param("id"))));
  api.post("/boards/:id/links", async (c) => c.json(await c.var.access.createLink(c.var.caller.principal, c.req.param("id"), await jsonBody(c)), 201));
  api.delete("/boards/:id/links/:link", async (c) => c.json(await c.var.access.revokeLink(c.var.caller.principal, c.req.param("id"), c.req.param("link"))));
  // Not tied to a board: the invite names it. The caller must be the person or agent the invite is for.
  api.post("/invites/accept", async (c) => c.json(await c.var.access.accept(c.var.caller.principal, text((await jsonBody(c)).id, "id"))));
  api.post("/boards/:id/shapes", async (c) => c.json(await c.var.service.add(c.req.param("id"), await jsonBody(c), c.var.actor), 201));
  api.post("/boards/:id/connectors", async (c) => c.json(await c.var.service.connect(c.req.param("id"), await jsonBody(c), c.var.actor), 201));
  api.post("/boards/:id/flow", async (c) => c.json(await c.var.service.flow(c.req.param("id"), text((await jsonBody(c)).text, "text"), c.var.actor)));
  api.post("/boards/:id/move", async (c) => {
    const b = await jsonBody(c);
    return c.json(await c.var.service.move(c.req.param("id"), text(b.element, "element"), num(b.dx, "dx"), num(b.dy, "dy"), c.var.actor));
  });
  api.patch("/boards/:id/elements/:element", async (c) => c.json(await c.var.service.update(c.req.param("id"), c.req.param("element"), await jsonBody(c), c.var.actor)));
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
