import { isAddOnRequest, type Device, type ScopeDraftV1 } from "@sd/core";
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
  /** Another brand the request names for this system (UniFi): the line is Livewire's standard as a stand-in for it. */
  equivalent_of?: string;
  /** The requested product the line holds the place of ("UniFi G6 Bullet camera"), priced at Livewire's equivalent (Henry, 2026-11-03). */
  placeholder_for?: string;
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
  /** Devices the customer supplies that the job installs (their UniFi access points): labor, no equipment price. */
  installed?: Array<{ role: string; quantity: number }>;
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
  /** Equipment the rep prices as a dollar allowance ("a $1,000 placeholder for the turntable"; Henry, 2026-11-07). */
  equipment_allowances?: Array<{ label: string; amount_cents: number }>;
  /** Requested products with no Livewire standard (a TV cart), listed to verify and priced in the final proposal. */
  to_verify: string[];
  /** Roles listed to price in to_verify instead of priced (another brand's cameras): accounted for, not unresolved. */
  listed?: string[];
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
  // The open questions count: the interpreter put Giessel's "via the bath/laundry plumbing chase" there (Zack, 2026-10-30).
  const texts = [scope.project_type ?? "", ...scope.requested_changes, ...scope.unresolved_questions].map(fold);
  if (texts.some((t) => NEW_CONSTRUCTION.test(t))) return false;
  // An upgrade of a lived-in home, or one with equipment already in it, is wired through finished walls
  // (Zack, 2026-11-05: Bennett's and Hansen's single drops in existing homes were priced and titled as a prewire).
  const existingHome = EXISTING_HOME.test(fold(scope.project_type ?? "")) || scope.existing_equipment_disposition === "described";
  return existingHome || texts.some((t) => RETROFIT.test(t));
}
const EXISTING_HOME = /\b(upgrade|retro-?fit|renovat\w*|remodel\w*|existing|update|refresh|replacement)\b/;

/** The request's own words, one entry per change or stated count. System names and rooms are not requests ("Patio" is not outdoor Wi-Fi). */
const requestTexts = (scope: ScopeDraftV1) => [...scope.requested_changes, ...scope.requested_quantities.map((q) => q.item)].map(fold);

/**
 * The request mentions one of these terms as a whole word ("arc" is not "search").
 * With `require`, the same change must also name one of those ("outdoor" counts for
 * an eero only beside Wi-Fi words, not in "outdoor PoE cameras").
 */
