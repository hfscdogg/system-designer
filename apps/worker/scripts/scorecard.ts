/**
 * Coverage and accuracy scorecard over every accepted D-Tools quote. Offline and
 * read-only, like backtest.ts: it reads a local D-Tools export and never calls
 * an API or writes to D-Tools.
 *
 *   SD_DTOOLS_DATA=<dir with quotes.json, products.json> SD_SCORECARD_OUT=<out.json> \
 *     node apps/worker/scripts/scorecard.ts
 *
 * Coverage: each quote's equipment is grouped by its D-Tools category into the
 * systems our patterns price, accessories (cable, brackets, racks: neutral), or
 * work no pattern prices (conferencing, projectors, signage …). A quote is
 * coverable when every system it needs has a pattern and uncovered equipment is
 * at most 20% of its equipment.
 *
 * Accuracy ("same scope, same answer"): each coverable quote's own device list
 * (category, name, model and count, as a rep would type it) is the request.
 * Products it names by model are priced from the catalog, as in production.
 * The budget is compared with what the customer accepted for that same scope.
 * The bar is 80% of quotes within ±20%. SD_SCORECARD_NAMED=0 turns off the
 * model lookup, for comparison.
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
  catalogIndex,
  CommercialPolicySchema,
  compile,
  findNamedProducts,
  loadPatterns,
  materialize,
  patternRecordIds,
  selectPattern,
  type AdmittedProduct,
  type CatalogEntry,
} from "@sd/build";

type Item = {
  type: string;
  category: string | null;
  name: string | null;
  model: string | null;
  quantity: number;
  unitPrice: number | null;
  unitLaborPrice: number | null;
  unitLaborTime: number | null;
  isTaxable: boolean;
  isBillable: boolean;
  isOptional: boolean;
  isClientSupplied: boolean;
  alternateSetId: number | null;
  laborItems: Array<{ time: number | null; price: number | null; isBillable: boolean }> | null;
};
type Quote = {
  number: string;
  name: string;
  state: string;
  price: number;
  isExemptFromTax: boolean;
  items: Item[];
  adjustments: Array<{ isPercent: boolean; percent: number | null; amount: number | null; isTaxable: boolean; applyTo: string }> | null;
  taxes: Array<{ id: number; rate: number }>;
  taxSettings: { taxId: number | null } | null;
};

const DATA = process.env.SD_DTOOLS_DATA;
if (!DATA) throw new Error("set SD_DTOOLS_DATA to the D-Tools export directory");
const OUT = process.env.SD_SCORECARD_OUT ?? join(DATA, "scorecard.json");
const MODE = process.env.SD_SCORECARD_MODE === "complete" ? "complete" : "add_on";
const NAMED = process.env.SD_SCORECARD_NAMED !== "0";

/** D-Tools category → the system our patterns price, "accessory" (neutral) or "uncovered:<kind>". First match wins. */
const BUCKETS: Array<[RegExp, string]> = [
  [/^(Wire and Cable|Interconnect Cables|Uncategorized|Power Distribution|Warranties|Equipment Racks|Parts|Labor)/, "accessory"],
  [/^Mounts > (Accessories|Flush Wall|Projector|Speaker)/, "accessory"],
  [/^Speakers > (Accessories|Speaker Brackets|Back Boxes)/, "accessory"],
  [/^Surveillance > Brackets/, "accessory"],
  [/^Display Devices > (TVs|Outdoor TVs|Accessories)|^Mounts > TV Mounts|^Speakers > (Soundbars|Subwoofers)|^A\/V Sources|^Amplifiers > Subwoofer/, "audio_video"],
  [/^Speakers > (In-Ceiling|In-Wall|Outdoor|Invisible|Surface|Bookshelf|Landscape)|^Amplifiers|^Distributed Audio/, "whole_home_audio"],
  [/^Networking|^Power Protection/, "networking"],
  [/^Surveillance/, "video_surveillance"],
  [/doorbell/i, "video_doorbell"],
  [/^Security Systems/, "intrusion_security"],
  [/Thermostat/, "uncovered:thermostats"],
  [/^Control Systems/, "home_automation"],
  [/^Lighting/, "lighting_control"],
  [/shade|window treatment/i, "motorized_shades"],
  [/^Access Control > Door Locks/, "smart_locks"],
  [/^Access Control/, "access_control"],
  [/^Structured Wiring/, "structured_wiring"],
  [/^(Video Conferencing|Microphones)/, "uncovered:conferencing"],
  [/^Display Devices > (Projectors|Video Walls|Monitors)|^Projection Screens|^Receivers|^Processors|^Signal Distribution/, "uncovered:theater_and_commercial_av"],
  [/^Digital Signage/, "uncovered:signage"],
  [/^Speakers > (Column Array|Stage|Portable)/, "uncovered:commercial_audio"],
  [/^Commercial Security Systems/, "uncovered:commercial_security"],
  [/^(Electrical|Electrical Fixtures)/, "uncovered:electrical"],
  [/^Furniture|^Mounts > TV Lifts/, "uncovered:furniture_and_lifts"],
];
const bucketOf = (category: string | null) => BUCKETS.find(([re]) => re.test(category ?? ""))?.[1] ?? "uncovered:other";

