import { describe, expect, it } from "vitest";
import { parsePastedItems } from "../src/index.ts";

describe("parsePastedItems (Zack, 2026-11-06: revisions from a pasted item list)", () => {
  it("reads the budget message's item lines, with or without bullets, either way round", () => {
    const text = ["Proposal validated for Smith Family.", "Total $4,512.00 incl. tax (subtotal $4,200.00, tax $312.00).", "• Sony K65XR70 × 2", "Sanus CILT4-B1 x 3", "2 x Sonos AMP", "+3 more"].join("\n");
    expect(parsePastedItems(text)).toEqual([
      { item: "Sony K65XR70", quantity: 2 },
      { item: "Sanus CILT4-B1", quantity: 3 },
      { item: "Sonos AMP", quantity: 2 },
    ]);
  });
  it("reads 0 as a removal and a leading \"Revise:\"", () => {
    expect(parsePastedItems("Revise: Strong SM-CS-ART2-L × 0")).toEqual([{ item: "Strong SM-CS-ART2-L", quantity: 0 }]);
  });
  it("reads no items in words alone", () => {
    expect(parsePastedItems("make it 2 TVs and remove the eeros")).toEqual([]);
    expect(parsePastedItems("hours to 7")).toEqual([]);
  });
});