function mentioned(scope: ScopeDraftV1, terms: string[], require?: string[], without: string[] = [], unless?: { words: string[]; unless_also: string[] }): boolean {
  const strip = (t: string) => without.reduce((x, p) => x.replace(new RegExp(`\\b${escape(p)}(s|es)?\\b`, "g"), " "), t);
  const about = (t: string) => !unless || !unless.words.some((w) => hasWord(t, fold(w))) || unless.unless_also.some((w) => hasWord(t, fold(w)));
  return requestTexts(scope)
    .filter(about)
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
// TV makers too: a "Sony ultra slim mount" is a mount, not a Sony TV (staging smoke, Baker, 2026-11-06).
const BRANDS = new Set(["control4", "c4", "lutron", "sonos", "alarm.com", "sony", "bravia", "samsung", "lg"]);

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

/** The role a device or count names most specifically, if any. */
function roleNamed(text: string, roles: RoleSpec[]): RoleSpec | undefined {
  const scores = roles.map((r) => matchScore(text, r));
  const best = Math.max(0, ...scores);
  return best > 0 ? roles[scores.indexOf(best)] : undefined;
}

const deviceItem = (d: Device) => (d.room ? `${d.item} (${d.room})` : d.item);

/**
 * The scope with its device list as the counts and kept equipment, for the roles the list names: Livewire's new
 * devices become the stated counts, the customer's existing ones the kept equipment. The sentences' own counts and
 * kept items stay for roles the list doesn't name (an Ethernet port, which is no device of the list). Customer-supplied
 * new devices are left to suppliedRoles: installed, not sold (Henry, 2026-11-06).
 */
function withDevices(scope: ScopeDraftV1, roles: RoleSpec[]): ScopeDraftV1 {
  const devices = scope.devices ?? [];
  if (!devices.length) return scope;
  const listed = new Set(devices.map((d) => roleNamed(d.item, roles)?.role).filter((r): r is string => !!r));
  const unlisted = (text: string) => {
    const r = roleNamed(text, roles);
    return !r || !listed.has(r.role);
  };
  // A generic "wall mount" × 2 in a room with one TV and a soundbar is the TV's mount and the soundbar's, not two TV
  // mounts: a room's TV-mount count stops at its TVs (staging smoke, Green, 2026-11-07: "wall mount (fitness room) × 2").
  const room = (d: Device) => (d.room ?? "").toLowerCase();
  const tvMount = (r: RoleSpec | undefined) => !!r?.per_moved?.some((w) => /^(tv|television)$/.test(w));
  const isTv = (d: Device) => roleNamed(d.item, roles)?.role === "television" || /\b(tv|television)s?\b/i.test(d.item) && !tvMount(roleNamed(d.item, roles));
  const isBar = (d: Device) => /\b(soundbar|sound bar)s?\b/i.test(d.item) && !/\b(mount|bracket)s?\b/i.test(d.item);
  const inRoom = (d: Device, test: (x: Device) => boolean) => devices.filter((x) => x.room && room(x) === room(d) && test(x)).reduce((n, x) => n + x.quantity, 0);
  const capped = (d: Device): Device => {
    if (!d.room || !tvMount(roleNamed(d.item, roles)) || /\b(tv|television)\b/i.test(d.item)) return d;
    const tvs = inRoom(d, isTv);
    return tvs > 0 && inRoom(d, isBar) > 0 && d.quantity > tvs ? { ...d, quantity: tvs } : d;
  };
  const ours = devices.filter((d) => d.supplied_by === "livewire" && !d.existing).map(capped);
  return {
    ...scope,
    requested_quantities: [...ours.map((d) => ({ item: deviceItem(d), quantity: d.quantity })), ...scope.requested_quantities.filter((q) => unlisted(q.item))],
    retained_equipment: [...devices.filter((d) => d.existing).map((d) => d.item), ...scope.retained_equipment.filter(unlisted)],
  };
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

/** Integrating a device is connecting the customer's own: "thermostat integration", "integrate the existing thermostats". */
const INTEGRATION = /\bintegrat(e|es|ed|ing|ion)\b/;
/**
 * The request's words for this device when it integrates the customer's own (Zack's Annie Lewis job, 2026-11-05:
 * "Thermostat integration, up to 2, verify Z-Wave compatibility" was priced as a new thermostat).
 */
function integrated(scope: ScopeDraftV1, role: RoleSpec): string | undefined {
  for (const text of [...scope.requested_changes, ...scope.requested_quantities.map((q) => q.item)]) {
    const t = fold(text);
    if (!INTEGRATION.test(t) || NEW_DEVICE.test(t)) continue;
    const term = (role.retained_match ?? []).find((m) => new RegExp(String.raw`\b${escape(fold(m))}(s|es)?\b`).test(t));
    if (term) return text.trim();
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
    // Nor is a count of devices to integrate ("Thermostat integration: up to 2"): those are the customer's.
    if (INTEGRATION.test(fold(q.item)) && !NEW_DEVICE.test(fold(q.item))) continue;
    // A length per drop ("feet of Cat6 per drop" × 50) is not a count of anything.
    if (PER_DROP_ITEM.test(fold(q.item))) continue;
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
  // A device list has one entry per device per room: every entry of the role adds up ("flat TV mount (great room)",
  // "flat/tilt TV mount (primary bedroom)" are 2 mounts).
  if (scope.devices?.length) return { item: mine[0]!.item, quantity: mine.reduce((n, q) => n + q.quantity, 0) };
  // The same device counted room by room ("2 upstairs", "2 downstairs") adds up; a count of something else stays apart.
  const same = mine.filter((q) => deviceOf(q.item) === deviceOf(mine[0]!.item));
  if (same.length > 1) return { item: mine[0]!.item, quantity: same.reduce((n, q) => n + q.quantity, 0) };
  // Different models of the device, each named by its model ("3 G6 Bullet cameras", "1 G6 Pro Bullet camera"), add up:
  // a model count is never a total of the others (Zack's Standon job, 2026-11-03: 4 cameras priced as 3).
  const modelled = (q: { item: string }) => /\d/.test(q.item.replace(/^\s*\d+\s*/, "")) || !!role.other_brands?.some((b) => hasWord(fold(q.item), fold(b)));
  if (mine.length > 1 && mine.every(modelled)) return { item: mine[0]!.item, quantity: mine.reduce((n, q) => n + q.quantity, 0) };
  // Kinds of the device that each say what sets them apart ("3 door contacts", "4 window contacts"; "43-inch TV", "65-inch
  // Sony TV") add up too: neither is a total of the other (Zack's Annie Lewis job, 2026-11-05: 4 window contacts dropped).
  if (mine.length > 1 && distinctKinds(mine)) return { item: mine[0]!.item, quantity: mine.reduce((n, q) => n + q.quantity, 0) };
  return mine[0]!;
}

/** Each item has a word of its own, no kind word, that none of the others has: "door contacts" and "window contacts". */
function distinctKinds(items: Array<{ item: string }>): boolean {
  const words = items.map((q) => new Set(itemWords(q.item).filter((w) => !KIND_WORDS.has(w))));
  return words.every((ws, i) => [...ws].some((w) => words.every((o, j) => j === i || !o.has(w))));
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
/** A negated clause, to the next comma or stop: "no new speakers", "without a new mount", "don't add a sub". */
const NEGATED = /\b(?:no|not|without|never|don'?t|do not|doesn'?t|does not)\b[^,.;]*/g;

function wantsNew(scope: ScopeDraftV1, role: RoleSpec, roles: RoleSpec[]): boolean {
  // The device list says it outright: a role it lists is new only for a device Livewire supplies new (staging smoke,
  // Biscuit Belly, 2026-11-06: "No new speakers, just the amp" priced 2 speakers beside the customer's existing ones).
  const listed = (scope.devices ?? []).filter((d) => roleNamed(d.item, roles) === role);
  if (listed.length) return listed.some((d) => d.supplied_by === "livewire" && !d.existing);
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
  // "No new speakers, just the amp" asks for no speakers: a negated clause sells nothing.
  const said = otherChanges(scope).map((c) => c.replace(NEGATED, " "));
  if (said.some((c) => roleTerms(role).some((t) => asks(c, t) && (sold(c) || more(c, t))))) return true;
  // An outdoor device the request specifies by size ("55'' Outdoor rated TV with cover") is one to sell
  // unless the request says it's the customer's or existing (Zack's Britt job, 2026-10-19: the TV was dropped).
  return outdoorAsked(scope, role) && sizeAsked(scope, role) !== undefined && !customerOwned(scope, role) && !deviceChanges(scope, role).some((c) => EXISTING_ITEM.test(c));
}

/** Brands Livewire doesn't carry as its standard, named for a system the budget prices. */
const OTHER_BRANDS = ["UniFi", "Ubiquiti", "Luma", "Ring", "Nest", "Arlo", "Hikvision", "Dahua", "Lorex", "Reolink", "Verkada", "Axis", "Uniview", "Wyze", "SimpliSafe", "Vivint", "ADT", "Netgear", "Orbi", "TP-Link", "Linksys", "Brivo"];
/** Which system a requested product belongs to, by its device words; first match wins. */
const BRAND_SYSTEMS: Array<[string, RegExp]> = [
  ["video_doorbell", /\bdoorbells?\b/],
  ["access_control", /\b(entry reader|card reader|readers?|access control|entry)\b/],
  ["intrusion_security", /\b(alarm|sensors?|contacts?|sirens?|motion|keypads?|superlink)\b/],
  ["video_surveillance", /\b(cameras?|bullet|turret|dome|nvr|recorder|surveillance)\b/],
  ["networking", /\b(router|gateway|dream machine|udm|switch|access points?|wi-?fi|wireless|network|poe)\b/],
];

/** The brand the customer keeps a system of ("Luma NVR"): their new devices of that brand are listed to price, not replaced. */
function keepsBrand(scope: ScopeDraftV1, brand: string): boolean {
  return scope.retained_equipment.some((e) => hasWord(fold(e), fold(brand)));
}

/** Other brands the request names, by the system each requested product belongs to (not ones the customer keeps). */
function brandsBySystem(scope: ScopeDraftV1): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const q of scope.unresolved_questions.map(fold)) {
    const m = /^requested product:\s*(.+)$/.exec(q);
    if (!m) continue;
    const brand = OTHER_BRANDS.find((b) => hasWord(m[1]!, fold(b)));
    if (!brand || keepsBrand(scope, brand)) continue;
    const system = BRAND_SYSTEMS.find(([, p]) => p.test(m[1]!))?.[0];
    if (!system) continue;
    const name = brand === "Ubiquiti" ? "UniFi" : brand;
    if (!(out.get(system) ?? []).includes(name)) out.set(system, [...(out.get(system) ?? []), name]);
  }
  return out;
}

/** The camera the request describes ("indoor dome cameras" → "indoor dome camera"), so the budget doesn't call it our outdoor turret. */
function cameraStyleAsked(scope: ScopeDraftV1): string | undefined {
  for (const t of requestTexts(scope)) {
    const m = /\b((?:indoor|outdoor|interior|exterior)\s+)?(dome|turret|bullet|ptz|fisheye|box)\s+cam(?:era)?s?\b/.exec(t);
    if (m) return `${m[1] ?? ""}${m[2]} camera`;
  }
  return undefined;
}

/** The request's name for another model of this device ("Requested product: Control4 CoreLite", "Halo Remote + CoreLite"). */
function otherModelAsked(scope: ScopeDraftV1, role: RoleSpec): string | undefined {
  const words = role.other_models!.map(fold);
  // Spaced or not ("CoreLite", "Core Lite"); a short model ("EA-1") only as written, never inside other words ("area 1").
  const says = (t: string) => words.some((w) => hasWord(fold(t), w) || (compact(w).length >= 6 && compact(t).includes(compact(w))));
  const question = scope.unresolved_questions.map((q) => /^requested product:\s*(.+)$/i.exec(q)?.[1]?.trim()).find((q): q is string => !!q && says(q));
  if (question) return question;
  const item = scope.requested_quantities.find((q) => says(q.item) && !EXISTING_ITEM.test(fold(q.item)));
  if (item) return item.item.trim();
  return scope.requested_changes.some((c) => says(c) && !EXISTING_ITEM.test(fold(c))) ? `${role.label.split(" ")[0]} ${role.other_models![0]}` : undefined;
}

/** The requested product of this brand the line stands in for, as the request names it ("UniFi G6 Bullet camera"). */
function requestedProductFor(scope: ScopeDraftV1, role: RoleSpec, brands: string): string | undefined {
  const devices = deviceTerms(role).concat((role.count_terms ?? []).map(fold));
  const names = brands.split(" / ").map(fold).concat(brands.split(" / ").some((b) => fold(b) === "unifi") ? ["ubiquiti"] : []);
  const asked = scope.unresolved_questions
    .map((q) => /^requested product:\s*(.+)$/i.exec(q)?.[1]?.trim())
    .filter((q): q is string => !!q && names.some((b) => hasWord(fold(q), b)));
  const mine = asked.filter((q) => devices.some((d) => hasWord(fold(q), d.replace(/s$/, "")) || hasWord(fold(q), d)));
  return mine.length ? mine.join(" / ") : undefined;
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

/**
 * The customer keeps their own equipment these terms name, other than an eero: "existing Verizon router" kept, or a change
 * like "keep the customer's own router" / "eeros on their existing modem".
 */
function keepsOwn(scope: ScopeDraftV1, terms: string[]): boolean {
  const term = terms.map((w) => escape(fold(w))).join("|");
  const kept = scope.retained_equipment.map(fold).filter((e) => !/\beeros?\b/.test(e));
  if (kept.some((e) => new RegExp(String.raw`\b(?:${term})s?\b`).test(e))) return true;
  const KEPT = new RegExp(String.raw`\b(?:keep|keeps|keeping|kept|existing|own|current|isp'?s?|provider'?s?)\b(?:\s+[\w'’-]+){0,3}?\s+(?:${term})s?\b`);
  // Replacing it is no keeping it ("replace the existing router"); upgrading the Wi-Fi beside it is.
  const REPLACED = new RegExp(String.raw`\b(?:replac|swap|remov|upgrad)\w*\b(?:\s+[\w'’-]+){0,4}?\s+(?:${term})s?\b`);
  return requestTexts(scope).some((t) => KEPT.test(t) && !REPLACED.test(t));
}

/** Words that put a device outside: "75\" full weather outdoor TV", "weatherproof TV on the patio". */
const OUTDOOR = /\b(outdoors?|outside|exterior|weather[- ]?proof|weather[- ]?rated|all[- ]weather|full[- ]weather|full[- ]sun|partial[- ]sun|full[- ]shade|patio|porch|pool ?deck|pergola|terrace|veranda)\b/;

/** The request's changes that name this role's device (its label or retained-equipment terms), for size and placement. */
const deviceChanges = (scope: ScopeDraftV1, role: RoleSpec) =>
  otherChanges(scope).filter((c) => [fold(role.label), ...(role.retained_match ?? []).map(fold)].some((t) => hasWord(c, t)));

/** The request puts this device outside (McGetrick, 2026-10-15: a 75" full-weather outdoor TV was priced as an indoor Sony). */
function outdoorAsked(scope: ScopeDraftV1, role: RoleSpec): boolean {
  // A change that only places something by the TV ("an Ethernet port at the back of the TV location ... the front porch")
  // doesn't put the TV outside: the changes that size it say where it goes, when any does (Bennett, 2026-11-05).
  // Nor does a change about the customer's own TV ("Porch: Customer supplied TV, outdoor TV install") put ours outside (Morales, 2026-11-06).
  const all = deviceChanges(scope, role).filter((c) => !SUPPLIED.test(c) && !OWNED_ITEM.test(c) && !EXISTING_ITEM.test(c));
  const sized = all.filter((c) => new RegExp(SIZE.source).test(c));
  return !!role.variants?.length && (sized.length ? sized : all).some((c) => OUTDOOR.test(c));
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

const TV_WORD = /\b(tvs?|televisions?)\b/;
/** A drop count at or under which a finished home's new drops terminate at its existing network equipment. */
const SMALL_RETROFIT_DROPS = 2;

/**
 * The TVs the request sizes, one change at a time ("Guest room: 43-inch TV", "1 x 85\" Sony Bravia RGB TV"), each at the
 * approved record for its size or, for a size with none, a placeholder at the closest one. Empty when an outdoor size has
 * no approved outdoor record (that one is listed to price instead).
 */
function sizedTvs(scope: ScopeDraftV1, role: RoleSpec): Array<{ record_id: string; quantity: number; placeholder_for?: string }> {
  const baseSize = Number(/(\d{2,3})\s*(?:"|”|-?inch)/.exec(role.label)?.[1] ?? 0);
  const out = new Map<string, { record_id: string; quantity: number; placeholder_for?: string }>();
  // Livewire's TVs from the device list when the scope has one (its counts are given), else from the changes.
  const ours = (scope.devices ?? []).filter((d) => d.supplied_by === "livewire" && !d.existing);
  const sources = scope.devices?.length ? ours.map((d) => ({ raw: d.item, given: d.quantity })) : scope.requested_changes.map((raw) => ({ raw, given: null as number | null }));
  for (const { raw, given } of sources) {
    const c = fold(raw);
    if (MOVE.test(c) || !TV_WORD.test(c) || EXISTING_ITEM.test(c) || OWNED_ITEM.test(raw)) continue;
    const m = [...c.matchAll(SIZE)][0];
    if (!m) continue;
    // The size is the TV's: the TV word follows it within a few words ("85” Sony Bravia RGB TV").
    const tail = /^\s*(?:[\w'’+-]+\s+){0,4}?(?:tvs?|televisions?)\b/.exec(c.slice(m.index! + m[0].length));
    if (!tail) continue;
    const size = Number(m[1]);
    // A count leads its clause ("1 x 85” TV", "Add 2 new 43” TVs"); a model number before the size is no count:
    // "Sony Bravia 7 or 9 65-inch TV" is one TV, not 9 (Zack's Morales re-runs, 2026-11-06: 9 TVs and 18 mounts).
    const n = /(?:^|[:;,(]\s*|\b(?:add|install|provide|supply|mount|new|and)\s+)(\d+|one|two|three|four|five|six)\s*(?:x\s*)?(?:new\s+)?$/.exec(c.slice(0, m.index));
    const quantity = given ?? (n ? (COUNT_WORDS[n[1]!] ?? Number(n[1])) : 1);
    const outdoor = OUTDOOR.test(c);
    const worded = (role.word_variants ?? []).filter((v) => v.words.some((w) => hasWord(c, fold(w))));
    const candidates = worded.length
      ? worded.map((v) => ({ sizes: v.sizes ?? (v.default_size ? [baseSize] : []), product_id: v.product_id, outdoor: false }))
      : [{ sizes: [baseSize], product_id: role.product_id, outdoor: false }, ...(role.variants ?? [])].filter((v) => !!v.outdoor === outdoor);
    const exact = candidates.find((v) => v.sizes.includes(size));
    if (!exact && outdoor) return [];
    const closest = (v: { sizes: number[] }) => Math.min(...v.sizes.map((x) => Math.abs(x - size) - x / 1000));
    const pick = exact ?? [...candidates].filter((v) => v.sizes.length).sort((a, b) => closest(a) - closest(b))[0];
    if (!pick?.product_id) return [];
    const placeholder_for = exact ? undefined : raw.slice(m.index!, m.index! + m[0].length + tail[0].length).replace(/\s+/g, " ").trim();
    const key = `${pick.product_id}|${placeholder_for ?? ""}`;
    const had = out.get(key);
    out.set(key, { record_id: pick.product_id, quantity: (had?.quantity ?? 0) + quantity, ...(placeholder_for ? { placeholder_for } : {}) });
  }
  return [...out.values()];
}

/**
 * New devices (from the device list) a mount role carries that have no mount listed in their room: a mount device of
 * the same kind (any TV mount, or a soundbar mount) in the same room, or one with no room, covers them.
 */
function unmountedNew(scope: ScopeDraftV1, role: RoleSpec, roles: RoleSpec[]): number {
  const devices = scope.devices ?? [];
  if (!devices.length || !role.quantity_follows) return 0;
  const kin = roles.filter((r) => r === role || (role.alternative_group && r.alternative_group === role.alternative_group));
  const mounts = devices.filter((d) => kin.includes(roleNamed(d.item, roles)!));
  // No mount on the list: the stated count is the rep's own total ("only need 1 TV mount"), used as written
  // (staging smoke, Green step 3, 2026-11-06: priced 2).
  if (!mounts.length) return 0;
  const carried = devices.filter((d) => d.supplied_by === "livewire" && !d.existing && role.quantity_follows!.includes(roleNamed(d.item, roles)?.role ?? ""));
  const room = (d: Device) => (d.room ?? "").toLowerCase();
  let spare = mounts.filter((m) => !m.room).reduce((n, m) => n + m.quantity, 0);
  let gap = 0;
  for (const d of carried) {
    if (mounts.some((m) => m.room && room(m) === room(d))) continue;
    const take = Math.min(spare, d.quantity);
    spare -= take;
    gap += d.quantity - take;
  }
  return gap;
}

/** Words that stand a TV on furniture instead of the wall: "standing on top of a very long cabinet", "on the credenza". */
const STANDING = /\b(stand(s|ing)?|sits?|sitting|placed|set|rests?|resting)\s+on\b|\bon top of\b|\bon (?:a|an|the|his|her|their|its)\s+(?:[\w-]+\s+){0,3}?(cabinet|credenza|console|dresser|tv stand|media stand|table|furniture|media unit|sideboard|buffet)\b|\btable ?top\b/;
/** How many TVs the request stands on furniture. */
function standingTvs(scope: ScopeDraftV1): number {
  return scope.requested_changes
    .map(fold)
    .filter((c) => TV_WORD.test(c) && STANDING.test(c) && !/\b(mount(ed|ing|s)?|wall|bracket)\b/.test(c) && !MOVE.test(c))
    .reduce((n, c) => n + Number(/^\s*(\d+)\s*x?\b/.exec(c)?.[1] ?? 1), 0);
}

/** The customer supplies it: "customer-provided", "customer supplied", "supplied by the client", "the owner is providing". */
const SUPPLIED = /\b(customer|client|owner|homeowner)(?:'s|’s)?[- ]?(supplied|provided|furnished)\b|\b(supplied|provided|furnished) by the (customer|client|owner|homeowner)\b|\b(customer|client|owner|homeowner) (supplies|provides|furnishes|is supplying|is providing|will supply|will provide)\b/;
/** Words that make a supplied item a whole system's gear, not one device ("all customer-provided UniFi equipment", "customer-provided APs and cameras"). */
const WHOLE_SYSTEM = /\b(all|entire|whole|equipment|gear|system|hardware|everything)\b/;
/** A system's devices, for what the customer supplies. */
const SUPPLIED_SYSTEMS: Array<[string, RegExp]> = [
  ["networking", /\b(unifi|ubiquiti|network(?:ing)?|wi-?fi|access points|aps|gateway|dream machine|udm|switch(?:es)?|eeros?)\b/],
  ["video_surveillance", /\b(cameras|camera system|nvr|unvr|protect|surveillance)\b/],
];
/**
 * The roles whose equipment the customer supplies: every role of a system the request says the customer supplies the
 * gear for ("Mount and configure all customer-provided UniFi equipment", "customer-provided APs and cameras"), and any
 * other role a customer-supplied list names ("Customer-supplied equipment list includes ... 2 patch panels"). TVs are
 * left to each change, which says whose each TV is (Zack's Morales job, 2026-11-06: the customer's whole UniFi system
 * was priced as eeros, a switch, OvrC, a WattBox, a patch panel and an SVR).
 */
function suppliedRoles(scope: ScopeDraftV1, roles: RoleSpec[]): Map<string, string> {
  const out = new Map<string, string>();
  const texts = [...scope.requested_changes, ...scope.retained_equipment, ...scope.excluded_scope, ...scope.unresolved_questions].filter((t) => SUPPLIED.test(fold(t)));
  const systems = new Map<string, string>();
  for (const t of texts.map(fold)) {
    const brand = OTHER_BRANDS.find((b) => hasWord(t, fold(b)));
    for (const [system, words] of SUPPLIED_SYSTEMS) if ((brand || WHOLE_SYSTEM.test(t)) && words.test(t) && !systems.has(system)) systems.set(system, brand === "Ubiquiti" ? "UniFi" : (brand ?? ""));
  }
  // Lists of what the customer supplies, not a change that also names our work ("Porch: Customer supplied TV ... Sonos Beam"),
  // and only what follows the words that say so: "Sonos amp in customer supplied rack" supplies the rack, not the amp
  // (Zack's Morales re-runs, 2026-11-06: the Sonos Amps dropped in two of three runs).
  const lists = [...scope.retained_equipment, ...scope.excluded_scope, ...scope.unresolved_questions]
    .map(fold)
    .flatMap((t) => [...t.matchAll(new RegExp(SUPPLIED.source, "g"))].map((m) => t.slice(m.index! + m[0].length).split(/[.;]|\s-\s|\bwhile\b|\bbut\b/)[0]!));
  for (const role of roles) {
    const system = role.systems.find((x) => systems.has(x));
    if (system && role.systems.every((x) => systems.has(x))) {
      out.set(role.role, `${systems.get(system) ? `${systems.get(system)} ` : ""}${system === "networking" ? "network" : "camera"} equipment`);
      continue;
    }
    if (role.variants) continue;
    const terms = [...(role.mentions ?? []), ...(role.retained_match ?? []), ...(role.count_terms ?? [])].map(fold).filter((x) => x.length >= 4 && !BRANDS.has(x));
    const named = lists.find((t) => terms.some((x) => new RegExp(String.raw`\b${escape(x)}(s|es)?\b`).test(t)));
    const term = named && terms.find((x) => new RegExp(String.raw`\b${escape(x)}(s|es)?\b`).test(named));
    if (term) out.set(role.role, /s$/.test(term) ? term : `${term}s`);
  }
  // The device list says outright what the customer supplies new: installed by Livewire, not sold. A role Livewire
  // also sells a device of (one TV ours, two theirs) is priced for ours.
  const devices = scope.devices ?? [];
  const oursRoles = new Set(devices.filter((d) => d.supplied_by === "livewire" && !d.existing).map((d) => roleNamed(d.item, roles)?.role));
  for (const d of devices.filter((d) => d.supplied_by === "customer" && !d.existing)) {
    const r = roleNamed(d.item, roles);
    if (r && !oursRoles.has(r.role) && !out.has(r.role)) out.set(r.role, fold(d.item));
  }
  // The panel the customer's runs punch down into is in the customer's rack, with the rest of their network gear, unless
  // the request asks Livewire for one (Zack's Morales re-runs, 2026-11-06: a C2G panel priced beside their 2 panels).
  const panel = roles.find((r) => r.role === "patch_panel");
  const networkSupplied = [...out.values()].some((v) => v.endsWith("network equipment"));
  const ownPanel = requestTexts(scope).some((t) => /\b(new|provide|supply|add|install|livewire)\b(?:\s+[\w-]+){0,3}\s+patch panels?\b/.test(t) && !SUPPLIED.test(t));
  if (panel && networkSupplied && !out.has(panel.role) && !ownPanel) out.set(panel.role, "patch panels");
  return out;
}

/** Speakers wired before this job ("speakers wired during construction"): no speaker prewire to price. */
const SPEAKERS_WIRED = /\bspeakers?\b.*\b(wired|prewired|pre-wired|installed|run)\s+(during|in|at)\s+(the\s+)?(construction|build|framing)\b|\b(existing|prewired|pre-wired)\s+speaker\s+wir(e|es|ing)\b|\bspeakers?\s+(are\s+)?already\s+(wired|prewired|pre-wired)\b/;
/** Terminating runs already pulled ("terminations owed under the existing Biringer contract"): no new cable. */
const TERMINATE_EXISTING = /\b(terminat\w*|punch(?:es|ed|ing)?[- ]?downs?|re-?terminat\w*)\b.*\b(existing|owed|already|previous|prior|contract|pre-?run|pre-?wired|in place)\b|\b(existing|already pulled|previously pulled|pre-?run|pre-?wired|owed|contract)\b.*\b(terminat\w*|punch(?:es|ed|ing)?[- ]?downs?)\b/;
/** A request for new cable: "run Cat6", "pull new cable", "add an Ethernet port", "new drop". */
const NEW_CABLE = /\b(run|pull|pulling|add|install|new)\s+(?:a |an |new |\d+ )?(?:[\w-]+\s+){0,2}?(cable|cables|cat ?6|drops?|runs?|ethernet|data (?:port|jack|drop|outlet)s?)\b|\bethernet (port|jack|drop|outlet)s?\b/;

/** Mount words by type: an articulating arm, or a flat or tilt mount. */
const ARTICULATING_MOUNT = /\b(articulat\w*|art arm|full[- ]motion|swivel|cantilever|extend\w* arm|swing[- ]arm)\b/;
const FLAT_MOUNT = /\b(flat|tilt|tilting|fixed|low[- ]profile)\b(?:[\s/-]+\w+){0,2}?\s*mount/;
/** One TV mount per change that mounts a TV, by type: "flat mount", "flat/tilt mounted", "art arm mount". */
function mountPlan(scope: ScopeDraftV1): { articulating: number; flat: number; any: number } {
  const plan = { articulating: 0, flat: 0, any: 0 };
  for (const c of scope.requested_changes.map(fold)) {
    if (MOVE.test(c) || !/\bmount(ed|s|ing)?\b|\bart arm\b/.test(c) || STANDING.test(c)) continue;
    // A soundbar's or a camera's mount isn't a TV's.
    const tv = TV_WORD.test(c) || /\b(bravia|sony|samsung|lg|oled|qled)\b/.test(c) || ARTICULATING_MOUNT.test(c) || FLAT_MOUNT.test(c);
    if (!tv || (/\b(aps?|access points?|cameras?|equipment|speakers?)\b/.test(c) && !TV_WORD.test(c))) continue;
    if (ARTICULATING_MOUNT.test(c)) plan.articulating++;
    else if (FLAT_MOUNT.test(c)) plan.flat++;
    else plan.any++;
  }
  return plan;
}

/**
 * The interpreter lists the device as a product the request asks Livewire for ("Requested product: Sonos amp"), so the
 * same device in the kept equipment ("Sonos amp and speakers wired during construction") is the new one to install, not
 * the customer's (Zack's Morales re-runs, 2026-11-06: the 2 Sonos Amps dropped as "retained" in two of three runs).
 */
function askedAsProduct(scope: ScopeDraftV1, role: RoleSpec, roles: RoleSpec[]): boolean {
  return scope.unresolved_questions.some((q) => {
    const asked = /^requested product:\s*(.+)$/i.exec(q.trim())?.[1];
    if (!asked || EXISTING_ITEM.test(fold(asked)) || SUPPLIED.test(fold(asked)) || OWNED_ITEM.test(asked)) return false;
    // By the same device word the kept equipment matched ("amp"), not a brand: a "Sony ultra slim mount" is no Sony TV.
    if (!(role.retained_match ?? []).some((t) => hasWord(fold(asked), fold(t)))) return false;
    const scores = roles.map((r) => matchScore(asked, r));
    const best = Math.max(...scores);
    return best > 1 && roles[scores.indexOf(best)] === role;
  });
}

/** A change asks for a new TV the customer doesn't supply ("Great Room: Sony Bravia 7 or 9 (65”)"), beside TVs that are the customer's. */
function newTvAsked(scope: ScopeDraftV1, role: RoleSpec): boolean {
  if (!role.variants) return false;
  const words = (role.mentions ?? []).map(fold);
  return scope.requested_changes.some((raw) => {
    const c = fold(raw);
    if (MOVE.test(c) || EXISTING_ITEM.test(c) || OWNED_ITEM.test(raw) || SUPPLIED.test(c)) return false;
    return words.some((w) => hasWord(c, w)) || (TV_WORD.test(c) && new RegExp(SIZE.source).test(c));
  });
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

/**
 * admitted: the D-Tools records admitted in this run. A device, service or parts record outside it (a retired SKU)
 * is listed to price instead of stopping the build; omitted, every record is taken as admitted.
 */
export function materialize(given: ScopeDraftV1, pattern: PatternSpec, namedProducts: NamedProduct[] = [], admitted?: ReadonlySet<string>): Selection {
  // A scope that lists its devices prices from that list: Livewire's new devices are the counts, the customer's are
  // left out. A device list is never a set of totals over its items.
  const stated = withDevices(given, pattern.roles);
  const original = stated.devices?.length ? stated : withoutTotals(stated);
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
  /** Mount roles that skip the TVs standing on furniture. */
  const standingTvRoles = new Set<string>();
  const toVerify: string[] = [];
  const verifyOnly = new Set<string>();
  /** Roles priced as placeholders for another brand's devices on the system of that brand the customer keeps. */
  const keptBrandPlaceholders = new Map<string, string>();
  // Existing equipment the job keeps: nothing to price, its field test is listed to verify.
  const keptRoles = new Set<string>();
  const supplied = suppliedRoles(original, pattern.roles);
  const suppliedAnnounced = new Set<string>();
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
      (role.mentions && mentioned(scope, role.mentions, role.mentions_require, siblings, role.mentions_unless)) ||
      (role.asked_by && mentioned(scope, role.asked_by, undefined, siblings)) ||
      !!role.mentions_kept?.some((t) => scope.retained_equipment.some((e) => hasWord(fold(e), fold(t)))) ||
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
      ? (scope.retained_equipment.find((e) => role.retained_match!.some((t) => fold(e).includes(fold(t)))) ?? customerOwned(scope, role) ?? integrated(scope, role))
      : undefined;
    // A device list that lists the role settles it (wantsNew reads the list); otherwise a new TV or a requested product
    // the sentences name beside the kept one is ours.
    const listedByDevices = (original.devices ?? []).some((d) => roleNamed(d.item, pattern.roles) === role);
    const askedBeside = !listedByDevices && (newTvAsked(original, role) || askedAsProduct(original, role, pattern.roles));
    // The customer supplies it new (their UniFi cameras): built like ours, then installed, not sold, with its install labor
    // (suppliedLines below), not kept as old gear (Zack's Morales job, 2026-11-06: four customer cameras carried no labor).
    if (retained && !supplied.has(role.role) && !wantsNew(scope, role, pattern.roles) && !product && !askedBeside) {
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
    // Another brand's device is listed to price only when the customer keeps that brand's system (Jinny's Luma NVR:
    // our cameras wouldn't record to it). Otherwise our standard prices as a labeled stand-in (Henry, 2026-10-30).
    const brand = product ? undefined : otherBrandAsked(scope, role);
    // Henry, 2026-11-03: it prices as a placeholder line at Livewire's equivalent instead, so the total covers the devices
    // and their install (Zack's Jinny's job: a $358 budget for 2 cameras listed to price).
    if (brand && keepsBrand(scope, brand)) keptBrandPlaceholders.set(role.role, `${brand} ${cameraStyleAsked(scope) ?? role.label.replace(/^\S+\s+/, "")}`);
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
    const counted = product ? (statedForProduct(original, product) ?? statedQuantity(scope, role, pattern.roles)) : statedItems(scope, role, pattern.roles);
    // A change that counts the device in words ("Two Sonos Ports for the upstairs and downstairs TV systems") outranks
    // a smaller count the interpreter read off a product line (Zack's Paulenich job, 2026-10-30: one Port priced).
    // A longer product's name that starts with this one's ("Sonos Amp Multi" for the Sonos Amp) counts that product, not this.
    const longer = pattern.roles.map((r) => fold(r.label)).filter((l) => l.startsWith(`${fold(role.label)} `));
    const said = counted === null ? null : countedInChanges(original, [role.label, ...(product ? [product.model, product.label] : [])], longer);
    const statedUnits = counted !== null && said !== null ? Math.max(counted, said) : counted;
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

  // A device whose D-Tools record can't be admitted in this run (a retired SKU) is listed to price, and the rest of
  // the job still builds: one record no longer stops the whole budget (Zack's Standon job, 2026-10-27).
  if (admitted) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (admitted.has(line.record_id)) continue;
      const role = pattern.roles.find((r) => r.role === line.role)!;
      const variants = [...(role.variants ?? []), ...(role.brand_variants ?? []), ...(role.market_variants ?? []), ...(role.larger_tv_variants ?? []), ...(role.port_variants ?? []), ...(role.word_variants ?? [])];
      const label = line.requested_model ?? variants.find((v) => v.product_id === line.record_id)?.label ?? role.label;
      lines.splice(i, 1);
      toVerify.push(`Requested product: ${label} (its D-Tools record can't be read; priced in the final proposal)`);
      if (!lines.some((l) => l.role === line.role)) verifyOnly.add(line.role);
    }
  }

  // A TV in each room the request sizes ("Guest room: 43-inch TV", "Living room: 65-inch Sony TV") is a TV of its own, at
  // the approved record for its size; a size Livewire has no standard for is a placeholder at the closest one (Zack's
  // Annie Lewis job, 2026-11-05: 3 rooms priced 1 TV; Bennett: an 85" Bravia priced as a 65" BRAVIA 7 without saying so).
  for (const role of included) {
    const at = lines.findIndex((l) => l.role === role.role);
    if (!role.variants || at < 0 || requested.has(role.role) || lines.filter((l) => l.role === role.role).length > 1) continue;
    const plan = sizedTvs(original, role);
    const total = plan.reduce((n, t) => n + t.quantity, 0);
    const line = lines[at]!;
    if (!plan.length || total < (statedQuantity(scope, role, pattern.roles) ?? 0)) continue;
    if (plan.length === 1 && !plan[0]!.placeholder_for && plan[0]!.quantity <= line.quantity) continue;
    lines.splice(at, 1, ...plan.map((t) => ({ ...line, record_id: t.record_id, quantity: t.quantity, quantity_basis: "fixed" as const, verify: null, ...(t.placeholder_for ? { placeholder_for: t.placeholder_for } : {}) })));
  }
  // A TV that stands on furniture ("standing on top of a very long cabinet") takes no wall mount (Zack's Bennett job, 2026-11-05).
  const standing = standingTvs(original);
  if (standing > 0) {
    const tvs = lines.filter((l) => l.role === "television").reduce((n, l) => n + l.quantity, 0);
    for (const role of included) {
      if (role.alternative_group !== "tv_mount" || !role.quantity_follows || requested.has(role.role) || namesItself(scope, role, pattern.roles)) continue;
      if (tvs <= standing && movedNeedingMount(scope, role.per_moved ?? []) === 0) notAsked.add(role.role);
      else standingTvRoles.add(role.role);
    }
    toVerify.push(standing === 1 ? "The TV stands on furniture: no wall mount is priced" : `${standing} TVs stand on furniture: no wall mounts are priced for them`);
  }
  // A drop or two into a finished home terminates at the network equipment already there: no new structured media
  // enclosure unless the request asks for one (Zack's Bennett and Hansen jobs, 2026-11-05: a 42" enclosure for one drop).
  const enclosure = included.find((r) => r.role === "media_enclosure");
  if (enclosure && retro && !requested.has(enclosure.role) && !namesItself(scope, enclosure, pattern.roles)) {
    const dropRoles = pattern.roles.filter((r) => r.retrofit_units).map((r) => r.role);
    const drops = lines.filter((l) => dropRoles.includes(l.role)).reduce((n, l) => n + l.quantity / (pattern.roles.find((r) => r.role === l.role)?.retrofit_units?.units ?? 1), 0);
    if (drops > 0 && drops <= SMALL_RETROFIT_DROPS) {
      notAsked.add(enclosure.role);
      toVerify.push(`Termination: the new ${drops === 1 ? "drop terminates" : "drops terminate"} at the existing network equipment; no new enclosure is priced`);
    }
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
    // A kept switch powers new cameras; a kept recorder or camera does only while the budget doesn't replace the recorder
    // (Zack's Dunham job, 2026-11-02: a new SVR, which has no PoE, beside an old Luma camera dropped the switch).
    const recorderPriced = lines.some((l) => l.role === "nvr");
    // The likeliest power source first: a switch, then a recorder, then the cameras themselves.
    const sourceRank = (e: string) => (/\b(switch|poe)\b/.test(fold(e)) ? 0 : /\b(nvr|svr|dvr|recorder)\b/.test(fold(e)) ? 1 : 2);
    const keptSource = scope.retained_equipment
      .filter((e) => role.powers!.unless_kept.some((t) => hasWord(fold(e), fold(t)) && (!recorderPriced || /^(switch|poe)/.test(fold(t)))))
      .sort((a, b) => sourceRank(a) - sourceRank(b))[0];
    const otherBrand = role.powers.roles.some((r) => verifyOnly.has(r)) && !lines.some((l) => role.powers!.roles.includes(l.role));
    if (keptSource || otherBrand) notAsked.add(role.role);
    // Whenever new PoE cameras are priced without a switch, the budget says what powers them.
    if (keptSource && lines.some((l) => role.powers!.roles.includes(l.role))) {
      toVerify.push(`PoE source: no PoE switch is priced; confirm the existing ${keptSource} powers the new cameras`);
    }
  }
  // Likewise a role counted from devices that are all another brand's, listed to price: no microSD cards for UniFi
  // cameras (Zack's Standon job, 2026-10-27).
  for (const role of included) {
    if (!role.quantity_follows || requested.has(role.role) || namedExplicitly(scope, role, pattern.roles)) continue;
    if (role.quantity_follows.some((r) => verifyOnly.has(r)) && !lines.some((l) => role.quantity_follows!.includes(l.role))) notAsked.add(role.role);
    // Cards and the like for placeholder cameras that record to the customer's own system of that brand: none.
    if (role.quantity_follows.length && lines.filter((l) => role.quantity_follows!.includes(l.role)).every((l) => keptBrandPlaceholders.has(l.role))) {
      if (lines.some((l) => role.quantity_follows!.includes(l.role))) notAsked.add(role.role);
    }
  }
  // Amplifiers the request names itself, with no new speakers asked for, drive speakers the customer has: none are
  // added (Zack's Paulenich job, 2026-10-30: two Amp Multis, a Sonos Amp and two Ports priced 2 pairs of in-ceiling speakers).
  const ampsNamed = included.some((r) => r.alternative_group === "amplifier" && (requested.has(r.role) || namedExplicitly(scope, r, pattern.roles)));
  for (const amp of ampsNamed ? included : []) {
    for (const s of amp.drives?.roles ?? []) {
      const speakers = included.find((r) => r.role === s);
      if (!speakers || requested.has(s) || statedQuantity(scope, speakers, pattern.roles) !== null) continue;
      const asksNew = requestTexts(scope).some(
        (t) => /\bspeakers?\b/.test(t) && /\b(install|installing|add|adding|new|replace|replacing|upgrade|put in|mount|wire)\b/.test(t) && !/\b(existing|current|old|their)\b[^.]*\bspeakers?\b/.test(t),
      );
      if (!asksNew) notAsked.add(s);
    }
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
  // Gear the customer's own kept equipment makes unneeded: eeros on the customer's router take no switch (Henry, 2026-11-07).
  for (const role of included) {
    const rule = role.not_with_kept;
    if (!rule || notAsked.has(role.role) || requested.has(role.role) || namesItself(scope, role, pattern.roles)) continue;
    if (rule.except?.some((w) => included.some((r) => r.role === w && !notAsked.has(w)))) continue;
    if (keepsOwn(original, rule.terms)) notAsked.add(role.role);
  }
  if (notAsked.size) {
    for (let i = lines.length - 1; i >= 0; i--) if (notAsked.has(lines[i]!.role)) lines.splice(i, 1);
    for (let i = unresolved.length - 1; i >= 0; i--) if (unresolved[i]!.role && notAsked.has(unresolved[i]!.role!)) unresolved.splice(i, 1);
    included.splice(0, included.length, ...included.filter((r) => !notAsked.has(r.role)));
  }

  // Roles counted from others (a card per camera) take those roles' priced units, unless the request stated their own count.
  const gapped = new Set<string>();
  for (const line of lines) {
    const role = pattern.roles.find((r) => r.role === line.role);
    if (!role?.quantity_follows || line.requested_model) continue;
    // A stated count of plates names one location's plate ("a 2-port Cat6 keystone plate" × 1), never all of them:
    // it can raise the count by location but not lower it (Zack's Giessel job, 2026-11-02: 5 rooms priced 1 plate).
    const stated = statedQuantity(scope, role, pattern.roles);
    if (stated !== null && !role.port_variants) {
      // A device list names the mounts it names: a new TV or soundbar in a room with no mount listed still takes one
      // (staging smoke, Green, 2026-11-06: mounts listed for the fitness room only; the family room's new TV got none).
      // Once per kind of mount: a tilt and an articulating line share the TVs they carry.
      const kind = role.alternative_group ?? role.role;
      const gap = role.per_moved && !gapped.has(kind) ? unmountedNew(original, role, pattern.roles) : 0;
      if (gap > 0) {
        gapped.add(kind);
        Object.assign(line, { quantity: stated + gap, quantity_basis: "fixed", verify: null });
      }
      continue;
    }
    const followed = lines.filter((l) => role.quantity_follows!.includes(l.role));
    // Units of what it follows, not items: a retrofit drop's two jacks are one drop.
    let units = followed.reduce((n, l) => n + l.quantity / (retro ? (pattern.roles.find((r) => r.role === l.role)?.retrofit_units?.units ?? 1) : 1), 0);
    // A 12-port panel per 12 drops; a 2-port plate per 2.
    const per = role.port_variants?.find((v) => v.product_id === line.record_id)?.ports ?? role.follows_per ?? 1;
    // A mount per new TV, plus one per existing TV the request moves (Zack's Paulenich job, 2026-10-26: 2 TVs, 1 mount).
    // With no new TV, the moved ones are all the mounts: one moved TV is one mount (Zack's Young job, 2026-10-26: 2).
    const moved = role.per_moved ? movedNeedingMount(scope, role.per_moved) : 0;
    if (standingTvRoles.has(role.role)) units = Math.max(0, units - standing);
    if (units > 0 || moved > 0) {
      // Plates go one per location: rooms the request gives several ports ("a 2-port plate", "library (2 ports)") take one
      // plate each, the rest one apiece (Zack's Giessel job, 2026-10-30: 7 ports in 5 rooms priced as 4 two-port plates).
      const multi = role.port_variants ? multiPortLocations(scope) : [];
      const byLocation = multi.length ? units - multi.reduce((n, p) => n + p - 1, 0) : 0;
      line.quantity = Math.max(Math.ceil(Math.round((units / per) * 1000) / 1000), byLocation, stated ?? 0) + moved;
      // Plates go one per outlet location, which the drops don't say: always a minimum to verify.
      const toCheck = !!role.port_variants && role.quantity.kind === "minimum";
      line.quantity_basis = toCheck ? "minimum_to_verify" : "fixed";
      line.verify = toCheck && role.quantity.kind === "minimum" ? role.quantity.verify : null;
    }
  }

  // A mount per TV the request mounts, of the type each change asks for: Morales's great room flat mount, bedroom flat/tilt
  // mount and porch art arm are 3 mounts, two of them for TVs the customer supplies (Zack, 2026-11-06: 1 tilt mount priced).
  const mounts = mountPlan(original);
  if (mounts.articulating + mounts.flat + mounts.any > 0) {
    const group = lines.filter((l) => pattern.roles.find((r) => r.role === l.role)?.alternative_group === "tv_mount" && l.role !== "tv_cart");
    const articulating = group.find((l) => l.role === "tv_mount_articulating");
    const flat = group.find((l) => l.role === "tv_mount");
    const plain = flat ?? articulating;
    for (const [line, n] of [[articulating, mounts.articulating], [flat, mounts.flat]] as const) {
      if (line && n + (line === plain ? mounts.any : 0) > line.quantity) Object.assign(line, { quantity: n + (line === plain ? mounts.any : 0), quantity_basis: "fixed", verify: null });
    }
    if (!flat && articulating && mounts.flat > 0) articulating.quantity = Math.max(articulating.quantity, mounts.articulating + mounts.flat + mounts.any);
    if (!articulating && flat && mounts.articulating > 0) flat.quantity = Math.max(flat.quantity, mounts.articulating + mounts.flat + mounts.any);
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

  // A length the request states per drop ("assume 50 feet for each data drop") sizes the cable at that length a drop
  // (Zack's Giessel job, 2026-10-30: priced at 75 ft a drop against his stated 50).
  // Otherwise the cable is about 75 ft a drop, for the drops priced, not a fixed 450 ft (Zack, 2026-11-05: 450 ft for one
  // drop on Bennett's and Hansen's jobs), and one drop the request gives a length ("approx 150 ft") takes that length.
  const perDrop = feetPerDrop(scope);
  for (const line of lines) {
    const role = pattern.roles.find((r) => r.role === line.role);
    if (!role?.stated_length_per || statedQuantity(scope, role, pattern.roles) !== null) continue;
    const units = lines
      .filter((l) => role.stated_length_per!.includes(l.role))
      .reduce((n, l) => n + l.quantity / (retro ? (pattern.roles.find((r) => r.role === l.role)?.retrofit_units?.units ?? 1) : 1), 0);
    if (units <= 0) continue;
    const run = perDrop === null && units === 1 ? runFeet(scope) : null;
    if (perDrop !== null) Object.assign(line, { quantity: Math.ceil(units * perDrop), quantity_basis: "minimum_to_verify", verify: `${perDrop} ft per drop, as the request states` });
    else if (run !== null) Object.assign(line, { quantity: run, quantity_basis: "minimum_to_verify", verify: `${run} ft for the one drop, as the request states` });
    else if (role.quantity.kind === "minimum") Object.assign(line, { quantity: Math.ceil(units * DEFAULT_FEET_PER_DROP) });
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

  // A cable run the request wants priced separately ("Two-story Cat6 run up to the master bedroom …, priced separately")
  // is its own cable-run allowance line on a wiring job too (Zack's Dunham job, 2026-10-26: not priced separately).
  const wiring = (pattern.allowances ?? []).find((a) => a.key === "wiring_run");
  const separateRuns = wiring ? scope.requested_changes.map(fold).filter((c) => SEPARATELY.test(c) && wiring.mentions.some((w) => hasWord(c, fold(w)))) : [];
  // A drop count the rep stated may or may not include it: asked, not guessed.
  if (separateRuns.length && lines.some((l) => l.role === "data_drop" && l.quantity_basis === "fixed")) {
    toVerify.push(`Cable runs priced separately (${separateRuns.length}): confirm the Cat6 keystone jack count leaves them out`);
  }

  // Speakers wired before this job need no speaker prewire, and terminating runs already pulled needs no new cable
  // (Zack's Morales job, 2026-11-06: 4 binding posts and 450 ft of Cat6 for terminating the Biringer runs).
  const dropped = new Set<string>();
  const texts = [...requestTexts(scope), ...scope.retained_equipment.map(fold)];
  // Already wired, not to be wired: "speakers to be installed during construction" is a prewire.
  const wiredBefore = (t: string) => SPEAKERS_WIRED.test(t) && !/\b(to be|will be|needs? to be|should be|must be)\s+(wired|prewired|pre-wired|installed|run)\b/.test(t);
  if (texts.some(wiredBefore) && !texts.some((t) => /\b(new|run|pull)\s+(?:[\w-]+\s+){0,2}?speaker wir/.test(t))) dropped.add("speaker_prewire");
  // The interpreter may put the terminations in a question ("Biringer contract terms for owed media closet terminations").
  if ([...texts, ...scope.unresolved_questions.map(fold)].some((t) => TERMINATE_EXISTING.test(t)) && !texts.some((t) => NEW_CABLE.test(t))) {
    for (const r of pattern.roles.filter((r) => r.stated_length_per)) dropped.add(r.role);
    // The runs already land somewhere: no new enclosure either, unless the request asks for one.
    const enclosure = pattern.roles.find((r) => r.role === "media_enclosure");
    if (enclosure && !namesItself(scope, enclosure, pattern.roles)) dropped.add(enclosure.role);
    if (lines.some((l) => dropped.has(l.role))) toVerify.push("Cabling: the request terminates existing runs; no new cable is priced");
  }
  // What the customer supplies is installed, not sold: its install time stays in the labor, its equipment is not priced.
  const suppliedLines = lines.filter((l) => supplied.has(l.role) && !l.requested_model && !dropped.has(l.role));
  for (const what of new Set(suppliedLines.map((l) => supplied.get(l.role)!))) if (!suppliedAnnounced.has(what)) toVerify.push(`Customer-supplied ${what}: installed and configured on site; no equipment is priced`);
  for (const l of suppliedLines) keptRoles.add(l.role);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (dropped.has(lines[i]!.role) || suppliedLines.includes(lines[i]!)) lines.splice(i, 1);
  }
  if (dropped.size) included.splice(0, included.length, ...included.filter((r) => !dropped.has(r.role)));

  // Quantities the rep set by pasting the budget's item list back ("Sony K65XR70 × 2") are applied as written, last:
  // the item's line takes that count, 0 removes it, and an item the rebuilt budget no longer has comes back (Zack,
  // 2026-11-06: "Revisions won't accept a pasted item list"). Items the paste leaves out stay as built.
  for (const q of stated.item_quantities ?? []) {
    const role = pattern.roles.find((r) => r.role === q.role);
    if (!role) continue;
    const at = lines.filter((l) => l.record_id === q.record_id && l.role === q.role);
    if (q.quantity === 0) {
      for (const l of at) lines.splice(lines.indexOf(l), 1);
      continue;
    }
    if (at.length) {
      Object.assign(at[0]!, { quantity: q.quantity, quantity_basis: "fixed", verify: null });
      for (const l of at.slice(1)) lines.splice(lines.indexOf(l), 1);
    } else {
      lines.push({ role: role.role, record_id: q.record_id, quantity: q.quantity, quantity_basis: "fixed", verify: null, location: role.location, precedent: role.precedent });
    }
    if (!included.includes(role)) included.push(role);
    keptRoles.delete(role.role);
  }

  const devices = [...lines, ...suppliedLines].reduce((n, l) => n + l.quantity, 0);
  // Labor-only allowances the request mentions (framing a niche), priced as hours at the pattern's labor rate.
  const extras = (pattern.labor_extras ?? []).filter((x) => mentioned(scope, x.mentions)).map((x) => x.id);
  // Hours the rep set in a revision, or the crew and days the request states, replace the estimate.
  const crew = devices > 0 && !scope.labor_hours ? statedCrewHours(scope) : null;
  const repHours = scope.labor_hours ?? crew;
  const hours = !pattern.labor ? 0 : (repHours ?? (devices > 0 ? laborHoursFor(pattern, [...lines, ...suppliedLines], addOn, extras) : 0));
  const labor: Selection["labor"] =
    pattern.labor && hours > 0
      ? { labor_type: pattern.labor.labor_type, hours, devices, covers: pattern.labor.covers, extras, ...(repHours ? { set_by_rep: true } : {}) }
      : null;

  const services: Selection["services"] = [];
  for (const category of scope.service_categories) {
    // Services the pattern's labor estimate includes are never priced separately, even when no labor is needed.
    if ((labor ?? pattern.labor)?.covers.includes(category)) continue;
    const spec = pattern.services.find((s) => s.category === category);
    if (spec?.product_id && (!admitted || admitted.has(spec.product_id))) services.push({ category, record_id: spec.product_id, quantity: 1 });
    else if (spec?.product_id) allowances.push({ label: spec.label, reason: "its D-Tools record can't be read; shown as a TBD allowance outside committed totals" });
    else allowances.push({ label: spec?.label ?? category, reason: "no authenticated price; shown as a TBD allowance outside committed totals" });
  }

  // Out-of-pattern work the request asks for, in its changes or as a system no role covers: one allowance per template.
  const uncovered = scope.functional_systems.filter((system) => !candidates.some((r) => r.systems.includes(system)));
  const laborAllowances = allowancesFor(pattern.allowances ?? [], scope, uncovered.map(fold), lines, separateRuns);
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
  // A CD player or tape deck the request mentions is connected, not ignored; how is a question (Zack's Paulenich job, 2026-10-26).
  const player = [...requestTexts(scope), ...scope.retained_equipment.map(fold)].flatMap((c) => Object.keys(AUDIO_PLAYERS).filter((t) => hasWord(c, t)))[0];
  if (player && audio && !(source && lines.some((l) => l.role === source.role))) {
    toVerify.push(`${AUDIO_PLAYERS[player]}: confirm how it connects to the music system (the amplifier's line-in, or a Sonos Port)`);
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

  // A recorder the request sizes by channels ("a newer model 4 channel NVR") is Livewire's standard 8-channel SVR, which
  // records as many: said on the verify list rather than silently swapped (Zack's Dunham job, 2026-10-30).
  const nvr = lines.find((l) => l.role === "nvr" && !l.requested_model);
  const channels = nvr && requestTexts(scope).map((t) => /\b(\d+)[- ]?(?:ch|channel)\b/.exec(t)).find((m) => m && /\b(nvr|dvr|svr|recorder)\b/.test(m.input))?.[1];
  if (nvr && channels && Number(channels) !== 8 && Number(channels) <= 8) {
    toVerify.push(`Recorder: the request asks for ${channels} channels; priced as Livewire's standard 8-channel Alarm.com SVR, which records them`);
  }

  // Another brand the request names for a system (Standon's UniFi network, alarm and entry reader) is priced as
  // Livewire's standard, each line labeled as the stand-in, so the number is honest about its gear (Henry, 2026-10-30).
  const standIns = brandsBySystem(scope);
  for (const line of lines) {
    if (line.requested_model) continue;
    const role = pattern.roles.find((r) => r.role === line.role);
    const brands = [...new Set((role?.systems ?? []).flatMap((s) => standIns.get(s) ?? []))];
    if (brands.length) line.equivalent_of = brands.join(" / ");
    const kept = keptBrandPlaceholders.get(line.role);
    if (kept) line.equivalent_of = kept.split(" ")[0];
    // Henry, 2026-11-03: the line is named for the product the request asks for, a placeholder at our equivalent's price.
    const asked = kept ?? (role && line.equivalent_of ? requestedProductFor(scope, role, line.equivalent_of) : undefined);
    if (asked) line.placeholder_for = asked;
    const otherModel = !asked && !line.placeholder_for && role?.other_models ? otherModelAsked(scope, role) : undefined;
    if (otherModel) line.placeholder_for = otherModel;
    // A placeholder for indoor cameras isn't listed under our outdoor camera's "Exterior" (Zack's Jinny's job, 2026-11-03).
    if (asked && /\b(indoor|interior)\b/i.test(asked) && /^exterior$/i.test(line.location)) line.location = "Interior";
  }

  return {
    schema: "selection_v1",
    pattern: pattern.pattern,
    pattern_version: pattern.version,
    add_on: addOn,
    ...(retrofit(stated) ? { retrofit: true } : {}),
    lines,
    ...(suppliedLines.length ? { installed: suppliedLines.map((l) => ({ role: l.role, quantity: l.quantity })) } : {}),
    services,
    labor,
    parts: pattern.parts && lines.length && (!admitted || admitted.has(pattern.parts.product_id)) ? { record_id: pattern.parts.product_id } : null,
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
    ...(equipmentAllowances(original).length ? { equipment_allowances: equipmentAllowances(original) } : {}),
    to_verify: toVerify,
    ...(verifyOnly.size ? { listed: [...verifyOnly] } : {}),
  };
}

const DOLLARS = String.raw`\$\s?(\d[\d,]*(?:\.\d{1,2})?)\s*(k\b)?`;
const ALLOWANCE_FOR = new RegExp(String.raw`${DOLLARS}\s*(?:placeholder|allowance)\s+(?:for|on)\s+(?:a|an|the|their|his|her)?\s*([^,;.()\n]+)`, "gi");
const ALLOWANCE_OF = new RegExp(String.raw`(?:placeholder|allowance)\s+of\s+${DOLLARS}\s+(?:for|on)\s+(?:a|an|the|their|his|her)?\s*([^,;.()\n]+)`, "gi");
const ITEM_ALLOWANCE = new RegExp(String.raw`(?:^|[,;:]\s*|\b(?:add|include|plus|and)\s+(?:a|an|the)?\s*)([a-z][\w'’ -]{1,40}?)\s*(?:[-–—:]|\bat\b)\s*${DOLLARS}\s*(?:placeholder|allowance)\b`, "gi");

const ITEM_THEN_AMOUNT = new RegExp(String.raw`(?:^|[,;:]\s*|\b(?:add|include|plus|and)\s+(?:a|an|the)?\s*)([a-z][\w'’ -]{1,40}?)\s+(?:placeholder|allowance)\s*(?:\(\s*|[-–—:]\s*|of\s+|at\s+)${DOLLARS}`, "gi");

/**
 * Equipment the rep prices as a dollar allowance: "add a $1,000 placeholder for the turntable", "an allowance of $500 for
 * the bar TV", "turntable – $1,000 allowance". Priced at the rep's amount as an allowance line (Henry, 2026-11-07); a
 * budget for the whole job ("$20,000 budget") is no allowance.
 */
function equipmentAllowances(scope: ScopeDraftV1): Array<{ label: string; amount_cents: number }> {
  const out = new Map<string, { label: string; amount_cents: number }>();
  const add = (amount: string, k: string | undefined, item: string) => {
    const what = item
      .replace(/\s+/g, " ")
      .replace(/\b(?:placeholder|allowance|to be selected|tbd)\b.*$/i, "")
      .trim()
      .replace(/^(?:(?:add|include|plus|and|a|an|the)(?:\s+|$))+/i, "");
    const cents = Math.round(Number(amount.replace(/,/g, "")) * (k ? 1000 : 1) * 100);
    if (!what || !Number.isFinite(cents) || cents <= 0) return;
    const label = `${what[0]!.toUpperCase()}${what.slice(1)} (allowance)`;
    out.set(fold(label), { label, amount_cents: cents });
  };
  for (const c of scope.requested_changes) {
    for (const m of c.matchAll(ALLOWANCE_FOR)) add(m[1]!, m[2], m[3]!);
    for (const m of c.matchAll(ALLOWANCE_OF)) add(m[1]!, m[2], m[3]!);
    for (const m of c.matchAll(ITEM_ALLOWANCE)) add(m[2]!, m[3], m[1]!);
    for (const m of c.matchAll(ITEM_THEN_AMOUNT)) add(m[2]!, m[3], m[1]!);
  }
  return [...out.values()];
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
/** Music sources the audio patterns have no role for, as the request words them and as the budget names them. */
const AUDIO_PLAYERS: Record<string, string> = { "cd player": "CD player", "cd changer": "CD changer", "tape deck": "Tape deck", "cassette deck": "Cassette deck", "cassette player": "Cassette player" };

const PER_DROP = /\b(\d+)\s*(?:feet|foot|ft|')\s*(?:of cable\s*)?(?:for|per|a|on)?\s*(?:each|every|per|a)?\s*(?:data |cat6 |cat 6 |ethernet |network )?(?:drop|run|outlet|port|jack)s?\b/;
/** The cable length the request states per drop, in feet. */
/** The same said the other way round: "each drop is 50 feet", "drops of 50 ft", "50-foot drops". */
const DROP_FEET = [
  /\b(?:each|every|per)\s+(?:data |cat ?6 |ethernet |network )?(?:drop|run|outlet|port|jack)\b[^.;\d]{0,20}?(\d+)\s*(?:-\s*)?(?:feet|foot|ft|')/,
  /\b(?:drop|run)s?\s+(?:of|at)\s+(\d+)\s*(?:-\s*)?(?:feet|foot|ft|')/,
  /\b(\d+)\s*-?\s*(?:foot|ft)\s+(?:data |cat ?6 |ethernet |network )?(?:drop|run)s?\b/,
];
/** A stated count that is the length per drop ("feet of Cat6 per drop" × 50). */
const PER_DROP_ITEM = /\b(feet|foot|ft|length)\b.*\b(per|each|every|a)\s+(?:data |cat ?6 |ethernet |network )?(drop|run|outlet|port|jack)\b/;
function feetPerDrop(scope: ScopeDraftV1): number | null {
  const ok = (n: number) => n > 0 && n <= 500;
  // Every place the model may put the rep's length: changes, counts, questions, exclusions, the project type
  // (Zack's Giessel job, 2026-11-03: "Assume 50 feet for each data drop" went back to 75 ft per drop).
  const texts = [...requestTexts(scope), ...scope.unresolved_questions, ...scope.excluded_scope, scope.project_type ?? ""].map(fold);
  for (const t of texts) {
    const m = PER_DROP.exec(t) ?? DROP_FEET.map((p) => p.exec(t)).find(Boolean);
    if (m && ok(Number(m[1]))) return Number(m[1]);
  }
  const item = scope.requested_quantities.find((q) => PER_DROP_ITEM.test(fold(q.item)) && ok(q.quantity));
  return item ? item.quantity : null;
}

/** Cat6 a drop when the request gives no length: the cable role's own "about 75 ft of Cat6 per data outlet". */
const DEFAULT_FEET_PER_DROP = 75;
/** A cable run's length the request gives ("data cables can be run ... approx 150 ft"), for a job of one drop. */
function runFeet(scope: ScopeDraftV1): number | null {
  for (const t of [...requestTexts(scope), ...scope.unresolved_questions].map(fold)) {
    if (!/\b(cable|cables|cabling|run|runs|cat ?6|ethernet|data|wire|wiring)\b/.test(t)) continue;
    const m = /\b(\d{2,3})\s*(?:-\s*)?(?:feet|foot|ft\b|')/.exec(t);
    if (m && Number(m[1]) >= 10 && Number(m[1]) <= 500) return Number(m[1]);
  }
  return null;
}

/** Port counts of single locations the request gives several ports: "a 2-port keystone plate", "library (2 ports)". */
function multiPortLocations(scope: ScopeDraftV1): number[] {
  // The same plate in a change and in a stated count ("2-port Cat6 keystone plate" × 1) is one location.
  const n = (w: string) => COUNT_WORDS[w] ?? Number(w);
  const plates = (t: string) => [
    ...[...t.matchAll(/\b(\d|two|three|four)[- ]port\s+(?:[\w-]+\s+){0,3}?(?:wall ?plate|faceplate|face plate|plate)\b(?!s)/g)].map((m) => ({ text: m[0], ports: n(m[1]!) })),
    ...[...t.matchAll(/\((\d|two|three|four) ports\)/g)].map((m) => ({ text: m[0], ports: n(m[1]!) })),
  ];
  const inChanges = scope.requested_changes.map(fold).flatMap(plates);
  const inCounts = scope.requested_quantities.map((q) => fold(q.item)).flatMap(plates).filter((p) => !inChanges.some((c) => c.text === p.text));
  return [...inChanges, ...inCounts].map((p) => p.ports).filter((p) => p >= 2);
}

/** The largest count a change gives the device by name ("two Sonos Ports", "3 G6 Bullets"), or null. */
function countedInChanges(scope: ScopeDraftV1, names: string[], longer: string[] = []): number | null {
  let most: number | null = null;
  for (const name of names.map(fold).filter((n) => n.length >= 4)) {
    // A count is a short number on its own, never part of a code: "207363 ADC-V730" is a UPC, "V-1092" a model
    // (past-quote scorecard, 2026-11-08: product names with UPCs priced 207,363 cameras).
    const pattern = new RegExp(`(?<![\\w.-])(\\d{1,3}|two|three|four|five|six)\\s+${escape(name)}(s|es)?\\b`, "g");
    for (const c of scope.requested_changes.map(fold)) {
      for (const m of c.matchAll(pattern)) {
        if (longer.some((l) => c.startsWith(l, m.index! + m[1]!.length + 1))) continue;
        const n = COUNT_WORDS[m[1]!] ?? Number(m[1]);
        if (n > 0 && (most === null || n > most)) most = n;
      }
    }
  }
  return most;
}

const COUNT_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, a: 1 };
const CREW = /\b(\d+|one|two|three|four)[- ](?:man|men|person|people|tech|techs|technicians?|installers?)\b/;
const DAYS = /\b(?:(\d+(?:\.\d+)?|one|two|three|four)[- ](?:full[- ]|whole[- ])?days?|(?:a |one )?(?:full|whole)[- ]day|(half)[- ]a?[- ]?day)\b/;
/**
 * The crew and days the request states for the job ("a 2 man job for a full day", "2 techs for 2 days"),
 * as labor hours at 8 hours a day (Zack's Dunham job, 2026-10-30: 2 techs for a full day priced as 9 hours).
 */
function statedCrewHours(scope: ScopeDraftV1): number | null {
  for (const t of [...requestTexts(scope), ...scope.unresolved_questions.map(fold)]) {
    const c = CREW.exec(t);
    const d = c && DAYS.exec(t);
    if (!c || !d) continue;
    const crew = COUNT_WORDS[c[1]!] ?? Number(c[1]);
    const days = d[2] ? 0.5 : d[1] ? (COUNT_WORDS[d[1]] ?? Number(d[1])) : 1;
    if (crew > 0 && days > 0) return crew * days * 8;
  }
  return null;
}

/** A change the request wants priced on its own line ("priced separately", "as a separate price", "broken out"). */
const SEPARATELY = /\b(?:priced|price|quoted?|listed|shown)\s+(?:out\s+)?separately\b|\bseparate(?:ly)?\s+(?:line|price|priced|quote)\b|\bbroken\s+out\b/;

const allowanceTexts = (scope: ScopeDraftV1) => [...scope.requested_changes, ...scope.requested_quantities.map((q) => (STICK_ITEM.test(q.item) ? `${q.quantity} - ${q.item}` : q.item))].map(fold);

function allowancesFor(
  templates: AllowanceSpec[],
  scope: ScopeDraftV1,
  uncovered: string[],
  lines: SelectionLine[],
  separateRuns: string[] = [],
): Array<AllowanceSpec & { texts: string[]; quantity: number; feet?: number; trenched?: true }> {
  const any = (t: string, words?: string[]) => !!words?.some((w) => hasWord(t, fold(w)));
  const found = templates.flatMap((a) => {
    if (a.covered_by_systems?.some((s) => scope.functional_systems.includes(s))) {
      // A system that covers the work still prices the runs the request wants priced separately, one line each.
      return a.key === "wiring_run" && separateRuns.length ? [{ ...a, texts: separateRuns, asked: true, run: undefined, quantity: separateRuns.length }] : [];
    }
    const asks = (t: string) => any(t, a.mentions) && (!a.require || any(t, a.require)) && !any(t, a.exclude);
    const fromRequest = [...allowanceTexts(scope), ...(a.from_questions ? scope.unresolved_questions.map(fold) : [])].filter(asks);
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
  // The mount's own changes can put it outside too: the customer's porch TV on a tilt mount (Henry, 2026-11-07).
  const outdoor = (!!tv && outdoorAsked(scope, tv)) || mountOutdoor(scope, role);
  if (!role.fits_tv_inches) return undefined;
  if (!inches) return outdoor ? role.larger_tv_variants?.find((v) => !!v.outdoor) : undefined;
  if (!outdoor && inches <= role.fits_tv_inches[1]) return undefined;
  return role.larger_tv_variants?.find((v) => !!v.outdoor === outdoor && inches >= v.fits_tv_inches[0] && inches <= v.fits_tv_inches[1]);
}

/** Every change that names this mount puts it outside ("Porch: customer's TV, tilt mounted"). */
function mountOutdoor(scope: ScopeDraftV1, role: RoleSpec): boolean {
  const terms = [...(role.count_terms ?? []), ...(role.mentions ?? [])].map(fold);
  const named = otherChanges(scope).filter((c) => terms.some((t) => hasWord(c, t)));
  return named.length > 0 && named.every((c) => OUTDOOR.test(c));
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
