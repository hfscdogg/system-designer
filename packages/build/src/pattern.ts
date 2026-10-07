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
export type PatternSpec = z.infer<typeof PatternSpecSchema>;

export function selectPattern(systems: string[], patterns: PatternSpec[]): PatternSpec | null {
  const matches = patterns.filter((p) => p.applies_when_any.some((s) => systems.includes(s)));
  // Ambiguity is not resolved by guessing: exactly one pattern must apply.
  return matches.length === 1 ? matches[0]! : null;
}

/** Every product record a pattern may need, for exact-record reads. */
export function patternRecordIds(p: PatternSpec): string[] {
  return [...new Set([...p.roles, ...p.services].map((x) => x.product_id).filter((x): x is string => x !== null))].sort();
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
