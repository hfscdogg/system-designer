# Architecture decision record: System Designer rebuild

**Status:** accepted. M1–M3 have landed in this repo.
**Requirements source:** *Livewire System Designer: Tool-Agnostic PRD* (Henry Clifford).

## Decision

Rebuild System Designer as a controlled workflow with an LLM inside it. It is not an autonomous agent.

| Concern | Choice | Why |
|---|---|---|
| **Run state and recovery** | Temporal Cloud. One workflow per run, with `workflowId = runId`. | Crash, deploy and timeout recovery come from durable replay. Activities retry with idempotency keys. Approvals and clarifications are signals. Worker deployment versions pin in-flight runs (PRD §6.2, §16.3, §17). |
| **Business state** | Postgres (Cloud SQL) | Single-use claims, atomic approvals, an append-only audit log enforced by triggers, and identity and space allowlists. |
| **Evidence** | GCS, write-once with `ifGenerationMatch=0` | Original provider payloads and, later, artifacts are stored hashed. A rewrite with different bytes is an error. |
| **Chat** | `ChannelAdapter` interface. Google Chat first, Telegram in M6. | One view model (`text`, `receipt`, `status`) rendered natively per platform, so the same agent runs on every app. |
| **LLM** | Anthropic Messages API, structured outputs, keyless via Workload Identity Federation | Stateless calls whose outputs are validated by strict zod schemas. They never decide state, identity or approval. The worker's Google identity is exchanged for short-lived Claude tokens, so there is no Anthropic API key to leak or rotate. |
| **Language / runtime** | TypeScript on Node 22, run directly with no build step | Reuses the existing Node D-Tools client and renderer. Typed contracts between stages. |

iMessage is out of scope because the system runs entirely in the cloud. Hermes is not reused.

## Why this is more stable than Hermes

Each Hermes failure from PRD §20 maps to a mechanism here:

| PRD §20 failure | Mechanism here |
|---|---|
| Reconstructed intake | The gateway stores the exact provider bytes and text hash before any LLM call. Intake rows are immutable (trigger). |
| LLM fabricating session identity | Identity comes from the verified Google token and the `channel_identities` table. The LLM never receives authority fields, and any it emits are rejected at any depth. |
| Model-written summary instead of a receipt | Receipts are built by `packages/core/src/receipt.ts`. Chat renders `lines` verbatim. |
| Stale approvals | Approval is one transaction under a run row lock. It checks: latest receipt, scope hash, requester, thread and session generation. |
| Building or sending twice after a timeout | Temporal activities plus idempotency keys: the receipt ID for receipts, `runId:status` for the status card, and Google Chat `requestId`. |
| Lost approval signal | The workflow reconciles hourly from the `approvals` table. |
| Prompts treated as stronger than permissions | The pilot hold is structural: no customer channel adapter, no D-Tools write code, internal-space allowlist. |
| Service start treated as proof of deployment | Releases are immutable image digests. Acceptance requires a fresh authenticated live run (M5). |

## Requirement → component map

