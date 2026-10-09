import type { ScopeDraftV1 } from "@sd/core";
import type { DraftLabor, DraftLine, DraftParts, DraftService, ProposalDraft } from "./compile.ts";
import { sum } from "./money.ts";
import { minimumMarginPct, type CommercialPolicy, type PolicyRecord } from "./policy.ts";

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

export interface PricedParts extends DraftParts {
  quantity: number;
  price_cents: number;
  cost_cents: number;
  /** D-Tools carries a placeholder cost for this record, so cost comes from the policy's parts margin. */
  cost_basis: "policy_parts_margin";
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
  pattern: { name: string; version: string };
  sections: Section[];
  services: DraftService[];
  labor: PricedLabor | null;
  parts: PricedParts | null;
  requirements: ProposalDraft["requirements"];
  allowances: ProposalDraft["allowances"];
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
    /** An approved-only price reduction the requester asked for (equipment + labor + services + parts, then minus this). */
    discount: { pct: number; note: string; cents: number } | null;
    subtotal_cents: number;
    tax: { status: "tbd" } | { status: "calculated"; rate_pct: number; cents: number };
    /** Omitted (null) whenever the commercial scope is incomplete (PRD §14.3). */
    total_cents: number | null;
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

/** Parts sized so they make up the policy's parts share of the subtotal (rounded up to whole units). */
export function sizeParts(parts: DraftParts, otherCents: number, policy: CommercialPolicy): PricedParts {
  const share = policy.mix_targets.parts.share_pct / 100;
  const target = (otherCents * share) / (1 - share);
  const quantity = Math.max(1, Math.ceil(target / parts.unit_price_cents));
  const unitCost = Math.round(parts.unit_price_cents * (1 - policy.mix_targets.parts.margin_pct / 100));
  return { ...parts, quantity, price_cents: quantity * parts.unit_price_cents, cost_cents: quantity * unitCost, cost_basis: "policy_parts_margin" };
}

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
  const services = sum(draft.services.map((s) => s.unit_price_cents));
  const parts = draft.parts && policy ? sizeParts(draft.parts, equipment + labor + services, policy) : null;
  const partsCents = parts?.price_cents ?? 0;
  const gross = equipment + labor + services + partsCents;
  const discount = ctx.scope.requested_discount ? { ...ctx.scope.requested_discount, cents: Math.round((gross * ctx.scope.requested_discount.pct) / 100) } : null;
  const subtotal = gross - (discount?.cents ?? 0);
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

  const costed = [...bound.map((l) => ({ id: l.label, price: l.extended_cents, cost: l.unit_cost_cents === null ? null : l.unit_cost_cents * l.quantity })),
    ...draft.services.map((s) => ({ id: s.label, price: s.unit_price_cents, cost: s.unit_cost_cents })),
    ...(projectLabor ? [{ id: "Labor", price: projectLabor.price_cents, cost: projectLabor.cost_cents }] : []),
    ...(parts ? [{ id: parts.label, price: parts.price_cents, cost: parts.cost_cents }] : []),
    // The discount comes straight off the margin.
    ...(discount ? [{ id: "Discount", price: -discount.cents, cost: 0 }] : [])];
  const withCost = costed.filter((c) => c.cost !== null);
  const pricedWithCost = sum(withCost.map((c) => c.price));
  const cost = sum(withCost.map((c) => c.cost!));

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
    pattern: { name: draft.pattern, version: draft.pattern_version },
    sections,
    services: draft.services,
    labor: projectLabor,
    parts,
    requirements: draft.requirements,
    allowances,
    unresolved: draft.unresolved,
    assumptions: draft.assumptions,
    exclusions: [...draft.exclusions, ...ctx.scope.excluded_scope],
    remaining_verification: [
      ...verifyQuantities,
      ...(draft.labor?.extras ?? []).map((x) => `${x.label}: ${x.hours} hours included in labor`),
      ...draft.unresolved.map((u) => `${u.item}: ${u.reason}`),
      ...ctx.scope.unresolved_questions,
    ],
    commercial: {
      complete,
      label: complete ? "Total" : "Priced scope to date",
      equipment_cents: equipment,
      labor_cents: labor,
      services_cents: services,
      parts_cents: partsCents,
      discount,
      subtotal_cents: subtotal,
      tax,
      total_cents: complete && tax.status === "calculated" ? subtotal + tax.cents : null,
    },
    internal: {
      cost_cents: cost,
      priced_cents_with_cost: pricedWithCost,
      gross_margin_pct: pricedWithCost > 0 ? Math.round(((pricedWithCost - cost) / pricedWithCost) * 10000) / 100 : null,
      lines_without_cost: costed.filter((c) => c.cost === null).map((c) => c.id),
      policy_version: ctx.policy?.version ?? null,
      minimum_gross_margin_pct: policy ? minimumMarginPct(policy, ctx.scope.market) : null,
      mix: {
        equipment: categoryMix(bound.map((l) => ({ price: l.extended_cents, cost: l.unit_cost_cents === null ? null : l.unit_cost_cents * l.quantity })), subtotal),
        labor: categoryMix(projectLabor ? [{ price: projectLabor.price_cents, cost: projectLabor.cost_cents }] : [], subtotal),
        parts: categoryMix(parts ? [{ price: parts.price_cents, cost: parts.cost_cents }] : [], subtotal),
      },
    },
  };
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
