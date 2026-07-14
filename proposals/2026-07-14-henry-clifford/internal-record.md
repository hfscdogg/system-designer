# Internal record — Clifford Residence proposal (Draft)

**Not client-facing. Not rep-facing.** This is the internal layer of the
two-layer output (the shape `log_internal_record` will carry), for the
antagonistic roster and the audit trail.

## Record: `routing_decision`

- **Intake:** "Build a proposal for Henry Clifford using the D-Tools skill."
  Single sentence; no room count, no budget tier, no core ask.
- **Checklist floor:** FAILED all three items. Per the Controller principle
  (forgiving front end), the proposal was produced anyway with the floor items
  as prominent flagged defaults, listed first in the client-facing
  assumptions.
- **Quote state:** `Draft`. Not promoted. Promotion requires the
  Feedback → Critic → Reflector pass and the Controller's `set_quote_state`
  call — none of which exist yet (Threads 3–4).

## Record: `assembly_trail`

Chunk candidates used (named per the future efficiency-engine library —
Thread 5 will replace these with blessed chunk ids):

| Chunk candidate | System | Why chosen |
|---|---|---|
| LW-NET-FOUNDATION-M | Network | Default mid-size wired backbone; every other system depends on it |
| LW-LTG-RA3-MAINSPACES | Lighting | RA3 fits the assumed tier without a full-panel commitment |
| LW-AUD-SONOS-4ZONE | Audio | Four-zone default for a six-room scope; family-operable |
| LW-MED-85-SONOS-SURROUND | Media room | Big-screen + soundbar-based surround avoids AVR rack complexity at this tier |
| LW-CAM-UNIFI-4CAM | Surveillance | Local recording, no subscription, rides the UniFi backbone already specified |

## Margin trail (all placeholder)

Unit-price sums in `opportunity.draft.json` total **$28,603**. The
client-facing equipment figures total **$37,600** — the ~31% delta is a flat
placeholder allowance for bulk materials (wire, connectors, mounts, rack
hardware) plus margin headroom, applied per system and rounded. It is **not**
a real margin model; the D-Tools catalog is the pricing source of truth at
promotion, and the Critic should attack this allowance explicitly. Labor
placeholder: 113 hours × $135/hr = $15,255, presented as $15,400 after
per-system rounding.

## Flagged assumptions (default chosen → reason)

1. Room count → **6 primary spaces**: modal Livewire whole-home scope; middle
   of the range a rep intake usually implies.
2. Budget tier → **mid/upper (~$50–60k)**: matches a whole-home foundation
   ask; alternates offered rather than guessed.
3. Core ask → **whole-home foundation**: "a proposal" with no system named
   defaults to the foundation package, the highest-coverage interpretation.
4. Wire access → new construction / accessible runs: cheapest-true default;
   retrofit is a visible adder, not a hidden risk.
5. Lighting scope → main spaces only: whole-house fixture control belongs to
   an explicit ask, not an assumption.
6. Exclusions (shades, distributed video, dedicated theater, alarm) → named
   in the client doc as add-ons so the Critic can test whether any should be
   in scope.

## Open items for the roster

- **Feedback:** are these chunk candidates consistent with current Livewire
  standards (esp. Sonos vs. Control4-based control at this tier)?
- **Critic:** does a 24-port PoE budget cover 4 APs + 5 cameras + spares?
  Is a soundbar-based media room defensible at an $11k equipment level, or
  does the tier imply discrete surround?
- **Reflector:** the intake gave zero floor items — should this iterate once
  with the rep before any promotion path, despite the forgiving-front-end
  rule? (Recommend: yes, via the soft "anything else?" check-in.)
- **Thread 1 dependency:** every API field in `opportunity.draft.json` is
  `TODO(spike)`; if Quotes are GET-only, chunk candidates must become Quote
  Template content.
