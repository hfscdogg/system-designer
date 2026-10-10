/**
 * Most Livewire jobs add devices to a system the customer already has ("add 3
 * Halo remotes", "another Sonos Port"). Those are priced as an add-on: only the
 * devices named, with no system core. Replacing or upgrading equipment is a
 * modernization and is priced as a complete system, as is anything ambiguous.
 */
const ADD_ON_VERB = /^(add|adding|additional|another|extra|move|relocate|fix|repair)\b/;
const WHOLE_SYSTEM = /\b(new (security |alarm |audio |network |wi-?fi |control4 |lighting |camera )?system|whole[- ](home|house)|full system|complete system|entire (home|house|system)|new construction|new home|new build|pre-?wire|(install|new) (a |an )?(security|alarm) system)\b/;

/** Replacing a consumable part (a panel battery) is service on the existing system, not a modernization. */
const SERVICE_PART = /^(replace|replacing|swap|change)\b.*\bbatter(y|ies)\b/;

export function isAddOnRequest(scope: { requested_changes: string[] }): boolean {
  const changes = scope.requested_changes.map((c) => c.trim().toLowerCase()).filter(Boolean);
  if (!changes.length) return false;
  if (changes.some((c) => WHOLE_SYSTEM.test(c))) return false;
  return changes.every((c) => ADD_ON_VERB.test(c) || SERVICE_PART.test(c));
}
