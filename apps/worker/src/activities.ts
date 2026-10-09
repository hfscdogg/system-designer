import {
  ANSWER_CHOICES,
  answerPatch,
  applyClarification,
  buildReceipt,
  computeBlockers,
  describeScopeChanges,
  hashCanonical,
  normalizeExtraction,
  validateClarificationPatch,
  validateExtraction,
  type CurrentReceipt,
} from "@sd/core";
import type { ChannelAdapter, View } from "@sd/channels";
import type { ClarificationInterpreter, ScopeExtractor } from "@sd/llm";
import { formatUsd, type PatternSpec, type Proposal } from "@sd/build";
import type { DToolsReader } from "@sd/dtools";
import { IntegrityError, threadOf, type RunRecord, type Store } from "@sd/store";
import { createBuildStage } from "./build-activities.ts";
import { statusView } from "./progress.ts";
import type { ExtractOutcome, RunActivities } from "./workflows/logic.ts";

export interface ActivityDeps {
  store: Store;
  adapters: Record<string, ChannelAdapter>;
  extractor: ScopeExtractor;
  interpreter: ClarificationInterpreter;
  dtools: DToolsReader;
  patterns: PatternSpec[];
  /** HTML → PDF (Chromium in production). */
  renderPdf: (html: string) => Promise<Uint8Array>;
  /** Fetch an exact-model product image; null when unavailable (→ IMAGE PENDING). */
  fetchImage: (url: string) => Promise<{ bytes: Uint8Array; contentType: string } | null>;
  /** Model attempts per extraction before the run is blocked. */
  extractionAttempts?: number;
}

export { IntegrityError };

