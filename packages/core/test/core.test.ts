import { describe, expect, it } from "vitest";
import {
  ANSWER_CHOICES,
  answerPatch,
  applyClarification,
  buildReceipt,
  canTransition,
  computeBlockers,
  decideSignal,
  findAuthorityFields,
  hashCanonical,
  normalizeExtraction,
  describeScopeChanges,
  isAddOnRequest,
  systemsMentioned,
  normalizeFunctionalSystems,
  normalizeServiceCategories,
  parseApprovalText,
  validateClarificationPatch,
  validateExtraction,
} from "../src/index.ts";
import { completeExtraction, emptyExtraction, noPatch } from "./fixtures.ts";

const route = { platform: "google_chat", space_id: "spaces/A", thread_id: "spaces/A/threads/T", session_generation: 1 };
const receiptFor = (extraction = completeExtraction(), version = 1) =>
  buildReceipt({ runId: "run-0123456789abcdef", version, requesterPersonId: "zack", route, extraction: normalizeExtraction(extraction).scope });

describe("scope validation", () => {
  it("accepts a well-formed extraction", () => {
    expect(validateExtraction(completeExtraction()).ok).toBe(true);
  });

  it("rejects unrecognized fields", () => {
    const r = validateExtraction({ ...completeExtraction(), favorite_color: "blue" });
    expect(r.ok).toBe(false);
  });

  it("rejects model-authored authority fields at any depth", () => {
    const raw = { ...completeExtraction(), property: { ...completeExtraction().property, approved_by: "zack" } };
    const r = validateExtraction(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("$.property.approved_by");
    expect(findAuthorityFields({ a: [{ scope_hash: "x" }] })).toEqual(["$.a[0].scope_hash"]);
  });

  it("rejects bad dates, sizes and budgets", () => {
    expect(validateExtraction(completeExtraction({ target_installation_date: "2026-02-30" })).ok).toBe(false);
    expect(validateExtraction(completeExtraction({ target_installation_date: "next spring" })).ok).toBe(false);
    expect(validateExtraction(completeExtraction({ size: { value: 0, unit: "sqft" } })).ok).toBe(false);
    expect(validateExtraction(completeExtraction({ budget: { status: "known", amount_usd: -5 } })).ok).toBe(false);
    expect(validateExtraction(completeExtraction({ budget: { status: "unknown", amount_usd: 100 } })).ok).toBe(false);
  });
});

describe("normalization", () => {
  it("maps equivalent phrasings to the same canonical scope and hash", () => {
    const a = completeExtraction();
    const b = completeExtraction({
      functional_systems: ["Alarm.com", "security system", "fire detection", "carbon monoxide detectors", "thermostat", "doorbell camera"],
      service_categories: ["commissioning", "install", "test", "system programming"],
    });
    const ra = receiptFor(a);
    const rb = receiptFor(b);
    expect(ra.scope!.functional_systems).toEqual(rb.scope!.functional_systems);
    expect(ra.scope!.service_categories).toEqual(["commissioning", "installation", "programming", "testing"]);
    expect(ra.scope_hash).toBe(rb.scope_hash);
  });

  it("keeps testing and commissioning separate", () => {
    const { scope } = normalizeExtraction(completeExtraction({ service_categories: ["testing & commissioning"] }));
    expect(scope.service_categories).toEqual(["commissioning", "testing"]);
  });

  it("does not coerce unknown systems into a known pattern", () => {
    const { scope } = normalizeExtraction(completeExtraction({ functional_systems: ["Pool automation"] }));
    expect(scope.functional_systems).toEqual(["pool automation"]);
  });

  it("does not treat smoke alarms as intrusion security", () => {
    const { scope } = normalizeExtraction(completeExtraction({ functional_systems: ["smoke alarms"] }));
    expect(scope.functional_systems).toEqual(["fire_detection"]);
  });

  it("drops equipment listed as a service category and says so", () => {
    const { scope, notes } = normalizeExtraction(completeExtraction({ service_categories: ["installation", "keypads"] }));
    expect(scope.service_categories).toEqual(["installation"]);
    expect(notes[0]).toContain("keypads");
  });
  it("is idempotent, including canonical service names", () => {
    const once = normalizeExtraction(completeExtraction({ service_categories: ["monitoring activation", "project management", "installation"] })).scope;
    expect(once.service_categories).toEqual(["installation", "monitoring_activation", "project_management"]);
    expect(normalizeExtraction(once)).toEqual({ scope: once, notes: [] });
  });
});

describe("revision changes", () => {
  it("lists what a revision changed in plain words, and nothing when nothing changed", () => {
    const before = normalizeExtraction(completeExtraction({ requested_quantities: [{ item: "eero", quantity: 3 }] })).scope;
    const after = normalizeExtraction(completeExtraction({ client: "Monica Greene", requested_quantities: [{ item: "eero", quantity: 4 }], excluded_scope: ["Painting"] })).scope;
    expect(describeScopeChanges(before, after)).toEqual(["Client: Smith Family → Monica Greene", "eero: 3 → 4", "Excluded added: Painting"]);
    expect(describeScopeChanges(before, structuredClone(before))).toEqual([]);
  });
});

describe("systems a sentence mentions", () => {
  it("finds the systems an open question is about", () => {
    expect(systemsMentioned("Which existing remotes are being consolidated into the Halo remote and are they compatible with Control4?")).toEqual(["home_automation"]);
    expect(systemsMentioned("Is the existing soundbar compatible with the fitness room setup?")).toEqual(["audio_video"]);
  });
});

describe("smart locks", () => {
  it("reads a residential smart lock as its own system, and card access as access control", () => {
    expect(normalizeFunctionalSystems(["smart lock"])).toEqual(["smart_locks"]);
    expect(normalizeFunctionalSystems(["Yale keypad lock on the front door"])).toEqual(["smart_locks"]);
    expect(normalizeFunctionalSystems(["Schlage deadbolt"])).toEqual(["smart_locks"]);
    expect(normalizeFunctionalSystems(["card readers for the office"])).toEqual(["access_control"]);
    expect(normalizeFunctionalSystems(["access control"])).toEqual(["access_control"]);
  });
});

describe("Control4 remotes", () => {
  it("reads Halo remotes as Control4, not lighting", () => {
    expect(normalizeFunctionalSystems(["Halo remotes"])).toEqual(["home_automation"]);
    // An amp is music through the house; electrical amps ("20 amp circuit") are not.
    expect(normalizeFunctionalSystems(["amplifier"])).toEqual(["whole_home_audio"]);
    expect(normalizeFunctionalSystems(["Sonos Amp"])).toEqual(["whole_home_audio"]);
    expect(normalizeFunctionalSystems(["20 amp outdoor circuit"])).toEqual(["20 amp outdoor circuit"]);
  });
  it("reads a Sonos soundbar as TV sound, not whole-home audio", () => {
    expect(normalizeFunctionalSystems(["Sonos Arc Ultra soundbar"])).toEqual(["audio_video"]);
    expect(normalizeFunctionalSystems(["Sonos in the kitchen"])).toEqual(["whole_home_audio"]);
  });
});

describe("add-on requests", () => {
  it("treats pure additions to an existing system as add-ons", () => {
    expect(isAddOnRequest({ requested_changes: ["Add 3 Halo remotes"] })).toBe(true);
    expect(isAddOnRequest({ requested_changes: ["Add a Sonos Port", "another amp in the den"] })).toBe(true);
  });
  it("prices replacements, new systems and anything unclear as a complete system", () => {
    expect(isAddOnRequest({ requested_changes: ["Replace the alarm panel"] })).toBe(false);
    expect(isAddOnRequest({ requested_changes: ["Add a new security system"] })).toBe(false);
    expect(isAddOnRequest({ requested_changes: ["Add whole-home audio"] })).toBe(false);
    expect(isAddOnRequest({ requested_changes: ["Add glass-break sensors", "Replace legacy panel"] })).toBe(false);
    expect(isAddOnRequest({ requested_changes: [] })).toBe(false);
  });
});

describe("generic audio and video", () => {
  it("reads bare audio and video as a TV when a TV is in scope, otherwise music", () => {
    expect(normalizeFunctionalSystems(["audio", "video"])).toEqual(["audio_video"]);
    expect(normalizeFunctionalSystems(["video"])).toEqual(["audio_video"]);
    expect(normalizeFunctionalSystems(["A/V"])).toEqual(["audio_video"]);
    expect(normalizeFunctionalSystems(["audio"])).toEqual(["whole_home_audio"]);
    expect(normalizeFunctionalSystems(["video doorbell"])).toEqual(["video_doorbell"]);
    expect(normalizeFunctionalSystems(["video surveillance"])).toEqual(["video_surveillance"]);
    expect(normalizeFunctionalSystems(["cameras", "video"])).toEqual(["audio_video", "video_surveillance"]);
    // Pilot feedback: words describing a camera are not other systems.
    expect(normalizeFunctionalSystems(["security cameras"])).toEqual(["video_surveillance"]);
    expect(normalizeFunctionalSystems(["WiFi cameras with hardwired power"])).toEqual(["video_surveillance"]);
    expect(normalizeFunctionalSystems(["floodlight camera lighting"])).toEqual(["video_surveillance"]);
    expect(normalizeFunctionalSystems(["security cameras", "alarm"])).toEqual(["intrusion_security", "video_surveillance"]);
    expect(normalizeFunctionalSystems(["Wi-Fi", "cameras"])).toEqual(["networking", "video_surveillance"]);
    expect(normalizeFunctionalSystems(["Lutron scene keypads"])).toEqual(["lighting_control"]);
  });
  it("leaves canonical names unchanged", () => {
    const canonical = ["audio_video", "video_doorbell", "video_surveillance", "whole_home_audio"];
    expect(normalizeFunctionalSystems(canonical)).toEqual(canonical);
  });
});

describe("tap-to-answer choices", () => {
  it("maps every system and service choice to exactly one canonical term", () => {
    for (const o of ANSWER_CHOICES.functional_systems!.options) expect(normalizeFunctionalSystems([o.value]), o.value).toHaveLength(1);
    for (const o of ANSWER_CHOICES.service_categories!.options) {
      const n = normalizeServiceCategories([o.value]);
      expect(n.categories, o.value).toHaveLength(1);
      expect(n.rejected).toEqual([]);
    }
  });

  it("turns each offered choice into a patch that clears its question, and refuses anything else", () => {
    const base = normalizeExtraction(
      completeExtraction({
        market: "not_provided",
        project_type: null,
        room_types: [],
        functional_systems: ["smoke detectors"],
        existing_equipment: { status: "not_provided", retained: [], removed_or_replaced: [] },
        existing_detectors: "not_provided",
        service_categories: [],
        budget: { status: "not_provided", amount_usd: null },
        target_installation_date: null,
      }),
    ).scope;
    for (const [field, choices] of Object.entries(ANSWER_CHOICES)) {
      for (const o of choices.options) {
        const patch = answerPatch(field, [o.value]);
        expect(validateClarificationPatch(patch).ok, `${field}=${o.value}`).toBe(true);
        const next = normalizeExtraction(applyClarification(base, patch!)).scope;
        expect(computeBlockers(next).map((b) => b.field), `${field}=${o.value}`).not.toContain(field);
      }
    }
    expect(answerPatch("market", ["industrial"])).toBeNull();
    expect(answerPatch("market", ["residential", "commercial"])).toBeNull();
    expect(answerPatch("client", ["Smith"])).toBeNull();
    expect(answerPatch("room_types", [])).toBeNull();
  });
});

describe("blockers and receipts", () => {
  it("treats explicit unknowns as answers", () => {
    expect(computeBlockers(completeExtraction())).toEqual([]);
  });

  it("normalizes stated quantities and shows them on the receipt", () => {
    const r = receiptFor(completeExtraction({ requested_quantities: [{ item: " Keypads ", quantity: 2 }, { item: "glass-break sensors", quantity: 3 }] }));
    expect(r.scope?.requested_quantities).toEqual([{ item: "glass-break sensors", quantity: 3 }, { item: "keypads", quantity: 2 }]);
    expect(r.lines).toContain("Stated quantities: glass-break sensors × 3; keypads × 2");
  });

  it("classifies keypads and wireless contacts as security, not networking", () => {
    expect(normalizeExtraction(completeExtraction({ functional_systems: ["keypads", "wireless contacts"] })).scope.functional_systems).toEqual(["intrusion_security"]);
  });

  it("asks whether the job is residential or commercial only when the request does not say", () => {
    expect(computeBlockers(normalizeExtraction(completeExtraction({ market: "not_provided" })).scope).map((b) => b.field)).toEqual(["market"]);
    const r = receiptFor(completeExtraction({ market: "commercial" }));
    expect(r.lines).toContain("Market: commercial");
    expect(r.scope?.market).toBe("commercial");
  });

  it("asks about existing smoke/CO detectors only when fire or CO detection is in scope", () => {
    const fire = normalizeExtraction(completeExtraction({ existing_detectors: "not_provided" })).scope;
    expect(computeBlockers(fire).map((b) => b.field)).toEqual(["existing_detectors"]);
    const security = normalizeExtraction(completeExtraction({ functional_systems: ["alarm panel"], existing_detectors: "not_provided" })).scope;
    expect(computeBlockers(security)).toEqual([]);
    const answered = receiptFor(completeExtraction({ existing_detectors: "keep_and_monitor" }));
    expect(answered.lines).toContain("Existing smoke/CO detectors: keep and monitor");
    expect(answered.scope?.existing_detectors).toBe("keep_and_monitor");
    expect(receiptFor(completeExtraction({ functional_systems: ["alarm panel"] })).scope?.existing_detectors).toBe("not_applicable");
  });

  it("asks at most three questions per turn and never offers approval while blocked", () => {
    const r = receiptFor(emptyExtraction());
    expect(r.status).toBe("NEEDS_CLARIFICATION");
    expect(r.approval_action).toBeNull();
    expect(r.scope_hash).toBeNull();
    expect(r.lines.filter((l) => /^\d\. /.test(l))).toHaveLength(3);
  });

  it("produces an approvable receipt with a stable hash and approval phrase", () => {
    const r = receiptFor();
    expect(r.status).toBe("AWAITING_APPROVAL");
    expect(r.receipt_id).toBe("R-RUN0123456-1");
    expect(r.approval_action).toBe("Approve scope R-RUN0123456-1");
    expect(r.scope_hash).toBe(hashCanonical(r.scope));
    expect(r.lines.at(-1)).toBe("To approve: Approve scope R-RUN0123456-1");
  });

  it("drops an UNASSIGNED selector but shows it on the receipt", () => {
    const r = receiptFor(completeExtraction({ proposal: { number: "unassigned", name: "Smith" } }));
    expect(r.scope!.source_quote_selector).toBeUndefined();
    expect(r.lines).toContain("Proposal: UNASSIGNED (draft)");
    const withQuote = receiptFor(completeExtraction({ proposal: { number: "P-2566", name: "Smith AV" } }));
    expect(withQuote.scope!.source_quote_selector).toEqual({ number: "P-2566", name: "Smith AV" });
  });

  it("parses the text approval form", () => {
    expect(parseApprovalText("approve scope r-run0123456-1")).toBe("R-RUN0123456-1");
    expect(parseApprovalText("Approve scope R-RUN0123456-1 please")).toBeNull();
  });
});

describe("clarification", () => {
  it("preserves supplied values and only changes what the answer covers", () => {
    const base = completeExtraction({ budget: { status: "not_provided", amount_usd: null }, target_installation_date: null });
    const patch = validateClarificationPatch({ ...noPatch, budget: { status: "known", amount_usd: 45000 } });
    expect(patch.ok).toBe(true);
    if (!patch.ok) return;
    const next = applyClarification(base, patch.value);
    expect(next.budget).toEqual({ status: "known", amount_usd: 45000 });
    expect(next.target_installation_date).toBeNull();
    expect(next.client).toBe("Smith Family");
    // An unknown install date is assumed, not asked (minimal questions).
    expect(computeBlockers(next)).toEqual([]);
  });

  it("fills only the address components supplied", () => {
    const base = completeExtraction({ property: { line1: "12 Oak Lane", city: null, region: null, postal_code: null } });
    const patch = validateClarificationPatch({ ...noPatch, property: { line1: null, city: "Richmond", region: "VA", postal_code: null } });
    if (!patch.ok) throw new Error(patch.errors.join());
    expect(applyClarification(base, patch.value).property).toEqual({ line1: "12 Oak Lane", city: "Richmond", region: "VA", postal_code: null });
  });

  it("rejects authority fields in a clarification", () => {
    expect(validateClarificationPatch({ ...noPatch, approved: true }).ok).toBe(false);
  });
});

describe("state machine and signals", () => {
  it("forbids skipping approval and leaving terminal states", () => {
    expect(canTransition("AWAITING_SCOPE_APPROVAL", "SCOPE_APPROVED")).toBe(true);
    expect(canTransition("NEEDS_CLARIFICATION", "SCOPE_APPROVED")).toBe(false);
    expect(canTransition("AUTHENTICATED_AND_CAPTURED", "PREBUILD_VERIFIED")).toBe(false);
    expect(canTransition("READY_HELD", "FAILED")).toBe(false);
    // A finished budget can only be replaced by its revision.
    expect(canTransition("READY_HELD", "SUPERSEDED")).toBe(true);
    expect(canTransition("SUPERSEDED", "READY_HELD")).toBe(false);
    expect(canTransition("COMPILED", "BLOCKED")).toBe(true);
  });

  const current = { receiptId: "R-X-2", status: "AWAITING_APPROVAL" as const, scopeHash: "sha256:abc" };

  it("accepts approval only for the latest receipt and hash", () => {
    expect(decideSignal(current, { type: "approved", receiptId: "R-X-2", scopeHash: "sha256:abc", approvalId: "a1" })).toEqual({ action: "approve", approvalId: "a1" });
    expect(decideSignal(current, { type: "approved", receiptId: "R-X-1", scopeHash: "sha256:abc", approvalId: "a1" }).action).toBe("reject");
    expect(decideSignal(current, { type: "approved", receiptId: "R-X-2", scopeHash: "sha256:zzz", approvalId: "a1" }).action).toBe("reject");
    expect(decideSignal({ ...current, status: "NEEDS_CLARIFICATION" }, { type: "approved", receiptId: "R-X-2", scopeHash: "sha256:abc", approvalId: "a1" }).action).toBe("reject");
  });
});
