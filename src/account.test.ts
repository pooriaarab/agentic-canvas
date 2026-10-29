// Account export and erase, over the real file store and the real sharing records. No mock.
//
// Failure cases, written before the code:
//  1. A bad subject (no kind, an unknown kind, an empty id) or a missing store is refused.
//  2. A board with two owners is deleted when one is erased, or a board that the subject owns alone is left.
//  3. An element of the subject stays on a board of someone else, or an element of someone else goes with it.
//  4. A connector of someone else is left hidden on a deleted shape, or a member of a deleted group is lost.
//  5. An invite email is in the export, or an invite of the subject stays after the erase.
//  6. An audit entry keeps the subject's id, or loses its kind (so it stops saying that a machine acted).
//  7. The export holds another person's data (except the elements of others on a board the subject owns alone), or the erase touches it.
//  8. A delegated agent (agent_of_human) is refused, though it stamps elements. The stand-in for an erased id names a real principal.
//  9. A damaged grant of the subject is skipped, so the erase reports done and leaves it. A grant with no resource stays.
// 10. A second erase counts anything, or the erase fails when a board has no room to erase.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { CanvasAccess } from "./access.js";
import { canvasAccount } from "./account.js";
import type { Principal } from "./core/principal.js";
import * as Y from "yjs";
import { Board } from "./core/board.js";
import { CanvasService, toBase64 } from "./service.js";
import { openLocalStore } from "./store-file.js";

