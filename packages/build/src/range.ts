import { z } from "zod";
import RANGES from "./budget-range.json" with { type: "json" };

/**
 * The likely price range shown next to a budget: where the middle half of
 * similar accepted Livewire jobs landed, as a multiple of what System Designer
 * priced for the same device list (apps/worker/scripts/scorecard.ts writes the
 * bands). Patterns without enough history use the all-jobs band.
 */
export const BudgetRangesSchema = z
  .object({
    schema: z.literal("budget_range_v1"),
    basis: z.string().min(1),
    bands: z.record(z.string(), z.object({ low: z.number().positive(), high: z.number().positive(), n: z.number().int().positive() }).strict()),
  })
  .strict()
  .refine((r) => "*" in r.bands, { message: "bands must include the all-jobs band \"*\"" });

export type BudgetRanges = z.infer<typeof BudgetRangesSchema>;
export interface LikelyRange {
  low_cents: number;
  high_cents: number;
  /** How many accepted jobs the band comes from. */
  jobs: number;
}

export const BUDGET_RANGES: BudgetRanges = BudgetRangesSchema.parse(RANGES);

/** The range for a budget of `cents` under `pattern`, in whole hundreds of dollars, always containing the budget. */
export function likelyRange(pattern: string, cents: number, ranges: BudgetRanges = BUDGET_RANGES): LikelyRange | null {
  if (cents <= 0) return null;
  const band = ranges.bands[pattern] ?? ranges.bands["*"]!;
  // History too spread to say anything useful (more than 3x from low to high): no range.
  if (Math.max(1, band.high) / Math.min(1, band.low) > 3) return null;
  return {
    low_cents: Math.floor((cents * Math.min(1, band.low)) / 10000) * 10000,
    high_cents: Math.ceil((cents * Math.max(1, band.high)) / 10000) * 10000,
    jobs: band.n,
  };
}
