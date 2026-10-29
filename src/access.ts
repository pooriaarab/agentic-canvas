import { createSharing, EraseRefusedError, hasScope, ROLES, SUBJECT_KINDS, type Action, type Grant, type InviteSummary, type PrincipalContext, type Role, type Store, type Subject } from "agentic-identity";
import { CanvasError } from "./core/board.js";
import { isBoardId, isStoreId } from "./service.js";

/** The identity resource type of a board. Scopes read `canvas:<action>`. */
export const RESOURCE_TYPE = "canvas";
export { ROLES, SUBJECT_KINDS };
/** A share link without its token. `revokedAt` is set once the link is revoked. */
export interface LinkSummary {
  id: string;
  role: Exclude<Role, "owner">;
  signedInOnly: boolean;
  expiresAt?: number;
  revokedAt?: number;
}

export type { Grant, InviteSummary, Role, Subject };

/** The roles an invite or a link may give. Only a grant makes an owner. */
const SHARE_ROLES = ROLES.filter((r) => r !== "owner");

/** The messages that agentic-identity throws for a bad input. Anything else is not ours to show. */
const BAD_INPUT = /^(give an email or a handle|invalid handle|invalid email|invalid subject( kind "[^"]*")?|the last owner cannot be removed|expiresInMs must be .*|expiresAt must be .*|invalid role .*)$/;

function refuse(error: unknown): never {
  if (error instanceof EraseRefusedError) throw new CanvasError("INVALID", error.message);
  if (error instanceof Error && error.message === "forbidden") throw new CanvasError("FORBIDDEN", "you may not do this on this board");
  if (error instanceof Error && BAD_INPUT.test(error.message)) throw new CanvasError("INVALID", error.message);
  throw error;
}

const oneOf = <T extends string>(value: unknown, list: readonly T[], name: string): T => {
  if (typeof value !== "string" || !(list as readonly string[]).includes(value)) throw new CanvasError("INVALID", `${name} must be one of: ${list.join(", ")}`);
  return value as T;
};
const storeId = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !isStoreId(value)) throw new CanvasError("INVALID", `${name} must be 1 to 128 of A-Z, a-z, 0-9, _ and -, and not like __x__`);
  return value;
};
const word = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value === "") throw new CanvasError("INVALID", `${name} must be a non-empty string`);
  return value;
};
const lifetime = (value: unknown, name: string): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new CanvasError("INVALID", `${name} must be a whole number of milliseconds above 0`);
  return value;
};

/**
 * Who may do what on a board. A board is an identity resource of type `canvas`. The roles, the grants, the invites,
 * and the links are those of agentic-identity: this class checks input and maps its failures to `CanvasError`.
 * A caller who cannot read a board gets NOT_FOUND, so a board id tells a stranger nothing. A caller who can read
 * it and lacks the role for the action gets FORBIDDEN.
 */
export class CanvasAccess {
  private readonly sharing: ReturnType<typeof createSharing>;
  private readonly now: () => number;

  constructor(private readonly store: Store, options: { now?: () => number } = {}) {
    this.sharing = createSharing(store, options);
    this.now = options.now ?? Date.now;
  }

  /** A board id that the Store refuses names no board. The gate checks this for a role holder: a token of the dev list skips the gate. */
  private known(id: string): void {
    if (!isBoardId(id)) throw new CanvasError("NOT_FOUND", `no board "${id}"`);
  }

  /** Make the actor the owner of a new board. */
  async register(ctx: PrincipalContext, id: string): Promise<void> {
    await this.sharing.createResource(ctx, { id, type: RESOURCE_TYPE }).catch((error: unknown) => {
      if (error instanceof Error && error.message === "resource exists") throw new CanvasError("DUPLICATE_ID", `board "${id}" already exists`);
      // A check of a board that was just deleted can leave an audit entry. The id is free again once an operator clears it.
      if (error instanceof Error && error.message === "resource id has old audit entries") throw new CanvasError("UNAVAILABLE", "this board id was used a moment ago. Try again, or use another id");
      return refuse(error);
    });
  }

  /** Remove the sharing records of a board. Needs an owner. */
  async unregister(ctx: PrincipalContext, id: string): Promise<void> {
    await this.sharing.deleteResource(ctx, id).catch(refuse);
  }

  /** True if the board has sharing records: it was made by an identity credential. */
  async registered(id: string): Promise<boolean> {
    // The Store refuses some ids, and a refusal is a 500. An id it would refuse names no board.
    if (!isBoardId(id)) return false;
    return (await this.store.get("resources", id))?.type === RESOURCE_TYPE;
  }

