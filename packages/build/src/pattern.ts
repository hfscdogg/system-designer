import { EXISTING_DETECTORS } from "@sd/core";
import { z } from "zod";

/**
 * An approved architecture pattern (PRD §12): which roles a system needs, the
 * Livewire-standard D-Tools record for each role, and how quantities are set.
 * Patterns are configuration reviewed by Livewire, not model output.
 */
export const RoleSpecSchema = z
  .object({
    role: z.string().min(1),
    label: z.string().min(1),
    /** Critical roles must be priced or explicitly unresolved; never silently missing. */
    critical: z.boolean(),
    /** Canonical functional systems this role serves (see @sd/core normalize). */
    systems: z.array(z.string()).min(1),
    /** If set, include the role only when the request mentions one of these terms. */
    mentions: z.array(z.string()).optional(),
    /** If set, include the role only when the answer about existing smoke/CO detectors is one of these. */
    existing_detectors: z.array(z.enum(EXISTING_DETECTORS)).min(1).optional(),
    /** Terms that identify this role in the retained-equipment list. */
    retained_match: z.array(z.string()).optional(),
    /** The D-Tools model of the role's product, so a rep can name it as printed on the budget ("1 WSSATM1-B2"). */
    model: z.string().min(1).optional(),
    /** Extra terms that identify this role in a stated count ("3 doors" → door/window contacts). */
    count_terms: z.array(z.string()).optional(),
    /** One more of this role for each existing item the request moves that matches these terms (a mount per moved TV). */
    per_moved: z.array(z.string()).optional(),
    /** Alternative approved records chosen by the size the request names ("75-inch" → the 77" model). */
    variants: z
      .array(z.object({ sizes: z.array(z.number().int().positive()).min(1), product_id: z.string().uuid(), label: z.string().min(1) }).strict())
      .optional(),
    /** D-Tools product record. Null until Livewire chooses a standard product. */
    product_id: z.string().uuid().nullable(),
    precedent: z.enum(["livewire_standard", "accepted_comparable", "new_to_livewire"]),
    quantity: z.union([
      z.object({ kind: z.literal("fixed"), qty: z.number().int().positive() }).strict(),
      z.object({ kind: z.literal("minimum"), qty: z.number().int().positive(), verify: z.string().min(1) }).strict(),
    ]),
    location: z.string().min(1),
    /** What this role contributes, shown as capability evidence. */
    capability: z.string().min(1),
    /** Labor hours per unit of this role, when it differs from the pattern's per-device rate (a speaker pair takes longer than an amp). */
    hours_each: z.number().min(0).optional(),
    /** Life-safety and similar roles escalate to Zack when unresolved. */
    escalate_if_unresolved: z.boolean().default(false),
  })
  .strict();

export const ServiceSpecSchema = z
  .object({
    category: z.string().min(1),
    label: z.string().min(1),
    /** D-Tools labor/service record priced per project. Null means allowance (TBD). */
    product_id: z.string().uuid().nullable(),
  })
  .strict();

/**
 * Project labor estimated from Livewire history: hours = base + per device,
 * priced at the policy's hourly rate for the D-Tools labor type.
 */
export const LaborSpecSchema = z
  .object({
    labor_type: z.string().min(1),
    base_hours: z.number().min(0),
    hours_per_device: z.number().min(0),
    /** Service categories this estimate includes; they are not priced separately. */
    covers: z.array(z.string()).min(1),
    /** Where the numbers come from, kept with the pattern for review. */
    basis: z.string().min(1),
  })
  .strict();

export const PatternSpecSchema = z
  .object({
    schema: z.literal("architecture_pattern_v1"),
    pattern: z.string().min(1),
    version: z.string().min(1),
    title: z.string().min(1),
    /** The pattern applies when the scope includes any of these systems. */
    applies_when_any: z.array(z.string()).min(1),
    roles: z.array(RoleSpecSchema).min(1),
    services: z.array(ServiceSpecSchema),
    labor: LaborSpecSchema.optional(),
    /** Labor-only allowances added to project labor when the request mentions them (framing a TV niche). */
    labor_extras: z
      .array(z.object({ id: z.string().min(1), label: z.string().min(1), hours: z.number().positive(), mentions: z.array(z.string()).min(1) }).strict())
      .optional(),
    /** D-Tools parts-and-materials record, sized from the policy's parts mix target. */
    parts: z.object({ product_id: z.string().uuid(), label: z.string().min(1) }).strict().optional(),
    assumptions: z.array(z.string()),
    exclusions: z.array(z.string()),
  })
  .strict()
  .superRefine((p, ctx) => {
    const seen = new Set<string>();
    for (const r of p.roles) {
      if (seen.has(r.role)) ctx.addIssue({ code: "custom", message: `duplicate role ${r.role}` });
      seen.add(r.role);
    }
  });

export type RoleSpec = z.infer<typeof RoleSpecSchema>;
export type ServiceSpec = z.infer<typeof ServiceSpecSchema>;
export type LaborSpec = z.infer<typeof LaborSpecSchema>;
export type PatternSpec = z.infer<typeof PatternSpecSchema>;

