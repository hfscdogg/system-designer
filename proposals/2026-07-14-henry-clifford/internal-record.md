# Internal record — Clifford Residence proposal v3 (Draft)

**Not client-facing. Not rep-facing.** This is the internal layer of the
two-layer output (the shape `log_internal_record` will carry), for the
antagonistic roster and the audit trail.

## Record: `routing_decision`

- **Intake:** "Build a proposal for Henry Clifford using the D-Tools skill"
  (second test run of the skill, first with the interview phase in place
  from the start).
- **History:** v1 (PR #5) was assumption-only; v2 (PR #6) added the interview
  and re-scoped to $25–50k. This v3 is a fresh interview: same spaces and
  site context, but the tier moved to **$50–100k** with named depth
  priorities. v3 supersedes v2.
- **Checklist floor:** PASSED — resolved by interview, not assumption.
- **Quote state:** `Draft`. Not promoted. Promotion requires the
  Feedback → Critic → Reflector pass and the Controller's `set_quote_state`
  call — none of which exist yet (Threads 3–4).

## Interview transcript (2026-07-14, v3 run)

| # | Question | Answer |
|---|---|---|
| 1 | Core ask | **Whole-home foundation** (all systems) |
| 2 | Room count / scope | **3–4 spaces** |
| 3 | Budget tier | **$50–100k** (up from $25–50k in v2) |
| 4 | Site context | **Finished home retrofit** |
| 5 | Which spaces | **Kitchen + family room, primary suite, home office, porch/patio** |
| 6 | Where the extra depth goes | **Wired architectural audio; theater-grade family room; motorized shades** — unified control NOT selected |
| 7 | Trim priority if over budget | **Nothing — shrink evenly** |

## Design consequences of the interview

- **Tier jump spent on depth, not width:** same four spaces as v2, but
  interior audio moved from wireless Sonos Era pairs back to **wired
  in-ceiling with retrofit brackets** (his explicit pick, accepting the
  retrofit labor), the family room stepped up from soundbar to **discrete
  surround** (85" BRAVIA 9 + Marantz AVR + in-wall/in-ceiling speakers +
  SVS sub), and **6 Lutron Triathlon battery shades** were added — battery
  chosen specifically because the site is a finished retrofit (no wiring).
- **Unified control declined:** no Control4-class processor. Native apps
  (Sonos / Lutron / UniFi) + one universal remote in the family room. Flagged
  in the client doc that it can be layered on later without re-wiring.
- **Network stepped back up** to the 24-port switch (v2 used 16-port) — the
  wired audio zones, AVR, and theater endpoints consume the extra ports.
- **Shrink evenly** retained as the trim rule; at $62,300 there is ~$38k of
  headroom to the ceiling, so no trims were needed.

## Record: `assembly_trail`

Chunk candidates used (named per the future efficiency-engine library —
Thread 5 will replace these with blessed chunk ids):

| Chunk candidate | System | Why chosen |
|---|---|---|
| LW-NET-FOUNDATION-M-RETRO | Network | Mid backbone; 24-port PoE for added wired endpoints |
| LW-LTG-RA3-4SPACE | Lighting | Carried from v2; swap-in dimmers, no retrofit penalty |
| LW-SHD-TRIATHLON-6 | Shades | Battery rollers = zero wiring in finished walls; rides the RA3 processor already in the design |
| LW-AUD-WIRED-4ZONE-RETRO | Audio | Interview picked wired architectural over wireless; retrofit brackets + wire fishing priced in labor |
| LW-MED-85-DISCRETE-RETRO | Theater | Interview picked theater-grade: discrete AVR surround, hidden speakers |
| LW-CAM-UNIFI-3CAM-RETRO | Surveillance | Carried from v2 unchanged |

## Margin trail (all placeholder)

Unit-price sums in `opportunity.draft.json` total **$35,175**. The
client-facing equipment figures total **$45,200** — the ~28.5% delta is a
flat placeholder allowance for bulk materials (speaker wire, retrofit
brackets, connectors, mounts, rack hardware) plus margin headroom, applied
per system and rounded. It is **not** a real margin model; the D-Tools
catalog is the pricing source of truth at promotion, and the Critic should
attack this allowance explicitly. Labor placeholder: 126 hours × $135/hr =
$17,010, presented as $17,100 after per-system rounding. Retrofit uplift
lands in audio (26 h, ceiling cuts + fishing) and theater (24 h, in-wall
retrofit).

## Flagged assumptions (default chosen → reason)

Floor items and depth priorities are interview-resolved. Remaining:

1. Attic/crawl access for wire fishing, office drop, patio wiring, camera
   runs → assumed available: most-common case; wall-open-and-patch becomes a
   visible change order.
2. Theater front-stage in-wall speakers assume standard stud bays without
   fire blocking at speaker height → fallback to on-wall/in-ceiling
   equivalents stated in the client doc.
3. Shade count: 4 kitchen/family + 2 primary → typical window counts; final
   at measurement, and shades are the largest per-unit swing item.
4. 85" display → sized to tier; pending wall measurement.

## Open items for the roster

- **Feedback:** is Marantz + Sonance + SVS the Livewire-standard stack for a
  living-room discrete surround, or does the house standard call for a
  different AVR/speaker line? Is Triathlon (battery) acceptable at this tier
  or does the standard push wired Sivoia?
- **Critic:** Sonos Amp zones + a Marantz AVR in one room set = two audio
  ecosystems in the family room (kitchen zone on Sonos, theater on AVR).
  Confirm the kitchen in-ceiling pair shouldn't instead hang off the AVR's
  zone 2 — one fewer Sonos Amp, tighter integration, less app-switching.
- **Critic:** no unified control at a six-system, $62k scope — is the
  native-apps-plus-remote experience defensible, or should the proposal
  carry a priced Control4 alternate for the client to see?
- **Reflector:** interview answered the floor and depth — no iteration loop
  required before the (future) promotion path; site-access and fire-blocking
  assumptions are the walkthrough confirmations.
- **Thread 1 dependency:** every API field in `opportunity.draft.json` is
  `TODO(spike)`; if Quotes are GET-only, chunk candidates must become Quote
  Template content.
