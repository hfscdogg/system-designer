import { z } from "zod";

/**
 * Scope schemas.
 *
 * ScopeExtraction is what the LLM proposes (null = not supplied). It is untrusted
 * input: parse it with validateExtraction(), never use it directly.
 *
 * ScopeDraftV1 is the PRD §8 contract. It only exists once every blocker is
 * resolved, and it is what the approval hash covers.
 */


export const PropertySchema = z
  .object({
    line1: z.string().nullable(),
    city: z.string().nullable(),
    region: z.string().nullable(),
    postal_code: z.string().nullable(),
  })
  .strict();

export const ExistingEquipmentSchema = z
  .object({
    status: z.enum(["not_provided", "none", "unknown", "described"]),
    retained: z.array(z.string()),
    removed_or_replaced: z.array(z.string()),
  })
  .strict();

export const BudgetSchema = z
  .object({
    status: z.enum(["not_provided", "unknown", "known"]),
    amount_usd: z.number().nullable(),
  })
  .strict();

export const SizeSchema = z
  .object({
    value: z.number(),
    unit: z.enum(["sqft", "sqm"]),
  })
  .strict();

export const ScopeExtractionSchema = z
  .object({
    client: z.string().nullable(),
    property: PropertySchema,
    project_type: z.string().nullable(),
    room_types: z.array(z.string()),
    functional_systems: z.array(z.string()),
    requested_changes: z.array(z.string()),
    existing_equipment: ExistingEquipmentSchema,
    excluded_scope: z.array(z.string()),
    service_categories: z.array(z.string()),
    size: SizeSchema.nullable(),
    budget: BudgetSchema,
    /** null = not supplied, "unknown" = explicit unknown, else YYYY-MM-DD. */
    target_installation_date: z.string().nullable(),
    proposal: z.object({ number: z.string().nullable(), name: z.string().nullable() }).strict(),
    unresolved_questions: z.array(z.string()),
  })
  .strict();

export type ScopeExtraction = z.infer<typeof ScopeExtractionSchema>;

/**
 * Bounded clarification update (PRD §9.5). Each field is null when the answer
 * does not change it; lists are full replacements.
 */
export const ClarificationPatchSchema = z
  .object({
    client: z.string().nullable(),
    property: PropertySchema.nullable(),
    project_type: z.string().nullable(),
    room_types: z.array(z.string()).nullable(),
    functional_systems: z.array(z.string()).nullable(),
    requested_changes: z.array(z.string()).nullable(),
    existing_equipment: ExistingEquipmentSchema.nullable(),
    excluded_scope: z.array(z.string()).nullable(),
    service_categories: z.array(z.string()).nullable(),
    size: SizeSchema.nullable(),
    size_is_unknown: z.boolean(),
    budget: BudgetSchema.nullable(),
    target_installation_date: z.string().nullable(),
    proposal: z.object({ number: z.string().nullable(), name: z.string().nullable() }).strict().nullable(),
    /** True when the answer could not be mapped to these fields. */
    unmapped: z.boolean(),
  })
  .strict();

export type ClarificationPatch = z.infer<typeof ClarificationPatchSchema>;

export const ScopeDraftV1Schema = z
  .object({
    schema: z.literal("preliminary_scope_draft_v1"),
    client: z.string().min(1),
    property: z.string().min(1),
    project_type: z.string().min(1),
    room_types: z.array(z.string()).min(1),
    functional_systems: z.array(z.string()).min(1),
    requested_changes: z.array(z.string()).min(1),
    existing_equipment_disposition: z.enum(["none", "unknown", "described"]),
    retained_equipment: z.array(z.string()),
    excluded_scope: z.array(z.string()),
    service_categories: z.array(z.string()).min(1),
    unresolved_questions: z.array(z.string()),
    size: SizeSchema.nullable(),
    budget: z.union([
      z.object({ status: z.literal("unknown") }).strict(),
      z.object({ status: z.literal("known"), amount: z.number().nonnegative(), currency: z.literal("USD") }).strict(),
    ]),
    target_installation_date: z.string(),
    source_quote_selector: z.object({ number: z.string().min(1), name: z.string().min(1) }).strict().optional(),
  })
  .strict();

export type ScopeDraftV1 = z.infer<typeof ScopeDraftV1Schema>;

/**
 * Keys that carry authority. The model may never author these, at any depth
 * (PRD §10.3). Matching is case-insensitive on the key name.
 */