| PRD | Requirement | Component | Status |
|---|---|---|---|
| §6.1 | Canonical states | `packages/core/src/states.ts` | ✅ |
| §6.2 | Idempotent transitions, resume, no silent rebuild | Temporal workflow + `Store.transitionRun` | ✅ through approval |
| §7.2 | Immutable original intake | `Store.captureIntake`, `intake_messages` trigger, GCS raw payload | ✅ |
| §7.3 | Single-use message claim outside the run workspace | `message_claims` | ✅ |
| §7.4 | Attachment hashing and admission | Metadata recorded and marked *not admitted* | ◑ download and hash in M2 |
| §7.5 | Minimum intake, explicit unknowns | `computeBlockers` | ✅ |
| §8 | Typed scope contract, strict validation, normalization | `scope.ts`, `normalize.ts` | ✅ |
| §9.1 | ≤3 questions, partial answers preserved | `questionsForTurn`, `applyClarification` | ✅ |
| §9.2–9.4 | Deterministic receipt, atomic approval, button bound to receipt + hash | `receipt.ts`, `Store.commitApproval`, Chat card | ✅ |
| §10 | LLM vs deterministic boundary | `packages/llm` returns untrusted data only | ✅ |
| §11 | Read-only D-Tools, exact records, no fabrication, refresh before finalizing | `packages/dtools` (GET only), `admitProduct`, `catalog_evidence`, `refreshCatalog` stage | ✅ |
| §12 | Architecture patterns, BOM roles, supported / allowance / unresolved, precedent | `packages/build/src/pattern.ts`, `materialize.ts`, `patterns/*.json` | ✅ (Livewire standards, labor and parts from D-Tools project history) |
| §13.1–13.5 | Prebuild, materializer, compiler, binder, validator | `apps/worker/src/build-activities.ts`, `packages/build` | ✅ |
| §13.6–13.7 | Renderer, preflight | `packages/render` (HTML from customer view → Chromium PDF → pdfjs preflight) | ✅ |
| §13.8 | Coordinator ends at `READY_HELD`, one hand-off | `handoff` stage, `held_handoffs` | ✅ |
| §14 | PDF content, watermark, no internal financials, bound packet | `packages/render`, `internal/financial_report` (stored only), `packet/manifest` | ✅ |
| §15.1–15.2 | Route binding, stale sessions | Thread checks in approval; `resetSession` | ✅ |
| §15.3 | Pilot hold | No delivery or write code paths exist | ✅ structurally |
| §15.4 | Margin config, Henry-only | `commercial_policies` (admin-only trigger, append-only), frozen per run; below-floor builds wait in `AWAITING_MARGIN_APPROVAL` for an admin's recorded decision (`margin_exceptions`) | ✅ |
| §16 | Append-only events, atomic publication, idempotency | `events` table, write-once blobs, idempotency keys | ✅ for M1 scope |
| §17 | Immutable releases, pinned runs, staged activation, rollback, post-deploy checks | `infra/terraform`, `.github/workflows/ci.yml` (deploy jobs), `scripts/deploy-env.sh` (deploy by digest, one worker service per build until drained, Temporal version promotion, smoke checks) | ◑ written; first live deploy pending |
| §18 | Acceptance | `apps/gateway/test/e2e.test.ts` + live run | M5 |

## Messaging UX

- **Natural conversation:** the salesperson writes freely. Extraction and clarification are LLM calls. Code decides what is missing and asks at most three questions at a time.
- **Live progress:** one status card per run, patched in place through `messages.patch` / `editMessageText`, instead of a stream of pings.
- **PDF in the thread (M3):** `ChannelAdapter` gains `postFile`. The provider message ID and PDF hash are recorded.
- **Same agent on every app (M6):** a `person` links multiple channel identities. `status` lists a person's runs from any channel.
  - Approval and PDF hand-off stay bound to the run's home conversation (PRD §15.1).
  - An explicit, logged "move this run here" re-homes a run.
- **DMs:** a Google Chat DM is one conversation keyed by space, so follow-ups that land on new threads still reach the open run.

## Milestones

| | Milestone | Scope |
|---|---|---|
| **M0** | Spikes | Google Chat app in Workspace. **Confirm how an app posts a PDF attachment**: app-auth media upload is limited, so the fallback is a Drive file card or delegated upload. D-Tools read spike. Temporal Cloud namespace. GCP project. |
| **M1** ✅ | Vertical slice | Chat → intake → scope → clarification → receipt → approval. |
| **M2** ✅ | Catalog and compile | D-Tools read adapter, evidence admission, security-modernization materializer, compiler / binder / validator, margin config. Bounded LLM selection for uncommon scopes is deferred: unsupported scopes block and go to Zack. |
| **M3** ✅ | Render and hold | Renderer, PDF, preflight, `READY_HELD`, PDF posted in the thread. |
| **M4** | Hardening | Full PRD §18.2 adversarial suite, worker kill / recovery tests, Terraform, staging → prod pipeline, open-run reconciler. |
| **M5** | Acceptance | Live acceptance run with Zack. Evidence packet: run ID, release ID, message ID, PDF hash, no side effects. |
| **M6** | Telegram | Telegram adapter, identity linking, "move run here". |

## Open decisions for Henry (configuration, not prompts)

- **Cross-channel rule:** is home-conversation binding plus an explicit "move run here" acceptable?
- **PDF upload mode:** `GOOGLE_CHAT_UPLOAD_MODE=app` if Google lets the Chat app upload attachments itself; otherwise `delegated` (the pilot setting, because Chat uploads need user authentication), which acts as the requester through domain-wide delegation limited to Chat message creation. Neither needs a paid seat. A Drive link card is the last resort and is not built.
- **Production model:** which LLM provider and model are approved? `LLM_MODEL` must be set explicitly.
  - Server-side refusal fallbacks are deliberately **not** enabled, because they would silently switch models.
- **Commercial values:** production margin thresholds and tax rules.
- **Labor pricing:** Livewire prices labor as project-level hourly lines (07LABOR1MAN), which the D-Tools v1 API cannot read.
  - Patterns estimate hours from Livewire history.
  - The rate is commercial-policy configuration, so it must be kept in step with D-Tools.
