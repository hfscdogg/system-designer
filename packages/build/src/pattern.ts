import { EXISTING_DETECTORS, MARKETS } from "@sd/core";
import { z } from "zod";

/**
 * An approved architecture pattern (PRD §12): which roles a system needs, the
 * Livewire-standard D-Tools record for each role, and how quantities are set.
 * Patterns are configuration reviewed by Livewire, not model output.
 */
export const RoleSpecSchema = z
  .object({
    role: z.string().min(1),
    /** D-Tools categories this role's products come from ("Networking > Switches"): a product the request names by model from one of them fills this role. */
    categories: z.array(z.string().min(1)).optional(),
    label: z.string().min(1),
    /** Critical roles must be priced or explicitly unresolved; never silently missing. */
    critical: z.boolean(),
    /** Canonical functional systems this role serves (see @sd/core normalize). */
    systems: z.array(z.string()).min(1),
    /** If set, include the role only when the request mentions one of these terms (whole words, in its changes or stated counts). */
    mentions: z.array(z.string()).optional(),
    /**
     * A mention counts only when the same change also names one of these (an "outdoor" eero needs Wi-Fi
     * words beside it, so "outdoor PoE cameras" adds no access point).
     */
    mentions_require: z.array(z.string()).min(1).optional(),
    /**
     * Include the role only when the request uses one of these words for its system ("Wi-Fi",
     * "internet"). Unlike mentions they don't name the device, so "add Wi-Fi" is not an add-on of one eero.
     */
    asked_by: z.array(z.string()).min(1).optional(),
    /** Equipment the customer keeps that asks for this role too (a kept CD player needs a Sonos Port to stream). */
    mentions_kept: z.array(z.string().min(1)).min(1).optional(),
    /** When priced without any of these roles, `verify` is listed to check (an eero access point with no eero router priced). */
    verify_without: z.object({ roles: z.array(z.string()).min(1), verify: z.string().min(1) }).strict().optional(),
    /** Include the role only when one of these roles is included (a switch and power protection for the eero network). */
    with_roles: z.array(z.string()).min(1).optional(),
    /**
     * Devices this role powers (a PoE switch for wired cameras): an add-on that prices them prices this role too,
     * unless the customer keeps one or keeps equipment of that system (Zack's Bowen-Rees job, 2026-10-23).
     */
    powers: z.object({ roles: z.array(z.string()).min(1), unless_kept: z.array(z.string()).min(1) }).strict().optional(),
    /**
     * Roles in one count group are counted together ("only need 1 eero"): when a stated count
     * goes to one of them, the others the request never named are dropped.
     */
    count_group: z.string().optional(),
    /** If set, include the role only when the answer about existing smoke/CO detectors is one of these. */
    existing_detectors: z.array(z.enum(EXISTING_DETECTORS)).min(1).optional(),
    /** Terms that identify this role in the retained-equipment list. */
    retained_match: z.array(z.string()).optional(),
    /** The D-Tools model of the role's product, so a rep can name it as printed on the budget ("1 WSSATM1-B2"). */
    model: z.string().min(1).optional(),
    /** Extra terms that identify this role in a stated count ("3 doors" → door/window contacts). */
    count_terms: z.array(z.string()).optional(),
    /**
     * A stated count naming one of these is this role's count too, whichever role it names best:
     * "4 smoke/CO detectors" is 4 smoke/heat and 4 CO detectors ("/", "&" and "and" read as spaces).
     */
    shared_count_terms: z.array(z.string().min(1)).min(1).optional(),
    /**
     * Roles that are alternatives for one job (turret vs floodlight cameras).
     * When a request names any role in the group, only the named ones are priced.
     */
    alternative_group: z.string().optional(),
    /** Priced one for each unit of these roles when the request states no count of its own (a memory card per camera). */
    quantity_follows: z.array(z.string()).optional(),
    /** One more of this role for each existing item the request moves that matches these terms (a mount per moved TV). */
    per_moved: z.array(z.string()).optional(),
    /**
     * An amplifier's count follows the speakers it drives (Henry, 2026-10-12): one per `speakers_per_unit`
     * passive speakers (pairs count as two), new or existing, once the request asks for speakers.
     */
    drives: z
      .object({
        roles: z.array(z.string()).min(1),
        speakers_per_unit: z.number().int().positive(),
        /**
         * At least one per room the speakers are asked for, too: two rooms of 4 speakers are 2 Sonos Amps, not 1
         * (Henry, 2026-10-27: one per zone on 11 of 25 multi-room Livewire quotes, one per 4 speakers on 7).
         */
        per_room: z.boolean().optional(),
      })
      .strict()
      .optional(),
    /** Each unit serves this many units of the roles it follows, and a stated count of "ports" is a count of them (a 12-port patch panel per 12 drops). */
    follows_per: z.number().int().positive().optional(),
    /**
     * On a retrofit each unit of this role is `units` items, each with its install time, and `verify` says why: a fished drop
     * takes a keystone jack at the wall and one at the head end (Henry, 2026-10-27: 2 jacks on 75 of 114 Livewire Cat6 Retro drops).
     */
    retrofit_units: z.object({ units: z.number().int().min(2), verify: z.string().min(1) }).strict().optional(),
    /** Approved records by port count, chosen when the request sizes this device ("2-port keystone plate"); each serves that many units it follows. */
    port_variants: z
      .array(z.object({ ports: z.number().int().min(2), product_id: z.string().uuid(), model: z.string().min(1), label: z.string().min(1) }).strict())
      .optional(),
    /**
     * Approved records chosen by the words the request uses for this device ("Sonos Beam" → the Beam). With `require`, the same
     * text must also name one of those; with `with_kept`, kept equipment's words count too (the customer's Playbar). With no product_id the
     * device is listed to price instead of priced as the standard. With `sizes`, only for those sizes; with `default_size`, only
     * when the request names none of the other entries' sizes (the 65" BRAVIA 8 unless 55" or 77" is asked for).
     */
    word_variants: z
      .array(
        z
          .object({
            words: z.array(z.string().min(1)).min(1),
            require: z.array(z.string().min(1)).min(1).optional(),
            with_kept: z.boolean().optional(),
            sizes: z.array(z.number().int().positive()).min(1).optional(),
            default_size: z.boolean().optional(),
            product_id: z.string().uuid().nullable(),
            model: z.string().min(1).optional(),
            label: z.string().min(1),
          })
          .strict(),
      )
      .optional(),
    /**
     * Another brand's approved record, priced when the request names that brand for this device ("Klipsch
     * in-ceiling speakers" on Biscuit Belly, 2026-10-15) instead of the standard's. Sold each, like a product
     * named by model. With `market`, only on that market's jobs.
     */
    brand_variants: z
      .array(
        z
          .object({ brand: z.string().min(1), market: z.enum(MARKETS).optional(), product_id: z.string().uuid(), model: z.string().min(1), label: z.string().min(1), units_per_item: z.number().int().min(2).optional() })
          .strict(),
      )
      .optional(),
    /** The approved record for one market instead of the standard (a 70V commercial amplifier), with its own speakers per unit. */
    market_variants: z
      .array(
        z
          .object({ market: z.enum(MARKETS), product_id: z.string().uuid(), label: z.string().min(1), speakers_per_unit: z.number().int().positive().optional() })
          .strict(),
      )
      .optional(),
    /**
     * "verify": with no Livewire standard (product_id null), a request for this role is listed to verify
     * as a requested product, priced in the final proposal, instead of withholding the budget total.
     */
    unpriced: z.literal("verify").optional(),
    /**
     * Other makers' brands for this device (Luma cameras): when the request asks for one ("Requested product:
     * Luma cameras"), the device is listed to price in that brand instead of priced as the standard, which
     * may not work with what the customer keeps (Zack's Jinny's job, 2026-10-26: Alarm.com cameras on a Luma NVR).
     */
    other_brands: z.array(z.string().min(1)).min(1).optional(),
    /**
     * Alternative approved records chosen by the size the request names ("75-inch" → the 77" model).
     * An `outdoor` variant is chosen only for a request that says the device goes outside (and only one is):
     * an outdoor TV is never priced as an indoor one.
     */
    variants: z
      .array(z.object({ sizes: z.array(z.number().int().positive()).min(1), product_id: z.string().uuid(), label: z.string().min(1), outdoor: z.boolean().optional() }).strict())
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
    /** How many units the standard item holds (a speaker pair is 2). A product the request names instead is sold each, so it takes hours_each per unit. */
    units_per_item: z.number().int().min(2).optional(),
    /** A mount's rated TV sizes, inches: a TV outside them is listed to confirm the mount (Zack's McGetrick job, 2026-10-19). */
    fits_tv_inches: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
    /** A short line printed under the item on the budget ("Includes its Cat6 run to the PoE switch"). */
    customer_note: z.string().min(1).optional(),
    /**
     * The mount to use instead when the TV is larger than `fits_tv_inches` allows, indoors or outdoors (Henry, 2026-10-19).
     * An `outdoor` one is also the mount for any outdoor TV it fits (Zack's Britt job, 2026-10-23).
     */
    larger_tv_variants: z
      .array(
        z
          .object({ product_id: z.string().uuid(), model: z.string().min(1), label: z.string().min(1), outdoor: z.boolean().optional(), fits_tv_inches: z.tuple([z.number().int().positive(), z.number().int().positive()]) })
          .strict(),
      )
      .optional(),
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
    /** Setup hours on an add-on visit (no system setup, but travel, testing and handover); 0 when absent. */
    add_on_base_hours: z.number().min(0).optional(),
    /** Service categories this estimate includes; they are not priced separately. */
    covers: z.array(z.string()).min(1),
    /** Where the numbers come from, kept with the pattern for review. */
    basis: z.string().min(1),
  })
  .strict();

