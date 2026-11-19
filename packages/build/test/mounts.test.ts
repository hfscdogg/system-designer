import { describe, expect, it } from "vitest";
import { loadPatterns, materialize, selectPattern } from "../src/index.ts";
import { approvedScope } from "./fixtures.ts";

// One rule for TV mounts (Henry, 2026-11-19): a mount per TV the job hangs on a wall, typed per TV, the standard tilt
// when no type is named; only the rep's total overrides it. A WattBox per wall TV the job installs, ours or the
// customer's mount. Cases from the mount review of production runs since 2026-10-01.
const none = { existing_equipment: { status: "none" as const, retained: [], removed_or_replaced: [] }, existing_detectors: "not_provided" as const };
const lw = (item: string, room: string | null, quantity = 1) => ({ item, room, quantity, supplied_by: "livewire" as const, existing: false });
const cu = (item: string, room: string | null, quantity = 1, existing = false) => ({ item, room, quantity, supplied_by: "customer" as const, existing });

async function counts(o: object) {
  const patterns = await loadPatterns();
  const { scope } = approvedScope({ ...none, ...o });
  const selection = materialize(scope, selectPattern(scope.functional_systems, patterns)!);
  const sum = (role: string) => selection.lines.filter((l) => l.role === role).reduce((n, l) => n + l.quantity, 0);
  return { tilt: sum("tv_mount"), articulating: sum("tv_mount_articulating"), mounts: sum("tv_mount") + sum("tv_mount_articulating"), wattbox: sum("tv_power_protection"), tvs: sum("television") };
}

