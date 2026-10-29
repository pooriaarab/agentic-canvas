// The package's side of the account contract: a host calls `exportAccount` and `eraseAccount` and never reads the
// storage layout. The shape is provisional, as in other agentic packages: it is the contract that a later
// `agentic-identity` release adds to `agentic-identity/account` as `AccountPackage`. The `AccountApp` of 0.9.0 is a
// different contract (files for a zip), and this does not fit it.
import { createSharing, ROLES, type Json, type PrincipalContext, type Store } from "agentic-identity";
import { Board, CanvasError } from "./core/board.js";
import { principalSchema, type Principal } from "./core/principal.js";
import { RESOURCE_TYPE } from "./access.js";
import { fromBase64, isBoardId, toBase64 } from "./service.js";

export interface CanvasAccountDeps {
  /** The Store that holds the boards and the sharing records. */
  store: Store;
  /** Saves the live room of a board to the Store, as the Worker does before it reads a board. Without it, edits that no request has saved yet are not seen, and an erase that resets a room drops them. A board with no room needs no work. Omit it when no room runs. */
  saveRoom?: (boardId: string) => Promise<void>;
  /** Erases the live room of a board, so it opens again from the Store. The erase calls it for every board that it changes or deletes. Omit it when no room runs. */
  eraseRoom?: (boardId: string) => Promise<void>;
}

export type CanvasCollection = "boards" | "grants" | "invites" | "authored_elements" | "edited_elements" | "titles" | "audit";

export interface CanvasAccount {
  id: "canvas";
  /**
   * Collections: `boards` (each board the subject is the only owner of, with its elements), `grants` (every role the subject
   * holds on a board), `invites` (made by the subject, with no email), `authored_elements` (made by the subject on a board of someone else, with
   * its `boardId`), `edited_elements` (made by someone else, last edited by the subject: `boardId` and `elementId`), `titles` (boards
   * of someone else whose title the subject set), and `audit` (entries on a board where the subject acted as the principal, as the root of the chain, or was the target of a grant, as stored). It holds no format, version, or time.
   */
  exportAccount(subject: Principal, deps: CanvasAccountDeps): Promise<Record<CanvasCollection, Json[]>>;
  /**
   * Deletes the boards the subject is the only owner of, with their grants, invites, links, and audit entries. On every other
   * board it removes the subject's grant and invites, deletes the elements the subject made, sets the editor of the
   * elements it edited to `(erased)`, clears a title it set, and sets its audit entries to `(erased)`. Counts by the same collection
   * names. A second run counts zero. Run it with writes stopped: a write after the export is erased and not exported.
   */
  eraseAccount(subject: Principal, deps: CanvasAccountDeps): Promise<Record<CanvasCollection, number>>;
}

/** Not a valid principal id, so no real principal can be named like it, and a stamp of it is never found again. */
const ERASED = "(erased)";
const PAGE = 100;