/**
 * Labor for work no pattern role covers (a conduit run, an outdoor outlet), priced as hours at the
 * policy rate, with no invented parts prices: Design & Delivery covers materials. Templates live in
 * patterns/allowances.json and ride along with every pattern, so a run freezes the ones it used.
 */
export const AllowanceSpecSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    /** Whole words in one change (or an uncovered system) that ask for this work. */
    mentions: z.array(z.string().min(1)).min(1),
    /** The same change must also name one of these ("outdoor" for an outdoor outlet). */
    require: z.array(z.string().min(1)).min(1).optional(),
    /** A change naming one of these is about something else ("data outlet", "eero outlet mount"). */
    exclude: z.array(z.string().min(1)).min(1).optional(),
    /** Systems whose pattern prices this work itself (cable runs in a prewire). */
    covered_by_systems: z.array(z.string().min(1)).optional(),
    hours: z.number().positive(),
    /**
     * Priced once per thing asked for, not once per job: "Ethernet port in the dining room" and
     * "… in the living room" are two cable runs. The count is the stated count when there is one.
     */
    counted: z.boolean().optional(),
    /**
     * Roles each priced unit of which needs one more of this counted allowance (a cable run per wired access point),
     * unless the request states its own count of runs or drops, which already includes them.
     */
    per_role: z.array(z.string().min(1)).min(1).optional(),
    /**
     * Hours per foot when the request gives a length ("120 ft of hand trench"): the allowance is the larger of
     * `hours` and the feet (times the runs it names, "two conduits") at this rate (Henry, 2026-10-15).
     */
    hours_per_foot: z.number().positive().optional(),
    /**
     * Laid in a trench the request also asks for (conduit in an open trench): the trench's length times the
     * runs named, at this lower per-foot rate, at least `hours` (Henry, 2026-10-15).
     */
    in_trench: z.object({ trench: z.string().min(1), hours_per_foot: z.number().positive() }).strict().optional(),
    labor_type: z.string().min(1),
    /** Where the hours come from, kept for review. */
    basis: z.string().min(1),
  })
  .strict();

