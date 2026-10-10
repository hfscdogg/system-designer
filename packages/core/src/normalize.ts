import type { ScopeExtraction } from "./scope.ts";

/**
 * Deterministic normalization (PRD §8.2). Equivalent phrasings map to the same
 * canonical terms so the scope hash is stable. The tables are bounded: a term
 * that matches nothing is kept as the requester wrote it (whitespace and case
 * folded), never coerced into a known pattern.
 */

const FUNCTIONAL_SYSTEMS: Array<[canonical: string, patterns: RegExp[]]> = [
  ["intrusion_security", [/\b((?<!(smoke|fire|co|monoxide) )alarm|alarm panel|security|security panel|intrusion|burglar|door contacts?|window contacts?|(?:door\/window|wireless) contacts?|glass[- ]?break( sensors?)?|motion (detector|sensor)s?|(?<!(lutron|scene|lighting|control4|c4) )(alarm |security )?keypads?(?! for lighting))\b/]],
  ["alarm_monitoring", [/\b(alarm\.com|monitoring|central station|monitored)\b/]],
  ["fire_detection", [/\b(fire|smoke)( detection| detectors?| alarms?| sensors?)?\b/]],
  ["co_detection", [/\b(co|carbon monoxide)( detection| detectors?| alarms?| sensors?)\b/]],
  ["climate_control", [/\b(thermostats?|hvac control|climate( control)?)\b/]],
  ["video_doorbell", [/\b(video )?door ?bell\b/]],
  ["video_surveillance", [/\b((?<!door ?bell )cameras?|cctv|surveillance|nvr)\b/]],
  // Music through the house is its own system (Sonos amps and architectural speakers); TVs and theaters are audio_video.
  ["whole_home_audio", [/\b(sonos|whole[- ](home|house) (audio|music)|distributed audio|multi[- ]room (audio|music)|background music|(in|on)[- ](ceiling|wall) speakers?|ceiling speakers?|outdoor speakers?|landscape speakers?|patio speakers?|speakers?|music)\b/]],
  // Bare "video" is a TV; "video doorbell" and "video cameras" are their own systems.
  ["audio_video", [/\b(tvs?|television|home theater|theatre|media room|audio[/ -]?video|a\/v|av|soundbar|surround( sound)?|video(?! ?(door ?bell|surveillance|cameras?|security)))\b/]],
  // New-construction cabling; listed before networking so "network drops" are wiring, not Wi-Fi.
  ["structured_wiring", [/\b(structured wiring|pre-?wire|prewiring|pre-?wired|low[- ]voltage wiring|cat ?6 (runs?|drops?|wiring)|data (drops?|outlets?|runs?)|network (drops?|outlets?|wiring)|rough[- ]?in)\b/]],
  // "wireless" alone names how a device connects (wireless contacts, sensors), not a network.
  ["networking", [/\b(wi-?fi|network(ing)?(?! (drops?|outlets?|wiring))|access points?|router|wireless (network|internet|coverage))\b/]],
  // Bare "automation" is too broad (pool automation): only whole-home control platforms.
  ["home_automation", [/\b(control4|c4|halo( remotes?)?|(home|house) automation|smart home|whole[- ](home|house) control|universal remote|savant|crestron)\b/]],
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

/**
 * Words that describe a camera rather than name another system: "security
 * cameras" are not an alarm, "WiFi cameras" are not a network, "floodlight
 * cameras" are not lighting control. Dropped before matching when the item is
 * about cameras.
 */
const CAMERA_ITEM = /\b(cameras?|cams?|surveillance|cctv|nvr)\b/;
const CAMERA_FEATURES = /\b(security|wi-?fi|wireless|hard-?wired|lighting|lights?|flood ?lights?|motion|power(ed)?|poe)\b/g;

function systemHits(item: string): string[] {
  const t = fold(item);
  return matchAll(FUNCTIONAL_SYSTEMS, CAMERA_ITEM.test(t) ? t.replace(CAMERA_FEATURES, " ") : t);
}

/** The canonical systems a piece of text talks about ("Is the Halo remote compatible with Control4?" → home_automation). */
export function systemsMentioned(text: string): string[] {
  return systemHits(text);
}

export function normalizeFunctionalSystems(items: string[]): string[] {
  const mapped = items.map((item) => {
    const hits = systemHits(item);
    // A Sonos soundbar ("Sonos Arc Ultra") is TV sound, not music through the house.
    const tvSound = hits.includes("audio_video") && /\b(soundbars?|sound bars?|arc|beam|ray)\b/.test(fold(item));
    return { item, hits: tvSound ? hits.filter((h) => h !== "whole_home_audio") : hits };
  });
  const hasAv = mapped.some((m) => m.hits.includes("audio_video"));
  return uniqSorted(
    mapped.flatMap(({ item, hits }) => {
      if (hits.length) return hits;
      // Bare "audio" is the TV's sound when a TV is in scope, otherwise music through the house.
      if (/^audio( systems?)?$/.test(fold(item))) return [hasAv ? "audio_video" : "whole_home_audio"];
      return [fold(item)];
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
    // Canonical names stay as they are, so normalizing twice changes nothing.
    if (SERVICE_CATEGORIES.some(([c]) => c === fold(item))) {
      categories.push(fold(item));
      continue;
    }
    const hits = matchAll(SERVICE_CATEGORIES, item);
    if (hits.length) categories.push(...hits);
    else rejected.push(clean(item));
  }
  return { categories: uniqSorted(categories), rejected: uniqSorted(rejected) };
}

/** Stated counts keyed by item (folded); a repeated item keeps its last count. Sorted for a stable hash. */
function normalizeQuantities(items: Array<{ item: string; quantity: number }>): Array<{ item: string; quantity: number }> {
  const byItem = new Map<string, number>();
  for (const q of items) {
    const item = clean(q.item).toLowerCase();
    if (item) byItem.set(item, q.quantity);
  }
  return [...byItem.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([item, quantity]) => ({ item, quantity }));
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
    market: input.market,
    room_types: list(input.room_types),
    functional_systems: normalizeFunctionalSystems(input.functional_systems),
    requested_changes: list(input.requested_changes),
    requested_quantities: normalizeQuantities(input.requested_quantities),
    requested_discount: input.requested_discount ? { pct: input.requested_discount.pct, note: clean(input.requested_discount.note) } : null,
    existing_equipment: {
      status: input.existing_equipment.status,
      retained: list(input.existing_equipment.retained),
      removed_or_replaced: list(input.existing_equipment.removed_or_replaced),
    },
    existing_detectors: input.existing_detectors,
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
