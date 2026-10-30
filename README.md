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

Pricing decisions (Henry, 2026-10-12):
- Amplifiers follow the speakers they drive (`drives`): one Sonos Amp per 4 passive speakers, new pairs counted as two plus existing speakers the rep counts. Commercial jobs get a JBL Professional CSA180Z 70V amplifier instead (`market_variants`), one per 8 speakers. An amplifier the rep names by model is priced as named.
- An articulating mount (Strong SM-CS-ART2-L) replaces the tilt mount when the request asks for one, and a TV on a cart gets no wall mount. Livewire has no standard cart (`unpriced: "verify"`), so it is listed to verify as a requested product, priced in the final proposal, without blanking the total.
- Work no pattern role covers (an outdoor outlet, a conduit run, trenching, a low-voltage cable run) is priced from the templates in `packages/build/patterns/allowances.json`: labor hours at the policy's 07LABOR1MAN rate, with no parts price (Design & Delivery covers materials). Each template's hours and their basis come from Livewire's accepted and presented D-Tools quotes. The lines print under "Allowances — verify on site", count toward the subtotal, total and margin, and keep the total. A requested system that matches no template still goes to Zack.

Zack's round 3 (2026-10-13):
- A doorbell camera the rep asks for adds the video doorbell even when the model filed it under cameras, and "streaming" or an Apple TV is the TV's source.
- An SVR, NVR or DVR the request names is priced as Livewire's most quoted Alarm.com recorder (ADC-SVR210-2TB; the commercial PoE recorder on commercial jobs) in place of a memory card per camera.
- A keypad and door/window contacts are priced only when asked for (each is on about 60% of Livewire's IQ Panel 5 quotes). "4 smoke/CO detectors" prices 4 smoke/heat and 4 CO detectors: Livewire has no PowerG combination detector.
- One product two combined patterns both price (the network's and the cameras' PoE switch) is one line, at the larger count or the rep's own.
- Each Ethernet port or data drop asked for is one low-voltage cable-run allowance.
- The verify list leaves out products the budget prices (in any word order), products the client supplies, and the PoE switch question once a PoE switch is priced. The budget-ready message says "Total $X incl. tax", or "Priced so far $X — total withheld: <why>", and lists up to 12 items.

Zack's round 4 (2026-10-15):
- A stated total the request then itemizes ("4 exterior cameras": a doorbell, a floodlight and 2 wired cameras; "4 smoke/CO detectors": 2 upstairs, 2 downstairs) is not priced on top of its items. A count given floor by floor adds up however the floor is written ("upstairs smoke/CO detectors", "smoke/CO detectors (downstairs)", or the same item listed twice).
- Words that name another eero of the same count group ("PoE access point") don't ask for the mesh or the outdoor eero. The switch, OvrC and WattBox come with any eero, and an access point priced without an eero router lists the router to confirm. A wired access point is one more cable run, unless the request counts its drops.
- Existing equipment the job keeps (a Control4 controller) is listed to field-test without withholding the total. The Control4 Halo remote is priced only when a remote is asked for.
- An outdoor TV ("full weather", "weatherproof", "patio") is never priced as an indoor TV: it takes an `outdoor` variant at its size, or is listed to price when there is none.
- The Apple TV is the Apple TV 4K (2026) record at $339 (Ben retired the 2022 SKUs on 2026-10-14).
- A role's `brand_variants` price another approved brand's record when the request names that brand for the device ("Klipsch in-ceiling speakers"), sold each at the stated count.

Pricing decisions (Henry, 2026-10-15, from 1,348 accepted or presented Livewire quotes since 2024):
- An outdoor TV is a Samsung Terrace: 75" QN75LST9D, 65" QN65LST9D, 55" QN55LST7D (on about 15 of 23 outdoor-TV quotes). Other outdoor sizes are listed to price.
- Klipsch in-ceiling speakers are the Klipsch Professional PIC-650-T (70V) on commercial jobs and the CS-16C II at home.
- Trench and conduit labor scale with a length the request gives: trench 0.083 h/ft, conduit 0.17 h/ft, and conduit laid in the request's trench runs the trench length per conduit at 0.05 h/ft, each at least the flat 6 h. Materials stay in Design & Delivery.

Zack's round 7 (2026-10-26):
- Cabling with no Wi-Fi ("structured cabling", "network cabling", "Cat6 home runs", a keystone patch panel) is structured wiring, priced by the prewire pattern, not the Wi-Fi pattern. A budget of cable-run allowances alone is a budget, not "no products could be priced".
- A keystone patch panel the request names replaces the structured media enclosure, and wall plates it names are priced too (see Henry's decisions, 2026-10-27). A stated count of drops or ports sets the jacks. Cabling fished or drilled into a finished home is worded as a retrofit.
- A build that stops after the scope is approved gets **Revise this request** and **New request**. The revision rebuilds from the approved scope and replaces the blocked run. Typing "revise …" works too.
- Wall mounts follow the TVs priced, plus one per existing TV the request moves. A moved TV with no new TV is one mount, not two.
- A ProRemote (Pro Control) or URC remote is the TVs' remote, not Control4. A requested product named with a model word the priced line doesn't have stays on the verify list (the Sonos Amp Multi is now priced: see 2026-10-27).
- Cameras the request asks for in another brand (`other_brands`: "Requested product: Luma cameras") are listed to price in that brand instead of priced as Alarm.com. On any job, the camera PoE switch goes when the customer keeps a switch, recorder or cameras, or when the cameras it would power are another brand's.

Henry's decisions (2026-10-27), from 2,035 accepted or presented D-Tools quotes since 2024:
- A named patch panel is priced as the C2G 03857 12-port keystone panel, one per 12 drops (`follows_per`). A count of "patch panel ports" is ports. Named keystone plates are Wirepath PLATE-1-WH, one per drop, or the 2- or 4-port plate the request names (`port_variants`), one per 2 or 4 drops, verified per location. A retrofit drop takes a keystone jack at each end and 2 hours (`retrofit_units`).
- Troubleshooting existing cameras is a 2-hour allowance (`camera_troubleshooting`).
- The soundbar and its mount follow the words the request uses (`word_variants`): a Sonos Beam gets the Beam and the Sanus WSSBM1-B2, an Arc or Arc Ultra the WSSATM1-B2, and a mount for the customer's Playbar is listed to price.
- Sonos Amps follow the speakers at one per 4 and at least one per room with speakers (`drives.per_room`). A named Sonos Amp Multi is priced with its 2U rack mount, in place of the Sonos Amps unless the request also names one.
- A TV with no model named is the Sony BRAVIA 7 (K65XR70, K55XR70, K75XR70). A BRAVIA 8 or an OLED the request names is the BRAVIA 8. Outdoor TVs stay the Samsung Terrace; there is no 55-inch LST9, so 55 inches is the partial-sun LST7.

Starting a different job while another is open (Zack's Giessel/Dunham job, 2026-10-26; Henry, 2026-10-27):
- A message starting "new request" closes the open request in the conversation and starts the rest of the message as a new one ("new request" alone closes it and waits).
- A message sent while a request waits for answers that names a different client, or reads as a whole intake (three or more labeled fields such as Client, Address, Budget), is not read into the open request: the reply asks "Answer to my questions" or "New request", and nothing changes until the rep taps one.

One item never stops the budget (Zack's Standon job, 2026-10-27; Henry, 2026-10-28):
- A device listed to price (another brand's cameras, an outdoor TV size or soundbar mount with no standard) is accounted for: the rest of the job builds.
- A standard D-Tools record that can't be read or admitted (a retired SKU, no price) no longer stops the run. A device on it is listed to price ("its D-Tools record can't be read"), a service on it is a TBD allowance, and a missing parts record leaves the parts line out. A build with nothing priceable still stops. A D-Tools outage or rate limit is still retried.
- A cable run the request wants "priced separately" is its own cable-run allowance line, even on a structured-wiring job. With a drop count stated, the verify list asks whether the count leaves it out.
- A CD player, CD changer or tape deck the request mentions or the customer keeps gets a Sonos Port, like a turntable (Henry, 2026-10-28; `mentions_kept`). Whole-home audio 2026-10-28.1.

Zack's round 8 (2026-10-30) and Henry's 10/30 decisions:
- Another brand the request names for a system (Standon's UniFi network, cameras, doorbell, alarm and entry reader) prices Livewire's standard as a stand-in, each line noted "Livewire equivalent of the requested UniFi equipment; the final proposal can price UniFi instead." Only when the customer keeps that brand's system (Jinny's Luma NVR) are the new devices listed to price instead.
- Pre-wire the request says is already complete ("Assume all pre-wire work is complete", "already prewired") prices no structured wiring, cable or prewire service.
- A crew and duration the request states ("a 2 man job for a full day", "2 techs for 2 days", "one tech, half day") sets the labor hours at 8 hours a day.
- A recorder asked for by channel count is Livewire's 8-channel Alarm.com SVR, said on the verify list.
- Camera trouble the interpreter writes as an open question ("difficulty hearing camera audio") gets the 2-hour troubleshooting allowance (`from_questions`).
- A universal remote (ProRemote, Pro Control, URC) gets a 2-hour programming allowance (Henry). Allowances 2026-10-30.1.
- Retrofit wording in the open questions (a plumbing-chase route) counts; a length the request states per drop ("50 feet for each data drop") sizes the Cat6 (`stated_length_per`). Prewire 2026-10-30.1.
- Amplifiers the request names itself, with no new speakers asked for, drive the client's own speakers: none are added. A CD player the client needs to buy is listed to price (no Livewire standard); its Sonos Port is priced. Whole-home audio 2026-10-30.1.

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
