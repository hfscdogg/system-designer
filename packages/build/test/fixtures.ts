import { buildReceipt, normalizeExtraction } from "@sd/core";
import { PatternSpecSchema, type PatternSpec, type PolicyRecord } from "../src/index.ts";
import { completeExtraction } from "../../core/test/fixtures.ts";

// TEST FIXTURES ONLY: synthetic D-Tools records. Not real products or prices.
export const IDS = {
  panel: "11111111-1111-4111-8111-111111111111",
  keypad: "22222222-2222-4222-8222-222222222222",
  contact: "33333333-3333-4333-8333-333333333333",
  glass: "44444444-4444-4444-8444-444444444444",
  smoke: "55555555-5555-4555-8555-555555555555",
  co: "66666666-6666-4666-8666-666666666666",
  motion: "77777777-7777-4777-8777-777777777777",
  radio: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  listener: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  thermostat: "88888888-8888-4888-8888-888888888888",
  doorbell: "99999999-9999-4999-8999-999999999999",
  install: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  programming: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  parts: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
};

export function product(id: string, brand: string, model: string, price: number, cost: number | null, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: `${brand} ${model}`,
    brand,
    model,
    shortDescription: `Test ${model}`,
    unitPrice: price,
    unitCost: cost,
    isActive: true,
    isDiscontinued: false,
    isTaxable: true,
    images: [{ url: `https://images.example.test/${model}.png`, isDefault: true }],
    laborItems: [{ laborType: "Installation", time: 30, price: 25, isBillable: true }],
    ...extra,
  };
}

export const CATALOG: Record<string, unknown> = {
  [IDS.panel]: product(IDS.panel, "TestCo", "PANEL-1", 600, 360),
  [IDS.keypad]: product(IDS.keypad, "TestCo", "KEYPAD-1", 150, 90),
  [IDS.contact]: product(IDS.contact, "TestCo", "CONTACT-1", 40, 20),
  [IDS.glass]: product(IDS.glass, "TestCo", "GLASS-1", 80, 45),
  [IDS.smoke]: product(IDS.smoke, "TestCo", "SMOKE-1", 120, 70),
  [IDS.co]: product(IDS.co, "TestCo", "CO-1", 110, 65),
  [IDS.motion]: product(IDS.motion, "TestCo", "MOTION-1", 90, 50),
  [IDS.radio]: product(IDS.radio, "TestCo", "RADIO-1", 80, 40),
  [IDS.listener]: product(IDS.listener, "TestCo", "LISTEN-1", 70, 40),
  [IDS.thermostat]: product(IDS.thermostat, "TestCo", "THERMO-1", 250, 150),
  [IDS.doorbell]: product(IDS.doorbell, "TestCo", "BELL-1", 230, 140, { images: [] }),
  [IDS.install]: product(IDS.install, "Livewire", "LAB-INSTALL", 500, 250, { laborItems: [], images: [] }),
  [IDS.programming]: product(IDS.programming, "Livewire", "LAB-PROG", 300, 120, { laborItems: [], images: [] }),
  // Mirrors the real parts record: $1 per unit with a placeholder cost.
  [IDS.parts]: product(IDS.parts, "Livewire", "PARTS", 1, 0.01, { laborItems: [], images: [] }),
};

export function testPattern(overrides: Partial<Record<keyof typeof IDS, string | null>> = {}): PatternSpec {
  const base = JSON.parse(JSON.stringify(PATTERN_JSON));
  // The shipped doorbell is its own pattern now; the pipeline tests keep one in the security fixture so their numbers stay comparable.
  base.roles.push({ role: "video_doorbell", label: "Video doorbell", critical: false, systems: ["video_doorbell"], retained_match: ["doorbell"], product_id: null, precedent: "livewire_standard", quantity: { kind: "fixed", qty: 1 }, location: "Front entry", capability: "Doorbell video in the security app", escalate_if_unresolved: false });
  const id = (k: keyof typeof IDS) => (k in overrides ? overrides[k]! : IDS[k]);
  const map: Record<string, keyof typeof IDS> = {
    security_panel: "panel", keypad: "keypad", door_window_contact: "contact", motion_detector: "motion", glass_break: "glass",
    smoke_heat_detector: "smoke", co_detector: "co", panel_345_radio: "radio", detector_listener: "listener",
    thermostat: "thermostat", video_doorbell: "doorbell",
  };
  // The pipeline tests price the core security roles; optional service roles (battery, siren) stay out of the fixture.
  base.roles = base.roles.filter((r: { role: string }) => r.role in map);
  for (const r of base.roles) r.product_id = id(map[r.role]!);
  for (const s of base.services) s.product_id = s.category === "installation" ? id("install") : s.category === "programming" ? id("programming") : null;
  if (base.parts) {
    if (id("parts")) base.parts.product_id = id("parts");
    else delete base.parts;
  }
  return PatternSpecSchema.parse(base);
}

import PATTERN_JSON from "../patterns/security_modernization.json" with { type: "json" };

export function approvedScope(overrides = {}) {
  const receipt = buildReceipt({
    runId: "run_test",
    version: 1,
    requesterPersonId: "zack",
    route: { platform: "google_chat", space_id: "s", thread_id: "t", session_generation: 1 },
    extraction: normalizeExtraction(completeExtraction(overrides)).scope,
  });
  return { scope: receipt.scope!, scopeHash: receipt.scope_hash!, receiptId: receipt.receipt_id };
}

export const POLICY: PolicyRecord = {
  version: 3,
  policy: {
    schema: "commercial_policy_v2",
    margin: { residential_min_gross_margin_pct: 30, commercial_min_gross_margin_pct: 30 },
    mix_targets: { equipment: { share_pct: 60, margin_pct: 35 }, labor: { share_pct: 30, margin_pct: 50 }, parts: { share_pct: 10, margin_pct: 60 } },
    labor_rates: [{ labor_type: "07LABOR1MAN", price_per_hour: 179, cost_per_hour: 89.5 }],
    tax: { mode: "tbd" },
  },
};
