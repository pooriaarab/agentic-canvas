// Board sharing over HTTP, on the real app over a real D1 database and R2 bucket (miniflare).
//
// Failure cases, written before the code:
//  1. A stranger reads, lists, or learns that a board exists. (404, and it is not in the list.)
//  2. A viewer or commenter writes. An editor shares, lists access, or deletes the board. (403)
//  3. A revoked grant still works. The last owner can be removed.
//  4. An invite is taken by the wrong person, twice, or after it expired.
//  5. A link gives more than its role, works after revoke or expiry, works for another board, or a revoke names another board's link.
//  6. A credential with a read-only scope shares, or a request with no credential gets in. (401)
//  7. An invite or link makes an owner. A bad role, kind, or lifetime ends as a 500.
//  8. The dev static list is stopped by roles, or the identity credentials are not.
import { createD1Store, D1_SCHEMA, type D1Like, type R2Like } from "agentic-identity/cloudflare";
import { issueCredential, type Store } from "agentic-identity";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createApp } from "./worker.js";

// Each call writes audit entries to a local D1, and a busy machine is slow.
vi.setConfig({ testTimeout: 120_000 });

let mf: Miniflare;
let db: D1Like;
let bucket: R2Like;
let store: Store;
const app = createApp();
const tokens: Record<string, string> = {};

beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", d1Databases: { DB: "share-db" }, r2Buckets: { IMAGES: "share-bucket" } });
  db = (await mf.getD1Database("DB")) as unknown as D1Like;
  bucket = (await mf.getR2Bucket("IMAGES")) as unknown as R2Like;
  await db.prepare(D1_SCHEMA).run();
  store = createD1Store(db, { region: "unknown" });
  const principals: Record<string, string | string[]>[] = [
    { id: "ada", kind: "human", scopes: ["canvas:admin"] },
    { id: "bob", kind: "human", scopes: ["canvas:admin"] },
    { id: "cy", kind: "human", scopes: ["canvas:admin"] },
    { id: "dee", kind: "human", scopes: ["canvas:admin"] },
    { id: "eve", kind: "human", scopes: ["canvas:admin"] },
    { id: "ro", kind: "human", scopes: ["canvas:read"] },
    { id: "bot", kind: "agent", handle: "robo", scopes: ["canvas:write"] },
    { id: "kid", kind: "agent_of_human", parentId: "ada", scopes: ["canvas:read", "canvas:write"] },
  ];
  for (const p of principals) {
    await store.transaction((tx) => tx.put("principals", p.id as string, p));
    tokens[p.id as string] = await store.transaction((tx) => issueCredential(tx, { principalId: p.id as string, kind: "api_key" }));
  }
  await store.transaction((tx) => tx.put("users", "bob", { id: "bob", email: "bob@example.com", emailVerified: true }));
  await store.transaction((tx) => tx.put("users", "cy", { id: "cy", email: "cy@example.com", emailVerified: false }));
});
afterAll(() => mf.dispose());

