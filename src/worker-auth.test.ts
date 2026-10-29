// The default auth of the Worker is agentic-identity: credentials and principals live in the Store.
// These tests run the real app over a real D1 database and R2 bucket (miniflare).
//
// Failure cases, written before the code:
//  1. A credential the Store does not know, a revoked one, or one of a revoked parent gets in.
//  2. A principal with no canvas scope, or a scope of another app, gets in.
//  3. `canvas:read` writes, or `canvas:write` is read as a viewer.
//  4. The static list signs in without `CANVAS_UNSAFE_STATIC_TOKENS=1`, or a deploy that sets it by mistake runs silently.
//  5. The dev fallback replaces the identity credentials instead of adding to them.
import { createD1Store, D1_SCHEMA, type D1Like, type R2Like } from "agentic-identity/cloudflare";
import { issueCredential, revokeCredential, type Store } from "agentic-identity";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { authenticate, createApp } from "./worker.js";

let mf: Miniflare;
let db: D1Like;
let bucket: R2Like;
let store: Store;
const app = createApp();
const tokens: Record<string, string> = {};
const STATIC = "static-token-".padEnd(40, "s");

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "auth-db" },
    r2Buckets: { IMAGES: "auth-bucket" },
  });
  db = (await mf.getD1Database("DB")) as unknown as D1Like;
  bucket = (await mf.getR2Bucket("IMAGES")) as unknown as R2Like;
  await db.prepare(D1_SCHEMA).run();
  store = createD1Store(db, { region: "unknown" });
  const principals: Record<string, string | string[]>[] = [
    { id: "ada", kind: "human", scopes: ["canvas:write"] },
    { id: "eve", kind: "human", scopes: ["canvas:read"] },
    { id: "ned", kind: "human", scopes: ["docs:write"] },
    { id: "all", kind: "human", scopes: ["*:admin"] },
    { id: "helper", kind: "agent_of_human", parentId: "ada", scopes: ["canvas:write"] },
    { id: "gone", kind: "human", scopes: ["canvas:write"] },
    { id: "kid", kind: "agent_of_human", parentId: "gone", scopes: ["canvas:write"] },
    { id: "canvas-room", kind: "agent", scopes: ["canvas:write"] },
  ];
  for (const p of principals) {
    await store.transaction((tx) => tx.put("principals", p.id as string, p));
    tokens[p.id as string] = await store.transaction((tx) => issueCredential(tx, { principalId: p.id as string, kind: "api_key" }));
  }
  await store.transaction((tx) => tx.put("principals", "gone", { ...principals[5]!, revokedAt: 1 }));
});
afterAll(() => mf.dispose());