export const AllowanceFileSchema = z
  .object({
    schema: z.literal("allowance_templates_v1"),
    version: z.string().min(1),
    labor_type: z.string().min(1),
    allowances: z.array(AllowanceSpecSchema.omit({ labor_type: true })).min(1),
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
    /** Labor allowances for out-of-pattern work (see AllowanceSpecSchema); attached by loadPatterns. */
    allowances: z.array(AllowanceSpecSchema).optional(),
    assumptions: z.array(z.string()),
    exclusions: z.array(z.string()),
    /**
     * A combined pattern's parts, with their roles, assumptions and exclusions: a part the budget prices
     * nothing from adds none of its wording or title (Zack's McGetrick job, 2026-10-23). Set by combinePatterns.
     */
    sources: z
      .array(z.object({ pattern: z.string().min(1), roles: z.array(z.string()).min(1), assumptions: z.array(z.string()), exclusions: z.array(z.string()) }).strict())
      .optional(),
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
export type AllowanceSpec = z.infer<typeof AllowanceSpecSchema>;

/** Labor hours for a device count, rounded up to the half hour. */
export function laborHours(spec: LaborSpec, devices: number): number {
  return Math.ceil((spec.base_hours + spec.hours_per_device * devices) * 2) / 2;
}

/** Labor hours for priced lines: base plus each line's units at its role's rate (or the pattern's per-device rate). */
/** Minimum labor for an add-on visit, matching the hourly service-call minimum on Livewire quotes. */
export const ADD_ON_MIN_HOURS = 1;

export function laborHoursFor(pattern: PatternSpec, lines: Array<{ role: string; quantity: number; record_id?: string }>, addOn = false, extras: string[] = []): number {
  const spec = pattern.labor!;
  const rate = (line: { role: string; record_id?: string }) => {
    const role = pattern.roles.find((r) => r.role === line.role);
    const each = role?.hours_each ?? spec.hours_per_device;
    // A named product in place of a multi-unit standard (one speaker, not a pair) takes that standard's hours per unit.
    const substitute =
      !!role?.units_per_item && !!line.record_id && line.record_id !== role.product_id && ![...(role.variants ?? []), ...(role.word_variants ?? [])].some((v) => v.product_id === line.record_id);
    return substitute ? each / role!.units_per_item! : each;
  };
  const extraHours = extras.reduce((h, id) => h + (pattern.labor_extras?.find((x) => x.id === id)?.hours ?? 0), 0);
  // An add-on visit has no system setup (base hours), only its own visit setup and the devices, with an hourly minimum.
  const raw = lines.reduce((h, l) => h + l.quantity * rate(l), (addOn ? (spec.add_on_base_hours ?? 0) : spec.base_hours) + extraHours);
  // Devices sold without install time (a Control4 remote, paired remotely) carry no visit and no minimum.
  const hours = addOn && raw > 0 ? Math.max(ADD_ON_MIN_HOURS, raw) : raw;
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
            // One visit: the largest add-on setup, not the sum.
            add_on_base_hours: Math.max(0, ...labors.map((l) => l!.add_on_base_hours ?? 0)),
            covers: uniq(labors.flatMap((l) => l!.covers)),
            basis: labors.map((l, i) => `${ps[i]!.title}: ${l!.basis}`).join(" | "),
          },
        }
      : {}),
    ...(ps[0]!.parts ? { parts: ps[0]!.parts } : {}),
    ...(ps.some((p) => p.labor_extras?.length) ? { labor_extras: ps.flatMap((p) => p.labor_extras ?? []) } : {}),
    ...(ps.some((p) => p.allowances?.length) ? { allowances: [...new Map(ps.flatMap((p) => p.allowances ?? []).map((a) => [a.key, a])).values()] } : {}),
    assumptions: uniq(ps.flatMap((p) => p.assumptions)),
    exclusions: uniq(ps.flatMap((p) => p.exclusions)),
    sources: ps.flatMap((p) => p.sources ?? [{ pattern: p.pattern, roles: p.roles.map((r) => r.role), assumptions: p.assumptions, exclusions: p.exclusions }]),
  });
}