export const AUTHORITY_KEYS = [
  "requester",
  "requester_id",
  "requester_email",
  "approver",
  "approval",
  "approved",
  "approved_by",
  "approval_id",
  "route",
  "space_id",
  "thread_id",
  "session",
  "session_id",
  "session_generation",
  "run_id",
  "receipt_id",
  "scope_hash",
  "state",
  "status_override",
  "price",
  "unit_price",
  "cost",
  "margin",
  "markup",
  "discount",
  "delivery",
  "deliver_to",
  "send_to",
  "recipient",
  "customer_email",
  "dtools_evidence",
  "catalog_evidence",
  "evidence",
  "quote_owner",
] as const;

export function findAuthorityFields(value: unknown, path = "$"): string[] {
  const hits: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...findAuthorityFields(v, `${path}[${i}]`)));
  } else if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if ((AUTHORITY_KEYS as readonly string[]).includes(key.toLowerCase())) hits.push(`${path}.${key}`);
      hits.push(...findAuthorityFields(v, `${path}.${key}`));
    }
  }
  return hits;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function semanticErrors(x: {
  size?: { value: number } | null;
  budget?: { status: string; amount_usd: number | null } | null;
  target_installation_date?: string | null;
}): string[] {
  const errors: string[] = [];
  if (x.size && !(x.size.value > 0)) errors.push("size must be a positive number");
  if (x.budget) {
    if (x.budget.status === "known") {
      if (x.budget.amount_usd === null || !(x.budget.amount_usd >= 0)) {
        errors.push("known budget needs a nonnegative USD amount");
      }
    } else if (x.budget.amount_usd !== null) {
      errors.push(`budget amount given with status ${x.budget.status}`);
    }
  }
  const date = x.target_installation_date;
  if (date && date !== "unknown" && !isValidIsoDate(date)) {
    errors.push(`target_installation_date "${date}" is not YYYY-MM-DD or "unknown"`);
  }
  return errors;
}

function parseStrict<T>(schema: z.ZodType<T>, raw: unknown, extra: (v: T) => string[]): Validated<T> {
  const authority = findAuthorityFields(raw);
  if (authority.length > 0) {
    return { ok: false, errors: authority.map((p) => `model-authored authority field rejected: ${p}`) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "$"}: ${i.message}`) };
  }
  const errors = extra(parsed.data);
  return errors.length ? { ok: false, errors } : { ok: true, value: parsed.data };
}

export function validateExtraction(raw: unknown): Validated<ScopeExtraction> {
  return parseStrict(ScopeExtractionSchema, raw, semanticErrors);
}

export function validateClarificationPatch(raw: unknown): Validated<ClarificationPatch> {
  return parseStrict(ClarificationPatchSchema, raw, semanticErrors);
}

/** Apply a validated patch. Fields the patch leaves null are preserved (PRD §9.1). */
export function applyClarification(base: ScopeExtraction, patch: ClarificationPatch): ScopeExtraction {
  const next: ScopeExtraction = structuredClone(base);
  if (patch.client !== null) next.client = patch.client;
  if (patch.property !== null) {
    // Only overwrite the address components the answer supplied.
    for (const k of ["line1", "city", "region", "postal_code"] as const) {
      if (patch.property[k] !== null) next.property[k] = patch.property[k];
    }
  }
  if (patch.project_type !== null) next.project_type = patch.project_type;
  if (patch.room_types !== null) next.room_types = patch.room_types;
  if (patch.functional_systems !== null) next.functional_systems = patch.functional_systems;
  if (patch.requested_changes !== null) next.requested_changes = patch.requested_changes;
  if (patch.existing_equipment !== null) next.existing_equipment = patch.existing_equipment;
  if (patch.excluded_scope !== null) next.excluded_scope = patch.excluded_scope;
  if (patch.service_categories !== null) next.service_categories = patch.service_categories;
  if (patch.size_is_unknown) next.size = null;
  else if (patch.size !== null) next.size = patch.size;
  if (patch.budget !== null) next.budget = patch.budget;
  if (patch.target_installation_date !== null) next.target_installation_date = patch.target_installation_date;
  if (patch.proposal !== null) {
    if (patch.proposal.number !== null) next.proposal.number = patch.proposal.number;
    if (patch.proposal.name !== null) next.proposal.name = patch.proposal.name;
  }
  return next;
}
