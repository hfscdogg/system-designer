import { z } from "zod";
import HISTORY from "./job-history.json" with { type: "json" };

/**
 * Where similar accepted Livewire jobs landed, independent of what System Designer priced: for each pattern and
 * device-count bucket, the 10th and 90th percentile of what customers accepted (apps/worker/scripts/scorecard.ts
 * writes the bands from a D-Tools export; aggregates only). A budget outside its band is flagged to the rep, never
 * held (Henry, 2026-11-07): the likely range scales with our own total, so it can't catch a mispriced budget.
 */
export const JobHistorySchema = z
  .object({
    schema: z.literal("job_history_v1"),
    basis: z.string().min(1),
    bands: z.record(
      z.string(),
      z.array(z.object({ min: z.number().int().positive(), max: z.number().int().positive().nullable(), p10: z.number().positive(), p90: z.number().positive(), n: z.number().int().positive() }).strict()),
    ),
  })
  .strict();

export type JobHistory = z.infer<typeof JobHistorySchema>;

export const JOB_HISTORY: JobHistory = JobHistorySchema.parse(HISTORY);

/** Device-count buckets, by their smallest count: 1–2, 3–5, 6–10, 11–20, 21–40, 41 or more. */
export const DEVICE_BUCKETS: Array<[number, number | null]> = [
  [1, 2],
  [3, 5],
  [6, 10],
  [11, 20],
  [21, 40],
  [41, null],
];

/** Equipment that isn't a device a customer counts: cable by the foot, racks, power strips, brackets, parts. */
export const ACCESSORY_CATEGORY =
  /^(Wire and Cable|Interconnect Cables|Uncategorized|Power Distribution|Warranties|Equipment Racks|Parts|Labor)|^Mounts > (Accessories|Flush Wall|Projector|Speaker)|^Speakers > (Accessories|Speaker Brackets|Back Boxes)|^Surveillance > Brackets/;

export interface HistoryCheck {
  low_cents: number;
  high_cents: number;
  jobs: number;
  devices: [number, number | null];
  position: "below" | "within" | "above";
}

/** The band of similar accepted jobs for a budget of `cents` with `devices` devices under `pattern`, and where it sits. */
export function historyCheck(pattern: string, devices: number, cents: number, history: JobHistory = JOB_HISTORY): HistoryCheck | null {
  if (devices <= 0 || cents <= 0) return null;
  const inBucket = (b: { min: number; max: number | null }) => devices >= b.min && (b.max === null || devices <= b.max);
  const band = (history.bands[pattern] ?? []).find(inBucket) ?? (history.bands["*"] ?? []).find(inBucket);
  if (!band) return null;
  const low = Math.round(band.p10 * 100);
  const high = Math.round(band.p90 * 100);
  return { low_cents: low, high_cents: high, jobs: band.n, devices: [band.min, band.max], position: cents < low ? "below" : cents > high ? "above" : "within" };
}
