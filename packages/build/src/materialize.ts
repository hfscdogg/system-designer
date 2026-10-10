import { isAddOnRequest, type ScopeDraftV1 } from "@sd/core";
import type { NamedProduct } from "./named.ts";
import { laborHoursFor, type PatternSpec, type RoleSpec } from "./pattern.ts";

/**
 * Deterministic materializer (PRD §13.2): approved scope + approved pattern →
 * selection. No model call, no catalog search, no invented quantities.
 */
export type Classification = "supported" | "allowance" | "unresolved";

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
  lines: SelectionLine[];
  services: Array<{ category: string; record_id: string; quantity: 1 }>;
  /** Project labor estimate; null when the pattern has no labor model. */
  labor: { labor_type: string; hours: number; devices: number; covers: string[]; extras: string[] } | null;
  parts: { record_id: string } | null;
  requirements: Array<{ system: string; classification: Classification; roles: string[]; note: string }>;
  allowances: Array<{ label: string; reason: string }>;
  unresolved: Array<{ item: string; role: string | null; reason: string; escalate: boolean }>;
}

const fold = (s: string) => s.toLowerCase();

function mentioned(scope: ScopeDraftV1, terms: string[]): boolean {
  const text = fold([...scope.requested_changes, ...scope.requested_quantities.map((q) => q.item), ...scope.functional_systems, ...scope.room_types].join(" | "));
  return terms.some((t) => text.includes(fold(t)));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Count terms are short words ("door"), so they match whole words only: "doors" yes, "doorbell" no. */
function hasWord(text: string, term: string): boolean {
  return new RegExp(`\\b${escape(term)}(s|es)?\\b`).test(text);
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
  const terms = deviceTerms(role).filter((term) => t.includes(term));
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
  for (const q of scope.requested_quantities) {
    const scores = roles.map((r) => matchScore(q.item, r));
    const best = Math.max(...scores);
    if (best > 0 && roles[scores.indexOf(best)] === role) return q.quantity;
  }
  return null;
}

/** Whether the request itself names this role (its changes or a stated count), for add-on pricing. */
function named(scope: ScopeDraftV1, role: RoleSpec, roles: RoleSpec[]): boolean {
  const changes = fold(scope.requested_changes.join(" | "));
  const byModel = !!role.model && compact(changes).includes(compact(role.model));
  const byDevice = (r: RoleSpec, c: string) => deviceTerms(r).some((t) => c.includes(t)) || (r.count_terms ?? []).some((t) => hasWord(c, fold(t)));
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
  const changes = fold(scope.requested_changes.join(" | "));
  return (
    [role.label, ...(role.mentions ?? [])].some((t) => changes.includes(fold(t))) ||
    (role.count_terms ?? []).some((t) => hasWord(changes, fold(t))) ||
    statedQuantity(scope, role, roles) !== null
  );
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
const SIZE = /\b(\d{2,3})\s*(?:-\s*)?(?:inch(?:es)?|in\b\.?|"|”|″)/g;

const changes = (scope: ScopeDraftV1) => scope.requested_changes.map(fold);
const moveChanges = (scope: ScopeDraftV1) => changes(scope).filter((c) => MOVE.test(c));
const otherChanges = (scope: ScopeDraftV1) => changes(scope).filter((c) => !MOVE.test(c));

/** The request asks for a new one of this device, even if the customer also has an existing one ("sell a new 75-inch TV"). */
function wantsNew(scope: ScopeDraftV1, role: RoleSpec): boolean {
  return otherChanges(scope).some((c) => roleTerms(role).some((t) => c.includes(t)) && NEW_DEVICE.test(c));
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
  return moveChanges(scope).filter(names).length;
}

const DEVICE_NOUNS = ["access", "point", "node", "unit", "device", "system", "network", "equipment"];
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
    const hit = terms.filter((t) => hasWord(item, t));
    if (!hit.length) return false;
    // Once the item names the role, the role's own words ("eero Pro 7 mesh Wi-Fi") and generic device
    // nouns ("access points", "system") don't count against it: "eero access points" removes the eeros.
    const covered = new Set([...terms.flatMap((t) => t.split(/[\s/-]+/)), ...DEVICE_NOUNS]);
    const rest = item.split(/[\s/-]+/).filter((w) => w && !FILLER.has(w) && !covered.has(w) && !covered.has(w.replace(/e?s$/, "")));
    return rest.length <= 1;
  });
}

