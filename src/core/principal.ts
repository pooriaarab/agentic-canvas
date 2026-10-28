import { z } from "zod";

// Same kinds as the identity kernel. Swap this file for its export once that
// package is on npm.
export const PRINCIPAL_KINDS = ["human", "agent_of_human", "agent_of_agent", "agent", "user_token"] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

export const principalSchema = z
  .object({ kind: z.enum(PRINCIPAL_KINDS), id: z.string().min(1).max(200) })
  .strict();
export type Principal = z.infer<typeof principalSchema>;

/** Machine-made content and edits carry this label (EU AI Act transparency). */
export function isMachineMade(kind: PrincipalKind): boolean {
  return kind !== "human";
}
