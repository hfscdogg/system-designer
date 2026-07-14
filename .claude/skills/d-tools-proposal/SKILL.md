---
name: d-tools-proposal
description: >-
  Universal proposal skill for any customer scenario: interview the requester,
  create the Opportunity (with its draft Quote) in D-Tools Cloud, build the
  scope of work right in the chat, and deliver the client-facing proposal as
  an HTML page. Use when asked to draft, stage, or review a proposal / scope
  of work / quote. Conversation-scoped: it never commits proposal files to the
  repo or opens pull requests.
---

# D-Tools Proposal Skill

One interaction, one proposal, any customer. The flow is always:
**interview → stage in D-Tools → scope in chat → HTML proposal.**

This skill is **universal**. Nothing in it is specific to any one customer;
every scenario detail comes from the interview. It is also
**conversation-scoped**: the deliverables are the chat scope, the D-Tools
record, and the HTML proposal — **never** files committed to this repo, and
**never** a pull request. (Editing this skill itself is normal repo work;
running it is not.)

## Step 0 — Interview the requester

When the requester can answer (AskUserQuestion available), interview before
authoring anything. Two rounds maximum, concrete options, recommended default
first; every question must change the design if answered differently.

**Round 1 — checklist floor + site context (always):**
1. **Core ask** — what should the proposal cover?
2. **Room count / scope size.**
3. **Budget tier** — bracketed ranges.
4. **Site context** — new construction / remodel / finished retrofit. Drives
   wiring strategy and labor.

**Round 2 — targeted follow-ups shaped by round 1:**
- Which specific spaces (multi-select).
- Where extra budget depth goes, or what gets trimmed first.
- Anything round 1 left ambiguous.

Anything unanswered falls back to **assume-and-flag** (visible assumption,
never a blocker). The never-interrogate rule belongs to the rep SMS pipeline,
not to an interactive requester.

## Step 1 — Create the Opportunity in D-Tools Cloud

Stage the record as early as the interview allows — Opportunity first, scope
refined after, exactly like the production pipeline.

- **If D-Tools is reachable** (a `DTOOLS_API_KEY` is available in the running
  environment and egress permits): `POST` the Opportunity from the standard
  Quote Template — base URL `https://dtcloudapi.d-tools.cloud/api/v1`, auth
  `X-API-Key`, endpoint map per `spikes/thread1-dtools/dtools_spike.py`
  (paths marked `TODO(spike)` until `FINDINGS.md` is filled in). Read back
  the Opportunity and confirm the spawned Quote is in **Draft**. Show the
  requester the opportunity id/link in chat.
- **If not reachable** (no key, or egress blocked — e.g. an agent-build
  session, per locked decision #4 in the root `README.md`): show the exact
  request payload in chat, clearly marked **not sent**, and continue. The
  proposal does not block on the API.
- The key is read from the environment only. It never appears in chat, in
  the HTML, or in any log — redact it everywhere.

## Step 2 — Build the scope of work in the chat

Present the scope **in the conversation**, not in files: one section per
system, each with what it does for the client, the equipment lines
(qty / item / purpose), and included labor in plain terms — then an
investment summary. Iterate here: the requester reacts in chat, the scope
updates in chat.

Two-layer discipline:
- **Client layer** — the scope and investment summary. No margins, no
  internal reasoning.
- **Internal layer** — stays in chat for the requester only (and, in the
  production pipeline, goes to `log_internal_record`): interview transcript,
  chunk/assembly choices and why, the equipment allowance delta over raw
  unit sums, flagged assumptions with reasons, open questions a reviewer
  should attack. Never in the client HTML.

## Step 3 — Deliver the proposal as HTML

Render the **client layer** as a polished, self-contained HTML proposal page
and deliver it (as a rendered file or published artifact — whatever the
surface supports). Header (client, prepared-by, date, quote state `Draft`,
validity), project overview in the client's terms, scope by system,
investment summary, assumptions & exclusions, what happens next. Interview
answers are decisions and belong in the overview, not the assumptions list.

## Pricing and product discipline

- Without live D-Tools catalog access, prices are **placeholders** at
  street-price magnitude, and the proposal must say pricing is finalized from
  the D-Tools catalog at promotion. Never present a placeholder as firm.
- Products at real brand/model level so they can be checked against Livewire
  standards, marked *representative* until matched to catalog SKUs.
- Labor as hours × role rate, placeholder rates flagged. Retrofit context
  adds labor and shifts wireless-first where sensible.
- Client-facing equipment figures may carry a materials/headroom allowance
  above raw unit sums — state the delta in the internal layer.

## Hard rules

- Quote state is always **Draft**. This skill never promotes — promotion is
  the Controller's `set_quote_state` gate after the antagonistic roster
  (Feedback → Critic → Reflector) signs off.
- Universal: no customer-specific content lives in this skill.
- Conversation-scoped: no proposal files committed to the repo, no branches,
  no pull requests for a proposal run.
- No credentials, keys, or tenant identifiers in any output.
- If the checklist floor is still unresolved after the interview, build the
  proposal anyway with the floor items as prominent flagged defaults.
