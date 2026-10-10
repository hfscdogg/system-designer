import type { Proposal } from "./bind.ts";

/**
 * Customer-facing projection (PRD §14.1). Built field by field from an
 * allowlist, so internal cost, margin, unit and extended prices cannot leak.
 */
/** Design retainer target: this share of the budget total (Henry, 2026-10-07). */
export const DESIGN_RETAINER_PCT = 4;

/**
 * The retainer is collected through a D-Tools quote template with a fixed
 * price, so it comes in tiers (Henry, 2026-10-10): the largest tier that is
 * not more than 4% of the budget, and never less than the smallest tier.
 */
export const RETAINER_TIERS_CENTS = [10_000, 25_000, 50_000, 100_000, 250_000, 500_000] as const;

export function retainerTier(budgetCents: number): number {
  const target = (budgetCents * DESIGN_RETAINER_PCT) / 100;
  return [...RETAINER_TIERS_CENTS].reverse().find((t) => t <= target) ?? RETAINER_TIERS_CENTS[0];
}

/** The D-Tools quote template Livewire keeps for a retainer tier: "Design Retainer $250". */
export function retainerTemplateName(cents: number): string {
  return `Design Retainer $${(cents / 100).toLocaleString("en-US")}`;
}

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
    }>;
    subtotal_cents: number;
  }>;
  /** Labor and service lines; like a D-Tools proposal, only quantities per line and a section total. */
  labor_lines: Array<{ name: string; description: string; quantity: number }>;
  labor_total_cents: number;
  /** For the System Proposal introduction. */
  intro: { systems: string; rooms: string[]; labor_hours: number | null };
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
    /** Shown in the Summary as "Shipping & Handling/Parts", as Livewire's D-Tools proposals do. */
    parts_cents: number;
    /** An admin-approved price reduction, shown in the Summary. */
    reduction: { pct: number; cents: number } | null;
    /** The retainer tier for the total (or the priced scope while the total is incomplete), collected through D-Tools. */
    retainer: { cents: number };
    /** Where similar Livewire jobs landed, shown under the total. */
    likely_range: { low_cents: number; high_cents: number } | null;
  };
}

const extrasNote = (xs: Array<{ label: string; hours: number }>) => (xs.length ? `, including ${xs.map((x) => `${x.hours} h ${x.label}`).join(", ")}` : "");

export function customerView(p: Proposal): CustomerProposal {
  return {
    watermark: p.watermark,
    proposal_number: p.identity.proposal_number,
    title: p.identity.proposal_name ?? `${patternTitle(p.pattern.name)} Budget`,
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
    labor_lines: [
      ...p.services.map((s) => ({ name: s.label, description: "", quantity: 1 })),
      ...(p.labor
        ? [{ name: "Installation Labor", description: `${capitalize(labelFor(p.labor.included).replace(/^Labor: /, ""))} (estimated ${p.labor.hours} hours${extrasNote(p.labor.extras)})`, quantity: p.labor.hours }]
        : []),
    ],
    labor_total_cents: p.services.reduce((sum, s) => sum + s.unit_price_cents, 0) + (p.labor?.price_cents ?? 0),
    intro: { systems: patternTitle(p.pattern.name).toLowerCase(), rooms: p.rooms, labor_hours: p.labor?.hours ?? null },
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
      parts_cents: p.commercial.parts_cents,
      reduction: p.commercial.discount ? { pct: p.commercial.discount.pct, cents: p.commercial.discount.cents } : null,
      retainer: { cents: retainerTier(p.commercial.total_cents ?? p.commercial.subtotal_cents) },
      likely_range: p.commercial.likely_range ? { low_cents: p.commercial.likely_range.low_cents, high_cents: p.commercial.likely_range.high_cents } : null,
    },
  };
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const titleCase = (s: string) => s.split(/[_\s-]+/).filter(Boolean).map(capitalize).join(" ");
/** "security_modernization+home_network" → "Security Modernization & Home Network". */
const patternTitle = (name: string) => name.split("+").map(titleCase).join(" & ");

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
