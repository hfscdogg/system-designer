import type { ScopeDraftV1 } from "@sd/core";
import type { DraftLabor, DraftLaborAllowance, DraftLine, DraftParts, DraftService, ProposalDraft } from "./compile.ts";
import { formatUsd, sum } from "./money.ts";
import { minimumMarginPct, type CommercialPolicy, type PolicyRecord } from "./policy.ts";
import { modelWords } from "./named.ts";
import { likelyRange, type LikelyRange } from "./range.ts";

/**
 * Binder (PRD §13.4): injects authoritative identity, approved scope and
 * commercial data into the compiled draft. Every identity field comes from
 * the database records passed in, never from model output.
 */
export const PILOT_WATERMARK = "CONCEPTUAL BUDGET • NOT FOR APPROVAL";

export interface BindContext {
  runId: string;
  receiptId: string;
  approvalId: string;
  scopeHash: string;
  scope: ScopeDraftV1;
  policy: PolicyRecord | null;
  releaseId: string;
}

export interface BoundLine extends DraftLine {
  extended_cents: number;
  labor_cents: number;
}

export interface Section {
  location: string;
  lines: BoundLine[];
  equipment_cents: number;
  labor_cents: number;
  subtotal_cents: number;
}

export interface PricedLabor extends DraftLabor {
  /** The requested service categories this labor includes (what the client sees). */
  included: string[];
  price_per_hour_cents: number;
  cost_per_hour_cents: number;
  price_cents: number;
  cost_cents: number;
}

/** Out-of-pattern work priced as hours at the policy labor rate (an allowance, verified on site). */
export interface PricedLaborAllowance extends DraftLaborAllowance {
  price_per_hour_cents: number;
  price_cents: number;
  cost_cents: number;
}

export interface PricedParts extends DraftParts {
  quantity: number;
  price_cents: number;
  cost_cents: number;
  /** D-Tools carries a placeholder cost for this record, so cost comes from the policy's parts margin. */
  cost_basis: "policy_parts_margin";
  /** Design & Delivery as a share of product + labor + services, when the policy sets one. */
  pct_of_product_labor?: number;
  /** Raised above the base share to bring the budget up to the margin floor. */
  raised_for_margin?: boolean;
}

export interface Proposal {
  schema: "proposal_v1";
  mode: "conceptual_budget";
  watermark: typeof PILOT_WATERMARK;
  identity: {
    run_id: string;
    receipt_id: string;
    approval_id: string;
    scope_hash: string;
    proposal_number: string;
    proposal_name: string | null;
    release_id: string;
  };
  client: string;
  property: string;
  project_type: string;
  market: ScopeDraftV1["market"];
  rooms: string[];
  requested_changes: string[];
  /** shown: the parts of a combined pattern the budget prices, for its title (absent when it prices from all of them). */
  pattern: { name: string; version: string; shown?: string };
  sections: Section[];
  services: DraftService[];
  labor: PricedLabor | null;
  parts: PricedParts | null;
  requirements: ProposalDraft["requirements"];
  allowances: ProposalDraft["allowances"];
  /** Priced labor allowances: they count toward the total and the margin. */
  labor_allowances: PricedLaborAllowance[];
  unresolved: ProposalDraft["unresolved"];
  assumptions: string[];
  exclusions: string[];
  remaining_verification: string[];
  commercial: {
    complete: boolean;
    label: "Total" | "Priced scope to date";
    equipment_cents: number;
    labor_cents: number;
    services_cents: number;
    parts_cents: number;
    /** Labor allowances for out-of-pattern work (absent on budgets from before 2026-10-13). */
    allowances_cents?: number;
    /** An approved-only price reduction the requester asked for (equipment + labor + services + parts, then minus this). */
    discount: { pct: number; note: string; cents: number } | null;
    subtotal_cents: number;
    tax: { status: "tbd" } | { status: "calculated"; rate_pct: number; cents: number };
    /** Omitted (null) whenever the commercial scope is incomplete (PRD §14.3). */
    total_cents: number | null;
    /** Where similar accepted jobs landed (middle half), around the total or the priced scope; null when history is too thin or spread. */
    likely_range: LikelyRange | null;
  };
  internal: {
    cost_cents: number;
    priced_cents_with_cost: number;
    gross_margin_pct: number | null;
    lines_without_cost: string[];
    policy_version: number | null;
    minimum_gross_margin_pct: number | null;
    /** Share of the subtotal and margin per category, against the policy mix targets. */
    mix: Record<"equipment" | "labor" | "parts", { share_pct: number | null; margin_pct: number | null }>;
  };
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 10000) / 100 : null);

