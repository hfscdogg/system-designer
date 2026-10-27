import { isAddOnRequest, type ScopeDraftV1 } from "@sd/core";
import type { NamedProduct } from "./named.ts";
import { allowanceHours, laborHoursFor, type AllowanceSpec, type PatternSpec, type RoleSpec } from "./pattern.ts";

/**
 * Deterministic materializer (PRD §13.2): approved scope + approved pattern →
 * selection. No model call, no catalog search, no invented quantities.
 */
/** "removed": the request took out every device of a system it named (a revision dropping the ceiling speakers). */
export type Classification = "supported" | "allowance" | "unresolved" | "removed";

export interface SelectionLine {
  role: string;
  record_id: string;
  quantity: number;
  quantity_basis: "fixed" | "minimum_to_verify";
  verify: string | null;
  location: string;
  precedent: RoleSpec["precedent"];
  /** The model the request named, when the line prices that catalog product instead of the role's standard. */
  requested_model?: string;
}

export interface Selection {
  schema: "selection_v1";
  pattern: string;
  pattern_version: string;
  /** Priced as an add-on to an existing system: only the named devices, no system setup hours. */
  add_on: boolean;
  /** Cabling into a finished home (fished, drilled up from a basement), not open walls: worded so on the budget. */
  retrofit?: boolean;
  lines: SelectionLine[];
  services: Array<{ category: string; record_id: string; quantity: 1 }>;
  /** Project labor estimate; null when the pattern has no labor model. */
  /** set_by_rep: the hours are the rep's ("hours to 7"), not the pattern estimate. */
  labor: { labor_type: string; hours: number; devices: number; covers: string[]; extras: string[]; set_by_rep?: boolean } | null;
  parts: { record_id: string } | null;
  requirements: Array<{ system: string; classification: Classification; roles: string[]; note: string }>;
  allowances: Array<{ label: string; reason: string }>;
  unresolved: Array<{ item: string; role: string | null; reason: string; escalate: boolean }>;
  /** Labor for out-of-pattern work the request asks for (a conduit run), from the pattern's allowance templates; priced at the policy rate. */
  /** quantity: how many of a counted template the hours cover (4 Ethernet ports); absent for one. */
  labor_allowances: Array<{ key: string; label: string; hours: number; labor_type: string; quantity?: number; feet?: number; trenched?: true }>;
  /** Requested products with no Livewire standard (a TV cart), listed to verify and priced in the final proposal. */
  to_verify: string[];
}

const fold = (s: string) => s.toLowerCase();

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Count terms are short words ("door"), so they match whole words only: "doors" yes, "doorbell" no. */
function hasWord(text: string, term: string): boolean {
  return new RegExp(`\\b${escape(term)}(s|es)?\\b`).test(text);
}

/**
 * Cabling into a finished home: the request says it is fished or drilled through existing walls, not run
 * before drywall (Zack's Giessel / Dunham job, 2026-10-26: "drill-up access to all first-floor walls").
 */
const RETROFIT = /\b(retro-?fit|retro|fish(ed|ing)?|drill(ed|ing)?(-| )?up|drill(ed|ing)? (up|down|through)|finished (walls?|ceilings?|rooms?|spaces?)|existing (walls?|home|house)|plumbing chase|chase)\b/;
const NEW_CONSTRUCTION = /\b(new construction|new build|new home build|open walls|open studs|before drywall|rough[- ]?in)\b/;
function retrofit(scope: ScopeDraftV1): boolean {
  const texts = [scope.project_type ?? "", ...scope.requested_changes].map(fold);
  return texts.some((t) => RETROFIT.test(t)) && !texts.some((t) => NEW_CONSTRUCTION.test(t));
}

/** The request's own words, one entry per change or stated count. System names and rooms are not requests ("Patio" is not outdoor Wi-Fi). */
const requestTexts = (scope: ScopeDraftV1) => [...scope.requested_changes, ...scope.requested_quantities.map((q) => q.item)].map(fold);

/**
 * The request mentions one of these terms as a whole word ("arc" is not "search").
 * With `require`, the same change must also name one of those ("outdoor" counts for
 * an eero only beside Wi-Fi words, not in "outdoor PoE cameras").
 */
function mentioned(scope: ScopeDraftV1, terms: string[], require?: string[], without: string[] = []): boolean {
  const strip = (t: string) => without.reduce((x, p) => x.replace(new RegExp(`\\b${escape(p)}(s|es)?\\b`, "g"), " "), t);
  return requestTexts(scope)
    .map(strip)
    .some((t) => terms.some((term) => hasWord(t, fold(term))) && (!require || require.some((r) => hasWord(t, fold(r)))));
}

/**
 * Phrases that name another role of the same count group ("PoE access point" for the wired eero):
 * their words ask for that role, not this one. A PoE access point is not a request for mesh Wi-Fi
 * or an outdoor eero (Zack's Britt job, 2026-10-15).
 */
function siblingPhrases(role: RoleSpec, roles: RoleSpec[]): string[] {
  if (!role.count_group) return [];
  const own = new Set([...(role.mentions ?? []), ...(role.asked_by ?? []), ...(role.count_terms ?? [])].map(fold));
  return roles
    .filter((r) => r !== role && r.count_group === role.count_group)
    .flatMap((r) => [...(r.mentions ?? []), ...(r.count_terms ?? [])].map(fold))
    .filter((p) => /\s/.test(p) && !own.has(p))
    .sort((a, b) => b.length - a.length);
}

/** Every word of a multi-word term appears in the text, in any order: "mount for the soundbar" names a "soundbar mount". */
function hasAllWords(text: string, term: string): boolean {
  return term.split(/\s+/).every((w) => hasWord(text, w));
}

/** Terms that identify a role in the request: its label, retained-equipment terms and mention terms. */
function roleTerms(role: RoleSpec): string[] {
  return [role.label, ...(role.retained_match ?? []), ...(role.mentions ?? [])].map(fold);
}

/** Brand names say which system, not which device: a "Control4 remote" is a remote, not a Control4 controller. */
const BRANDS = new Set(["control4", "c4", "lutron", "sonos", "alarm.com"]);

/** The role's terms that name a device, not just its brand. */
function deviceTerms(role: RoleSpec): string[] {
  return roleTerms(role).filter((t) => !BRANDS.has(t));
}

/** How specifically `text` names `role`: a full label beats the longest matching term; 0 when it doesn't. */
const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The request names this role's model anywhere in its changes or stated counts. */
function modelNamed(scope: ScopeDraftV1, role: RoleSpec): boolean {
  if (!role.model) return false;
  const m = compact(role.model);
  return [...scope.requested_changes, ...scope.requested_quantities.map((q) => q.item)].some((x) => compact(x).includes(m));
}

function matchScore(text: string, role: RoleSpec): number {
  const t = fold(text);
  // The model number printed on the budget is the most specific way to name a device.
  if (role.model && compact(text).includes(compact(role.model))) return 2000 + role.model.length;
  if (t.includes(fold(role.label))) return 1000 + role.label.length;
  // A mention that needs a companion word counts only beside it: in "1 outdoor rated TV", "outdoor"
  // names where the TV goes, not an outdoor eero (Zack's Britt job, 2026-10-19).
  const unpaired = role.mentions_require && !role.mentions_require.some((r) => hasWord(t, fold(r)));
  const own = new Set([fold(role.label), ...(role.retained_match ?? []).map(fold)]);
  // Whole words: the WattBox's "ups" is not in "upstairs" (Zack's Britt job, 2026-10-13).
  const terms = deviceTerms(role).filter((term) => hasWord(t, term) && (!unpaired || own.has(term)));
  const words = (role.count_terms ?? []).map(fold).filter((term) => hasAllWords(t, term));
  // A brand alone is the weakest match: any device word for another role wins.
  const brandOnly = roleTerms(role).some((term) => BRANDS.has(term) && hasWord(t, term)) ? 1 : 0;
  return Math.max(0, brandOnly, ...[...terms, ...words].map((term) => term.length));
}

/**
 * The requester's stated count for a role. Each stated item belongs to the one
 * role it names most specifically, so "3 Control4 Halo remotes" sets the
 * remotes, not the Control4 controller too.
 */
function statedQuantity(scope: ScopeDraftV1, role: RoleSpec, roles: RoleSpec[]): number | null {
  return statedItem(scope, role, roles)?.quantity ?? null;
}

/** A count of what the customer already has ("5 existing speakers") is not a count of new devices. */
const EXISTING_ITEM = /\b(existing|current|currently|retained|keep|kept|keeping|reuse|reused|old)\b/;

/** Whose it is: "the customer's", "client-supplied", "their own". What the customer supplies is never sold. */
const OWNER = String.raw`(?:(?:customer|client|owner|homeowner)(?:'s|’s|s'|s)?(?:[- ](?:supplied|provided|owned))?|their(?: own)?)`;
const OWNED_ITEM = new RegExp(String.raw`\b${OWNER}(?=\s|$)`, "i");
const OWNED_PHRASE = new RegExp(String.raw`\b${OWNER}(?=\s|$)`, "gi");

/**
 * The request's words for this device when they say the customer supplies it ("Mount the customer's
 * 65-inch Sony TV"): the device is theirs, whether or not the extractor listed it as kept equipment
 * (Baker, 2026-10-13: the customer's Sony TV was priced as a new Sony TV).
 */
