import type { ScopeExtraction } from "./scope.ts";

/**
 * Minimal questions (Henry, 2026-10-07): the goal is an 80%-right budget fast,
 * so anything that can be inferred is assumed instead of asked. Assumptions are
 * marked on the receipt; the requester corrects one by replying, and an answer
 * always wins over an assumption. The raw extraction is kept unchanged so a
 * later answer replaces the assumption rather than the other way round.
 */
export interface AssumedScope {
  scope: ScopeExtraction;
  /** Fields filled by assumption, in receipt order. */
  assumed: string[];
}

/** Services a typical budget includes when the requester names none. */
export const DEFAULT_SERVICES = ["design", "installation", "programming", "testing", "commissioning", "training"];

export const ADDRESS_TO_CONFIRM = "Address to be confirmed";

export function applyAssumptions(raw: ScopeExtraction): AssumedScope {
  const s: ScopeExtraction = structuredClone(raw);
  const assumed: string[] = [];
  const assume = (field: string, apply: () => void) => {
    apply();
    assumed.push(field);
  };
  if (!s.property.line1 || !s.property.city || !s.property.region) assumed.push("property");
  if (!s.project_type) {
    const existing = s.existing_equipment.status === "described" || s.existing_detectors === "keep_and_monitor";
    assume("project_type", () => (s.project_type = existing ? "upgrade" : "new installation"));
  }
  if (s.room_types.length === 0) assume("room_types", () => (s.room_types = ["whole house"]));
  if (s.requested_changes.length === 0 && s.functional_systems.length > 0) {
    assume("requested_changes", () => (s.requested_changes = [`budget for ${s.functional_systems.map((x) => x.replace(/_/g, " ")).join(", ")}`]));
  }
  if (s.existing_equipment.status === "not_provided") assume("existing_equipment", () => (s.existing_equipment = { status: "unknown", retained: [], removed_or_replaced: [] }));
  if (s.service_categories.length === 0) {
    assume("service_categories", () => {
      s.service_categories = [...DEFAULT_SERVICES, ...(s.functional_systems.includes("alarm_monitoring") ? ["monitoring_activation"] : [])].sort();
    });
  }
  if (s.budget.status === "not_provided") assume("budget", () => (s.budget = { status: "unknown", amount_usd: null }));
  if (s.target_installation_date === null) assume("target_installation_date", () => (s.target_installation_date = "unknown"));
  return { scope: s, assumed };
}
