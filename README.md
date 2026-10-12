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

The flow is Google Chat message → captured intake → scope extraction → one question at a time (tap-to-answer buttons, or a typed reply that can answer several) → receipt card → **Approve** button → D-Tools catalog read → compile → bind → validate → D-Tools re-check → watermarked PDF → preflight → PDF posted in the thread → `READY_HELD`.

- **Natural conversation.** The salesperson writes normally. The LLM proposes a scope, and code validates it, normalizes it and decides what to ask (at most 3 questions per turn). A request split over two messages (who and where first, then the scope) is read again as one message, not patched onto an empty scope.
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
- The security pattern (`packages/build/patterns/security_modernization.json`) carries Livewire's standard D-Tools records. They were chosen from how often each product appears on Livewire's own projects since 2023. Labor is estimated from Livewire history (2.5 hours plus 0.5 per device, at the 07LABOR1MAN rate in the policy). A Livewire PARTS line is sized to the policy's parts share.
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
packages/dtools/   D-Tools Cloud client: reads, plus the one write (the retainer's opportunity); recorded fakes for tests
packages/qbo/      QuickBooks Online client for the design-retainer invoice, OAuth with refresh-token rotation in Secret Manager
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

Margin, labor-rate and tax rules are versioned configuration, never prompt text. The database refuses a policy from anyone who isn't an active admin. Each run freezes the policy version it was built with.

[`config/commercial-policy-2026.json`](config/commercial-policy-2026.json) encodes the 2026 sales compensation policy:
- gross-profit floors of 40% residential and 37.5% commercial;
- mix targets of equipment 60% at 35%, labor 30% at 50% and parts 10% at 60%;
- the 07LABOR1MAN rate of $179 per hour, costing $89.50;
- Virginia sales tax of 6% on taxable equipment and parts, with labor untaxed, as on Livewire's D-Tools quotes.

A build below its market's floor, or with any requested discount, is **held** as a margin exception:
- The requester is told it is waiting.
- Each admin gets an internal card in their direct conversation with the app, showing the margin, the floor and the mix, with **Approve exception** / **Decline** buttons. They can also reply `approve exception MX-…` or `decline exception MX-…`.
- Approving is the written exception the comp policy requires. It is recorded once, admin-only (also enforced by the database), and the PDF then posts to the requester. Declining stops the run.
- An admin must have messaged the app directly at least once to be reachable.
- A discount the salesperson asks for ("10% off") is recorded as `requested_discount` and shown on the receipt. The budget applies it but is held until an admin approves; the PDF Summary then shows "Discount (10%)". Discounts on monitoring or service plans aren't priced in a budget.

Patterns (`packages/build/patterns/`), each built from Livewire's D-Tools history, cover security modernization, home networking, whole-home audio (Sonos), TV and media walls, prewire, surveillance cameras, Control4 automation, Lutron lighting control, video doorbells, commercial access control and motorized shades. A scope that needs several gets them combined into one budget: setup hours add up and each role keeps its own labor rate.

Gear is priced only when asked (Zack's test round, 2026-10-12). A role's `mentions` match whole words in the rep's own changes and stated counts, never system names or rooms; `mentions_require` also needs a Wi-Fi word in the same change, so "outdoor PoE cameras" add no eero. `asked_by` includes the eero network only when the request asks for Wi-Fi, coverage, a router or the like, and `with_roles` prices the switch, OvrC and WattBox (and HDMI cables, with a soundbar or streamer) only alongside it, unless the rep names them. Roles in a `count_group` share a stated count: "only need 1 eero" drops the outdoor or wired eeros the request only mentioned. Speakers sold in pairs take a stated count of speakers as pairs. A revision that prices exactly what the budget it revises did gets a "couldn't apply your change" reply quoting the rep.

Design & Delivery (the parts line) is `design_delivery.base_pct` of product + labor + services, costed at the parts margin. When a budget would fall under the margin floor, it rises in half-point steps up to `design_delivery.max_pct` until the budget clears the floor; past that, the budget waits for an admin's approval. Without `design_delivery`, parts are sized to the parts share of the subtotal. `tax` can also be `{ "mode": "rate", "rate_pct": <n>, "applies_to": "taxable_equipment" }`.

The file ships in the image. Publish it with the admin job (see `docs/deploy.md`):

```bash
gcloud run jobs execute sd-migrate-staging --region us-east4 --wait \
  --args="^|^apps/gateway/src/admin.ts|set-policy|henry|config/commercial-policy-2026.json|2026 sales comp policy"
```

Anyone with an active identity can DM the app. Each person's runs are their own: only the requester can answer questions on a run or approve its scope. Different people, and different threads in a shared space, run in parallel.

### Design retainer

Under each finished budget, **Send design retainer** collects the retainer (Henry, 2026-10-12): 4% of the likely range's low end, at least $100.
1. The bot asks: "What email should the retainer invoice go to?" The requester replies with just the client's address, or `cancel`.
   - When the request the rep typed (its captured messages, never model output) holds exactly one email address other than the rep's own, the bot offers it instead: "Send the retainer invoice to jane@example.com? Reply "yes", another address, or "cancel"."
   - The address is taken only from that reply (or the offered one on "yes"), matched by a strict pattern with no model involved. Anything else is asked again.
   - The ask lapses after 24 hours, or when the budget is revised or a new request starts.
2. The worker creates a D-Tools opportunity, `Design Retainer · <client> · SD-xxxxxxxx`. It has no quote template; reps build the real quote under it later, and the hourly job reads that quote back for the run log.
3. In QuickBooks Online it finds the client's customer by email. Failing that, it creates one named after the client, or "Client (email)" when that name is taken.
4. It invoices one non-taxable line on the `DESIGN RETAINER` item, with card and bank payment on. The line reads "Design Retainer: 4% Deposit Against Estimated Total Budget of $14,075 – $17,200. Non-refundable; applied in full toward your final project value."
   - The invoice number is the budget's `SD-` reference, so a retry finds the same invoice instead of making a second.
   - The item id is `retainer.qbo_item_id` in the commercial policy (3649 when absent).
5. QuickBooks emails the invoice with its Pay now link, and the bot confirms in the thread. If the send fails, the reply says so, and tapping again re-sends the same invoice.
6. The hourly job checks each sent invoice. At a zero balance it records the payment and posts "✓ Design retainer paid" in the thread, once.

The run log shows `retainer_opportunity`, `retainer_invoice` and `retainer_paid_at`. A paid retainer reads "retainer paid" in the score's reason.

QuickBooks is on in production only, once it is set up (see [QuickBooks retainer invoice](docs/deploy.md#quickbooks-retainer-invoice-production)). Until then the bot creates the opportunity and says to invoice by hand.

## Deploy

See [`docs/deploy.md`](docs/deploy.md):
- one bootstrap script in Cloud Shell (Terraform, us-east4);
- then GitHub Actions deploys each merge by image digest, to staging automatically and to production after approval.
