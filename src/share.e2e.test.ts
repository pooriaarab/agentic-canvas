// End to end: sharing through the typed client, the built CLI, and the built MCP server. They talk over HTTP to the real
// app on a real D1 database and R2 bucket (miniflare). Run `npm run build` first. `npm run ci:local` does.
//
// Failure cases, written before the code:
//  1. A grant, revoke, list, or invite reaches the wrong board, or the wrong subject kind (human and agent share an id).
//  2. A non-owner shares, or a stranger learns a board exists. The client, CLI, and tool must show the server's code.
//  3. A bad role, a bad subject, both email and handle, or an invite for `owner` ends as a crash, not an error with a code.
//  4. The CLI shares with no server, so a local board looks shared. It must exit 2 and say it needs a server.
//  5. The MCP server with no server: a sharing tool must fail with UNAVAILABLE and keep running.
//  6. A path that holds a slash or a space in the board id is not escaped, and reaches another route.
//  7. A token or an email leaks into an error or a list.
//  8. A link list shows a token or its hash, or a link of another board, or a non-owner lists, makes, or revokes links.
//  9. A revoked link still opens the board, or a link of board A is revoked through board B.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { issueCredential, type Store } from "agentic-identity";
import { createD1Store, D1_SCHEMA, type D1Like, type R2Like } from "agentic-identity/cloudflare";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createClient } from "./client.js";
import { createApp } from "./worker.js";

vi.setConfig({ testTimeout: 120_000 });

const BIN = join(process.cwd(), "dist", "cli.js");
let mf: Miniflare;
let http: Server;
let server: string;
let store: Store;
const tokens: Record<string, string> = {};
const scratch = mkdtempSync(join(tmpdir(), "canvas-share-"));

beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", d1Databases: { DB: "share-e2e-db" }, r2Buckets: { IMAGES: "share-e2e-bucket" } });
  const db = (await mf.getD1Database("DB")) as unknown as D1Like;
  const bucket = (await mf.getR2Bucket("IMAGES")) as unknown as R2Like;
  await db.prepare(D1_SCHEMA).run();
  store = createD1Store(db, { region: "unknown" });
  for (const [id, kind, scopes] of [["ada", "human", ["canvas:admin"]], ["bob", "human", ["canvas:admin"]], ["bot", "agent", ["canvas:write"]]] as const) {
    await store.transaction((tx) => tx.put("principals", id, { id, kind, scopes: [...scopes], ...(kind === "agent" ? { handle: "robo" } : {}) }));
    tokens[id] = await store.transaction((tx) => issueCredential(tx, { principalId: id, kind: "api_key" }));
  }
  const app = createApp();
  const env = { DB: db, IMAGES: bucket, CANVAS_REGION: "unknown" } as never;
  http = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const reply = await app.fetch(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, body: body.length ? body : undefined }), env);
    res.writeHead(reply.status, Object.fromEntries(reply.headers));
    res.end(Buffer.from(await reply.arrayBuffer()));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  server = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(async () => {
  http.close();
  await mf.dispose();
  rmSync(scratch, { recursive: true, force: true });
});

const client = (who: string) => createClient({ baseUrl: `${server}/api/v1/canvas`, token: tokens[who]! });
const failure = async (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error);

function cli(args: string[], who: string | null, extra: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...(who ? { CANVAS_SERVER: server, CANVAS_TOKEN: tokens[who]! } : {}), ...extra };
    const child = spawn(process.execPath, [BIN, ...args], { env });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