function customerOwned(scope: ScopeDraftV1, role: RoleSpec): string | undefined {
  for (const text of [...scope.requested_changes, ...scope.requested_quantities.map((q) => q.item)]) {
    for (const term of role.retained_match ?? []) {
      const m = new RegExp(String.raw`\b${OWNER}\s+(?:[\w"”.-]+\s+){0,3}?${escape(fold(term))}(s|es)?\b`, "i").exec(text);
      if (m) return m[0];
    }
  }
  return undefined;
}

/** "/", "&", "+" and "and" between words read as a space: "smoke/CO", "smoke & CO" and "smoke and CO" are all "smoke co". */
const joined = (s: string) => fold(s).replace(/\s*[/&+]\s*|\s+and\s+/g, " ");

/** Where an item is, not what it is: "smoke/CO detectors upstairs" and "… in the living room" are the same device. */
const PLACE = /\s+\b(upstairs|downstairs|in|at|on|by|near|above|below|behind|outside|inside|for|facing|over|under|of)\b.*$/;
/** Place words on their own, wherever they stand: "upstairs smoke/CO detectors", "smoke/CO detectors (downstairs)" (Zack's Britt job, 2026-10-15). */
const PLACE_WORD = /\b(upstairs|downstairs|basement|attic|first|second|third|top|main|lower|upper|floor|level|front|back|rear|side|corner|left|right|north|south|east|west)\b/g;
const deviceOf = (item: string) =>
  fold(item)
    .replace(/\([^)]*\)/g, " ")
    .replace(PLACE, "")
    .replace(PLACE_WORD, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Rooms a speaker request can name ("in-ceiling speakers in the kitchen and great room"). Floors and sides are not rooms. */
const ROOMS = [
  "kitchen", "living room", "family room", "great room", "dining room", "dining", "den", "office", "study", "library", "media room", "theater", "theatre",
  "bonus room", "game room", "rec room", "playroom", "gym", "bar", "sunroom", "mud room", "laundry", "garage", "basement", "foyer", "entry",
  "primary bedroom", "master bedroom", "primary bath", "master bath", "bedroom", "bathroom", "bath", "guest room", "nursery", "loft",
  "patio", "porch", "deck", "pool", "backyard", "yard", "lanai", "pergola", "terrace", "balcony",
];

/**
 * How many rooms the request asks the driven speakers for: each room named in a change or stated count that names them,
 * once ("master bedroom" is not also "bedroom").
 */
function speakerRooms(scope: ScopeDraftV1, driven: RoleSpec[]): number {
  const names = (t: string) => driven.some((r) => deviceTerms(r).some((d) => hasWord(t, d)) || (r.count_terms ?? []).some((c) => hasAllWords(t, fold(c))));
  const rooms = new Set<string>();
  for (let t of requestTexts(scope).filter(names)) {
    for (const room of [...ROOMS].sort((a, b) => b.length - a.length)) {
      if (!hasWord(t, room)) continue;
      rooms.add(room);
      t = t.replace(new RegExp(`\\b${escape(room)}(s|es)?\\b`, "g"), " ");
    }
  }
  return rooms.size;
}

/** Words that say what kind of thing, not which one: a total of "4 exterior cameras" counts doorbell and wired cameras alike. */
const KIND_WORDS = new Set(["exterior", "interior", "outdoor", "indoor", "outside", "inside", "wired", "wireless", "hardwired", "new", "total", "additional", "more", "smart", "security"]);
const itemWords = (item: string) =>
  deviceOf(item)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.replace(/(?<=[a-z]{3})(es|s)$/, ""));

/**
 * A stated total the request then itemizes ("4 exterior cameras": a doorbell camera, a floodlight
 * camera and 2 wired cameras; "4 smoke/CO detectors": 2 upstairs and 2 downstairs) is not more
 * devices on top of its items (Zack's Bowen-Rees job, 2026-10-15). A count is a total when two or
 * more other counts each name all of its device words and add up to it exactly.
 */
function withoutTotals(scope: ScopeDraftV1): ScopeDraftV1 {
  const qs = scope.requested_quantities;
  const totals = new Set(
    qs.filter((q) => {
      const words = itemWords(q.item).filter((w) => !KIND_WORDS.has(w));
      if (!words.length) return false;
      const parts = qs.filter((o) => o !== q && words.every((w) => itemWords(o.item).includes(w)));
      if (parts.length < 2 || parts.reduce((n, o) => n + o.quantity, 0) !== q.quantity) return false;
      // Parts that are each another device ("wired floodlight camera", "wired smart doorbell camera") are not this count's
      // items when the request also names this device on its own ("1 x wired camera on the side of the house"): "wired
      // cameras × 2" is those two, not a total that happens to match (staging smoke, Bowen-Rees, 2026-10-27).
      const extra = (o: { item: string }) => itemWords(o.item).filter((w) => !words.includes(w) && !KIND_WORDS.has(w));
      if (!parts.every((o) => extra(o).length)) return true;
      const theirs = new Set(parts.flatMap(extra));
      return !scope.requested_changes.some((c) => {
        const said = itemWords(c);
        return words.every((w) => said.includes(w)) && !said.some((w) => theirs.has(w));
      });
    }),
  );
  return totals.size ? { ...scope, requested_quantities: qs.filter((q) => !totals.has(q)) } : scope;
}

function statedItem(scope: ScopeDraftV1, role: RoleSpec, roles: RoleSpec[]): { item: string; quantity: number } | null {
  const mine: Array<{ item: string; quantity: number }> = [];
  for (const q of scope.requested_quantities) {
    // Nor is a count of what the customer supplies ("1 customer's 65-inch Sony TV").
    if (EXISTING_ITEM.test(fold(q.item)) || OWNED_ITEM.test(q.item)) continue;
    // A count for devices sold as one thing elsewhere ("4 smoke/CO detectors") counts for each of them.
    if (role.shared_count_terms?.some((t) => hasWord(joined(q.item), joined(t)))) {
      mine.push(q);
      continue;
    }
    const scores = roles.map((r) => matchScore(q.item, r));
    const best = Math.max(...scores);
    if (best > 0 && roles[scores.indexOf(best)] === role) mine.push(q);
  }
  if (!mine.length) return null;
  // The same device counted room by room ("2 upstairs", "2 downstairs") adds up; a count of something else stays apart.
  const same = mine.filter((q) => deviceOf(q.item) === deviceOf(mine[0]!.item));
  return same.length > 1 ? { item: mine[0]!.item, quantity: same.reduce((n, q) => n + q.quantity, 0) } : mine[0]!;
}

/**
 * The stated count in the role's own units: a role sold in pairs takes "2 in-ceiling
 * speakers" as one pair and "7 speakers" as four; a count of pairs stays as written.
 */
function statedItems(scope: ScopeDraftV1, role: RoleSpec, roles: RoleSpec[]): number | null {
  const q = statedItem(scope, role, roles);
  if (!q) return null;
  // "8 patch panel ports" is one 12-port panel, not eight panels ("8-port patch panel" is a panel).
  if (role.follows_per && /\bports\b/.test(fold(q.item))) return Math.ceil(q.quantity / role.follows_per);
  if (!role.units_per_item || /\bpairs?\b/.test(fold(q.item))) return q.quantity;
  return Math.ceil(q.quantity / role.units_per_item);
}

/** Whether the request itself names this role (its changes or a stated count), for add-on pricing. */
/** The words of a role's terms ("soundbar mount" → soundbar, mount). */
const termWords = (r: RoleSpec) => new Set([...roleTerms(r), ...(r.count_terms ?? []).map(fold)].flatMap((t) => t.split(/[^a-z0-9.]+/)).filter(Boolean));

/**
 * The text with this role's words removed where they only describe another
 * device: "panel battery" is a battery, "soundbar mount" a mount. A word is a
 * modifier when the next word belongs to another role's terms and not this one's.
 */
function withoutModifiers(text: string, role: RoleSpec, roles: RoleSpec[]): string {
  const own = termWords(role);
  const others = new Set(roles.filter((r) => r !== role).flatMap((r) => [...termWords(r)]));
  const words = text.split(/\s+/);
  return words.map((w, i) => (own.has(w.replace(/[^a-z0-9.]/g, "")) && others.has((words[i + 1] ?? "").replace(/[^a-z0-9.]/g, "").replace(/e?s$/, "")) && !own.has((words[i + 1] ?? "").replace(/[^a-z0-9.]/g, "").replace(/e?s$/, "")) ? "_" : w)).join(" ");
}

function named(scope: ScopeDraftV1, role: RoleSpec, roles: RoleSpec[]): boolean {
  const changes = withoutModifiers(fold(scope.requested_changes.join(" | ")), role, roles);
  const byModel = !!role.model && compact(changes).includes(compact(role.model));
  const byDevice = (r: RoleSpec, c: string) => deviceTerms(r).some((t) => hasWord(c, t)) || (r.count_terms ?? []).some((t) => hasWord(c, fold(t)));
  // A change that names only the brand ("add Control4") names the role; one that also names another device doesn't.
  const byBrand = scope.requested_changes.map(fold).some(
    (c) => roleTerms(role).some((t) => BRANDS.has(t) && hasWord(c, t)) && !roles.some((r) => r !== role && byDevice(r, c)),
  );
  return byModel || byDevice(role, changes) || byBrand || statedQuantity(scope, role, roles) !== null;
}

