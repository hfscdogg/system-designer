import { isAddOnRequest, type ScopeDraftV1 } from "@sd/core";
import { laborHoursFor, type PatternSpec, type RoleSpec } from "./pattern.ts";

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
  /** Priced as an add-on to an existing system: only the named devices, no system setup hours. */
  add_on: boolean;
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
  const text = fold([...scope.requested_changes, ...scope.requested_quantities.map((q) => q.item), ...scope.functional_systems, ...scope.room_types].join(" | "));
  return terms.some((t) => text.includes(fold(t)));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Count terms are short words ("door"), so they match whole words only: "doors" yes, "doorbell" no. */
function hasWord(text: string, term: string): boolean {
  return new RegExp(`\\b${escape(term)}(s|es)?\\b`).test(text);
}

/** Terms that identify a role in the request: its label, retained-equipment terms and mention terms. */
function roleTerms(role: RoleSpec): string[] {
  return [role.label, ...(role.retained_match ?? []), ...(role.mentions ?? [])].map(fold);
}

/** How specifically `text` names `role`: a full label beats the longest matching term; 0 when it doesn't. */
function matchScore(text: string, role: RoleSpec): number {
  const t = fold(text);
  if (t.includes(fold(role.label))) return 1000 + role.label.length;
  const terms = roleTerms(role).filter((term) => t.includes(term));
  const words = (role.count_terms ?? []).map(fold).filter((term) => hasWord(t, term));
  return Math.max(0, ...[...terms, ...words].map((term) => term.length));
}

/**
 * The requester's stated count for a role. Each stated item belongs to the one
 * role it names most specifically, so "3 Control4 Halo remotes" sets the
 * remotes, not the Control4 controller too.
 */
function statedQuantity(scope: ScopeDraftV1, role: RoleSpec, roles: RoleSpec[]): number | null {
  for (const q of scope.requested_quantities) {
    const scores = roles.map((r) => matchScore(q.item, r));
    const best = Math.max(...scores);
    if (best > 0 && roles[scores.indexOf(best)] === role) return q.quantity;
  }
  return null;
}

/** Whether the request itself names this role (its changes or a stated count), for add-on pricing. */
function named(scope: ScopeDraftV1, role: RoleSpec, roles: RoleSpec[]): boolean {
  const changes = fold(scope.requested_changes.join(" | "));
  return roleTerms(role).some((t) => changes.includes(t)) || (role.count_terms ?? []).some((t) => hasWord(changes, fold(t))) || statedQuantity(scope, role, roles) !== null;
}

export function materialize(scope: ScopeDraftV1, pattern: PatternSpec): Selection {
  const lines: SelectionLine[] = [];
  const allowances: Selection["allowances"] = [];
  const unresolved: Selection["unresolved"] = [];
  const included: RoleSpec[] = [];
  const blockedRoles = new Set<string>();

  const candidates = pattern.roles.filter((role) => role.systems.some((s) => scope.functional_systems.includes(s)));
  // An add-on prices only the devices the request names. A pattern it names nothing from (e.g. "add Wi-Fi") is priced whole.
  const addOnRequested = isAddOnRequest(scope);
  const addOn = addOnRequested && candidates.some((r) => named(scope, r, pattern.roles));

  for (const role of candidates) {
    // In an add-on, a role is priced when the request names it or names its own system (smoke detection alongside sensors).
    const ownSystemRequested = role.systems.some((s) => scope.functional_systems.includes(s) && !pattern.applies_when_any.includes(s));
    if (addOn && !named(scope, role, pattern.roles) && !ownSystemRequested) continue;
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
    // A count the requester stated is used as written; otherwise the pattern's quantity (a minimum is verified on site).
    const stated = statedQuantity(scope, role, pattern.roles);
    const minimum = stated === null && role.quantity.kind === "minimum";
    lines.push({
      role: role.role,
      record_id: role.product_id,
      quantity: stated ?? role.quantity.qty,
      quantity_basis: minimum ? "minimum_to_verify" : "fixed",
      verify: minimum && role.quantity.kind === "minimum" ? role.quantity.verify : null,
      // A single-room scope places devices in that room; otherwise use the pattern's location.
      location: scope.room_types.length === 1 ? scope.room_types[0]! : role.location,
      precedent: role.precedent,
    });
  }

  const devices = lines.reduce((n, l) => n + l.quantity, 0);
  const labor: Selection["labor"] =
    pattern.labor && devices > 0
      ? { labor_type: pattern.labor.labor_type, hours: laborHoursFor(pattern, lines, addOn), devices, covers: pattern.labor.covers }
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
    add_on: addOn,
    lines,
    services,
    labor,
    parts: pattern.parts && lines.length ? { record_id: pattern.parts.product_id } : null,
    requirements,
    allowances,
    unresolved,
  };
}