describe("the typed client", () => {
  test("grants, lists, invites, and revokes on one board", async () => {
    const ada = client("ada");
    await ada.createBoard({ id: "c-board" });
    await ada.createBoard({ id: "other" });
    expect(await ada.grant("c-board", { subjectKind: "human", subjectId: "bob", role: "editor" })).toEqual({ ok: true });
    expect(await ada.grant("c-board", { subjectKind: "agent", subjectId: "bob", role: "viewer" })).toEqual({ ok: true });
    const invite = await ada.invite("c-board", { role: "viewer", email: "x@example.com", expiresInMs: 60_000 });
    expect(typeof invite.id).toBe("string");
    const access = await ada.access("c-board");
    expect(access.grants.filter((g) => g.subjectId === "bob").map((g) => [g.subjectKind, g.role]).sort()).toEqual([["agent", "viewer"], ["human", "editor"]]);
    expect(access.invites.map((i) => i.id)).toEqual([invite.id]);
    expect(JSON.stringify(access)).not.toContain("x@example.com");
    expect((await ada.access("other")).grants.map((g) => g.subjectId)).toEqual(["ada"]);
    expect(await ada.revoke("c-board", { subjectKind: "human", subjectId: "bob" })).toEqual({ ok: true });
    const after = await ada.access("c-board");
    expect(after.grants.filter((g) => g.subjectId === "bob").map((g) => g.subjectKind)).toEqual(["agent"]);
  });

  test("makes, lists, and revokes links on one board, and a revoked link stops working", async () => {
    const ada = client("ada");
    await ada.createBoard({ id: "l-board" });
    await ada.createBoard({ id: "l-other" });
    const link = await ada.createLink("l-board", { role: "viewer", signedInOnly: true, expiresInMs: 60_000 });
    const plain = await ada.createLink("l-board", { role: "commenter" });
    await ada.createLink("l-other", { role: "viewer" });
    expect(link.token.length).toBeGreaterThan(30);
    const { links } = await ada.links("l-board");
    expect(links.map((l) => [l.id, l.role, l.signedInOnly]).sort()).toEqual([[link.id, "viewer", true], [plain.id, "commenter", false]].sort());
    expect(links.find((l) => l.id === link.id)!.expiresAt).toBeGreaterThan(Date.now());
    expect(JSON.stringify(links)).not.toMatch(new RegExp(`${link.token}|tokenHash`));
    const open = (token: string) => fetch(`${server}/api/v1/canvas/shared/l-board`, { headers: { "x-link-token": token, authorization: `Bearer ${tokens.bob}` } });
    expect((await open(plain.token)).status).toBe(200);
    expect(await failure(ada.revokeLink("l-other", plain.id))).toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(await ada.revokeLink("l-board", plain.id)).toEqual({ ok: true });
    expect((await open(plain.token)).status).toBe(404);
    expect((await ada.links("l-board")).links.find((l) => l.id === plain.id)!.revokedAt).toBeGreaterThan(0);
    expect((await ada.links("l-other")).links).toHaveLength(1);
  });

  test("a list of more than 200 links says it was cut", async () => {
    const ada = client("ada");
    await ada.createBoard({ id: "l-many" });
    // Write the records straight to the store: 201 calls over HTTP are slow.
    await store.transaction(async (tx) => {
      for (let i = 0; i < 201; i++) await tx.put("links", `many-${i}`, { id: `many-${i}`, resourceId: "l-many", role: "viewer", tokenHash: "x", signedInOnly: false });
    });
    const list = await ada.links("l-many");
    expect([list.links.length, list.truncated]).toEqual([200, true]);
    // Live links come before revoked ones, so a cut keeps the ones that matter.
    const live = await ada.createLink("l-many", { role: "viewer" });
    await ada.revokeLink("l-many", "many-0");
    expect((await ada.links("l-many")).links.some((l) => l.id === live.id)).toBe(true);
    await store.transaction((tx) => tx.put("links", "odd", { id: "odd", resourceId: "l-odd", role: "owner", tokenHash: "x" }));
    await ada.createBoard({ id: "l-odd" });
    expect(await ada.links("l-odd")).toEqual({ links: [], skipped: 1 });
    // A damaged record fails closed: a bad revokedAt shows as revoked, and a bad expiresAt, a wrong key, or a wrong board is not shown.
    await store.transaction(async (tx) => {
      await tx.put("links", "bad-revoked", { id: "bad-revoked", resourceId: "l-odd", role: "viewer", tokenHash: "x", revokedAt: true });
      await tx.put("links", "bad-expiry", { id: "bad-expiry", resourceId: "l-odd", role: "viewer", tokenHash: "x", expiresAt: "soon" });
      await tx.put("links", "null-expiry", { id: "null-expiry", resourceId: "l-odd", role: "viewer", tokenHash: "x", expiresAt: null });
      await tx.put("links", "no-hash", { id: "no-hash", resourceId: "l-odd", role: "viewer" });
      await tx.put("links", "key-a", { id: "key-b", resourceId: "l-odd", role: "viewer", tokenHash: "x" });
    });
    const odd = await ada.links("l-odd");
    expect(odd.links.map((l) => l.id).sort()).toEqual(["bad-revoked", "null-expiry"]);
    expect(odd.links.find((l) => l.id === "null-expiry")).toEqual({ id: "null-expiry", role: "viewer", signedInOnly: false });
    expect(odd.skipped).toBe(4);
    expect(odd.links.find((l) => l.id === "bad-revoked")!.revokedAt).toBe(0);
    expect((await ada.links("l-board")).truncated).toBeUndefined();
  });

  test("a list reads at most 1000 records and says it was cut", async () => {
    await client("ada").createBoard({ id: "l-huge" });
    await store.transaction(async (tx) => {
      for (let i = 0; i < 1001; i++) await tx.put("links", `huge-${i}`, { id: `huge-${i}`, resourceId: "l-huge", role: "viewer", tokenHash: "x", revokedAt: 1 });
    });
    const list = await client("ada").links("l-huge");
    expect([list.links.length, list.truncated]).toEqual([200, true]);
  });

  test("a non-owner and a stranger cannot use links, and bad input has a code", async () => {
    const ada = client("ada");
    await ada.createBoard({ id: "l-guard" });
    await ada.grant("l-guard", { subjectKind: "human", subjectId: "bob", role: "editor" });
    const link = await ada.createLink("l-guard", { role: "viewer" });
    expect(await failure(client("bob").links("l-guard"))).toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(await failure(client("bob").createLink("l-guard", { role: "viewer" }))).toMatchObject({ code: "FORBIDDEN" });
    expect(await failure(client("bob").revokeLink("l-guard", link.id))).toMatchObject({ code: "FORBIDDEN" });
    expect(await failure(client("bot").links("l-guard"))).toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(await failure(ada.createLink("l-guard", { role: "owner" as never }))).toMatchObject({ code: "INVALID" });
    expect(await failure(ada.revokeLink("l-guard", "nope"))).toMatchObject({ code: "NOT_FOUND" });
  });

  test("shows the server's code for a non-owner, a stranger, and bad input", async () => {
    const ada = client("ada");
    await ada.createBoard({ id: "c-guard" });
    await ada.grant("c-guard", { subjectKind: "human", subjectId: "bob", role: "editor" });
    expect(await failure(client("bob").grant("c-guard", { subjectKind: "human", subjectId: "bob", role: "owner" }))).toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(await failure(client("bot").access("c-guard"))).toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(await failure(ada.grant("c-guard", { subjectKind: "human", subjectId: "bob", role: "boss" as never }))).toMatchObject({ code: "INVALID" });
    expect(await failure(ada.invite("c-guard", { role: "owner" as never, email: "a@example.com" }))).toMatchObject({ code: "INVALID" });
    expect(await failure(ada.invite("c-guard", { role: "viewer", email: "a@example.com", handle: "robo" }))).toMatchObject({ code: "INVALID" });
    expect(await failure(ada.revoke("c-guard", { subjectKind: "human", subjectId: "ada" }))).toMatchObject({ code: "INVALID" });
  });

  test("escapes a board id, so it reaches no other route", async () => {
    const error = await failure(client("ada").access("a/grants?x=1"));
    // The id stays one path segment, so the server looks for a board with that name and finds none.
    expect(error).toMatchObject({ code: "NOT_FOUND", status: 404 });
  });
});