/**
 * Whether the request names this role itself (its label, count terms or mention
 * terms, or a stated count), not just its kind of equipment: "floodlight
 * cameras" names the floodlight camera, not the turret.
 */
function namedSpecifically(scope: ScopeDraftV1, role: RoleSpec, roles: RoleSpec[]): boolean {
  let changes = fold(scope.requested_changes.join(" | "));
  const others = roles.filter((x) => x !== role && role.alternative_group && x.alternative_group === role.alternative_group);
  const termsOf = (r: RoleSpec) => [r.label, ...(r.mentions ?? []), ...(r.count_terms ?? [])].map(fold);
  // This role's own phrases that contain another alternative's ("Sonos Amp Multi" holds "Sonos Amp") are kept whole while those are taken out.
  const otherTerms = others.flatMap(termsOf);
  const kept: string[] = [];
  for (const o of termsOf(role).filter((o) => otherTerms.some((t) => t !== o && o.includes(t))).sort((a, b) => b.length - a.length)) {
    changes = changes.replace(new RegExp(`\\b${escape(o)}(s|es)?\\b`, "g"), (m) => ` \u0000${kept.push(m) - 1}\u0000 `);
  }
  // Another alternative's words, and the words right after them, describe that alternative: an "articulating TV mount" is not the tilt "TV mount".
  for (const t of otherTerms) changes = changes.replace(new RegExp(`\\b${escape(t)}(s|es)?\\b(\\s+[\\w-]+){0,2}`, "g"), " ");
  changes = changes.replace(/\u0000(\d+)\u0000/g, (_, i: string) => kept[Number(i)]!);
  return (
    [role.label, ...(role.mentions ?? [])].some((t) => changes.includes(fold(t))) ||
    (role.count_terms ?? []).some((t) => hasWord(changes, fold(t))) ||
    statedQuantity(scope, role, roles) !== null
  );
}

/** The request names the device itself: its label, model, count terms or a stated count, not a word it is merely mentioned by. */
function namedExplicitly(scope: ScopeDraftV1, role: RoleSpec, roles: RoleSpec[]): boolean {
  const changes = requestTexts(scope);
  return (
    modelNamed(scope, role) ||
    changes.some((c) => c.includes(fold(role.label)) || (role.count_terms ?? []).some((t) => hasAllWords(c, fold(t)))) ||
    statedQuantity(scope, role, roles) !== null
  );
}

/** Named explicitly, or by one of its own device words as a whole word ("add a PoE switch", "a WattBox"). */
function namesItself(scope: ScopeDraftV1, role: RoleSpec, roles: RoleSpec[]): boolean {
  const words = [...(role.retained_match ?? []), ...(role.mentions ?? [])].map(fold).filter((t) => !BRANDS.has(t));
  return namedExplicitly(scope, role, roles) || requestTexts(scope).some((c) => words.some((t) => hasWord(c, t)));
}

/**
 * The request names this role as one thing ("replace the amplifier", "an amp")
 * and never as several ("amps", "2 amplifiers"). A role whose default is a
 * minimum of several is then priced as one; "a camera system" is not one camera.
 */
function namedAsOne(scope: ScopeDraftV1, role: RoleSpec): boolean {
  const text = changes(scope).join(" | ");
  const terms = [...roleTerms(role), ...(role.count_terms ?? []).map(fold)].map(escape);
  const plural = terms.some((t) => new RegExp(`\\b${t}(s|es)\\b`).test(text) || new RegExp(`\\b(\\d+|two|three|four|five|six|several|multiple)\\s+(?:[\\w-]+\\s+){0,2}${t}`).test(text));
  if (plural) return false;
  return terms.some((t) => new RegExp(`\\b(a|an|the|one|single)\\s+(?:[\\w-]+\\s+){0,2}${t}\\b(?!\\s+(system|package|setup|network|zones?))`).test(text));
}