/** Every product record a pattern may need, for exact-record reads. */
export function patternRecordIds(p: PatternSpec): string[] {
  const ids = [
    ...p.roles,
    ...p.services,
    ...p.roles.flatMap((r) => [...(r.variants ?? []), ...(r.market_variants ?? []), ...(r.brand_variants ?? []), ...(r.larger_tv_variants ?? []), ...(r.port_variants ?? []), ...(r.word_variants ?? [])]),
  ]
    .map((x) => x.product_id)
    .filter((x): x is string => x !== null);
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
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json") && f !== ALLOWANCES_FILE).sort();
  const allowances = await readFile(new URL(ALLOWANCES_FILE, dir), "utf8").then(
    (text) => {
      const file = AllowanceFileSchema.parse(JSON.parse(text));
      return file.allowances.map((a) => ({ ...a, labor_type: file.labor_type }));
    },
    () => [],
  );
  return Promise.all(
    files.map(async (f) => {
      const p = PatternSpecSchema.parse(JSON.parse(await readFile(new URL(f, dir), "utf8")));
      return allowances.length ? { ...p, allowances } : p;
    }),
  );
}

/** An allowance's hours: per unit for a counted one, or by length at its per-foot rate when it has one and a length is given. */
export function allowanceHours(spec: Pick<AllowanceSpec, "hours" | "hours_per_foot" | "in_trench">, units = 1, feet?: number, inTrench = false): number {
  const rate = inTrench ? spec.in_trench?.hours_per_foot : spec.hours_per_foot;
  if (feet && rate) return Math.max(spec.hours, Math.ceil(Math.round(feet * rate * 1000) / 1000 * 2) / 2);
  return spec.hours * units;
}

/** The allowance templates in the patterns directory (not a pattern itself). */
export const ALLOWANCES_FILE = "allowances.json";
