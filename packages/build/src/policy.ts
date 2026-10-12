import { z } from "zod";

/**
 * Commercial policy: margin, labor-rate, parts and tax rules. Configuration,
 * never prompt text (PRD §15.4). Only an admin can publish a new version;
 * production values are Henry's decision (PRD §23), so nothing here has a default.
 *
 * Margins follow the Livewire sales compensation policy: a gross-profit floor
 * per market, and a target mix of equipment, labor and parts.
 */
const pct = z.number().min(0).max(100);
const MixTargetSchema = z.object({ share_pct: pct, margin_pct: pct }).strict();

export const CommercialPolicySchema = z
  .object({
    schema: z.literal("commercial_policy_v2"),
    margin: z.object({ residential_min_gross_margin_pct: pct, commercial_min_gross_margin_pct: pct }).strict(),
    mix_targets: z.object({ equipment: MixTargetSchema, labor: MixTargetSchema, parts: MixTargetSchema }).strict(),
    /**
     * Hourly labor rates by D-Tools labor type. The D-Tools API does not expose
     * labor types, so the rates are configuration kept in step with D-Tools.
     */
    labor_rates: z
      .array(z.object({ labor_type: z.string().min(1), price_per_hour: z.number().positive(), cost_per_hour: z.number().min(0) }).strict())
      .min(1),
    tax: z.union([
      z.object({ mode: z.literal("tbd") }).strict(),
      z.object({ mode: z.literal("rate"), rate_pct: pct, applies_to: z.literal("taxable_equipment") }).strict(),
    ]),
    /**
     * Design & Delivery (the parts line): base_pct of product + labor + services, and
     * how high it may go to bring a budget up to the margin floor before the
     * budget needs an admin's approval instead. Absent: parts are sized to the
     * parts share of the subtotal, as before.
     */
    design_delivery: z.object({ base_pct: pct, max_pct: pct }).strict().optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    const shares = p.mix_targets.equipment.share_pct + p.mix_targets.labor.share_pct + p.mix_targets.parts.share_pct;
    if (Math.abs(shares - 100) > 0.001) ctx.addIssue({ code: "custom", message: `mix target shares must add up to 100, got ${shares}` });
    if (p.mix_targets.parts.share_pct >= 100) ctx.addIssue({ code: "custom", message: "parts share must be below 100" });
    if (p.design_delivery && p.design_delivery.max_pct < p.design_delivery.base_pct) ctx.addIssue({ code: "custom", message: "design_delivery max_pct must be at least base_pct" });
  });

export type CommercialPolicy = z.infer<typeof CommercialPolicySchema>;

export interface PolicyRecord {
  version: number;
  policy: CommercialPolicy;
}

export function minimumMarginPct(policy: CommercialPolicy, market: "residential" | "commercial"): number {
  return market === "residential" ? policy.margin.residential_min_gross_margin_pct : policy.margin.commercial_min_gross_margin_pct;
}