const MOVE = /^(move|moving|relocate|relocating|reinstall|remount)\b/;
const NEW_DEVICE = /\b(new|sell|selling|provide[sd]?|supply|supplied|purchase|buy|livewire)\b/;
// Inches written as two apostrophes count too: Zack's Britt intake has "55’’ Outdoor rated TV" (2026-10-19).
const SIZE = /\b(\d{2,3})\s*(?:-\s*)?(?:inch(?:es)?|in\b\.?|"|”|″|''|’’|′′)/g;

const changes = (scope: ScopeDraftV1) => scope.requested_changes.map(fold);
const moveChanges = (scope: ScopeDraftV1) => changes(scope).filter((c) => MOVE.test(c));
const otherChanges = (scope: ScopeDraftV1) => changes(scope).filter((c) => !MOVE.test(c));

/**
 * The request asks for a new one of this device, even if the customer also has an existing one
 * ("sell a new 75-inch TV", "add 2 more in-ceiling speakers"), or states a count of new ones.
 */
function wantsNew(scope: ScopeDraftV1, role: RoleSpec, roles: RoleSpec[]): boolean {
  const q = statedItem(scope, role, roles);
  // A count asks for a new one of a kept device only when it names the device itself and the request doesn't
  // say the customer supplies it: in "1 Sony ultra slim mount", Sony is the mount's brand, not a new Sony TV.
  if (q && !customerOwned(scope, role) && (!role.retained_match?.length || role.retained_match.some((t) => hasWord(fold(q.item), fold(t))))) return true;
  const more = (c: string, t: string) => new RegExp(`\\b(more|additional|another|extra)\\s+(?:[\\w-]+\\s+){0,2}${escape(t)}`).test(c);
  // "Customer-supplied" is who supplies it, not a sale.
  const sold = (c: string) => NEW_DEVICE.test(c.replace(OWNED_PHRASE, " "));
  // The device's own words, not ones that describe another device ("soundbar mount") or name the customer's
  // ("the existing Sonos Beam"): "New soundbar mount for the existing Sonos Beam" sells a mount, not a soundbar.
  const asks = (c: string, t: string) =>
    new RegExp(`(?<!\\b(?:existing|current|old|their|customer'?s|client'?s)\\s+(?:[\\w-]+\\s+){0,2})${escape(t)}`).test(withoutModifiers(c, role, roles));
  if (otherChanges(scope).some((c) => roleTerms(role).some((t) => asks(c, t) && (sold(c) || more(c, t))))) return true;
  // An outdoor device the request specifies by size ("55'' Outdoor rated TV with cover") is one to sell
  // unless the request says it's the customer's or existing (Zack's Britt job, 2026-10-19: the TV was dropped).
  return outdoorAsked(scope, role) && sizeAsked(scope, role) !== undefined && !customerOwned(scope, role) && !deviceChanges(scope, role).some((c) => EXISTING_ITEM.test(c));
}

/** The other brand the request asks for this device in: a "Requested product" it lists that names the brand and the device. */
function otherBrandAsked(scope: ScopeDraftV1, role: RoleSpec): string | undefined {
  if (!role.other_brands) return undefined;
  const devices = deviceTerms(role).concat((role.count_terms ?? []).map(fold));
  for (const q of scope.unresolved_questions.map(fold)) {
    const m = /^requested product:\s*(.+)$/.exec(q);
    if (!m || !devices.some((d) => hasWord(m[1]!, d.replace(/s$/, "")) || hasWord(m[1]!, d))) continue;
    const brand = role.other_brands.find((b) => hasWord(m[1]!, fold(b)));
    if (brand) return brand;
  }
  return undefined;
}

/** How many existing items matching these terms the request moves ("move the existing TV and soundbar upstairs"). */
function movedCount(scope: ScopeDraftV1, terms: string[]): number {
  return moveChanges(scope).filter((c) => terms.some((t) => c.includes(fold(t)))).length;
}

/** Moved items that need a mount in the new room: not ones the request says already have their own mount. */
function movedNeedingMount(scope: ScopeDraftV1, terms: string[]): number {
  const names = (c: string) => terms.some((t) => c.includes(fold(t)));
  // "The existing TV has its own wall mount", in any change or clause, means no new mount for it.
  const ownMount = /\b(its own|own|existing|current|keeps? (its|the)) (wall |tv |soundbar )?mounts?\b/;
  const clauses = changes(scope).flatMap((c) => c.split(/[;.]|\bbut\b/));
  if (clauses.some((c) => ownMount.test(c) && names(c))) return 0;
  // An exclusion of a mount for the existing device ("new mount for existing soundbar") says the same.
  if (scope.excluded_scope.map(fold).some((x) => /\bmounts?\b/.test(x) && ABOUT_EXISTING.test(x) && names(x))) return 0;
  return moveChanges(scope).filter(names).length;
}

const DEVICE_NOUNS = ["access", "point", "node", "unit", "device", "system", "network", "equipment"];
const BEYOND_COUNT = /\b(additional|extra|more|further|spare|other)\b/;
const FILLER = new Set(["the", "a", "an", "any", "all", "existing", "new", "livewire", "of", "and"]);

/**
 * The request removes this device: an excluded item that names it and little else
 * ("Halo remote", "in-ceiling speakers", "Control4"). A longer exclusion that only
 * mentions it in passing ("TV wall reinforcement") does not remove it.
 */
function excluded(scope: ScopeDraftV1, role: RoleSpec): boolean {
  const terms = [...roleTerms(role), ...(role.count_terms ?? []).map(fold)];
  return scope.excluded_scope.some((raw) => {
    if (role.model && compact(raw) === compact(role.model)) return true;
    const item = fold(raw);
    // "No additional eeros" limits the count ("only need 1 eero"); it doesn't remove the device.
    if (BEYOND_COUNT.test(item)) return false;
    const hit = terms.filter((t) => hasWord(item, t));
    if (!hit.length) return false;
    // Once the item names the role, the role's own words ("eero Pro 7 mesh Wi-Fi") and generic device
    // nouns ("access points", "system") don't count against it: "eero access points" removes the eeros.
    const covered = new Set([...terms.flatMap((t) => t.split(/[\s/-]+/)), ...DEVICE_NOUNS]);
    const rest = item.split(/[\s/-]+/).filter((w) => w && !FILLER.has(w) && !covered.has(w) && !covered.has(w.replace(/e?s$/, "")));
    return rest.length <= 1;
  });
}

/** Words that put a device outside: "75\" full weather outdoor TV", "weatherproof TV on the patio". */
const OUTDOOR = /\b(outdoors?|outside|exterior|weather[- ]?proof|weather[- ]?rated|all[- ]weather|full[- ]weather|full[- ]sun|partial[- ]sun|full[- ]shade|patio|porch|pool ?deck|pergola|terrace|veranda)\b/;

/** The request's changes that name this role's device (its label or retained-equipment terms), for size and placement. */
const deviceChanges = (scope: ScopeDraftV1, role: RoleSpec) =>
  otherChanges(scope).filter((c) => [fold(role.label), ...(role.retained_match ?? []).map(fold)].some((t) => hasWord(c, t)));

/** The request puts this device outside (McGetrick, 2026-10-15: a 75" full-weather outdoor TV was priced as an indoor Sony). */
function outdoorAsked(scope: ScopeDraftV1, role: RoleSpec): boolean {
  return !!role.variants?.length && deviceChanges(scope, role).some((c) => OUTDOOR.test(c));
}

/** An exclusion about the customer's existing devices ("replacement of existing smoke/CO detectors"), not the new ones. */
const ABOUT_EXISTING = /\b(replac\w*|existing|current|old)\b/;

/** The approved record for the size the request names for a new device, if the role has size variants (an outdoor one when it goes outside). */
function variantFor(scope: ScopeDraftV1, role: RoleSpec) {
  const outdoor = outdoorAsked(scope, role);
  const sizes = (outdoor ? deviceChanges(scope, role) : otherChanges(scope)).flatMap((c) => [...c.matchAll(SIZE)].map((m) => Number(m[1])));
  return role.variants?.find((v) => !!v.outdoor === outdoor && v.sizes.some((n) => sizes.includes(n)));
}

/**
 * The approved record the request's words choose for this device ("Sonos Beam" → the Beam and its Sanus WSSBM1-B2),
 * first match in pattern order. An outdoor device takes its outdoor size variant instead.
 */
function wordVariant(scope: ScopeDraftV1, role: RoleSpec) {
  if (!role.word_variants || outdoorAsked(scope, role)) return undefined;
  const sizes = otherChanges(scope).flatMap((c) => [...c.matchAll(SIZE)].map((m) => Number(m[1])));
  const sized = new Set(role.word_variants.flatMap((v) => v.sizes ?? []));
  return role.word_variants.find((v) => {
    const texts = [...requestTexts(scope), ...(v.with_kept ? scope.retained_equipment.map(fold) : [])];
    const said = texts.some((t) => v.words.some((w) => hasWord(t, fold(w))) && (!v.require || v.require.some((r) => hasWord(t, fold(r)))));
    if (!said) return false;
    if (v.sizes) return v.sizes.some((n) => sizes.includes(n));
    return !v.default_size || !sizes.some((n) => sized.has(n));
  });
}

const PORT_WORDS: Record<string, number> = { one: 1, single: 1, two: 2, dual: 2, double: 2, three: 3, triple: 3, four: 4, quad: 4 };
const PORTS = /\b(\d|one|single|two|dual|double|three|triple|four|quad)[- ]?(?:port|gang)\b/g;

/** The record for the port count the request gives this device ("a 2-port Cat6 keystone plate"): the largest one named that has a record. */
function portVariant(scope: ScopeDraftV1, role: RoleSpec) {
  if (!role.port_variants) return undefined;
  const texts = requestTexts(scope).filter((t) => (role.mentions ?? []).some((m) => hasWord(t, fold(m))));
  const named = texts.flatMap((t) => [...t.matchAll(PORTS)].map((m) => PORT_WORDS[m[1]!] ?? Number(m[1])));
  return [...role.port_variants].sort((a, b) => b.ports - a.ports).find((v) => named.includes(v.ports));
}

/** The size the request names for this device, if any. */
function sizeAsked(scope: ScopeDraftV1, role: RoleSpec): number | undefined {
  return deviceChanges(scope, role).flatMap((c) => [...c.matchAll(SIZE)].map((m) => Number(m[1])))[0];
}

/**
 * The role each named catalog product fills: the role its category, name and the
 * request's words match best. A product that fits no role is left out (the
 * pattern's standard prices that job). Several products can fill one role
 * ("a Samsung QN65 and a Sony XR-77"): each is priced on its own line.
 */
function namedForRoles(named: NamedProduct[], roles: RoleSpec[]): Map<string, NamedProduct[]> {
  const byRole = new Map<string, NamedProduct[]>();
  for (const n of named) {
    // The product's own category ("Speakers > Outdoor") says which role it fills, on top of how the request names it.
    const leaf = n.category.split(">").at(-1) ?? "";
    // A role whose D-Tools categories include the product's outranks any word match short of naming the role itself.
    const inCategory = (r: RoleSpec) => (r.categories ?? []).some((c) => n.category.toLowerCase().startsWith(c.toLowerCase()));
    const scores = roles.map((r) => matchScore(`${n.category} ${n.label} ${n.text}`, r) + matchScore(leaf, r) + (inCategory(r) ? 100 : 0));
    const best = Math.max(0, ...scores);
    const role = roles[scores.indexOf(best)];
    if (best > 1 && role) byRole.set(role.role, [...(byRole.get(role.role) ?? []), n]);
  }
  return byRole;
}

/**
 * The request with each named product's own words (its name, model and category)
 * taken out, so they name no other role: "Sonos Amp (Stereo 2-Channel)" doesn't
 * also ask for the Sonos Port that "stereo" names. Other words still count
 * ("a Samsung QN65Q80C and a mount" still names the mount).
 */
function withoutNamedWords(scope: ScopeDraftV1, named: NamedProduct[]): ScopeDraftV1 {
  if (!named.length) return scope;
  const strip = (text: string) => {
    const own = named.filter((n) => compact(text).includes(compact(n.model)));
    if (!own.length) return text;
    const words = new Set(own.flatMap((n) => `${n.label} ${n.model} ${n.category}`.toLowerCase().split(/[^a-z0-9]+/)).filter(Boolean));
    return text
      .split(/\s+/)
      .filter((w) => w && !words.has(w.toLowerCase().replace(/[^a-z0-9]/g, "")) && !own.some((n) => compact(w) && compact(n.model).includes(compact(w)) && compact(w).length > 2))
      .join(" ");
  };
  const meaningful = (t: string) => /[a-z]{3,}/i.test(t.replace(/\b(add|install|replace|new|and|the|with|for)\b/gi, ""));
  return {
    ...scope,
    requested_changes: scope.requested_changes.map(strip).filter(meaningful),
    requested_quantities: scope.requested_quantities.map((q) => ({ ...q, item: strip(q.item) })).filter((q) => meaningful(q.item)),
  };
}

/**
 * Roles whose device the request names with another approved brand ("Klipsch in-ceiling speakers"): that
 * brand's record, as if named by model, so it is sold each at the count stated.
 */
function brandNamed(scope: ScopeDraftV1, roles: RoleSpec[], byModel: NamedProduct[]): Array<[string, NamedProduct]> {
  const skip = (t: string) => byModel.some((n) => compact(t).includes(compact(n.model)));
  const out: Array<[string, NamedProduct]> = [];
  for (const role of roles) {
    for (const v of role.brand_variants ?? []) {
      if (v.market && v.market !== scope.market) continue;
      const text = requestTexts(scope).find((t) => !skip(t) && hasWord(t, fold(v.brand)) && deviceTerms(role).some((d) => hasWord(t, d)));
      if (!text) continue;
      out.push([role.role, { record_id: v.product_id, model: v.model, label: v.label, category: role.categories?.[0] ?? "", text, ...(v.units_per_item ? { units_per_item: v.units_per_item } : {}) }]);
      break;
    }
  }
  return out;
}

/** The stated count is already in pairs ("1 pair of speakers"). */
function pairCounted(scope: ScopeDraftV1, role: RoleSpec, roles: RoleSpec[]): boolean {
  const q = statedItem(scope, role, roles);
  return !!q && /\bpairs?\b/.test(fold(q.item));
}

/** A stated count whose item names this product by model ("2 AN-620-SW-R-24-POE"). */
function statedForProduct(scope: ScopeDraftV1, n: NamedProduct | undefined): number | null {
  if (!n) return null;
  const m = compact(n.model);
  return scope.requested_quantities.find((q) => compact(q.item).includes(m))?.quantity ?? null;
}

export function materialize(stated: ScopeDraftV1, pattern: PatternSpec, namedProducts: NamedProduct[] = []): Selection {
  const original = withoutTotals(stated);
  const retro = retrofit(stated);
  const lines: SelectionLine[] = [];
  const allowances: Selection["allowances"] = [];
  const unresolved: Selection["unresolved"] = [];
  const included: RoleSpec[] = [];
  const blockedRoles = new Set<string>();

  const candidates = pattern.roles.filter((role) => role.systems.some((s) => original.functional_systems.includes(s)));
  // Products the request names by model are priced in the role they fill, and name that role. Their words name nothing else.
  const requested = namedForRoles(namedProducts, candidates);
  // A change that already names a product by model ("Klipsch AW-525 outdoor speakers") is priced as that product, not by brand.
  for (const [role, n] of brandNamed(original, candidates, namedProducts)) if (!requested.has(role)) requested.set(role, [n]);
  const priced = [...requested.values()].flat();
  const scope = withoutNamedWords(original, priced);
  const names = (r: RoleSpec) => requested.has(r.role) || named(scope, r, pattern.roles);
  // An add-on prices only the devices the request names. A pattern it names nothing from (e.g. "add Wi-Fi") is priced whole.
  const addOnRequested = isAddOnRequest(original);
  const addOn = addOnRequested && candidates.some(names);

  // In a group of alternatives (turret vs floodlight cameras), naming any one prices only the ones named.
  const namedGroups = new Set(candidates.filter((r) => r.alternative_group && namedSpecifically(scope, r, pattern.roles)).map((r) => r.alternative_group!));
  const removedRoles = new Set<string>();
  // Roles left out because the request never asked for them (no mention, or the role they serve isn't priced).
  const notAsked = new Set<string>();
  const toVerify: string[] = [];
  const verifyOnly = new Set<string>();
  // Existing equipment the job keeps: nothing to price, its field test is listed to verify.
  const keptRoles = new Set<string>();
  // Roles an add-on prices only for the devices they power: dropped when none of those is priced.
  const poweredOnly = new Set<string>();
  for (const role of candidates) {
    if (role.alternative_group && namedGroups.has(role.alternative_group) && !namedSpecifically(scope, role, pattern.roles)) continue;
    // In an add-on, a role is priced when the request names it or names its own system (smoke detection alongside sensors).
    const ownSystemRequested = role.systems.some((s) => scope.functional_systems.includes(s) && !pattern.applies_when_any.includes(s));
    const products = requested.get(role.role) ?? [];
    const product = products[0];
    // A PoE switch for the wired cameras an add-on prices still comes with them: they need its power (Zack's Bowen-Rees job, 2026-10-23).
    const powersNew =
      !!role.powers && !scope.retained_equipment.some((e) => role.powers!.unless_kept.some((t) => hasWord(fold(e), fold(t)))) && candidates.some((r) => role.powers!.roles.includes(r.role) && names(r));
    if (addOn && !names(role) && !ownSystemRequested && !powersNew) continue;
    if (addOn && powersNew && !names(role)) poweredOnly.add(role.role);
    // A stated count of the device ("3 doors" of contacts) asks for it too, and so does existing alarm
    // gear the rep says stays (it is field-tested before reuse).
    const keptHere = role.critical && !!role.retained_match?.length && scope.retained_equipment.some((e) => role.retained_match!.some((t) => hasWord(fold(e), fold(t))));
    const siblings = siblingPhrases(role, pattern.roles);
    const asked =
      (role.mentions && mentioned(scope, role.mentions, role.mentions_require, siblings)) ||
      (role.asked_by && mentioned(scope, role.asked_by, undefined, siblings)) ||
      statedQuantity(scope, role, pattern.roles) !== null ||
      // A sized device the request sells without a count ("Install 55'' outdoor rated TV with cover").
      (!!role.variants?.length && wantsNew(scope, role, pattern.roles)) ||
      keptHere;
    if ((role.mentions || role.asked_by) && !asked && !modelNamed(scope, role) && !product) {
      notAsked.add(role.role);
      continue;
    }
    // New detectors the rep counts ("2 x smoke/CO detectors upstairs") are priced whatever the answer about existing
    // ones reads as: "replacing none" is not "keep the existing detectors instead" (staging smoke, 2026-10-15).
    if (role.existing_detectors && !(role.existing_detectors as string[]).includes(scope.existing_detectors) && !(role.existing_detectors.includes("none") && statedQuantity(scope, role, pattern.roles) !== null)) continue;
    // An exclusion about the existing devices doesn't remove new ones the rep counts: "replacing none" read as
    // "replacement of existing smoke/CO detectors" is not "no smoke/CO detectors" beside "2 x smoke/CO detectors
    // upstairs" (staging smoke, 2026-10-15). Any other exclusion still wins over a count left from before.
    const aboutNewOnes = { ...scope, excluded_scope: scope.excluded_scope.filter((x) => !ABOUT_EXISTING.test(fold(x))) };
    const countedNew = statedQuantity(scope, role, pattern.roles) !== null;
    // A mount for a moved device: "new mount for existing soundbar" is about the moved one (it keeps its own),
    // not the new soundbar's mount (staging smoke, Green, 2026-10-23).
    if (role.per_moved ? excluded(aboutNewOnes, role) : excluded(scope, role) && (!countedNew || excluded(aboutNewOnes, role))) {
      removedRoles.add(role.role);
      continue;
    }
    included.push(role);

    const retained = role.retained_match?.length
      ? (scope.retained_equipment.find((e) => role.retained_match!.some((t) => fold(e).includes(fold(t)))) ?? customerOwned(scope, role))
      : undefined;
    if (retained && !wantsNew(scope, role, pattern.roles) && !product) {
      // Existing equipment being moved stays the customer's: its mount and labor are priced on the roles that carry it.
      // It is the customer's, like kept equipment: a critical role moved ("relocate the doorbell wiring" for the
      // client's Nest doorbell) no longer blocks the build as supported but unpriced (Ben Khandan-Barani, 2026-10-16).
      if (movedCount(scope, role.retained_match ?? []) > 0) {
        keptRoles.add(role.role);
        continue;
      }
      // Kept equipment is field-tested before it is reused: listed to verify, without withholding the total of what
      // the budget does price (Zack's McGetrick job, 2026-10-15: a kept Control4 controller blanked the total).
      toVerify.push(`${role.label} (retained: ${retained}): existing equipment must be field-tested before it can be reused`);
      keptRoles.add(role.role);
      continue;
    }
    const brand = product ? undefined : otherBrandAsked(scope, role);
    if (brand) {
      toVerify.push(`Requested product: ${brand} ${role.label.replace(/^\S+\s+/, "")} (not Livewire's standard brand for this; priced in the final proposal)`);
      verifyOnly.add(role.role);
      continue;
    }
    if (!product && outdoorAsked(scope, role) && !variantFor(scope, role)) {
      // An outdoor device in a size with no approved outdoor model is listed to price, never priced as the indoor one.
      const size = sizeAsked(scope, role);
      const noun = role.retained_match?.includes("tv") ? "TV" : role.label;
      toVerify.push(`Requested product: ${size ? `${size}" ` : ""}outdoor ${noun} (no Livewire standard outdoor model${size ? " at this size" : ""}; priced in the final proposal)`);
      verifyOnly.add(role.role);
      continue;
    }
    const word = product ? undefined : wordVariant(scope, role);
    if (word && !word.product_id) {
      // Words that name a device Livewire has no standard for (a mount for the customer's Playbar): listed to price, not priced as the standard.
      toVerify.push(`Requested product: ${word.label} (no Livewire standard; priced in the final proposal)`);
      verifyOnly.add(role.role);
      continue;
    }
    if (!role.product_id && !product && role.unpriced === "verify") {
      // Asked for, but Livewire has no standard to price: listed to verify instead of silently becoming something else.
      const said = scope.unresolved_questions.some((q) => /^requested product:/i.test(q) && (role.mentions ?? []).some((t) => hasWord(fold(q), fold(t))));
      if (!said) toVerify.push(`Requested product: ${role.label} (no Livewire standard; priced in the final proposal)`);
      verifyOnly.add(role.role);
      continue;
    }
    if (!role.product_id && !product) {
      unresolved.push({ item: role.label, role: role.role, reason: "no Livewire standard product is configured for this role", escalate: role.critical || role.escalate_if_unresolved });
      blockedRoles.add(role.role);
      continue;
    }
    // A count the requester stated is used as written (speakers as pairs, for a role sold in pairs); otherwise the pattern's quantity (a minimum is verified on site).
    const statedUnits = product ? (statedForProduct(original, product) ?? statedQuantity(scope, role, pattern.roles)) : statedItems(scope, role, pattern.roles);
    // A record sold as a pair takes a count of speakers as pairs: 2 restroom speakers are one PIC-650-T pair (Zack's Biscuit Belly job, 2026-10-19).
    const pairs = product?.units_per_item && statedUnits !== null && !pairCounted(scope, role, pattern.roles);
    const stated = pairs ? Math.ceil(statedUnits! / product!.units_per_item!) : statedUnits;
    const minimum = stated === null && role.quantity.kind === "minimum";
    // Each existing item the request moves needs its own mount (and the mount's install labor) in the new room.
    const moved = stated === null && role.per_moved ? movedNeedingMount(scope, role.per_moved) : 0;
    const verify = minimum && role.quantity.kind === "minimum" ? role.quantity.verify : null;
    const location = scope.room_types.length === 1 ? scope.room_types[0]! : role.location;
    if (products.length > 1) {
      // Each named product is its own line, at the count stated for its model (one when none is).
      for (const n of products) {
        const qty = statedForProduct(original, n);
        lines.push({
          role: role.role,
          record_id: n.record_id,
          quantity: qty ?? 1,
          quantity_basis: "fixed",
          verify: null,
          location,
          precedent: role.precedent,
          ...(n.record_id !== role.product_id ? { requested_model: n.model } : {}),
        });
      }
      continue;
    }
    // "The amplifier" is the rep's own count of one, like a stated count: nothing left to verify.
    const asOne = minimum && role.quantity.qty > 1 && namedAsOne(scope, role);
    // A fished drop is terminated at both ends: two jacks per drop, each with its install time (2 h a retrofit drop).
    const perUnit = retro && role.retrofit_units && !product ? role.retrofit_units.units : 1;
    const baseVerify = asOne ? null : moved && verify ? `${verify}; includes ${moved} for moved existing equipment (confirm wall and power in the new room)` : verify;
    lines.push({
      role: role.role,
      record_id:
        product?.record_id ??
        word?.product_id ??
        portVariant(scope, role)?.product_id ??
        variantFor(scope, role)?.product_id ??
        largerTvVariant(original, role, pattern)?.product_id ??
        marketVariant(scope, role)?.product_id ??
        role.product_id!,
      quantity: ((stated ?? (asOne ? 1 : role.quantity.qty)) + moved) * perUnit,
      quantity_basis: minimum && !asOne ? "minimum_to_verify" : "fixed",
      verify: perUnit > 1 ? [baseVerify, role.retrofit_units!.verify].filter(Boolean).join("; ") : baseVerify,
      // A single-room scope places devices in that room; otherwise use the pattern's location.
      location,
      precedent: role.precedent,
      ...(product && product.record_id !== role.product_id ? { requested_model: product.model } : {}),
    });
  }

  // A count for one device of a group ("only need 1 eero") is the group's count: the others it only mentioned in passing go.
  const counted = (r: RoleSpec) => statedQuantity(scope, r, pattern.roles) !== null || (requested.get(r.role) ?? []).some((n) => statedForProduct(original, n) !== null);
  for (const role of included) {
    if (!role.count_group || role.critical || requested.has(role.role) || namedExplicitly(scope, role, pattern.roles)) continue;
    if (included.some((r) => r !== role && r.count_group === role.count_group && counted(r))) notAsked.add(role.role);
  }
  // A floodlight camera and a doorbell take no switch: one an add-on priced for wired cameras goes when none is priced.
  for (const role of included) {
    if (poweredOnly.has(role.role) && !lines.some((l) => role.powers!.roles.includes(l.role))) notAsked.add(role.role);
  }
  // On any job, a switch the request doesn't name goes when the customer keeps what powers the cameras, or the cameras
  // it would power are another brand's, listed to price (Zack's Jinny's job, 2026-10-26: a PoE switch beside the Luma NVR they keep).
  for (const role of included) {
    if (!role.powers || requested.has(role.role) || namesItself(scope, role, pattern.roles)) continue;
    const kept = scope.retained_equipment.some((e) => role.powers!.unless_kept.some((t) => hasWord(fold(e), fold(t))));
    const otherBrand = role.powers.roles.some((r) => verifyOnly.has(r)) && !lines.some((l) => role.powers!.roles.includes(l.role));
    if (kept || otherBrand) notAsked.add(role.role);
  }
  // Gear that serves another role (a switch for the eero network) is priced only with it, unless the request names it itself.
  for (let changed = true; changed; ) {
    changed = false;
    for (const role of included) {
      if (notAsked.has(role.role) || !role.with_roles || requested.has(role.role) || namesItself(scope, role, pattern.roles)) continue;
      if (role.with_roles.some((w) => included.some((r) => r.role === w && !notAsked.has(w)))) continue;
      notAsked.add(role.role);
      changed = true;
    }
  }
  if (notAsked.size) {
    for (let i = lines.length - 1; i >= 0; i--) if (notAsked.has(lines[i]!.role)) lines.splice(i, 1);
    for (let i = unresolved.length - 1; i >= 0; i--) if (unresolved[i]!.role && notAsked.has(unresolved[i]!.role!)) unresolved.splice(i, 1);
    included.splice(0, included.length, ...included.filter((r) => !notAsked.has(r.role)));
  }

  // Roles counted from others (a card per camera) take those roles' priced units, unless the request stated their own count.
  for (const line of lines) {
    const role = pattern.roles.find((r) => r.role === line.role);
    if (!role?.quantity_follows || statedQuantity(scope, role, pattern.roles) !== null || line.requested_model) continue;
    const followed = lines.filter((l) => role.quantity_follows!.includes(l.role));
    // Units of what it follows, not items: a retrofit drop's two jacks are one drop.
    const units = followed.reduce((n, l) => n + l.quantity / (retro ? (pattern.roles.find((r) => r.role === l.role)?.retrofit_units?.units ?? 1) : 1), 0);
    // A 12-port panel per 12 drops; a 2-port plate per 2.
    const per = role.port_variants?.find((v) => v.product_id === line.record_id)?.ports ?? role.follows_per ?? 1;
    // A mount per new TV, plus one per existing TV the request moves (Zack's Paulenich job, 2026-10-26: 2 TVs, 1 mount).
    // With no new TV, the moved ones are all the mounts: one moved TV is one mount (Zack's Young job, 2026-10-26: 2).
    const moved = role.per_moved ? movedNeedingMount(scope, role.per_moved) : 0;
    if (units > 0 || moved > 0) {
      line.quantity = Math.ceil(Math.round((units / per) * 1000) / 1000) + moved;
      // Plates go one per outlet location, which the drops don't say: always a minimum to verify.
      const toCheck = !!role.port_variants && role.quantity.kind === "minimum";
      line.quantity_basis = toCheck ? "minimum_to_verify" : "fixed";
      line.verify = toCheck && role.quantity.kind === "minimum" ? role.quantity.verify : null;
    }
  }

  // Amplifiers follow the speakers they drive (Henry, 2026-10-12), once the request asks for speakers or counts existing ones.
  for (const line of lines) {
    const role = pattern.roles.find((r) => r.role === line.role);
    if (!role?.drives || line.requested_model || statedQuantity(scope, role, pattern.roles) !== null) continue;
    const driven = pattern.roles.filter((r) => role.drives!.roles.includes(r.role));
    const existing = driven.reduce((n, r) => n + retainedUnits(scope, r, pattern.roles), 0);
    if (!existing && !driven.some((r) => included.includes(r) && names(r))) continue;
    const speakerLines = lines.filter((l) => role.drives!.roles.includes(l.role));
    // A pair is two speakers (the standard, or a brand's pair record); a named product in its place is sold each.
    const perItem = (l: SelectionLine) => {
      const r = driven.find((x) => x.role === l.role)!;
      if (l.record_id === r.product_id || r.variants?.some((v) => v.product_id === l.record_id)) return r.units_per_item ?? 1;
      return r.brand_variants?.find((v) => v.product_id === l.record_id)?.units_per_item ?? 1;
    };
    const speakers = speakerLines.reduce((n, l) => n + l.quantity * perItem(l), 0) + existing;
    if (!speakers) continue;
    const market = marketVariant(scope, role);
    const per = market?.speakers_per_unit ?? role.drives.speakers_per_unit;
    // One per room as well, on the standard (a commercial 70V amplifier runs every room on one line).
    const rooms = role.drives.per_room && !market ? speakerRooms(scope, driven) : 0;
    const toCheck = speakerLines.some((l) => l.quantity_basis === "minimum_to_verify");
    line.quantity = Math.max(Math.ceil(speakers / per), rooms);
    line.quantity_basis = toCheck ? "minimum_to_verify" : "fixed";
    line.verify = toCheck ? `one amplifier per ${per} speakers${rooms > 1 ? ` and at least one per room (${rooms} rooms)` : ""}; ${speakers} speakers so far` : null;
  }

  // One product priced by two combined patterns (the network's PoE switch and the cameras') is one line, at
  // the larger count, or the rep's own count (Zack's Britt and Bowen-Rees jobs, 2026-10-13).
  const merged = new Set<string>();
  const roleOf = (l: SelectionLine) => pattern.roles.find((r) => r.role === l.role)!;
  for (let i = 0; i < lines.length; i++) {
    for (let j = lines.length - 1; j > i; j--) {
      const [a, b] = [lines[i]!, lines[j]!];
      if (a.record_id !== b.record_id || a.role === b.role) continue;
      const stated = [a, b].find((l) => statedQuantity(scope, roleOf(l), pattern.roles) !== null);
      const keep = stated ?? (b.quantity > a.quantity ? b : a);
      Object.assign(a, { quantity: keep.quantity, quantity_basis: keep.quantity_basis, verify: keep.verify });
      lines.splice(j, 1);
      merged.add(b.role);
    }
  }
  if (merged.size) included.splice(0, included.length, ...included.filter((r) => !merged.has(r.role) || lines.some((l) => l.role === r.role)));

  // A device that needs another the budget doesn't price (an eero access point with no eero router) says what to check.
  for (const role of included) {
    const w = role.verify_without;
    if (w && lines.some((l) => l.role === role.role) && !lines.some((l) => w.roles.includes(l.role)) && !toVerify.includes(w.verify)) toVerify.push(w.verify);
  }

  const devices = lines.reduce((n, l) => n + l.quantity, 0);
  // Labor-only allowances the request mentions (framing a niche), priced as hours at the pattern's labor rate.
  const extras = (pattern.labor_extras ?? []).filter((x) => mentioned(scope, x.mentions)).map((x) => x.id);
  // Hours the rep set in a revision replace the estimate.
  const hours = !pattern.labor ? 0 : (scope.labor_hours ?? (devices > 0 ? laborHoursFor(pattern, lines, addOn, extras) : 0));
  const labor: Selection["labor"] =
    pattern.labor && hours > 0
      ? { labor_type: pattern.labor.labor_type, hours, devices, covers: pattern.labor.covers, extras, ...(scope.labor_hours ? { set_by_rep: true } : {}) }
      : null;

  const services: Selection["services"] = [];
  for (const category of scope.service_categories) {
    // Services the pattern's labor estimate includes are never priced separately, even when no labor is needed.
    if ((labor ?? pattern.labor)?.covers.includes(category)) continue;
    const spec = pattern.services.find((s) => s.category === category);
    if (spec?.product_id) services.push({ category, record_id: spec.product_id, quantity: 1 });
    else allowances.push({ label: spec?.label ?? category, reason: "no authenticated price; shown as a TBD allowance outside committed totals" });
  }

  // Out-of-pattern work the request asks for, in its changes or as a system no role covers: one allowance per template.
  const uncovered = scope.functional_systems.filter((system) => !candidates.some((r) => r.systems.includes(system)));
  const laborAllowances = allowancesFor(pattern.allowances ?? [], scope, uncovered.map(fold), lines);
  // A mount rated for smaller or larger TVs than the one the request gives is listed to confirm, never silently
  // priced as fitting: the Strong SM-CS-ART2-L is rated 37-70" and McGetrick's TV is 75" (Zack, 2026-10-19).
  const tvRole = pattern.roles.find((r) => r.role === "television");
  const tvInches = tvRole && sizeAsked(original, tvRole);
  for (const role of pattern.roles) {
    const fits = role.fits_tv_inches;
    if (!fits || !tvInches || (tvInches >= fits[0] && tvInches <= fits[1]) || !lines.some((l) => l.role === role.role && l.record_id === role.product_id)) continue;
    toVerify.push(`${role.label} is rated for ${fits[0]}-${fits[1]}" TVs and the TV is ${tvInches}": confirm a mount rated for it`);
  }
  // A commercial audio job prices no music source unless asked: most of Livewire's JBL commercial quotes play from the
  // client's own device (a Sonos Port on 4 of 43). Ask what plays the music instead (Henry, 2026-10-19).
  const source = pattern.roles.find((r) => r.role === "streaming_port");
  const audio = lines.some((l) => pattern.roles.find((r) => r.role === l.role)?.systems.includes("whole_home_audio"));
  if (source && scope.market === "commercial" && audio && !lines.some((l) => l.role === source.role)) {
    toVerify.push("Music source: none is priced; confirm what plays the music (the client's phone, POS or music service, or a Sonos Port)");
  }
  // The cable runs the budget prices are the job's wiring: a "prewire" service with no price of its own
  // doesn't also withhold the total (Zack's Britt job, 2026-10-19: "TBD allowance: prewire").
  if (laborAllowances.some((a) => a.key === "wiring_run")) {
    const prewire = pattern.services.find((s) => s.category === "prewire");
    for (let i = allowances.length - 1; i >= 0; i--) if (!prewire?.product_id && allowances[i]!.label === (prewire?.label ?? "prewire")) allowances.splice(i, 1);
  }

  // A system whose devices the request removed entirely is no longer required.
  const removedSystems = scope.functional_systems.filter(
    (system) => !included.some((r) => r.systems.includes(system)) && candidates.some((r) => r.systems.includes(system) && removedRoles.has(r.role)),
  );
  const requirements: Selection["requirements"] = scope.functional_systems.map((system) => {
    if (removedSystems.includes(system)) return { system, classification: "removed", roles: [], note: "every device removed by the request" };
    // Kept equipment is listed to verify, not priced: it is no role of the budget's.
    const kept = included.filter((r) => r.systems.includes(system) && keptRoles.has(r.role));
    const roles = included.filter((r) => r.systems.includes(system) && !keptRoles.has(r.role));
    const ownRoles = candidates.filter((r) => r.systems.includes(system));
    if (!roles.length && kept.length) return { system, classification: "allowance", roles: [], note: `existing equipment kept: ${kept.map((r) => r.label).join(", ")}` };
    if (!roles.length && ownRoles.length && ownRoles.every((r) => notAsked.has(r.role) || removedRoles.has(r.role))) {
      // Every device of the system is optional gear the request never asked for (no Wi-Fi asked on a camera job): nothing to price.
      return { system, classification: "removed", roles: [], note: "no device of this system was asked for" };
    }
    // Work no role covers but an allowance template does (a conduit run) is priced as labor hours, not escalated.
    const allowance = laborAllowances.find((a) => a.texts.includes(fold(system)));
    if (!roles.length && allowance) return { system, classification: "allowance", roles: [], note: `allowance: ${allowance.label}` };
    if (!roles.length) {
      unresolved.push({ item: system, role: null, reason: `not covered by the ${pattern.title} pattern`, escalate: true });
      return { system, classification: "unresolved", roles: [], note: "no approved pattern role" };
    }
    const blockedCritical = roles.filter((r) => r.critical && blockedRoles.has(r.role));
    if (blockedCritical.length) {
      return { system, classification: "unresolved", roles: roles.map((r) => r.role), note: `unresolved: ${blockedCritical.map((r) => r.label).join(", ")}` };
    }
    const priced = roles.filter((r) => !blockedRoles.has(r.role) && !verifyOnly.has(r.role));
    if (!priced.length && roles.some((r) => verifyOnly.has(r.role))) {
      return { system, classification: "allowance", roles: roles.map((r) => r.role), note: `requested product to price: ${roles.filter((r) => verifyOnly.has(r.role)).map((r) => r.label).join(", ")}` };
    }
    return { system, classification: priced.length ? "supported" : "unresolved", roles: roles.map((r) => r.role), note: priced.map((r) => r.capability).join("; ") };
  });

  return {
    schema: "selection_v1",
    pattern: pattern.pattern,
    pattern_version: pattern.version,
    add_on: addOn,
    ...(retrofit(stated) ? { retrofit: true } : {}),
    lines,
    services,
    labor,
    parts: pattern.parts && lines.length ? { record_id: pattern.parts.product_id } : null,
    requirements,
    allowances,
    unresolved,
    labor_allowances: laborAllowances.map((a) => ({
      key: a.key,
      label: a.label,
      hours: allowanceHours(a, a.quantity, a.feet, a.trenched),
      labor_type: a.labor_type,
      ...(a.quantity > 1 ? { quantity: a.quantity } : {}),
      ...(a.feet ? { feet: a.feet } : {}),
      ...(a.trenched ? { trenched: true as const } : {}),
    })),
    to_verify: toVerify,
  };
}

/**
 * The allowance templates the request (each change and stated count, and each system no role covers)
 * asks for, in file order, with the texts that asked. Each is priced once, or, when the template is
 * counted, once per stated unit or per change that asks ("Ethernet port in the dining room", "… in the living room").
 */
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, a: 1, single: 1, dual: 2, twin: 2 };
const FEET = /\b(\d{1,3}(?:,\d{3})*|\d+)\s*(?:-\s*)?(?:ft\b\.?|feet\b|foot\b|'(?!s|'))/g;