/** Labor hours for a device count, rounded up to the half hour. */
export function laborHours(spec: LaborSpec, devices: number): number {
  return Math.ceil((spec.base_hours + spec.hours_per_device * devices) * 2) / 2;
}

/** Labor hours for priced lines: base plus each line's units at its role's rate (or the pattern's per-device rate). */
/** Minimum labor for an add-on visit, matching the hourly service-call minimum on Livewire quotes. */
export const ADD_ON_MIN_HOURS = 1;

export function laborHoursFor(pattern: PatternSpec, lines: Array<{ role: string; quantity: number }>, addOn = false, extras: string[] = []): number {
  const spec = pattern.labor!;
  const rate = (role: string) => pattern.roles.find((r) => r.role === role)?.hours_each ?? spec.hours_per_device;
  const extraHours = extras.reduce((h, id) => h + (pattern.labor_extras?.find((x) => x.id === id)?.hours ?? 0), 0);
  // An add-on visit has no system setup (base hours), only the devices, with an hourly minimum.
  const raw = lines.reduce((h, l) => h + l.quantity * rate(l.role), (addOn ? 0 : spec.base_hours) + extraHours);
  const hours = addOn ? Math.max(ADD_ON_MIN_HOURS, raw) : raw;
  return Math.ceil(Math.round(hours * 1000) / 1000 * 2) / 2;
}

/**
 * The pattern for a scope. When several apply (a security and network job),
 * they are combined into one, so each system is priced by its own approved
 * pattern. Patterns that cannot be combined safely (a role in both, different
 * labor rates or parts records) are not merged by guessing: none applies.
 */
export function selectPattern(systems: string[], patterns: PatternSpec[]): PatternSpec | null {
  const matches = patterns.filter((p) => p.applies_when_any.some((s) => systems.includes(s)));
  if (matches.length <= 1) return matches[0] ?? null;
  return combinePatterns(matches);
}

export function combinePatterns(ps: PatternSpec[]): PatternSpec | null {
  // Each role keeps its own pattern's labor rate.
  const roles = ps.flatMap((p) => p.roles.map((r) => (p.labor && r.hours_each === undefined ? { ...r, hours_each: p.labor.hours_per_device } : r)));
  if (new Set(roles.map((r) => r.role)).size !== roles.length) return null;
  const labors = ps.map((p) => p.labor);
  const parts = ps.map((p) => p.parts);
  if (labors.some((l) => l === undefined) && labors.some((l) => l !== undefined)) return null;
  if (new Set(labors.map((l) => l?.labor_type)).size > 1) return null;
  if (new Set(parts.map((x) => x?.product_id)).size > 1) return null;
  const uniq = (xs: string[]) => [...new Set(xs)];
  const first = labors[0];
  const services = [...new Map(ps.flatMap((p) => p.services).map((s) => [s.category, s])).values()];
  return PatternSpecSchema.parse({
    schema: "architecture_pattern_v1",
    pattern: ps.map((p) => p.pattern).join("+"),
    version: ps.map((p) => `${p.pattern}@${p.version}`).join("+"),
    title: ps.map((p) => p.title).join(" + "),
    applies_when_any: uniq(ps.flatMap((p) => p.applies_when_any)),
    roles,
    services,
    // One visit covers both systems: the base hours add up; each role keeps its own pattern's rate.
    ...(first
      ? {
          labor: {
            ...first,
            base_hours: labors.reduce((sum, l) => sum + l!.base_hours, 0),
            covers: uniq(labors.flatMap((l) => l!.covers)),
            basis: labors.map((l, i) => `${ps[i]!.title}: ${l!.basis}`).join(" | "),
          },
        }
      : {}),
    ...(ps[0]!.parts ? { parts: ps[0]!.parts } : {}),
    ...(ps.some((p) => p.labor_extras?.length) ? { labor_extras: ps.flatMap((p) => p.labor_extras ?? []) } : {}),
    assumptions: uniq(ps.flatMap((p) => p.assumptions)),
    exclusions: uniq(ps.flatMap((p) => p.exclusions)),
  });
}

/** Every product record a pattern may need, for exact-record reads. */
export function patternRecordIds(p: PatternSpec): string[] {
  const ids = [...p.roles, ...p.services, ...p.roles.flatMap((r) => r.variants ?? [])].map((x) => x.product_id).filter((x): x is string => x !== null);
  if (p.parts) ids.push(p.parts.product_id);
  return [...new Set(ids)].sort();
}

/**
 * Load the approved patterns shipped with the release. Product IDs are filled
 * in by Livewire (the shipped draft has none, so every role is unresolved until
 * standards are chosen).
 */
export async function loadPatterns(dir = new URL("../patterns/", import.meta.url)): Promise<PatternSpec[]> {
  const { readdir, readFile } = await import("node:fs/promises");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  return Promise.all(files.map(async (f) => PatternSpecSchema.parse(JSON.parse(await readFile(new URL(f, dir), "utf8")))));
}
