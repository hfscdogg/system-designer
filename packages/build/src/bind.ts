import type { ScopeDraftV1 } from "@sd/core";
import type { DraftLine, DraftService, ProposalDraft } from "./compile.ts";
import { sum } from "./money.ts";
import type { PolicyRecord } from "./policy.ts";

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
  rooms: string[];
  requested_changes: string[];
  pattern: { name: string; version: string };
  sections: Section[];
  services: DraftService[];
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
  };
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

  const equipment = sum(sections.map((s) => s.equipment_cents));
  const labor = sum(sections.map((s) => s.labor_cents));
  const services = sum(draft.services.map((s) => s.unit_price_cents));
  const subtotal = equipment + labor + services;

  const policy = ctx.policy?.policy;
  const tax: Proposal["commercial"]["tax"] =
    policy?.tax.mode === "rate"
      ? {
          status: "calculated",
          rate_pct: policy.tax.rate_pct,
          cents: Math.round((sum(bound.filter((l) => l.is_taxable).map((l) => l.extended_cents)) * policy.tax.rate_pct) / 100),
        }
      : { status: "tbd" };

  const verifyQuantities = bound.filter((l) => l.quantity_basis === "minimum_to_verify").map((l) => `${l.label}: ${l.verify}`);
  const complete = draft.allowances.length === 0 && draft.unresolved.length === 0 && verifyQuantities.length === 0 && tax.status === "calculated";

  const costed = [...bound.map((l) => ({ id: l.label, price: l.extended_cents, cost: l.unit_cost_cents === null ? null : l.unit_cost_cents * l.quantity })),
    ...draft.services.map((s) => ({ id: s.label, price: s.unit_price_cents, cost: s.unit_cost_cents }))];
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
    rooms: ctx.scope.room_types,
    requested_changes: ctx.scope.requested_changes,
    pattern: { name: draft.pattern, version: draft.pattern_version },
    sections,
    services: draft.services,
    requirements: draft.requirements,
    allowances: draft.allowances,
    unresolved: draft.unresolved,
    assumptions: draft.assumptions,
    exclusions: [...draft.exclusions, ...ctx.scope.excluded_scope],
    remaining_verification: [
      ...verifyQuantities,
      ...draft.unresolved.map((u) => `${u.item}: ${u.reason}`),
      ...ctx.scope.unresolved_questions,
    ],
    commercial: {
      complete,
      label: complete ? "Total" : "Priced scope to date",
      equipment_cents: equipment,
      labor_cents: labor,
      services_cents: services,
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
    },
  };
}
