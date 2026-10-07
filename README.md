# Livewire System Designer

An internal presales app. A salesperson describes a project in Google Chat. They get back a deterministic scope receipt, approve it, and (in later milestones) receive a held, watermarked conceptual-budget PDF in the same conversation.

This is a rebuild that replaces the Hermes agent setup. The messaging experience stays the same. What changes is what holds the state:

> **A durable workflow engine owns state. The LLM is a stateless function called from inside it.**

Hermes kept business state in the agent's conversation. That is the root of the instability: reconstructed intake, stale approvals, double builds after timeouts. Here:
- identity, evidence, receipts, approvals and the audit log live in Postgres;
- run progress lives in Temporal;
- every authority decision is plain code with tests.

The design rationale and requirement mapping are in [`docs/architecture.md`](docs/architecture.md).

## What works today (milestones M1–M3)

The flow is Google Chat message → captured intake → scope extraction → clarification → receipt card → **Approve** button → D-Tools catalog read → compile → bind → validate → D-Tools re-check → watermarked PDF → preflight → PDF posted in the thread → `READY_HELD`.

- **Natural conversation.** The salesperson writes normally. The LLM proposes a scope, and code validates it, normalizes it and decides what to ask (at most 3 questions per turn).
- **Deterministic receipts.** Code generates each receipt. It is shown verbatim as a Chat card, and its Approve button is bound to the receipt ID and scope hash. `Approve scope <id>` also works as text.
- **Live progress.** One status card per run, edited in place (✅ ⏳ ▫️).
- **Safety.** Only the requester can approve, only in the run's own conversation, and only the latest receipt.
  - Replayed messages, forged tokens, unknown people, unapproved spaces and model-authored authority fields all fail closed.
  - Every one of these cases has a test.

- **Build (M2).**
  - The approved scope is matched to an approved architecture pattern (`packages/build/patterns/`).
  - Every product comes from an exact D-Tools record read in this run, and the raw response is stored as evidence.
  - The proposal is compiled, bound and validated: coverage, provenance, arithmetic in cents, "priced scope to date" when incomplete, margin and tax policy, and a customer view with no cost or margin fields.
  - Each approved scope gets exactly one build, and every stage output is published once with its hash.

**Before M2 can run live:**
- The security pattern (`packages/build/patterns/security_modernization.json`) carries Livewire's standard D-Tools records. They were chosen from how often each product appears on Livewire's own projects since 2023. Service categories stay TBD allowances until labor pricing lands.
- An admin must publish a commercial policy (see below).

- **PDF (M3).**
  - The PDF is rendered from the customer-safe view only, fully self-contained: embedded fonts, logo and exact-model images, or **IMAGE PENDING** for any item without one.
  - `CONCEPTUAL BUDGET • NOT FOR APPROVAL` appears once on every page, and there are no signature or acceptance controls.
  - Before rendering, every D-Tools record is re-read. If any changed, the run stops at `RECONCILIATION_REQUIRED` with no PDF.
  - Preflight reads the real PDF bytes and checks: watermark once per page, no form fields, no cost/margin wording, totals that match, the run's title, and the hash.
  - One PDF is posted per run; the hand-off and a bound evidence manifest are recorded.
  - The confidential cost and margin report is stored, never posted.

**Not built yet:** hardening and deployment pipeline (M4), Telegram (M6). See [`docs/architecture.md`](docs/architecture.md).

## Layout

```
apps/gateway/      Google Chat webhook (verify → capture → claim → signal) + admin CLI
apps/worker/       Temporal worker: proposal-run workflow + activities
packages/core/     Schemas, normalizer, blockers, receipts, state machine (pure code)
packages/store/    Postgres schema + Store (claims, receipts, atomic approvals, audit log), GCS evidence
packages/channels/ Channel adapter interface + Google Chat (auth, parsing, cards, REST)
packages/llm/      Claude calls (structured outputs) for extraction and clarification
packages/dtools/   Read-only D-Tools Cloud client (GET only) + recorded-response reader for tests
packages/build/    Catalog admission, architecture patterns, materializer, compiler, binder, validator
packages/render/   Customer HTML, Chromium PDF, PDF preflight
.claude/skills/d-tools-skill/  Existing D-Tools tooling; its client and renderer get ported in M2/M3
spikes/thread1-dtools/         D-Tools read-API spike (M0)
```

## Develop

```bash
pnpm install
pnpm typecheck
pnpm test             # unit + end-to-end slice; PDF tests need Chromium (PLAYWRIGHT_BROWSERS_PATH or `pnpm --filter @sd/render exec playwright-core install chromium`) (PGlite in-process Postgres, fake Chat, inline workflows)
pnpm test:temporal    # same workflow on a Temporal test server (downloads the server binary; runs in CI)
```

Node 22 runs the TypeScript sources directly, so there is no build step.

## Pilot users (Henry and Zack, then more)

Access is an allowlist in the database, managed by `apps/gateway/src/admin.ts`. The LLM has no path to change it.

1. Have the new person send any message to the System Designer app in Google Chat. They'll get "not set up yet".
2. Run `node apps/gateway/src/admin.ts pending` to see their Google user ID (`users/…`) and email.
3. Run `node apps/gateway/src/admin.ts add-person zack "Zack Reichert" requester users/… zack@getlivewire.com`. Give Henry the `requester,admin` roles.
4. **Optional:** to use a shared space instead of DMs, run `node apps/gateway/src/admin.ts allow-space spaces/… "Sales pilot"`.

### Commercial policy (admin only)

Margin and tax rules are versioned configuration, never prompt text. The database refuses a policy from anyone who isn't an active admin. Each run freezes the policy version it was built with.

```json
{ "schema": "commercial_policy_v1",
  "margin": { "minimum_gross_margin_pct": <Henry's number> },
  "tax": { "mode": "tbd" } }
```

`tax` can also be `{ "mode": "rate", "rate_pct": <n>, "applies_to": "taxable_equipment" }`. Publish with `node apps/gateway/src/admin.ts set-policy henry policy.json "reason"`.

Anyone with an active identity can DM the app. Each person's runs are their own: only the requester can answer questions on a run or approve its scope. Different people, and different threads in a shared space, run in parallel.

## Deploy

See [`docs/deploy.md`](docs/deploy.md):
- one bootstrap script in Cloud Shell (Terraform, us-east4);
- then GitHub Actions deploys each merge by image digest, to staging automatically and to production after approval.
