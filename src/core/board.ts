import * as Y from "yjs";
import { z } from "zod";
import { isMachineMade, principalSchema, storedPrincipalSchema, type Principal } from "./principal.js";

export type ErrorCode = "INVALID" | "DUPLICATE_ID" | "NOT_FOUND" | "BAD_REFERENCE" | "LIMIT" | "UNAVAILABLE" | "FORBIDDEN";

export class CanvasError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CanvasError";
  }
}

export const SHAPE_TYPES = ["rect", "ellipse", "diamond", "text", "sticky", "frame", "image"] as const;
export type ShapeType = (typeof SHAPE_TYPES)[number];
export const MAX_ELEMENTS = 10_000;
export const MAX_TEXT = 10_000;

export type Endpoint = { id: string } | { x: number; y: number };
interface Stamp {
  id: string;
  z: number;
  groupId?: string;
  /** Who made the element. Never changes. */
  author: Principal;
  /** Who made the last edit. */
  editedBy: Principal;
}
export interface Shape extends Stamp {
  type: ShapeType;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  fill?: string;
  stroke?: string;
  src?: string;
}
export interface Connector extends Stamp {
  type: "connector";
  from: Endpoint;
  to: Endpoint;
  text: string;
  startArrow: boolean;
  endArrow: boolean;
  stroke?: string;
}
export interface Group extends Stamp {
  type: "group";
}
export type CanvasElement = Shape | Connector | Group;

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const coord = z.number().finite().min(-1e7).max(1e7);
const size = z.number().finite().gt(0).max(1e7);
const text = z.string().max(MAX_TEXT);
// Colours go into SVG attributes, so allow only hex and plain names.
export const COLOR_PATTERN = /^(#[0-9a-fA-F]{3,8}|[a-z]{3,20})$/;
// No remote URLs (no outbound calls) and no SVG (script risk). Bytes live in the blob store.
export const IMAGE_PATTERN = /^(data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*|blob:[A-Za-z0-9._-]{1,200})$/;
const color = z.string().regex(COLOR_PATTERN);
const imageSrc = z.string().max(2_000_000).regex(IMAGE_PATTERN);
const endpoint = z.union([z.object({ id }).strict(), z.object({ x: coord, y: coord }).strict()]);

const shapeInput = z
  .object({
    id: id.optional(),
    type: z.enum(SHAPE_TYPES),
    x: coord,
    y: coord,
    w: size.default(120),
    h: size.default(60),
    text: text.default(""),
    fill: color.optional(),
    stroke: color.optional(),
    src: imageSrc.optional(),
  })
  .strict()
  .refine((s) => (s.type === "image") === (s.src !== undefined), {
    message: "src is required for image shapes and allowed on no other type",
  });
const connectorInput = z
  .object({
    id: id.optional(),
    from: endpoint,
    to: endpoint,
    text: text.default(""),
    startArrow: z.boolean().default(false),
    endArrow: z.boolean().default(true),
    stroke: color.optional(),
  })
  .strict();
const shapePatch = z.object({ x: coord, y: coord, w: size, h: size, text, fill: color, stroke: color, src: imageSrc }).partial().strict();
const connectorPatch = z.object({ from: endpoint, to: endpoint, text, startArrow: z.boolean(), endArrow: z.boolean(), stroke: color }).partial().strict();
const delta = z.number().finite().min(-2e7).max(2e7);

// What a stored element must look like. Peers write raw Yjs, so every read checks this.
const MAX_Z = 1e9;
const stampFields = {
  id,
  z: z.number().finite().min(-MAX_Z).max(MAX_Z),
  groupId: id.optional(),
  author: storedPrincipalSchema,
  editedBy: storedPrincipalSchema,
};
const storedShape = z
  .object({ ...stampFields, type: z.enum(SHAPE_TYPES), x: coord, y: coord, w: size, h: size, text, fill: color.optional(), stroke: color.optional(), src: imageSrc.optional() })
  .refine((s) => (s.type === "image") === (s.src !== undefined), { message: "src is required for image shapes and allowed on no other type" });
const storedConnector = z.object({
  ...stampFields,
  type: z.literal("connector"),
  from: endpoint,
  to: endpoint,
  text,
  startArrow: z.boolean(),
  endArrow: z.boolean(),
  stroke: color.optional(),
});
const storedGroup = z.object({ ...stampFields, type: z.literal("group") });
const storedElement = z.union([storedShape, storedConnector, storedGroup]);
const titleSchema = z.string().max(200);

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`);
    throw new CanvasError("INVALID", issues.join("; "));
  }
  return result.data;
}

const isBindable = (type: unknown): boolean => typeof type === "string" && type !== "connector" && type !== "group";
const isValidZ = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_Z;
const clampZ = (value: number): number => Math.min(MAX_Z, Math.max(-MAX_Z, value));
const samePrincipal = (a: Principal, b: Principal): boolean => a.kind === b.kind && a.id === b.id;
const hasId = (e: unknown): e is { id: string } => typeof e === "object" && e !== null && typeof (e as { id?: unknown }).id === "string";

/**
 * A whiteboard on a Yjs doc. Headless: no UI code. Every write names its actor.
 *
 * A synced Yjs update is untrusted input. Every read checks each stored element against the same
 * rules the write methods enforce, and returns only the checked fields. An entry that fails is
 * hidden at once. `repair()` deletes it, and `Board.decode` runs `repair()`. This holds even
 * when a caller writes to `doc` directly.
 */
export class Board {
  readonly doc: Y.Doc;
  private readonly elements: Y.Map<Y.Map<unknown>>;
  private readonly meta: Y.Map<unknown>;
  private maxElements: number;

  constructor(doc: Y.Doc = new Y.Doc(), options: { maxElements?: number } = {}) {
    this.maxElements = Math.min(options.maxElements ?? MAX_ELEMENTS, MAX_ELEMENTS);
    this.doc = doc;
    this.elements = doc.getMap("elements");
    this.meta = doc.getMap("meta");
  }

  /** Load a saved board with no element checks. Only the owner repair path uses it. */
  static open(update: Uint8Array): Board {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, update);
    return new Board(doc);
  }

  /**
   * Load a saved board. Refuses a doc past the element cap. Then it deletes every entry that fails
   * the element checks, and repairs what concurrent writers left broken.
   */
  static decode(update: Uint8Array): Board {
    const board = Board.open(update);
    if (board.elements.size > MAX_ELEMENTS) throw new CanvasError("LIMIT", `a board holds at most ${MAX_ELEMENTS} elements`);
    board.repair();
    return board;
  }

  encode(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  /** An independent copy. Edits to it leave this board alone. */
  clone(): Board {
    const copy = Board.decode(this.encode());
    copy.maxElements = this.maxElements;
    return copy;
  }

  get title(): string {
    const value = titleSchema.safeParse(this.meta.get("title"));
    return value.success ? value.data : "";
  }

  get titleBy(): Principal | undefined {
    const value = storedPrincipalSchema.safeParse(this.meta.get("titleBy"));
    return value.success ? value.data : undefined;
  }

  setTitle(title: string, actor: Principal): void {
    const t = parse(z.string().max(200), title);
    const by = parse(principalSchema, actor);
    this.doc.transact(() => {
      this.meta.set("title", t);
      this.meta.set("titleBy", by);
    });
  }

  /** One element. An invalid entry, or a connector with a missing bound end, is hidden. */
  get(elementId: string): CanvasElement | undefined {
    const el = this.stored(elementId);
    return el && !this.isDetached(el, (endId) => this.stored(endId)) ? el : undefined;
  }

  /** All visible elements from back to front. */
  list(): CanvasElement[] {
    const all = this.storedList();
    const byId = new Map(all.map((e) => [e.id, e]));
    return all.filter((e) => !this.isDetached(e, (endId) => byId.get(endId)));
  }

  /**
   * Delete what peers can leave broken: entries that fail the element checks, connectors whose
   * bound end is gone, and members that name a deleted group. Idempotent, so every peer may run it.
   * `drop` names elements the owner removes too, with what they hold: a shape takes its connectors,
   * a group takes its members. Refuses a result still past the cap, and then changes nothing.
   * Returns the ids fixed.
   */
  repair(drop: string[] = []): string[] {
    const all = this.allStored();
    const byId = new Map(all.map((e) => [e.id, e]));
    const doomed = new Set([...this.elements.keys()].filter((key) => !byId.has(key)));
    for (const name of drop) {
      if (byId.has(name)) this.subtreeIn(all, name).forEach((d) => doomed.add(d));
      else if (!this.elements.has(name)) throw new CanvasError("NOT_FOUND", `no element "${name}"`);
    }
    const alive = all.filter((e) => !doomed.has(e.id));
    const aliveById = new Map(alive.map((e) => [e.id, e]));
    const detached = new Set(alive.filter((e) => this.isDetached(e, (endId) => aliveById.get(endId))).map((e) => e.id));
    const kept = alive.filter((e) => !detached.has(e.id));
    if (kept.length > this.maxElements) throw new CanvasError("LIMIT", `a board holds at most ${this.maxElements} elements`);
    const loose = kept.filter((e) => e.groupId !== undefined && aliveById.get(e.groupId)?.type !== "group").map((e) => e.id);
    this.doc.transact(() => {
      [...doomed, ...detached].forEach((d) => this.elements.delete(d));
      loose.forEach((l) => (this.elements.get(l) as Y.Map<unknown> | undefined)?.delete("groupId"));
    });
    return [...new Set([...doomed, ...detached, ...loose])].sort();
  }

  /**
   * Make the author stamps of a merged board honest. `prior` is the board before the merge, and `trusted` says whether
   * a principal really wrote in this session. A new element stamped by anyone else is deleted. An old element keeps its
   * author, and a changed one needs a trusted editor or it goes back to its prior state. An editor stamp changed alone
   * to an untrusted principal is put back. Unknown keys, nested Yjs types, and bad or foreign title values are deleted
   * or undone. Returns the ids it deleted or restored.
   *
   * `writer` says who sent the update that holds a Yjs item, or undefined when it does not know. Where it knows, it
   * decides: a new element gets its creator as author and editor, and an old one gets the sender of its changes as editor.
   * A client cannot claim another principal, and an agent cannot pass as a person. A new item that the log lacks has no
   * sender: it is deleted or undone. Only an old item falls back to `trusted`. A hand save names its poster as the sender
   * of every item that the room does not hold, in `writer`.
   */
  restamp(prior: Board, trusted: (who: Principal) => boolean, writer?: (item: { client: number; clock: number }) => Principal | undefined): string[] {
    const before = new Map(prior.allStored().map((e) => [e.id, e]));
    const body = ({ author: _a, editedBy: _e, ...rest }: CanvasElement) => JSON.stringify(rest);
    const fixed: string[] = [];
    // An item is new when the stored board has not seen it. Only a new item can hold something the client made up.
    const isNew = (item: { client: number; clock: number }) => item.clock >= Y.getState(prior.doc.store, item.client);
    const who = (item: { client: number; clock: number }) => writer?.(item);
    // Several writers: a machine among them shows, so an agent's change is not hidden behind a later edit by a person.
    // Otherwise the editor stamp's own writer wins when it is one of them, so the last editor of two people is kept.
    const pick = (writers: Principal[], stamped?: Principal) =>
      writers.find((w) => isMachineMade(w.kind)) ?? (stamped && (writers.length === 0 || writers.some((w) => samePrincipal(w, stamped))) ? stamped : writers[0]);
    this.doc.transact(() => {
      for (const el of writer ? this.allStored() : []) {
        const entry = this.elements.get(el.id)!;
        const was = prior.elements.get(el.id);
        const by = (key: string) => {
          const item = entry._map.get(key);
          return item && !item.deleted ? who(item.id) : undefined;
        };
        if (!was) {
          // A new element has one creator, and its author. Its editor is whoever wrote its keys. If any writer is unknown,
          // the element cannot be checked, and it goes.
          const creator = entry._item ? who(entry._item.id) : undefined;
          const writers = [...entry.keys()].filter((k) => k !== "author" && k !== "editedBy").map(by);
          if (!creator || writers.some((w) => !w)) this.elements.delete(el.id);
          else {
            const editor = pick(writers as Principal[], by("editedBy")) ?? creator;
            if (samePrincipal(el.author, creator) && samePrincipal(el.editedBy, editor)) continue;
            entry.set("author", creator);
            entry.set("editedBy", editor);
          }
          fixed.push(el.id);
          continue;
        }
        // An old element: whoever wrote the keys that changed edited it. A deleted key leaves no item, so only an editor stamp
        // written in this window can name its writer. A change with no known writer goes back to its prior state.
        const raw = (map: Y.Map<unknown>, key: string) => JSON.stringify(map.get(key));
        const changed = [...new Set([...entry.keys(), ...was.keys()])].filter((k) => k !== "author" && k !== "editedBy" && raw(entry, k) !== raw(was, k));
        const found = entry._map.get("editedBy");
        const stamp = found?.deleted ? undefined : found;
        const stamped = stamp && isNew(stamp.id) ? who(stamp.id) : undefined;
        const writers = changed.map((k) => (entry.has(k) ? by(k) : stamped));
        if (writers.some((w) => !w) || (stamp && isNew(stamp.id) && !stamped)) {
          this.elements.set(el.id, new Y.Map([...was.entries()]));
          fixed.push(el.id);
          continue;
        }
        const editor = pick(writers as Principal[], stamped);
        if (editor && !samePrincipal(el.editedBy, editor)) {
          entry.set("editedBy", editor);
          fixed.push(el.id);
        }
      }
      for (const el of this.allStored()) {
        const old = before.get(el.id);
        if (!old) {
          if (trusted(el.author) && trusted(el.editedBy)) continue;
          this.elements.delete(el.id);
        } else {
          const entry = this.elements.get(el.id)!;
          const authorKept = samePrincipal(el.author, old.author);
          const editorOk = trusted(el.editedBy) || samePrincipal(el.editedBy, old.editedBy);
          const changed = body(el) !== body(old);
          if (authorKept && editorOk && !(changed && !trusted(el.editedBy))) continue;
          if (changed && !trusted(el.editedBy)) this.elements.set(el.id, new Y.Map(Object.entries(old).filter(([, v]) => v !== undefined)));
          else {
            if (!authorKept) entry.set("author", old.author);
            if (!editorOk) entry.set("editedBy", old.editedBy);
          }
        }
        fixed.push(el.id);
      }
      for (const el of this.allStored()) {
        const entry = this.elements.get(el.id)!;
        // A nested Yjs type reads as plain data but can hold more, such as an embed, so no field may be one.
        const extra = [...entry.keys()].filter((key) => !(key in el) || entry.get(key) instanceof Y.AbstractType);
        extra.forEach((key) => entry.delete(key));
        if (extra.length > 0 && !fixed.includes(el.id)) fixed.push(el.id);
      }
      // Compare the raw values: a getter hides a value that fails its check, but the doc still holds it.
      const same = (key: string) => !(this.meta.get(key) instanceof Y.AbstractType) && JSON.stringify(this.meta.get(key)) === JSON.stringify(prior.meta.get(key));
      let titleBroken = false;
      if (writer) {
        const found = this.meta._map.get("title");
        const titleItem = found?.deleted ? undefined : found;
        const byItem = this.meta._map.get("titleBy");
        // Each of the two keys that was written in this window names its writer. A deleted title leaves no item and no writer.
        const written = [titleItem, byItem?.deleted ? undefined : byItem].filter((item) => item !== undefined && isNew(item.id)).map((item) => who(item!.id));
        titleBroken = (!titleItem && prior.meta.has("title")) || written.some((w) => !w);
        const titleWriter = titleBroken ? undefined : pick(written as Principal[]);
        if (titleWriter && this.titleBy && !samePrincipal(this.titleBy, titleWriter)) {
          this.meta.set("titleBy", titleWriter);
          fixed.push("title");
        }
      }
      const by = this.titleBy;
      const title = this.meta.get("title");
      const honest = !titleBroken && by !== undefined && trusted(by) && (title === undefined || titleSchema.safeParse(title).success);
      if (!honest && !(same("title") && same("titleBy"))) {
        for (const key of ["title", "titleBy"]) {
          const old = prior.meta.get(key);
          if (old === undefined) this.meta.delete(key);
          else this.meta.set(key, old);
        }
        fixed.push("title");
      }
      for (const key of [...this.meta.keys()]) {
        if (key === "title" || key === "titleBy") continue;
        this.meta.delete(key);
        fixed.push(`meta:${key}`);
      }
    });
    return fixed;
  }

  addShape(input: unknown, actor: Principal): Shape {
    const { id: given, ...fields } = parse(shapeInput, input);
    return this.create({ ...fields, id: given }, actor) as Shape;
  }

  addConnector(input: unknown, actor: Principal): Connector {
    const { id: given, ...fields } = parse(connectorInput, input);
    this.checkEnd(fields.from);
    this.checkEnd(fields.to);
    return this.create({ ...fields, type: "connector", id: given }, actor) as Connector;
  }

  update(elementId: string, patch: unknown, actor: Principal): CanvasElement {
    const by = parse(principalSchema, actor);
    const el = this.require(elementId);
    if (el.type === "group") throw new CanvasError("INVALID", "a group has no fields to update");
    const fields: Record<string, unknown> = parse(el.type === "connector" ? connectorPatch : shapePatch, patch);
    if (Object.keys(fields).length === 0) throw new CanvasError("INVALID", "patch is empty");
    // The patch schemas let `undefined` through. Only fill and stroke may be cleared.
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined && key !== "fill" && key !== "stroke") throw new CanvasError("INVALID", `${key} cannot be cleared`);
    }
    if ("src" in fields && el.type !== "image") throw new CanvasError("INVALID", "only an image has a src");
    if (el.type === "connector") {
      this.checkEnd(fields.from as Endpoint | undefined);
      this.checkEnd(fields.to as Endpoint | undefined);
    }
    this.write([[elementId, fields]], by);
    return this.get(elementId)!;
  }

  /** Shift an element, or a whole group. Returns the ids that moved. Bound connector ends follow their shapes. */
  move(elementId: string, dx: number, dy: number, actor: Principal): string[] {
    const by = parse(principalSchema, actor);
    const [mx, my] = parse(z.tuple([delta, delta]), [dx, dy]);
    this.require(elementId);
    const free = (e: Endpoint): Endpoint => (hasId(e) ? e : { x: e.x + mx, y: e.y + my });
    const plan: [string, Record<string, unknown>][] = [];
    for (const memberId of this.subtree(elementId)) {
      const el = this.get(memberId);
      if (!el) continue;
      if (el.type === "connector") {
        const patch = parse(connectorPatch, { from: free(el.from), to: free(el.to) });
        if (!hasId(el.from) || !hasId(el.to)) plan.push([memberId, patch]);
      } else if (el.type !== "group") {
        plan.push([memberId, parse(shapePatch, { x: el.x + mx, y: el.y + my })]);
      }
    }
    this.write(plan, by);
    return plan.map(([memberId]) => memberId);
  }

  /** Delete an element. A shape takes its connectors and a group takes its members. Returns the ids removed. */
  remove(elementId: string): string[] {
    this.require(elementId);
    const doomed = new Set(this.subtree(elementId));
    for (const el of this.storedList()) {
      if (el.type === "connector" && [el.from, el.to].some((e) => hasId(e) && doomed.has(e.id))) doomed.add(el.id);
    }
    this.doc.transact(() => doomed.forEach((d) => this.elements.delete(d)));
    return [...doomed].sort();
  }

  group(ids: string[], actor: Principal, groupId?: string): Group {
    const by = parse(principalSchema, actor);
    const members = parse(z.array(id).min(2).max(MAX_ELEMENTS), ids);
    const gid = parse(id.optional(), groupId);
    if (new Set(members).size !== members.length) throw new CanvasError("INVALID", "member ids repeat");
    const parents = new Set(members.map((m) => this.require(m).groupId));
    if (parents.size > 1) throw new CanvasError("BAD_REFERENCE", "members must share one parent group");
    const [parent] = parents;
    const group = this.create({ type: "group", id: gid, groupId: parent }, by) as Group;
    this.write(members.map((m) => [m, { groupId: group.id }]), by);
    return group;
  }

  /** Remove a group and hand its members to the parent group. */
  ungroup(groupId: string, actor: Principal): void {
    const by = parse(principalSchema, actor);
    const group = this.require(groupId);
    if (group.type !== "group") throw new CanvasError("INVALID", `"${groupId}" is not a group`);
    const members = this.list().filter((e) => e.groupId === groupId);
    this.doc.transact(() => {
      this.write(members.map((m) => [m.id, { groupId: group.groupId }]), by);
      this.elements.delete(groupId);
    });
  }

  /** Put an element, or a group with its inner order kept, in front of or behind every other element. */
  reorder(elementId: string, to: "front" | "back", actor: Principal): void {
    const by = parse(principalSchema, actor);
    this.require(elementId);
    const inner = new Set(this.subtree(elementId));
    const members = this.list().filter((e) => inner.has(e.id) && e.type !== "group");
    const start = to === "front" ? this.edgeZ(1) : this.edgeZ(-1) - (members.length - 1);
    if (start < -MAX_Z || start + members.length - 1 > MAX_Z) throw new CanvasError("LIMIT", `z order is full: values must stay within ${MAX_Z}`);
    this.write(members.map((m, i) => [m.id, { z: start + i }]), by);
  }

  /** One stored element that passes the checks and whose id matches its key, or undefined. */
  private stored(key: string): CanvasElement | undefined {
    const entry: unknown = this.elements.get(key);
    if (!(entry instanceof Y.Map)) return undefined;
    const parsed = storedElement.safeParse(entry.toJSON());
    return parsed.success && parsed.data.id === key ? (parsed.data as CanvasElement) : undefined;
  }

  /** Every stored element that passes the checks, from back to front. Refuses a doc past the cap. */
  private storedList(): CanvasElement[] {
    if (this.elements.size > MAX_ELEMENTS) throw new CanvasError("LIMIT", `a board holds at most ${MAX_ELEMENTS} elements`);
    return this.allStored();
  }

  /** Like storedList, with no cap check. Repair needs every entry, even on a board past the cap. */
  private allStored(): CanvasElement[] {
    const all: CanvasElement[] = [];
    for (const key of this.elements.keys()) {
      const el = this.stored(key);
      if (el) all.push(el);
    }
    return all.sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** A connector is detached when a bound end does not name a stored shape. */
  private isDetached(el: CanvasElement, lookup: (elementId: string) => CanvasElement | undefined): boolean {
    if (el.type !== "connector") return false;
    return [el.from, el.to].some((e) => hasId(e) && !isBindable(lookup(e.id)?.type));
  }

  private require(elementId: string): CanvasElement {
    const el = this.get(elementId);
    if (!el) throw new CanvasError("NOT_FOUND", `no element "${elementId}"`);
    return el;
  }

  private checkEnd(end: Endpoint | undefined): void {
    if (!end || !hasId(end)) return;
    if (!isBindable(this.stored(end.id)?.type)) {
      throw new CanvasError("BAD_REFERENCE", `"${end.id}" is not a shape a connector can bind to`);
    }
  }

  /** The z value just past the top or the bottom. Not clamped: the caller checks the range. */
  private edgeZ(direction: 1 | -1): number {
    let z = 0;
    for (const m of this.elements.values()) {
      const value: unknown = m instanceof Y.Map ? m.get("z") : undefined;
      if (isValidZ(value)) z = direction === 1 ? Math.max(z, value) : Math.min(z, value);
    }
    return z + direction;
  }

  /** The element and, for a group, everything below it. Cycle-safe. */
  private subtree(elementId: string): string[] {
    return this.subtreeIn(this.storedList(), elementId);
  }

  private subtreeIn(all: CanvasElement[], elementId: string): string[] {
    const children = new Map<string, string[]>();
    for (const { id: childId, groupId: parent } of all) {
      if (parent !== undefined) children.set(parent, [...(children.get(parent) ?? []), childId]);
    }
    const seen = new Set([elementId]);
    for (const next of seen) for (const child of children.get(next) ?? []) seen.add(child);
    return [...seen];
  }

  private create(fields: Record<string, unknown> & { id?: string }, actor: Principal): CanvasElement {
    const by = parse(principalSchema, actor);
    const elementId = fields.id ?? crypto.randomUUID();
    if (this.elements.has(elementId)) throw new CanvasError("DUPLICATE_ID", `element "${elementId}" already exists`);
    if (this.elements.size >= this.maxElements) throw new CanvasError("LIMIT", `a board holds at most ${this.maxElements} elements`);
    const record = { ...fields, id: elementId, z: clampZ(this.edgeZ(1)), author: by, editedBy: by };
    const entries = Object.entries(record).filter(([, v]) => v !== undefined);
    this.doc.transact(() => this.elements.set(elementId, new Y.Map(entries)));
    return this.get(elementId)!;
  }

  /** Apply field changes and stamp the editor, all in one transaction. An undefined value clears the field. */
  private write(plan: [string, Record<string, unknown>][], actor: Principal): void {
    this.doc.transact(() => {
      for (const [elementId, fields] of plan) {
        const m = this.elements.get(elementId)!;
        for (const [key, value] of Object.entries(fields)) {
          if (value === undefined) m.delete(key);
          else m.set(key, value);
        }
        m.set("editedBy", actor);
      }
    });
  }
}
