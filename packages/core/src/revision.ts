import { canonicalJson } from "./canonical.ts";
import type { ScopeExtraction } from "./scope.ts";

/**
 * What a revision changed, in plain words, for the receipt's "Changed:" line.
 * Compares the approved scope a revision starts from with the revised one.
 */
export function describeScopeChanges(before: ScopeExtraction, after: ScopeExtraction): string[] {
  const out: string[] = [];
  // Canonical JSON: a scope read back from the database may list its keys in a different order.
  const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
  const list = (label: string, a: string[], b: string[]) => {
    const added = b.filter((x) => !a.includes(x));
    const removed = a.filter((x) => !b.includes(x));
    if (added.length) out.push(`${label} added: ${added.join("; ")}`);
    if (removed.length) out.push(`${label} removed: ${removed.join("; ")}`);
  };
  const value = (label: string, a: unknown, b: unknown, show: (v: never) => string = (v) => String(v ?? "none")) => {
    if (!same(a, b)) out.push(`${label}: ${show(a as never)} → ${show(b as never)}`);
  };

  value("Client", before.client, after.client);
  if (!same(before.property, after.property)) out.push("Property address changed");
  value("Market", before.market, after.market);
  list("Systems", before.functional_systems, after.functional_systems);
  list("Requested", before.requested_changes, after.requested_changes);
  list("Rooms", before.room_types, after.room_types);
  const qty = (s: ScopeExtraction) => new Map(s.requested_quantities.map((q) => [q.item, q.quantity]));
  const [qa, qb] = [qty(before), qty(after)];
  for (const [item, n] of qb) if (qa.get(item) !== n) out.push(`${item}: ${qa.get(item) ?? "none"} → ${n}`);
  for (const [item, n] of qa) if (!qb.has(item)) out.push(`${item}: ${n} → none`);
  value("Discount", before.requested_discount?.pct ?? null, after.requested_discount?.pct ?? null, (v: number | null) => (v === null ? "none" : `${v}%`));
  list("Kept equipment", before.existing_equipment.retained, after.existing_equipment.retained);
  value("Existing detectors", before.existing_detectors, after.existing_detectors);
  list("Excluded", before.excluded_scope, after.excluded_scope);
  value("Budget", before.budget.amount_usd, after.budget.amount_usd, (v: number | null) => (v === null ? "unknown" : `$${v.toLocaleString("en-US")}`));
  value("Target install", before.target_installation_date, after.target_installation_date);
  return out;
}