export function createActivities(deps: ActivityDeps): RunActivities {
  const { store } = deps;
  const attempts = deps.extractionAttempts ?? 2;

  const adapterFor = (run: RunRecord) => {
    const a = deps.adapters[run.platform];
    if (!a) throw new IntegrityError(`no channel adapter for ${run.platform}`);
    return a;
  };

  async function upsertStatus(run: RunRecord, view: ReturnType<typeof statusView>) {
    const adapter = adapterFor(run);
    if (run.status_message_id) {
      await adapter.update(run.status_message_id, view);
    } else {
      const { messageId } = await adapter.post(threadOf(run), view, `${run.id}:status`);
      await store.setStatusMessage(run.id, messageId);
    }
  }

  async function validateModelScope(raw: unknown, model: string, runId: string, kind: string): Promise<ExtractOutcome> {
    return validateScope(raw, runId, kind, { model });
  }

  /**
   * A revision starts from the approved scope of the budget it revises, with the
   * requester's change applied the same way a clarification is.
   */
  async function reviseScope(runId: string, parentRunId: string, revision: number, change: string): Promise<ExtractOutcome> {
    const approval = await store.getApprovalForRun(parentRunId);
    const parentReceipt = approval ? await store.getReceipt(approval.receipt_id) : null;
    if (!parentReceipt) throw new IntegrityError(`run ${runId} revises ${parentRunId}, which has no approved receipt`);
    const base = parentReceipt.body.extraction;
    const { raw, model } = await deps.interpreter.interpret({ current: base, questions: [], answer: change });
    const patch = validateClarificationPatch(raw);
    if (!patch.ok || patch.value.unmapped) {
      await store.appendEvent(runId, "revision_unmapped", "system", { model, parentRunId, errors: patch.ok ? [] : patch.errors });
      return { ok: false, reason: "I couldn't apply that change to the earlier budget. Tap \"Revise this budget\" and say what to change, or tap \"New request\" for a different job" };
    }
    const outcome = await validateModelScope(applyClarification(base, patch.value), model, runId, "revision_applied");
    if (!outcome.ok) return outcome;
    const changed = describeScopeChanges(base, outcome.extraction);
    return {
      ...outcome,
      notes: [
        `Revision ${revision} of the budget approved in ${parentReceipt.id}; it replaces that budget once approved.`,
        changed.length ? `Changed: ${changed.join("; ")}` : "Changed: nothing in the scope; the budget is rebuilt with today's prices.",
        ...outcome.notes,
      ],
    };
  }

  /** `source` is recorded with the event: the model that proposed the scope, or how the requester answered. */
  async function validateScope(raw: unknown, runId: string, kind: string, source: Record<string, unknown>): Promise<ExtractOutcome> {
    const valid = validateExtraction(raw);
    if (!valid.ok) {
      await store.appendEvent(runId, `${kind}_rejected`, "system", { ...source, errors: valid.errors });
      return { ok: false, reason: `the scope could not be validated (${valid.errors.slice(0, 3).join("; ")})` };
    }
    const { scope, notes } = normalizeExtraction(valid.value);
    await store.appendEvent(runId, kind, "system", { ...source, scopeSha256: hashCanonical(scope), notes });
    return { ok: true, extraction: scope, notes };
  }

  return {
    async reportProgress({ runId, phase, note }) {
      await upsertStatus(await store.getRun(runId), statusView(runId, phase, note ?? null));
    },

    async extractScope({ runId }) {
      const run = await store.getRun(runId);
      const intake = await store.getIntake(run.intake_id); // verifies the stored text hash
      if (run.parent_run_id) return reviseScope(run.id, run.parent_run_id, run.revision, intake.text);
      let last: ExtractOutcome = { ok: false, reason: "no attempt made" };
      for (let i = 0; i < attempts; i++) {
        const { raw, model } = await deps.extractor.extract({
          text: intake.text,
          attachmentNames: intake.attachments.map((a) => a.name),
        });
        last = await validateModelScope(raw, model, runId, "scope_extracted");
        if (last.ok) {
          const ignored = intake.attachments.length
            ? [`${intake.attachments.length} attachment(s) received; not yet used as scope evidence`]
            : [];
          return { ...last, notes: [...last.notes, ...ignored] };
        }
      }
      return last;
    },

    async publishReceipt({ runId, version, extraction, notes }) {
      const run = await store.getRun(runId);
      const receipt = buildReceipt({
        runId,
        version,
        requesterPersonId: run.person_id,
        route: { platform: run.platform, space_id: run.space_id, thread_id: run.thread_id, session_generation: run.session_generation },
        extraction,
        notes,
      });
      let record;
      try {
        record = await store.publishReceipt(receipt);
      } catch (err) {
        const now = await store.getRun(runId);
        if (now.state === "SCOPE_APPROVED" || now.state === "STALE") return { ok: false, runState: now.state };
        throw err;
      }
      const adapter = adapterFor(run);
      // While questions remain, ask the next one (with tap-to-answer choices); the full receipt rides along.
      const next = receipt.blockers[0];
      const view: View = next
        ? {
            kind: "question",
            receiptId: receipt.receipt_id,
            field: next.field,
            question: next.question,
            remaining: receipt.blockers.length,
            choices: ANSWER_CHOICES[next.field] ?? null,
            lines: receipt.lines,
          }
        : {
            kind: "receipt",
            receiptId: receipt.receipt_id,
            version: receipt.version,
            status: receipt.status,
            lines: receipt.lines,
            approve: receipt.scope_hash ? { receiptId: receipt.receipt_id, scopeHash: receipt.scope_hash } : null,
          };
      // The receipt id is the idempotency key: a retried activity cannot post it twice.
      const { messageId } = await adapter.post(threadOf(run), view, receipt.receipt_id);
      if (!record.message_id) await store.setReceiptMessage(receipt.receipt_id, messageId);
      await upsertStatus(await store.getRun(runId), statusView(runId, receipt.status === "AWAITING_APPROVAL" ? "awaiting_approval" : "needs_answers"));
      const current: CurrentReceipt = { receiptId: receipt.receipt_id, status: receipt.status, scopeHash: receipt.scope_hash };
      return { ok: true, receipt: current };
    },

    async interpretClarification({ runId, intakeId }) {
      const latest = await store.latestReceipt(runId);
      if (!latest) throw new IntegrityError(`run ${runId} has no receipt to clarify`);
      const answer = await store.getIntake(intakeId);
      if (answer.person_id !== latest.body.requester_person_id) throw new IntegrityError("clarification is not from the requester");
      const base = latest.body.extraction;
      // Every open question, so one typed or dictated reply can answer several.
      const questions = computeBlockers(base).map((b) => b.question);
      const { raw, model } = await deps.interpreter.interpret({ current: base, questions, answer: answer.text });
      const patch = validateClarificationPatch(raw);
      if (!patch.ok) {
        await store.appendEvent(runId, "clarification_rejected", "system", { model, intakeId, errors: patch.errors });
        return { ok: false, reason: "I couldn't safely apply that answer. Could you rephrase it?" };
      }
      if (patch.value.unmapped) {
        await store.appendEvent(runId, "clarification_unmapped", "system", { model, intakeId });
        return {
          ok: false,
          reason: "I couldn't map that to the scope. Answer the open questions, or start a new request if the project changed.",
        };
      }
      const outcome = await validateModelScope(applyClarification(base, patch.value), model, runId, "clarification_applied");
      return outcome.ok ? { ...outcome, notes: latest.body.notes } : outcome;
    },

    async applyAnswer({ runId, receiptId, field, values }) {
      const latest = await store.latestReceipt(runId);
      if (!latest) throw new IntegrityError(`run ${runId} has no receipt to answer`);
      if (latest.id !== receiptId) return { ok: false, reason: "That question was already answered; use the latest card." };
      const patch = answerPatch(field, values);
      if (!patch) return { ok: false, reason: "That answer isn't one of the choices. Pick one, or type your answer." };
      const outcome = await validateScope(applyClarification(latest.body.extraction, patch), runId, "answer_applied", { source: "button", field, values });
      return outcome.ok ? { ...outcome, notes: latest.body.notes } : outcome;
    },

    async confirmApproval({ runId, approvalId, receiptId }) {
      const approval = await store.getApproval(approvalId);
      const run = await store.getRun(runId);
      if (!approval || approval.run_id !== runId || approval.receipt_id !== receiptId || run.state !== "SCOPE_APPROVED") {
        throw new IntegrityError(`approval ${approvalId} does not match run ${runId} receipt ${receiptId} (state ${run.state})`);
      }
      await upsertStatus(run, statusView(runId, "approved"));
    },

    async findCommittedApproval({ runId }) {
      const approval = await store.getApprovalForRun(runId);
      return approval ? { approvalId: approval.id, receiptId: approval.receipt_id, scopeHash: approval.scope_hash } : null;
    },

    async notify({ runId, text, key }) {
      const run = await store.getRun(runId);
      await adapterFor(run).post(threadOf(run), { kind: "text", text }, key);
    },

    async requestMarginApproval({ runId, exceptionId, reason }) {
      const run = await store.getRun(runId);
      const exception = await store.getMarginException(runId);
      if (exception?.id !== exceptionId) throw new IntegrityError(`margin exception ${exceptionId} does not belong to ${runId}`);
      const proposal = await store.readArtifact<Proposal>(runId, "bind", "proposal");
      if (!proposal) throw new IntegrityError(`missing bind/proposal for ${runId}`);
      const requester = await store.resolvePersonById(run.person_id);
      const mix = proposal.internal.mix;
      const share = (k: keyof typeof mix) => `${k} ${mix[k].share_pct ?? "–"}% of total at ${mix[k].margin_pct ?? "–"}% margin`;
      const lines = [
        `Requested by ${requester?.display_name ?? run.person_id} for ${proposal.client}, ${proposal.property}.`,
        `${proposal.commercial.label}: ${formatUsd(proposal.commercial.subtotal_cents)} (${proposal.market}).`,
        `Gross margin ${exception.gross_margin_pct}% vs the ${exception.minimum_pct}% ${exception.market} floor.`,
        `Mix: ${share("equipment")}; ${share("labor")}; ${share("parts")}.`,
        "Approving is the written exception the 2026 sales comp policy requires; the PDF is then posted to the requester.",
      ];
      const admins = await store.adminDirectSpaces(run.platform);
      for (const admin of admins) {
        await adapterFor(run).post(
          { platform: run.platform, spaceId: admin.dm_space_id, threadId: admin.dm_space_id },
          { kind: "margin_exception", exceptionId, title: `Margin exception ${exceptionId}`, lines },
          `${exceptionId}:admin:${admin.person_id}`,
        );
      }
      const who = admins.map((x) => x.display_name).join(" or ");
      const text = admins.length
        ? `${reason}. I've asked ${who} to approve the exception; the PDF follows if it's approved. Nothing was sent to a customer.`
        : `${reason}. No admin can be reached yet: an admin needs to send System Designer a direct message once. The run is held; nothing was sent to a customer.`;
      await adapterFor(run).post(threadOf(run), { kind: "text", text }, `${exceptionId}:requester`);
    },

    async findMarginDecision({ runId }) {
      const exception = await store.getMarginException(runId);
      return exception?.decision ? { exceptionId: exception.id, decision: exception.decision, decidedBy: exception.decided_by_name ?? exception.decided_by! } : null;
    },

    async markOutcome({ runId, state, reason }) {
      const run = await store.getRun(runId);
      const duringBuild = !["RECEIVED", "AUTHENTICATED_AND_CAPTURED", "NEEDS_CLARIFICATION", "AWAITING_SCOPE_APPROVAL", "BLOCKED"].includes(run.state);
      const duringPdf = ["VALIDATED", "RENDERED", "PREFLIGHT_PASSED"].includes(run.state);
      if (run.state !== state) await store.transitionRun(runId, state, "system", { error: reason, from: run.state });
      const phase =
        state === "STALE" ? "expired" : state === "RECONCILIATION_REQUIRED" ? "reconcile" : duringPdf ? "blocked_pdf" : duringBuild ? "blocked_build" : "blocked";
      await upsertStatus(await store.getRun(runId), statusView(runId, phase, reason));
      if (state === "RECONCILIATION_REQUIRED") {
        await adapterFor(run).post(
          threadOf(run),
          { kind: "text", text: `D-Tools changed while this proposal was being built: ${reason}. I stopped before producing a PDF. Nothing was sent to a customer or written to D-Tools. Zack needs to decide whether to rebuild.` },
          `${runId}:reconcile`,
        );
      }
      if (state === "BLOCKED") {
        const text = duringBuild
          ? `I stopped the build after ${run.state}: ${reason}. Nothing was sent to a customer or written to D-Tools. The run is kept for review.`
          : `I stopped before writing a scope: ${reason}. Nothing was sent anywhere. Reply with a new message to try again.`;
        await adapterFor(run).post(threadOf(run), { kind: "text", text }, `${runId}:blocked`);
      }
    },

    buildStage: createBuildStage({
      store,
      dtools: deps.dtools,
      patterns: deps.patterns,
      renderPdf: deps.renderPdf,
      fetchImage: deps.fetchImage,
      postView: (run, view, key) => adapterFor(run).post(threadOf(run), view, key).then(() => undefined),
      postFile: async (run, file, key) => {
        // Chat uploads need a user; a delegated upload acts as the requester, who is in the conversation.
        const actAs = (await store.requesterEmail(run.id)) ?? undefined;
        return adapterFor(run).postFile(threadOf(run), { ...file, actAs }, key);
      },
      notify: (run, text, key) => adapterFor(run).post(threadOf(run), { kind: "text", text }, key).then(() => undefined),
    }),
  };
}