/** The approved record for the size the request names for a new device, if the role has size variants. */
function variantFor(scope: ScopeDraftV1, role: RoleSpec) {
  const sizes = otherChanges(scope).flatMap((c) => [...c.matchAll(SIZE)].map((m) => Number(m[1])));
  return role.variants?.find((v) => v.sizes.some((n) => sizes.includes(n)));
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
    const scores = roles.map((r) => matchScore(`${n.category} ${n.label} ${n.text}`, r) + matchScore(leaf, r));
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

/** A stated count whose item names this product by model ("2 AN-620-SW-R-24-POE"). */
function statedForProduct(scope: ScopeDraftV1, n: NamedProduct | undefined): number | null {
  if (!n) return null;
  const m = compact(n.model);
  return scope.requested_quantities.find((q) => compact(q.item).includes(m))?.quantity ?? null;
}

export function materialize(original: ScopeDraftV1, pattern: PatternSpec, namedProducts: NamedProduct[] = []): Selection {
  const lines: SelectionLine[] = [];
  const allowances: Selection["allowances"] = [];
  const unresolved: Selection["unresolved"] = [];
  const included: RoleSpec[] = [];
  const blockedRoles = new Set<string>();

  const candidates = pattern.roles.filter((role) => role.systems.some((s) => original.functional_systems.includes(s)));
  // Products the request names by model are priced in the role they fill, and name that role. Their words name nothing else.
  const requested = namedForRoles(namedProducts, candidates);
  const priced = [...requested.values()].flat();
  const scope = withoutNamedWords(original, priced);
  const names = (r: RoleSpec) => requested.has(r.role) || named(scope, r, pattern.roles);
  // An add-on prices only the devices the request names. A pattern it names nothing from (e.g. "add Wi-Fi") is priced whole.
  const addOnRequested = isAddOnRequest(original);
  const addOn = addOnRequested && candidates.some(names);

  // In a group of alternatives (turret vs floodlight cameras), naming any one prices only the ones named.
  const namedGroups = new Set(candidates.filter((r) => r.alternative_group && namedSpecifically(scope, r, pattern.roles)).map((r) => r.alternative_group!));
  const removedRoles = new Set<string>();
  for (const role of candidates) {
    if (role.alternative_group && namedGroups.has(role.alternative_group) && !namedSpecifically(scope, role, pattern.roles)) continue;
    // In an add-on, a role is priced when the request names it or names its own system (smoke detection alongside sensors).
    const ownSystemRequested = role.systems.some((s) => scope.functional_systems.includes(s) && !pattern.applies_when_any.includes(s));
    const products = requested.get(role.role) ?? [];
    const product = products[0];
    if (addOn && !names(role) && !ownSystemRequested) continue;
    if (role.mentions && !mentioned(scope, role.mentions) && !modelNamed(scope, role) && !product) continue;
    if (role.existing_detectors && !(role.existing_detectors as string[]).includes(scope.existing_detectors)) continue;
    if (excluded(scope, role)) {
      removedRoles.add(role.role);
      continue;
    }
    included.push(role);

    const retained = role.retained_match?.length
      ? scope.retained_equipment.find((e) => role.retained_match!.some((t) => fold(e).includes(fold(t))))
      : undefined;
    if (retained && !wantsNew(scope, role) && !product) {
      // Existing equipment being moved stays the customer's: its mount and labor are priced on the roles that carry it.
      if (movedCount(scope, role.retained_match ?? []) > 0) continue;
      // Retained equipment awaiting field testing is unresolved, not supported (PRD §12).
      unresolved.push({ item: `${role.label} (retained: ${retained})`, role: role.role, reason: "existing equipment must be field-tested before it can be reused", escalate: false });
      blockedRoles.add(role.role);
      continue;
    }
    if (!role.product_id && !product) {
      unresolved.push({ item: role.label, role: role.role, reason: "no Livewire standard product is configured for this role", escalate: role.critical || role.escalate_if_unresolved });
      blockedRoles.add(role.role);
      continue;
    }
    // A count the requester stated is used as written; otherwise the pattern's quantity (a minimum is verified on site).
    const stated = product ? (statedForProduct(original, product) ?? statedQuantity(scope, role, pattern.roles)) : statedQuantity(scope, role, pattern.roles);
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
    lines.push({
      role: role.role,
      record_id: product?.record_id ?? variantFor(scope, role)?.product_id ?? role.product_id!,
      quantity: (stated ?? (minimum && role.quantity.qty > 1 && namedAsOne(scope, role) ? 1 : role.quantity.qty)) + moved,
      quantity_basis: minimum ? "minimum_to_verify" : "fixed",
      verify: moved && verify ? `${verify}; includes ${moved} for moved existing equipment (confirm wall and power in the new room)` : verify,
      // A single-room scope places devices in that room; otherwise use the pattern's location.
      location,
      precedent: role.precedent,
      ...(product && product.record_id !== role.product_id ? { requested_model: product.model } : {}),
    });
  }

  const devices = lines.reduce((n, l) => n + l.quantity, 0);
  // Labor-only allowances the request mentions (framing a niche), priced as hours at the pattern's labor rate.
  const extras = (pattern.labor_extras ?? []).filter((x) => mentioned(scope, x.mentions)).map((x) => x.id);
  const labor: Selection["labor"] =
    pattern.labor && devices > 0
      ? { labor_type: pattern.labor.labor_type, hours: laborHoursFor(pattern, lines, addOn, extras), devices, covers: pattern.labor.covers, extras }
      : null;

  const services: Selection["services"] = [];
  for (const category of scope.service_categories) {
    if (labor?.covers.includes(category)) continue;
    const spec = pattern.services.find((s) => s.category === category);
    if (spec?.product_id) services.push({ category, record_id: spec.product_id, quantity: 1 });
    else allowances.push({ label: spec?.label ?? category, reason: "no authenticated price; shown as a TBD allowance outside committed totals" });
  }

  // A system whose devices the request removed entirely is no longer required.
  const removedSystems = scope.functional_systems.filter(
    (system) => !included.some((r) => r.systems.includes(system)) && candidates.some((r) => r.systems.includes(system) && removedRoles.has(r.role)),
  );
  const requirements: Selection["requirements"] = scope.functional_systems.filter((s) => !removedSystems.includes(s)).map((system) => {
    const roles = included.filter((r) => r.systems.includes(system));
    if (!roles.length) {
      unresolved.push({ item: system, role: null, reason: `not covered by the ${pattern.title} pattern`, escalate: true });
      return { system, classification: "unresolved", roles: [], note: "no approved pattern role" };
    }
    const blockedCritical = roles.filter((r) => r.critical && blockedRoles.has(r.role));
    if (blockedCritical.length) {
      return { system, classification: "unresolved", roles: roles.map((r) => r.role), note: `unresolved: ${blockedCritical.map((r) => r.label).join(", ")}` };
    }
    const priced = roles.filter((r) => !blockedRoles.has(r.role));
    return { system, classification: priced.length ? "supported" : "unresolved", roles: roles.map((r) => r.role), note: priced.map((r) => r.capability).join("; ") };
  });

  return {
    schema: "selection_v1",
    pattern: pattern.pattern,
    pattern_version: pattern.version,
    add_on: addOn,
    lines,
    services,
    labor,
    parts: pattern.parts && lines.length ? { record_id: pattern.parts.product_id } : null,
    requirements,
    allowances,
    unresolved,
  };
}