function priceLabor(labor: DraftLabor | null, policy: CommercialPolicy | undefined, requested: string[]): PricedLabor | null {
  const rate = labor && policy?.labor_rates.find((r) => r.labor_type === labor.labor_type);
  if (!labor || !rate) return null;
  const perHour = Math.round(rate.price_per_hour * 100);
  const costPerHour = Math.round(rate.cost_per_hour * 100);
  const included = labor.covers.filter((c) => requested.includes(c));
  return { ...labor, included: included.length ? included : labor.covers, price_per_hour_cents: perHour, cost_per_hour_cents: costPerHour, price_cents: Math.round(perHour * labor.hours), cost_cents: Math.round(costPerHour * labor.hours) };
}

/**
 * Parts (Design & Delivery), rounded up to whole units: `pctOfOther` percent of
 * product + labor + services when given, else the policy's parts share of the subtotal.
 */
export function sizeParts(parts: DraftParts, otherCents: number, policy: CommercialPolicy, pctOfOther?: number): PricedParts {
  const share = policy.mix_targets.parts.share_pct / 100;
  const target = pctOfOther !== undefined ? (otherCents * pctOfOther) / 100 : (otherCents * share) / (1 - share);
  const quantity = Math.max(1, Math.ceil(target / parts.unit_price_cents));
  const unitCost = Math.round(parts.unit_price_cents * (1 - policy.mix_targets.parts.margin_pct / 100));
  return {
    ...parts,
    quantity,
    price_cents: quantity * parts.unit_price_cents,
    cost_cents: quantity * unitCost,
    cost_basis: "policy_parts_margin",
    ...(pctOfOther !== undefined ? { pct_of_product_labor: pctOfOther } : {}),
  };
}

/** Design & Delivery steps up by this much at a time toward the margin floor. */
const DESIGN_DELIVERY_STEP_PCT = 0.5;

