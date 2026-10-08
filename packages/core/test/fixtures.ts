import type { ScopeExtraction } from "../src/index.ts";

export function completeExtraction(overrides: Partial<ScopeExtraction> = {}): ScopeExtraction {
  return {
    client: "Smith Family",
    property: { line1: "12 Oak Lane", city: "Richmond", region: "VA", postal_code: "23220" },
    project_type: "Security modernization",
    market: "residential",
    room_types: ["Whole house"],
    functional_systems: ["alarm panel", "smoke detectors", "CO detectors", "thermostats", "video doorbell", "Alarm.com monitoring"],
    requested_changes: ["Replace legacy panel and keypads", "Add glass-break sensors"],
    requested_quantities: [],
    requested_discount: null,
    existing_equipment: { status: "described", retained: ["Door contacts"], removed_or_replaced: ["Legacy panel"] },
    existing_detectors: "replace",
    excluded_scope: [],
    service_categories: ["Installation", "Programming", "Testing and commissioning"],
    size: null,
    budget: { status: "unknown", amount_usd: null },
    target_installation_date: "unknown",
    proposal: { number: null, name: null },
    unresolved_questions: [],
    ...overrides,
  };
}

export function emptyExtraction(): ScopeExtraction {
  return {
    client: null,
    property: { line1: null, city: null, region: null, postal_code: null },
    project_type: null,
    market: "not_provided",
    room_types: [],
    functional_systems: [],
    requested_changes: [],
    requested_quantities: [],
    requested_discount: null,
    existing_equipment: { status: "not_provided", retained: [], removed_or_replaced: [] },
    existing_detectors: "not_provided",
    excluded_scope: [],
    service_categories: [],
    size: null,
    budget: { status: "not_provided", amount_usd: null },
    target_installation_date: null,
    proposal: { number: null, name: null },
    unresolved_questions: [],
  };
}

export const noPatch = {
  client: null,
  property: null,
  project_type: null,
  market: null,
  room_types: null,
  functional_systems: null,
  requested_changes: null,
  requested_quantities: null,
  requested_discount: null,
  existing_equipment: null,
  existing_detectors: null,
  excluded_scope: null,
  service_categories: null,
  size: null,
  size_is_unknown: false,
  budget: null,
  target_installation_date: null,
  proposal: null,
  unmapped: false,
};
