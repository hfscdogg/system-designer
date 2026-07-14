# Internal record — Clifford Residence proposal v2 (Draft)

**Not client-facing. Not rep-facing.** This is the internal layer of the
two-layer output (the shape `log_internal_record` will carry), for the
antagonistic roster and the audit trail.

## Record: `routing_decision`

- **Intake:** "Build a proposal for Henry Clifford using the D-Tools skill."
- **v1 (merged in PR #5):** produced with zero interview — all three
  checklist-floor items assumed (6 rooms, mid/upper tier, ~$53k). Henry's
  feedback: *the skill is supposed to interview the user.* Correct — the
  never-interrogate rule governs the rep SMS pipeline, not an interactive
  requester. The skill now interviews first (Step 0); this v2 supersedes v1.
- **Checklist floor:** PASSED — resolved by interview, not assumption.
- **Quote state:** `Draft`. Not promoted. Promotion requires the
  Feedback → Critic → Reflector pass and the Controller's `set_quote_state`
  call — none of which exist yet (Threads 3–4).

## Interview transcript (2026-07-14)

| # | Question | Answer |
|---|---|---|
| 1 | Core ask | **Whole-home foundation** (all five systems) |
| 2 | Room count / scope | **3–4 spaces** |
| 3 | Budget tier | **$25–50k** |
| 4 | Site context | **Finished home retrofit** |
| 5 | Which spaces | **Kitchen + family room, primary suite, home office, porch/patio** |
| 6 | Trim priority if over budget | **Nothing — shrink evenly**, keep all five systems |

## Design consequences of the interview

- **Retrofit → wireless-first:** interior audio moved from amp + in-ceiling
  (v1) to Sonos Era wireless pairs — no ceiling cuts. Lighting stayed Lutron
  RA3 because Sunnata dimmers swap into existing boxes with no retrofit
  penalty. Wired runs limited to where they're non-negotiable: office drop,
  patio speakers, exterior cameras.
- **Shrink evenly → all five systems retained**, each stepped down one notch:
  16-port switch / 3 APs (was 24 / 4), 8 dimmers (was 12), 75" BRAVIA 7 +
  Arc/Sub (was 85" BRAVIA 9 + full surround), 3 cameras (was 4).
- **Budget positioning:** $34,500 placeholder total sits mid-tier with ~$10k
  headroom under the $50k ceiling — deliberate retrofit contingency, per the
  "shrink evenly" instruction rather than packing the ceiling.

## Record: `assembly_trail`

Chunk candidates used (named per the future efficiency-engine library —
Thread 5 will replace these with blessed chunk ids):

| Chunk candidate | System | Why chosen |
|---|---|---|
| LW-NET-FOUNDATION-S-RETRO | Network | Small-tier backbone; retrofit cable routes; still PoE headroom for 3 APs + 4 cameras |
| LW-LTG-RA3-4SPACE | Lighting | RA3 wireless dimmers = near-zero retrofit penalty at this tier |
| LW-AUD-SONOS-WIRELESS-RETRO | Audio | Wireless interior zones avoid ceiling cuts; wired patio where it matters |
| LW-MED-75-ARC-LIVING | Media | Living-space media (not dedicated room); Arc Ultra doubles as the room's music zone |
| LW-CAM-UNIFI-3CAM-RETRO | Surveillance | Local recording, no subscription; 3 cameras cover the three approaches |

## Margin trail (all placeholder)

Unit-price sums in `opportunity.draft.json` total **$17,822**. The
client-facing equipment figures total **$22,900** — the ~28% delta is a flat
placeholder allowance for bulk materials (wire, connectors, mounts, rack
hardware) plus margin headroom, applied per system and rounded. It is **not**
a real margin model; the D-Tools catalog is the pricing source of truth at
promotion, and the Critic should attack this allowance explicitly. Labor
placeholder: 86 hours × $135/hr = $11,610, presented as $11,600 after
per-system rounding. Retrofit uplift is reflected in network (26 h) and
surveillance (16 h) hours.

## Flagged assumptions (default chosen → reason)

Floor items are interview-resolved and no longer assumptions. Remaining:

1. Attic/crawl access for the office drop, patio wiring, and camera runs →
   assumed available: most-common case; wall-open-and-patch becomes a visible
   change order, not hidden labor.
2. Kitchen/family as one open zone with the Arc Ultra as its music source →
   avoids a redundant speaker pair; easy add if the layout says otherwise.
3. 75" display → sized to tier and typical family-room wall; pending
   measurement.

## Open items for the roster

- **Feedback:** is a Sonos-wireless interior audio package consistent with
  Livewire standards at the $25–50k tier, or does the standard call for wired
  architectural audio even in retrofit?
- **Critic:** does the 16-port PoE budget (3 APs + 3 cameras + doorbell +
  UNVR + spares) leave enough headroom? Is the ~$10k budget headroom the
  right retrofit contingency, or should scope fill more of the tier?
- **Reflector:** interview answered all floor items — no iteration loop
  required before the (future) promotion path; site-access assumption #1 is
  the one item worth a rep confirmation at walkthrough.
- **Thread 1 dependency:** every API field in `opportunity.draft.json` is
  `TODO(spike)`; if Quotes are GET-only, chunk candidates must become Quote
  Template content.
