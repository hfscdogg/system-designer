import { z } from "zod";

/**
 * Commercial policy: margin and tax rules. Configuration, never prompt text
 * (PRD §15.4). Only an admin can publish a new version; production values are
 * Henry's decision (PRD §23), so nothing here has a default.
 */
export const CommercialPolicySchema = z
  .object({
    schema: z.literal("commercial_policy_v1"),
    margin: z.object({ minimum_gross_margin_pct: z.number().min(0).max(100) }).strict(),
    tax: z.union([
      z.object({ mode: z.literal("tbd") }).strict(),
      z.object({ mode: z.literal("rate"), rate_pct: z.number().min(0).max(100), applies_to: z.literal("taxable_equipment") }).strict(),
    ]),
  })
  .strict();

export type CommercialPolicy = z.infer<typeof CommercialPolicySchema>;

export interface PolicyRecord {
  version: number;
  policy: CommercialPolicy;
}