export function bind(draft: ProposalDraft, ctx: BindContext): Proposal {
  const bound: BoundLine[] = draft.lines.map((l) => ({
    ...l,
    extended_cents: l.unit_price_cents * l.quantity,
    labor_cents: sum(l.labor.map((x) => x.unit_price_cents)) * l.quantity,
  }));

  const locations = [...new Set(bound.map((l) => l.location))];
  const sections: Section[] = locations.map((location) => {
    const lines = bound.filter((l) => l.location === location);
    const equipment = sum(lines.map((l) => l.extended_cents));
    const labor = sum(lines.map((l) => l.labor_cents));
    return { location, lines, equipment_cents: equipment, labor_cents: labor, subtotal_cents: equipment + labor };
  });

  const policy = ctx.policy?.policy;
  const projectLabor = priceLabor(draft.labor, policy, ctx.scope.service_categories);
  const allowances = [...draft.allowances];
  if (draft.labor && !projectLabor) {
    allowances.push({ label: `Labor (${draft.labor.hours} hours)`, reason: "no labor rate in the commercial policy; shown as a TBD allowance outside committed totals" });
  }

  const equipment = sum(sections.map((s) => s.equipment_cents));
  const labor = sum(sections.map((s) => s.labor_cents)) + (projectLabor?.price_cents ?? 0);
  // Out-of-pattern work at the policy labor rate; without a rate it is a TBD allowance like labor.
  const laborAllowances: PricedLaborAllowance[] = [];
  for (const a of draft.labor_allowances ?? []) {
    const rate = policy?.labor_rates.find((r) => r.labor_type === a.labor_type);
    if (!rate) {
      allowances.push({ label: `${a.label} (${a.hours} hours)`, reason: "no labor rate in the commercial policy; shown as a TBD allowance outside committed totals" });
      continue;
    }
    const perHour = Math.round(rate.price_per_hour * 100);
    laborAllowances.push({ ...a, price_per_hour_cents: perHour, price_cents: Math.round(perHour * a.hours), cost_cents: Math.round(Math.round(rate.cost_per_hour * 100) * a.hours) });
  }
  const allowanceCents = sum(laborAllowances.map((a) => a.price_cents));
  const services = sum(draft.services.map((s) => s.unit_price_cents));
  const floor = policy ? minimumMarginPct(policy, ctx.scope.market) : null;
  // Everything that depends on the parts line: totals, discount and margin.
  const priceWith = (parts: PricedParts | null) => {
    const partsCents = parts?.price_cents ?? 0;
    const gross = equipment + labor + services + allowanceCents + partsCents;
    const discount = ctx.scope.requested_discount ? { ...ctx.scope.requested_discount, cents: Math.round((gross * ctx.scope.requested_discount.pct) / 100) } : null;
    const costed = [...bound.map((l) => ({ id: l.label, price: l.extended_cents, cost: l.unit_cost_cents === null ? null : l.unit_cost_cents * l.quantity })),
      ...draft.services.map((s) => ({ id: s.label, price: s.unit_price_cents, cost: s.unit_cost_cents })),
      ...(projectLabor ? [{ id: "Labor", price: projectLabor.price_cents, cost: projectLabor.cost_cents }] : []),
      ...laborAllowances.map((a) => ({ id: a.label, price: a.price_cents, cost: a.cost_cents })),
      ...(parts ? [{ id: parts.label, price: parts.price_cents, cost: parts.cost_cents }] : []),
      // The discount comes straight off the margin.
      ...(discount ? [{ id: "Discount", price: -discount.cents, cost: 0 }] : [])];
    const withCost = costed.filter((c) => c.cost !== null);
    const pricedWithCost = sum(withCost.map((c) => c.price));
    const cost = sum(withCost.map((c) => c.cost!));
    const margin = pricedWithCost > 0 ? Math.round(((pricedWithCost - cost) / pricedWithCost) * 10000) / 100 : null;
    return { parts, partsCents, gross, discount, costed, pricedWithCost, cost, margin };
  };
  // Design & Delivery starts at its base share; below the margin floor it rises, up to its cap,
  // until the budget clears the floor (Henry, 2026-10-12). Past the cap the budget waits for an admin.
  const dd = policy?.design_delivery;
  // Allowance labor is labor: Design & Delivery covers its materials too.
  const productLabor = equipment + labor + services + allowanceCents;
  let priced = priceWith(draft.parts && policy ? sizeParts(draft.parts, productLabor, policy, dd?.base_pct) : null);
  if (dd && draft.parts && policy && floor !== null && priced.margin !== null && priced.margin < floor) {
    for (let pctOf = dd.base_pct + DESIGN_DELIVERY_STEP_PCT; pctOf <= dd.max_pct + 1e-9; pctOf += DESIGN_DELIVERY_STEP_PCT) {
      priced = priceWith({ ...sizeParts(draft.parts, productLabor, policy, Math.round(pctOf * 100) / 100), raised_for_margin: true });
      if (priced.margin !== null && priced.margin >= floor) break;
    }
  }
  const { parts, partsCents, discount, costed, pricedWithCost, cost } = priced;
  const subtotal = priced.gross - (discount?.cents ?? 0);
  const keep = 1 - (discount?.pct ?? 0) / 100;
  const tax: Proposal["commercial"]["tax"] =
    policy?.tax.mode === "rate"
      ? {
          status: "calculated",
          rate_pct: policy.tax.rate_pct,
          cents: Math.round(
            ((sum(bound.filter((l) => l.is_taxable).map((l) => l.extended_cents)) + (parts?.is_taxable ? parts.price_cents : 0)) * keep * policy.tax.rate_pct) / 100,
          ),
        }
      : { status: "tbd" };

  const verifyQuantities = bound.filter((l) => l.quantity_basis === "minimum_to_verify").map((l) => `${l.label}: ${l.verify}`);
  // A conceptual budget totals with minimum quantities (they are listed to verify); TBD allowances and unresolved roles still withhold it.
  const complete = allowances.length === 0 && draft.unresolved.length === 0 && tax.status === "calculated";


  const selector = ctx.scope.source_quote_selector;
  return {
    schema: "proposal_v1",
    mode: "conceptual_budget",
    watermark: PILOT_WATERMARK,
    identity: {
      run_id: ctx.runId,
      receipt_id: ctx.receiptId,
      approval_id: ctx.approvalId,
      scope_hash: ctx.scopeHash,
      proposal_number: selector?.number ?? "UNASSIGNED",
      proposal_name: selector?.name ?? null,
      release_id: ctx.releaseId,
    },
    client: ctx.scope.client,
    property: ctx.scope.property,
    project_type: ctx.scope.project_type,
    market: ctx.scope.market,
    rooms: ctx.scope.room_types,
    requested_changes: ctx.scope.requested_changes,
    pattern: { name: draft.pattern, version: draft.pattern_version, ...(draft.title_pattern ? { shown: draft.title_pattern } : {}) },
    sections,
    services: draft.services,
    labor: projectLabor,
    parts,
    requirements: draft.requirements,
    allowances,
    labor_allowances: laborAllowances,
    unresolved: draft.unresolved,
    assumptions: draft.assumptions,
    exclusions: [...draft.exclusions, ...ctx.scope.excluded_scope],
    remaining_verification: [
      ...new Set([
        ...verifyQuantities,
        ...(draft.labor?.extras ?? []).map((x) => `${x.label}: ${x.hours} hours included in labor`),
        ...draft.unresolved.map((u) => `${u.item}: ${u.reason}`),
        ...(draft.to_verify ?? []),
        // A product the request named and the budget prices, or the client supplies, is not left to verify.
        ...ctx.scope.unresolved_questions.filter((q) => !settled(q, bound)),
      ]),
    ],
    commercial: {
      complete,
      label: complete ? "Total" : "Priced scope to date",
      equipment_cents: equipment,
      labor_cents: labor,
      services_cents: services,
      parts_cents: partsCents,
      allowances_cents: allowanceCents,
      discount,
      subtotal_cents: subtotal,
      tax,
      total_cents: complete && tax.status === "calculated" ? subtotal + tax.cents : null,
      likely_range: likelyRange(draft.pattern, complete && tax.status === "calculated" ? subtotal + tax.cents : subtotal),
    },
    internal: {
      cost_cents: cost,
      priced_cents_with_cost: pricedWithCost,
      gross_margin_pct: pricedWithCost > 0 ? Math.round(((pricedWithCost - cost) / pricedWithCost) * 10000) / 100 : null,
      lines_without_cost: costed.filter((c) => c.cost === null).map((c) => c.id),
      policy_version: ctx.policy?.version ?? null,
      minimum_gross_margin_pct: floor,
      mix: {
        equipment: categoryMix(bound.map((l) => ({ price: l.extended_cents, cost: l.unit_cost_cents === null ? null : l.unit_cost_cents * l.quantity })), subtotal),
        labor: categoryMix([...(projectLabor ? [projectLabor] : []), ...laborAllowances].map((x) => ({ price: x.price_cents, cost: x.cost_cents })), subtotal),
        parts: categoryMix(parts ? [{ price: parts.price_cents, cost: parts.cost_cents }] : [], subtotal),
      },
    },
  };
}