describe("TV mounts: one rule (Henry, 2026-11-19)", () => {
  it("Danny Lewis: a TV taken down for wiring and reinstalled on its own wall takes no new mount", async () => {
    const c = await counts({
      functional_systems: ["TV", "surge protection"],
      existing_equipment: { status: "described", retained: ["55-inch Sony TV"], removed_or_replaced: [] },
      requested_changes: [
        "Remove the existing 55-inch Sony TV for wiring access",
        "Replace the speaker and HDMI wiring",
        "Reinstall the TV, reconnect all existing equipment, and test operation",
        "Replace the existing surge protector with a new WattBox",
      ],
    });
    expect(c.mounts).toBe(0);
  });

  it("a TV standing on a cabinet takes no mount, even when another room's mount is listed", async () => {
    const c = await counts({
      functional_systems: ["TV"],
      requested_changes: ["Living room: 65-inch Sony TV on a tilt mount", "Basement: 85-inch Sony TV standing on top of a long cabinet"],
      devices: [lw("65-inch Sony TV", "Living room"), lw("tilt TV mount", "Living room"), lw("85-inch Sony TV", "Basement")],
    });
    expect(c).toMatchObject({ tvs: 2, mounts: 1, wattbox: 1 });
  });

  it("Gayatri Choudhary: 'make it 1 SanusCILT4-B1' is one mount, though the list names the TV area twice", async () => {
    const c = await counts({
      functional_systems: ["TV"],
      requested_changes: ["Second floor: 45-inch Sony Bravia TV", "Second floor: fixed TV mount", "Sonos Arc soundbar", "make it 1 SanusCILT4-B1"],
      requested_quantities: [{ item: "SanusCILT4-B1", quantity: 1 }],
      devices: [lw("Sony Bravia 45-inch TV", "Second floor"), lw("fixed TV mount", "Second floor"), lw("Sonos Arc", "Second floor"), lw("TV mount", "Second-floor TV and gaming area")],
    });
    expect(c.mounts).toBe(1);
  });

  it("'Only need 1 TV mount' with no count beside it is one mount for two new TVs", async () => {
    const c = await counts({ functional_systems: ["TV"], requested_changes: ["Living room: 65-inch Sony TV", "Bedroom: 55-inch Sony TV", "Only need 1 TV mount"] });
    expect(c).toMatchObject({ tvs: 2, mounts: 1 });
  });

  it("'Only need 1 TV mount' beside two typed mount changes is one mount, not three", async () => {
    const c = await counts({
      functional_systems: ["TV"],
      requested_changes: ["Living room: 65-inch Sony TV with flat mount", "Bedroom: 55-inch Sony TV with tilt mount", "Only need 1 TV mount"],
      requested_quantities: [{ item: "TV mount", quantity: 1 }],
    });
    expect(c.mounts).toBe(1);
  });

  it("a revision's total is the count: 'remove 1 Sanus mount' from 2 leaves 1", async () => {
    const c = await counts({
      functional_systems: ["TV"],
      requested_changes: ["Living room: 65-inch Sony TV, tilt mount", "Bedroom: 55-inch Sony TV, tilt mount", "Remove 1 Sanus mount"],
      devices: [lw("65-inch Sony TV", "Living room"), lw("tilt mount", "Living room"), lw("55-inch Sony TV", "Bedroom"), lw("tilt mount", "Bedroom")],
      rep_totals: [{ item: "Sanus CILT4-B1", quantity: 1, room: null }],
    });
    expect(c).toMatchObject({ tvs: 2, mounts: 1, tilt: 1, wattbox: 2 });
  });

  it("a room's total sets that room only", async () => {
    const c = await counts({
      functional_systems: ["TV"],
      requested_changes: ["Living room: 65-inch Sony TV, articulating mount", "Bedroom: 55-inch Sony TV, tilt mount"],
      devices: [lw("65-inch Sony TV", "Living room"), lw("articulating mount", "Living room"), lw("55-inch Sony TV", "Bedroom"), lw("tilt mount", "Bedroom")],
      rep_totals: [{ item: "tilt mount", quantity: 0, room: "Bedroom" }],
    });
    expect(c).toMatchObject({ articulating: 1, tilt: 0 });
  });

  it("a customer's TV on the customer's own mount takes no mount, and still gets its WattBox", async () => {
    const said = await counts({ functional_systems: ["TV"], requested_changes: ["Hang the customer's 65-inch TV on the customer-supplied mount in the den", "Living room: 65-inch Sony TV"] });
    expect(said).toMatchObject({ mounts: 1, wattbox: 2 });
    const listed = await counts({
      functional_systems: ["TV"],
      requested_changes: ["Hang the customer's 65-inch TV in the den on their own mount", "Living room: 65-inch Sony TV"],
      devices: [cu("65-inch TV", "den"), cu("TV mount", "den"), lw("65-inch Sony TV", "Living room")],
    });
    expect(listed).toMatchObject({ mounts: 1, wattbox: 2 });
  });

  it("a customer's TV with no word about its mount gets one sold (Morales)", async () => {
    const c = await counts({ functional_systems: ["TV"], requested_changes: ["Great Room: Sony Bravia 7 (65in) with flat mount", "Porch: customer supplied TV, art arm mount", "Primary Bedroom: customer supplied TV flat/tilt mounted"] });
    expect(c).toMatchObject({ tilt: 2, articulating: 1, wattbox: 3 });
  });

  it("a room-less 'wall mount' × 3 for three TVs is three mounts, not six", async () => {
    const c = await counts({
      functional_systems: ["TV"],
      requested_changes: ["Three 55-inch Sony TVs for the bedrooms"],
      devices: [lw("55-inch Sony TV", "Bedroom 1"), lw("55-inch Sony TV", "Bedroom 2"), lw("55-inch Sony TV", "Bedroom 3"), lw("wall mount", null, 3)],
    });
    expect(c).toMatchObject({ tvs: 3, mounts: 3, wattbox: 3 });
  });

  it("an untyped mount beside articulating ones is the standard tilt (Annie Lewis's office)", async () => {
    const c = await counts({
      functional_systems: ["TV"],
      requested_changes: ["Guest room: 43-inch TV with articulating wall mount", "Office: 43-inch TV with mount"],
      devices: [lw("43-inch TV", "Guest room"), lw("articulating wall mount", "Guest room"), lw("43-inch TV", "Office"), lw("TV mount", "Office")],
    });
    expect(c).toMatchObject({ articulating: 1, tilt: 1, wattbox: 2 });
  });
});