describe("the CLI", () => {
  test("grants, lists, invites, and revokes, and prints JSON", async () => {
    await client("ada").createBoard({ id: "cli-board" });
    const grant = await cli(["grant", "cli-board", "agent:bot", "--role", "editor"], "ada");
    expect([grant.code, JSON.parse(grant.out)]).toEqual([0, { ok: true }]);
    const invite = await cli(["invite", "cli-board", "--role", "viewer", "--handle", "robo", "--expires-in-ms", "60000"], "ada");
    expect(invite.code).toBe(0);
    const inviteId = JSON.parse(invite.out).id as string;
    const list = JSON.parse((await cli(["access", "cli-board"], "ada")).out);
    expect(list.grants.map((g: { subjectKind: string; subjectId: string; role: string }) => `${g.subjectKind}:${g.subjectId}:${g.role}`).sort()).toEqual(["agent:bot:editor", "human:ada:owner"]);
    expect(list.invites.map((i: { id: string }) => i.id)).toEqual([inviteId]);
    const revoke = await cli(["revoke", "cli-board", "agent:bot"], "ada");
    expect([revoke.code, JSON.parse(revoke.out)]).toEqual([0, { ok: true }]);
    expect(JSON.parse((await cli(["access", "cli-board"], "ada")).out).grants.map((g: { subjectId: string }) => g.subjectId)).toEqual(["ada"]);
  });

  test("a non-owner gets the code and exit 1, and a bad subject or role exits cleanly", async () => {
    await client("ada").createBoard({ id: "cli-guard" });
    const denied = await cli(["access", "cli-guard"], "bob");
    expect([denied.code, denied.out, denied.err.startsWith("NOT_FOUND:")]).toEqual([1, "", true]);
    const badSubject = await cli(["grant", "cli-guard", "bob", "--role", "viewer"], "ada");
    expect([badSubject.code, badSubject.err]).toEqual([2, expect.stringContaining("human:<id> or agent:<id>")]);
    const badRole = await cli(["grant", "cli-guard", "human:bob", "--role", "boss"], "ada");
    expect([badRole.code, badRole.err.startsWith("INVALID:")]).toEqual([1, true]);
    const both = await cli(["invite", "cli-guard", "--role", "viewer", "--email", "a@example.com", "--handle", "robo"], "ada");
    expect([both.code, both.err.startsWith("INVALID:")]).toEqual([1, true]);
  });

  test("makes, lists, and revokes links, and prints JSON", async () => {
    await client("ada").createBoard({ id: "cli-link" });
    const made = await cli(["link", "cli-link", "--role", "viewer", "--signed-in-only", "--expires-in-ms", "60000"], "ada");
    expect(made.code).toBe(0);
    const link = JSON.parse(made.out) as { id: string; token: string };
    const list = JSON.parse((await cli(["links", "cli-link"], "ada")).out);
    expect(list.links).toEqual([{ id: link.id, role: "viewer", signedInOnly: true, expiresAt: expect.any(Number) }]);
    expect((await cli(["links", "cli-link"], "ada")).out).not.toContain(link.token);
    expect(JSON.parse((await cli(["revoke-link", "cli-link", link.id], "ada")).out)).toEqual({ ok: true });
    expect(JSON.parse((await cli(["links", "cli-link"], "ada")).out).links[0].revokedAt).toEqual(expect.any(Number));
    const denied = await cli(["links", "cli-link"], "bot");
    expect([denied.code, denied.err]).toEqual([1, expect.stringContaining("NOT_FOUND")]);
    const bad = await cli(["link", "cli-link", "--role", "owner"], "ada");
    expect([bad.code, bad.err]).toEqual([1, expect.stringContaining("INVALID")]);
    expect((await cli(["revoke-link", "cli-link"], "ada")).code).toBe(2);
  });

  test.each(["links x", "link x --role viewer", "revoke-link x abc", "access x", "grant x human:bob --role viewer", "revoke x human:bob", "invite x --role viewer --email a@example.com"])("`%s` with no server exits 2 and says it needs a server", async (line) => {
    const r = await cli(["--dir", join(scratch, "local"), ...line.split(" ")], null, { CANVAS_ACTOR: "human:ada" });
    expect([r.code, r.out, r.err]).toEqual([2, "", expect.stringContaining("needs a server")]);
  });

  test("the token never shows in an error", async () => {
    const r = await cli(["access", "nope"], "ada");
    expect(r.err).not.toContain(tokens.ada!);
  });
});

