import type { ScopeExtraction } from "./scope.ts";

/**
 * Deterministic normalization (PRD §8.2). Equivalent phrasings map to the same
 * canonical terms so the scope hash is stable. The tables are bounded: a term
 * that matches nothing is kept as the requester wrote it (whitespace and case
 * folded), never coerced into a known pattern.
 */

const FUNCTIONAL_SYSTEMS: Array<[canonical: string, patterns: RegExp[]]> = [
  ["intrusion_security", [/\b((?<!(smoke|fire|co|monoxide) )alarm|alarm panel|security|security panel|intrusion|burglar|door contacts?|window contacts?|glass[- ]?break( sensors?)?|motion (detector|sensor)s?)\b/]],
  ["alarm_monitoring", [/\b(alarm\.com|monitoring|central station|monitored)\b/]],
  ["fire_detection", [/\b(fire|smoke)( detection| detectors?| alarms?| sensors?)?\b/]],
  ["co_detection", [/\b(co|carbon monoxide)( detection| detectors?| alarms?| sensors?)\b/]],
  ["climate_control", [/\b(thermostats?|hvac control|climate( control)?)\b/]],
  ["video_doorbell", [/\b(video )?door ?bell\b/]],
  ["video_surveillance", [/\b((?<!door ?bell )cameras?|cctv|surveillance|nvr)\b/]],
  ["audio_video", [/\b(tvs?|television|home theater|theatre|media room|audio[/ -]?video|av|distributed audio|speakers?|soundbar)\b/]],
  ["networking", [/\b(wi-?fi|network(ing)?|access points?|router|wireless)\b/]],
  ["lighting_control", [/\b(lighting control|lutron|dimmers?|keypads? for lighting|lighting)\b/]],
  ["motorized_shades", [/\b(shades?|blinds|motorized (window )?treatments?)\b/]],
  ["access_control", [/\b(door locks?|smart locks?|access control|gate)\b/]],
];

/** Service categories are labor/service delivery only (PRD §8.1). */
const SERVICE_CATEGORIES: Array<[canonical: string, patterns: RegExp[]]> = [
  ["design", [/\b(design|engineering|system design)\b/]],
  ["prewire", [/\b(pre-?wire|rough[- ]?in|wiring|cabling)\b/]],
  ["installation", [/\b(install(ation)?|trim(-out)?|mounting)\b/]],
  ["programming", [/\b(programming|configuration|setup|set-up)\b/]],
  ["testing", [/\btest(ing)?\b/]],
  ["commissioning", [/\bcommission(ing)?\b/]],
  ["project_management", [/\b(project management|pm|coordination)\b/]],
  ["training", [/\b(training|walkthrough|orientation)\b/]],
  ["removal", [/\b(removal|demo(lition)?|decommission(ing)?|take[- ]?out)\b/]],
  ["monitoring_activation", [/\b(monitoring activation|activate monitoring|account activation)\b/]],
];

function clean(s: string): string {
  return s.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function fold(s: string): string {
  return clean(s).toLowerCase();
}

function uniqSorted(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.length > 0))].sort();
}

/** Map free text to every canonical term it names. Empty when nothing matches. */
function matchAll(table: Array<[string, RegExp[]]>, text: string): string[] {
  const t = fold(text);
  return table.filter(([, patterns]) => patterns.some((p) => p.test(t))).map(([c]) => c);
}

export function normalizeFunctionalSystems(items: string[]): string[] {
  return uniqSorted(
    items.flatMap((item) => {
      const hits = matchAll(FUNCTIONAL_SYSTEMS, item);
      return hits.length ? hits : [fold(item)];
    }),
  );
}

export interface ServiceNormalization {
  categories: string[];
  /** Entries that were not labor/service categories and were dropped. */
  rejected: string[];
}

export function normalizeServiceCategories(items: string[]): ServiceNormalization {
  const categories: string[] = [];
  const rejected: string[] = [];
  for (const item of items) {
    const hits = matchAll(SERVICE_CATEGORIES, item);
    if (hits.length) categories.push(...hits);
    else rejected.push(clean(item));
  }
  return { categories: uniqSorted(categories), rejected: uniqSorted(rejected) };
}

export interface NormalizedExtraction {
  scope: ScopeExtraction;
  notes: string[];
}

/** Normalize an already-validated extraction. Idempotent. */
export function normalizeExtraction(input: ScopeExtraction): NormalizedExtraction {
  const notes: string[] = [];
  const nullableClean = (s: string | null) => {
    if (s === null) return null;
    const c = clean(s);
    return c.length ? c : null;
  };
  const list = (xs: string[]) => uniqSorted(xs.map(clean));

  const services = normalizeServiceCategories(input.service_categories);
  if (services.rejected.length) {
    notes.push(`Not a service category, ignored: ${services.rejected.join("; ")}`);
  }

  let date = nullableClean(input.target_installation_date);
  if (date !== null && /^(unknown|tbd|undecided|not sure)$/i.test(date)) date = "unknown";

  let proposalNumber = nullableClean(input.proposal.number);
  if (proposalNumber !== null && /^unassigned$/i.test(proposalNumber)) proposalNumber = "UNASSIGNED";

  const scope: ScopeExtraction = {
    client: nullableClean(input.client),
    property: {
      line1: nullableClean(input.property.line1),
      city: nullableClean(input.property.city),
      region: nullableClean(input.property.region),
      postal_code: nullableClean(input.property.postal_code),
    },
    project_type: nullableClean(input.project_type),
    room_types: list(input.room_types),
    functional_systems: normalizeFunctionalSystems(input.functional_systems),
    requested_changes: list(input.requested_changes),
    existing_equipment: {
      status: input.existing_equipment.status,
      retained: list(input.existing_equipment.retained),
      removed_or_replaced: list(input.existing_equipment.removed_or_replaced),
    },
    excluded_scope: list(input.excluded_scope),
    service_categories: services.categories,
    size: input.size,
    budget: input.budget,
    target_installation_date: date,
    proposal: { number: proposalNumber, name: nullableClean(input.proposal.name) },
    unresolved_questions: list(input.unresolved_questions),
  };
  return { scope, notes };
}
