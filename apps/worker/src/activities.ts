import {
  ANSWER_CHOICES,
  answerPatch,
  applyClarification,
  buildReceipt,
  computeBlockers,
  describeScopeChanges,
  systemsMentioned,
  hashCanonical,
  normalizeExtraction,
  parsePastedItems,
  validateClarificationPatch,
  validateExtraction,
  type CurrentReceipt,
  type ScopeExtraction,
} from "@sd/core";
import type { ChannelAdapter, View } from "@sd/channels";
import type { ClarificationInterpreter, ScopeExtractor } from "@sd/llm";
import { formatUsd, type PatternSpec, type Proposal } from "@sd/build";
import type { DToolsReader, DToolsWriter } from "@sd/dtools";
import type { QboClient } from "@sd/qbo";
import { IntegrityError, threadOf, type RunRecord, type Store } from "@sd/store";
import { createBuildStage } from "./build-activities.ts";
import { createRetainer } from "./retainer.ts";
import { statusView } from "./progress.ts";
import type { ExtractOutcome, RunActivities } from "./workflows/logic.ts";

export interface ActivityDeps {
  store: Store;
  adapters: Record<string, ChannelAdapter>;
  extractor: ScopeExtractor;
  interpreter: ClarificationInterpreter;
  dtools: DToolsReader;
  /** The one approved D-Tools write (retainer opportunities); null where it is not configured. */
  dtoolsWriter?: DToolsWriter | null;
  /** QuickBooks Online, for the design-retainer invoice; null where it is not switched on. */
  qbo?: QboClient | null;
  patterns: PatternSpec[];
  /** HTML → PDF (Chromium in production). */
  renderPdf: (html: string) => Promise<Uint8Array>;
  /** Fetch an exact-model product image; null when unavailable (→ IMAGE PENDING). */
  fetchImage: (url: string) => Promise<{ bytes: Uint8Array; contentType: string } | null>;
  /** Model attempts per extraction before the run is blocked. */
  extractionAttempts?: number;
}

export { IntegrityError };

/**
 * What the rep said that couldn't be placed, named back with how to say it so it can be (Henry's demo, 2026-11-09:
 * "I couldn't safely apply that answer" and "I couldn't map that to the scope" told the rep nothing to try).
 */
