---
name: d-tools-proposal
description: >-
  Build a Livewire proposal in the D-Tools Cloud deliverable shape — an
  Opportunity carrying a draft Quote built from the standard Quote Template.
  Use when asked to draft, stage, or review a proposal / scope of work / quote
  for a client or internal pilot. INTERVIEWS the requester first when they are
  available to answer; assume-and-flag is the fallback, not the default.
  Produces the two-layer output (client-facing scope + internal
  margin/assembly trail).
---

# D-Tools Proposal Skill

You are producing the deliverable the Livewire System Designer stages in
D-Tools Cloud: an **Opportunity** with a **draft Quote**. Until the D-Tools API
key is in play (it lives host-side only — see locked decision #4 in the root
`README.md`), the deliverable is authored as repo artifacts in the exact shape
the orchestrator will later `POST`.

## Step 0 — Interview the requester FIRST

**When the requester can answer (an interactive session — AskUserQuestion is
available), interview before authoring anything.** Do not guess what you can
ask. The interview is short and structured:

**Round 1 — the checklist floor plus site context (always ask):**
1. **Core ask** — what should the proposal cover (whole-home foundation,
   entertainment-focused, network + security, single room)?
2. **Room count / scope size** — how many spaces?
3. **Budget tier** — bracketed ranges, not an open-ended number.
4. **Site context** — new construction / pre-wire, major remodel, or finished
   retrofit. This drives wiring strategy and labor.

**Round 2 — targeted follow-ups shaped by round 1 (at most one round):**
- Which specific spaces are in scope (multi-select).
- Trim priority — if labor or site conditions push past budget, what gets
  value-engineered first?
- Anything round 1 made ambiguous (e.g. "single room" → which room).

Keep it to **two rounds maximum**. Offer concrete options with a recommended
default first; every question must change the design if answered differently.
Whatever the interview did not cover — or the requester skipped — falls back
to **assume-and-flag**.

**Scope of the never-interrogate rule:** the Controller principle "never
demand detail-oriented behavior from a rep" governs the **SMS intake pipeline**
(reps, over text, mid-hustle). It does not apply to an interactive requester
who invoked this skill and is sitting there able to answer. Interview the
requester; never interrogate the rep.

## Governing principles (from the Controller system prompt — do not dilute)

1. **Forgiving on the front end.** Tolerate messy intake. For anything the
   interview couldn't resolve, assume a reasonable default and **flag it** —
   never block on a missing confirmation. The hard checklist floor is small:
   room count, rough budget tier, the core ask.
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
  Price alternates (good/better/best) only if the interview or intake asked.
- **Assumptions & exclusions** — every assume-and-flag item, stated plainly.
  Interview answers are **decisions**, not assumptions — record them in the
  overview, not here.
- **What happens next** — review, revision, acceptance path.

### 2. `opportunity.draft.json` — the API-shaped payload
The body the host-side orchestrator would `POST` to
`Opportunities/AddOpportunity` (path itself `TODO(spike)`), plus the intended
quote line structure. Every unverified field name carries a `_todo_spike`
sibling note. This file is the contract between the proposal and Thread 1.

### 3. `internal-record.md` — the internal layer
Invisible to rep and customer (the `log_internal_record` payload shape):
margin/assembly trail, which reusable chunks were used and why, the
**interview transcript** (question → answer), every flagged assumption with
the default chosen and the reason, checklist-floor status, and open items for
the antagonistic roster.

## Pricing and product discipline

- Until D-Tools catalog access exists, prices are **placeholders** — plausible
  street-price magnitudes, each marked `placeholder`. Never present a
  placeholder as a firm number: the client-facing doc must say pricing is
  finalized from the D-Tools catalog at promotion.
- Products are named at real-world brand/model level so the Feedback agent can
  check them against Livewire standards, but marked *representative* until
  matched to catalog SKUs.
- Labor as hours × role rate, placeholder rates flagged. Retrofit site context
  adds labor and shifts the design wireless-first where sensible.
- Client-facing equipment figures may carry a materials/headroom allowance
  above raw unit sums — the delta must be stated in the internal record.

## Hard rules

- Quote state in every artifact: `Draft`. This skill never promotes.
- No credentials, keys, or tenant identifiers in any artifact.
- Interview when the requester is present; flag-don't-ask only for what the
  interview couldn't cover, or when there is no interactive requester (e.g.
  rep SMS intake replayed through the pipeline).
- If the checklist floor is still unresolved after the interview (requester
  skipped, or non-interactive), produce the proposal anyway with the floor
  items as **prominent** flagged defaults at the top of the assumptions
  section.