/**
 * D-Tools files many real devices under "Uncategorized" (Livewire's own standard
 * Alarm.com cameras among them). Their models say what they are; anything else
 * uncategorized (parts, markups) stays an accessory.
 */
const UNCATEGORIZED: Array<[RegExp, string]> = [
  [/\bADC-VDBA?-?\d/i, "Surveillance > Video Doorbells"],
  [/\bADC-V(C|-)?\d|\bcamera\b/i, "Surveillance > Cameras"],
  [/\bADC-USD-|micro ?sd/i, "Surveillance > Storage"],
  [/\bADC-C?SVR/i, "Surveillance > DVRs & NVRs"],
  [/\beero\b/i, "Networking > Wireless Access Points"],
  [/\bYRD\d|\block\b/i, "Access Control > Door Locks"],
];
const categoryOf = (i: { category: string | null; name: string | null; model: string | null }) =>
  /^Uncategorized/.test(i.category ?? "") ? (UNCATEGORIZED.find(([re]) => re.test(`${i.name ?? ""} ${i.model ?? ""}`))?.[1] ?? i.category) : i.category;

const billable = (i: Item) => i.isBillable && !i.isOptional && !i.alternateSetId && !i.isClientSupplied;

/** What the customer accepted, rebuilt from the lines (as backtest.ts). */
function actual(q: Quote) {
  let equipment = 0;
  let taxable = 0;
  let labor = 0;
  let hours = 0;
  let accessories = 0;
  for (const i of q.items.filter(billable)) {
    if (i.type === "Product") {
      const v = (i.unitPrice ?? 0) * i.quantity;
      equipment += v;
      if (bucketOf(categoryOf(i)) === "accessory") accessories += v;
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
  return { equipment, accessories, labor, hours, rebuilt: equipment + labor + adjustments + tax, price: q.price };
}

const quotes: Quote[] = JSON.parse(readFileSync(join(DATA, "quotes.json"), "utf8"))
  .map((x: { quote?: Quote }) => x.quote)
  .filter((q: Quote | undefined): q is Quote => !!q && q.state === "Accepted" && Array.isArray(q.items));
const productList = JSON.parse(readFileSync(join(DATA, "products.json"), "utf8")) as CatalogEntry[];
const products = Object.fromEntries(productList.map((p) => [p.id, p]));
const index = catalogIndex(productList);
const patterns = await loadPatterns();
const policySource = JSON.parse(readFileSync(new URL("../../../config/commercial-policy-2026.json", import.meta.url), "utf8"));
const policy = { version: 1, policy: CommercialPolicySchema.parse(policySource.policy ?? policySource) };
const reader = recordedDToolsReader(products);
const catalog = new Map<string, AdmittedProduct>();
for (const p of patterns) {
  for (const id of patternRecordIds(p)) {
    if (catalog.has(id) || !(id in products)) continue;
    const a = admitProduct(id, await reader.getProduct(id), "");
    if (a.ok) catalog.set(id, a.product);
  }
}
// Systems a pattern can price on their own (a thermostat role inside the security pattern doesn't make thermostat jobs coverable).
const priced = new Set(patterns.flatMap((p) => p.applies_when_any));

async function price(systems: string[], items: Item[]) {
  // The device counts a rep would type: each quoted device, by its category and name.
  const counts = new Map<string, number>();
  for (const i of items) {
    if (i.type !== "Product" || bucketOf(categoryOf(i)).startsWith("uncovered") || bucketOf(categoryOf(i)) === "accessory") continue;
    const text = `${(categoryOf(i) ?? "").split(" > ").at(-1)} ${i.name ?? ""} ${i.model ?? ""}`.trim();
    counts.set(text, (counts.get(text) ?? 0) + i.quantity);
  }
  const scope = {
    schema: "preliminary_scope_draft_v1",
    client: "Scorecard",
    property: "Scorecard",
    project_type: "upgrade",
    market: "residential",
    room_types: ["whole house"],
    functional_systems: systems,
    // "Add" prices only the devices named (an add-on to an existing system); "Install" a complete system.
    requested_changes: [...counts.keys()].map((t) => `${MODE === "add_on" ? "Add" : "Install"} ${t}`),
    requested_quantities: [...counts].map(([item, quantity]) => ({ item, quantity: Math.max(1, Math.round(quantity)) })),
    requested_discount: null,
    existing_equipment_disposition: "none",
    retained_equipment: [],
    existing_detectors: systems.includes("intrusion_security") ? "replace" : "not_applicable",
    excluded_scope: [],
    service_categories: ["installation", "programming", "testing"],
    unresolved_questions: [],
    size: null,
    budget: { status: "unknown" },
    target_installation_date: "unknown",
  } as unknown as ScopeDraftV1;
  const pattern = selectPattern(systems, patterns);
  if (!pattern) return { error: `no pattern for ${systems.join(", ")}` };
  // As in production: named products are admitted on demand; one that can't be admitted falls back to the standard.
  const named = NAMED ? findNamedProducts(scope, index) : [];
  for (const n of named) {
    if (catalog.has(n.record_id)) continue;
    const a = admitProduct(n.record_id, await reader.getProduct(n.record_id), "");
    if (a.ok) catalog.set(n.record_id, a.product);
  }
  const selection = materialize(scope, pattern, named.filter((n) => catalog.has(n.record_id)));
  const compiled = compile(selection, catalog, pattern);
  if (!compiled.ok) return { error: compiled.errors.join("; ").slice(0, 200) };
  const p = bind(compiled.draft, { runId: "sc", receiptId: "sc", approvalId: "sc", scopeHash: hashCanonical(scope), scope, policy, releaseId: "scorecard" });
  const c = p.commercial;
  const tax = c.tax.status === "calculated" ? c.tax.cents : 0;
  return {
    pattern: pattern.pattern,
    total: (c.total_cents ?? c.subtotal_cents + tax) / 100,
    equipment: c.equipment_cents / 100,
    labor: (c.labor_cents + c.parts_cents) / 100,
    labor_only: c.labor_cents / 100,
    parts: c.parts_cents / 100,
    hours: selection.labor?.hours ?? 0,
    add_on: selection.add_on,
    lines: selection.lines.map((l) => ({ role: l.role, quantity: l.quantity, ...(l.requested_model ? { model: l.requested_model } : {}) })),
  };
}

const rows = [];
for (const q of quotes) {
  const a = actual(q);
  const byBucket: Record<string, number> = {};
  for (const i of q.items.filter(billable)) if (i.type === "Product") byBucket[bucketOf(categoryOf(i))] = (byBucket[bucketOf(categoryOf(i))] ?? 0) + (i.unitPrice ?? 0) * i.quantity;
  const counted = Object.entries(byBucket).filter(([b]) => b !== "accessory");
  const countedTotal = counted.reduce((n, [, v]) => n + v, 0);
  const uncovered = counted.filter(([b]) => b.startsWith("uncovered")).reduce((n, [, v]) => n + v, 0);
  const systems = counted.filter(([b, v]) => !b.startsWith("uncovered") && countedTotal > 0 && v / countedTotal >= 0.1).map(([b]) => b).sort();
  const uncoveredKinds = counted.filter(([b, v]) => b.startsWith("uncovered") && countedTotal > 0 && v / countedTotal >= 0.1).map(([b]) => b.slice(10));
  const kind =
    a.equipment <= 0 ? "labor_or_service_only" : countedTotal <= 0 ? "accessories_only" : uncovered / countedTotal > 0.2 ? "uncovered" : systems.every((s) => priced.has(s)) && systems.length ? "coverable" : "uncovered";
  const explainable = a.price > 0 && Math.abs(a.rebuilt - a.price) <= Math.max(1, 0.02 * a.price);
  const ours = kind === "coverable" && explainable ? await price(systems, q.items.filter(billable)) : null;
  rows.push({
    quote: q.number,
    price: a.price,
    kind,
    systems,
    uncovered_kinds: uncoveredKinds,
    uncovered_share: countedTotal > 0 ? Math.round((uncovered / countedTotal) * 100) : null,
    ours,
    actual_hours: Math.round(a.hours * 100) / 100,
    actual: { equipment: Math.round(a.equipment), accessories: Math.round(a.accessories), labor: Math.round(a.labor) },
    error_pct: ours && "total" in ours ? Math.round((ours.total / a.price - 1) * 100) : null,
    equipment_error_pct: ours && "total" in ours && a.equipment > 0 ? Math.round((ours.equipment / a.equipment - 1) * 100) : null,
    labor_error_pct: ours && "total" in ours && a.labor > 0 ? Math.round((ours.labor / a.labor - 1) * 100) : null,
  });
}
writeFileSync(OUT, JSON.stringify(rows, null, 2));

// ---- summary ----
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "-");
const money = (rs: typeof rows) => rs.reduce((n, r) => n + r.price, 0);
const all = rows;
const design = rows.filter((r) => r.kind !== "labor_or_service_only" && r.kind !== "accessories_only");
const cov = design.filter((r) => r.kind === "coverable");
console.log(`accepted quotes: ${all.length}; with equipment to design: ${design.length} (${pct(design.length, all.length)})`);
console.log(`coverable today: ${cov.length} of ${design.length} jobs (${pct(cov.length, design.length)}), ${pct(money(cov), money(design))} of revenue`);
const errs = cov.map((r) => r.error_pct).filter((e): e is number => e !== null);
const within = (e: number[], b: number) => e.filter((x) => Math.abs(x) <= b).length;
const med = (xs: number[]) => [...xs].sort((x, y) => x - y)[xs.length >> 1] ?? NaN;
console.log(`priced: ${errs.length}; within ±20%: ${pct(within(errs, 20), errs.length)}; median |error| ${med(errs.map(Math.abs))}%; median error ${med(errs)}%`);
const group = <T,>(rs: T[], key: (r: T) => string) => {
  const g = new Map<string, T[]>();
  for (const r of rs) g.set(key(r), [...(g.get(key(r)) ?? []), r]);
  return [...g].sort((x, y) => y[1].length - x[1].length);
};
console.log("\naccuracy by job type (coverable, priced):");
for (const [k, rs] of group(cov.filter((r) => r.error_pct !== null), (r) => r.systems.join("+"))) {
  const e = rs.map((r) => r.error_pct!);
  const eq = rs.map((r) => r.equipment_error_pct).filter((x): x is number => x !== null);
  const lb = rs.map((r) => r.labor_error_pct).filter((x): x is number => x !== null);
  console.log(`  ${k.padEnd(48)} n ${String(rs.length).padStart(4)}  within±20% ${pct(within(e, 20), e.length).padStart(4)}  median ${String(med(e)).padStart(5)}%  equip ${String(med(eq)).padStart(5)}%  labor ${String(med(lb)).padStart(5)}%`);
}
console.log("\nwhy jobs are not coverable (by job count / revenue):");
const unc = design.filter((r) => r.kind !== "coverable");
for (const [k, rs] of group(unc, (r) => (r.uncovered_kinds.length ? r.uncovered_kinds.join("+") : `unpriced system: ${r.systems.filter((s) => !priced.has(s)).join("+") || "minor mix"}`)).slice(0, 15)) {
  console.log(`  ${k.padEnd(48)} n ${String(rs.length).padStart(4)}  ${pct(money(rs), money(design)).padStart(4)} of revenue`);
}
console.log("\npricing errors:", [...new Set(cov.map((r) => r.ours && "error" in r.ours ? r.ours.error.slice(0, 90) : null).filter(Boolean))].slice(0, 8));

// ---- likely-range bands (packages/build/src/budget-range.json) ----
// Where the middle half of accepted jobs landed relative to our price for the same device list, per pattern with enough history.
const RANGE_OUT = process.env.SD_SCORECARD_RANGE_OUT;
if (RANGE_OUT) {
  const quantile = (xs: number[], p: number) => [...xs].sort((x, y) => x - y)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;
  const pricedRows = cov.filter((r) => r.ours && "total" in r.ours && r.ours.total > 0);
  const band = (rs: typeof pricedRows) => {
    const ratios = rs.map((r) => r.price / (r.ours as { total: number }).total);
    return { low: Math.round(quantile(ratios, 0.25) * 100) / 100, high: Math.round(quantile(ratios, 0.75) * 100) / 100, n: rs.length };
  };
  const bands: Record<string, ReturnType<typeof band>> = { "*": band(pricedRows) };
  for (const [k, rs] of group(pricedRows, (r) => (r.ours as { pattern: string }).pattern)) if (rs.length >= 15) bands[k] = band(rs);
  const basis = `middle half (25th-75th percentile) of ${pricedRows.length} accepted D-Tools quotes, priced from their own device lists (${MODE})`;
  writeFileSync(RANGE_OUT, JSON.stringify({ schema: "budget_range_v1", basis, bands }, null, 2) + "\n");
  console.log(`\nwrote ${Object.keys(bands).length} range bands to ${RANGE_OUT}`);
}