export function notPlaced(text: string, revision = false): string {
  const said = text.replace(/\s+/g, " ").trim();
  const quoted = said.length > 120 ? `${said.slice(0, 117)}...` : said;
  return [
    `I couldn't place "${quoted}" in the ${revision ? "earlier budget" : "scope"}.`,
    `Say it as a change, for example "add 10 ft of linear lighting in the kitchen", "make it 1 Cat6 drop", "remove the soundbar" or "hours to 7".`,
    `Give anything without a standard product a dollar amount ("add a $600 allowance for the turntable").`,
    revision ? `Or tap "New request" for a different job.` : `Or tap "Start over" if the project changed.`,
  ].join(" ");
}

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

  /**
   * Keep the model's raw reply and what it was given, so every prompt and its result can be audited.
   * Named by content, so a retried call adds its own record and a repeat adds nothing.
   */
  async function recordModelReply(runId: string, kind: string, input: Record<string, unknown>, raw: unknown, model: string): Promise<void> {
    const record = { kind, model, input, raw };
    await store.publishArtifact(runId, "model", `${kind}-${hashCanonical(record).replace(/^sha256:/, "").slice(0, 16)}`, record);
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
    // A pasted item list ("Sony K65XR70 × 2", one per line) sets those items' counts as written, without the model.
    const pasted = await pastedQuantities(parentRunId, change);
    if (pasted) {
      if (!pasted.ok) return { ok: false, reason: pasted.reason };
      const merged = new Map((base.item_quantities ?? []).map((q) => [q.record_id + "|" + q.role, q]));
      for (const q of pasted.items) merged.set(q.record_id + "|" + q.role, q);
      const revised = { ...structuredClone(base), item_quantities: [...merged.values()] };
      await store.appendEvent(runId, "revision_pasted_list", "system", { parentRunId, items: pasted.items });
      const outcome = await validateScope(revised, runId, "revision_applied", { model: "pasted item list" });
      if (!outcome.ok) return outcome;
      const changed = describeScopeChanges(base, outcome.extraction);
      return {
        ...outcome,
        notes: [
          `Revision ${revision} of the budget approved in ${parentReceipt.id}; it replaces that budget once approved.`,
          changed.length ? `Changed: ${changed.join("; ")}` : "Changed: nothing; every pasted quantity matches the budget.",
          ...outcome.notes,
        ],
      };
    }
    const { patch, model } = await interpretAnswer(runId, "revision", base, [], change);
    if (!patch.ok || patch.value.unmapped) {
      await store.appendEvent(runId, "revision_unmapped", "system", { model, parentRunId, errors: patch.ok ? [] : patch.errors });
      return { ok: false, reason: notPlaced(change, true) };
    }
    const revised = applyClarification(base, patch.value);
    // Open questions about something the revision removed no longer apply.
    const removed = revised.excluded_scope.filter((x) => !base.excluded_scope.includes(x)).map((x) => x.toLowerCase());
    revised.unresolved_questions = revised.unresolved_questions.filter((q) => !removed.some((x) => q.toLowerCase().includes(x)));
    const outcome = await validateModelScope(revised, model, runId, "revision_applied");
    if (!outcome.ok) return outcome;
    // So do open questions about a system the revision dropped (no Control4 → no question about the Halo remote).
    const droppedSystems = base.functional_systems.filter((x) => !outcome.extraction.functional_systems.includes(x));
    outcome.extraction.unresolved_questions = outcome.extraction.unresolved_questions.filter(
      (q) => !systemsMentioned(q).some((x) => droppedSystems.includes(x)),
    );
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

  /**
   * The counts a revision pastes for the revised budget's own items, matched to its lines by brand and model; null when
   * the change is not an item list (it goes to the model). An item line that matches nothing in the budget is named back
   * to the rep rather than guessed.
   */
  async function pastedQuantities(
    parentRunId: string,
    change: string,
  ): Promise<null | { ok: true; items: Array<{ item: string; role: string; record_id: string; quantity: number }> } | { ok: false; reason: string }> {
    const parsed = parsePastedItems(change);
    // One counted item with other words around it ("make it 2 TVs") is an ordinary revision for the model.
    const lines = change.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!parsed.length || (parsed.length === 1 && lines.length === 1 && !/[×]|\bx\s*\d+\s*$/i.test(lines[0]!))) return null;
    const proposal = await store.readArtifact<Proposal>(parentRunId, "bind", "proposal");
    const priced = (proposal?.sections ?? []).flatMap((s) => s.lines);
    const key = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
    const items: Array<{ item: string; role: string; record_id: string; quantity: number }> = [];
    const unknown: string[] = [];
    for (const p of parsed) {
      const k = key(p.item);
      const line = priced.find((l) => [`${l.brand} ${l.model}`, l.model, l.label].some((t) => t && key(t) === k));
      if (line) items.push({ item: [line.brand, line.model].filter(Boolean).join(" "), role: line.role, record_id: line.record_id, quantity: p.quantity });
      else unknown.push(p.item);
    }
    // Not this budget's list at all: let the model read it as words.
    if (!items.length) return null;
    if (unknown.length) {
      return {
        ok: false,
        reason: `I couldn't match ${unknown.map((u) => `"${u}"`).join(", ")} to the budget's items. Paste the lines as the budget lists them (for example "Sony K65XR70 × 2"), or describe the change in words`,
      };
    }
    return { ok: true, items };
  }

  /** Read a request's scope from its text (the model, then validation), with retries. */
  async function extractFrom(runId: string, text: string, attachmentNames: string[]): Promise<ExtractOutcome> {
    let last: ExtractOutcome = { ok: false, reason: "no attempt made" };
    for (let i = 0; i < attempts; i++) {
      const input = { text, attachmentNames };
      const { raw, model } = await deps.extractor.extract(input);
      await recordModelReply(runId, "extraction", input, raw, model);
      last = await validateModelScope(raw, model, runId, "scope_extracted");
      if (last.ok) {
        const ignored = attachmentNames.length ? [`${attachmentNames.length} attachment(s) received; not yet used as scope evidence`] : [];
        return { ...last, notes: [...last.notes, ...ignored] };
      }
    }
    return last;
  }

  /**
   * Map a rep's answer or revision onto the scope, with the same retries as extraction: one model reply that
   * fails validation or comes back unmapped shouldn't block a change the model maps on another try
   * (staging smoke, 2026-11-09: "add 10' of linear lighting in the kitchen" placed in two runs, not in the third).
   */
  async function interpretAnswer(runId: string, kind: "revision" | "clarification", current: ScopeExtraction, questions: string[], answer: string) {
    let last: { patch: ReturnType<typeof validateClarificationPatch>; model: string } | undefined;
    for (let i = 0; i < Math.max(1, attempts); i++) {
      const { raw, model } = await deps.interpreter.interpret({ current, questions, answer });
      await recordModelReply(runId, kind, kind === "revision" ? { answer } : { questions, answer }, raw, model);
      last = { patch: validateClarificationPatch(raw), model };
      if (last.patch.ok && !last.patch.value.unmapped) break;
    }
    return last!;
  }

  /** These intakes, in order, when each is the requester's own message; anyone else's are left out. */
  async function requesterIntakes(run: RunRecord, ids: string[]) {
    const intakes = await Promise.all([...new Set(ids)].map((id) => store.getIntake(id)));
    return intakes.filter((m) => m.person_id === run.person_id && m.id !== run.intake_id);
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

    async extractScope({ runId, alsoIntakeIds }) {
      const run = await store.getRun(runId);
      const intake = await store.getIntake(run.intake_id); // verifies the stored text hash
      // Messages that arrived before the first receipt are read with the request, as one message.
      const more = await requesterIntakes(run, alsoIntakeIds ?? []);
      if (more.length) await store.appendEvent(runId, "intake_combined", "system", { intakeIds: more.map((m) => m.id) });
      const text = [intake.text, ...more.map((m) => m.text)].join("\n\n");
      if (run.parent_run_id) return reviseScope(run.id, run.parent_run_id, run.revision, text);
      return extractFrom(runId, text, [...intake.attachments, ...more.flatMap((m) => m.attachments)].map((a) => a.name));
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
      const run = await store.getRun(runId);
      // A first message that was only who and where ("Rick Crowder, 100 Main St") left nothing to price: the next
      // message is the request itself, so both are read together as one, instead of patching an empty scope.
      if (!run.parent_run_id && computeBlockers(base).some((b) => b.field === "functional_systems")) {
        const earlier = (await store.listEvents(runId)).filter((e) => e.type === "intake_combined").flatMap((e) => e.data.intakeIds as string[]);
        const intake = await store.getIntake(run.intake_id);
        const more = await requesterIntakes(run, [...earlier, intakeId]);
        await store.appendEvent(runId, "intake_combined", "system", { intakeIds: more.map((m) => m.id) });
        const outcome = await extractFrom(runId, [intake.text, ...more.map((m) => m.text)].join("\n\n"), [...intake.attachments, ...more.flatMap((m) => m.attachments)].map((a) => a.name));
        return outcome.ok ? { ...outcome, notes: [...latest.body.notes.filter((n) => !outcome.notes.includes(n)), ...outcome.notes] } : outcome;
      }
      // Every open question, so one typed or dictated reply can answer several.
      const questions = computeBlockers(base).map((b) => b.question);
      const { patch, model } = await interpretAnswer(runId, "clarification", base, questions, answer.text);
      if (!patch.ok) {
        await store.appendEvent(runId, "clarification_rejected", "system", { model, intakeId, errors: patch.errors });
        return { ok: false, reason: notPlaced(answer.text) };
      }
      if (patch.value.unmapped) {
        await store.appendEvent(runId, "clarification_unmapped", "system", { model, intakeId });
        return { ok: false, reason: notPlaced(answer.text) };
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
        if (duringBuild) {
          // The approved scope can still be changed and rebuilt: a run blocked after approval is not a dead end
          // with a Revise button only on a budget that was never made (Zack's Giessel job, 2026-10-26).
          const text =
            `I couldn't build this budget: ${reason}. Nothing was sent to a customer or written to D-Tools. ` +
            "Tap Revise this request and say what to change in plain words, and I'll rebuild it from the approved scope, or tap New request.";
          await adapterFor(run).post(threadOf(run), { kind: "budget_actions", runId, text, retainer: false }, `${runId}:blocked`);
        } else {
          const text = `I stopped before writing a scope: ${reason}. Nothing was sent anywhere. Reply with a new message to try again.`;
          await adapterFor(run).post(threadOf(run), { kind: "text", text }, `${runId}:blocked`);
        }
      }
    },

    createRetainer: ({ runId, tap, email }) =>
      createRetainer(
        {
          store,
          dtools: deps.dtools,
          writer: deps.dtoolsWriter ?? null,
          qbo: deps.qbo ?? null,
          notify: (run, text, key) => adapterFor(run).post(threadOf(run), { kind: "text", text }, key).then(() => undefined),
        },
        runId,
        tap,
        email,
      ),

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