const env = (extra: Record<string, string> = {}) => ({ DB: db, IMAGES: bucket, CANVAS_REGION: "unknown", ...extra }) as never;
const call = async (token: string | null, method: string, path: string, json?: unknown, headers: Record<string, string> = {}, vars?: Record<string, string>) => {
  const res = await app.fetch(new Request(`http://x/api/v1/canvas${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json === undefined ? {} : { "content-type": "application/json" }), ...headers }, body: json === undefined ? undefined : JSON.stringify(json) }), env(vars));
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
};
const shape = { type: "rect", x: 0, y: 0 };
const grant = (as: string, board: string, who: string, role: string, kind = "human") => call(tokens[as]!, "POST", `/boards/${board}/grants`, { subjectKind: kind, subjectId: who, role });

describe("roles on a board", () => {
  test("the creator owns the board, and a stranger sees nothing", async () => {
    expect((await call(tokens.ada!, "POST", "/boards", { id: "r1", title: "Roles" })).status).toBe(201);
    expect((await call(tokens.ada!, "GET", "/boards")).body.boards).toEqual([{ id: "r1", title: "Roles" }]);
    expect((await call(tokens.bob!, "GET", "/boards")).body.boards).toEqual([]);
    for (const [method, path] of [["GET", "/boards/r1"], ["GET", "/boards/r1/svg"], ["POST", "/boards/r1/shapes"], ["DELETE", "/boards/r1"], ["GET", "/boards/r1/access"]] as const) {
      const res = await call(tokens.bob!, method, path, method === "POST" ? shape : undefined);
      expect([path, res.status]).toEqual([path, 404]);
    }
    // A missing board and a board of someone else look the same.
    expect((await call(tokens.bob!, "GET", "/boards/none")).status).toBe(404);
  });

  test("viewer reads; commenter reads; editor writes; none of them shares or deletes", async () => {
    await grant("ada", "r1", "bob", "viewer");
    await grant("ada", "r1", "cy", "commenter");
    await grant("ada", "r1", "dee", "editor");
    expect((await call(tokens.bob!, "GET", "/boards/r1")).status).toBe(200);
    expect((await call(tokens.bob!, "GET", "/boards")).body.boards).toHaveLength(1);
    expect((await call(tokens.bob!, "POST", "/boards/r1/shapes", shape)).status).toBe(403);
    expect((await call(tokens.cy!, "POST", "/boards/r1/shapes", shape)).status).toBe(403);
    expect((await call(tokens.dee!, "POST", "/boards/r1/shapes", { ...shape, id: "s1" })).status).toBe(201);
    for (const who of ["bob", "cy", "dee"]) {
      expect((await call(tokens[who]!, "GET", "/boards/r1/access")).status).toBe(403);
      expect((await grant(who, "r1", "ro", "viewer")).status).toBe(403);
      expect((await call(tokens[who]!, "POST", "/boards/r1/links", { role: "viewer" })).status).toBe(403);
      expect((await call(tokens[who]!, "POST", "/boards/r1/invites", { role: "viewer", handle: "robo" })).status).toBe(403);
      expect((await call(tokens[who]!, "DELETE", "/boards/r1")).status).toBe(403);
    }
    expect((await call(tokens.ada!, "GET", "/boards/r1")).body.nodes.map((n: { id: string }) => n.id)).toContain("s1");
  });

  test("an agent of an owner holds the owner's role inside its own scopes", async () => {
    expect((await call(tokens.kid!, "POST", "/boards/r1/shapes", { ...shape, id: "s2" })).status).toBe(201);
    // It holds no canvas:admin scope, so it cannot share, though its person owns the board.
    expect((await call(tokens.kid!, "POST", "/boards/r1/links", { role: "viewer" })).status).toBe(403);
  });

  test("a read-only scope never writes, even for an owner", async () => {
    await call(tokens.ada!, "POST", "/boards", { id: "ro-board" });
    await grant("ada", "ro-board", "ro", "owner");
    expect((await call(tokens.ro!, "GET", "/boards/ro-board")).status).toBe(200);
    expect((await call(tokens.ro!, "POST", "/boards/ro-board/shapes", shape)).status).toBe(403);
    expect((await call(tokens.ro!, "POST", "/boards/ro-board/grants", { subjectKind: "human", subjectId: "bob", role: "viewer" })).status).toBe(403);
  });

  test("no credential is 401 on every sharing route", async () => {
    for (const [method, path] of [["GET", "/boards/r1/access"], ["POST", "/boards/r1/grants"], ["DELETE", "/boards/r1/grants"], ["POST", "/boards/r1/invites"], ["POST", "/boards/r1/links"], ["DELETE", "/boards/r1/links/x"], ["POST", "/invites/accept"]] as const) {
      expect([path, (await call(null, method, path, method === "POST" ? {} : undefined)).status]).toEqual([path, 401]);
    }
    expect((await call("u".repeat(40), "GET", "/boards/r1/access")).status).toBe(401);
  });
});

describe("every write route needs the editor role", () => {
  // The gate lists the routes it knows. Any route under a board that is not a read needs write, so a new one fails closed.
  const writes: [string, string, unknown][] = [
    ["POST", "/boards/r1/shapes", shape],
    ["POST", "/boards/r1/connectors", { from: { id: "s1" }, to: { id: "s2" } }],
    ["POST", "/boards/r1/flow", { text: "A -> B" }],
    ["POST", "/boards/r1/move", { element: "s1", dx: 1, dy: 1 }],
    ["PATCH", "/boards/r1/elements/s1", { x: 5 }],
    ["DELETE", "/boards/r1/elements/s1", undefined],
    ["POST", "/boards/r1/checkpoint", undefined],
    ["POST", "/boards/r1/comments", {}],
  ];
  test.each(writes)("%s %s: a viewer and a commenter get 403, a stranger 404", async (method, path, body) => {
    for (const who of ["bob", "cy"]) expect([who, (await call(tokens[who]!, method, path, body)).status]).toEqual([who, 403]);
    expect((await call(tokens.eve!, method, path, body)).status).toBe(404);
  });

  test("an editor passes the gate on the routes that exist", async () => {
    expect((await call(tokens.dee!, "PATCH", "/boards/r1/elements/s1", { x: 5 })).status).toBe(200);
    expect((await call(tokens.dee!, "POST", "/boards/r1/move", { element: "s1", dx: 1, dy: 1 })).status).toBe(200);
    expect((await call(tokens.dee!, "POST", "/boards/r1/flow", { text: "A -> B" })).status).toBe(200);
    // A route that does not exist is 404 for an editor, and still 403 for a viewer.
    expect((await call(tokens.dee!, "POST", "/boards/r1/comments", {})).status).toBe(404);
  });
});

describe("grant, revoke, list access", () => {
  test("an owner lists the access, and a revoke stops it at once", async () => {
    const access = (await call(tokens.ada!, "GET", "/boards/r1/access")).body;
    expect(access.grants).toEqual(expect.arrayContaining([
      { resourceId: "r1", subjectKind: "human", subjectId: "ada", role: "owner" },
      { resourceId: "r1", subjectKind: "human", subjectId: "dee", role: "editor" },
    ]));
    expect((await call(tokens.ada!, "DELETE", "/boards/r1/grants?subjectKind=human&subjectId=dee")).status).toBe(200);
    expect((await call(tokens.dee!, "GET", "/boards/r1")).status).toBe(404);
    expect((await call(tokens.dee!, "POST", "/boards/r1/shapes", shape)).status).toBe(404);
  });

  test("the last owner stays, and a second owner may share", async () => {
    const last = await call(tokens.ada!, "DELETE", "/boards/r1/grants?subjectKind=human&subjectId=ada");
    expect(last.status).toBe(422);
    expect(last.body.error.code).toBe("INVALID");
    await grant("ada", "r1", "bob", "owner");
    expect((await call(tokens.bob!, "GET", "/boards/r1/access")).status).toBe(200);
    await call(tokens.ada!, "DELETE", "/boards/r1/grants?subjectKind=human&subjectId=bob");
  });

  test.each([
    [{ subjectKind: "human", subjectId: "bob", role: "god" }],
    [{ subjectKind: "robot", subjectId: "bob", role: "viewer" }],
    [{ subjectKind: "human", subjectId: "", role: "viewer" }],
    [{ subjectKind: "human", subjectId: "a b", role: "viewer" }],
    [{ subjectKind: "human", subjectId: 7, role: "viewer" }],
    [{}],
  ])("a bad grant %j is 422, not 500", async (body) => {
    expect((await call(tokens.ada!, "POST", "/boards/r1/grants", body)).status).toBe(422);
  });

  test("a grant on a board of another owner is refused", async () => {
    await call(tokens.bob!, "POST", "/boards", { id: "bobs" });
    expect((await grant("ada", "bobs", "ada", "owner")).status).toBe(404);
  });
});

describe("invites", () => {
  test("a person takes an invite by verified email, once", async () => {
    const made = await call(tokens.ada!, "POST", "/boards/r1/invites", { role: "editor", email: "Bob@Example.com" });
    expect(made.status).toBe(201);
    const id = made.body.id as string;
    // The list shows the invite and never the address.
    const listed = (await call(tokens.ada!, "GET", "/boards/r1/access")).body.invites;
    expect(listed).toEqual([expect.objectContaining({ id, role: "editor", for: "email" })]);
    expect(JSON.stringify(listed)).not.toContain("example.com");
    // Another person, and a person whose email is not verified, cannot take it.
    expect((await call(tokens.dee!, "POST", "/invites/accept", { id })).status).toBe(403);
    expect((await call(tokens.cy!, "POST", "/invites/accept", { id })).status).toBe(403);
    expect((await call(tokens.bob!, "POST", "/invites/accept", { id })).status).toBe(200);
    expect((await call(tokens.bob!, "POST", "/boards/r1/shapes", { ...shape, id: "s3" })).status).toBe(201);
    expect((await call(tokens.bob!, "POST", "/invites/accept", { id })).status).toBe(403);
  });

  test("an agent takes an invite by its handle", async () => {
    const { body } = await call(tokens.ada!, "POST", "/boards/r1/invites", { role: "viewer", handle: "robo" });
    expect((await call(tokens.ro!, "POST", "/invites/accept", { id: body.id })).status).toBe(403);
    expect((await call(tokens.bot!, "POST", "/invites/accept", { id: body.id })).status).toBe(200);
    expect((await call(tokens.bot!, "GET", "/boards/r1")).status).toBe(200);
  });

  test("an invite that expired is refused", async () => {
    const { body } = await call(tokens.ada!, "POST", "/boards/r1/invites", { role: "viewer", handle: "robo", expiresInMs: 1 });
    await new Promise((r) => setTimeout(r, 20));
    expect((await call(tokens.bot!, "POST", "/invites/accept", { id: body.id })).status).toBe(403);
  });

  test.each([
    [{ role: "owner", handle: "robo" }],
    [{ role: "viewer" }],
    [{ role: "viewer", email: "a@b.co", handle: "robo" }],
    [{ role: "viewer", email: "not an email" }],
    [{ role: "viewer", handle: "Bad Handle" }],
    [{ role: "viewer", handle: "robo", expiresInMs: -1 }],
    [{ role: "viewer", handle: "robo", expiresInMs: "soon" }],
    [{ role: "viewer", handle: "robo", expiresInMs: 1.5 }],
  ])("a bad invite %j is 422, not 500", async (body) => {
    expect((await call(tokens.ada!, "POST", "/boards/r1/invites", body)).status).toBe(422);
  });
});

describe("share links", () => {
  test("a link reads the board with its token and nothing more", async () => {
    const link = (await call(tokens.ada!, "POST", "/boards/r1/links", { role: "viewer" })).body as { id: string; token: string };
    expect(link.token.length).toBeGreaterThan(30);
    const read = (token?: string) => call(null, "GET", "/shared/r1", undefined, token ? { "x-link-token": token } : {});
    expect((await read(link.token)).status).toBe(200);
    expect((await call(null, "GET", "/shared/r1/svg", undefined, { "x-link-token": link.token })).status).toBe(200);
    expect((await read()).status).toBe(404);
    expect((await read("wrong-token")).status).toBe(404);
    // The token opens only its own board, and only to read.
    expect((await call(null, "GET", "/shared/ro-board", undefined, { "x-link-token": link.token })).status).toBe(404);
    expect((await call(null, "POST", "/boards/r1/shapes", shape, { "x-link-token": link.token })).status).toBe(401);
    // A wrong bearer token is 401, even with a good link.
    expect((await call("u".repeat(40), "GET", "/shared/r1", undefined, { "x-link-token": link.token })).status).toBe(401);
    // A revoke by a non-owner, and for a link of another board, fails. The owner's revoke stops it.
    expect((await call(tokens.bob!, "DELETE", `/boards/r1/links/${link.id}`)).status).toBe(403);
    expect((await call(tokens.ada!, "DELETE", `/boards/ro-board/links/${link.id}`)).status).toBe(404);
    expect((await call(tokens.ada!, "DELETE", `/boards/r1/links/${link.id}`)).status).toBe(200);
    expect((await read(link.token)).status).toBe(404);
  });

  test("a link expires, and a signed-in-only link needs a valid sign-in", async () => {
    const short = (await call(tokens.ada!, "POST", "/boards/r1/links", { role: "viewer", expiresInMs: 1 })).body;
    await new Promise((r) => setTimeout(r, 20));
    expect((await call(null, "GET", "/shared/r1", undefined, { "x-link-token": short.token })).status).toBe(404);
    const signed = (await call(tokens.ada!, "POST", "/boards/r1/links", { role: "commenter", signedInOnly: true })).body;
    expect((await call(null, "GET", "/shared/r1", undefined, { "x-link-token": signed.token })).status).toBe(404);
    expect((await call(tokens.ro!, "GET", "/shared/r1", undefined, { "x-link-token": signed.token })).status).toBe(200);
  });

  test.each([[{ role: "owner" }], [{}], [{ role: "viewer", signedInOnly: "yes" }], [{ role: "viewer", expiresInMs: 0 }]])("a bad link %j is 422", async (body) => {
    expect((await call(tokens.ada!, "POST", "/boards/r1/links", body)).status).toBe(422);
  });
});

describe("delete and the dev list", () => {
  test("deleting a board removes its sharing, so a new board of the same id starts clean", async () => {
    await grant("ada", "r1", "dee", "editor");
    expect((await call(tokens.ada!, "DELETE", "/boards/r1")).status).toBe(200);
    expect((await call(tokens.ada!, "POST", "/boards", { id: "r1" })).status).toBe(201);
    expect((await call(tokens.dee!, "GET", "/boards/r1")).status).toBe(404);
  });

  test("a delete that stopped half way is finished by the owner, and a stranger learns nothing from it", async () => {
    await call(tokens.ada!, "POST", "/boards", { id: "half" });
    // The board is gone and its sharing records are left, as when the erase of the records fails.
    await store.delete("boards", "half");
    expect((await call(tokens.bob!, "DELETE", "/boards/half")).status).toBe(404);
    expect((await call(tokens.ada!, "DELETE", "/boards/half")).body).toEqual({ deleted: "half" });
    expect((await call(tokens.ada!, "POST", "/boards", { id: "half" })).status).toBe(201);
  });

  test("a resource of another app with the board's id gives no access", async () => {
    const dev = "d".repeat(40);
    const vars = { CANVAS_UNSAFE_STATIC_TOKENS: "1", CANVAS_API_TOKENS: JSON.stringify({ [dev]: { actor: "dev", kind: "human" } }) };
    await call(dev, "POST", "/boards", { id: "other" }, {}, vars);
    await store.transaction(async (tx) => {
      await tx.put("resources", "other", { id: "other", type: "doc" });
      await tx.put("grants", "other:human:bob", { resourceId: "other", subjectKind: "human", subjectId: "bob", role: "owner" });
    });
    expect((await call(tokens.bob!, "GET", "/boards/other")).status).toBe(404);
    expect((await call(tokens.bob!, "GET", "/boards")).body.boards.map((b: { id: string }) => b.id)).not.toContain("other");
  });

  test("a token of the static dev list never deletes a board that has owners", async () => {
    const dev = "d".repeat(40);
    const vars = { CANVAS_UNSAFE_STATIC_TOKENS: "1", CANVAS_API_TOKENS: JSON.stringify({ [dev]: { actor: "dev", kind: "human" } }) };
    expect((await call(dev, "DELETE", "/boards/r1", undefined, {}, vars)).status).toBe(403);
    expect((await call(tokens.ada!, "GET", "/boards/r1")).status).toBe(200);
  });

  test("a token of the static dev list reaches every board, and still obeys its own role", async () => {
    const dev = "d".repeat(40);
    const vars = { CANVAS_UNSAFE_STATIC_TOKENS: "1", CANVAS_API_TOKENS: JSON.stringify({ [dev]: { actor: "dev", kind: "human" } }) };
    expect((await call(dev, "GET", "/boards/r1", undefined, {}, vars)).status).toBe(200);
    expect((await call(dev, "POST", "/boards/r1/shapes", shape, {}, vars)).status).toBe(201);
    // It holds no board role, so it cannot share.
    expect((await call(dev, "POST", "/boards/r1/links", { role: "viewer" }, {}, vars)).status).toBe(403);
    // An identity credential is still held to roles under the same settings.
    expect((await call(tokens.bob!, "GET", "/boards/r1", undefined, {}, vars)).status).toBe(404);
  });
});

describe("live rooms", () => {
  // A room that records what the Worker asks of it. The role of a socket is set when it joins, so the Worker must pick it from the board role.
  const joined: { id: string; principal: string; role: string }[] = [];
  const closed: string[] = [];
  const room = {
    meta: async () => ({ updates: 0, compactions: 0, contributors: [] }),
    connect: async (_id: string, request: Request, grant: { principal: { id: string }; role: string }) => {
      joined.push({ id: _id, principal: grant.principal.id, role: grant.role });
      return new Response(null, { status: 200, headers: { "sec-websocket-protocol": request.headers.get("sec-websocket-protocol") ?? "" } });
    },
    revoke: async (id: string, who: string) => { closed.push(`${id}:${who}`); return { closed: 1, stored: false }; },
    erase: async () => ({ sockets: 0 }),
  };
  const live = createApp({ live: () => room as never });
  const open = (token: string, board: string) => {
    const b64 = btoa(token).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return live.fetch(new Request(`http://x/api/v1/canvas/boards/${board}/ws`, { headers: { upgrade: "websocket", "sec-websocket-protocol": `agentic-canvas, agentic-canvas.bearer.${b64}` } }), env());
  };
  const send = (token: string, method: string, path: string, json?: unknown) =>
    live.fetch(new Request(`http://x/api/v1/canvas${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: json === undefined ? undefined : JSON.stringify(json) }), env());

  test("the room role comes from the board role, and a stranger never reaches the room", async () => {
    await send(tokens.ada!, "POST", "/boards", { id: "lv" });
    await send(tokens.ada!, "POST", "/boards/lv/grants", { subjectKind: "human", subjectId: "bob", role: "viewer" });
    await send(tokens.ada!, "POST", "/boards/lv/grants", { subjectKind: "human", subjectId: "dee", role: "editor" });
    await open(tokens.ada!, "lv");
    await open(tokens.bob!, "lv");
    await open(tokens.dee!, "lv");
    expect((await open(tokens.eve!, "lv")).status).toBe(404);
    expect(joined.filter((j) => j.principal !== "canvas-room")).toEqual([
      { id: "lv", principal: "ada", role: "editor" },
      { id: "lv", principal: "bob", role: "viewer" },
      { id: "lv", principal: "dee", role: "editor" },
    ]);
  });

  test("a revoke, and a lower role, close the sockets of the subject", async () => {
    closed.length = 0;
    await send(tokens.ada!, "POST", "/boards/lv/grants", { subjectKind: "human", subjectId: "dee", role: "viewer" });
    await send(tokens.ada!, "POST", "/boards/lv/grants", { subjectKind: "human", subjectId: "bob", role: "editor" });
    await send(tokens.ada!, "DELETE", "/boards/lv/grants?subjectKind=human&subjectId=bob");
    expect(closed).toEqual(["lv:dee", "lv:bob"]);
  });

  test("an encoded path does not move a route out of the gate", async () => {
    expect((await call(tokens.dee!, "GET", "/boards/lv/%61ccess")).status).toBe(403);
    expect((await call(tokens.dee!, "GET", "/boards/lv/%E0%A4%A")).status).toBe(403);
  });
});