/** A depth is not a length: "hand trenching 1ft down" (Zack's Crowder job, 2026-10-19). */
const DEPTH_AFTER = /^\s*(?:down|deep|depth|below|under(?:ground)?)\b/;
const DEPTH_BEFORE = /\b(?:depth of|deep|down)\s*$/;
/** Material by the stick: "12 - 10ft sticks of 3/4 conduit" is 120 ft (Zack's Crowder job, 2026-10-19). */
// The count and the length are apart ("12 - 10ft", "12 10ft"): "10ft sticks" alone is not 1 stick of 0 ft (Crowder, 2026-10-23).
const STICKS = /\b(\d{1,3})(?:\s*(?:-|x|×)\s*|\s+)(\d{1,3})\s*(?:-\s*)?(?:ft\b\.?|feet\b|foot\b|'(?!s|'))\s*(?:long\s+)?(?:sticks?|lengths?|pieces?|sections?)\b/g;

/** The length one change gives: the sticks it counts, else the longest length that isn't a depth. */
function lengthIn(text: string): { feet: number; sticks: boolean; material?: string } {
  const counted = [...text.matchAll(STICKS)];
  const sticks = counted.reduce((n, m) => n + Number(m[1]) * Number(m[2]), 0);
  // What the sticks are ("of 3/4 conduit for data"), so the same material stated twice is counted once.
  if (sticks) return { feet: sticks, sticks: true, material: text.slice(counted.at(-1)!.index! + counted.at(-1)![0].length).trim() };
  const lengths = [...text.matchAll(FEET)]
    .filter((m) => !DEPTH_AFTER.test(text.slice(m.index! + m[0].length)) && !DEPTH_BEFORE.test(text.slice(0, m.index)))
    .map((m) => Number(m[1]!.replace(/,/g, "")));
  return { feet: Math.max(0, ...lengths), sticks: false };
}

