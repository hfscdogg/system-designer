import { describe, expect, it } from "vitest";
import { normalizeFunctionalSystems } from "@sd/core";
import { recordedDToolsReader } from "@sd/dtools";
import {
  admitProduct,
  bind,
  compile,
  customerView,
  forbiddenCustomerKeys,
  laborHoursFor,
  loadPatterns,
  materialize,
  patternRecordIds,
  selectPattern,
  validateProposal,
  type AdmittedProduct,
  type PatternSpec,
  type PolicyRecord,
} from "../src/index.ts";
import { approvedScope, CATALOG, IDS, POLICY, product, testPattern } from "./fixtures.ts";

async function admitAll(pattern: PatternSpec, catalog = CATALOG) {
  const reader = recordedDToolsReader(catalog);
  const admitted = new Map<string, AdmittedProduct>();
  const rejected: string[] = [];
  for (const id of patternRecordIds(pattern)) {
    try {
      const a = admitProduct(id, await reader.getProduct(id), `runs/r/catalog/${id}.json`);
      if (a.ok) admitted.set(id, a.product);
      else rejected.push(`${id}: ${a.reason}`);
    } catch (err) {
      rejected.push(`${id}: ${(err as Error).message}`);
    }
  }
  return { admitted, rejected, reader };
}

async function pipeline(scopeOverrides = {}, pattern = testPattern(), policy: PolicyRecord | null = POLICY) {
  const { scope, scopeHash, receiptId } = approvedScope(scopeOverrides);
  const { admitted } = await admitAll(pattern);
  const selection = materialize(scope, pattern);
  const compiled = compile(selection, admitted, pattern);
  if (!compiled.ok) throw new Error(compiled.errors.join("\n"));
  const proposal = bind(compiled.draft, { runId: "run_test", receiptId, approvalId: "ap_1", scopeHash, scope, policy, releaseId: "rel" });
  return { scope, scopeHash, selection, proposal, admitted, validation: validateProposal(proposal, scope, scopeHash, admitted, policy) };
}

describe("catalog admission", () => {
  const read = async (body: unknown) => (await recordedDToolsReader({ [IDS.panel]: body }).getProduct(IDS.panel));

  it("admits an active priced product and keeps its evidence hash", async () => {
    const r = await read(CATALOG[IDS.panel]);
    const a = admitProduct(IDS.panel, r, "k");
    expect(a.ok && a.product).toMatchObject({ brand: "TestCo", model: "PANEL-1", unit_price_cents: 60000, unit_cost_cents: 36000, evidence: { sha256: r.sha256 } });
  });

  it("refuses inactive, discontinued, unpriced, unbranded or mismatched records", async () => {
    const cases = [
      [{ ...product(IDS.panel, "T", "M", 1, 1), isActive: false }, "inactive"],
      [{ ...product(IDS.panel, "T", "M", 1, 1), isDiscontinued: true }, "discontinued"],
      [{ ...product(IDS.panel, "T", "M", 1, 1), unitPrice: null }, "sell price"],
      [{ ...product(IDS.panel, "T", "M", 1, 1), brand: null }, "manufacturer"],
      [product(IDS.keypad, "T", "M", 1, 1), "not the requested record"],
    ] as const;
    for (const [body, reason] of cases) {
      const a = admitProduct(IDS.panel, await read(body), "k");
      expect(a.ok ? "admitted" : a.reason).toContain(reason);
    }
  });

  it("treats a missing record as an error, not an empty result", async () => {
    await expect(recordedDToolsReader({}).getProduct(IDS.panel)).rejects.toThrow(/404/);
  });
});

