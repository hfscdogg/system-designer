import type { Proposal } from "./bind.ts";

/**
 * Customer-facing projection (PRD §14.1). Built field by field from an
 * allowlist, so internal cost, margin, unit and extended prices cannot leak.
 */
/** Design retainer shown in Payment Terms: this share of the budget total (Henry, 2026-10-07). */
export const DESIGN_RETAINER_PCT = 4;

export interface CustomerProposal {
  watermark: string;
  proposal_number: string;
  /** Cover title, like a D-Tools quote name. */
  title: string;
  client: string;
  property: string;
  project_type: string;
  sections: Array<{
    location: string;
    items: Array<{
      manufacturer: string;
      model: string;
      description: string;
      quantity: number;
      quantity_note: string | null;
      image: { url: string } | { pending: true };
      /** Sell prices, as a D-Tools proposal shows them. */
      unit_price_cents: number;
      total_cents: number;
    }>;
    subtotal_cents: number;
  }>;
  /** Labor, parts and service lines, priced like the equipment lines. */
  labor_lines: Array<{ name: string; description: string; quantity: number; unit_price_cents: number; total_cents: number }>;
  services: string[];
  allowances: Array<{ label: string; note: string }>;
  assumptions: string[];
  exclusions: string[];
  remaining_verification: string[];
  commercial: {
    label: string;
    subtotal_cents: number;
    tax: "TBD" | { rate_pct: number; cents: number };
    total_cents: number | null;
    /** DESIGN_RETAINER_PCT of the total, or of the priced scope while the total is incomplete. */
    retainer: { pct: number; cents: number };
  };
}

export function customerView(p: Proposal): CustomerProposal {
  return {
    watermark: p.watermark,
    proposal_number: p.identity.proposal_number,
    title: p.identity.proposal_name ?? `${titleCase(p.pattern.name)} Budget`,
    client: p.client,
    property: p.property,
    project_type: p.project_type,
    sections: p.sections.map((s) => ({
      location: s.location,
      items: s.lines.map((l) => ({
        manufacturer: l.brand,
        model: l.model,
        description: l.description,
        quantity: l.quantity,
        quantity_note: l.quantity_basis === "minimum_to_verify" ? `Minimum; ${l.verify}` : null,
        image: l.image_url ? { url: l.image_url } : { pending: true as const },
        unit_price_cents: l.unit_price_cents,
        total_cents: l.extended_cents,
      })),
      subtotal_cents: s.subtotal_cents,
    })),
    labor_lines: [
      ...p.services.map((s) => ({ name: s.label, description: "", quantity: 1, unit_price_cents: s.unit_price_cents, total_cents: s.unit_price_cents })),
      ...(p.labor
        ? [
            {
              name: "Installation Labor",
              description: `${capitalize(labelFor(p.labor.included).replace(/^Labor: /, ""))} (estimated ${p.labor.hours} hours)`,
              quantity: p.labor.hours,
              unit_price_cents: p.labor.price_per_hour_cents,
              total_cents: p.labor.price_cents,
            },
          ]
        : []),
      ...(p.parts
        ? [{ name: p.parts.label, description: "Wire, connectors, mounting hardware and consumables", quantity: p.parts.quantity, unit_price_cents: p.parts.unit_price_cents, total_cents: p.parts.price_cents }]
        : []),
    ],
    services: [
      ...p.services.map((s) => s.label),
      ...(p.labor ? [`${labelFor(p.labor.included)} (estimated ${p.labor.hours} hours)`] : []),
      ...(p.parts ? [p.parts.label] : []),
    ],
    allowances: p.allowances.map((a) => ({ label: a.label, note: "Allowance — TBD, not included in totals" })),
    assumptions: p.assumptions,
    exclusions: p.exclusions,
    remaining_verification: p.remaining_verification,
    commercial: {
      label: p.commercial.label,
      subtotal_cents: p.commercial.subtotal_cents,
      tax: p.commercial.tax.status === "calculated" ? { rate_pct: p.commercial.tax.rate_pct, cents: p.commercial.tax.cents } : "TBD",
      total_cents: p.commercial.total_cents,
      retainer: {
        pct: DESIGN_RETAINER_PCT,
        cents: Math.round(((p.commercial.total_cents ?? p.commercial.subtotal_cents) * DESIGN_RETAINER_PCT) / 100),
      },
    },
  };
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const titleCase = (s: string) => s.split(/[_\s-]+/).filter(Boolean).map(capitalize).join(" ");

const SERVICE_NAMES: Record<string, string> = {
  design: "design",
  removal: "removal",
  installation: "installation",
  programming: "programming",
  testing: "testing",
  commissioning: "commissioning",
  monitoring_activation: "monitoring activation",
  training: "client training",
  project_management: "project management",
};

function labelFor(covers: string[]): string {
  const names = covers.map((c) => SERVICE_NAMES[c] ?? c.replace(/_/g, " "));
  const text = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]!;
  return `Labor: ${text}`;
}

// Sell prices per line are shown, as on a D-Tools proposal; cost and margin never are.
const FORBIDDEN_KEY = /(cost|margin|markup|commission|extended|internal|discount|record_id|evidence|approval)/i;

/** Keys in a customer document that must never appear (defense in depth for the validator). */
export function forbiddenCustomerKeys(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenCustomerKeys(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => [...(FORBIDDEN_KEY.test(k) ? [`${path}.${k}`] : []), ...forbiddenCustomerKeys(v, `${path}.${k}`)]);
  }
  return [];
}