/**
 * The length a change gives for this work, times the runs it names: "120 ft of hand trench" is 120 ft;
 * "two conduits … 120 ft" is 240 ft of conduit. The longest length any asking text gives, so a length
 * repeated across changes is counted once; material counted by the stick adds up across changes
 * ("12 sticks for data", "12 sticks for electrical"). `run` is the longest single run.
 */
function feetAsked(texts: string[], mentions: string[]): { feet: number; run: number } | undefined {
  let best = 0;
  // Sticks by material: a change and a stated count of the same sticks are one length, data and electrical two.
  const sticks = new Map<string, number>();
  let run = 0;
  for (const t of texts) {
    const l = lengthIn(t);
    if (!l.feet) continue;
    run = Math.max(run, l.feet);
    if (l.sticks) sticks.set(l.material!, Math.max(sticks.get(l.material!) ?? 0, l.feet));
    else best = Math.max(best, l.feet * runsIn(t, mentions));
  }
  const feet = Math.max(best, [...sticks.values()].reduce((n, f) => n + f, 0));
  return feet ? { feet, run } : undefined;
}

/** How many runs a change names for this work ("two conduits", "2 conduit runs"); 1 when it names no number. */
function runsIn(text: string, mentions: string[]): number {
  return Math.max(
    1,
    ...mentions.map((w) => {
      // A pipe size is not a count: "3/4 conduit" is one conduit (Zack's Crowder job, 2026-10-19).
      const m = new RegExp(`(?<![\\d/])\\b(\\d+|${Object.keys(NUMBER_WORDS).join("|")})(?![\\d/])\\s+(?:[\\w-]+\\s+){0,2}${escape(fold(w))}(?:s|es)?\\b`).exec(text);
      // "50 ft of conduit" is a length, not 50 conduits.
      if (!m || /\b(ft|feet|foot|inch|inches)\b|'|"/.test(m[0])) return 1;
      return Number(m[1]) || NUMBER_WORDS[m[1]!] || 1;
    }),
  );
}

/** A wall port or jack, not a run: "ethernet ports", "data jack". */
const WALL_PORT = /\b(ports?|jacks?|outlets?|plates?)\b/;

/** A stated count of sticks ("10ft sticks of 3/4 conduit", 12): written with its count, so the sticks add up to their length. */
const STICK_ITEM = /^\s*\d{1,3}\s*(?:-\s*)?(?:ft\b\.?|feet\b|foot\b|')\s*(?:long\s+)?(?:sticks?|lengths?|pieces?|sections?)\b/i;

/** The request's changes and stated counts, as allowance texts: a count of sticks keeps its count (Zack's Crowder job, 2026-10-23). */
const allowanceTexts = (scope: ScopeDraftV1) => [...scope.requested_changes, ...scope.requested_quantities.map((q) => (STICK_ITEM.test(q.item) ? `${q.quantity} - ${q.item}` : q.item))].map(fold);

function allowancesFor(templates: AllowanceSpec[], scope: ScopeDraftV1, uncovered: string[], lines: SelectionLine[]): Array<AllowanceSpec & { texts: string[]; quantity: number; feet?: number; trenched?: true }> {
  const any = (t: string, words?: string[]) => !!words?.some((w) => hasWord(t, fold(w)));
  const found = templates.flatMap((a) => {
    if (a.covered_by_systems?.some((s) => scope.functional_systems.includes(s))) return [];
    const asks = (t: string) => any(t, a.mentions) && (!a.require || any(t, a.require)) && !any(t, a.exclude);
    const fromRequest = allowanceTexts(scope).filter(asks);
    const asking = [...fromRequest, ...uncovered].filter(asks);
    if (!asking.length) return [];
    const stated = scope.requested_quantities.filter((q) => asks(fold(q.item))).reduce((n, q) => n + q.quantity, 0);
    const changes = new Set(scope.requested_changes.map(fold).filter(asks)).size;
    // The wired access point's own drop (Zack's Britt job, 2026-10-15: 4 Ethernet ports and a PoE access point are 5 runs).
    // A count of wall ports ("4 Ethernet ports") leaves the access point's drop out; a count of drops or runs may include it (2026-10-23).
    const countsDrops = scope.requested_quantities.some((q) => asks(fold(q.item)) && !WALL_PORT.test(fold(q.item)));
    const forRoles = countsDrops ? 0 : lines.filter((l) => a.per_role?.includes(l.role)).reduce((n, l) => n + l.quantity, 0);
    // Work sized by length ("120 ft of hand trench") at the template's per-foot rate (Crowder, 2026-10-15).
    const length = a.hours_per_foot ? feetAsked(asking, a.mentions) : undefined;
    return [{ ...a, texts: asking, asked: fromRequest.length > 0, run: length?.run, quantity: a.counted ? Math.max(1, (stated || changes) + forRoles) : 1, ...(length ? { feet: length.feet } : {}) }];
  });
  // A trench the request asks for without a length runs as far as the conduit laid in it
  // ("hand trench 1ft down along the same lines", "12 - 10ft sticks of conduit"): Zack's Crowder job, 2026-10-19.
  const sized = found.map((t) => {
    if (t.feet || !t.asked || !t.hours_per_foot) return t;
    const laid = found.find((a) => a.in_trench?.trench === t.key && a.run);
    return laid ? { ...t, feet: laid.run! } : t;
  });
  // Conduit laid in the request's trench runs the trench's length, once per conduit, at the in-trench rate:
  // Crowder's 120 ft trench with two conduits is 240 ft of conduit at 0.05 h/ft (Henry, 2026-10-15).
  // Conduit counted by the stick is the length laid, when it is more.
  return sized.map(({ asked: _asked, run: _run, ...a }) => {
    const trench = a.in_trench && sized.find((t) => t.key === a.in_trench!.trench);
    if (!trench?.feet) return a;
    const runs = Math.max(1, ...a.texts.map((t) => runsIn(t, a.mentions)));
    const own = feetAsked(a.texts.filter((t) => lengthIn(t).sticks), a.mentions)?.feet ?? 0;
    return { ...a, feet: Math.max(trench.feet * runs, own), trenched: true as const };
  });
}

/**
 * The mount for a TV larger than the standard is rated for: Sanus VLF628-B1 (46-90") indoors and the
 * Sanus VODLF125-B2 (40-85") outdoors over 70", in place of the Strong ART2-L (37-70") (Henry, 2026-10-19).
 * An outdoor TV gets the outdoor mount at any size it fits: Britt's 55" outdoor TV was on the indoor Strong
 * mount while McGetrick's got the Sanus outdoor one (Zack, 2026-10-23).
 */
function largerTvVariant(scope: ScopeDraftV1, role: RoleSpec, pattern: PatternSpec) {
  const tv = pattern.roles.find((r) => r.role === "television");
  const inches = tv && sizeAsked(scope, tv);
  if (!role.fits_tv_inches || !inches) return undefined;
  const outdoor = !!tv && outdoorAsked(scope, tv);
  if (!outdoor && inches <= role.fits_tv_inches[1]) return undefined;
  return role.larger_tv_variants?.find((v) => !!v.outdoor === outdoor && inches >= v.fits_tv_inches[0] && inches <= v.fits_tv_inches[1]);
}

/** The role's approved record for the job's market (a 70V amplifier on a commercial job), if it has one. */
function marketVariant(scope: ScopeDraftV1, role: RoleSpec) {
  return role.market_variants?.find((v) => v.market === scope.market);
}

/** Existing units the request counts for this role ("5 existing in-ceiling speakers"), from its stated counts or the retained list. */
function retainedUnits(scope: ScopeDraftV1, role: RoleSpec, roles: RoleSpec[]): number {
  const best = (text: string) => {
    const scores = roles.map((r) => matchScore(text, r));
    const top = Math.max(...scores);
    return top > 0 ? roles[scores.indexOf(top)] : undefined;
  };
  const stated = scope.requested_quantities.filter((q) => EXISTING_ITEM.test(fold(q.item)) && best(q.item) === role).reduce((n, q) => n + q.quantity, 0);
  if (stated) return stated;
  // "5 existing in-ceiling speakers" in the retained list; a size ("65-inch") is not a count.
  return scope.retained_equipment
    .filter((e) => (role.retained_match ?? []).some((t) => hasWord(fold(e), fold(t))) && best(e) === role)
    .reduce((n, e) => n + Number(/^\D*?\b(\d{1,3})\b(?!\s*(-\s*)?(inch|in\b|"|”|″|ft|feet|'))/.exec(e)?.[1] ?? 0), 0);
}