describe("patterns", () => {
  it("ships Livewire's standard D-Tools records for every role, and no invented service records", async () => {
    const patterns = await loadPatterns();
    expect(patterns.map((p) => p.pattern)).toEqual([
      "access_control", "home_automation", "home_network", "lighting_control", "motorized_shades", "prewire",
      "security_modernization", "smart_locks", "surveillance", "tv_media", "video_doorbell", "whole_home_audio",
    ]);
    for (const p of patterns) {
      expect(p.roles.every((r) => r.product_id !== null), p.pattern).toBe(true);
      expect(p.services.every((s) => s.product_id === null), p.pattern).toBe(true);
      expect(p.labor?.labor_type, p.pattern).toBe("07LABOR1MAN");
      // Each role, its size variants and the parts record.
      expect(patternRecordIds(p), p.pattern).toHaveLength(p.roles.length + p.roles.reduce((n, r) => n + (r.variants?.length ?? 0), 0) + 1);
    }
    const network = patterns.find((p) => p.pattern === "home_network")!;
    expect(network.applies_when_any).toEqual(["networking"]);
    expect(network.roles.find((r) => r.role === "mesh_wifi")).toMatchObject({ critical: true, quantity: { kind: "minimum", qty: 3 } });
  });

  it("combines a security and a network pattern for a job that needs both", async () => {
    const patterns = await loadPatterns();
    const both = selectPattern(["intrusion_security", "networking"], patterns)!;
    expect(both.pattern).toBe("home_network+security_modernization");
    expect(both.roles.map((r) => r.role)).toEqual(expect.arrayContaining(["security_panel", "mesh_wifi", "network_switch"]));
    const byName = (n: string) => patterns.find((p) => p.pattern === n)!;
    expect(both.labor!.base_hours).toBe(byName("home_network").labor!.base_hours + byName("security_modernization").labor!.base_hours);
    expect(new Set(both.services.map((s) => s.category)).size).toBe(both.services.length);
    expect(selectPattern(["networking"], patterns)!.pattern).toBe("home_network");
  });

  it("routes each kind of request to its own pattern", async () => {
    const patterns = await loadPatterns();
    const route = (words: string[]) => selectPattern(normalizeFunctionalSystems(words), patterns)?.pattern ?? null;
    expect(route(["prewire", "data drops"])).toBe("prewire");
    expect(route(["network drops"])).toBe("prewire");
    expect(route(["cameras", "surveillance"])).toBe("surveillance");
    expect(route(["Control4", "universal remote"])).toBe("home_automation");
    expect(route(["Lutron lighting control", "dimmers"])).toBe("lighting_control");
    expect(route(["video doorbell"])).toBe("video_doorbell");
    expect(route(["access control"])).toBe("access_control");
    expect(route(["motorized shades"])).toBe("motorized_shades");
    // Security with a doorbell prices the doorbell once, from its own pattern.
    const both = selectPattern(normalizeFunctionalSystems(["alarm panel", "video doorbell"]), patterns)!;
    expect(both.roles.filter((r) => r.systems.includes("video_doorbell"))).toHaveLength(1);
    // Pool automation is not a home-automation platform.
    expect(normalizeFunctionalSystems(["pool automation"])).toEqual(["pool automation"]);
  });

  it("routes music requests to whole-home audio, not to TV and theater", async () => {
    const patterns = await loadPatterns();
    const systems = normalizeFunctionalSystems(["Sonos in the kitchen", "in-ceiling speakers", "outdoor speakers on the patio"]);
    expect(systems).toEqual(["whole_home_audio"]);
    expect(selectPattern(systems, patterns)!.pattern).toBe("whole_home_audio");
    expect(normalizeFunctionalSystems(["85 inch TV", "soundbar"])).toEqual(["audio_video"]);
    const tv = selectPattern(["audio_video"], patterns)!;
    expect(tv.pattern).toBe("tv_media");
    // A mounted, client-supplied TV with a soundbar (hours fitted to accepted quotes): 1.5 + 2.25 + 3 + 0.5 = 7.25 → 7.5 h.
    expect(laborHoursFor(tv, [{ role: "tv_mount", quantity: 1 }, { role: "soundbar", quantity: 1 }, { role: "soundbar_mount", quantity: 1 }])).toBe(7.5);
    // An add-on visit carries its own setup (1.5 h for TV work), not the full system setup: 1.5 + 2.25 → 4 h.
    expect(laborHoursFor(tv, [{ role: "tv_mount", quantity: 1 }], true)).toBe(4);
    const audio = patterns.find((p) => p.pattern === "whole_home_audio")!;
    expect(audio.roles.find((r) => r.role === "zone_amplifier")).toMatchObject({ critical: true, quantity: { kind: "minimum", qty: 2 } });
    expect(audio.roles.find((r) => r.role === "outdoor_speakers")!.mentions).toContain("patio");
    // Speaker pairs take longer than amps: 1 h setup + 2 amps × 1 + 2 pairs × 3 = 9 h.
    expect(laborHoursFor(audio, [{ role: "zone_amplifier", quantity: 2 }, { role: "in_ceiling_speakers", quantity: 2 }])).toBe(9);
    // Combined with networking, each role keeps its own rate and the setup hours add: (1 + 2.5) + 2 + 6 + 3 × 0.75 = 13.75 → 14.
    const both = selectPattern(["whole_home_audio", "networking"], patterns)!;
    expect(laborHoursFor(both, [{ role: "zone_amplifier", quantity: 2 }, { role: "in_ceiling_speakers", quantity: 2 }, { role: "mesh_wifi", quantity: 3 }])).toBe(14);
    // An add-on visit to both carries one visit's setup (the larger one), not each pattern's.
    const visit = Math.max(...["whole_home_audio", "home_network"].map((n) => patterns.find((p) => p.pattern === n)!.labor!.add_on_base_hours ?? 0));
    expect(laborHoursFor(both, [{ role: "mesh_wifi", quantity: 1 }], true)).toBe(Math.max(1, Math.ceil((visit + 0.75) * 2) / 2));
  });

  it("prices an add-on as only the devices named, with no setup hours", async () => {
    const patterns = await loadPatterns();
    const c4 = patterns.find((p) => p.pattern === "home_automation")!;
    const addOn = approvedScope({ functional_systems: ["Control4"], requested_changes: ["Add 3 Halo remotes"], requested_quantities: [{ item: "Control4 Halo remote", quantity: 3 }], existing_detectors: "not_provided" }).scope;
    const sel = materialize(addOn, c4);
    expect(sel.add_on).toBe(true);
    expect(sel.lines.map((l) => [l.role, l.quantity])).toEqual([["automation_remote", 3]]);
    // Remotes are sold without install time, and there is no controller setup: no labor at all.
    expect(sel.labor).toBeNull();
    // A single small device that does need install time still carries the one-hour visit minimum.
    const quick = { ...c4, roles: c4.roles.map((r) => (r.role === "automation_remote" ? { ...r, hours_each: 0.25 } : r)) };
    expect(laborHoursFor(quick, [{ role: "automation_remote", quantity: 1 }], true)).toBe(1);
  });

  it("gives each stated count to the one device it names", async () => {
    const patterns = await loadPatterns();
    const c4 = patterns.find((p) => p.pattern === "home_automation")!;
    const system = approvedScope({ functional_systems: ["Control4"], requested_changes: ["Install Control4"], requested_quantities: [{ item: "Control4 Halo remote", quantity: 3 }], existing_detectors: "not_provided" }).scope;
    const sel = materialize(system, c4);
    expect(sel.add_on).toBe(false);
    expect(sel.lines.map((l) => [l.role, l.quantity])).toEqual([["automation_controller", 1], ["automation_remote", 3]]);
  });

  it("reads short counts like \"3 doors, 2 motions\" as sensor counts", async () => {
    const patterns = await loadPatterns();
    const security = patterns.find((p) => p.pattern === "security_modernization")!;
    const scope = approvedScope({
      functional_systems: ["security system"],
      requested_changes: ["Security system"],
      requested_quantities: [{ item: "doors", quantity: 3 }, { item: "motions", quantity: 2 }],
      existing_equipment: { status: "none", retained: [], removed_or_replaced: [] },
      existing_detectors: "none",
    }).scope;
    const lines = new Map(materialize(scope, security).lines.map((l) => [l.role, l]));
    expect(lines.get("door_window_contact")).toMatchObject({ quantity: 3, quantity_basis: "fixed" });
    expect(lines.get("motion_detector")).toMatchObject({ quantity: 2, quantity_basis: "fixed" });
  });

  it("prices a new TV alongside a moved existing one, with the niche allowance (Green job)", async () => {
    const patterns = await loadPatterns();
    const scope = approvedScope({
      client: "Monica Green",
      functional_systems: ["75-inch OLED TV", "Sonos Arc Ultra soundbar", "eero network", "Halo remote"],
      room_types: ["Family room", "Fitness room"],
      requested_changes: [
        "Stud up and sheetrock a niche over the fireplace",
        "Sell a new Livewire-provided 75-inch OLED TV with a Sonos Arc Ultra soundbar",
        "Move the existing 65-inch TV and soundbar upstairs and wall-mount them in the fitness room",
        "Add an eero access point network",
        "Consolidate the family room remotes to one Halo remote",
      ],
      requested_quantities: [{ item: "eero access points", quantity: 3 }],
      existing_equipment: { status: "described", retained: ["65-inch TV", "soundbar"], removed_or_replaced: [] },
      existing_detectors: "not_provided",
    }).scope;
    const pattern = selectPattern(scope.functional_systems, patterns)!;
    const sel = materialize(scope, pattern);
    const lines = new Map(sel.lines.map((l) => [l.role, l]));
    expect(sel.unresolved).toEqual([]);
    // The new TV is the 77" BRAVIA 8 (closest OLED to 75"); the existing one moves, so it needs a second mount.
    expect(lines.get("television")).toMatchObject({ record_id: "b89ed236-fff6-4985-a526-31d12b9c796f", quantity: 1 });
    expect(lines.get("soundbar")!.quantity).toBe(1);
    expect(lines.get("tv_mount")!.quantity).toBe(2);
    expect(lines.get("soundbar_mount")!.quantity).toBe(2);
    expect(lines.get("mesh_wifi")).toMatchObject({ quantity: 3, quantity_basis: "fixed" });
    expect(lines.get("automation_remote")!.quantity).toBe(1);
    expect(sel.labor!.extras).toEqual(["niche_framing"]);
    // Without the niche allowance the hours are 8 lower.
    expect(sel.labor!.hours - laborHoursFor(pattern, sel.lines)).toBe(8);
  });

  it("applies a revision's removals and stated mount count (Green job, revised)", async () => {
    const patterns = await loadPatterns();
    const base = {
      client: "Monica Green",
      room_types: ["Family room", "Fitness room"],
      requested_quantities: [{ item: "eero access points", quantity: 3 }],
      existing_equipment: { status: "described" as const, retained: ["65-inch TV", "soundbar"], removed_or_replaced: [] },
      existing_detectors: "not_provided" as const,
    };
    const changes = [
      "Sell a new Livewire-provided 75-inch OLED TV with a Sonos Arc Ultra soundbar",
      "Move the existing 65-inch TV and soundbar to the fitness room; the existing TV has its own wall mount",
      "Add an eero access point network",
      "Apple TV remote controlling everything in the family room",
    ];
    // "Remove the Halo remote and Control4": the system is gone and so is the remote.
    const scope = approvedScope({
      ...base,
      functional_systems: ["75-inch OLED TV", "Sonos Arc Ultra soundbar", "eero network"],
      requested_changes: changes,
      excluded_scope: ["Halo remote", "Control4"],
    }).scope;
    const sel = materialize(scope, selectPattern(scope.functional_systems, patterns)!);
    const roles = new Map(sel.lines.map((l) => [l.role, l.quantity]));
    expect(sel.unresolved).toEqual([]);
    expect(roles.has("automation_remote")).toBe(false);
    expect(roles.has("automation_controller")).toBe(false);
    // Only the new TV needs a mount: the moved one has its own.
    expect(roles.get("tv_mount")).toBe(1);
    expect(roles.get("streamer")).toBe(1);

    // If the interpreter leaves Control4 in the systems, the excluded remote is still removed.
    const kept = approvedScope({
      ...base,
      functional_systems: ["75-inch OLED TV", "Sonos Arc Ultra soundbar", "eero network", "Control4"],
      requested_changes: [...changes, "Consolidate the family room remotes"],
      requested_quantities: [...base.requested_quantities, { item: "tv mount", quantity: 1 }],
      excluded_scope: ["Halo remote", "TV wall reinforcement"],
    }).scope;
    const keptSel = materialize(kept, selectPattern(kept.functional_systems, patterns)!);
    const keptRoles = new Map(keptSel.lines.map((l) => [l.role, l.quantity]));
    expect(keptRoles.has("automation_remote")).toBe(false);
    // "TV wall reinforcement" mentions the TV in passing; it doesn't remove the TV.
    expect(keptRoles.get("television")).toBe(1);
    expect(keptRoles.get("tv_mount")).toBe(1);
  });

  it("removes a device however the removal is worded (Green: \"remove the eeros\")", async () => {
    const patterns = await loadPatterns();
    const net = patterns.find((p) => p.pattern === "home_network")!;
    const eeros = (excluded: string) =>
      materialize(
        approvedScope({
          functional_systems: ["eero network", "TV"],
          requested_changes: ["Add 3 eero access points"],
          requested_quantities: [{ item: "eero access points", quantity: 3 }],
          excluded_scope: [excluded],
          existing_detectors: "not_provided",
        }).scope,
        net,
      ).lines.some((l) => l.role === "mesh_wifi");
    for (const item of ["eeros", "the eero", "eero access points", "eero mesh network", "the eero system", "eero Wi-Fi access points"]) expect(eeros(item), item).toBe(false);
    // Naming something else, or the device plus unrelated words, removes nothing.
    expect(eeros("Control4")).toBe(true);
    expect(eeros("eero install in the garage attic")).toBe(true);
  });

  it("takes a count for a device named by the model number printed on the budget", async () => {
    const patterns = await loadPatterns();
    const tv = patterns.find((p) => p.pattern === "tv_media")!;
    const scope = approvedScope({
      functional_systems: ["TV", "soundbar"],
      requested_changes: ["Sell a new 75-inch OLED TV with a Sonos Arc Ultra soundbar", "Move the existing TV and soundbar to the fitness room"],
      requested_quantities: [{ item: "WSSATM1-B2", quantity: 1 }],
      existing_equipment: { status: "described", retained: ["TV", "soundbar"], removed_or_replaced: [] },
      existing_detectors: "not_provided",
    }).scope;
    const roles = new Map(materialize(scope, tv).lines.map((l) => [l.role, l.quantity]));
    // The stated count replaces the extra mount for the moved soundbar; the TV mount still gets one.
    expect(roles.get("soundbar_mount")).toBe(1);
    expect(roles.get("tv_mount")).toBe(2);
  });

  it("takes a mount count or an own-mount note in plain language", async () => {
    const patterns = await loadPatterns();
    const tv = patterns.find((p) => p.pattern === "tv_media")!;
    const base = {
      functional_systems: ["TV", "soundbar"],
      existing_equipment: { status: "described" as const, retained: ["TV", "soundbar"], removed_or_replaced: [] },
      existing_detectors: "not_provided" as const,
    };
    const changes = ["Sell a new 75-inch OLED TV with a Sonos Arc Ultra soundbar", "Move the existing TV and soundbar to the fitness room"];
    const roles = (extra: object) => new Map(materialize(approvedScope({ ...base, requested_changes: changes, ...extra }).scope, tv).lines.map((l) => [l.role, l.quantity]));

    // "Only need 1 mount for the soundbar": the words in any order name the soundbar mount, not the TV mount.
    const counted = roles({ requested_quantities: [{ item: "mount for the soundbar", quantity: 1 }] });
    expect(counted.get("soundbar_mount")).toBe(1);
    expect(counted.get("tv_mount")).toBe(2);

    // A stated TV mount count still goes to the TV mount.
    const tvCount = roles({ requested_quantities: [{ item: "tv mount", quantity: 1 }] });
    expect(tvCount.get("tv_mount")).toBe(1);
    expect(tvCount.get("soundbar_mount")).toBe(2);

    // "The existing soundbar has its own mount" as its own change: the moved soundbar needs no new mount.
    const own = roles({ requested_changes: [...changes, "The existing soundbar has its own mount"] });
    expect(own.get("soundbar_mount")).toBe(1);
    expect(own.get("tv_mount")).toBe(2);
  });

  it("still asks to field-test existing equipment that is only kept", async () => {
    const patterns = await loadPatterns();
    const tv = patterns.find((p) => p.pattern === "tv_media")!;
    const scope = approvedScope({
      functional_systems: ["TV", "soundbar"],
      requested_changes: ["Add a Sonos Arc Ultra soundbar to the existing 65-inch Sony TV"],
      existing_equipment: { status: "described", retained: ["65-inch Sony TV"], removed_or_replaced: [] },
      existing_detectors: "not_provided",
    }).scope;
    const sel = materialize(scope, tv);
    expect(sel.unresolved.map((u) => u.role)).toContain("television");
    expect(sel.lines.map((l) => l.role)).toEqual(["soundbar", "soundbar_mount"]);
  });

  it("prices only the camera type named, and drops a switch the request excludes (pilot: Kemp)", async () => {
    const patterns = await loadPatterns();
    const cams = patterns.find((p) => p.pattern === "surveillance")!;
    const base = { functional_systems: ["security cameras"], existing_detectors: "not_provided", existing_equipment: { status: "none", retained: [], removed_or_replaced: [] } };
    const roles = (o: object) => materialize(approvedScope({ ...base, ...o }).scope, cams).lines.map((l) => [l.role, l.quantity]);
    // Cameras in general: the standard turret package.
    expect(roles({ requested_changes: ["Install cameras"] })).toEqual([["outdoor_camera", 2], ["camera_storage", 2], ["camera_poe_switch", 1]]);
    // Floodlight cameras named: no turrets added on top.
    expect(roles({ requested_changes: ["Install 2 floodlight cameras"], requested_quantities: [{ item: "floodlight cameras", quantity: 2 }] })).toEqual([
      ["camera_storage", 2],
      ["floodlight_camera", 2],
      ["camera_poe_switch", 1],
    ]);
    // Both named: both priced.
    expect(roles({ requested_changes: ["2 turret cameras and a floodlight camera"] }).map(([r]) => r)).toEqual(["outdoor_camera", "camera_storage", "floodlight_camera", "camera_poe_switch"]);
    // "No switch" removes the PoE switch.
    const noSwitch = materialize(approvedScope({ ...base, requested_changes: ["Install cameras"], excluded_scope: ["no switch"] }).scope, cams);
    expect(noSwitch.lines.map((l) => l.role)).toEqual(["outdoor_camera", "camera_storage"]);
    expect(noSwitch.unresolved).toEqual([]);
  });

  it("prices one of a device the request names as one thing (pilot: Biscuit Belly)", async () => {
    const patterns = await loadPatterns();
    const audio = patterns.find((p) => p.pattern === "whole_home_audio")!;
    const amps = (o: object) =>
      materialize(approvedScope({ functional_systems: ["Sonos"], existing_detectors: "not_provided", existing_equipment: { status: "none", retained: [], removed_or_replaced: [] }, ...o }).scope, audio).lines.find((l) => l.role === "zone_amplifier")?.quantity;
    // "The amplifier" is one amp, still verified on site; without a count the pattern's minimum stands.
    expect(amps({ requested_changes: ["Replace the amplifier for the existing ceiling speakers"] })).toBe(1);
    expect(amps({ requested_changes: ["Install an amp in the rack"] })).toBe(1);
    expect(amps({ requested_changes: ["Sonos in the kitchen, family room and back patio"] })).toBe(2);
    // Several, or a stated count, are never cut to one.
    expect(amps({ requested_changes: ["Replace the amps"] })).toBe(2);
    expect(amps({ requested_changes: ["Install 3 amplifiers"] })).toBe(2);
    expect(amps({ requested_changes: ["Install the amps"], requested_quantities: [{ item: "Sonos Amp", quantity: 3 }] })).toBe(3);
  });

  it("does not read \"a camera system\" as one camera", async () => {
    const patterns = await loadPatterns();
    const cams = patterns.find((p) => p.pattern === "surveillance")!;
    const sel = materialize(approvedScope({ functional_systems: ["security cameras"], requested_changes: ["Install a camera system"], existing_detectors: "not_provided", existing_equipment: { status: "none", retained: [], removed_or_replaced: [] } }).scope, cams);
    expect(sel.lines.find((l) => l.role === "outdoor_camera")?.quantity).toBe(2);
  });

  it("reads a brand as the system, not the device (\"Control4 SR260 remote\" is a remote)", async () => {
    const patterns = await loadPatterns();
    const c4 = patterns.find((p) => p.pattern === "home_automation")!;
    const roles = (o: object) =>
      materialize(approvedScope({ functional_systems: ["Control4"], existing_detectors: "not_provided", existing_equipment: { status: "none", retained: [], removed_or_replaced: [] }, ...o }).scope, c4).lines.map((l) => [l.role, l.quantity]);
    expect(roles({ requested_changes: ["Add a Control4 SR260 remote"] })).toEqual([["automation_remote", 1]]);
    expect(roles({ requested_changes: ["Add 2 Control4 remotes"], requested_quantities: [{ item: "Control4 remotes", quantity: 2 }] })).toEqual([["automation_remote", 2]]);
    // Naming only the brand still names the system's core.
    expect(roles({ requested_changes: ["Add Control4 to the family room"] }).map(([r]) => r)).toContain("automation_controller");
  });

  it("sells a Control4 remote without install labor", async () => {
    const patterns = await loadPatterns();
    const c4 = patterns.find((p) => p.pattern === "home_automation")!;
    const sel = materialize(approvedScope({ functional_systems: ["home_automation"], existing_detectors: "not_provided", existing_equipment: { status: "none", retained: [], removed_or_replaced: [] }, requested_changes: ["Add a Control4 SR260 remote"] }).scope, c4);
    expect(sel.lines.map((l) => l.role)).toEqual(["automation_remote"]);
    expect(sel.labor).toBeNull();
    expect(sel.allowances).toEqual([]);
    // A controller still carries its install time.
    const core = materialize(approvedScope({ functional_systems: ["home_automation"], existing_detectors: "not_provided", existing_equipment: { status: "none", retained: [], removed_or_replaced: [] }, requested_changes: ["Add a Control4 CORE 1 controller"] }).scope, c4);
    expect(core.labor?.hours).toBeGreaterThan(0);
  });

  it("prices a panel battery or a siren as just that, not a new alarm system", async () => {
    const patterns = await loadPatterns();
    const sec = patterns.find((p) => p.pattern === "security_modernization")!;
    const roles = (change: string) =>
      materialize(approvedScope({ functional_systems: ["intrusion_security"], existing_detectors: "not_provided", existing_equipment: { status: "none", retained: [], removed_or_replaced: [] }, requested_changes: [change] }).scope, sec).lines.map((l) => l.role);
    expect(roles("Replace the alarm panel battery")).toEqual(["panel_battery"]);
    expect(roles("Add a siren in the upstairs hall")).toEqual(["siren"]);
    // A plain security request is unchanged: no battery or siren unless asked.
    expect(roles("Install a new alarm system")).not.toContain("panel_battery");
    // A device word that only describes another device is not a request for it: a soundbar mount is a mount.
    const tv = patterns.find((p) => p.pattern === "tv_media")!;
    const tvRoles = (change: string) =>
      materialize(approvedScope({ functional_systems: ["audio_video"], existing_detectors: "not_provided", existing_equipment: { status: "none", retained: [], removed_or_replaced: [] }, requested_changes: [change] }).scope, tv).lines.map((l) => l.role);
    expect(tvRoles("Add a soundbar mount")).toEqual(["soundbar_mount"]);
  });

  it("prices a recorder as a recorder, and only when asked for", async () => {
    const patterns = await loadPatterns();
    const cams = patterns.find((p) => p.pattern === "surveillance")!;
    const sel = (change: string) =>
      materialize(approvedScope({ functional_systems: ["video_surveillance"], existing_detectors: "not_provided", existing_equipment: { status: "none", retained: [], removed_or_replaced: [] }, requested_changes: [change] }).scope, cams);
    const nvr = sel("Add an NVR in the basement rack");
    expect(nvr.lines.map((l) => l.role)).toEqual(["nvr"]);
    // A recorder add-on: a half-hour visit plus 2 hours for the recorder.
    expect(nvr.labor?.hours).toBe(2.5);
    expect(sel("Add 2 turret cameras by the front door").lines.map((l) => l.role)).not.toContain("nvr");
  });

  it("prices one memory card per camera", async () => {
    const patterns = await loadPatterns();
    const cams = patterns.find((p) => p.pattern === "surveillance")!;
    const sel = (o: object) => materialize(approvedScope({ functional_systems: ["video_surveillance"], existing_detectors: "not_provided", ...o }).scope, cams);
    const qty = (s: ReturnType<typeof sel>) => Object.fromEntries(s.lines.map((l) => [l.role, l.quantity]));
    expect(qty(sel({ requested_changes: ["Add 3 floodlight cameras"], requested_quantities: [{ item: "floodlight cameras", quantity: 3 }] }))).toMatchObject({ floodlight_camera: 3, camera_storage: 3 });
    expect(qty(sel({ requested_changes: ["Add 1 turret camera by the front door"], requested_quantities: [{ item: "turret camera", quantity: 1 }] }))).toMatchObject({ outdoor_camera: 1, camera_storage: 1 });
  });

  it("prices a smart lock as a lock, not a card-access door", async () => {
    const patterns = await loadPatterns();
    const systems = normalizeFunctionalSystems(["smart lock"]);
    const pattern = selectPattern(systems, patterns)!;
    expect(pattern.pattern).toBe("smart_locks");
    const sel = materialize(approvedScope({ functional_systems: systems, requested_changes: ["Add 2 Yale smart locks to the front and back doors"], requested_quantities: [{ item: "smart locks", quantity: 2 }], existing_detectors: "not_provided" }).scope, pattern);
    expect(sel.lines.map((l) => [l.role, l.quantity])).toEqual([["smart_lock", 2]]);
    expect(sel.labor?.hours).toBe(3.5);
  });

  it("prices a whole system when an add-on names nothing the pattern knows", async () => {
    const patterns = await loadPatterns();
    const net = patterns.find((p) => p.pattern === "home_network")!;
    const sel = materialize(approvedScope({ functional_systems: ["Wi-Fi"], requested_changes: ["Add Wi-Fi to the house"], existing_detectors: "not_provided" }).scope, net);
    expect(sel.add_on).toBe(false);
    expect(sel.lines.map((l) => l.role)).toEqual(expect.arrayContaining(["mesh_wifi", "network_switch"]));
  });

  it("selects exactly one applicable pattern or none", () => {
    const p = testPattern();
    expect(selectPattern(["intrusion_security", "fire_detection"], [p])?.pattern).toBe("security_modernization");
    expect(selectPattern(["audio_video"], [p])).toBeNull();
    expect(selectPattern(["intrusion_security"], [p, { ...p, pattern: "other" }])).toBeNull();
  });
});

