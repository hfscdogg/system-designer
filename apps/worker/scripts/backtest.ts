/**
 * Backtest: price past accepted D-Tools quotes with System Designer's patterns
 * and compare against what Livewire actually sold. Offline and read-only: it
 * reads a local D-Tools export and never calls an API or writes to D-Tools.
 *
 *   SD_DTOOLS_DATA=<dir with quotes.json, products.json> SD_BACKTEST_OUT=<out.json> \
 *     node apps/worker/scripts/backtest.ts
 *
 * Customer data stays in that directory; nothing from it is committed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashCanonical, type ScopeDraftV1 } from "@sd/core";
import { recordedDToolsReader } from "@sd/dtools";
import {
  admitProduct,
  bind,
  CommercialPolicySchema,
  compile,
  customerView,
  loadPatterns,
  materialize,
  patternRecordIds,
  selectPattern,
  type AdmittedProduct,
  type PatternSpec,
  type RoleSpec,
} from "@sd/build";

type Item = {
  type: string;
  catalogId: string | null;
  quantity: number;
  unitPrice: number | null;
  unitLaborPrice: number | null;
  unitLaborTime: number | null;
  isTaxable: boolean;
  isBillable: boolean;
  isOptional: boolean;
  isClientSupplied: boolean;
  alternateSetId: number | null;
  location: string | null;
  laborItems: Array<{ time: number | null; price: number | null; isBillable: boolean }> | null;
};
type Quote = {
  number: string;
  name: string;
  state: string;
  price: number;
  isExemptFromTax: boolean;
  items: Item[];
  adjustments: Array<{ name: string; isPercent: boolean; percent: number | null; amount: number | null; isTaxable: boolean; applyTo: string }> | null;
  taxes: Array<{ id: number; rate: number }>;
  taxSettings: { taxId: number | null } | null;
};

const DATA = process.env.SD_DTOOLS_DATA;
if (!DATA) throw new Error("set SD_DTOOLS_DATA to the D-Tools export directory");
const OUT = process.env.SD_BACKTEST_OUT ?? join(DATA, "backtest.json");
const MIN_COVERAGE = Number(process.env.SD_MIN_COVERAGE ?? 0.75);

/** What the customer paid, rebuilt from the quote's lines so it can be split into equipment, labor and adjustments. */
function actual(q: Quote) {
  const items = q.items.filter((i) => i.isBillable && !i.isOptional && !i.alternateSetId && !i.isClientSupplied);
  let equipment = 0;
  let taxable = 0;
  let labor = 0;
  let hours = 0;
  for (const i of items) {
    if (i.type === "Product") {
      const v = (i.unitPrice ?? 0) * i.quantity;
      equipment += v;
      if (i.isTaxable) taxable += v;
    }
    if (i.unitLaborPrice) {
      labor += i.unitLaborPrice * i.quantity;
      hours += ((i.unitLaborTime ?? 0) * i.quantity) / 3600;
    } else {
      for (const li of i.laborItems ?? []) {
        if (!li.isBillable) continue;
        labor += (li.price ?? 0) * i.quantity;
        hours += ((li.time ?? 0) * i.quantity) / 3600;
      }
    }
  }
  let adjustments = 0;
  let adjTaxable = 0;
  for (const a of q.adjustments ?? []) {
    const base = a.applyTo === "Product" ? equipment : a.applyTo === "Labor" ? labor : equipment + labor;
    const v = a.isPercent ? base * (a.percent ?? 0) : (a.amount ?? 0);
    adjustments += v;
    if (a.isTaxable) adjTaxable += v;
  }
  const rate = q.taxes.find((t) => t.id === q.taxSettings?.taxId)?.rate ?? 0;
  const tax = q.isExemptFromTax ? 0 : (taxable + adjTaxable) * rate;
  return { equipment, labor, hours, adjustments, tax, rebuilt: equipment + labor + adjustments + tax, price: q.price };
}

const quotes: Quote[] = JSON.parse(readFileSync(join(DATA, "quotes.json"), "utf8"))
  .map((x: { quote?: Quote }) => x.quote)
  .filter((q: Quote | undefined): q is Quote => !!q && q.state === "Accepted" && Array.isArray(q.items));
const productList: Array<{ id: string }> = JSON.parse(readFileSync(join(DATA, "products.json"), "utf8"));
const products = Object.fromEntries(productList.map((p) => [p.id, p]));

const patterns = await loadPatterns();
const policySource = JSON.parse(readFileSync(new URL("../../../config/commercial-policy-2026.json", import.meta.url), "utf8"));
const policy = { version: 1, policy: CommercialPolicySchema.parse(policySource.policy ?? policySource) };

const roleById = new Map<string, { pattern: PatternSpec; role: RoleSpec }>();
for (const p of patterns) for (const r of p.roles) if (r.product_id) roleById.set(r.product_id, { pattern: p, role: r });

