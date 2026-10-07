import type { Proposal } from "./bind.ts";

/**
 * Customer-facing projection (PRD §14.1). Built field by field from an
 * allowlist, so internal cost, margin, unit and extended prices cannot leak.
 */
export interface CustomerProposal {
  watermark: string;
  proposal_number: string;
  client: string;
  property: string;
  project_type: string;
  sections: Array<{
    location: string;
    items: Array<{ manufacturer: string; model: string; description: string; quantity: number; quantity_note: string | null; image: { url: string } | { pending: true } }>;
    subtotal_cents: number;
  }>;
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
  };
}

export function customerView(p: Proposal): CustomerProposal {
  return {
    watermark: p.watermark,
    proposal_number: p.identity.proposal_number,
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
      })),
      subtotal_cents: s.subtotal_cents,
    })),
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
    },
  };
}

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

const FORBIDDEN_KEY = /(cost|margin|markup|commission|unit_price|extended|internal|discount|record_id|evidence|approval)/i;

/** Keys in a customer document that must never appear (defense in depth for the validator). */
export function forbiddenCustomerKeys(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenCustomerKeys(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => [...(FORBIDDEN_KEY.test(k) ? [`${path}.${k}`] : []), ...forbiddenCustomerKeys(v, `${path}.${k}`)]);
  }
  return [];
}