describe("materialize → compile → bind → validate", () => {
  it("produces a reconciled, watermarked conceptual budget from the approved scope", async () => {
    const { proposal, validation, selection } = await pipeline();
    expect(validation).toEqual({ ok: true, findings: [] });
    expect(proposal.watermark).toBe("CONCEPTUAL BUDGET • NOT FOR APPROVAL");
    // Requested: panel+keypads, glass-break, smoke, CO, thermostat, doorbell, Alarm.com monitoring. Door contacts are retained.
    expect(selection.lines.map((l) => l.role).sort()).toEqual(
      ["co_detector", "glass_break", "keypad", "security_panel", "smoke_heat_detector", "thermostat", "video_doorbell"].sort(),
    );
    expect(selection.unresolved).toEqual([
      { item: "Door/window contact (retained: Door contacts)", role: "door_window_contact", reason: "existing equipment must be field-tested before it can be reused", escalate: false },
    ]);
    // Labor covers every requested service, so nothing is left as an allowance.
    expect(selection.allowances).toEqual([]);
    expect(selection.services).toEqual([]);
    expect(proposal.commercial).toMatchObject({ complete: false, label: "Priced scope to date", total_cents: null, tax: { status: "tbd" } });
    // 600+150+80+120+110+250+230 equipment; 7 × $25 product labor + (2.5 + 7 × 0.5 = 6 hours) × $179.
    expect(proposal.commercial.equipment_cents).toBe(154000);
    expect(proposal.labor).toMatchObject({ labor_type: "07LABOR1MAN", hours: 6, devices: 7, price_cents: 107400, cost_cents: 53700 });
    expect(proposal.labor!.included).toEqual(["installation", "programming", "testing", "commissioning"]);
    expect(proposal.commercial.labor_cents).toBe(17500 + 107400);
    expect(proposal.commercial.services_cents).toBe(0);
    // Parts are 10% of the subtotal: ceil(278,900 × 10/90) cents in $1 units = 310 units.
    expect(proposal.parts).toMatchObject({ quantity: 310, price_cents: 31000, cost_cents: 310 * 40, cost_basis: "policy_parts_margin" });
    expect(proposal.commercial.parts_cents).toBe(31000);
    expect(proposal.commercial.subtotal_cents).toBe(154000 + 124900 + 31000);
    expect(proposal.internal.mix.parts.share_pct).toBe(10);
    expect(proposal.internal.minimum_gross_margin_pct).toBe(30);
    expect(proposal.remaining_verification).toEqual(expect.arrayContaining(["Keypad: number of keypads (one per primary entry)"]));
  });

  it("keeps internal financials out of the customer view and marks missing images", async () => {
    const { proposal } = await pipeline();
    const customer = customerView(proposal);
    expect(forbiddenCustomerKeys(customer)).toEqual([]);
    const json = JSON.stringify(customer);
    expect(json).not.toContain("36000"); // panel cost
    const bell = customer.sections.flatMap((s) => s.items).find((i) => i.model === "BELL-1");
    expect(bell?.image).toEqual({ pending: true });
    expect(proposal.internal.gross_margin_pct).toBeGreaterThan(30);
  });

  it("marks an unconfigured role unresolved and escalates life-safety gaps", async () => {
    const { selection, validation, proposal } = await pipeline({}, testPattern({ smoke: null }));
    expect(selection.requirements.find((r) => r.system === "fire_detection")).toMatchObject({ classification: "unresolved" });
    expect(validation.ok).toBe(true);
    expect(validation.findings).toEqual([{ code: "escalation", severity: "escalate", message: "Smoke/heat detector: no Livewire standard product is configured for this role" }]);
    expect(proposal.sections.flatMap((s) => s.lines).some((l) => l.role === "smoke_heat_detector")).toBe(false);
  });

  it("monitors existing smoke/CO detectors with a listener and radio card instead of new detectors", async () => {
    const { selection, validation } = await pipeline({ existing_detectors: "keep_and_monitor" });
    const roles = selection.lines.map((l) => l.role);
    expect(roles).toEqual(expect.arrayContaining(["panel_345_radio", "detector_listener"]));
    expect(roles).not.toContain("smoke_heat_detector");
    expect(roles).not.toContain("co_detector");
    expect(selection.requirements.filter((r) => ["fire_detection", "co_detection"].includes(r.system)).map((r) => r.classification)).toEqual(["supported", "supported"]);
    expect(validation.ok).toBe(true);
  });

  it("uses the counts the requester stated, and verifies only the rest", async () => {
    const { selection, proposal } = await pipeline({ requested_quantities: [{ item: "Keypads", quantity: 2 }, { item: "glass-break sensors", quantity: 3 }] });
    expect(selection.lines.find((l) => l.role === "keypad")).toMatchObject({ quantity: 2, quantity_basis: "fixed", verify: null });
    expect(selection.lines.find((l) => l.role === "glass_break")).toMatchObject({ quantity: 3, quantity_basis: "fixed" });
    expect(selection.lines.find((l) => l.role === "smoke_heat_detector")).toMatchObject({ quantity: 1, quantity_basis: "minimum_to_verify" });
    expect(proposal.remaining_verification.some((v) => v.startsWith("Keypad:"))).toBe(false);
  });

  it("adds motion detectors only when the request mentions them", async () => {
    expect((await pipeline()).selection.lines.map((l) => l.role)).not.toContain("motion_detector");
    const withMotion = await pipeline({ requested_changes: ["Replace legacy panel and keypads", "Add motion detectors in the hallways"] });
    expect(withMotion.selection.lines.map((l) => l.role)).toContain("motion_detector");
  });

  it("applies the market's margin floor and leaves labor as an allowance without a policy rate", async () => {
    const floors: PolicyRecord = { ...POLICY, policy: { ...POLICY.policy, margin: { residential_min_gross_margin_pct: 30, commercial_min_gross_margin_pct: 90 } } };
    expect((await pipeline({}, testPattern(), floors)).validation.ok).toBe(true);
    const commercial = await pipeline({ market: "commercial" }, testPattern(), floors);
    expect(commercial.validation.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "margin_exception", message: expect.stringContaining("90% commercial minimum") })]));

    const noRate: PolicyRecord = { ...POLICY, policy: { ...POLICY.policy, labor_rates: [{ labor_type: "OTHER", price_per_hour: 100, cost_per_hour: 50 }] } };
    const r = await pipeline({}, testPattern(), noRate);
    expect(r.proposal.labor).toBeNull();
    expect(r.proposal.allowances.map((a) => a.label)).toEqual(["Labor (6 hours)"]);
  });

  it("rejects labor hours that are not the pattern's estimate", async () => {
    const pattern = testPattern();
    const { scope } = approvedScope();
    const { admitted } = await admitAll(pattern);
    const selection = materialize(scope, pattern);
    selection.labor!.hours = 1;
    expect(compile(selection, admitted, pattern)).toMatchObject({ ok: false, errors: [expect.stringContaining("labor hours")] });
  });

  it("flags requested systems that no pattern role covers", async () => {
    const { selection } = await pipeline({ functional_systems: ["alarm panel", "pool automation"] });
    expect(selection.unresolved).toEqual(expect.arrayContaining([expect.objectContaining({ item: "pool automation", escalate: true })]));
  });

  it("blocks without a commercial policy and below the minimum margin", async () => {
    expect((await pipeline({}, testPattern(), null)).validation.findings.map((f) => f.code)).toContain("policy");
    const strict = { ...POLICY, policy: { ...POLICY.policy, margin: { residential_min_gross_margin_pct: 60, commercial_min_gross_margin_pct: 60 } } };
    const r = await pipeline({}, testPattern(), strict);
    expect(r.validation.ok).toBe(false);
    expect(r.validation.findings.map((f) => f.code)).toContain("margin_exception");
  });

  it("calculates tax and a total only when the commercial scope is complete", async () => {
    const taxed: PolicyRecord = { ...POLICY, policy: { ...POLICY.policy, tax: { mode: "rate", rate_pct: 8.25, applies_to: "taxable_equipment" } } };
    // Unresolved roles still withhold the total; quantities to verify alone do not.
    const partial = await pipeline({}, testPattern(), taxed);
    expect(partial.proposal.unresolved.length).toBeGreaterThan(0);
    expect(partial.proposal.commercial.total_cents).toBeNull();
    expect(partial.proposal.commercial.tax).toMatchObject({ status: "calculated", rate_pct: 8.25 });
    const complete = await pipeline(
      {
        functional_systems: ["alarm panel", "Alarm.com monitoring"],
        requested_changes: ["Replace panel"],
        existing_equipment: { status: "none", retained: [], removed_or_replaced: [] },
        service_categories: ["installation", "programming"],
      },
      // Fixed quantities only, so nothing is left to verify.
      (() => {
        const p = testPattern();
        p.roles = p.roles.filter((r) => r.role === "security_panel");
        return p;
      })(),
      taxed,
    );
    expect(complete.proposal.commercial).toMatchObject({ complete: true, label: "Total" });
    // Taxed like D-Tools: taxable equipment and the parts record; labor is not taxed.
    const parts = complete.proposal.parts!;
    expect(parts.is_taxable).toBe(true);
    expect(complete.proposal.commercial.total_cents).toBe(complete.proposal.commercial.subtotal_cents + Math.round((60000 + parts.price_cents) * 0.0825));
    expect(complete.validation.ok).toBe(true);

    // A minimum quantity is listed to verify but does not withhold the budget total.
    const withMinimum = await pipeline(
      { functional_systems: ["alarm panel", "Alarm.com monitoring"], existing_equipment: { status: "none", retained: [], removed_or_replaced: [] } },
      (() => {
        const p = testPattern();
        p.roles = p.roles.filter((r) => r.role === "security_panel" || r.role === "keypad");
        return p;
      })(),
      taxed,
    );
    expect(withMinimum.proposal.remaining_verification.some((v) => v.startsWith("Keypad"))).toBe(true);
    expect(withMinimum.proposal.commercial).toMatchObject({ complete: true, label: "Total" });
  });
});