/** Why a budget has no total, in the words the run log uses (empty when it has one). */
export function totalWithheld(p: Proposal): string[] {
  if (p.commercial.total_cents !== null) return [];
  return [
    ...(p.commercial.tax.status === "tbd" ? ["tax TBD"] : []),
    ...p.allowances.map((a) => `TBD allowance: ${a.label}`),
    ...p.unresolved.map((u) => `unresolved: ${u.item}`),
  ];
}

/** Line items listed in the budget-ready message before "+N more". */
const READY_ITEMS = 12;

/**
 * The message the rep reads when the budget is validated: the total in plain words, or why there is
 * none, and what was priced, "Model × count" (Zack's round 3, 2026-10-13: "Total (total)" confused him).
 */
export function budgetReadyLines(p: Proposal): string[] {
  const c = p.commercial;
  const items = p.sections.flatMap((s) => s.lines.map((l) => `• ${[l.brand, l.model].filter(Boolean).join(" ")} × ${l.quantity}`));
  return [
    `Proposal validated for ${p.client}.`,
    c.total_cents !== null
      ? `Total ${formatUsd(c.total_cents)} incl. tax (subtotal ${formatUsd(c.subtotal_cents)}, tax ${c.tax.status === "calculated" ? formatUsd(c.tax.cents) : "TBD"}).`
      : `Priced so far ${formatUsd(c.subtotal_cents)} — total withheld: ${totalWithheld(p).join("; ") || "the scope is incomplete"}.`,
    c.likely_range ? `Likely range: ${formatUsd(c.likely_range.low_cents)} – ${formatUsd(c.likely_range.high_cents)} (middle half of ${c.likely_range.jobs} similar Livewire jobs).` : null,
    items.length ? ["Items:", ...items.slice(0, READY_ITEMS), ...(items.length > READY_ITEMS ? [`+${items.length - READY_ITEMS} more`] : [])].join("\n") : null,
    p.labor_allowances?.length
      ? `Allowances (verify on site): ${p.labor_allowances.map((x) => `${x.label}${x.quantity ? ` × ${x.quantity}` : ""} ${x.hours} h, ${formatUsd(x.price_cents)}`).join("; ")}.`
      : null,
    p.allowances.length ? `Allowances (TBD): ${p.allowances.map((x) => x.label).join(", ")}.` : null,
    p.remaining_verification.length ? `To verify: ${p.remaining_verification.join("; ")}.` : null,
  ].filter((x): x is string => x !== null);
}

