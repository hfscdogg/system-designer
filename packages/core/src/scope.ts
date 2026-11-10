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

/**
 * Existing smoke/CO detectors, asked only when fire or CO detection is in scope.
 * keep_and_monitor: listen to the existing hard-wired detectors; replace/none: new wireless detectors.
 */
export const EXISTING_DETECTORS = ["none", "keep_and_monitor", "replace"] as const;

/** An explicit count the requester wrote ("2 keypads"). Never estimated. */
export const RequestedQuantitySchema = z.object({ item: z.string().min(1), quantity: z.number().int().positive() }).strict();

/**
 * One device the job involves, as the request names it, with who supplies it: one entry per device per room
 * ("Sony Bravia 7 or 9 65-inch TV", great room, 1, Livewire). Pricing counts Livewire's new devices from this
 * list and leaves the customer's out, rather than reading counts and ownership out of sentences (Henry, 2026-11-06).
 */
export const DeviceSchema = z
  .object({
    /** The device as the request names it, brand and model words included; never a count. */
    item: z.string().min(1),
    room: z.string().nullable(),
    quantity: z.number().int().positive(),
    /** livewire: Livewire sells it. customer: the customer supplies it (new or already in the home). */
    supplied_by: z.enum(["livewire", "customer"]),
    /** true: already installed in the home (kept, moved or reused); false: new to this job. */
    existing: z.boolean(),
  })
  .strict();
export type Device = z.infer<typeof DeviceSchema>;

/**
 * A quantity the rep set for one of the budget's own items by pasting the item list back with new counts
 * ("Sony K65XR70 × 2"): applied to that item as written, no interpretation (Zack, 2026-11-06). 0 removes it.
 */
export const ItemQuantitySchema = z
  .object({
    /** The item as the budget lists it: "Sony K65XR70". */
    item: z.string().min(1),
    role: z.string().min(1),
    record_id: z.string().min(1),
    quantity: z.number().int().min(0),
  })
  .strict();
export type ItemQuantity = z.infer<typeof ItemQuantitySchema>;

/** A discount off this project's price, as the requester stated it. Always needs an admin's written approval. */
export const DiscountSchema = z.object({ pct: z.number().gt(0).max(100), note: z.string() }).strict();

/** Residential or commercial; sets which margin target applies. */
export const MARKETS = ["residential", "commercial"] as const;

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

const LaborHoursSchema = z.number().positive().max(500);

export const ScopeExtractionSchema = z
  .object({
    client: z.string().nullable(),
    property: PropertySchema,
    project_type: z.string().nullable(),
    market: z.enum(["not_provided", ...MARKETS]),
    room_types: z.array(z.string()),
    functional_systems: z.array(z.string()),
    requested_changes: z.array(z.string()),
    requested_quantities: z.array(RequestedQuantitySchema),
    /** Absent on scopes extracted before 2026-11-06, which price from the sentences alone. */
    devices: z.array(DeviceSchema).optional(),
    /** Quantities set from a pasted item list in a revision; never extracted from a request. */
    item_quantities: z.array(ItemQuantitySchema).optional(),
    requested_discount: DiscountSchema.nullable(),
    existing_equipment: ExistingEquipmentSchema,
    existing_detectors: z.enum(["not_provided", ...EXISTING_DETECTORS]),
    excluded_scope: z.array(z.string()),
    service_categories: z.array(z.string()),
    size: SizeSchema.nullable(),
    budget: BudgetSchema,
    /** null = not supplied, "unknown" = explicit unknown, else YYYY-MM-DD. */
    target_installation_date: z.string().nullable(),
    proposal: z.object({ number: z.string().nullable(), name: z.string().nullable() }).strict(),
    unresolved_questions: z.array(z.string()),
    /** Total labor hours the rep set in a revision ("hours to 7"), replacing the estimate. Never extracted from a request. */
    labor_hours: LaborHoursSchema.nullable().optional(),
  })
  .strict();

/** What the model fills in from a request: everything but the rep-set labor hours. */
export const ScopeExtractionModelSchema = ScopeExtractionSchema.omit({ labor_hours: true, devices: true, item_quantities: true }).extend({ devices: z.array(DeviceSchema) });

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
    market: z.enum(MARKETS).nullable(),
    room_types: z.array(z.string()).nullable(),
    functional_systems: z.array(z.string()).nullable(),
    requested_changes: z.array(z.string()).nullable(),
    requested_quantities: z.array(RequestedQuantitySchema).nullable(),
    /** The complete device list, when the answer changes a device. Absent in patches from before it existed. */
    devices: z.array(DeviceSchema).nullable().default(null),
    requested_discount: DiscountSchema.nullable(),
    existing_equipment: ExistingEquipmentSchema.nullable(),
    existing_detectors: z.enum(EXISTING_DETECTORS).nullable(),
    excluded_scope: z.array(z.string()).nullable(),
    service_categories: z.array(z.string()).nullable(),
    size: SizeSchema.nullable(),
    size_is_unknown: z.boolean(),
    budget: BudgetSchema.nullable(),
    target_installation_date: z.string().nullable(),
    proposal: z.object({ number: z.string().nullable(), name: z.string().nullable() }).strict().nullable(),
    labor_hours: LaborHoursSchema.nullable(),
    /** The complete open-items list, when the answer adds a requested product or settles an open item. Absent in patches from before it existed. */
    unresolved_questions: z.array(z.string()).nullable().default(null),
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
    market: z.enum(MARKETS),
    room_types: z.array(z.string()).min(1),
    functional_systems: z.array(z.string()).min(1),
    requested_changes: z.array(z.string()).min(1),
    requested_quantities: z.array(RequestedQuantitySchema),
    /** Present only when the scope lists its devices; absent keeps older scopes (and their hashes) unchanged. */
    devices: z.array(DeviceSchema).optional(),
    /** Present only when a revision set quantities from a pasted item list. */
    item_quantities: z.array(ItemQuantitySchema).optional(),
    requested_discount: DiscountSchema.nullable(),
    existing_equipment_disposition: z.enum(["none", "unknown", "described"]),
    retained_equipment: z.array(z.string()),
    existing_detectors: z.enum(["not_applicable", ...EXISTING_DETECTORS]),
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
    /** Present only when the rep set the hours; absent keeps older scopes (and their hashes) unchanged. */
    labor_hours: LaborHoursSchema.optional(),
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