  /**
   * True if the caller may do `action` on the board. A link token adds the role of its link. It writes an audit entry.
   * An id that belongs to a resource of another type, in a Store shared with another app, is no board: it is denied.
   */
  async allowed(ctx: PrincipalContext | null, action: Action, id: string, linkToken?: string): Promise<boolean> {
    if (!(await this.registered(id))) return false;
    return (await this.sharing.can(ctx, action, id, linkToken === undefined ? {} : { linkToken })).allowed;
  }

  /** Throw NOT_FOUND for a caller who cannot read the board, and FORBIDDEN for one who can read it but not do `action`. */
  async require(ctx: PrincipalContext | null, action: Action, id: string, linkToken?: string): Promise<void> {
    if (await this.allowed(ctx, action, id, linkToken)) return;
    if (action === "read" || !(await this.allowed(ctx, "read", id, linkToken))) throw new CanvasError("NOT_FOUND", `no board "${id}"`);
    throw new CanvasError("FORBIDDEN", `this needs the ${action === "admin" ? "owner" : "editor"} role on the board`);
  }

  /** The ids of the boards a person or agent holds a role on, the first 100. A credential without `canvas:read` gets none. */
  async readable(ctx: PrincipalContext): Promise<string[]> {
    const root = ctx.chain[0];
    if (!root || !(SUBJECT_KINDS as readonly string[]).includes(root.kind) || !hasScope(ctx.scopes, `${RESOURCE_TYPE}:read`)) return [];
    const ids: string[] = [];
    // Grants of other apps share the collection, so read on until 100 boards are found, or ten pages are read.
    let cursor: string | undefined;
    for (let pages = 0; pages < 10 && ids.length < 100; pages++) {
      const page = await this.store.query("grants", { where: { subjectKind: root.kind, subjectId: root.id }, limit: 100, ...(cursor === undefined ? {} : { cursor }) });
      for (const { data } of page.items) {
        if (ids.length >= 100 || typeof data.resourceId !== "string" || !(ROLES as readonly unknown[]).includes(data.role)) continue;
        if (await this.registered(data.resourceId)) ids.push(data.resourceId);
      }
      if ((cursor = page.nextCursor) === undefined) break;
    }
    return ids;
  }

  async grant(ctx: PrincipalContext, id: string, input: { subjectKind?: unknown; subjectId?: unknown; role?: unknown }): Promise<{ ok: true }> {
    this.known(id);
    const subject: Subject = { kind: oneOf(input.subjectKind, SUBJECT_KINDS, "subjectKind"), id: storeId(input.subjectId, "subjectId") };
    await this.sharing.grant(ctx, id, subject, oneOf(input.role, ROLES, "role")).catch(refuse);
    return { ok: true };
  }

  async revoke(ctx: PrincipalContext, id: string, input: { subjectKind?: unknown; subjectId?: unknown }): Promise<{ ok: true }> {
    this.known(id);
    const subject: Subject = { kind: oneOf(input.subjectKind, SUBJECT_KINDS, "subjectKind"), id: storeId(input.subjectId, "subjectId") };
    await this.sharing.revokeGrant(ctx, id, subject).catch(refuse);
    return { ok: true };
  }

  /** The grants and the invites on a board. An invite never shows its email. `listLinks` lists the links, and never a token. */
  async list(ctx: PrincipalContext, id: string): Promise<{ grants: Grant[]; invites: InviteSummary[] }> {
    this.known(id);
    const [grants, invites] = await Promise.all([this.sharing.listGrants(ctx, id, { limit: 200 }), this.sharing.listInvites(ctx, id, { limit: 200 })]).catch(refuse);
    return { grants: grants.grants, invites: invites.invites };
  }

  async invite(ctx: PrincipalContext, id: string, input: { role?: unknown; email?: unknown; handle?: unknown; expiresInMs?: unknown }): Promise<{ id: string }> {
    this.known(id);
    const role = oneOf(input.role, SHARE_ROLES, "role");
    const expiresInMs = lifetime(input.expiresInMs, "expiresInMs");
    const who = input.email !== undefined ? { email: word(input.email, "email") } : input.handle !== undefined ? { handle: word(input.handle, "handle") } : {};
    if (input.email !== undefined && input.handle !== undefined) throw new CanvasError("INVALID", "give an email or a handle, not both");
    return this.sharing.createInvite(ctx, id, { role, ...who, ...(expiresInMs === undefined ? {} : { expiresInMs }) }).catch(refuse);
  }

