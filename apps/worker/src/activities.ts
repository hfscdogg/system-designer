import {
  applyClarification,
  buildReceipt,
  computeBlockers,
  hashCanonical,
  normalizeExtraction,
  questionsForTurn,
  validateClarificationPatch,
  validateExtraction,
  type CurrentReceipt,
} from "@sd/core";
import type { ChannelAdapter } from "@sd/channels";
import type { ClarificationInterpreter, ScopeExtractor } from "@sd/llm";
import type { PatternSpec } from "@sd/build";
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
    const valid = validateExtraction(raw);
    if (!valid.ok) {
      await store.appendEvent(runId, `${kind}_rejected`, "system", { model, errors: valid.errors });
      return { ok: false, reason: `the scope could not be validated (${valid.errors.slice(0, 3).join("; ")})` };
    }
    const { scope, notes } = normalizeExtraction(valid.value);
    await store.appendEvent(runId, kind, "system", { model, scopeSha256: hashCanonical(scope), notes });
    return { ok: true, extraction: scope, notes };
  }

  return {
    async reportProgress({ runId, phase, note }) {
      await upsertStatus(await store.getRun(runId), statusView(runId, phase, note ?? null));
    },

    async extractScope({ runId }) {
      const run = await store.getRun(runId);
      const intake = await store.getIntake(run.intake_id); // verifies the stored text hash
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
      // The receipt id is the idempotency key: a retried activity cannot post it twice.
      const { messageId } = await adapter.post(
        threadOf(run),
        {
          kind: "receipt",
          receiptId: receipt.receipt_id,
          version: receipt.version,
          status: receipt.status,
          lines: receipt.lines,
          approve: receipt.scope_hash ? { receiptId: receipt.receipt_id, scopeHash: receipt.scope_hash } : null,
        },
        receipt.receipt_id,
      );
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
      const questions = questionsForTurn(computeBlockers(base)).map((b) => b.question);
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
      postFile: async (run, file, key) => {
        const a = adapterFor(run);
        return a.postFile(threadOf(run), file, key);
      },
      notify: (run, text, key) => adapterFor(run).post(threadOf(run), { kind: "text", text }, key).then(() => undefined),
    }),
  };
}