async function* pages(store: Store, collection: string, where: Record<string, string>): AsyncGenerator<{ id: string; data: Record<string, unknown> }> {
  let cursor: string | undefined;
  do {
    const page = await store.query(collection, { where, limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
    yield* page.items;
    cursor = page.nextCursor;
  } while (cursor !== undefined);
}
const rows = async (store: Store, collection: string, where: Record<string, string>) => {
  const out: { id: string; data: Record<string, unknown> }[] = [];
  for await (const row of pages(store, collection, where)) out.push(row);
  return out;
};

/** Through JSON, so the records are what a file would hold. */
const plain = (value: unknown): Json[] => JSON.parse(JSON.stringify(value)) as Json[];

function check(subject: Principal, deps: CanvasAccountDeps): void {
  if (typeof deps?.store?.query !== "function") throw new CanvasError("INVALID", "canvasAccount needs deps.store");
  for (const hook of [deps.saveRoom, deps.eraseRoom]) if (hook !== undefined && typeof hook !== "function") throw new CanvasError("INVALID", "deps.saveRoom and deps.eraseRoom must be functions");
  // Every principal kind may stamp an element or an audit entry, so every kind is a subject. A kind that holds no role has no grants.
  if (!principalSchema.safeParse(subject).success) throw new CanvasError("INVALID", "subject needs an id and a known kind");
}

interface Held { grantId: string; resourceId: string; role: string }

/** The boards the subject holds a role on, and which of them it alone owns. */
async function held(store: Store, subject: Principal): Promise<{ all: Held[]; sole: Set<string> }> {
  const all: Held[] = [];
  const sole = new Set<string>();
  for await (const { id: grantId, data } of pages(store, "grants", { subjectKind: subject.kind, subjectId: subject.id })) {
    const { resourceId: id, role } = data;
    // A grant that we cannot read may be a canvas grant: stop, and do not report an erase that left it.
    if (typeof id !== "string" || typeof role !== "string" || !(ROLES as readonly string[]).includes(role)) throw new CanvasError("INVALID", `grant "${grantId}" of the subject is damaged`);
    const resource = await store.get("resources", id);
    // A grant with no resource is what an erase that stopped half way leaves. A resource of another type is another app's.
    if (resource === null ? !isBoardId(id) : resource.type !== RESOURCE_TYPE) continue;
    all.push({ grantId, resourceId: id, role });
    if (resource === null || role !== "owner") continue;
    const owners = await rows(store, "grants", { resourceId: id, role: "owner" });
    if (owners.every((o) => o.data.subjectKind === subject.kind && o.data.subjectId === subject.id)) sole.add(id);
  }
  return { all, sole };
}

/** Every stored board, one page at a time. A board that does not decode stops the call: it may hold the subject's data. */
async function* boards(store: Store, saveRoom?: (boardId: string) => Promise<void>): AsyncGenerator<{ id: string; board: Board }> {
  let cursor: string | undefined;
  do {
    const page = await store.query("boards", { limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
    for (const item of page.items) {
      const { id } = item;
      let data = item.data;
      if (saveRoom) {
        await saveRoom(id);
        data = (await store.get("boards", id)) ?? data;
      }
      try {
        yield { id, board: Board.open(fromBase64(String(data.update))) };
      } catch {
        throw new CanvasError("INVALID", `stored board "${id}" is damaged`);
      }
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
}

const isSubject = (value: unknown, subject: Principal) => typeof value === "object" && value !== null && (value as Principal).kind === subject.kind && (value as Principal).id === subject.id;

/** The audit entries about the subject on a canvas board: the subject acted, acted through the chain it roots, or was the target of a grant. A host with other apps on the Store keeps their entries. */
async function auditOf(store: Store, subject: Principal): Promise<{ id: string; data: Record<string, unknown> }[]> {
  const found = new Map<string, { id: string; data: Record<string, unknown> }>();
  for (const field of ["principalId", "rootId", "targetId"]) for (const row of await rows(store, "audit", { [field]: subject.id })) found.set(row.id, row);
  const out: { id: string; data: Record<string, unknown> }[] = [];
  for (const row of found.values()) {
    const { principalId, principalKind, chain, rootId, resourceId, targetKind, targetId } = row.data;
    const mine = isSubject({ kind: principalKind, id: principalId }, subject) || (Array.isArray(chain) ? isSubject(chain[0], subject) : rootId === subject.id) || isSubject({ kind: targetKind, id: targetId }, subject);
    if (!mine || typeof resourceId !== "string" || !isBoardId(resourceId)) continue;
    // A deleted board has no sharing record, and its entries still count. Only a record of another type clears a row.
    const resource = await store.get("resources", resourceId);
    if (resource === null || resource.type === RESOURCE_TYPE) out.push(row);
  }
  return out;
}

/** The invites the subject made on a canvas board. An invite on a resource of another type is another app's. */
async function invitesOf(store: Store, subject: Principal): Promise<{ id: string; data: Record<string, unknown> }[]> {
  const out: { id: string; data: Record<string, unknown> }[] = [];
  for (const row of await rows(store, "invites", { createdBy: subject.id })) {
    const { resourceId } = row.data;
    if (typeof resourceId !== "string") throw new CanvasError("INVALID", `invite "${row.id}" of the subject is damaged`);
    if (!isBoardId(resourceId)) continue;
    const resource = await store.get("resources", resourceId);
    if (resource === null || resource.type === RESOURCE_TYPE) out.push(row);
  }
  return out;
}

/** The entry with the subject's id replaced. The kinds stay, so the entry still says whether a machine acted. */
function scrub(data: Record<string, unknown>, subject: Principal): Record<string, unknown> {
  const erase = (step: unknown) => (isSubject(step, subject) ? { ...(step as object), id: ERASED } : step);
  return {
    ...data,
    ...(isSubject({ kind: data.principalKind, id: data.principalId }, subject) ? { principalId: ERASED } : {}),
    ...(data.rootId === subject.id ? { rootId: ERASED } : {}),
    ...(isSubject({ kind: data.targetKind, id: data.targetId }, subject) ? { targetId: ERASED } : {}),
    ...(Array.isArray(data.chain) ? { chain: data.chain.map(erase) } : {}),
  };
}

export const canvasAccount: CanvasAccount = {
  id: "canvas",
  async exportAccount(subject, deps) {
    check(subject, deps);
    const { store } = deps;
    const out: Record<CanvasCollection, Json[]> = { boards: [], grants: [], invites: [], authored_elements: [], edited_elements: [], titles: [], audit: [] };
    const mine = await held(store, subject);
    const owned = new Map<string, Json>();
    for await (const { id, board } of boards(store, deps.saveRoom)) {
      if (mine.sole.has(id)) {
        // Every stored entry as it is: the read model cuts images and groups, and the erase deletes the whole board.
        owned.set(id, plain([{ id, title: board.title, elements: board.rawElements() }])[0]!);
        continue;
      }
      const found = board.stampedBy(subject);
      out.authored_elements.push(...plain(found.authored.map((element) => ({ boardId: id, element }))));
      out.edited_elements.push(...plain(found.edited.map((elementId) => ({ boardId: id, elementId }))));
      if (found.titleBy) out.titles.push(...plain([{ boardId: id, title: board.title }]));
    }
    for (const g of mine.all) {
      out.grants.push(...plain([{ resourceId: g.resourceId, subjectKind: subject.kind, subjectId: subject.id, role: g.role }]));
      // A grant with no board behind it (an erase that stopped half way) has nothing to export.
      const board = owned.get(g.resourceId);
      if (board) out.boards.push(board);
    }
    // Invites hold `createdBy` as an id with no kind: ids are unique across kinds in the identity store. The fields are listed, so a new one is not exported by chance.
    for (const { id, data } of await invitesOf(store, subject)) {
      const { resourceId, role, expiresAt, acceptedAt, revokedAt } = data;
      out.invites.push(...plain([{ id, resourceId, role, expiresAt, acceptedAt, revokedAt }]));
    }
    out.audit.push(...plain((await auditOf(store, subject)).map((r) => r.data)));
    return out;
  },

  async eraseAccount(subject, deps) {
    check(subject, deps);
    const { store } = deps;
    const sharing = createSharing(store);
    const total: Record<CanvasCollection, number> = { boards: 0, grants: 0, invites: 0, authored_elements: 0, edited_elements: 0, titles: 0, audit: 0 };
    const ctx: PrincipalContext = { principalId: subject.id, kind: subject.kind, chain: [{ id: subject.id, kind: subject.kind }], scopes: [`${RESOURCE_TYPE}:admin`] };
    const mine = await held(store, subject);

    // Scan every board before the first change: a board that does not decode stops the call with nothing done.
    const stamped: string[] = [];
    for await (const { id, board } of boards(store, deps.saveRoom)) {
      if (mine.sole.has(id)) continue;
      const found = board.stampedBy(subject);
      if (found.authored.length > 0 || found.edited.length > 0 || found.titleBy) stamped.push(id);
    }
    // The sharing erase refuses a board that has child resources. Refuse here, before the first delete, so a retry can finish.
    // It also checks that the sharing erase accepts the subject as owner: a grant under an old key is found here and refused there.
    for (const id of mine.sole) {
      if ((await rows(store, "resources", { parentId: id })).length > 0) throw new CanvasError("INVALID", `board "${id}" has child resources: remove them first`);
      if (!(await sharing.can(ctx, "admin", id)).allowed) throw new CanvasError("INVALID", `the owner grant on board "${id}" is not valid: an operator repairs it first`);
    }
    // Audit first: the entries of a board that goes below are removed with it, and a repeat after a failure still finds the rest.
    for (const { id, data } of await auditOf(store, subject)) {
      await store.put("audit", id, scrub(data, subject) as Record<string, Json>);
      total.audit += 1;
    }
    for (const { id } of await invitesOf(store, subject)) {
      await store.delete("invites", id);
      total.invites += 1;
    }
    for (const id of mine.sole) {
      // The room, then the board, then the room again for a client that joined in between, then the sharing records, as the Worker does.
      await deps.eraseRoom?.(id);
      await store.delete("boards", id);
      await deps.eraseRoom?.(id);
      await sharing.deleteResource(ctx, id).catch((e: unknown) => {
        if (e instanceof Error && (e.name === "EraseRefusedError" || e.message === "forbidden")) throw new CanvasError("INVALID", e.message);
        throw e;
      });
      total.boards += 1;
    }
    for (const id of stamped) {
      // The board is read again inside the transaction, so a save between the scan and here is not lost.
      const done = await store.transaction(async (tx) => {
        const doc = await tx.get("boards", id);
        if (!doc) return null;
        let board: Board;
        try {
          board = Board.open(fromBase64(String(doc.update)));
        } catch {
          throw new CanvasError("INVALID", `stored board "${id}" is damaged`);
        }
        const counts = board.eraseStamps(subject, { kind: subject.kind, id: ERASED });
        await tx.put("boards", id, { update: toBase64(board.encode()) });
        return counts;
      });
      // A client that joined between the first erase and the write loaded the old state. Erase the room again.
      await deps.eraseRoom?.(id);
      if (!done) continue;
      total.authored_elements += done.authored;
      total.edited_elements += done.edited;
      total.titles += done.title ? 1 : 0;
    }
    // The grants go last: a failed run is found again from them.
    for (const g of mine.all) {
      if (mine.sole.has(g.resourceId)) {
        total.grants += 1;
        continue;
      }
      await store.delete("grants", g.grantId);
      total.grants += 1;
    }
    return total;
  },
};