const compactText = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const CLIENT_SUPPLIED = /\b(client|customer|owner|homeowner)[- ](supplied|provided|owned)\b/i;
const POE_SWITCH = /\bpoe\b.*\bswitch\b|\bswitch\b.*\bpoe\b/i;

/**
 * An open item the budget already settles (Zack's round 3, 2026-10-13): a requested product it prices,
 * one the client supplies, or "PoE switch or injector?" once a PoE switch is priced.
 */
function settled(question: string, lines: BoundLine[]): boolean {
  if (/poe (switch|injector)/i.test(question) && lines.some((l) => POE_SWITCH.test(`${l.label} ${l.brand} ${l.model}`))) return true;
  return pricedProduct(question, lines) || modelPicked(question, lines);
}

/** The question is which model of a device to use ("Amplifier model … not specified", "Which amplifier model?"). */
const MODEL_OPEN = /\b(model|make|brand|sku)\b.*\b(not specified|unspecified|not given|not stated|not provided|unknown|tbd)\b|\bwhich\b.*\b(model|make|brand)\b/i;

/**
 * "Amplifier model and number of zones/channels not specified" once the budget prices the amplifier: the budget
 * picked the model (Zack's Biscuit Belly job, 2026-10-23). The question's first clause must name the priced line's
 * device, by its role ("zone_amplifier": amplifier) or its brand and model.
 */
function modelPicked(question: string, lines: BoundLine[]): boolean {
  const clause = question.split(/[;:]/)[0]!.toLowerCase();
  if (!MODEL_OPEN.test(clause)) return false;
  const named = (w: string) => w.length >= 4 && new RegExp(`\\b${w}s?\\b`).test(clause);
  return lines.some((l) => [...l.role.split("_"), ...modelWords(`${l.brand} ${l.model}`)].some((w) => named(w.toLowerCase())));
}

/** Words that tell one model of a product line from another. */
const VARIANT_WORDS = new Set(["multi", "pro", "max", "mini", "ultra", "plus", "port", "sub", "duo", "lite", "playbar", "playbase", "beam", "arc"]);

/**
 * "Requested product: Araknis AN-520-AP-I" when a priced line is that product (its model, requested model or label),
 * in any word order ("Outdoor Eero PoE 7" is the eero Outdoor PoE 7), or a product the client supplies.
 */
function pricedProduct(question: string, lines: BoundLine[]): boolean {
  const m = /^requested product:\s*(.+)$/i.exec(question.trim());
  if (!m) return false;
  if (CLIENT_SUPPLIED.test(m[1]!)) return true;
  const asked = compactText(m[1]!);
  if (asked.length < 3) return false;
  const askedWords = new Set(modelWords(m[1]!));
  const within = (xs: string[], set: Set<string>) => xs.length > 0 && xs.every((x) => set.has(x));
  // A word that names another model of the line's product ("Sonos Amp Multi" is not the Sonos Amp priced;
  // Zack's Paulenich job, 2026-10-26) means the request is for something else.
  const otherModel = (l: BoundLine) => {
    const own = new Set(modelWords(`${l.brand} ${l.model} ${l.label}`));
    return [...askedWords].some((w) => VARIANT_WORDS.has(w) && !own.has(w));
  };
  return lines.some(
    (l) =>
      ([l.model, l.label].map(compactText).some((x) => x.length >= 4 && (asked.includes(x) || x.includes(asked))) && !otherModel(l)) ||
      // The line's brand and model are all named, or every word named is the line's own (two words at least).
      within(modelWords(`${l.brand} ${l.model}`), askedWords) ||
      (askedWords.size >= 2 && within([...askedWords], new Set(modelWords(`${l.brand} ${l.model} ${l.label}`)))),
  );
}

function categoryMix(items: Array<{ price: number; cost: number | null }>, subtotal: number) {
  const price = sum(items.map((i) => i.price));
  const costed = items.filter((i) => i.cost !== null);
  const costedPrice = sum(costed.map((i) => i.price));
  return {
    share_pct: pct(price, subtotal),
    margin_pct: costedPrice > 0 ? pct(costedPrice - sum(costed.map((i) => i.cost!)), costedPrice) : null,
  };
}