const reader = recordedDToolsReader(products);
const catalog = new Map<string, AdmittedProduct>();
for (const p of patterns) {
  for (const id of patternRecordIds(p)) {
    if (catalog.has(id) || !(id in products)) continue;
    const a = admitProduct(id, await reader.getProduct(id), "");
    if (a.ok) catalog.set(id, a.product);
  }
}

/** with_counts: a complete system with the quote's counts; quick: no counts; add_on: "Add …" each quoted device. */
type Mode = "with_counts" | "quick" | "add_on";

function scopeFor(q: Quote, roles: Map<string, { role: RoleSpec; qty: number }>, mode: Mode): ScopeDraftV1 {
  const matched = [...roles.values()];
  const systems = new Set<string>();
  for (const { role } of matched) for (const s of role.systems) systems.add(s);
  const changes = matched.map(({ role }) => (mode === "add_on" ? "Add " : "") + (role.mentions?.[0] ? `${role.label} (${role.mentions[0]})` : role.label));
  const hasDetectors = matched.some(({ role }) => role.existing_detectors);
  const usesListener = matched.some(({ role }) => role.existing_detectors?.includes("keep_and_monitor") && !role.existing_detectors.includes("replace"));
  const rooms = [...new Set(q.items.map((i) => i.location).filter((l): l is string => !!l))];
  return {
    schema: "preliminary_scope_draft_v1",
    client: "Backtest",
    property: "Backtest",
    project_type: "upgrade",
    market: "residential",
    room_types: rooms.length ? rooms : ["whole house"],
    functional_systems: [...systems].sort(),
    requested_changes: changes,
    requested_quantities: mode !== "quick" ? matched.map(({ role, qty }) => ({ item: role.label, quantity: Math.max(1, Math.round(qty)) })) : [],
    requested_discount: null,
    existing_equipment_disposition: "none",
    retained_equipment: [],
    existing_detectors: usesListener ? "keep_and_monitor" : hasDetectors ? "replace" : "not_applicable",
    excluded_scope: [],
    service_categories: ["installation", "programming", "testing"],
    unresolved_questions: [],
    size: null,
    budget: { status: "unknown" },
    target_installation_date: "unknown",
  };
}

function price(scope: ScopeDraftV1) {
  const pattern = selectPattern(scope.functional_systems, patterns);
  if (!pattern) return { error: `no pattern for ${scope.functional_systems.join(", ")}` };
  const compiled = compile(materialize(scope, pattern), catalog, pattern);
  if (!compiled.ok) return { error: compiled.errors.join("; ") };
  const p = bind(compiled.draft, { runId: "bt", receiptId: "bt", approvalId: "bt", scopeHash: hashCanonical(scope), scope, policy, releaseId: "backtest" });
  const c = p.commercial;
  const tax = c.tax.status === "calculated" ? c.tax.cents : 0;
  const total = (c.total_cents ?? c.subtotal_cents + tax) / 100;
  return {
    pattern: pattern.pattern,
    equipment: c.equipment_cents / 100,
    labor: c.labor_cents / 100,
    hours: p.labor?.hours ?? null,
    parts: c.parts_cents / 100,
    tax: tax / 100,
    total,
    retainer: customerView(p).commercial.retainer.cents / 100,
    unresolved: compiled.draft.unresolved.map((u) => u.item),
    lines: p.sections.flatMap((s) => s.lines.map((l) => `${l.role}×${l.quantity}@${l.unit_price_cents / 100}`)),
  };
}

const rows = [];
for (const q of quotes) {
  const a = actual(q);
  if (a.price <= 0 || Math.abs(a.rebuilt - a.price) > Math.max(1, 0.02 * a.price)) continue; // only quotes whose total we can explain
  const roles = new Map<string, { role: RoleSpec; qty: number }>();
  let patternEquipment = 0;
  for (const i of q.items) {
    if (i.type !== "Product" || !i.isBillable || i.isOptional || i.alternateSetId || !i.catalogId) continue;
    const hit = roleById.get(i.catalogId);
    if (!hit) continue;
    patternEquipment += (i.unitPrice ?? 0) * i.quantity;
    const prev = roles.get(hit.role.role + hit.pattern.pattern);
    roles.set(hit.role.role + hit.pattern.pattern, { role: hit.role, qty: (prev?.qty ?? 0) + i.quantity });
  }
  const coverage = a.equipment > 0 ? patternEquipment / a.equipment : 0;
  if (!roles.size || coverage < MIN_COVERAGE || coverage > 1.01) continue;
  rows.push({
    quote: q.number,
    name: q.name,
    coverage: Math.round(coverage * 100),
    actual: { equipment: a.equipment, labor: a.labor, hours: Math.round(a.hours * 10) / 10, adjustments: a.adjustments, tax: a.tax, total: a.price },
    roles: [...roles.values()].map(({ role, qty }) => `${role.role}×${qty}`),
    with_counts: price(scopeFor(q, roles, "with_counts")),
    quick: price(scopeFor(q, roles, "quick")),
    add_on: price(scopeFor(q, roles, "add_on")),
  });
}

writeFileSync(OUT, JSON.stringify(rows, null, 2));
console.log(`${rows.length} quotes priced → ${OUT}`);
