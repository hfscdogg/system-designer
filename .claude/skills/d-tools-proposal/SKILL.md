---
name: d-tools-proposal
description: >-
  Build a Livewire proposal in the D-Tools Cloud deliverable shape — an
  Opportunity carrying a draft Quote built from the standard Quote Template.
  Use when asked to draft, stage, or review a proposal / scope of work / quote
  for a client or internal pilot. Produces the two-layer output (client-facing
  scope + internal margin/assembly trail) with assumptions flagged, never
  interrogated.
---

# D-Tools Proposal Skill

You are producing the deliverable the Livewire System Designer stages in
D-Tools Cloud: an **Opportunity** with a **draft Quote**. Until the D-Tools API
key is in play (it lives host-side only — see locked decision #4 in the root
`README.md`), the deliverable is authored as repo artifacts in the exact shape
the orchestrator will later `POST`.

## Governing principles (from the Controller system prompt — do not dilute)

1. **Forgiving on the front end.** Tolerate messy intake. When information is
   missing, assume a reasonable default and **flag it** — never interrogate,
   never block on a missing confirmation. The hard checklist floor is small:
   room count, rough budget tier, the core ask. Everything above the floor is
   assume-and-flag.
2. **Antagonistic on the back end.** The proposal does not leave Draft until it
   is sound. Every assumption is visible for the antagonistic roster
   (Feedback → Critic → Reflector) to attack.
3. **Ownership boundary.** The proposal stays in **Draft** state. Promotion
   past Draft is the Controller's `set_quote_state` gate, after roster
   sign-off — never done by this skill.

## Deliverable model (D-Tools Cloud facts — Thread 1 spike)

- A new Quote is **always `Draft`** → `In Progress` → `Accepted`/`Declined`.
- The Quote Template is chosen at Opportunity-create time and preloads
  products + labor. Public docs say **Quotes are GET-only** over the Cloud
  API, so reusable product chunks likely live **in the template**, not written
  per-quote. Until `spikes/thread1-dtools/FINDINGS.md` is filled in, mark
  every API field name `TODO(spike)`.
- Base URL `https://dtcloudapi.d-tools.cloud/api/v1`, auth `X-API-Key`. The
  key never appears in a proposal artifact, prompt, or log.

## Output: three artifacts per proposal, under `proposals/<date>-<client>/`

### 1. `proposal.md` — client-facing scope of work
The layer the rep hands the customer. Warm, plain-language, zero internal
data. Structure:

- **Header** — client, prepared-by, date, quote state (`Draft`), validity.
- **Project overview** — the core ask in 2–4 sentences, in the client's terms.
- **Scope of work by system** — one section per system (e.g. Network &
  Infrastructure, Lighting Control, Whole-Home Audio, Media Room,
  Surveillance). Each section: what it does for the client, then the
  equipment lines (qty / item / purpose — client-facing, no margin), then
  included labor in plain terms.
- **Investment summary** — equipment, labor/programming, subtotals, total.
  Price alternates (good/better/best) only if the intake asked.
- **Assumptions & exclusions** — every assume-and-flag item, stated plainly.
- **What happens next** — review, revision, acceptance path.

### 2. `opportunity.draft.json` — the API-shaped payload
The body the host-side orchestrator would `POST` to
`Opportunities/AddOpportunity` (path itself `TODO(spike)`), plus the intended
quote line structure. Every unverified field name carries a `_todo_spike`
sibling note. This file is the contract between the proposal and Thread 1.

### 3. `internal-record.md` — the internal layer
Invisible to rep and customer (the `log_internal_record` payload shape):
margin/assembly trail, which reusable chunks were used and why, every flagged
assumption with the default chosen and the reason, checklist-floor status, and
open items for the antagonistic roster.

## Pricing and product discipline

- Until D-Tools catalog access exists, prices are **placeholders** — plausible
  street-price magnitudes, each marked `placeholder`. Never present a
  placeholder as a firm number: the client-facing doc must say pricing is
  finalized from the D-Tools catalog at promotion.
- Products are named at real-world brand/model level so the Feedback agent can
  check them against Livewire standards, but marked *representative* until
  matched to catalog SKUs.
- Labor as hours × role rate, placeholder rates flagged.

## Hard rules

- Quote state in every artifact: `Draft`. This skill never promotes.
- No credentials, keys, or tenant identifiers in any artifact.
- Flag, don't ask: a missing detail above the checklist floor becomes a
  visible assumption, not a question back to the requester.
- If the intake fails the checklist floor (no room count, no budget tier, or
  no discernible core ask), produce the proposal anyway with the floor items
  as **prominent** flagged defaults at the top of the assumptions section.
