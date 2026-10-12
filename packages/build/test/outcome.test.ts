import { describe, expect, it } from "vitest";
import { describeDiff, diffSelections, scoreBudget, type BudgetVersion, type FinalQuote, type SelectionLine } from "../src/index.ts";

const line = (role: string, quantity: number, record_id = `${role}-std`, requested_model?: string): SelectionLine => ({
  role, record_id, quantity, quantity_basis: "fixed", verify: null, location: "House", precedent: "livewire_standard", ...(requested_model ? { requested_model } : {}),
});
const NOW = new Date("2026-11-01T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const version = (over: Partial<BudgetVersion> = {}): BudgetVersion => ({
  run_id: "run_1", state: "READY_HELD", created_at: daysAgo(1), total_cents: 100_000, retainer_sent: false, final_quote: null,
  selection: { pattern: "tv_media", lines: [line("tv_mount", 2), line("soundbar", 1)] },
  ...over,
});
const quote = (price_cents: number, state = "Presented"): FinalQuote => ({
  quote_id: "q", number: "32501", name: "Quote", state, version: 1, price_cents, accepted_at: null, modified_at: null, equipment_by_system: {}, labor_hours: 0,
});

describe("revision diff", () => {
  it("names systems, roles, quantities and swaps that changed, and the total", () => {
    const d = diffSelections(
      { pattern: "home_network+tv_media", lines: [line("mesh_wifi", 3), line("tv_mount", 2), line("soundbar", 1)] },
      { pattern: "tv_media", lines: [line("tv_mount", 1), line("soundbar", 1, "sb-x", "Sonos Arc Ultra"), line("television", 1)] },
      200_000,
      150_000,
    );
    expect(d).toEqual({
      systems_added: [],
      systems_removed: ["home_network"],
      roles_added: ["television"],
      roles_removed: ["mesh_wifi"],
      quantity_changes: [{ role: "tv_mount", from: 2, to: 1 }],
      swaps: [{ role: "soundbar", from: ["soundbar-std"], to: ["Sonos Arc Ultra"] }],
      total_change_pct: -25,
    });
    expect(describeDiff(d)).toBe("removed home_network; +television; -mesh_wifi; tv_mount 2→1; soundbar soundbar-std→Sonos Arc Ultra; total -25%");
  });
});

describe("budget score", () => {
  const edited = (lines: SelectionLine[], total: number, over: Partial<BudgetVersion> = {}) => [version({ created_at: daysAgo(3) }), version({ run_id: "run_2", selection: { pattern: "tv_media", lines }, total_cents: total, ...over })];

  it("left as built and sent is a 5; not sent yet waits; dropped after 14 days is a 1", () => {
    expect(scoreBudget([version({ retainer_sent: true })], NOW)).toMatchObject({ stars: 5, why: "left as built; retainer sent" });
    expect(scoreBudget([version()], NOW)).toMatchObject({ stars: null, why: "left as built; retainer not sent yet" });
    expect(scoreBudget([version({ created_at: daysAgo(15) })], NOW)).toMatchObject({ stars: 1, why: "left as built; no retainer after 14 days" });
  });

  it("small edits are a 4, scope changes or a big move a 3", () => {
    expect(scoreBudget(edited([line("tv_mount", 1), line("soundbar", 1)], 95_000, { retainer_sent: true }), NOW)).toMatchObject({ stars: 4, why: "1 small edit, total moved 5%; retainer sent" });
    expect(scoreBudget(edited([line("tv_mount", 1), line("soundbar", 1)], 80_000, { retainer_sent: true }), NOW).stars).toBe(3);
    expect(scoreBudget(edited([line("tv_mount", 2)], 99_000, { retainer_sent: true }), NOW)).toMatchObject({ stars: 3, why: "1 edit changed the scope, total moved 1%; retainer sent" });
  });

  it("tries that blocked on the way cap the score at 3 (the Darren Mackin session)", () => {
    const stuck = version({ run_id: "run_b", state: "BLOCKED", selection: null, total_cents: null, created_at: daysAgo(2) });
    expect(scoreBudget([version({ created_at: daysAgo(3) }), stuck, stuck, version({ run_id: "run_2", retainer_sent: true })], NOW)).toMatchObject({
      stars: 3,
      why: "1 small edit, total moved 0%; 2 tries blocked; retainer sent",
    });
  });

  it("blocked is a 2; unfinished waits, then is a 1", () => {
    expect(scoreBudget([version({ state: "BLOCKED", selection: null, total_cents: null })], NOW)).toMatchObject({ stars: 2, why: "stopped at BLOCKED" });
    expect(scoreBudget([version({ state: "NEEDS_CLARIFICATION", selection: null })], NOW).stars).toBeNull();
    expect(scoreBudget([version({ state: "NEEDS_CLARIFICATION", selection: null, created_at: daysAgo(20) })], NOW).stars).toBe(1);
  });

  it("the real quote decides: within 20% lifts the score, further off caps it at 3", () => {
    const small = edited([line("tv_mount", 1), line("soundbar", 1)], 95_000);
    expect(scoreBudget([...small.slice(0, 1), { ...small[1]!, final_quote: quote(100_000, "Accepted") }], NOW)).toMatchObject({ stars: 5, final_quote_diff_pct: -5 });
    expect(scoreBudget([version({ retainer_sent: true, final_quote: quote(150_000) })], NOW)).toMatchObject({
      stars: 3,
      final_quote_diff_pct: -33.3,
      why: "left as built; ours -33.3% vs presented quote 32501",
    });
  });
});
