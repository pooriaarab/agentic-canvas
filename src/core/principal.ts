import { PRINCIPAL_KINDS, isMachineMade, parsePrincipal, type PrincipalKind } from "agentic-identity";
import { z } from "zod";

// The kinds and the machine-made rule come from the identity kernel.
export { PRINCIPAL_KINDS, isMachineMade };
export type { PrincipalKind };

/**
 * The actor of a new write. The rule is the identity kernel's `parsePrincipal`: a known kind, and an id of 1 to 128
 * characters from A-Z, a-z, 0-9, ".", "_" and "-". The Worker, the CLI and the SDK all use it.
 */
export const principalSchema = z
  .object({ kind: z.string(), id: z.string() })
  .strict()
  .transform((value, ctx): { kind: PrincipalKind; id: string } => {
    try {
      return parsePrincipal(value);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "invalid principal" });
      return z.NEVER;
    }
  });
export type Principal = { kind: PrincipalKind; id: string };

/** A principal read from a stored board. It keeps the older, looser id rule, so boards written before the strict rule still open. */
export const storedPrincipalSchema = z
  .object({ kind: z.enum(PRINCIPAL_KINDS), id: z.string().min(1).max(200) })
  .strict();
