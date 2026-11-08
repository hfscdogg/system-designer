import { describe, expect, it } from "vitest";
import { historyCheck, JOB_HISTORY, type JobHistory } from "../src/index.ts";

const history: JobHistory = {
  schema: "job_history_v1",
  basis: "test",
  bands: {
    "*": [{ min: 1, max: 2, p10: 300, p90: 3500, n: 300 }],
    tv_media: [
      { min: 1, max: 2, p10: 500, p90: 5000, n: 90 },
      { min: 3, max: 5, p10: 2500, p90: 9000, n: 20 },
    ],
  },
};

describe("job history check (Henry, 2026-11-07: warn the rep, never hold)", () => {
  it("places a budget against its pattern's band for its device count", () => {
    expect(historyCheck("tv_media", 2, 300000, history)).toMatchObject({ position: "within", low_cents: 50000, high_cents: 500000, jobs: 90, devices: [1, 2] });
    expect(historyCheck("tv_media", 4, 1200000, history)).toMatchObject({ position: "above", jobs: 20 });
    expect(historyCheck("tv_media", 4, 100000, history)).toMatchObject({ position: "below" });
  });
  it("falls back to all jobs for a pattern without history, and says nothing without a band", () => {
    expect(historyCheck("smart_locks", 1, 400000, history)).toMatchObject({ position: "above", jobs: 300 });
    expect(historyCheck("smart_locks", 30, 400000, history)).toBeNull();
    expect(historyCheck("tv_media", 0, 400000, history)).toBeNull();
  });
  it("ships bands from real accepted jobs, with enough jobs behind each", () => {
    expect(JOB_HISTORY.bands["*"]!.length).toBeGreaterThan(3);
    for (const bands of Object.values(JOB_HISTORY.bands)) for (const b of bands) {
      expect(b.n).toBeGreaterThanOrEqual(8);
      expect(b.p10).toBeLessThan(b.p90);
    }
  });
});