describe("the MCP server", () => {
  async function connect(env: Record<string, string>): Promise<Client> {
    const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, ...(env.CANVAS_SERVER ? [] : ["--dir", join(scratch, "mcp")]), "mcp"], env: { PATH: process.env.PATH ?? "", ...env }, stderr: "pipe" });
    const c = new Client({ name: "test", version: "0" });
    await c.connect(transport);
    return c;
  }
  async function call(c: Client, name: string, args: Record<string, unknown>) {
    const result = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text?: string }[] };
    return { error: result.isError === true, value: JSON.parse(result.content[0]!.text!) };
  }

  test("grants, lists, invites, and revokes through tools", async () => {
    await client("ada").createBoard({ id: "mcp-board" });
    const c = await connect({ CANVAS_SERVER: server, CANVAS_TOKEN: tokens.ada! });
    try {
      expect((await call(c, "grant_access", { board: "mcp-board", subjectKind: "agent", subjectId: "bot", role: "editor" })).value).toEqual({ ok: true });
      const invite = await call(c, "create_invite", { board: "mcp-board", role: "commenter", handle: "robo" });
      expect(invite.error).toBe(false);
      const list = (await call(c, "list_access", { board: "mcp-board" })).value;
      expect(list.grants.map((g: { subjectKind: string; subjectId: string }) => `${g.subjectKind}:${g.subjectId}`).sort()).toEqual(["agent:bot", "human:ada"]);
      expect(list.invites.map((i: { id: string }) => i.id)).toEqual([invite.value.id]);
      expect((await call(c, "revoke_access", { board: "mcp-board", subjectKind: "agent", subjectId: "bot" })).value).toEqual({ ok: true });
      expect((await call(c, "list_access", { board: "mcp-board" })).value.grants.map((g: { subjectId: string }) => g.subjectId)).toEqual(["ada"]);
    } finally {
      await c.close();
    }
  });

  test("makes, lists, and revokes links through tools", async () => {
    await client("ada").createBoard({ id: "mcp-link" });
    const c = await connect({ CANVAS_SERVER: server, CANVAS_TOKEN: tokens.ada! });
    try {
      const made = await call(c, "create_link", { board: "mcp-link", role: "viewer", expiresInMs: 60_000 });
      expect([made.error, typeof made.value.token]).toEqual([false, "string"]);
      const list = await call(c, "list_links", { board: "mcp-link" });
      expect(list.value.links.map((l: { id: string }) => l.id)).toEqual([made.value.id]);
      expect(JSON.stringify(list.value)).not.toContain(made.value.token);
      expect((await call(c, "revoke_link", { board: "mcp-link", link: made.value.id })).value).toEqual({ ok: true });
      expect((await call(c, "list_links", { board: "mcp-link" })).value.links[0].revokedAt).toEqual(expect.any(Number));
      const missing = await call(c, "revoke_link", { board: "mcp-link", link: "nope" });
      expect([missing.error, missing.value.code]).toEqual([true, "NOT_FOUND"]);
      for (const args of [{ role: "owner" }, { role: "viewer", expiresInMs: 1.5 }, { role: "viewer", expiresInMs: -1 }]) {
        const bad = (await c.callTool({ name: "create_link", arguments: { board: "mcp-link", ...args } })) as { isError?: boolean };
        expect(bad.isError).toBe(true);
      }
    } finally {
      await c.close();
    }
  });

  test("a non-owner's tool call is an error with the server's code, and a bad role is refused by the schema", async () => {
    await client("ada").createBoard({ id: "mcp-guard" });
    const c = await connect({ CANVAS_SERVER: server, CANVAS_TOKEN: tokens.bob! });
    try {
      const denied = await call(c, "list_access", { board: "mcp-guard" });
      expect([denied.error, denied.value.code]).toEqual([true, "NOT_FOUND"]);
      const bad = (await c.callTool({ name: "grant_access", arguments: { board: "mcp-guard", subjectKind: "human", subjectId: "bob", role: "boss" } })) as { isError?: boolean };
      expect(bad.isError).toBe(true);
    } finally {
      await c.close();
    }
  });

  test("with no server a sharing tool fails with UNAVAILABLE and the server keeps running", async () => {
    const c = await connect({ CANVAS_ACTOR: "human:ada" });
    try {
      const r = await call(c, "list_access", { board: "x" });
      expect([r.error, r.value.code]).toEqual([true, "UNAVAILABLE"]);
      expect((await call(c, "list_links", { board: "x" })).value.code).toBe("UNAVAILABLE");
      expect((await call(c, "list_boards", {})).value).toEqual({ boards: [] });
    } finally {
      await c.close();
    }
  });
});