  /** The email comes from a verified sign-in and the handle from the agent's own record, never from the request. */
  async accept(ctx: PrincipalContext, inviteId: string): Promise<{ ok: true }> {
    if (!isStoreId(inviteId)) throw new CanvasError("FORBIDDEN", "you may not do this on this board");
    const user = await this.store.get("users", ctx.principalId);
    const agent = await this.store.get("principals", ctx.principalId);
    const identity = {
      ...(user?.emailVerified === true && typeof user.email === "string" ? { email: user.email } : {}),
      ...(typeof agent?.handle === "string" ? { handle: agent.handle } : {}),
    };
    await this.sharing.acceptInvite(ctx, word(inviteId, "id"), identity).catch(refuse);
    return { ok: true };
  }

  /** The token shows once. Only its hash is stored. */
  async createLink(ctx: PrincipalContext, id: string, input: { role?: unknown; signedInOnly?: unknown; expiresInMs?: unknown }): Promise<{ id: string; token: string }> {
    this.known(id);
    const role = oneOf(input.role, SHARE_ROLES, "role");
    const expiresInMs = lifetime(input.expiresInMs, "expiresInMs");
    if (input.signedInOnly !== undefined && typeof input.signedInOnly !== "boolean") throw new CanvasError("INVALID", "signedInOnly must be true or false");
    return this.sharing.createLink(ctx, id, { role, signedInOnly: input.signedInOnly === true, ...(expiresInMs === undefined ? {} : { expiresAt: this.now() + expiresInMs }) }).catch(refuse);
  }

  /** The links of a board. A summary never holds the token or its hash. Needs an owner. */
  async listLinks(ctx: PrincipalContext, id: string): Promise<{ links: LinkSummary[]; truncated?: true }> {
    this.known(id);
    await this.require(ctx, "admin", id);
    // Read up to 1000 records, then show live links first: an owner who looks for a leaked link finds it before old revoked ones.
    const all: LinkSummary[] = [];
    let cursor: string | undefined;
    let cut = false;
    for (let pages = 0; pages < 10; pages++) {
      const page = await this.store.query("links", { where: { resourceId: id }, limit: 100, ...(cursor === undefined ? {} : { cursor }) });
      for (const { id: key, data } of page.items) {
        // A record that is not a share link of this board is not shown. The list says it is not complete.
        // A bad `expiresAt` is a dead link for agentic-identity, so it is not shown as one that never ends.
        const expiresOk = data.expiresAt === undefined || (typeof data.expiresAt === "number" && Number.isFinite(data.expiresAt));
        if (data.id !== key || data.resourceId !== id || typeof data.id !== "string" || !(SHARE_ROLES as readonly unknown[]).includes(data.role) || !expiresOk) {
          cut = true;
          continue;
        }
        all.push({
          id: data.id,
          role: data.role as LinkSummary["role"],
          signedInOnly: data.signedInOnly === true,
          ...(typeof data.expiresAt === "number" ? { expiresAt: data.expiresAt } : {}),
          // Any value but null means revoked, as in agentic-identity. A value that is not a time shows as 0.
          ...(data.revokedAt == null ? {} : { revokedAt: typeof data.revokedAt === "number" ? data.revokedAt : 0 }),
        });
      }
      if ((cursor = page.nextCursor) === undefined) break;
    }
    const now = this.now();
    const live = (l: LinkSummary) => l.revokedAt === undefined && (l.expiresAt === undefined || l.expiresAt > now);
    all.sort((x, y) => Number(live(y)) - Number(live(x)) || (y.expiresAt ?? Infinity) - (x.expiresAt ?? Infinity) || x.id.localeCompare(y.id));
    const links = all.slice(0, 200);
    // A cut list says so: an owner who looks for a leaked link must know it may be missing.
    return { links, ...(cut || cursor !== undefined || all.length > 200 ? { truncated: true as const } : {}) };
  }

  /** Revoke a link of this board. A link of another board is NOT_FOUND here, even for an owner of both. */
  async revokeLink(ctx: PrincipalContext, id: string, linkId: string): Promise<{ ok: true }> {
    this.known(id);
    const link = isStoreId(linkId) ? await this.store.get("links", linkId) : null;
    if (!link || link.resourceId !== id) throw new CanvasError("NOT_FOUND", "no such link on this board");
    await this.sharing.revokeLink(ctx, linkId).catch(refuse);
    return { ok: true };
  }
}
