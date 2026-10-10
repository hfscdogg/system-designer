import { describe, expect, it } from "vitest";
import { BUDGET_RANGES, likelyRange, type BudgetRanges } from "../src/index.ts";

const RANGES: BudgetRanges = {
  schema: "budget_range_v1",
  basis: "test",
  bands: { "*": { low: 0.7, high: 1.3, n: 700 }, tv_media: { low: 0.71, high: 1.13, n: 108 }, low_only: { low: 0.5, high: 0.9, n: 50 }, spread: { low: 0.2, high: 1.1, n: 20 } },
};

describe("likely range", () => {
  it("brackets the budget with the pattern's band, in whole hundreds", () => {
    expect(likelyRange("tv_media", 1_000_000, RANGES)).toEqual({ low_cents: 710_000, high_cents: 1_130_000, jobs: 108 });
    expect(likelyRange("tv_media", 123_456, RANGES)).toEqual({ low_cents: 80_000, high_cents: 140_000, jobs: 108 });
  });
  it("falls back to all jobs, always contains the budget, and stays quiet when history is too spread", () => {
    expect(likelyRange("home_network+tv_media+other", 1_000_000, RANGES)?.jobs).toBe(700);
    expect(likelyRange("low_only", 1_000_000, RANGES)).toMatchObject({ low_cents: 500_000, high_cents: 1_000_000 });
    expect(likelyRange("spread", 1_000_000, RANGES)).toBeNull();
    expect(likelyRange("tv_media", 0, RANGES)).toBeNull();
  });
  it("ships bands from the scorecard", () => {
    expect(BUDGET_RANGES.bands["*"]!.n).toBeGreaterThan(100);
  });
});

describe("design retainer tier", () => {
  it("is the largest tier not over 4%, never below $100, named like its D-Tools template", async () => {
    const { retainerTier, retainerTemplateName } = await import("../src/index.ts");
    expect(retainerTier(290_000)).toBe(10_000); // 4% = $116
    expect(retainerTier(700_000)).toBe(25_000); // 4% = $280
    expect(retainerTier(6_000_000)).toBe(100_000); // 4% = $2,400
    expect(retainerTier(50_000_000)).toBe(500_000);
    expect(retainerTier(100_000)).toBe(10_000);
    expect(retainerTemplateName(100_000)).toBe("Design Retainer $1,000");
  });
});