const root = mkdtempSync(join(tmpdir(), "canvas-account-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const ada: Principal = { kind: "human", id: "ada" };
const bob: Principal = { kind: "human", id: "bob" };
const bot: Principal = { kind: "agent", id: "robo" };
const ctx = (p: Principal) => ({ principalId: p.id, kind: p.kind, chain: [{ id: p.id, kind: p.kind }], scopes: ["canvas:admin"] }) as never;

async function setup() {
  const store = openLocalStore(join(root, `s${n++}`));
  const service = new CanvasService(store);
  const access = new CanvasAccess(store);
  for (const [id, owner] of [["mine", ada], ["joint", ada], ["bobs", bob], ["other", bob]] as const) {
    await service.create(owner, { id });
    await access.register(ctx(owner), id);
  }
  await access.grant(ctx(ada), "joint", { subjectKind: "human", subjectId: "bob", role: "owner" });
  await access.grant(ctx(bob), "bobs", { subjectKind: "human", subjectId: "ada", role: "editor" });
  await access.grant(ctx(bob), "bobs", { subjectKind: "agent", subjectId: "robo", role: "editor" });
  await access.invite(ctx(ada), "mine", { role: "viewer", email: "friend@example.com" });
  await access.invite(ctx(ada), "joint", { role: "viewer", handle: "helper" });
  await access.invite(ctx(bob), "bobs", { role: "viewer", email: "keep@example.com" });
  await service.add("mine", { id: "m1", type: "rect", x: 0, y: 0 }, ada);
  await service.change("bobs", (b) => {
    b.setTitle("Ada's title", ada);
    b.addShape({ id: "a1", type: "rect", x: 0, y: 0 }, ada);
    b.addShape({ id: "a2", type: "rect", x: 9, y: 0 }, ada);
    b.addShape({ id: "b1", type: "rect", x: 20, y: 0 }, bob);
    b.addShape({ id: "b2", type: "rect", x: 40, y: 0 }, bob);
    b.addConnector({ id: "bc", from: { id: "a1" }, to: { id: "b1" } }, bob);
    b.addConnector({ id: "ac", from: { id: "b1" }, to: { id: "b2" } }, ada);
    b.group(["a2", "b2"], ada, "g");
    b.update("b1", { text: "edited by ada" }, ada);
    b.addShape({ id: "r1", type: "rect", x: 60, y: 0 }, bot);
  });
  await service.add("other", { id: "o1", type: "rect", x: 0, y: 0 }, bob);
  // The audit entries come from the checks.
  await access.allowed(ctx(ada), "read", "mine");
  await access.allowed(ctx(ada), "write", "bobs");
  await access.allowed(ctx(bob), "read", "bobs");
  return { store, service };
}

describe("canvasAccount", () => {
  test("exports what the subject owns, holds, made, and edited, and nothing of others", async () => {
    const { store } = await setup();
    const out = await canvasAccount.exportAccount(ada, { store });
    expect(out.boards.map((b: any) => b.id)).toEqual(["mine"]);
    expect((out.boards[0] as any).elements.map((e: any) => e.id)).toEqual(["m1"]);
    expect(out.grants.map((g: any) => `${g.resourceId}:${g.role}`).sort()).toEqual(["bobs:editor", "joint:owner", "mine:owner"]);
    expect(out.authored_elements.map((e: any) => `${e.boardId}:${e.element.id}`).sort()).toEqual(["bobs:a1", "bobs:a2", "bobs:ac", "bobs:g"]);
    expect(out.edited_elements).toEqual([{ boardId: "bobs", elementId: "b1" }, { boardId: "bobs", elementId: "b2" }]);
    expect(out.titles).toEqual([{ boardId: "bobs", title: "Ada's title" }]);
    expect(out.invites).toHaveLength(2);
    expect(JSON.stringify(out)).not.toContain("friend@example.com");
    expect(JSON.stringify(out)).not.toContain("keep@example.com");
    expect(out.audit.length).toBeGreaterThan(0);
    expect(out.audit.every((a: any) => [a.principalId, a.rootId, a.targetId].includes("ada"))).toBe(true);
    // Plain JSON: it survives a round trip unchanged.
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });

  test("erases, keeps the rest, and a second erase counts zero", async () => {
    const { store, service } = await setup();
    const rooms: string[] = [];
    const deps = { store, eraseRoom: async (id: string) => void rooms.push(id) };
    const counts = await canvasAccount.eraseAccount(ada, deps);
    expect(counts).toMatchObject({ boards: 1, grants: 3, invites: 2, authored_elements: 4, edited_elements: 2, titles: 1 });
    expect(counts.audit).toBeGreaterThan(0);
    expect(new Set(rooms)).toEqual(new Set(["mine", "bobs"]));

    // A board owned alone is gone, with its sharing records. A joint board stays, with the other owner.
    await expect(service.read("mine")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await store.get("resources", "mine")).toBeNull();
    expect((await service.read("joint")).id).toBe("joint");
    const owners = (await store.query("grants", { where: { resourceId: "joint" }, limit: 10 })).items.map((g) => g.data.subjectId);
    expect(owners).toEqual(["bob"]);

    // Bob's board (ada also edited b2 when she grouped it): ada's elements are gone, bob's stay, a hidden connector goes, the group's member moves out, the editor is erased.
    const bobs = await service.read("bobs");
    expect(bobs.nodes.map((e) => e.id).sort()).toEqual(["b1", "b2", "r1"]);
    expect(bobs.edges).toEqual([]);
    expect(bobs.nodes.find((e) => e.id === "b2")!.groupId).toBeUndefined();
    expect(bobs.nodes.find((e) => e.id === "b1")).toMatchObject({ text: "edited by ada", editedBy: { kind: "human", id: "(erased)" }, author: bob });
    expect(bobs.title).toBe("");
    expect((await service.read("other")).nodes).toHaveLength(1);
    // The agent's work and bob's invite stay.
    expect(bobs.nodes.find((e) => e.id === "r1")!.author).toEqual(bot);
    expect((await store.query("invites", { where: { createdBy: "bob" }, limit: 5 })).items).toHaveLength(1);
    expect((await store.query("invites", { where: { createdBy: "ada" }, limit: 5 })).items).toHaveLength(0);

    // The audit entries keep their kind and lose the id.
    const audit = (await store.query("audit", { limit: 200 })).items.map((a) => JSON.stringify(a.data));
    expect(audit.filter((a) => a.includes(`"ada"`))).toEqual([]);
    expect(audit.some((a) => a.includes('"(erased)"') && a.includes('"human"'))).toBe(true);

    expect(await canvasAccount.eraseAccount(ada, deps)).toEqual({ boards: 0, grants: 0, invites: 0, authored_elements: 0, edited_elements: 0, titles: 0, audit: 0 });
    const again = await canvasAccount.exportAccount(ada, { store });
    expect(Object.values(again).flat()).toEqual([]);
  });

  test("erases an agent subject and keeps its kind on the stamp", async () => {
    const { store, service } = await setup();
    const counts = await canvasAccount.eraseAccount(bot, { store });
    expect(counts).toMatchObject({ boards: 0, grants: 1, authored_elements: 1 });
    expect((await service.read("bobs")).nodes.map((e) => e.id)).not.toContain("r1");
  });

  test.each([
    ["no kind", { id: "ada" }],
    ["an unknown kind", { kind: "anonymous", id: "ada" }],
    ["an empty id", { kind: "human", id: "" }],
  ])("refuses %s", async (_name, subject) => {
    const { store } = await setup();
    await expect(canvasAccount.exportAccount(subject as never, { store })).rejects.toMatchObject({ code: "INVALID" });
    await expect(canvasAccount.eraseAccount(subject as never, { store })).rejects.toMatchObject({ code: "INVALID" });
    await expect(canvasAccount.exportAccount(ada, {} as never)).rejects.toMatchObject({ code: "INVALID" });
  });

  test("stops on a damaged board and does not guess", async () => {
    const { store } = await setup();
    await store.transaction((tx) => tx.put("boards", "bad", { update: "!!not base64!!" }));
    await expect(canvasAccount.eraseAccount(bob, { store })).rejects.toMatchObject({ code: "INVALID" });
    // Nothing was changed before the stop.
    expect(await store.get("resources", "bobs")).not.toBeNull();
    expect((await store.query("invites", { where: { createdBy: "bob" }, limit: 5 })).items).toHaveLength(1);
  });

  test("erases a delegated agent, whose stamps are on boards it does not own", async () => {
    const { store, service } = await setup();
    const kid: Principal = { kind: "agent_of_human", id: "kid" };
    await service.add("bobs", { id: "k1", type: "rect", x: 0, y: 0 }, kid);
    const out = await canvasAccount.exportAccount(kid, { store });
    expect(out.authored_elements).toHaveLength(1);
    expect(await canvasAccount.eraseAccount(kid, { store })).toMatchObject({ authored_elements: 1 });
    expect((await service.read("bobs")).nodes.map((e) => e.id)).not.toContain("k1");
    expect(await canvasAccount.eraseAccount(kid, { store })).toMatchObject({ authored_elements: 0, edited_elements: 0 });
  });

  test("a real principal named erased owns nothing of what an erase left", async () => {
    const { store } = await setup();
    await canvasAccount.eraseAccount(ada, { store });
    const stand = { kind: "human", id: "erased" } as const;
    expect(Object.values(await canvasAccount.exportAccount(stand, { store })).flat()).toEqual([]);
    expect(await canvasAccount.eraseAccount(stand, { store })).toMatchObject({ edited_elements: 0, titles: 0 });
  });

  test("stops on a damaged grant, and removes a grant that has no resource", async () => {
    const { store } = await setup();
    await store.transaction((tx) => tx.put("grants", "orphan", { resourceId: "gone", subjectKind: "human", subjectId: "ada", role: "editor" }));
    expect(await canvasAccount.eraseAccount(ada, { store })).toMatchObject({ grants: 4 });
    expect(await store.get("grants", "orphan")).toBeNull();
    await store.transaction((tx) => tx.put("grants", "bad", { resourceId: "mine", subjectKind: "human", subjectId: "ada", role: "Editor" }));
    await expect(canvasAccount.exportAccount(ada, { store })).rejects.toMatchObject({ code: "INVALID" });
    await expect(canvasAccount.eraseAccount(ada, { store })).rejects.toMatchObject({ code: "INVALID" });
  });

  test("leaves the invites of another app alone", async () => {
    const { store } = await setup();
    await store.transaction((tx) => tx.put("resources", "doc1", { id: "doc1", type: "docs" }));
    await store.transaction((tx) => tx.put("invites", "docinv", { id: "docinv", resourceId: "doc1", role: "viewer", createdBy: "ada", handle: "x" }));
    expect((await canvasAccount.exportAccount(ada, { store })).invites).toHaveLength(2);
    expect(await canvasAccount.eraseAccount(ada, { store })).toMatchObject({ invites: 2 });
    expect(await store.get("invites", "docinv")).not.toBeNull();
  });

  test("exports an owned board as stored: full images, whole groups, damaged entries, and refuses a bad hook", async () => {
    const { store } = await setup();
    const src = `data:image/png;base64,${"A".repeat(300)}`;
    const doc = new Board();
    doc.addShape({ id: "img", type: "image", x: 0, y: 0, w: 10, h: 10, src }, ada);
    doc.addShape({ id: "s2", type: "rect", x: 0, y: 0 }, ada);
    doc.group(["img", "s2"], ada, "grp");
    // A shape with no size fails the element checks, so a read drops it.
    doc.doc.getMap<Y.Map<unknown>>("elements").set("bad", new Y.Map<unknown>([["id", "bad"], ["type", "rect"]]));
    await store.transaction((tx) => tx.put("boards", "mine", { update: toBase64(doc.encode()) }));
    const [board] = (await canvasAccount.exportAccount(ada, { store })).boards as any[];
    expect(board.elements.find((e: any) => e.id === "img").src).toBe(src);
    expect(board.elements.find((e: any) => e.id === "grp")).toMatchObject({ type: "group", author: ada });
    expect(board.elements.map((e: any) => e.id)).toContain("bad");
    await expect(canvasAccount.eraseAccount(ada, { store, eraseRoom: "x" as never })).rejects.toMatchObject({ code: "INVALID" });
    await expect(canvasAccount.exportAccount(ada, { store, saveRoom: 1 as never })).rejects.toMatchObject({ code: "INVALID" });
  });

  test("saves a room before it reads a board, and resets only the boards it changes", async () => {
    const { store, service } = await setup();
    const saved: string[] = [];
    const reset: string[] = [];
    // A live edit that only the room holds: the hook writes it to the Store, as a Worker pull does.
    const saveRoom = async (id: string) => {
      saved.push(id);
      if (id === "other" && !saved.slice(0, -1).includes("other")) await service.add("other", { id: "late", type: "rect", x: 0, y: 0 }, ada);
    };
    const out = await canvasAccount.exportAccount(ada, { store, saveRoom });
    expect(out.authored_elements.map((e: any) => e.element.id)).toContain("late");
    await canvasAccount.eraseAccount(ada, { store, saveRoom, eraseRoom: async (id) => void reset.push(id) });
    expect(new Set(saved)).toEqual(new Set(["mine", "joint", "bobs", "other"]));
    expect(new Set(reset)).toEqual(new Set(["mine", "bobs", "other"]));
    expect((await service.read("other")).nodes.map((e) => e.id)).toEqual(["o1"]);
  });

  test("stops on a damaged invite of the subject", async () => {
    const { store } = await setup();
    await store.transaction((tx) => tx.put("invites", "badinv", { id: "badinv", role: "viewer", createdBy: "ada" }));
    await expect(canvasAccount.eraseAccount(ada, { store })).rejects.toMatchObject({ code: "INVALID" });
  });

  test("refuses before any change when a board has a child resource", async () => {
    const { store, service } = await setup();
    await store.transaction((tx) => tx.put("resources", "child", { id: "child", type: "docs", parentId: "mine" }));
    await expect(canvasAccount.eraseAccount(ada, { store })).rejects.toMatchObject({ code: "INVALID" });
    expect((await service.read("mine")).id).toBe("mine");
    expect((await store.query("invites", { where: { createdBy: "ada" }, limit: 5 })).items).toHaveLength(2);
  });

  test("refuses before any change when the owner grant is under an old key", async () => {
    const { store, service } = await setup();
    const grant = await store.get("grants", "mine:human:ada");
    await store.transaction(async (tx) => {
      await tx.delete("grants", "mine:human:ada");
      await tx.put("grants", "mine:ada", grant!);
    });
    await expect(canvasAccount.eraseAccount(ada, { store })).rejects.toMatchObject({ code: "INVALID" });
    expect((await service.read("mine")).id).toBe("mine");
    expect((await store.query("invites", { where: { createdBy: "ada" }, limit: 5 })).items).toHaveLength(2);
  });

  test("stops on a damaged audit entry or a damaged co-owner grant", async () => {
    const { store } = await setup();
    await store.transaction((tx) => tx.put("grants", "mine:odd", { resourceId: "mine", subjectId: "bob", role: "owner" }));
    await expect(canvasAccount.eraseAccount(ada, { store })).rejects.toMatchObject({ code: "INVALID" });
    await store.transaction((tx) => tx.delete("grants", "mine:odd"));
    await store.transaction((tx) => tx.put("audit", "oldrow", { id: "oldrow", at: 1, action: "read", resourceId: "mine", principalId: "ada", outcome: "allowed" }));
    await expect(canvasAccount.exportAccount(ada, { store })).rejects.toMatchObject({ code: "INVALID" });
    await expect(canvasAccount.eraseAccount(ada, { store })).rejects.toMatchObject({ code: "INVALID" });
    await store.transaction((tx) => tx.delete("audit", "oldrow"));
    // A row that names the subject only as the root of the chain, or as the target, with a kind we do not know.
    for (const row of <Record<string, any>[]>[
      { principalId: "bob", principalKind: "human", chain: [{ id: "ada", kind: "x" }], rootId: "ada" },
      { principalId: "bob", principalKind: "human", chain: [{ id: "bob", kind: "human" }], rootId: "bob", targetKind: "hmn", targetId: "ada" },
    ]) {
      await store.transaction((tx) => tx.put("audit", "oddrow", { id: "oddrow", at: 1, action: "grant.set", resourceId: "mine", outcome: "allowed", ...row }));
      await expect(canvasAccount.exportAccount(ada, { store })).rejects.toMatchObject({ code: "INVALID" });
      await expect(canvasAccount.eraseAccount(ada, { store })).rejects.toMatchObject({ code: "INVALID" });
    }
  });
});
