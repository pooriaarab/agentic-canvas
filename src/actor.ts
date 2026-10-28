import { PRINCIPAL_KINDS, principalSchema, type Principal } from "./core/principal.js";

/** The operator set CANVAS_ACTOR wrong or not at all. */
export class ActorConfigError extends Error {}

/**
 * The actor for every write, from the operator's CANVAS_ACTOR as <kind>:<id>.
 * A caller never picks its own actor or kind. Unset, empty, or bad is an error.
 */
export function operatorActor(env: Record<string, string | undefined> = process.env): Principal {
  const raw = env.CANVAS_ACTOR;
  if (!raw) throw new ActorConfigError("the operator must set CANVAS_ACTOR=<kind>:<id>");
  const at = raw.indexOf(":");
  const parsed = principalSchema.safeParse({ kind: raw.slice(0, at), id: raw.slice(at + 1) });
  if (at < 0 || !parsed.success) {
    throw new ActorConfigError(`bad CANVAS_ACTOR "${raw}": use <kind>:<id>, kind is one of ${PRINCIPAL_KINDS.join(", ")}`);
  }
  return parsed.data;
}
