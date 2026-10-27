import { describe, expect, it } from "vitest";
import { normalizeFunctionalSystems } from "@sd/core";
import { recordedDToolsReader } from "@sd/dtools";
import {
  admitProduct,
  bind,
  budgetReadyLines,
  catalogIndex,
  compile,
  customerView,
  findNamedProducts,
  forbiddenCustomerKeys,
  formatUsd,
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
      // A role without a standard (the TV cart) is only ever listed to verify, never left unresolved.
      expect(p.roles.every((r) => r.product_id !== null || r.unpriced === "verify"), p.pattern).toBe(true);
      expect(p.services.every((s) => s.product_id === null), p.pattern).toBe(true);
      expect(p.labor?.labor_type, p.pattern).toBe("07LABOR1MAN");
      // Each priced role, its size, market, brand, larger-TV, port and word variants (those that aren't the role's own standard) and the parts record.
      const words = (r: (typeof p.roles)[number]) => (r.word_variants ?? []).filter((v) => v.product_id && v.product_id !== r.product_id).length;
      const records =
        p.roles.filter((r) => r.product_id).length +
        p.roles.reduce((n, r) => n + (r.variants?.length ?? 0) + (r.market_variants?.length ?? 0) + (r.brand_variants?.length ?? 0) + (r.larger_tv_variants?.length ?? 0) + (r.port_variants?.length ?? 0) + words(r), 0) +
        1;
      expect(patternRecordIds(p), p.pattern).toHaveLength(records);
      // The allowance templates ride along with every pattern.
      expect(p.allowances?.map((a) => a.key), p.pattern).toEqual(["outdoor_outlet", "electrical_outlet", "conduit", "trenching", "wiring_run", "camera_troubleshooting"]);
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
    // The Apple TV 4K (2026) at $339 (Ben, 2026-10-14).
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

  it("reads \"new mount for existing soundbar\" as the moved soundbar keeping its own mount, not as no soundbar mount (staging smoke, 2026-10-23)", async () => {
    const patterns = await loadPatterns();
    // The receipt the interpreter produced for "Revise: the existing soundbar keeps its own mount".
    const scope = approvedScope({
      client: "Smoke Test",
      functional_systems: ["audio_video", "networking"],
      requested_changes: [
        "Sell a new 77-inch Sony BRAVIA 8 OLED TV with a Sonos Arc Ultra soundbar for the family room",
        "Move the existing TV and soundbar to the fitness room and wall-mount both there",
        "Add 3 eero access points",
      ],
      requested_quantities: [{ item: "eero access points", quantity: 3 }],
      existing_equipment: { status: "described", retained: ["existing TV", "existing soundbar"], removed_or_replaced: [] },
      excluded_scope: ["new mount for existing soundbar"],
      existing_detectors: "not_provided",
    }).scope;
    const roles = new Map(materialize(scope, selectPattern(scope.functional_systems, patterns)!).lines.map((l) => [l.role, l.quantity]));
    expect(roles.get("soundbar_mount")).toBe(1);
    expect(roles.get("tv_mount")).toBe(2);
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
    expect(sel.to_verify).toEqual(["Sony BRAVIA 7 65\" TV (retained: 65-inch Sony TV): existing equipment must be field-tested before it can be reused"]);
    expect(sel.unresolved).toEqual([]);
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
    // Three rooms of speakers are three amps, at least one per room (Henry, 2026-10-27).
    expect(amps({ requested_changes: ["Sonos in the kitchen, family room and back patio"] })).toBe(3);
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

  it("prices a touchscreen and a volume control as themselves, not a new system", async () => {
    const patterns = await loadPatterns();
    const roles = (pattern: string, systems: string[], change: string) =>
      materialize(
        approvedScope({ functional_systems: systems, existing_detectors: "not_provided", existing_equipment: { status: "none", retained: [], removed_or_replaced: [] }, requested_changes: [change] }).scope,
        patterns.find((p) => p.pattern === pattern)!,
      ).lines.map((l) => l.role);
    expect(roles("home_automation", ["home_automation"], "Add a Control4 touchscreen in the kitchen")).toEqual(["touchscreen"]);
    expect(roles("whole_home_audio", ["whole_home_audio"], "Add 2 volume controls in the den and kitchen")).toEqual(["volume_control"]);
    expect(roles("home_automation", ["home_automation"], "Add a Control4 SR260 remote")).not.toContain("touchscreen");
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
    // Kept contacts are field-tested before reuse: listed to verify, without withholding the total (McGetrick, 2026-10-15).
    expect(selection.unresolved).toEqual([]);
    expect(selection.to_verify).toEqual(["Door/window contact (retained: Door contacts): existing equipment must be field-tested before it can be reused"]);
    expect(proposal.remaining_verification).toContain("Door/window contact (retained: Door contacts): existing equipment must be field-tested before it can be reused");
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

  it("prices detectors the rep counts even when an exclusion names them (staging smoke, 2026-10-15)", async () => {
    const { selection } = await pipeline({
      existing_detectors: "none",
      requested_quantities: [{ item: "smoke/CO detectors upstairs", quantity: 2 }, { item: "smoke/CO detectors downstairs", quantity: 2 }],
      excluded_scope: ["replacement of existing smoke/CO detectors"],
    });
    expect(Object.fromEntries(selection.lines.map((l) => [l.role, l.quantity]))).toMatchObject({ smoke_heat_detector: 4, co_detector: 4 });
    // With no count, the same exclusion still removes them.
    const { selection: none } = await pipeline({ existing_detectors: "none", excluded_scope: ["smoke/CO detectors"] });
    expect(none.lines.map((l) => l.role)).not.toContain("smoke_heat_detector");
  });

  it("prices new detectors the rep counts even when existing ones are kept (staging smoke, 2026-10-15)", async () => {
    const { selection } = await pipeline({ existing_detectors: "keep_and_monitor", requested_quantities: [{ item: "smoke/CO detectors upstairs", quantity: 2 }] });
    expect(Object.fromEntries(selection.lines.map((l) => [l.role, l.quantity]))).toMatchObject({ smoke_heat_detector: 2, co_detector: 2, detector_listener: 1 });
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
    const partial = await pipeline({}, testPattern({ glass: null }), taxed);
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

describe("a revision that removes a whole system", () => {
  it("builds without it instead of failing validation (\"remove the thermostats\")", async () => {
    const base = await pipeline({ functional_systems: ["alarm system", "thermostats"], requested_changes: ["Replace the alarm panel", "Add thermostats"] });
    expect(base.selection.requirements.find((r) => r.system === "climate_control")).toMatchObject({ classification: "supported" });
    const { selection, validation } = await pipeline({
      functional_systems: ["alarm system", "thermostats"],
      requested_changes: ["Replace the alarm panel", "Add thermostats"],
      excluded_scope: ["thermostats"],
    });
    expect(selection.lines.some((l) => l.role === "thermostat")).toBe(false);
    expect(selection.requirements.find((r) => r.system === "climate_control")).toMatchObject({ classification: "removed", roles: [] });
    expect(validation.findings.filter((f) => f.code === "scope_coverage")).toEqual([]);
  });
});

describe("Design & Delivery (Henry, 2026-10-12)", () => {
  const withDd = (floor: number): PolicyRecord => ({
    ...POLICY,
    policy: { ...POLICY.policy, design_delivery: { base_pct: 10, max_pct: 15 }, margin: { residential_min_gross_margin_pct: floor, commercial_min_gross_margin_pct: floor } },
  });

  it("is 10% of product + labor, and the line is called Design & Delivery", async () => {
    const { proposal } = await pipeline({}, testPattern(), withDd(30));
    // 154,000 equipment + 124,900 labor = 278,900 cents; 10% in $1 units = 279 units.
    expect(proposal.parts).toMatchObject({ quantity: 279, price_cents: 27900, pct_of_product_labor: 10 });
    expect(proposal.parts!.raised_for_margin).toBeUndefined();
  });

  it("rises in half-point steps until the budget clears the margin floor, and stops at 15%", async () => {
    const base = (await pipeline({}, testPattern(), withDd(30))).proposal.internal.gross_margin_pct!;
    const lifted = (await pipeline({}, testPattern(), withDd(base + 0.5))).proposal;
    expect(lifted.parts).toMatchObject({ raised_for_margin: true });
    expect(lifted.parts!.pct_of_product_labor).toBeGreaterThan(10);
    expect(lifted.parts!.pct_of_product_labor).toBeLessThan(15);
    expect(lifted.internal.gross_margin_pct).toBeGreaterThanOrEqual(base + 0.5);
    // Out of reach: capped at 15%, and the budget still goes to an admin (the margin stays under the floor).
    const capped = (await pipeline({}, testPattern(), withDd(90))).proposal;
    expect(capped.parts).toMatchObject({ pct_of_product_labor: 15, raised_for_margin: true, quantity: Math.ceil(278900 * 0.15 / 100) });
    expect(capped.internal.gross_margin_pct).toBeLessThan(90);
  });
});

describe("HDMI on TV jobs (Henry, 2026-10-12)", () => {
  it("adds one AudioQuest HDMI per source connected to the TV", async () => {
    const patterns = await loadPatterns();
    const tv = patterns.find((p) => p.pattern === "tv_media")!;
    const roles = (functional_systems: string[], requested_changes: string[]) =>
      new Map(materialize(approvedScope({ functional_systems, requested_changes, existing_detectors: "not_provided" }).scope, tv).lines.map((l) => [l.role, l.quantity]));
    // Soundbar + Apple TV: two cables, like most Livewire TV-and-soundbar quotes.
    expect(roles(["TV", "Sonos Arc Ultra", "Sonos Sub"], ['Provide a 77" OLED TV with a Sonos Arc Ultra and Sonos Sub', "Use the Apple TV remote to control everything"]).get("hdmi_cable")).toBe(2);
    // A TV hang with no new sources needs no new cable (Zack's test round, 2026-10-12).
    expect(roles(["TV"], ["Mount the customer's TV on the living room wall"]).has("hdmi_cable")).toBe(false);
    expect(roles(["TV"], ["Mount the customer's TV on the living room wall with a new Apple TV"]).get("hdmi_cable")).toBe(1);
  });
});

describe("Zack's test round (2026-10-12)", () => {
  const none = { existing_detectors: "not_provided" as const, existing_equipment: { status: "none" as const, retained: [], removed_or_replaced: [] } };
  const quantities = (sel: ReturnType<typeof materialize>) => Object.fromEntries(sel.lines.map((l) => [l.role, l.quantity]));
  async function job(o: object) {
    const patterns = await loadPatterns();
    const { scope } = approvedScope({ ...none, ...o });
    return materialize(scope, selectPattern(scope.functional_systems, patterns)!);
  }

  it("reads mentions as whole words in the request itself, not in system names or rooms", async () => {
    // Camera wording ("outdoor PoE cameras", "garage") adds no access points; the eero words sit in another change.
    const cams = await job({
      functional_systems: ["networking", "security cameras"],
      room_types: ["Garage", "Patio"],
      requested_changes: ["Install 4 outdoor PoE cameras around the garage and patio", "Add eero Wi-Fi to the house"],
      requested_quantities: [{ item: "outdoor PoE cameras", quantity: 4 }],
    });
    expect(quantities(cams)).toMatchObject({ mesh_wifi: 3, outdoor_camera: 4 });
    expect(cams.lines.map((l) => l.role)).not.toEqual(expect.arrayContaining(["wired_access_point"]));
    expect(cams.lines.map((l) => l.role)).not.toContain("outdoor_access_point");
    expect(cams.lines.map((l) => l.role)).not.toContain("floodlight_camera");
    // "arc" is a soundbar, not part of "arched".
    const tv = await job({ functional_systems: ["TV"], requested_changes: ["Mount the customer's TV in the arched niche"] });
    expect(tv.lines.map((l) => l.role)).not.toContain("soundbar");
    // Outdoor Wi-Fi asked in so many words still adds the outdoor eero.
    const outdoor = await job({ functional_systems: ["Wi-Fi"], requested_changes: ["Add outdoor WiFi for the back patio and pool"] });
    expect(quantities(outdoor)).toMatchObject({ outdoor_access_point: 1 });
  });

  it("takes \"only 1 eero\" as the eero count: other eeros it only mentioned go, and \"no additional eeros\" keeps the one", async () => {
    const base = {
      functional_systems: ["networking", "security cameras"],
      requested_changes: ["Add eero Wi-Fi with coverage out on the patio", "Install 4 outdoor PoE cameras"],
    };
    const before = await job({ ...base, requested_quantities: [{ item: "outdoor PoE cameras", quantity: 4 }] });
    expect(quantities(before)).toMatchObject({ mesh_wifi: 3, outdoor_access_point: 1 });
    const after = await job({
      ...base,
      requested_quantities: [{ item: "outdoor PoE cameras", quantity: 4 }, { item: "eero Pro 7", quantity: 1 }],
      excluded_scope: ["additional eeros"],
    });
    expect(quantities(after)).toMatchObject({ mesh_wifi: 1 });
    expect(after.lines.map((l) => l.role)).not.toContain("outdoor_access_point");
    // An outdoor eero the rep counts itself stays.
    const both = await job({ ...base, requested_quantities: [{ item: "eero Pro 7", quantity: 1 }, { item: "outdoor eero", quantity: 1 }] });
    expect(quantities(both)).toMatchObject({ mesh_wifi: 1, outdoor_access_point: 1 });
  });

  it("prices network gear only with the eero network, unless the request names it", async () => {
    // Networking came along with the cameras but nobody asked for Wi-Fi: no eeros, switch, OvrC or WattBox.
    const cams = await job({ functional_systems: ["networking", "security cameras"], requested_changes: ["Install 2 turret cameras"] });
    expect(cams.lines.map((l) => l.role).filter((r) => ["mesh_wifi", "network_switch", "remote_management", "power_protection"].includes(r))).toEqual([]);
    expect(cams.requirements.find((r) => r.system === "networking")).toMatchObject({ classification: "removed" });
    expect(cams.unresolved).toEqual([]);
    // A WattBox asked for by name is priced on its own.
    const wattbox = await job({ functional_systems: ["networking"], requested_changes: ["Add a WattBox to the rack"] });
    expect(wattbox.lines.map((l) => l.role)).toEqual(["power_protection"]);
  });

  it("leaves to verify only what the rep didn't settle: no minimum note on a stated or single count, no priced product, no repeats", async () => {
    const { proposal } = await pipeline({
      requested_quantities: [{ item: "Keypads", quantity: 2 }],
      unresolved_questions: ["Requested product: TestCo PANEL-1", "Requested product: Bretford cart", "Requested product: Bretford cart "],
    });
    const v = proposal.remaining_verification;
    expect(v.filter((x) => x.startsWith("Keypad"))).toEqual([]);
    expect(v.filter((x) => /PANEL-1/.test(x))).toEqual([]);
    expect(v.filter((x) => /Bretford/.test(x))).toEqual(["Requested product: Bretford cart"]);
    // "Replace the amplifier": the rep's one amp is not a minimum to verify.
    const amp = await job({
      functional_systems: ["Sonos"],
      requested_changes: ["Replace the amplifier for the existing ceiling speakers"],
      existing_equipment: { status: "described", retained: ["ceiling speakers"], removed_or_replaced: ["amplifier"] },
    });
    expect(amp.lines.find((l) => l.role === "zone_amplifier")).toMatchObject({ quantity: 1, quantity_basis: "fixed", verify: null });
  });

  it("counts stated speakers as pairs, and adds new speakers beside existing ones", async () => {
    const audio = async (o: object) => quantities(await job({ functional_systems: ["in-ceiling speakers"], requested_changes: ["Add in-ceiling speakers in the kitchen"], ...o }));
    expect((await audio({ requested_quantities: [{ item: "in-ceiling speakers", quantity: 2 }] })).in_ceiling_speakers).toBe(1);
    expect((await audio({ requested_quantities: [{ item: "speakers", quantity: 7 }] })).in_ceiling_speakers).toBe(4);
    expect((await audio({ requested_quantities: [{ item: "pairs of in-ceiling speakers", quantity: 3 }] })).in_ceiling_speakers).toBe(3);
    // "Add 2 more" beside 5 existing speakers prices one new pair; the existing ones are not a count of new pairs.
    const more = await job({
      functional_systems: ["in-ceiling speakers"],
      requested_changes: ["Add 2 more in-ceiling speakers in the kitchen"],
      requested_quantities: [{ item: "existing in-ceiling speakers", quantity: 5 }, { item: "in-ceiling speakers", quantity: 2 }],
      existing_equipment: { status: "described", retained: ["5 existing in-ceiling speakers"], removed_or_replaced: [] },
    });
    expect(quantities(more).in_ceiling_speakers).toBe(1);
    expect(more.unresolved.map((u) => u.role)).not.toContain("in_ceiling_speakers");
  });
});

describe("pricing decisions (Henry, 2026-10-12)", () => {
  const none = { existing_detectors: "not_provided" as const, existing_equipment: { status: "none" as const, retained: [], removed_or_replaced: [] } };
  const quantities = (sel: ReturnType<typeof materialize>) => Object.fromEntries(sel.lines.map((l) => [l.role, l.quantity]));
  async function job(o: object, named: Parameters<typeof materialize>[2] = []) {
    const patterns = await loadPatterns();
    const { scope } = approvedScope({ ...none, ...o });
    return materialize(scope, selectPattern(scope.functional_systems, patterns)!, named);
  }
  const CSA180Z = "fb79a157-4da4-45b2-a5b0-83c69fd3e778";

  it("sizes amplifiers by the speakers they drive: a Sonos Amp per 4 at home, a JBL CSA180Z per 8 on a commercial job", async () => {
    const audio = (o: object) => job({ functional_systems: ["in-ceiling speakers"], requested_changes: ["Install in-ceiling speakers in the kitchen and great room"], ...o });
    const home = await audio({ requested_quantities: [{ item: "in-ceiling speakers", quantity: 10 }] });
    expect(home.lines.find((l) => l.role === "zone_amplifier")).toMatchObject({ quantity: 3, quantity_basis: "fixed", record_id: "2f4f4038-cb86-4a7d-ba17-4919c5f2725f" });
    // Existing speakers the new amps drive count too: 1 new pair + 5 existing = 7 speakers, 2 amps.
    const more = await audio({
      requested_changes: ["Install 2 more in-ceiling speakers in the kitchen"],
      requested_quantities: [{ item: "in-ceiling speakers", quantity: 2 }],
      existing_equipment: { status: "described", retained: ["5 existing in-ceiling speakers"], removed_or_replaced: [] },
    });
    expect(quantities(more)).toMatchObject({ in_ceiling_speakers: 1, zone_amplifier: 2 });
    // Commercial: one 70V amplifier for up to 8 speakers.
    const office = await audio({ market: "commercial", requested_quantities: [{ item: "in-ceiling speakers", quantity: 6 }] });
    expect(office.lines.find((l) => l.role === "zone_amplifier")).toMatchObject({ record_id: CSA180Z, quantity: 1 });
    const big = await audio({ market: "commercial", requested_quantities: [{ item: "in-ceiling speakers", quantity: 12 }] });
    expect(big.lines.find((l) => l.role === "zone_amplifier")).toMatchObject({ record_id: CSA180Z, quantity: 2 });
    // An amplifier the rep names by model wins; its channels are its own, so the speakers don't set its count.
    const AMP = "abababab-abab-4bab-8bab-abababababab";
    const withModel = await job(
      { functional_systems: ["in-ceiling speakers"], requested_changes: ["Install in-ceiling speakers powered by a Sonos AMPG2"], requested_quantities: [{ item: "in-ceiling speakers", quantity: 10 }] },
      [{ record_id: AMP, model: "AMPG2", label: "Sonos Amp G2", category: "Amplifiers > Stereo (2-Channel)", text: "Install in-ceiling speakers powered by a Sonos AMPG2" }],
    );
    expect(withModel.lines.find((l) => l.role === "zone_amplifier")).toMatchObject({ record_id: AMP, quantity: 2, quantity_basis: "minimum_to_verify", requested_model: "AMPG2" });
    // Speakers nobody asked for (an amp-only job) leave the amp count as it was.
    expect(quantities(await job({ functional_systems: ["Sonos"], requested_changes: ["Replace the amps"] })).zone_amplifier).toBe(2);
  });

  it("mounts a TV on an articulating mount instead of the tilt mount, and a TV on a cart on no mount at all", async () => {
    const tv = (change: string, o: object = {}) => job({ functional_systems: ["TV"], requested_changes: [change], ...o });
    const swing = await tv("Mount the customer's 65-inch TV on an articulating TV mount in the den");
    expect(quantities(swing)).toMatchObject({ tv_mount_articulating: 1 });
    expect(swing.lines.map((l) => l.role)).not.toContain("tv_mount");
    const both = await tv("An articulating mount in the den and a tilt mount in the bedroom");
    expect(both.lines.map((l) => l.role)).toEqual(expect.arrayContaining(["tv_mount", "tv_mount_articulating"]));
    // A cart has no Livewire standard: no wall mount, and the cart is listed to price rather than swapped for a mount.
    const cart = await tv("Put the customer's TV on a rolling cart on the patio");
    expect(cart.lines.map((l) => l.role)).toEqual([]);
    expect(cart.to_verify).toEqual(["Requested product: TV cart (rolling stand) (no Livewire standard; priced in the final proposal)"]);
    expect(cart.unresolved).toEqual([]);
    expect(cart.requirements).toEqual([expect.objectContaining({ system: "audio_video", classification: "allowance" })]);
    // The rep's own "Requested product: Bretford cart" already says it.
    const bretford = await tv("Put the customer's TV on a Bretford rolling cart", { unresolved_questions: ["Requested product: Bretford cart"] });
    expect(bretford.to_verify).toEqual([]);
  });

  it("prices out-of-pattern work as labor allowances, and the Crowder job gets a total", async () => {
    const patterns = await loadPatterns();
    const { scope, scopeHash, receiptId } = approvedScope({
      ...none,
      client: "Rick Crowder",
      functional_systems: ["outdoor WiFi", "TV", "conduit", "outdoor outlet"],
      room_types: ["Patio"],
      requested_changes: [
        "Add outdoor WiFi for the back patio and pool",
        "Put the customer's TV on a Bretford rolling cart outside",
        "Run conduit from the house to the patio",
        "Add an outdoor outlet by the pool for the TV",
      ],
      unresolved_questions: ["Requested product: Bretford rolling cart"],
    });
    const pattern = selectPattern(scope.functional_systems, patterns)!;
    const selection = materialize(scope, pattern);
    expect(selection.labor_allowances.map((a) => [a.key, a.hours])).toEqual([["outdoor_outlet", 4.5], ["conduit", 6]]);
    expect(selection.requirements.filter((r) => r.classification === "allowance").map((r) => r.system).sort()).toEqual(["audio_video", "conduit", "outdoor outlet"]);
    expect(selection.unresolved).toEqual([]);
    const roles = selection.lines.map((l) => l.role);
    expect(roles).not.toContain("tv_mount");
    expect(roles).not.toContain("wired_access_point");
    expect(quantities(selection)).toMatchObject({ outdoor_access_point: 1 });

    // Synthetic records for the shipped patterns: $300 a device at half cost, the $1 parts record.
    const catalog = Object.fromEntries(
      patternRecordIds(pattern).map((id, i) => [id, id === pattern.parts!.product_id ? product(id, "Livewire", "PARTS", 1, 0.01, { laborItems: [] }) : product(id, "TestCo", `DEV-${i}`, 300, 150, { laborItems: [] })]),
    );
    const { admitted } = await admitAll(pattern, catalog);
    const compiled = compile(selection, admitted, pattern);
    if (!compiled.ok) throw new Error(compiled.errors.join("\n"));
    const taxed: PolicyRecord = { ...POLICY, policy: { ...POLICY.policy, tax: { mode: "rate", rate_pct: 6, applies_to: "taxable_equipment" } } };
    const proposal = bind(compiled.draft, { runId: "run_test", receiptId, approvalId: "ap_1", scopeHash, scope, policy: taxed, releaseId: "rel" });
    // 10.5 hours at $179: in the subtotal, the margin (at the $89.50 cost rate) and the total.
    expect(proposal.labor_allowances.map((a) => [a.label, a.price_cents, a.cost_cents])).toEqual([
      ["Outdoor electrical outlet (allowance)", 80550, 40275],
      ["Conduit run (allowance)", 107400, 53700],
    ]);
    expect(proposal.commercial.allowances_cents).toBe(187950);
    expect(proposal.commercial).toMatchObject({ complete: true, label: "Total" });
    expect(proposal.commercial.total_cents).not.toBeNull();
    expect(proposal.commercial.subtotal_cents).toBe(proposal.commercial.equipment_cents + proposal.commercial.labor_cents + 187950 + proposal.commercial.parts_cents);
    expect(proposal.remaining_verification).toContain("Requested product: Bretford rolling cart");
    expect(validateProposal(proposal, scope, scopeHash, admitted, taxed)).toMatchObject({ ok: true });
    const customer = customerView(proposal);
    expect(customer.labor_allowances).toEqual([
      { label: "Outdoor electrical outlet (allowance)", note: "About 4.5 hours of labor, confirmed on site", amount_cents: 80550 },
      { label: "Conduit run (allowance)", note: "About 6 hours of labor, confirmed on site", amount_cents: 107400 },
    ]);
    expect(forbiddenCustomerKeys(customer)).toEqual([]);

    // A system no template covers is still escalated, and a prewire job prices its own cable runs.
    expect((await job({ functional_systems: ["TV", "pool automation"], requested_changes: ["Mount the TV", "Pool automation"] })).unresolved).toEqual([expect.objectContaining({ item: "pool automation", escalate: true })]);
    expect((await job({ functional_systems: ["prewire"], requested_changes: ["Run cable to 6 data drops"] })).labor_allowances).toEqual([]);
    // One change can ask for two kinds of work; an outdoor outlet is not also an indoor one.
    const one = await job({ functional_systems: ["TV"], requested_changes: ["Mount the TV", "Run conduit from the house to the patio and add an outdoor outlet by the pool"] });
    expect(one.labor_allowances.map((a) => a.key)).toEqual(["outdoor_outlet", "conduit"]);
    // "Data outlets" and an eero "outlet mount" are not electrical work.
    expect((await job({ functional_systems: ["Wi-Fi"], requested_changes: ["Add eero Wi-Fi with an outlet mount in the hall"] })).labor_allowances).toEqual([]);
  });
});

describe("Zack's round 3 (2026-10-13)", () => {
  const none = { existing_equipment: { status: "none" as const, retained: [], removed_or_replaced: [] } };
  const quantities = (sel: ReturnType<typeof materialize>) => Object.fromEntries(sel.lines.map((l) => [l.role, l.quantity]));
  const SVR210 = "5df9bd7b-85fa-4b0b-841a-d68e9550fd9b";
  const SWITCH = "de42b9ff-167d-438c-88e0-df8afd6b46c9";
  const EERO_PRO_7 = "f9267d39-99d7-4906-8b19-081be5132697";
  // The eero records in Livewire's D-Tools catalog the Bowen-Rees request could name.
  const EEROS = catalogIndex([
    { id: EERO_PRO_7, name: "eero Pro 7 B0C6RBS846", brand: "eero", model: "Pro 7", partNumber: "B0C6RBS846", category: "Networking > Routers & Gateways" },
    { id: "b73b3608-eaf1-4517-b129-222a794f4f74", name: "eero eero 7 B0D954FD8R", brand: "eero", model: "eero 7", partNumber: "B0D954FD8R", category: "Networking > Routers & Gateways" },
    { id: "4372a3e8-dcae-404f-85e8-73a0ffe59747", name: "eero Outdoor PoE 7 SN11111", brand: "eero", model: "Outdoor PoE 7", partNumber: "SN11111", category: "Uncategorized" },
    { id: "9761ac74-f94c-4c62-bc5c-a166eb2d3266", name: "eero PoE 7", brand: "eero", model: "PoE 7", category: "Networking > Wireless Access Points" },
  ]);
  /** Synthetic records for the shipped patterns with their real brands and models: $300 a device at half cost, the $1 parts record. */
  const REAL: Record<string, [string, string]> = {
    [SWITCH]: ["Araknis Networks", "AN-220-SW-R-8-POE"],
    "4372a3e8-dcae-404f-85e8-73a0ffe59747": ["eero", "Outdoor PoE 7"],
    [EERO_PRO_7]: ["eero", "Pro 7"],
    "9761ac74-f94c-4c62-bc5c-a166eb2d3266": ["eero", "PoE 7"],
    "84e7060d-cd26-49b5-bbc7-cd9162dff768": ["Apple", "Apple TV 4K (2026)"],
  };
  async function build(pattern: PatternSpec, scopeOverrides: object, named: Parameters<typeof materialize>[2] = []) {
    const { scope, scopeHash, receiptId } = approvedScope({ ...none, ...scopeOverrides });
    const selection = materialize(scope, pattern, named);
    const catalog = Object.fromEntries(
      patternRecordIds(pattern).map((id, i) => [
        id,
        id === pattern.parts!.product_id ? product(id, "Livewire", "PARTS", 1, 0.01, { laborItems: [] }) : product(id, REAL[id]?.[0] ?? "TestCo", REAL[id]?.[1] ?? `DEV-${i}`, 300, 150, { laborItems: [] }),
      ]),
    );
    const { admitted } = await admitAll(pattern, catalog);
    const compiled = compile(selection, admitted, pattern);
    if (!compiled.ok) throw new Error(compiled.errors.join("\n"));
    const taxed: PolicyRecord = { ...POLICY, policy: { ...POLICY.policy, tax: { mode: "rate", rate_pct: 6, applies_to: "taxable_equipment" } } };
    const proposal = bind(compiled.draft, { runId: "run_test", receiptId, approvalId: "ap_1", scopeHash, scope, policy: taxed, releaseId: "rel" });
    return { scope, selection, proposal, validation: validateProposal(proposal, scope, scopeHash, admitted, taxed) };
  }

  // Ted Britt (run_837a7a53): network, outdoor TV, security, cameras and smoke/CO, as the extractor read it (no doorbell system).
  const BRITT = {
    client: "Ted Britt",
    existing_detectors: "none" as const,
    functional_systems: ["networking", "outdoor TV", "security system", "video surveillance", "smoke/CO detectors", "smart thermostat"],
    room_types: ["Master bedroom", "Hallway", "Dining room", "Living room", "Porch"],
    requested_changes: [
      "Add Ethernet port in master bedroom on top floor",
      "Add PoE access point in hallway of the top floor",
      "Add Ethernet port in dining room",
      "Add Ethernet port in living room",
      "Add Ethernet port behind the outdoor TV location on the back porch",
      "Install 55-inch outdoor rated TV with cover",
      "Install articulated mounting bracket for the outdoor TV",
      "Install SVR in the dining room",
      "Install security panel in hallway leading from carriage to the kitchen",
      "Install wired smart doorbell camera; the current doorbell is wired and the chime is working",
      "Install wired floodlight camera at the back of the house above the garage",
      "Install wired camera in the front of the house",
      "Install wired camera on the back corner of the house",
      "Install 2 smoke/CO detectors upstairs",
      "Install 2 smoke/CO detectors downstairs",
      "Install smart thermostat downstairs in the hallway between the kitchen and the front door",
    ],
    requested_quantities: [
      { item: "wired smart doorbell camera", quantity: 1 },
      { item: "wired floodlight camera", quantity: 1 },
      { item: "wired camera in the front of the house", quantity: 1 },
      { item: "wired camera on the back corner of the house", quantity: 1 },
      { item: "smoke/CO detectors upstairs", quantity: 2 },
      { item: "smoke/CO detectors downstairs", quantity: 2 },
      { item: "smart thermostat", quantity: 1 },
    ],
  };

  // Melissa Bowen-Rees (run_a770a3f5): cameras, a doorbell, an SVR and one more eero.
  const BOWEN_REES = {
    client: "Melissa Bowen-Rees",
    existing_detectors: "not_provided" as const,
    functional_systems: ["video surveillance", "networking"],
    requested_changes: [
      "Add 3 cameras and 1 video doorbell",
      "Add an additional Eero 7Pro to the son's bedroom",
      "Install wired Smart doorbell camera at front door (current doorbell and chime is operational)",
      "Install wired camera on the side of the house, facing the parking lot",
      "Install wired camera at the back of the house, facing the back yard",
      "Install wired floodlight camera above the garage, replacing the current floodlight",
      "Install SVR in the basement closet",
      "Add Eero 7 Pro in the son's bedroom below his desk; his room is a dead spot",
    ],
    requested_quantities: [
      { item: "wired Smart doorbell camera", quantity: 1 },
      { item: "wired camera on the side of the house", quantity: 1 },
      { item: "wired camera at the back of the house", quantity: 1 },
      { item: "wired floodlight camera", quantity: 1 },
      { item: "SVR", quantity: 1 },
      { item: "Eero 7 Pro", quantity: 1 },
    ],
  };

  it("prices Crowder's Apple TV for \"streaming\" and keeps the total, and drops verify lines the budget settles", async () => {
    const patterns = await loadPatterns();
    const crowder = {
      client: "Rick Crowder",
      existing_detectors: "not_provided" as const,
      functional_systems: ["outdoor WiFi", "TV cart", "streaming", "conduit and cabling", "outdoor electrical"],
      requested_changes: [
        "Add 2 eero Pro 7 and 1 outdoor eero PoE 7 for WiFi at the front yard post",
        "Add a PoE switch to power the outdoor eero",
        "Put the customer's LG 75UN7070PUC TV on a Bretford Explorer rolling cart",
        "Add an Apple TV connected via WiFi for streaming",
        "Run conduit from the head end to the post",
        "Add an outdoor receptacle at the post",
      ],
      requested_quantities: [
        { item: "eero Pro 7", quantity: 2 },
        { item: "outdoor eero PoE 7", quantity: 1 },
        { item: "Apple TV", quantity: 1 },
      ],
      unresolved_questions: [
        "Requested product: Bretford Explorer display cart ETCMV-SB*",
        "Requested product: LG 75UN7070PUC (client supplied)",
        "Requested product: Outdoor Eero PoE 7",
        "Requested product: Apple TV",
        "PoE switch vs 5 port switch with PoE injector undecided",
        "Is a second outdoor AP needed for TV use on the pool deck?",
      ],
    };
    const { scope } = approvedScope({ ...none, ...crowder });
    expect(scope.functional_systems).toContain("audio_video");
    expect(scope.functional_systems).not.toContain("streaming");
    const pattern = selectPattern(scope.functional_systems, patterns)!;
    expect(pattern.pattern).toBe("home_network+tv_media");
    const { selection, proposal, validation } = await build(pattern, crowder);
    expect(selection.unresolved).toEqual([]);
    expect(quantities(selection)).toMatchObject({ streamer: 1, mesh_wifi: 2, outdoor_access_point: 1, network_switch: 1 });
    expect(proposal.commercial.total_cents).not.toBeNull();
    expect(validation.ok).toBe(true);
    // The priced outdoor eero and Apple TV, the client's own TV and the PoE switch question are settled; the cart and the open question stay.
    const v = proposal.remaining_verification;
    expect(v.filter((x) => /Outdoor Eero|LG 75UN|Apple TV|PoE (switch|injector)/i.test(x))).toEqual([]);
    expect(v).toEqual(expect.arrayContaining(["Requested product: Bretford Explorer display cart ETCMV-SB*", "Is a second outdoor AP needed for TV use on the pool deck?"]));
  });

  it("prices Britt's doorbell, SVR, articulating mount, 4 smoke/CO pairs, the PoE access point and 5 cable runs, one switch, and no unasked keypad, contacts or mesh eeros", async () => {
    const patterns = await loadPatterns();
    const { scope } = approvedScope({ ...none, ...BRITT });
    const pattern = selectPattern(scope.functional_systems, patterns)!;
    expect(pattern.pattern).toBe("home_network+security_modernization+surveillance+tv_media+video_doorbell");
    const { selection, proposal, validation } = await build(pattern, BRITT);
    expect(quantities(selection)).toMatchObject({
      doorbell_camera: 1,
      nvr: 1,
      tv_mount_articulating: 1,
      smoke_heat_detector: 4,
      co_detector: 4,
      outdoor_camera: 2,
      floodlight_camera: 1,
      thermostat: 1,
      network_switch: 1,
      power_protection: 1,
      wired_access_point: 1,
    });
    const roles = selection.lines.map((l) => l.role);
    // Zack, 2026-10-15: wired drops and one PoE access point, not an eero mesh and an outdoor eero.
    for (const role of ["tv_mount", "camera_storage", "camera_poe_switch", "keypad", "door_window_contact", "mesh_wifi", "outdoor_access_point"]) expect(roles).not.toContain(role);
    expect(selection.lines.find((l) => l.role === "nvr")!.record_id).toBe(SVR210);
    expect(selection.lines.filter((l) => l.record_id === SWITCH)).toHaveLength(1);
    // The rep's detector counts leave nothing to verify; the access point with no eero router priced does.
    const v = proposal.remaining_verification;
    expect(v.filter((x) => /detector count|Keypad|Door\/window|mesh/.test(x))).toEqual([]);
    expect(v).toContain("eero access points join an eero network: confirm the existing eero router, or add an eero Pro 7 as the router");
    // Four Ethernet ports and the access point's drop, one cable-run allowance each: 5 × 2 h at $179.
    expect(proposal.labor_allowances.map((a) => [a.key, a.quantity, a.hours, a.price_cents])).toEqual([["wiring_run", 5, 10, 179000]]);
    expect(customerView(proposal).labor_allowances[0]!.note).toBe("5 × about 2 hours of labor (10 hours), confirmed on site");
    expect(validation.ok).toBe(true);
    expect(proposal.commercial.total_cents).not.toBeNull();
  });

  it("prices Bowen-Rees's doorbell, SVR, one switch and the eero Pro 7 she named, not the eero 7", async () => {
    const patterns = await loadPatterns();
    const { scope } = approvedScope({ ...none, ...BOWEN_REES });
    const named = findNamedProducts(scope, EEROS);
    expect(named.map((n) => n.record_id)).toEqual([EERO_PRO_7]);
    const pattern = selectPattern(scope.functional_systems, patterns)!;
    expect(pattern.pattern).toBe("home_network+surveillance+video_doorbell");
    const { selection, validation } = await build(pattern, BOWEN_REES, named);
    expect(quantities(selection)).toMatchObject({ doorbell_camera: 1, nvr: 1, outdoor_camera: 2, floodlight_camera: 1, mesh_wifi: 1, network_switch: 1 });
    expect(selection.lines.find((l) => l.role === "mesh_wifi")).toMatchObject({ record_id: EERO_PRO_7, quantity_basis: "fixed", verify: null });
    const roles = selection.lines.map((l) => l.role);
    for (const role of ["camera_storage", "camera_poe_switch", "wired_access_point", "outdoor_access_point"]) expect(roles).not.toContain(role);
    expect(selection.lines.filter((l) => l.record_id === SWITCH)).toHaveLength(1);
    expect(validation.ok).toBe(true);
  });

  it("keeps smoke and CO separate when asked separately, and a keypad or contacts when the request asks for them", async () => {
    const security = async (o: object) => {
      const patterns = await loadPatterns();
      const { scope } = approvedScope({ ...none, existing_detectors: "none", functional_systems: ["alarm panel", "smoke detectors", "CO detectors"], ...o });
      return quantities(materialize(scope, selectPattern(scope.functional_systems, patterns)!));
    };
    const separate = await security({ requested_changes: ["Replace the alarm panel", "Add 3 smoke detectors and 1 CO detector"], requested_quantities: [{ item: "smoke detectors", quantity: 3 }, { item: "CO detector", quantity: 1 }] });
    expect(separate).toMatchObject({ smoke_heat_detector: 3, co_detector: 1 });
    expect(separate).not.toHaveProperty("keypad");
    expect(separate).not.toHaveProperty("door_window_contact");
    expect(await security({ requested_changes: ["Replace the alarm panel and keypad", "Add contacts on the doors and windows"] })).toMatchObject({ keypad: 1, door_window_contact: 1 });
    expect(await security({ requested_changes: ["Replace the alarm panel"], requested_quantities: [{ item: "doors", quantity: 3 }] })).toMatchObject({ door_window_contact: 3 });
  });

  it("dedupes a product two combined patterns price, at the larger count or the rep's own", async () => {
    const patterns = await loadPatterns();
    const job = (o: object) => {
      const { scope } = approvedScope({ ...none, existing_detectors: "not_provided", functional_systems: ["Wi-Fi", "cameras"], ...o });
      return materialize(scope, selectPattern(scope.functional_systems, patterns)!);
    };
    const both = job({ requested_changes: ["Add eero Wi-Fi to the house", "Install 2 turret cameras"] });
    expect(both.lines.filter((l) => l.record_id === SWITCH).map((l) => [l.role, l.quantity])).toEqual([["network_switch", 1]]);
    expect(both.requirements.find((r) => r.system === "video_surveillance")!.roles).not.toContain("camera_poe_switch");
    const two = job({ requested_changes: ["Add eero Wi-Fi to the house", "Install 2 turret cameras", "Add 2 PoE switches"], requested_quantities: [{ item: "PoE switches", quantity: 2 }] });
    expect(two.lines.filter((l) => l.record_id === SWITCH).map((l) => l.quantity)).toEqual([2]);
  });

  it("tells the rep the total in plain words, or why it is withheld, with up to 12 items", async () => {
    const patterns = await loadPatterns();
    const { scope } = approvedScope({ ...none, ...BRITT });
    const { proposal } = await build(selectPattern(scope.functional_systems, patterns)!, BRITT);
    const text = budgetReadyLines(proposal).join("\n");
    expect(text).toMatch(/^Proposal validated for Ted Britt\.\nTotal \$[\d,.]+ incl\. tax \(subtotal \$[\d,.]+, tax \$[\d,.]+\)\./);
    expect(text).not.toContain("(total");
    const items = text.split("\n").filter((l) => l.startsWith("• "));
    expect(items).toHaveLength(12);
    expect(items[0]).toBe("• eero PoE 7 × 1");
    expect(text).toContain(`+${proposal.sections.reduce((n, s) => n + s.lines.length, 0) - 12} more`);
    expect(text).toContain("Allowances (verify on site): Low-voltage cable run (allowance) × 5 10 h, $1,790.00.");
    const withheld = { ...proposal, unresolved: [{ item: "pool automation", role: null, reason: "not covered", escalate: true }], commercial: { ...proposal.commercial, complete: false, total_cents: null } };
    expect(budgetReadyLines(withheld)[1]).toBe(`Priced so far ${formatUsd(proposal.commercial.subtotal_cents)} — total withheld: unresolved: pool automation.`);
  });

  it("matches a requested product to a priced line in any word order, case and punctuation", async () => {
    const pattern = selectPattern(["networking"], await loadPatterns())!;
    const { proposal } = await build(pattern, {
      functional_systems: ["outdoor WiFi"],
      requested_changes: ["Add outdoor WiFi for the back patio and pool"],
      unresolved_questions: ["Requested product: Outdoor Eero PoE 7", "Requested product: EERO outdoor-poe 7", "Requested product: Ubiquiti U7 Outdoor"],
    });
    expect(proposal.remaining_verification.filter((x) => x.startsWith("Requested product"))).toEqual(["Requested product: Ubiquiti U7 Outdoor"]);
  });

  it("Baker: customer's Sony TV, Sony mount named, Leon frame — same lines as before and margin at or above the floor", async () => {
    const tv = (await loadPatterns()).find((p) => p.pattern === "tv_media")!;
    const mount = tv.roles.find((r) => r.role === "tv_mount")!;
    const tvIds = new Set([tv.roles.find((r) => r.role === "television")!, ...(tv.roles.find((r) => r.role === "television")!.variants ?? [])].map((x) => x.product_id));
    // Synthetic records: the Sanus mount at a healthy margin, a Sony TV at a thin one (as TVs are), the $1 parts record.
    const catalog = Object.fromEntries(
      patternRecordIds(tv).map((id, i) => [
        id,
        id === tv.parts!.product_id
          ? product(id, "Livewire", "PARTS", 1, 0.01, { laborItems: [] })
          : id === mount.product_id
            ? product(id, "Sanus", "CILT4-B1", 249.99, 125, { laborItems: [] })
            : tvIds.has(id)
              ? product(id, "Sony", `TV-${i}`, 1599, 1312, { laborItems: [] })
              : product(id, "TestCo", `DEV-${i}`, 300, 150, { laborItems: [] }),
      ]),
    );
    const { admitted } = await admitAll(tv, catalog);
    const policy: PolicyRecord = {
      ...POLICY,
      policy: { ...POLICY.policy, margin: { residential_min_gross_margin_pct: 40, commercial_min_gross_margin_pct: 37.5 }, design_delivery: { base_pct: 10, max_pct: 15 } },
    };
    const said = "Mount the customer's 65-inch Sony TV on the living room wall with a Sony ultra slim mount, inside a Leon frame.";
    const baker = {
      client: "Richard Baker",
      functional_systems: ["TV"],
      requested_changes: [said],
      existing_equipment: { status: "described" as const, retained: ["65-inch Sony TV"], removed_or_replaced: [] },
      existing_detectors: "not_provided" as const,
      unresolved_questions: ["Requested product: Sony ultra slim mount", "Requested product: Leon frame"],
    };
    const run = async (o: object) => {
      const { scope, scopeHash, receiptId } = approvedScope({ ...baker, ...o });
      const compiled = compile(materialize(scope, tv), admitted, tv);
      if (!compiled.ok) throw new Error(compiled.errors.join("\n"));
      const proposal = bind(compiled.draft, { runId: "run_test", receiptId, approvalId: "ap_1", scopeHash, scope, policy, releaseId: "rel" });
      return { proposal, validation: validateProposal(proposal, scope, scopeHash, admitted, policy) };
    };
    const variants: Record<string, object> = {
      // As b2b6865 read it: the TV kept, the mount and frame left to verify.
      before: {},
      // The Sony mount counted ("names the model, states the count"): Sony is the mount's brand, not a new Sony TV.
      "mount counted": { requested_quantities: [{ item: "Sony ultra slim mount", quantity: 1 }] },
      // The customer's TV not listed as kept equipment, only in the request's words.
      "TV not listed as kept": { existing_equipment: { status: "none", retained: [], removed_or_replaced: [] } },
      "customer's TV counted": { requested_quantities: [{ item: "customer's 65-inch Sony TV", quantity: 1 }] },
      "client-supplied TV": {
        requested_changes: ["Mount the client-supplied 65-inch Sony TV on the living room wall with a Sony ultra slim mount, inside a Leon frame."],
        existing_equipment: { status: "none", retained: [], removed_or_replaced: [] },
        requested_quantities: [{ item: "TV", quantity: 1 }],
      },
    };
    for (const [name, o] of Object.entries(variants)) {
      const { proposal, validation } = await run(o);
      expect(proposal.sections.flatMap((s) => s.lines.map((l) => `${l.brand} ${l.model} × ${l.quantity}`)), name).toEqual(["Sanus CILT4-B1 × 1"]);
      // $249.99 mount + 4 h at $179 + 10% Design & Delivery: $1,062.99, as on b2b6865.
      expect(proposal.commercial.subtotal_cents, name).toBe(106299);
      expect(proposal.internal.gross_margin_pct!, name).toBeGreaterThanOrEqual(40);
      expect(validation.findings.map((f) => f.code), name).not.toContain("margin_exception");
      expect(proposal.remaining_verification, name).toEqual(
        expect.arrayContaining([
          "Sanus tilt TV wall mount: one mount per wall-mounted TV",
          expect.stringMatching(/^Sony BRAVIA 7 65" TV \(retained: .*65-inch Sony TV\): existing equipment must be field-tested before it can be reused$/),
          "Requested product: Leon frame",
          "Requested product: Sony ultra slim mount",
        ]),
      );
    }
  });
});

describe("Zack's round 4 (2026-10-15)", () => {
  const none = { existing_equipment: { status: "none" as const, retained: [], removed_or_replaced: [] } };
  const quantities = (sel: ReturnType<typeof materialize>) => Object.fromEntries(sel.lines.map((l) => [l.role, l.quantity]));
  async function job(o: object) {
    const patterns = await loadPatterns();
    const { scope } = approvedScope({ ...none, existing_detectors: "not_provided", ...o });
    const pattern = selectPattern(scope.functional_systems, patterns)!;
    return { scope, pattern, selection: materialize(scope, pattern) };
  }

  it("Bowen-Rees: a stated total of exterior cameras is not more cameras on top of the itemized ones", async () => {
    const { selection } = await job({
      functional_systems: ["video surveillance", "networking"],
      requested_changes: [
        "Add 4 exterior cameras",
        "Install wired Smart doorbell camera at front door (current doorbell and chime is operational)",
        "Install wired camera on the side of the house, facing the parking lot",
        "Install wired camera at the back of the house, facing the back yard",
        "Install wired floodlight camera above the garage, replacing the current floodlight",
        "Install SVR in the basement closet",
        "Add an additional Eero 7 Pro in the son's bedroom; his room is a dead spot",
      ],
      requested_quantities: [
        { item: "exterior cameras", quantity: 4 },
        { item: "wired Smart doorbell camera", quantity: 1 },
        { item: "wired camera on the side of the house", quantity: 1 },
        { item: "wired camera at the back of the house", quantity: 1 },
        { item: "wired floodlight camera", quantity: 1 },
        { item: "SVR", quantity: 1 },
        { item: "Eero 7 Pro", quantity: 1 },
      ],
    });
    const q = quantities(selection);
    expect(q).toMatchObject({ outdoor_camera: 2, floodlight_camera: 1, doorbell_camera: 1, nvr: 1, network_switch: 1 });
    expect(q.outdoor_camera! + q.floodlight_camera! + q.doorbell_camera!).toBe(4);
    // Staging smoke, 2026-10-27: "wired cameras × 2" beside one wired floodlight and one wired doorbell camera is the two
    // wired cameras the request names on their own, not a total of the other two that happens to match.
    const counts = (extra: Array<{ item: string; quantity: number }>) =>
      job({
        functional_systems: ["video surveillance", "video doorbell"],
        requested_changes: [
          "Install 1 wired smart doorbell camera at the front door (current doorbell and chime work)",
          "Install 1 wired camera on the side of the house",
          "Install 1 wired camera at the back of the house",
          "Install 1 wired floodlight camera above the garage",
          "SVR in the basement closet",
        ],
        existing_equipment: { status: "described", retained: ["existing doorbell and chime"], removed_or_replaced: [] },
        requested_quantities: [
          ...extra,
          { item: "svr", quantity: 1 },
          { item: "wired cameras", quantity: 2 },
          { item: "wired floodlight camera", quantity: 1 },
          { item: "wired smart doorbell camera", quantity: 1 },
        ],
      });
    expect(quantities((await counts([])).selection)).toMatchObject({ outdoor_camera: 2, floodlight_camera: 1, doorbell_camera: 1, nvr: 1 });
    // A real total over them still goes: "4 exterior cameras" is the 2 wired cameras, the floodlight and the doorbell.
    const totaled = quantities((await counts([{ item: "exterior cameras", quantity: 4 }])).selection);
    expect(totaled).toMatchObject({ outdoor_camera: 2, floodlight_camera: 1, doorbell_camera: 1 });
    // A total of something else stays: 4 motion detectors are not the 2 smoke and 2 CO detectors.
    const security = await job({
      existing_detectors: "none",
      functional_systems: ["alarm panel", "motion detectors", "smoke detectors", "CO detectors"],
      requested_changes: ["Replace the alarm panel", "Add 4 motion detectors, 2 smoke detectors and 2 CO detectors"],
      requested_quantities: [{ item: "motion detectors", quantity: 4 }, { item: "smoke detectors", quantity: 2 }, { item: "CO detectors", quantity: 2 }],
    });
    expect(quantities(security.selection)).toMatchObject({ motion_detector: 4, smoke_heat_detector: 2, co_detector: 2 });
  });

  it("Britt: 2 smoke/CO detectors upstairs and 2 downstairs are 4 of each, however the floors are written", async () => {
    const counts: Array<Array<{ item: string; quantity: number }>> = [
      [{ item: "smoke/CO detectors (upstairs)", quantity: 2 }, { item: "smoke/CO detectors (downstairs)", quantity: 2 }],
      [{ item: "upstairs smoke/CO detectors", quantity: 2 }, { item: "downstairs smoke/CO detectors", quantity: 2 }],
      [{ item: "smoke/CO detectors", quantity: 4 }, { item: "smoke/CO detectors upstairs", quantity: 2 }, { item: "smoke/CO detectors downstairs", quantity: 2 }],
      // The same item listed once per floor (the normalizer used to keep only the last count).
      [{ item: "smoke/CO detectors", quantity: 2 }, { item: "smoke/CO detectors", quantity: 2 }],
    ];
    for (const requested_quantities of counts) {
      const { selection } = await job({
        existing_detectors: "none",
        functional_systems: ["security system", "smoke/CO detectors"],
        requested_changes: ["Install security panel in hallway", "Install 2 smoke/CO detectors upstairs", "Install 2 smoke/CO detectors downstairs"],
        requested_quantities,
      });
      expect(quantities(selection), JSON.stringify(requested_quantities)).toMatchObject({ smoke_heat_detector: 4, co_detector: 4 });
    }
  });

  it("Britt: a PoE access point and wired drops price the wired eero and a cable run each, not an eero mesh or an outdoor eero", async () => {
    for (const o of [
      {
        requested_changes: [
          "Add Ethernet port in master bedroom on top floor",
          "Add PoE access point in hallway of the top floor",
          "Add Ethernet port in dining room",
          "Add Ethernet port in living room",
          "Add Ethernet port behind the outdoor TV location on the back porch",
        ],
      },
      {
        // One change for the whole network section, with the outdoor TV in it.
        requested_changes: ["Network: Ethernet ports in the master bedroom, dining room and living room, and one behind the outdoor TV on the back porch; PoE access point in the top floor hallway"],
        requested_quantities: [{ item: "network drops", quantity: 5 }, { item: "PoE access point", quantity: 1 }],
      },
    ]) {
      const { selection } = await job({ functional_systems: ["networking"], ...o });
      // An add-on ("Add …" only) prices just the access point; a complete job adds the PoE switch, OvrC and WattBox with it.
      expect(quantities(selection)).toEqual(selection.add_on ? { wired_access_point: 1 } : { wired_access_point: 1, network_switch: 1, remote_management: 1, power_protection: 1 });
      expect(selection.labor_allowances.map((a) => [a.key, a.quantity])).toEqual([["wiring_run", 5]]);
      expect(selection.to_verify).toEqual(["eero access points join an eero network: confirm the existing eero router, or add an eero Pro 7 as the router"]);
    }
    // Wi-Fi asked for still prices the mesh, and an outdoor eero beside Wi-Fi words.
    const wifi = await job({ functional_systems: ["networking"], requested_changes: ["Add eero Wi-Fi to the house and a PoE access point for the back porch coverage"] });
    expect(quantities(wifi.selection)).toMatchObject({ mesh_wifi: 3, wired_access_point: 1, outdoor_access_point: 1 });
    expect(wifi.selection.to_verify).toEqual([]);
  });

  it("McGetrick: a kept Control4 controller is listed to field-test without withholding the total, and no Halo remote is added", async () => {
    const { selection } = await job({
      functional_systems: ["TV", "Control4"],
      requested_changes: ["Provide a new 65-inch TV for the family room on an articulated mount", "Integrate the TV with the existing Control4 controller"],
      requested_quantities: [{ item: "65-inch TV", quantity: 1 }],
      existing_equipment: { status: "described", retained: ["Control4 controller"], removed_or_replaced: [] },
    });
    expect(selection.unresolved).toEqual([]);
    expect(quantities(selection)).toEqual({ television: 1, tv_mount_articulating: 1 });
    expect(selection.to_verify).toEqual(["Control4 CORE 1 controller (retained: Control4 controller): existing equipment must be field-tested before it can be reused"]);
    expect(selection.requirements.find((r) => r.system === "home_automation")).toMatchObject({ classification: "allowance", note: "existing equipment kept: Control4 CORE 1 controller" });
    // A remote the request asks for is still priced.
    const remote = await job({ functional_systems: ["Control4"], requested_changes: ["Add a Control4 Halo remote for the family room"] });
    expect(quantities(remote.selection)).toMatchObject({ automation_remote: 1 });
  });

  it("McGetrick: a 75\" full-weather outdoor TV is never priced as an indoor TV", async () => {
    const patterns = await loadPatterns();
    const tv = patterns.find((p) => p.pattern === "tv_media")!;
    const indoor = new Set([tv.roles.find((r) => r.role === "television")!.product_id, ...tv.roles.find((r) => r.role === "television")!.variants!.filter((v) => !v.outdoor).map((v) => v.product_id)]);
    const { selection } = await job({
      functional_systems: ["outdoor TV"],
      requested_changes: ['Provide a new 75" full weather outdoor TV for the patio', "Install on an articulated mount"],
      requested_quantities: [{ item: '75" full weather outdoor TV', quantity: 1 }],
    });
    const line = selection.lines.find((l) => l.role === "television");
    expect(line && indoor.has(line.record_id)).toBeFalsy();
    // Henry, 2026-10-15: the Samsung Terrace QN75LST9D, Livewire's most quoted 75" outdoor TV.
    expect(line!.record_id).toBe("23502905-bbcf-4e3f-af0d-9bf230a9ad14");
    // Henry, 2026-10-19: over 70" outdoors, the Sanus VODLF125-B2 (40-85") replaces the Strong ART2-L (37-70").
    expect(selection.lines.find((l) => l.role === "tv_mount_articulating")!.record_id).toBe("5e126131-73ba-4869-a490-941cee78cd26");
    expect(selection.to_verify).toEqual([]);
    // An outdoor size with no approved outdoor model is listed to price, not priced as an indoor TV.
    const odd = await job({ functional_systems: ["outdoor TV"], requested_changes: ['Provide a new 85" weatherproof TV for the pool deck'], requested_quantities: [{ item: '85" weatherproof TV', quantity: 1 }] });
    expect(odd.selection.lines.find((l) => l.role === "television")).toBeUndefined();
    expect(odd.selection.to_verify).toEqual(['Requested product: 85" outdoor TV (no Livewire standard outdoor model at this size; priced in the final proposal)']);
    // The customer's outdoor TV is theirs, as before.
    const own = await job({ functional_systems: ["outdoor TV"], requested_changes: ["Mount the customer's 55-inch outdoor TV on the porch"] });
    expect(own.selection.lines.find((l) => l.role === "television")).toBeUndefined();
    // An indoor 75" TV prices the 75" BRAVIA 7 (Henry, 2026-10-27).
    const inside = await job({ functional_systems: ["TV"], requested_changes: ['Provide a new 75" TV for the family room'], requested_quantities: [{ item: '75" TV', quantity: 1 }] });
    expect(inside.selection.lines.find((l) => l.role === "television")!.record_id).toBe("37d42d83-6eb6-47d2-90a3-ccbd95110fd5");
  });

  it("Biscuit Belly: Klipsch in-ceiling speakers price Klipsch, 70V on a commercial job, each at the count stated", async () => {
    const klipsch = async (market: string) =>
      (
        await job({
          market,
          functional_systems: ["audio"],
          requested_changes: ["Replace the 3 indoor speakers with Klipsch in-ceiling speakers", "Replace the amplifier"],
          requested_quantities: [{ item: "Klipsch in-ceiling speakers", quantity: 3 }],
        })
      ).selection.lines.find((l) => l.role === "in_ceiling_speakers")!;
    // The PIC-650-T record is a pair in D-Tools ("Professional In-Ceiling Speaker - Pair"): 3 speakers are 2 pairs (Zack, 2026-10-19).
    expect(await klipsch("commercial")).toMatchObject({ record_id: "2d7cf03e-3887-42d6-86f0-7ca328448201", quantity: 2, requested_model: "PIC-650-T BW" });
    expect(await klipsch("residential")).toMatchObject({ record_id: "2a31c82f-fc48-481f-86ae-57bf40bc0e6d", quantity: 3, requested_model: "CS-16C II" });
    // No brand named: the Sonos standard, as before.
    const sonos = await job({ functional_systems: ["audio"], requested_changes: ["Add in-ceiling speakers in the kitchen"], requested_quantities: [{ item: "in-ceiling speakers", quantity: 2 }] });
    expect(sonos.selection.lines.find((l) => l.role === "in_ceiling_speakers")).toMatchObject({ quantity: 1 });
    expect(sonos.selection.lines.find((l) => l.role === "in_ceiling_speakers")!.requested_model).toBeUndefined();
  });

  it("Crowder: trench and conduit labor scale with the length given, conduit in the trench at its own rate", async () => {
    const site = async (changes: string[]) =>
      Object.fromEntries((await job({ functional_systems: ["outdoor WiFi", "trenching", "conduit"], requested_changes: ["Add an outdoor eero at the post", ...changes] })).selection.labor_allowances.map((a) => [a.key, [a.hours, a.feet ?? null]]));
    // 120 ft × 0.083 h = 10 h of trench; two conduits in it, 240 ft × 0.05 h = 12 h.
    expect(await site(["Hand trench 120 ft from the house to the post, cut and relay the sod", "Lay two conduits in the trench, glued in sections"])).toEqual({ trenching: [10, 120], conduit: [12, 240] });
    expect(await site(["Hand trench 120 ft with the sod cut and relaid, plus two conduits glued and laid in sections"])).toEqual({ trenching: [10, 120], conduit: [12, 240] });
    // Conduit on its own: 50 ft × 0.17 h = 8.5 h. No length: the flat templates.
    expect(await site(["Run 50 ft of conduit along the garage wall"])).toEqual({ trenching: [6, null], conduit: [8.5, 50] });
    expect(await site(["Run conduit from the head end to the post", "Trench to the post"])).toEqual({ trenching: [6, null], conduit: [6, null] });
    // Short runs keep the minimum.
    expect(await site(["Trench 30 ft to the lamp post"])).toEqual({ trenching: [6, 30], conduit: [6, 30] });
  });

  it("Crowder: the Apple TV is the 2026 SKU, not the discontinued one (Ben, 2026-10-14)", async () => {
    const tv = (await loadPatterns()).find((p) => p.pattern === "tv_media")!;
    expect(tv.roles.find((r) => r.role === "streamer")!.product_id).toBe("84e7060d-cd26-49b5-bbc7-cd9162dff768");
  });
});

describe("staging smoke, Britt (2026-10-15)", () => {
  it("prices the security system, 4+4 smoke/CO and both wired cameras from the receipt the interpreter produced", async () => {
    const patterns = await loadPatterns();
    // The staging receipt: no security system among the model's systems, the places inside the camera items.
    const { scope } = approvedScope({
      existing_detectors: "none",
      functional_systems: ["audio_video", "climate_control", "co_detection", "fire_detection", "networking", "video_doorbell", "video_surveillance"],
      existing_equipment: { status: "described", retained: ["current doorbell and chime", "customer's 55-inch outdoor TV"], removed_or_replaced: [] },
      requested_changes: [
        "Add Ethernet ports in the master bedroom, dining room and living room, and one behind the outdoor TV on the back porch",
        "Add a PoE access point in the top floor hallway",
        "Mount the customer's 55-inch outdoor TV on an articulated mounting bracket",
        "Install the SVR in the dining room",
        "Install the security panel in the hallway from the garage to the kitchen",
        "Install a wired smart doorbell camera",
        "Install a wired floodlight camera above the garage, a wired camera at the front of the house and one on the back corner",
        "Install 2 smoke/CO detectors upstairs and 2 downstairs",
        "Install a smart thermostat downstairs",
      ],
      requested_quantities: [
        { item: "ethernet ports", quantity: 4 },
        { item: "poe access points", quantity: 1 },
        { item: "security panel", quantity: 1 },
        { item: "smart thermostats", quantity: 1 },
        { item: "smoke/co detectors downstairs", quantity: 2 },
        { item: "smoke/co detectors upstairs", quantity: 2 },
        { item: "svr", quantity: 1 },
        { item: "wired back corner cameras", quantity: 1 },
        { item: "wired floodlight cameras", quantity: 1 },
        { item: "wired front cameras", quantity: 1 },
        { item: "wired smart doorbell cameras", quantity: 1 },
      ],
    });
    expect(scope.functional_systems).toContain("intrusion_security");
    const pattern = selectPattern(scope.functional_systems, patterns)!;
    expect(pattern.pattern).toContain("security_modernization");
    const q = Object.fromEntries(materialize(scope, pattern).lines.map((l) => [l.role, l.quantity]));
    expect(q).toMatchObject({ security_panel: 1, smoke_heat_detector: 4, co_detector: 4, outdoor_camera: 2, floodlight_camera: 1, doorbell_camera: 1, nvr: 1, wired_access_point: 1, thermostat: 1 });
    // A kept panel is not a request for one.
    const { scope: kept } = approvedScope({ functional_systems: ["cameras"], existing_detectors: "not_provided", requested_changes: ["Add 2 cameras; keep the existing security panel"] });
    expect(kept.functional_systems).not.toContain("intrusion_security");
  });
});

describe("Zack's round 5 (2026-10-19)", () => {
  const none = { existing_equipment: { status: "none" as const, retained: [], removed_or_replaced: [] } };
  const quantities = (sel: ReturnType<typeof materialize>) => Object.fromEntries(sel.lines.map((l) => [l.role, l.quantity]));
  async function job(o: object) {
    const patterns = await loadPatterns();
    const { scope } = approvedScope({ ...none, client: "Ted Britt", existing_detectors: "none", ...o });
    const pattern = selectPattern(scope.functional_systems, patterns)!;
    return { scope, pattern, selection: materialize(scope, pattern) };
  }
  /** Synthetic records with the real brands where wording depends on them, at $300 a device; the $1 parts record. */
  async function compiled(o: object) {
    const { scope, pattern, selection } = await job(o);
    const sonos = new Set(pattern.roles.filter((r) => /sonos/i.test(r.label)).map((r) => r.product_id));
    // A brand's record carries its own model, as compile checks a requested model against the catalog.
    const brands = new Map(pattern.roles.flatMap((r) => (r.brand_variants ?? []).map((v) => [v.product_id, [v.brand, v.model] as const])));
    const catalog = Object.fromEntries(
      patternRecordIds(pattern).map((id, i) => [
        id,
        id === pattern.parts!.product_id
          ? product(id, "Livewire", "PARTS", 1, 0.01, { laborItems: [] })
          : product(id, brands.get(id)?.[0] ?? (sonos.has(id) ? "Sonos" : "TestCo"), brands.get(id)?.[1] ?? `DEV-${i}`, 300, 150, { laborItems: [] }),
      ]),
    );
    const { admitted } = await admitAll(pattern, catalog);
    const result = compile(selection, admitted, pattern);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    return { scope, selection, draft: result.draft };
  }
  const SAMSUNG_55 = "25fa5dd7-fb1f-4d71-bec2-7bcb7b9db9ac";
  // Ted Britt (run_5f446650), the network and outdoor TV as Zack wrote them.
  const BRITT_NETWORK = [
    "Ethernet port in master bedroom on top floor",
    "POE Access point in hallway of the top floor",
    "Ethernet port in dining room",
    "Ethernet port in living room",
    "Ethernet port at the back of the house behind the outdoor TV location on the porch at the back of the house",
  ];

  it("Britt: a 55’’ outdoor rated TV is priced as the 55\" Samsung Terrace, and its count adds no outdoor eero", async () => {
    for (const tv of ["55’’ Outdoor rated TV with cover", "Install 55'' outdoor rated TV with cover", 'Install 55" outdoor rated TV with cover']) {
      for (const counted of [true, false]) {
        const { selection } = await job({
          functional_systems: ["networking", "outdoor TV"],
          requested_changes: [...BRITT_NETWORK, tv, "Articulated mounting bracket"],
          ...(counted ? { requested_quantities: [{ item: "Outdoor rated TV", quantity: 1 }] } : {}),
        });
        expect(selection.lines.find((l) => l.role === "television")).toMatchObject({ record_id: SAMSUNG_55, quantity: 1 });
        const roles = selection.lines.map((l) => l.role);
        expect(roles).not.toContain("outdoor_access_point");
        expect(roles).not.toContain("mesh_wifi");
        expect(selection.labor_allowances.map((a) => [a.key, a.quantity])).toEqual([["wiring_run", 5]]);
      }
    }
    // The customer's or an existing outdoor TV is still theirs.
    for (const change of ["Mount the customer's 55-inch outdoor TV on the porch", "Mount the existing 55'' outdoor TV on the porch"]) {
      const { selection } = await job({ functional_systems: ["outdoor TV"], requested_changes: [change] });
      expect(selection.lines.find((l) => l.role === "television")).toBeUndefined();
    }
  });

  it("Britt: the cable runs the budget prices cover a \"prewire\" service, so it doesn't withhold the total", async () => {
    const { selection } = await job({ functional_systems: ["networking"], service_categories: ["prewire", "installation"], requested_changes: BRITT_NETWORK });
    expect(selection.labor_allowances.map((a) => [a.key, a.quantity])).toEqual([["wiring_run", 5]]);
    expect(selection.allowances).toEqual([]);
  });

  it("Crowder: conduit by the stick, a trench depth that isn't a length, and a pipe size that isn't a count", async () => {
    const site = async (changes: string[]) =>
      Object.fromEntries((await job({ functional_systems: ["networking", "conduit", "trenching"], requested_changes: ["Add an outdoor eero PoE 7 at the post", ...changes] })).selection.labor_allowances.filter((a) => a.key !== "electrical_outlet").map((a) => [a.key, [a.hours, a.feet ?? null]]));
    // 12 sticks of 10 ft for data and 12 for electrical: 240 ft of conduit in a 120 ft trench. Henry, 2026-10-15: 10 h of trench and 12 h of conduit.
    expect(
      await site([
        "2 Cat6 burial runs through conduit from head end location to post location in the front yard",
        "12 - 10ft sticks of 3/4 conduit for data",
        "12 - 10ft sticks of 3/4 inch conduit for electrical",
        "120ft of conduit is likely enough",
        "Hand trench 1ft down along the same lines as the house power",
      ]),
    ).toEqual({ trenching: [10, 120], conduit: [12, 240] });
    // A depth alone gives the trench no length.
    expect(await site(["Hand trench 1 ft deep to the post"])).toMatchObject({ trenching: [6, null] });
    // "3/4 conduit" is one conduit, not four.
    expect(await site(["Run 50 ft of 3/4 conduit along the garage wall"])).toMatchObject({ conduit: [8.5, 50] });
  });

  it("Biscuit Belly: two restroom speakers on a commercial job are one PIC-650-T pair, and the amp counts both", async () => {
    const { selection } = await job({
      market: "commercial",
      client: "Ronnie Santillo",
      functional_systems: ["audio"],
      requested_changes: ["1 x new amplifier for background music on the existing 3 indoor and 2 terrace speakers", "1 x Klipsch in-ceiling speaker in the female and male restrooms each"],
      requested_quantities: [{ item: "Klipsch in-ceiling speaker", quantity: 2 }],
    });
    expect(selection.lines.find((l) => l.role === "in_ceiling_speakers")).toMatchObject({ record_id: "2d7cf03e-3887-42d6-86f0-7ca328448201", quantity: 1 });
  });

  it("McGetrick: a TV over 70\" gets the Sanus full-motion mount (outdoor or indoor); one no mount fits is listed to confirm", async () => {
    const mount = (r: Awaited<ReturnType<typeof job>>) => r.selection.lines.find((l) => l.role === "tv_mount_articulating")!.record_id;
    const big = await job({ functional_systems: ["outdoor TV"], requested_changes: ['Provide a new 75" full weather outdoor TV', "Install an articulated mounting bracket"], requested_quantities: [{ item: '75" full weather outdoor TV', quantity: 1 }] });
    expect(mount(big)).toBe("5e126131-73ba-4869-a490-941cee78cd26");
    expect(big.selection.to_verify).toEqual([]);
    const indoor = await job({ functional_systems: ["TV"], requested_changes: ['Mount the customer\'s 85" TV on an articulating mount in the family room'] });
    expect(mount(indoor)).toBe("2b111277-c810-411c-bebd-297ac03631ea");
    expect(indoor.selection.to_verify).toEqual([]);
    // 98" outdoors is beyond every approved mount: the standard, listed to confirm.
    const huge = await job({ functional_systems: ["outdoor TV"], requested_changes: ['Mount the customer\'s 98" outdoor TV on the patio on an articulating mount'] });
    expect(mount(huge)).toBe("e984e610-2be4-4e3e-9407-a90d3a70b6c8");
    expect(huge.selection.to_verify).toEqual(['Strong articulating TV wall mount is rated for 37-70" TVs and the TV is 98": confirm a mount rated for it']);
    const fits = await job({ functional_systems: ["outdoor TV"], requested_changes: ['Install 55" outdoor rated TV with cover', "Articulated mounting bracket"] });
    expect(fits.selection.to_verify).toEqual([]);
    // The tilt mount is rated 42-90": a 77" TV fits.
    const tilt = await job({ functional_systems: ["TV"], requested_changes: ['Provide a new 77" TV for the family room'], requested_quantities: [{ item: '77" TV', quantity: 1 }] });
    expect(tilt.selection.to_verify.filter((v) => /rated for/.test(v))).toEqual([]);
  });

  it("assumptions fit the job: no drywall for a TV outdoors or on a cart, no Sonos app without Sonos, and a commercial job is no residence", async () => {
    const outdoor = await compiled({ functional_systems: ["outdoor TV"], requested_changes: ['Install 55" outdoor rated TV with cover', "Articulated mounting bracket"] });
    expect(outdoor.draft.assumptions).toContain("The outdoor TV mounts to a solid exterior wall or structure, with weatherproof power and data at the mount.");
    expect(outdoor.draft.assumptions.some((a) => /drywall/.test(a))).toBe(false);
    const cart = await compiled({ functional_systems: ["TV"], requested_changes: ["Mount the customer's 75 inch TV on a rolling cart"] });
    expect(cart.draft.assumptions).toContain("The TV goes on a rolling cart; no wall mounting is included.");
    const indoor = await compiled({ functional_systems: ["TV"], requested_changes: ['Mount the customer\'s 65" TV on the family room wall'] });
    expect(indoor.draft.assumptions).toContain("TVs are mounted on standard drywall over wood studs, with power and data concealed in the wall.");
    const commercial = await compiled({
      market: "commercial",
      client: "Ronnie Santillo",
      functional_systems: ["audio"],
      requested_changes: ["1 x new amplifier for background music on the existing 3 indoor and 2 terrace speakers", "1 x Klipsch in-ceiling speaker in the female and male restrooms each"],
      requested_quantities: [{ item: "Klipsch in-ceiling speaker", quantity: 2 }],
    });
    expect(commercial.draft.assumptions.some((a) => /Sonos/.test(a))).toBe(false);
    expect(commercial.draft.assumptions).toContain("A working Wi-Fi network covers the equipment location.");
    const sonos = await compiled({ functional_systems: ["audio"], requested_changes: ["Add in-ceiling speakers in the kitchen"], requested_quantities: [{ item: "in-ceiling speakers", quantity: 2 }] });
    expect(sonos.draft.assumptions).toContain("A working Wi-Fi network covers the equipment location; Sonos is controlled from the Sonos app.");
    const proposal = bind(commercial.draft, { runId: "run_test", receiptId: "rc_1", approvalId: "ap_1", scopeHash: "h", scope: commercial.scope, policy: POLICY, releaseId: "rel" });
    const view = customerView(proposal);
    expect(view.title).toBe("Commercial Audio Budget");
    expect(view.intro.systems).toBe("commercial audio");
    expect(view.market).toBe("commercial");
  });
  it("Ben Khandan-Barani: relocating the client's Nest doorbell wiring builds, with no doorbell priced", async () => {
    // run_6fe66455 blocked: "critical role Alarm.com video doorbell … is neither priced nor unresolved".
    const { selection } = await compiled({
      client: "Ben Khandan-Barani",
      functional_systems: ["networking", "video doorbell", "TV"],
      requested_changes: [
        "Relocate doorbell wiring to the right side of the front door",
        "Install and configure the client-supplied Google Nest doorbell",
        "Mount the customer-supplied 65-inch Samsung Frame TV on the brick wall",
        "Install a network switch in the TV room cabinet",
      ],
    });
    expect(selection.lines.map((l) => l.role)).not.toContain("doorbell_camera");
    expect(selection.requirements.find((r) => r.system === "video_doorbell")).toMatchObject({ classification: "allowance" });
  });
  it("Henry, 10/19: commercial audio asks what plays the music; each wired camera says its Cat6 run is included", async () => {
    const restaurant = await job({
      market: "commercial",
      client: "Ronnie Santillo",
      functional_systems: ["audio"],
      requested_changes: ["1 x new amplifier for background music on the existing 3 indoor and 2 terrace speakers"],
    });
    expect(restaurant.selection.to_verify).toContain("Music source: none is priced; confirm what plays the music (the client's phone, POS or music service, or a Sonos Port)");
    const home = await job({ functional_systems: ["audio"], requested_changes: ["Add in-ceiling speakers in the kitchen"], requested_quantities: [{ item: "in-ceiling speakers", quantity: 2 }] });
    expect(home.selection.to_verify.some((v) => /Music source/.test(v))).toBe(false);
    const cams = await compiled({ functional_systems: ["video surveillance"], requested_changes: ["1 x wired camera at the front of the house", "1 x wired camera on the back corner"], requested_quantities: [{ item: "wired camera", quantity: 2 }] });
    const line = cams.draft.lines.find((l) => l.role === "outdoor_camera")!;
    expect(line.note).toBe("Includes its Cat6 run to the PoE switch: the run is in the install labor and the cable in Design & Delivery.");
    const view = customerView(bind(cams.draft, { runId: "run_test", receiptId: "rc_1", approvalId: "ap_1", scopeHash: "h", scope: cams.scope, policy: POLICY, releaseId: "rel" }));
    expect(view.sections.flatMap((x) => x.items).find((i) => i.note)!.note).toBe(line.note);
  });
});

describe("Zack's round 6 (2026-10-23)", () => {
  const none = { existing_equipment: { status: "none" as const, retained: [], removed_or_replaced: [] } };
  const quantities = (sel: ReturnType<typeof materialize>) => Object.fromEntries(sel.lines.map((l) => [l.role, l.quantity]));
  const SWITCH = "de42b9ff-167d-438c-88e0-df8afd6b46c9";
  async function job(o: object) {
    const patterns = await loadPatterns();
    const { scope, scopeHash, receiptId } = approvedScope({ ...none, existing_detectors: "not_provided", ...o });
    const pattern = selectPattern(scope.functional_systems, patterns)!;
    return { scope, scopeHash, receiptId, pattern, selection: materialize(scope, pattern) };
  }
  /** Synthetic records at $300 a device (a brand's record with its own model), the $1 parts record; compiled and bound. */
  async function built(o: object) {
    const { scope, scopeHash, receiptId, pattern, selection } = await job(o);
    const brands = new Map(pattern.roles.flatMap((r) => (r.brand_variants ?? []).map((v) => [v.product_id, [v.brand, v.model] as const])));
    const catalog = Object.fromEntries(
      patternRecordIds(pattern).map((id, i) => [
        id,
        id === pattern.parts!.product_id
          ? product(id, "Livewire", "PARTS", 1, 0.01, { laborItems: [] })
          : product(id, brands.get(id)?.[0] ?? "TestCo", brands.get(id)?.[1] ?? `DEV-${i}`, 300, 150, { laborItems: [] }),
      ]),
    );
    const { admitted } = await admitAll(pattern, catalog);
    const result = compile(selection, admitted, pattern);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    const proposal = bind(result.draft, { runId: "run_test", receiptId, approvalId: "ap_1", scopeHash, scope, policy: POLICY, releaseId: "rel" });
    return { scope, selection, draft: result.draft, proposal };
  }

  it("Bowen-Rees: wired cameras added with \"Add …\" wording still get the PoE switch that powers them", async () => {
    // run_8ed480693: every change read as "Add …", so the job priced as an add-on and the switch dropped ($7,761 → $4,731).
    const { selection } = await job({
      client: "Melissa Bowen-Rees",
      functional_systems: ["video surveillance", "networking"],
      existing_equipment: { status: "described", retained: ["current doorbell and chime"], removed_or_replaced: ["current floodlight"] },
      requested_changes: [
        "Add 4 exterior cameras",
        "Add a wired Smart doorbell camera at the front door",
        "Add a wired camera on the side of the house, facing the parking lot",
        "Add a wired camera at the back of the house, facing the back yard",
        "Add a wired floodlight camera above the garage, replacing the current floodlight",
        "Add an SVR in the basement closet",
        "Add an additional Eero 7 Pro in the son's bedroom",
      ],
      requested_quantities: [
        { item: "exterior cameras", quantity: 4 },
        { item: "wired Smart doorbell camera", quantity: 1 },
        { item: "wired camera on the side of the house", quantity: 1 },
        { item: "wired camera at the back of the house", quantity: 1 },
        { item: "wired floodlight camera", quantity: 1 },
        { item: "SVR", quantity: 1 },
        { item: "Eero 7 Pro", quantity: 1 },
      ],
    });
    expect(selection.add_on).toBe(true);
    expect(quantities(selection)).toMatchObject({ outdoor_camera: 2, floodlight_camera: 1, doorbell_camera: 1, nvr: 1, mesh_wifi: 1 });
    expect(selection.lines.filter((l) => l.record_id === SWITCH)).toHaveLength(1);
    // A floodlight camera alone takes no switch, and neither does a camera added to cameras the customer keeps.
    const flood = await job({ functional_systems: ["video surveillance"], requested_changes: ["Add a floodlight camera above the garage"] });
    expect(flood.selection.lines.some((l) => l.record_id === SWITCH)).toBe(false);
    const kept = await job({
      functional_systems: ["video surveillance"],
      existing_equipment: { status: "described", retained: ["existing Alarm.com cameras"], removed_or_replaced: [] },
      requested_changes: ["Add 1 wired camera at the back corner"],
      requested_quantities: [{ item: "wired camera", quantity: 1 }],
    });
    expect(quantities(kept.selection)).toEqual({ outdoor_camera: 1 });
  });

  it("Crowder: conduit counted as \"10ft sticks\" with the count beside it is 120 ft per run, once however often it is stated", async () => {
    // run_918da0cb: the counts went to the stated quantities, and "10ft sticks" alone was read as 10 ft (6 h each).
    const site = async (o: object) =>
      Object.fromEntries(
        (await job({ functional_systems: ["networking", "conduit", "trenching"], ...o })).selection.labor_allowances.filter((a) => a.key === "trenching" || a.key === "conduit").map((a) => [a.key, [a.hours, a.feet ?? null]]),
      );
    const changes = [
      "Add an outdoor eero PoE 7 at the post",
      "Run 2 Cat6 burial runs through conduit from the head end to the post in the front yard",
      "Run 1 electrical run through conduit along the same path",
      "Hand trench 1ft down along the same lines as the house power; cut the sod, lay the conduit in sections and relay the sod",
    ];
    const sticks = [
      { item: "10ft sticks of 3/4 conduit for data", quantity: 12 },
      { item: "10ft sticks of 3/4 inch conduit for electrical", quantity: 12 },
    ];
    expect(await site({ requested_changes: changes, requested_quantities: sticks })).toEqual({ trenching: [10, 120], conduit: [12, 240] });
    // The same sticks as a change and a stated count are not 480 ft.
    expect(
      await site({ requested_changes: [...changes, "12 - 10ft sticks of 3/4 conduit for data", "12 - 10ft sticks of 3/4 inch conduit for electrical"], requested_quantities: sticks }),
    ).toEqual({ trenching: [10, 120], conduit: [12, 240] });
  });

  it("Britt: a count of 4 Ethernet ports and a PoE access point is still 5 cable runs", async () => {
    const { selection } = await job({
      functional_systems: ["networking"],
      requested_changes: [
        "Ethernet port in master bedroom on top floor",
        "POE Access point in hallway of the top floor",
        "Ethernet port in dining room",
        "Ethernet port in living room",
        "Ethernet port at the back of the house behind the outdoor TV location on the porch",
      ],
      requested_quantities: [{ item: "ethernet ports", quantity: 4 }, { item: "PoE access point", quantity: 1 }],
    });
    expect(selection.labor_allowances.map((a) => [a.key, a.quantity])).toEqual([["wiring_run", 5]]);
  });

  it("Britt: a 55\" outdoor TV goes on the Sanus outdoor mount, like McGetrick's 75\"; an indoor one stays on the Strong", async () => {
    const mount = async (o: object) => (await job(o)).selection.lines.find((l) => l.role === "tv_mount_articulating")!.record_id;
    expect(await mount({ functional_systems: ["outdoor TV"], requested_changes: ["55’’ Outdoor rated TV with cover", "Articulated mounting bracket"] })).toBe("5e126131-73ba-4869-a490-941cee78cd26");
    expect(await mount({ functional_systems: ["TV"], requested_changes: ["Mount the customer's 55-inch TV in the living room on an articulating mount"] })).toBe("e984e610-2be4-4e3e-9407-a90d3a70b6c8");
  });

  it("McGetrick: a kept Control4 system prices nothing from home automation, so the budget isn't titled or worded for it", async () => {
    // run_aa12f15e: "Home Automation" in the title and Control4 CORE 1 assumptions, with no Control4 gear priced.
    const { draft, proposal } = await built({
      client: "Brad McGetrick",
      functional_systems: ["outdoor TV", "Control4"],
      existing_equipment: { status: "described", retained: ["Control4 system"], removed_or_replaced: [] },
      requested_changes: ['Provide a new 75" full weather outdoor TV with an articulated mounting bracket', "Connect the TV audio to the existing Control4 system"],
      requested_quantities: [{ item: '75" full weather outdoor TV', quantity: 1 }],
    });
    expect(draft.pattern).toBe("home_automation+tv_media");
    expect(draft.title_pattern).toBe("tv_media");
    expect(draft.assumptions.some((a) => /CORE 1/.test(a))).toBe(false);
    expect(draft.exclusions.some((x) => /4Sight/.test(x))).toBe(false);
    const view = customerView(proposal);
    expect(view.title).not.toMatch(/Automation/);
    expect(view.intro.systems).not.toMatch(/automation/);
    // The kept controller is still listed to field-test.
    expect(proposal.remaining_verification.some((v) => /Control4 CORE 1 controller \(retained/.test(v))).toBe(true);
    // A job that prices from every part keeps the full title and wording.
    const both = await built({ functional_systems: ["TV", "Control4"], requested_changes: ['Provide a new 65" TV for the family room', "Add a Control4 CORE 1 controller and a Halo remote"], requested_quantities: [{ item: '65" TV', quantity: 1 }] });
    expect(both.draft.title_pattern).toBeUndefined();
    expect(both.draft.assumptions.some((a) => /CORE 1/.test(a))).toBe(true);
  });

  it("Biscuit Belly: the verify list doesn't ask for the amplifier model once the amplifier is priced", async () => {
    const { proposal } = await built({
      market: "commercial",
      client: "Ronnie Santillo",
      functional_systems: ["audio"],
      requested_changes: ["1 x new amplifier for background music on the existing 3 indoor and 2 terrace speakers", "1 x Klipsch in-ceiling speaker in the female and male restrooms each"],
      requested_quantities: [{ item: "Klipsch in-ceiling speaker", quantity: 2 }],
      unresolved_questions: [
        "Amplifier model and number of zones/channels not specified; the message says the same music plays on all speakers",
        "Opening date is Oct 26, 2026; installation date not specified",
      ],
    });
    expect(proposal.sections.flatMap((s) => s.lines).some((l) => l.role === "zone_amplifier")).toBe(true);
    expect(proposal.remaining_verification.filter((v) => /^Amplifier model/.test(v))).toEqual([]);
    expect(proposal.remaining_verification).toContain("Opening date is Oct 26, 2026; installation date not specified");
  });
});

describe("Zack's round 7 (2026-10-26)", () => {
  const none = { existing_equipment: { status: "none" as const, retained: [], removed_or_replaced: [] } };
  const quantities = (sel: ReturnType<typeof materialize>) => Object.fromEntries(sel.lines.map((l) => [l.role, l.quantity]));
  async function job(o: object) {
    const patterns = await loadPatterns();
    const { scope, scopeHash, receiptId } = approvedScope({ ...none, existing_detectors: "not_provided", project_type: null, ...o });
    const pattern = selectPattern(scope.functional_systems, patterns)!;
    return { scope, scopeHash, receiptId, pattern, selection: materialize(scope, pattern) };
  }
  /** Synthetic records at $300 a device, the $1 parts record; compiled, bound and validated. */
  async function built(o: object) {
    const { scope, scopeHash, receiptId, pattern, selection } = await job(o);
    const catalog = Object.fromEntries(
      patternRecordIds(pattern).map((id, i) => [
        id,
        id === pattern.parts!.product_id ? product(id, "Livewire", "PARTS", 1, 0.01, { laborItems: [] }) : product(id, "TestCo", `DEV-${i}`, 300, 150, { laborItems: [] }),
      ]),
    );
    const { admitted } = await admitAll(pattern, catalog);
    const result = compile(selection, admitted, pattern);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    const proposal = bind(result.draft, { runId: "run_test", receiptId, approvalId: "ap_1", scopeHash, scope, policy: POLICY, releaseId: "rel" });
    return { scope, selection, draft: result.draft, proposal, validation: validateProposal(proposal, scope, scopeHash, admitted, POLICY) };
  }

  // Andrew Giessel (run_799c5e88, run_9745cbb5, run_df1c3f43): Cat6 home runs and a keystone patch panel into a finished house.
  const giessel = {
    client: "Andrew Giessel",
    requested_changes: [
      "Replace a loose Ethernet plate in the great room with a 2-port Cat6 keystone plate (one port terminates the Fios ONT feed, the other is a new run down to a basement hub)",
      "Cat6 home runs from the unfinished basement (drill-up access to all first-floor walls) to the library (2 ports), living room and mud room",
      "Terminate all runs on a small 8-port keystone patch panel in the basement mech room, tested and labeled",
      "Two-story Cat6 run up to the master bedroom via the bath/laundry plumbing chase, priced separately",
    ],
  };

  it("Giessel: cabling with no Wi-Fi is structured wiring, whatever the model calls it, never the Wi-Fi pattern", () => {
    for (const label of ["Structured cabling", "Network cabling", "Cat6 cabling", "Ethernet home runs", "Low-voltage cabling", "Keystone patch panel"]) {
      expect(normalizeFunctionalSystems([label]), label).toEqual(["structured_wiring"]);
    }
    // Wi-Fi is still networking; speaker and HDMI cabling are not structured wiring; a Wi-Fi job's Ethernet ports stay its cable runs.
    expect(normalizeFunctionalSystems(["home network"])).toEqual(["networking"]);
    expect(normalizeFunctionalSystems(["speaker cabling"])).toEqual(["whole_home_audio"]);
    expect(normalizeFunctionalSystems(["Ethernet ports"])).toEqual(["ethernet ports"]);
  });

  it("Dunham (the Giessel request): a keystone patch panel replaces the enclosure, its 8 ports are not 8 enclosures, the jacks take the stated count", async () => {
    // run_df1c3f43 priced WP-SW-PL-ENCL-42-1PK × 8: the enclosure's "panel" took the patch panel's count.
    // Henry, 2026-10-27: the panel is the C2G 12-port keystone panel, the plates Wirepath keystone plates, and a retrofit
    // drop takes a jack at each end. Giessel names 2-port plates, so they are PLATE-2-WH, one per 2 drops.
    for (const requested_quantities of [[], [{ item: "patch panel ports", quantity: 8 }], [{ item: "8-port keystone patch panel", quantity: 1 }]]) {
      const { pattern, selection } = await job({ ...giessel, functional_systems: ["structured cabling"], requested_quantities });
      expect(pattern.pattern).toBe("prewire");
      expect(quantities(selection), JSON.stringify(requested_quantities)).toEqual({ patch_panel: 1, data_drop: 12, wall_plate: 3, cat6_cable: 450 });
      expect(selection.lines.find((l) => l.role === "patch_panel")!.record_id).toBe("1d118218-96f0-421e-a29e-b686b6b2f069");
      expect(selection.lines.find((l) => l.role === "wall_plate")!.record_id).toBe("90b2d65c-6d4f-4dc0-bc7e-752688f5197b");
      expect(selection.to_verify).toEqual([]);
    }
    const counted = await job({ ...giessel, functional_systems: ["structured cabling"], requested_quantities: [{ item: "Cat6 data ports", quantity: 7 }] });
    expect(quantities(counted.selection)).toMatchObject({ data_drop: 14, patch_panel: 1 });
    // With no patch panel named, new construction still gets the enclosure.
    const prewire = await job({ functional_systems: ["prewire"], requested_changes: ["Prewire the new construction home for data"] });
    expect(quantities(prewire.selection)).toMatchObject({ media_enclosure: 1 });
  });

  it("Dunham: a retrofit is worded as one, not as open walls with retrofit fishing excluded", async () => {
    const retrofit = await built({ ...giessel, functional_systems: ["structured cabling"] });
    expect(retrofit.selection.retrofit).toBe(true);
    expect(retrofit.draft.assumptions).toContain("Cables are fished through finished walls or drilled up from an unfinished basement or attic; no wall is opened.");
    expect(retrofit.draft.assumptions.some((a) => /open walls/.test(a))).toBe(false);
    expect(retrofit.draft.exclusions).toContain("Opening, patching and painting walls or ceilings.");
    expect(retrofit.draft.exclusions.some((x) => /^Retrofit fishing/.test(x))).toBe(false);
    const open = await built({ functional_systems: ["prewire"], requested_changes: ["Prewire the new construction home before drywall"] });
    expect(open.selection.retrofit).toBeUndefined();
    expect(open.draft.assumptions).toContain("New construction or open walls: cables are run before drywall.");
  });

  it("Giessel: Ethernet drops alone on a network job are a budget of cable-run allowances, not 'no products could be priced'", async () => {
    const { selection, validation } = await built({ functional_systems: ["networking"], requested_changes: ["Add an Ethernet drop in the office", "Add an Ethernet drop in the den"] });
    expect(selection.lines).toEqual([]);
    expect(selection.labor_allowances.map((a) => [a.key, a.quantity])).toEqual([["wiring_run", 2]]);
    expect(validation.findings.filter((f) => f.code === "empty_bom")).toEqual([]);
  });

  it("Young: moving the customer's TV with the tilt mount asked for is one mount, not two", async () => {
    // run_362dce0d: Sanus CILT4-B1 × 2 for one 55" LG the client supplies.
    const { selection } = await job({
      client: "Rich Young",
      functional_systems: ["TV mounting"],
      existing_equipment: { status: "described", retained: ["55-inch LG TV (client-supplied)", "Sonos Playbar (client-supplied)"], removed_or_replaced: [] },
      requested_changes: ["Move the existing TV closer to the wall on a Sanus Advanced Tilt mount", "Mount the Sonos Playbar with a compatible mount"],
    });
    expect(quantities(selection)).toMatchObject({ tv_mount: 1 });
  });

  it("Paulenich: two new TVs get two mounts; a ProRemote is the TVs' remote, not a Control4 CORE 1", async () => {
    // run_1d29cdcd: Sony K65XR80 × 2 with Sanus CILT4-B1 × 1, and a Control4 C4-CORE1 nobody asked for.
    const tvs = await job({
      client: "Randy Paulenich",
      functional_systems: ["TV"],
      requested_changes: ["Replace 2 TVs"],
      requested_quantities: [{ item: "Upstairs TV", quantity: 1 }, { item: "Downstairs TV", quantity: 1 }],
    });
    expect(quantities(tvs.selection)).toMatchObject({ television: 2, tv_mount: 2 });
    expect(normalizeFunctionalSystems(["Universal remote control (ProRemote)", "TV"])).toEqual(["audio_video"]);
    expect(normalizeFunctionalSystems(["Control4 Halo remote"])).toEqual(["home_automation"]);
  });

  it("Paulenich: a Sonos Amp Multi the rep asks for is priced, with its rack mount, beside the Sonos Amp", async () => {
    // Henry, 2026-10-27: the Amp Multi is in the catalog (on 3 Livewire quotes), so it is priced when named.
    const { selection, proposal } = await built({
      client: "Randy Paulenich",
      functional_systems: ["Sonos whole-home audio"],
      requested_changes: ["Sonos Amp for the downstairs bedroom in-ceiling speakers", "2 Sonos Amp Multi for the independently controlled music zones"],
      unresolved_questions: ["Requested product: Sonos Amp Multi (4 zones)", "Requested product: Sonos Amp"],
    });
    expect(selection.lines.map((l) => l.role)).toEqual(expect.arrayContaining(["zone_amplifier", "multi_zone_amplifier", "amp_multi_rack_mount"]));
    expect(selection.lines.find((l) => l.role === "multi_zone_amplifier")!.record_id).toBe("4cd69589-af0d-4ac0-8694-f0c9f673c82f");
    expect(proposal.remaining_verification).not.toContain("Requested product: Sonos Amp Multi (4 zones)");
    expect(proposal.remaining_verification).not.toContain("Requested product: Sonos Amp");
  });

  it("Jinny's: Luma cameras on the Luma NVR they keep are listed to price as Luma, with no Alarm.com cameras and no PoE switch", async () => {
    // run_95c25155: Alarm.com ADC-VC838PF × 2 and an Araknis PoE switch beside the client's Luma NVR.
    const jinny = {
      client: "Mark Dunham & Jinny",
      market: "commercial",
      functional_systems: ["video surveillance"],
      existing_equipment: { status: "described", retained: ["Luma NVR", "2 existing cameras"], removed_or_replaced: ["2 indoor dome cameras"] },
      requested_changes: ["Replace the front desk indoor dome camera with a Luma camera", "Replace the back room indoor dome camera with a Luma camera"],
      requested_quantities: [{ item: "Luma cameras", quantity: 2 }],
      unresolved_questions: ["Requested product: Luma cameras"],
    };
    const { selection } = await job(jinny);
    expect(selection.lines.map((l) => l.role)).toEqual([]);
    expect(selection.to_verify).toContain("Requested product: Luma outdoor turret camera (not Livewire's standard brand for this; priced in the final proposal)");
    // Alarm.com cameras the rep asks for still price, with their switch.
    const adc = await job({ ...jinny, existing_equipment: none.existing_equipment, requested_changes: ["Install 2 turret cameras"], requested_quantities: [], unresolved_questions: [] });
    expect(quantities(adc.selection)).toMatchObject({ outdoor_camera: 2, camera_poe_switch: 1 });
  });
});

describe("Henry's decisions (2026-10-27): D-Tools quote history for cabling, cameras, soundbars, outdoor TVs, amps and the TV", () => {
  const none = { existing_detectors: "not_provided" as const, project_type: null, existing_equipment: { status: "none" as const, retained: [], removed_or_replaced: [] } };
  const quantities = (sel: ReturnType<typeof materialize>) => Object.fromEntries(sel.lines.map((l) => [l.role, l.quantity]));
  const record = (sel: ReturnType<typeof materialize>, role: string) => sel.lines.find((l) => l.role === role)?.record_id;
  async function job(o: object) {
    const patterns = await loadPatterns();
    const { scope } = approvedScope({ ...none, ...o });
    const pattern = selectPattern(scope.functional_systems, patterns)!;
    return { pattern, selection: materialize(scope, pattern) };
  }

  it("patterns carry the new version", async () => {
    const versions = Object.fromEntries((await loadPatterns()).map((p) => [p.pattern, p.version]));
    expect(versions).toMatchObject({ prewire: "2026-10-27.2", tv_media: "2026-10-27.1", whole_home_audio: "2026-10-27.1" });
  });

  it("Q1: a retrofit drop is two keystone jacks and 2 hours; a new-construction drop one jack and 1 hour", async () => {
    const drops = (change: string, n: number, extra: string[] = []) =>
      job({ functional_systems: ["structured cabling"], requested_changes: [change, ...extra], requested_quantities: [{ item: "Cat6 drops", quantity: n }] });
    const retro = await drops("Fish Cat6 drops through the finished walls to a patch panel in the basement", 4);
    expect(retro.selection.retrofit).toBe(true);
    expect(quantities(retro.selection)).toMatchObject({ data_drop: 8, patch_panel: 1 });
    // The line is the jacks, not outlets: 8 jacks for 4 retrofit drops.
    expect(retro.pattern.roles.find((r) => r.role === "data_drop")!.label).toBe("Cat6 keystone jack");
    expect(retro.selection.lines.find((l) => l.role === "data_drop")!.verify).toBe("2 keystone jacks per retrofit drop: one at the wall plate, one at the patch panel or enclosure");
    // 1 h setup + 8 jacks at 1 h + the panel's 1 h: 2 hours a drop.
    expect(laborHoursFor(retro.pattern, retro.selection.lines)).toBe(10);
    const open = await drops("Prewire the new construction home before drywall, with a patch panel", 4);
    expect(open.selection.retrofit).toBeUndefined();
    expect(quantities(open.selection)).toMatchObject({ data_drop: 4, patch_panel: 1 });
    // A 12-port panel per 12 drops: 14 retrofit drops (28 jacks) are two panels.
    expect(quantities((await drops("Fish Cat6 drops through the finished walls to a patch panel", 14)).selection)).toMatchObject({ data_drop: 28, patch_panel: 2 });
  });

  it("Q1: keystone plates are Wirepath PLATE-1-WH, one per drop, or the 2- or 4-port plate the request names, always verified per location", async () => {
    const plates = async (change: string) =>
      (await job({ functional_systems: ["prewire"], requested_changes: ["Prewire the new construction home before drywall", change], requested_quantities: [{ item: "data drops", quantity: 8 }] })).selection;
    const one = await plates("Keystone wall plates at each outlet");
    expect([record(one, "wall_plate"), quantities(one).wall_plate]).toEqual(["8a3ac5a3-aa6f-4e6e-a668-f0a2242804c4", 8]);
    expect(one.lines.find((l) => l.role === "wall_plate")).toMatchObject({ quantity_basis: "minimum_to_verify", verify: "one plate per outlet location, sized to its ports" });
    const four = await plates("4-port keystone wall plates in the office and den");
    expect([record(four, "wall_plate"), quantities(four).wall_plate]).toEqual(["9f38f625-4696-4a83-a30a-00369deb72a2", 2]);
    // No plate named, none priced.
    const bare = (await job({ functional_systems: ["prewire"], requested_changes: ["Prewire the new construction home before drywall"] })).selection;
    expect(quantities(bare).wall_plate).toBeUndefined();
  });

  it("Q2: troubleshooting the customer's cameras is a 2-hour allowance, with no new cameras", async () => {
    const { selection } = await job({
      functional_systems: ["security cameras"],
      requested_changes: ["Troubleshoot the offline cameras on the existing DVR"],
      existing_equipment: { status: "described", retained: ["4 existing cameras", "DVR"], removed_or_replaced: [] },
    });
    expect(selection.lines).toEqual([]);
    expect(selection.labor_allowances.map((a) => [a.key, a.hours])).toEqual([["camera_troubleshooting", 2]]);
    // Replacing a camera is a new camera, not a service call.
    const replace = await job({ functional_systems: ["security cameras"], requested_changes: ["Replace the offline driveway camera with a new turret camera"] });
    expect(replace.selection.labor_allowances.map((a) => a.key)).not.toContain("camera_troubleshooting");
  });

  it("Q3: a Sonos Beam is priced with the Sanus WSSBM1-B2; the Arc and Arc Ultra keep the WSSATM1-B2; a Playbar's mount is listed to price", async () => {
    const BEAM = "b8dc2e4b-a25b-4508-bf5b-e7f19959e73d";
    const WSSBM1 = "7fb73570-69b6-4b86-b9b6-613bc02370ff";
    const WSSATM1 = "5e66b358-6e5b-44b9-85ef-8945af55280a";
    const beam = (await job({ functional_systems: ["TV", "soundbar"], requested_changes: ["Mount a new 65-inch TV with a Sonos Beam soundbar"] })).selection;
    expect([record(beam, "soundbar"), record(beam, "soundbar_mount")]).toEqual([BEAM, WSSBM1]);
    const arc = (await job({ functional_systems: ["TV", "soundbar"], requested_changes: ["Mount a new 65-inch TV with a Sonos Arc Ultra soundbar"] })).selection;
    expect([record(arc, "soundbar"), record(arc, "soundbar_mount")]).toEqual(["5eb671b0-b05d-4671-940a-0d77f3bbeac7", WSSATM1]);
    // The Arc it replaces the Beam with sets the mount.
    const swap = (await job({ functional_systems: ["soundbar"], requested_changes: ["Replace the Sonos Beam with an Arc Ultra"], existing_equipment: { status: "described", retained: [], removed_or_replaced: ["Sonos Beam"] } })).selection;
    expect(record(swap, "soundbar_mount")).toBe(WSSATM1);
    // The customer's Beam is theirs; its mount is the Beam's.
    const kept = (await job({ functional_systems: ["soundbar"], requested_changes: ["Mount the existing Sonos Beam below the TV"], existing_equipment: { status: "described", retained: ["Sonos Beam"], removed_or_replaced: [] } })).selection;
    expect([record(kept, "soundbar"), record(kept, "soundbar_mount")]).toEqual([undefined, WSSBM1]);
    // "New" sells the mount: the soundbar words describe the mount or name the customer's Beam (Henry, 2026-10-27).
    const newMount = (await job({ functional_systems: ["soundbar"], requested_changes: ["New soundbar mount for the existing Sonos Beam"], existing_equipment: { status: "described", retained: ["Sonos Beam"], removed_or_replaced: [] } })).selection;
    expect([record(newMount, "soundbar"), record(newMount, "soundbar_mount")]).toEqual([undefined, WSSBM1]);
    // A new soundbar is still sold when the request sells one.
    const sold = (await job({ functional_systems: ["soundbar"], requested_changes: ["Sell a new Sonos Beam soundbar and mount it"], existing_equipment: { status: "described", retained: ["Sonos Beam"], removed_or_replaced: [] } })).selection;
    expect(record(sold, "soundbar")).toBe(BEAM);
    const playbar = (
      await job({
        functional_systems: ["TV mounting"],
        requested_changes: ["Move the existing TV closer to the wall on a Sanus Advanced Tilt mount", "Mount the Sonos Playbar with a compatible mount"],
        existing_equipment: { status: "described", retained: ["55-inch LG TV (client-supplied)", "Sonos Playbar (client-supplied)"], removed_or_replaced: [] },
      })
    ).selection;
    expect(record(playbar, "soundbar_mount")).toBeUndefined();
    expect(playbar.to_verify).toContain("Requested product: Soundbar mount for the Sonos Playbar (no Livewire standard; priced in the final proposal)");
  });

  it("Q4: a 55-inch outdoor TV is the partial-sun Terrace LST7 (there is no 55-inch LST9); 65 and 75 inches are the LST9", async () => {
    const outdoor = async (size: number) =>
      record((await job({ functional_systems: ["outdoor TV"], requested_changes: [`Provide a new ${size}" outdoor TV for the patio`] })).selection, "television");
    expect(await outdoor(55)).toBe("25fa5dd7-fb1f-4d71-bec2-7bcb7b9db9ac");
    expect(await outdoor(65)).toBe("9ad8ffc2-6092-4cf2-a483-d95a5086933d");
    expect(await outdoor(75)).toBe("23502905-bbcf-4e3f-af0d-9bf230a9ad14");
  });

  it("Q5: at least one Sonos Amp per room with speakers, still one per 4 speakers; the Amp Multi alone replaces the Sonos Amps", async () => {
    const amps = async (o: object) => quantities((await job({ functional_systems: ["in-ceiling speakers"], ...o })).selection).zone_amplifier;
    // 4 speakers in two rooms: 2 amps (one per 4 speakers would be 1).
    expect(await amps({ requested_changes: ["In-ceiling speakers in the kitchen and the office"], requested_quantities: [{ item: "in-ceiling speakers", quantity: 4 }] })).toBe(2);
    // 10 speakers in two rooms: 3 amps, one per 4 speakers.
    expect(await amps({ requested_changes: ["In-ceiling speakers in the kitchen and great room"], requested_quantities: [{ item: "in-ceiling speakers", quantity: 10 }] })).toBe(3);
    // One room of 4: one amp. A master bedroom is one room, not also a bedroom.
    expect(await amps({ requested_changes: ["In-ceiling speakers in the master bedroom"], requested_quantities: [{ item: "in-ceiling speakers", quantity: 4 }] })).toBe(1);
    const multi = (await job({ functional_systems: ["Sonos whole-home audio"], requested_changes: ["Sonos Amp Multi for 4 zones of in-ceiling speakers"], requested_quantities: [{ item: "in-ceiling speakers", quantity: 8 }] })).selection;
    expect(quantities(multi)).toMatchObject({ multi_zone_amplifier: 1, amp_multi_rack_mount: 1 });
    expect(quantities(multi).zone_amplifier).toBeUndefined();
    // No Multi named: no Multi and no rack mount.
    const plain = (await job({ functional_systems: ["in-ceiling speakers"], requested_changes: ["In-ceiling speakers in the kitchen"] })).selection;
    expect(plain.lines.map((l) => l.role)).not.toEqual(expect.arrayContaining(["multi_zone_amplifier"]));
    expect(plain.lines.map((l) => l.role)).not.toEqual(expect.arrayContaining(["amp_multi_rack_mount"]));
  });

  it("Q6: a TV with no model named is the Sony BRAVIA 7; a BRAVIA 8 or an OLED the request names is the BRAVIA 8", async () => {
    const tv = async (change: string) => record((await job({ functional_systems: ["TV"], requested_changes: [change] })).selection, "television");
    expect(await tv("Provide and mount a new 65-inch TV")).toBe("430b2a72-ece3-42c6-ab88-baff1d0bf464");
    expect(await tv("Provide and mount a new TV")).toBe("430b2a72-ece3-42c6-ab88-baff1d0bf464");
    expect(await tv("Provide and mount a new 55-inch TV")).toBe("0cf5b1a4-63e2-403d-b458-12d6b0d4764c");
    expect(await tv("Provide and mount a new 75-inch TV")).toBe("37d42d83-6eb6-47d2-90a3-ccbd95110fd5");
    expect(await tv("Provide and mount a new 65-inch Sony BRAVIA 8 TV")).toBe("47e8ba9b-b520-4890-b2d0-d92d37378382");
    expect(await tv("Provide and mount a new 55-inch OLED TV")).toBe("9984eb72-588e-448c-831a-d734c401c15f");
    expect(await tv("Provide and mount a new 77-inch OLED TV")).toBe("b89ed236-fff6-4985-a526-31d12b9c796f");
  });
});

describe("Zack's Standon job (2026-10-27): another brand's cameras are listed to price and the rest still builds", () => {
  const none = { existing_detectors: "not_provided" as const, project_type: null, existing_equipment: { status: "none" as const, retained: [], removed_or_replaced: [] } };
  /** Materialized and compiled against synthetic records for every product the pattern names, at $300 a device. */
  async function build(o: object) {
    const patterns = await loadPatterns();
    const { scope } = approvedScope({ ...none, ...o });
    const pattern = selectPattern(scope.functional_systems, patterns)!;
    const selection = materialize(scope, pattern);
    const catalog = Object.fromEntries(
      patternRecordIds(pattern).map((id, i) => [id, id === pattern.parts?.product_id ? product(id, "Livewire", "PARTS", 1, 0.01, { laborItems: [] }) : product(id, "TestCo", `DEV-${i}`, 300, 150, { laborItems: [] })]),
    );
    const { admitted } = await admitAll(pattern, catalog);
    return { selection, compiled: compile(selection, admitted, pattern) };
  }
  const UNIFI = "Requested product: UniFi outdoor turret camera (not Livewire's standard brand for this; priced in the final proposal)";

  it("UniFi cameras with a network, UPS and audio: the cameras are listed to price, everything else prices, and the build compiles", async () => {
    // Both runs failed: "critical role Alarm.com outdoor turret camera … is neither priced nor unresolved".
    const { selection, compiled } = await build({
      functional_systems: ["video surveillance", "home network", "whole home audio"],
      requested_changes: ["Install 4 UniFi cameras", "Install a network rack with a UPS", "Install 2 pairs of in-ceiling speakers"],
      requested_quantities: [{ item: "UniFi cameras", quantity: 4 }],
      unresolved_questions: ["Requested product: UniFi cameras"],
    });
    expect(compiled.ok ? [] : compiled.errors).toEqual([]);
    expect(selection.to_verify).toContain(UNIFI);
    const roles = selection.lines.map((l) => l.role);
    expect(roles).not.toContain("outdoor_camera");
    // No microSD cards or PoE switch for cameras that aren't ours to price.
    expect(roles).not.toContain("camera_storage");
    expect(roles).not.toContain("camera_poe_switch");
    expect(roles).toEqual(expect.arrayContaining(["power_protection", "zone_amplifier", "in_ceiling_speakers"]));
  });

  it("a cameras-only job in another brand compiles with the cameras listed to price (Jinny's Luma cameras too)", async () => {
    const unifi = await build({
      functional_systems: ["video surveillance"],
      requested_changes: ["Install 4 UniFi outdoor cameras"],
      requested_quantities: [{ item: "UniFi cameras", quantity: 4 }],
      unresolved_questions: ["Requested product: UniFi cameras"],
    });
    expect(unifi.compiled.ok ? [] : unifi.compiled.errors).toEqual([]);
    expect(unifi.selection.lines).toEqual([]);
    expect(unifi.selection.requirements).toEqual([expect.objectContaining({ system: "video_surveillance", classification: "allowance" })]);
    const luma = await build({
      market: "commercial",
      functional_systems: ["video surveillance"],
      existing_equipment: { status: "described", retained: ["Luma NVR", "2 existing cameras"], removed_or_replaced: ["2 indoor dome cameras"] },
      requested_changes: ["Replace the front desk indoor dome camera with a Luma camera", "Replace the back room indoor dome camera with a Luma camera"],
      requested_quantities: [{ item: "Luma cameras", quantity: 2 }],
      unresolved_questions: ["Requested product: Luma cameras"],
    });
    expect(luma.compiled.ok ? [] : luma.compiled.errors).toEqual([]);
  });

  it("Alarm.com cameras still price with their cards, and named cards stay with another brand's cameras", async () => {
    const adc = await build({ functional_systems: ["video surveillance"], requested_changes: ["Install 2 turret cameras"] });
    expect(adc.compiled.ok).toBe(true);
    expect(adc.selection.lines.map((l) => l.role)).toEqual(expect.arrayContaining(["outdoor_camera", "camera_storage"]));
    const cards = await build({
      functional_systems: ["video surveillance"],
      requested_changes: ["Install 4 UniFi outdoor cameras", "Add a 256 GB microSD card to each camera"],
      unresolved_questions: ["Requested product: UniFi cameras"],
    });
    expect(cards.selection.lines.map((l) => l.role)).toContain("camera_storage");
  });
});
