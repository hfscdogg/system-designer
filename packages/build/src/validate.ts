import { hashCanonical, type ScopeDraftV1 } from "@sd/core";
import { PILOT_WATERMARK, type Proposal } from "./bind.ts";
import type { AdmittedProduct } from "./catalog.ts";
import type { PolicyRecord } from "./policy.ts";
import { customerView, forbiddenCustomerKeys } from "./customer.ts";
import { sum } from "./money.ts";

/**
 * Validator (PRD §13.5). Blocking findings stop the run; escalations are shown
 * to Zack and recorded but do not hide anything from the requester.
 */
export interface Finding {
  code: string;
  severity: "block" | "escalate" | "warn";
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  findings: Finding[];
}

export function validateProposal(
  p: Proposal,
  scope: ScopeDraftV1,
  scopeHash: string,
  catalog: Map<string, AdmittedProduct>,
  policy: PolicyRecord | null,
): ValidationResult {
  const f: Finding[] = [];
  const block = (code: string, message: string) => f.push({ code, severity: "block", message });

  // Identity and scope binding.
  if (hashCanonical(scope) !== scopeHash || p.identity.scope_hash !== scopeHash) block("scope_hash", "proposal is not bound to the approved scope hash");

  // Scope and architecture coverage.
  for (const system of scope.functional_systems) {
    const req = p.requirements.find((r) => r.system === system);
    if (!req) block("scope_coverage", `requested system ${system} has no requirement classification`);
    else if (req.classification === "supported") {
      const priced = p.sections.some((s) => s.lines.some((l) => req.roles.includes(l.role)));
      if (!priced) block("architecture_coverage", `${system} is marked supported without a priced role`);
    }
  }
  for (const u of p.unresolved) {
    if (u.escalate) f.push({ code: "escalation", severity: "escalate", message: `${u.item}: ${u.reason}` });
  }

  // BOM references and product provenance.
  const lines = p.sections.flatMap((s) => s.lines);
  if (lines.length === 0) {
    block("empty_bom", "no products could be priced; Livewire standard products must be configured for this pattern's roles");
  }
  for (const l of lines) {
    const product = catalog.get(l.record_id);
    if (!product) block("provenance", `${l.label} (${l.record_id}) has no admitted catalog evidence`);
    else {
      if (product.evidence.sha256 !== l.evidence_sha256) block("provenance", `${l.label} evidence hash does not match the admitted record`);
      if (product.unit_price_cents !== l.unit_price_cents || product.brand !== l.brand || product.model !== l.model) {
        block("provenance", `${l.label} price, manufacturer or model differs from D-Tools`);
      }
    }
    if (!Number.isInteger(l.quantity) || l.quantity <= 0) block("quantity", `${l.label} has an invalid quantity`);
  }
  for (const s of p.services) {
    const product = catalog.get(s.record_id);
    if (!product || product.evidence.sha256 !== s.evidence_sha256 || product.unit_price_cents !== s.unit_price_cents) {
      block("provenance", `service ${s.label} is not backed by admitted catalog evidence`);
    }
  }

  // Arithmetic reconciliation.
  for (const s of p.sections) {
    const eq = sum(s.lines.map((l) => l.unit_price_cents * l.quantity));
    const lab = sum(s.lines.map((l) => sum(l.labor.map((x) => x.unit_price_cents)) * l.quantity));
    if (eq !== s.equipment_cents || lab !== s.labor_cents || s.subtotal_cents !== eq + lab) block("arithmetic", `${s.location} subtotal does not reconcile`);
  }
  const c = p.commercial;
  const servicesTotal = sum(p.services.map((s) => s.unit_price_cents));
  if (c.equipment_cents !== sum(p.sections.map((s) => s.equipment_cents)) || c.labor_cents !== sum(p.sections.map((s) => s.labor_cents)) || c.services_cents !== servicesTotal) {
    block("arithmetic", "commercial totals do not reconcile with sections");
  }
  if (c.subtotal_cents !== c.equipment_cents + c.labor_cents + c.services_cents) block("arithmetic", "subtotal does not reconcile");

  // Commercial completeness: incomplete scope never presents a total (PRD §14.3).
  if (!c.complete && (c.total_cents !== null || c.label !== "Priced scope to date")) block("commercial", "incomplete commercial scope is presented as complete");
  if (c.complete && (p.allowances.length || p.unresolved.length || c.tax.status !== "calculated")) block("commercial", "commercial scope is marked complete but is not");

  // Margin rules: configuration, not prompts (PRD §15.4).
  if (!policy || p.internal.policy_version !== policy.version) {
    block("policy", "no commercial policy is configured; an admin must publish margin and tax rules");
  } else {
    f.push(...marginFindings(p, policy.policy.margin.minimum_gross_margin_pct));
  }
  if (p.internal.lines_without_cost.length) {
    f.push({ code: "margin_unknown", severity: "warn", message: `no D-Tools cost for: ${p.internal.lines_without_cost.join(", ")}` });
  }

  // Confidentiality and pilot safety.
  const customer = customerView(p);
  const leaked = forbiddenCustomerKeys(customer);
  if (leaked.length) block("confidentiality", `customer view exposes internal fields: ${leaked.join(", ")}`);
  if (p.mode !== "conceptual_budget" || p.watermark !== PILOT_WATERMARK) block("pilot_safety", "pilot output must be a watermarked conceptual budget");
  if (/sign|accept|authori[sz]e/i.test(JSON.stringify(customer.commercial))) block("pilot_safety", "acceptance language in commercial section");

  return { ok: !f.some((x) => x.severity === "block"), findings: f };
}

/** Margin check needs the policy itself; kept separate so the policy version is explicit. */
export function marginFindings(p: Proposal, minimumPct: number): Finding[] {
  if (p.internal.gross_margin_pct === null) return [{ code: "margin_unknown", severity: "warn", message: "no costed lines; margin unknown" }];
  if (p.internal.gross_margin_pct < minimumPct) {
    return [{ code: "margin_exception", severity: "block", message: `gross margin ${p.internal.gross_margin_pct}% is below the ${minimumPct}% minimum; needs an approved exception` }];
  }
  return [];
}