// A D1 whose queries fail, except the schema check. It makes the credential lookup fail.
const brokenDb = (message: string) => ({ ...db, prepare: (sql: string) => (sql === D1_SCHEMA ? db.prepare(sql) : { bind: () => ({ first: () => Promise.reject(new Error(message)), all: () => Promise.reject(new Error(message)), run: () => Promise.reject(new Error(message)) }) }) }) as unknown as D1Like;
const env = (extra: Record<string, string> = {}) => ({ DB: db, IMAGES: bucket, CANVAS_REGION: "unknown", ...extra }) as never;
const call = (token: string | null, path: string, init: RequestInit = {}, vars?: Record<string, string>) =>
  app.fetch(new Request(`http://x/api/v1/canvas${path}`, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" } }), env(vars));

describe("identity credentials are the default", () => {
  test("an editor writes, and the actor is the principal the credential names", async () => {
    expect(await (await call(tokens.ada, "/me")).json()).toEqual({ actor: "ada", kind: "human", role: "editor" });
    expect((await call(tokens.ada, "/boards", { method: "POST", body: JSON.stringify({ id: "b1" }) })).status).toBe(201);
    // An agent acts for a person: the chain is checked, and the author kind stays.
    expect(await (await call(tokens.helper, "/me")).json()).toEqual({ actor: "helper", kind: "agent_of_human", role: "editor" });
    const shape = await (await call(tokens.helper, "/boards/b1/shapes", { method: "POST", body: JSON.stringify({ id: "s1", type: "rect", x: 0, y: 0 }) })).json();
    expect(shape.author).toEqual({ kind: "agent_of_human", id: "helper" });
    // A wildcard admin scope covers canvas:write.
    expect((await (await call(tokens.all, "/me")).json()).role).toBe("editor");
  });

  test("canvas:read is a viewer: it reads and cannot write", async () => {
    expect(await (await call(tokens.eve, "/me")).json()).toEqual({ actor: "eve", kind: "human", role: "viewer" });
    expect((await call(tokens.eve, "/boards/b1")).status).toBe(200);
    expect((await call(tokens.eve, "/boards/b1/shapes", { method: "POST", body: JSON.stringify({ type: "rect", x: 0, y: 0 }) })).status).toBe(403);
    expect((await call(tokens.eve, "/boards/b1", { method: "DELETE" })).status).toBe(403);
  });

  test.each([
    ["no credential", null],
    ["an unknown credential", "u".repeat(40)],
    ["a credential with no canvas scope", "ned"],
    ["a credential of a revoked parent", "kid"],
    ["the room's seeder name", "canvas-room"],
  ])("%s gets 401", async (_name, who) => {
    const token = who === null || who.length > 10 ? who : tokens[who]!;
    expect((await call(token, "/me")).status).toBe(401);
  });

  test("a revoked credential stops at once", async () => {
    const token = await store.transaction((tx) => issueCredential(tx, { principalId: "ada", kind: "api_key" }));
    expect((await call(token, "/me")).status).toBe(200);
    await revokeCredential(store, token, Date.now() - 1);
    expect((await call(token, "/me")).status).toBe(401);
    expect((await call(tokens.ada, "/me")).status).toBe(200);
  });

  test("a store that fails is an error, never a 401", async () => {
    const broken = { ...store, get: () => Promise.reject(new Error("D1_ERROR: busy")) } as Store;
    const request = new Request("http://x/", { headers: { authorization: `Bearer ${tokens.ada}` } });
    await expect(authenticate(request, {} as never, broken)).rejects.toThrow("D1_ERROR: busy");
  });

  test("a store that fails answers 503 for a busy database and 500 for another error, never 401", async () => {
    const fail = (message: string) => app.fetch(new Request("http://x/api/v1/canvas/me", { headers: { authorization: `Bearer ${tokens.ada}` } }), { ...(env() as object), DB: brokenDb(message) } as never);
    expect((await fail("D1_ERROR: database is busy")).status).toBe(503);
    expect((await fail("something else")).status).toBe(500);
  });

  test("the static list is no way in by default", async () => {
    expect((await call(STATIC, "/me")).status).toBe(401);
  });
});

describe("the static list is an explicit dev fallback", () => {
  const list = JSON.stringify({ [STATIC]: { actor: "dev", kind: "human" } });

  test("a deploy that sets the list without the switch gets 503, whatever the credential", async () => {
    for (const token of [STATIC, tokens.ada, null]) {
      const res = await call(token, "/me", {}, { CANVAS_API_TOKENS: list });
      expect(res.status).toBe(503);
      expect((await res.json()).error.code).toBe("NOT_CONFIGURED");
    }
    expect((await call(STATIC, "/me", {}, { CANVAS_API_TOKENS: list, CANVAS_UNSAFE_STATIC_TOKENS: "true" })).status).toBe(503);
  });

  test("with the switch, the list signs in, and identity credentials still do", async () => {
    const vars = { CANVAS_API_TOKENS: list, CANVAS_UNSAFE_STATIC_TOKENS: "1" };
    expect(await (await call(STATIC, "/me", {}, vars)).json()).toEqual({ actor: "dev", kind: "human", role: "editor" });
    expect((await call(tokens.ada, "/me", {}, vars)).status).toBe(200);
    expect((await call("u".repeat(40), "/me", {}, vars)).status).toBe(401);
  });

  test("the switch alone, with no list, adds nothing", async () => {
    expect((await call(STATIC, "/me", {}, { CANVAS_UNSAFE_STATIC_TOKENS: "1" })).status).toBe(401);
    expect((await call(tokens.ada, "/me", {}, { CANVAS_UNSAFE_STATIC_TOKENS: "1" })).status).toBe(200);
  });
});