/**
 * The fields of a refused patch that are valid on their own. A reply that restates a whole list wrongly (a device
 * with a count of "10 ft") shouldn't discard the change it also wrote correctly (staging smoke, 2026-11-10: Jeff
 * German's "add 10' of linear lighting in the kitchen" refused twice). Null when nothing usable is left, or the
 * reply said it couldn't map the answer.
 */
export function salvageClarificationPatch(raw: unknown): { value: ClarificationPatch; dropped: string[] } | null {
  if (!raw || typeof raw !== "object" || (raw as { unmapped?: unknown }).unmapped !== false) return null;
  const fields = Object.keys(ClarificationPatchSchema.shape).filter((k) => k !== "size_is_unknown" && k !== "unmapped");
  const empty: Record<string, unknown> = { ...Object.fromEntries(fields.map((f) => [f, null])), size_is_unknown: false, unmapped: false };
  const kept: Record<string, unknown> = { ...empty };
  const dropped: string[] = [];
  for (const f of fields) {
    const v = (raw as Record<string, unknown>)[f];
    if (v === null || v === undefined) continue;
    if (validateClarificationPatch({ ...empty, [f]: v }).ok) kept[f] = v;
    else dropped.push(f);
  }
  if (!dropped.length || fields.every((f) => kept[f] === null)) return null;
  const whole = validateClarificationPatch({ ...kept, size_is_unknown: (raw as { size_is_unknown?: unknown }).size_is_unknown === true });
  return whole.ok ? { value: whole.value, dropped } : null;
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
  if (patch.market !== null) next.market = patch.market;
  if (patch.room_types !== null) next.room_types = patch.room_types;
  if (patch.functional_systems !== null) next.functional_systems = patch.functional_systems;
  if (patch.requested_changes !== null) next.requested_changes = patch.requested_changes;
  if (patch.requested_quantities !== null) next.requested_quantities = patch.requested_quantities;
  if (patch.devices !== null) next.devices = patch.devices;
  if (patch.requested_discount !== null) next.requested_discount = patch.requested_discount;
  if (patch.existing_equipment !== null) next.existing_equipment = patch.existing_equipment;
  if (patch.existing_detectors !== null) next.existing_detectors = patch.existing_detectors;
  if (patch.excluded_scope !== null) next.excluded_scope = patch.excluded_scope;
  if (patch.service_categories !== null) next.service_categories = patch.service_categories;
  if (patch.size_is_unknown) next.size = null;
  else if (patch.size !== null) next.size = patch.size;
  if (patch.budget !== null) next.budget = patch.budget;
  if (patch.target_installation_date !== null) next.target_installation_date = patch.target_installation_date;
  if (patch.labor_hours !== null) next.labor_hours = patch.labor_hours;
  if (patch.unresolved_questions !== null) next.unresolved_questions = patch.unresolved_questions;
  if (patch.proposal !== null) {
    if (patch.proposal.number !== null) next.proposal.number = patch.proposal.number;
    if (patch.proposal.name !== null) next.proposal.name = patch.proposal.name;
  }
  return next;
}

/**
 * The item lines of a pasted budget list, "• Sony K65XR70 × 2", "Sony K65XR70 x 2" or "2 x Sony K65XR70": the item as
 * written and its new count. Other lines (the total, "Proposal validated for …", "+3 more") are not items.
 */
export function parsePastedItems(text: string): Array<{ item: string; quantity: number }> {
  const out: Array<{ item: string; quantity: number }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:[•*·-]|\d+[.)])\s+/, "").trim();
    if (!line || /^(revise|revision)\b[^:]*:?\s*$/i.test(line)) continue;
    const after = /^(.+?)\s*[×x]\s*(\d+)$/i.exec(line);
    const before = /^(\d+)\s*[×x]\s+(.+)$/i.exec(line);
    const [item, n] = after ? [after[1]!, after[2]!] : before ? [before[2]!, before[1]!] : [null, null];
    if (!item || /\$|\btotal\b|\bsubtotal\b|\bhours?\b/i.test(item)) continue;
    out.push({ item: item.replace(/^(revise|revision)\s*:\s*/i, "").trim(), quantity: Number(n) });
  }
  return out;
}

