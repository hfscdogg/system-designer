import { z } from "zod";
import { findAuthorityFields } from "@sd/core";
import type { AdmittedProduct } from "./catalog.ts";
import type { Selection } from "./materialize.ts";
import type { PatternSpec } from "./pattern.ts";

/**
 * Compiler (PRD §13.3): validate a selection against the admitted catalog and
 * the pattern, then produce a draft BOM. It rejects anything it cannot prove.
 */
const SelectionSchema = z
  .object({
    schema: z.literal("selection_v1"),
    pattern: z.string(),
    pattern_version: z.string(),
    lines: z.array(
      z
        .object({
          role: z.string(),
          record_id: z.string(),
          quantity: z.number().int().positive(),
          quantity_basis: z.enum(["fixed", "minimum_to_verify"]),
          verify: z.string().nullable(),
          location: z.string().min(1),
          precedent: z.enum(["livewire_standard", "accepted_comparable", "new_to_livewire"]),
        })
        .strict(),
    ),
    services: z.array(z.object({ category: z.string(), record_id: z.string(), quantity: z.literal(1) }).strict()),
    requirements: z.array(
      z.object({ system: z.string(), classification: z.enum(["supported", "allowance", "unresolved"]), roles: z.array(z.string()), note: z.string() }).strict(),
    ),
    allowances: z.array(z.object({ label: z.string(), reason: z.string() }).strict()),
    unresolved: z.array(z.object({ item: z.string(), role: z.string().nullable(), reason: z.string(), escalate: z.boolean() }).strict()),
  })
  .strict();

export interface DraftLine {
  role: string;
  label: string;
  record_id: string;
  brand: string;
  model: string;
  description: string;
  quantity: number;
  quantity_basis: "fixed" | "minimum_to_verify";
  verify: string | null;
  location: string;
  precedent: string;
  image_url: string | null;
  unit_price_cents: number;
  unit_cost_cents: number | null;
  is_taxable: boolean;
  labor: Array<{ labor_type: string; unit_price_cents: number }>;
  evidence_sha256: string;
}

export interface DraftService {
  category: string;
  record_id: string;
  label: string;
  unit_price_cents: number;
  unit_cost_cents: number | null;
  evidence_sha256: string;
}

export interface ProposalDraft {
  schema: "proposal_draft_v1";
  pattern: string;
  pattern_version: string;
  lines: DraftLine[];
  services: DraftService[];
  requirements: Selection["requirements"];
  allowances: Selection["allowances"];
  unresolved: Selection["unresolved"];
  assumptions: string[];
  exclusions: string[];
}

export type CompileResult = { ok: true; draft: ProposalDraft } | { ok: false; errors: string[] };

export function compile(raw: unknown, catalog: Map<string, AdmittedProduct>, pattern: PatternSpec): CompileResult {
  const authority = findAuthorityFields(raw);
  if (authority.length) return { ok: false, errors: authority.map((p) => `unauthorized field in selection: ${p}`) };
  const parsed = SelectionSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  const sel = parsed.data;
  const errors: string[] = [];

  if (sel.pattern !== pattern.pattern || sel.pattern_version !== pattern.version) {
    errors.push(`selection is for ${sel.pattern}@${sel.pattern_version}, expected ${pattern.pattern}@${pattern.version}`);
  }

  const roles = new Map(pattern.roles.map((r) => [r.role, r]));
  const seenRoles = new Set<string>();
  const lines: DraftLine[] = [];
  for (const line of sel.lines) {
    const role = roles.get(line.role);
    if (!role) {
      errors.push(`role ${line.role} is not in the pattern`);
      continue;
    }
    if (seenRoles.has(line.role)) errors.push(`role ${line.role} appears twice`);
    seenRoles.add(line.role);
    if (role.product_id !== line.record_id) errors.push(`role ${line.role} must use its approved record ${role.product_id}, not ${line.record_id}`);
    const product = catalog.get(line.record_id);
    if (!product) {
      errors.push(`record ${line.record_id} for ${line.role} has no admitted D-Tools evidence in this run`);
      continue;
    }
    lines.push({
      role: line.role,
      label: role.label,
      record_id: product.record_id,
      brand: product.brand,
      model: product.model,
      description: product.description,
      quantity: line.quantity,
      quantity_basis: line.quantity_basis,
      verify: line.verify,
      location: line.location,
      precedent: line.precedent,
      image_url: product.image_url,
      unit_price_cents: product.unit_price_cents,
      unit_cost_cents: product.unit_cost_cents,
      is_taxable: product.is_taxable,
      labor: product.labor,
      evidence_sha256: product.evidence.sha256,
    });
  }

  const services: DraftService[] = [];
  for (const s of sel.services) {
    const spec = pattern.services.find((x) => x.category === s.category);
    if (!spec || spec.product_id !== s.record_id) {
      errors.push(`service ${s.category} does not use its approved record`);
      continue;
    }
    const product = catalog.get(s.record_id);
    if (!product) {
      errors.push(`service record ${s.record_id} has no admitted D-Tools evidence in this run`);
      continue;
    }
    services.push({
      category: s.category,
      record_id: product.record_id,
      label: spec.label,
      unit_price_cents: product.unit_price_cents,
      unit_cost_cents: product.unit_cost_cents,
      evidence_sha256: product.evidence.sha256,
    });
  }

  // Critical role coverage: every critical role the selection implies is priced or explicitly unresolved.
  for (const req of sel.requirements) {
    for (const roleName of req.roles) {
      const role = roles.get(roleName);
      if (!role) {
        errors.push(`requirement ${req.system} names unknown role ${roleName}`);
        continue;
      }
      const accounted = seenRoles.has(roleName) || sel.unresolved.some((u) => u.role === roleName);
      if (role.critical && !accounted) errors.push(`critical role ${role.label} for ${req.system} is neither priced nor unresolved`);
    }
    if (req.classification === "supported" && !req.roles.some((r) => seenRoles.has(r))) {
      errors.push(`${req.system} is marked supported but has no priced role`);
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    draft: {
      schema: "proposal_draft_v1",
      pattern: sel.pattern,
      pattern_version: sel.pattern_version,
      lines,
      services,
      requirements: sel.requirements,
      allowances: sel.allowances,
      unresolved: sel.unresolved,
      assumptions: pattern.assumptions,
      exclusions: pattern.exclusions,
    },
  };
}