describe("compiler rejections", () => {
  async function setup() {
    const pattern = testPattern();
    const { scope } = approvedScope();
    const { admitted } = await admitAll(pattern);
    return { pattern, admitted, selection: materialize(scope, pattern) };
  }

  it("rejects products without evidence, swapped records, duplicates and authority fields", async () => {
    const { pattern, admitted, selection } = await setup();
    const noEvidence = new Map(admitted);
    noEvidence.delete(IDS.panel);
    expect(compile(selection, noEvidence, pattern)).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.stringContaining("no admitted D-Tools evidence")]) });

    const swapped = structuredClone(selection);
    swapped.lines[0]!.record_id = IDS.keypad;
    expect(compile(swapped, admitted, pattern).ok).toBe(false);

    const dup = structuredClone(selection);
    dup.lines.push(dup.lines[0]!);
    expect(compile(dup, admitted, pattern)).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.stringContaining("appears twice")]) });

    expect(compile({ ...selection, approved_by: "zack" }, admitted, pattern)).toMatchObject({ ok: false });
    expect(compile({ ...selection, lines: [{ ...selection.lines[0], price: 1 }] }, admitted, pattern).ok).toBe(false);
  });

  it("rejects a critical role that silently disappears", async () => {
    const { pattern, admitted, selection } = await setup();
    const missing = structuredClone(selection);
    missing.lines = missing.lines.filter((l) => l.role !== "security_panel");
    expect(compile(missing, admitted, pattern)).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.stringContaining("Security panel")]) });
  });

  it("validator catches tampered prices after binding", async () => {
    const { proposal, scope, scopeHash, admitted } = await pipeline();
    const tampered = structuredClone(proposal);
    tampered.sections[0]!.lines[0]!.unit_price_cents += 1;
    const v = validateProposal(tampered, scope, scopeHash, admitted, POLICY);
    expect(v.ok).toBe(false);
    expect(v.findings.map((f) => f.code)).toEqual(expect.arrayContaining(["provenance", "arithmetic"]));
  });
});

describe("empty proposals", () => {
  it("blocks when no role has a configured product", async () => {
    const unconfigured = testPattern(Object.fromEntries(Object.keys(IDS).map((k) => [k, null])));
    const { scope, scopeHash, receiptId } = approvedScope();
    const selection = materialize(scope, unconfigured);
    const compiled = compile(selection, new Map(), unconfigured);
    if (!compiled.ok) throw new Error(compiled.errors.join());
    const proposal = bind(compiled.draft, { runId: "r", receiptId, approvalId: "a", scopeHash, scope, policy: POLICY, releaseId: "rel" });
    const v = validateProposal(proposal, scope, scopeHash, new Map(), POLICY);
    expect(v.ok).toBe(false);
    expect(v.findings.map((f) => f.code)).toContain("empty_bom");
  });
});
