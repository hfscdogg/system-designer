import { describe, expect, it } from "vitest";
import { notPlaced } from "../src/activities.ts";

// Henry's demo (2026-11-09): "I couldn't safely apply that answer. Could you rephrase it?" told the rep nothing to try.
describe("a reply the scope can't place", () => {
  it("names what the rep said back, with ways to say it that work", () => {
    const m = notPlaced("this is only 1 run of cat6 in an existing home", true);
    expect(m).toContain('I couldn\'t place "this is only 1 run of cat6 in an existing home" in the earlier budget.');
    expect(m).toContain('"make it 1 Cat6 drop"');
    expect(m).toContain("dollar amount");
    expect(m).toContain('"New request"');
    expect(notPlaced("10' linear lighting in kitchen")).toContain('in the scope.');
    expect(notPlaced("10' linear lighting in kitchen")).toContain('"Start over"');
  });
  it("keeps a long reply short", () => {
    expect(notPlaced("x".repeat(500))).toContain(`"${"x".repeat(117)}..."`);
  });
});
