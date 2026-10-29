import { PRINCIPAL_KINDS, isMachineMade, type PrincipalKind } from "agentic-identity";
import { z } from "zod";

// The kinds and the machine-made rule come from the identity kernel.
export { PRINCIPAL_KINDS, isMachineMade };
export type { PrincipalKind };

export const principalSchema = z
  .object({ kind: z.enum(PRINCIPAL_KINDS), id: z.string().min(1).max(200) })
  .strict();
export type Principal = z.infer<typeof principalSchema>;
