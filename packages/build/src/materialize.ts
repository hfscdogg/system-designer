import type { ScopeDraftV1 } from "@sd/core";
import { laborHours, type PatternSpec, type RoleSpec } from "./pattern.ts";

/**
 * Deterministic materializer (PRD §13.2): approved scope + approved pattern →
 * selection. No model call, no catalog search, no invented quantities.
 */
export type Classification = "supported" | "allowance" | "unresolved";

export interface SelectionLine {
  role: string;
  record_id: string;
  quantity: number;
  quantity_basis: "fixed" | "minimum_to_verify";
  verify: string | null;
  location: string;
  precedent: RoleSpec["precedent"];
}

export interface Selection {
  schema: "selection_v1";
  pattern: string;
  pattern_version: string;
  lines: SelectionLine[];
  services: Array<{ category: string; record_id: string; quantity: 1 }>;
  /** Project labor estimate; null when the pattern has no labor model. */
  labor: { labor_type: string; hours: number; devices: number; covers: string[] } | null;
  parts: { record_id: string } | null;
  requirements: Array<{ system: string; classification: Classification; roles: string[]; note: string }>;
  allowances: Array<{ label: string; reason: string }>;
  unresolved: Array<{ item: string; role: string | null; reason: string; escalate: boolean }>;
}

const fold = (s: string) => s.toLowerCase();

function mentioned(scope: ScopeDraftV1, terms: string[]): boolean {
  const text = fold([...scope.requested_changes, ...scope.functional_systems, ...scope.room_types].join(" | "));
  return terms.some((t) => text.includes(fold(t)));
}

export function materialize(scope: ScopeDraftV1, pattern: PatternSpec): Selection {
  const lines: SelectionLine[] = [];
  const allowances: Selection["allowances"] = [];
  const unresolved: Selection["unresolved"] = [];
  const included: RoleSpec[] = [];
  const blockedRoles = new Set<string>();

  for (const role of pattern.roles) {
    if (!role.systems.some((s) => scope.functional_systems.includes(s))) continue;
    if (role.mentions && !mentioned(scope, role.mentions)) continue;
    if (role.existing_detectors && !(role.existing_detectors as string[]).includes(scope.existing_detectors)) continue;
    included.push(role);

    const retained = role.retained_match?.length
      ? scope.retained_equipment.find((e) => role.retained_match!.some((t) => fold(e).includes(fold(t))))
      : undefined;
    if (retained) {
      // Retained equipment awaiting field testing is unresolved, not supported (PRD §12).
      unresolved.push({ item: `${role.label} (retained: ${retained})`, role: role.role, reason: "existing equipment must be field-tested before it can be reused", escalate: false });
      blockedRoles.add(role.role);
      continue;
    }
    if (!role.product_id) {
      unresolved.push({ item: role.label, role: role.role, reason: "no Livewire standard product is configured for this role", escalate: role.critical || role.escalate_if_unresolved });
      blockedRoles.add(role.role);
      continue;
    }
    const minimum = role.quantity.kind === "minimum";
    lines.push({
      role: role.role,
      record_id: role.product_id,
      quantity: role.quantity.qty,
      quantity_basis: minimum ? "minimum_to_verify" : "fixed",
      verify: role.quantity.kind === "minimum" ? role.quantity.verify : null,
      // A single-room scope places devices in that room; otherwise use the pattern's location.
      location: scope.room_types.length === 1 ? scope.room_types[0]! : role.location,
      precedent: role.precedent,
    });
  }

  const devices = lines.reduce((n, l) => n + l.quantity, 0);
  const labor: Selection["labor"] =
    pattern.labor && devices > 0
      ? { labor_type: pattern.labor.labor_type, hours: laborHours(pattern.labor, devices), devices, covers: pattern.labor.covers }
      : null;

  const services: Selection["services"] = [];
  for (const category of scope.service_categories) {
    if (labor?.covers.includes(category)) continue;
    const spec = pattern.services.find((s) => s.category === category);
    if (spec?.product_id) services.push({ category, record_id: spec.product_id, quantity: 1 });
    else allowances.push({ label: spec?.label ?? category, reason: "no authenticated price; shown as a TBD allowance outside committed totals" });
  }

  const requirements: Selection["requirements"] = scope.functional_systems.map((system) => {
    const roles = included.filter((r) => r.systems.includes(system));
    if (!roles.length) {
      unresolved.push({ item: system, role: null, reason: `not covered by the ${pattern.title} pattern`, escalate: true });
      return { system, classification: "unresolved", roles: [], note: "no approved pattern role" };
    }
    const blockedCritical = roles.filter((r) => r.critical && blockedRoles.has(r.role));
    if (blockedCritical.length) {
      return { system, classification: "unresolved", roles: roles.map((r) => r.role), note: `unresolved: ${blockedCritical.map((r) => r.label).join(", ")}` };
    }
    const priced = roles.filter((r) => !blockedRoles.has(r.role));
    return { system, classification: priced.length ? "supported" : "unresolved", roles: roles.map((r) => r.role), note: priced.map((r) => r.capability).join("; ") };
  });

  return {
    schema: "selection_v1",
    pattern: pattern.pattern,
    pattern_version: pattern.version,
    lines,
    services,
    labor,
    parts: pattern.parts && lines.length ? { record_id: pattern.parts.product_id } : null,
    requirements,
    allowances,
    unresolved,
  };
}
