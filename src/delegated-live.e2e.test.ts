// Failure cases: descendants retain writes after an ancestor downgrade or revoke;
// reconnect escapes the new role; an unrelated editor loses its live session.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueCredential } from "agentic-identity";
import { createD1Store, D1_SCHEMA, type D1Like } from "agentic-identity/cloudflare";
import { readMessage, syncStep1Message, updateMessage } from "agentic-realtime";
import { Miniflare } from "miniflare";
import * as Y from "yjs";
import { afterAll, beforeAll, expect, test } from "vitest";
import { Board } from "./core/board.js";

const scratch = mkdtempSync(join(tmpdir(), "canvas-delegated-"));
let mf: Miniflare;
const tokens: Record<string, string> = {};
const sockets: { close(): void }[] = [];
beforeAll(async () => {
  const config = join(scratch, "wrangler.json");
  writeFileSync(config, JSON.stringify({ name: "canvas-delegated-test", main: join(process.cwd(), "src/live-worker.ts"), compatibility_date: "2026-01-01", compatibility_flags: ["nodejs_compat"] }));
  execFileSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "deploy", "--dry-run", "--config", config, "--outdir", scratch], { env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: "pipe" });
  mf = new Miniflare({ modules: true, modulesRoot: scratch, scriptPath: join(scratch, "live-worker.js"), compatibilityDate: "2026-01-01", compatibilityFlags: ["nodejs_compat"], d1Databases: { DB: "delegated-db" }, r2Buckets: { IMAGES: "delegated-images" }, durableObjects: { SYNC_ROOM: { className: "SyncRoom", useSQLite: true } }, bindings: { CANVAS_REGION: "unknown" } });
  const db = await mf.getD1Database("DB") as unknown as D1Like;
  await db.prepare(D1_SCHEMA).run();
  const store = createD1Store(db, { region: "unknown" });
  for (const [id, kind, parentId] of [["owner", "human"], ["parent", "human"], ["child", "agent_of_human", "parent"], ["grandchild", "agent_of_agent", "child"], ["other", "human"]]) {
    await store.transaction(tx => tx.put("principals", id!, { id, kind, scopes: ["canvas:admin"], ...(parentId ? { parentId } : {}) }));
    tokens[id!] = await store.transaction(tx => issueCredential(tx, { principalId: id!, kind: "api_key" }));
  }
}, 120_000);
afterAll(async () => {
  for (const socket of sockets) socket.close();
  await mf?.dispose();
  rmSync(scratch, { recursive: true, force: true });
});
const call = (who: string, method: string, path: string, body?: unknown) => mf.dispatchFetch(`http://x/api/v1/canvas${path}`, { method, headers: { authorization: `Bearer ${tokens[who]}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
async function enter(who: string) {
  const response = await mf.dispatchFetch("http://x/api/v1/canvas/boards/b/ws", { headers: { upgrade: "websocket", authorization: `Bearer ${tokens[who]}` } });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  ws.accept();
  sockets.push(ws);
  const doc = new Y.Doc();
  const state = { closed: false, denied: false };
  ws.addEventListener("close", () => { state.closed = true; });
  ws.addEventListener("message", event => {
    if (typeof event.data === "string") return; // Peer presence is JSON, outside the Yjs protocol.
    const bytes = new Uint8Array(event.data as ArrayBuffer);
    if (bytes[0] === 2) state.denied = true;
    if (bytes[0] !== 0) return;
    const result = readMessage(doc, bytes, { canWrite: true, origin: ws });
    if (result.reply) ws.send(new Uint8Array(result.reply));
  });
  ws.send(new Uint8Array(syncStep1Message(doc)));
  return { ws, doc, state };
}
async function until(check: () => boolean) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 10_000) throw new Error("live condition timed out");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
function write(session: Awaited<ReturnType<typeof enter>>, who: string, id: string) {
  const vector = Y.encodeStateVector(session.doc);
  new Board(session.doc).addShape({ id, type: "rect", x: 0, y: 0 }, { id: who, kind: who === "child" ? "agent_of_human" : who === "grandchild" ? "agent_of_agent" : "human" });
  session.ws.send(new Uint8Array(updateMessage(Y.encodeStateAsUpdate(session.doc, vector))));
}
test("ancestor role changes stop delegated writes and reconnects, while unrelated sessions stay open", async () => {
  expect((await call("owner", "POST", "/boards", { id: "b" })).status).toBe(201);
  const grant = (subjectId: string, role: string) => call("owner", "POST", "/boards/b/grants", { subjectKind: "human", subjectId, role });
  for (const who of ["parent", "other"]) expect((await grant(who, "editor")).status).toBe(200);
  const observer = await enter("owner");
  const unrelated = await enter("other");
  const family = await Promise.all(["parent", "child", "grandchild"].map(enter));
  for (const [index, session] of family.entries()) write(session, ["parent", "child", "grandchild"][index]!, `before${index}`);
  await until(() => new Board(observer.doc).list().length === 3);
  expect((await grant("parent", "viewer")).status).toBe(200);
  await until(() => family.every(s => s.state.closed));
  const viewers = await Promise.all(["parent", "child", "grandchild"].map(enter));
  for (const [index, session] of viewers.entries()) write(session, ["parent", "child", "grandchild"][index]!, `denied${index}`);
  await until(() => viewers.every(s => s.state.denied));
  expect(new Board(observer.doc).list()).toHaveLength(3);
  expect((await call("owner", "DELETE", "/boards/b/grants?subjectKind=human&subjectId=parent")).status).toBe(200);
  await until(() => viewers.every(s => s.state.closed));
  for (const who of ["parent", "child", "grandchild"]) expect((await call(who, "GET", "/boards/b/ws")).status).toBe(404);
  write(unrelated, "other", "still-live");
  await until(() => !!new Board(observer.doc).get("still-live"));
  expect(unrelated.state.closed).toBe(false);
  // A later grant lifts persistent room bans for the whole delegation.
  expect((await grant("parent", "editor")).status).toBe(200);
  const restored = await enter("grandchild");
  write(restored, "grandchild", "restored");
  await until(() => !!new Board(observer.doc).get("restored"));
}, 120_000);
