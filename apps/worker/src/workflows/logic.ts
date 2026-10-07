/**
 * The proposal-run state machine as plain async code. It runs inside Temporal
 * (workflows/index.ts) in production and inline in tests, so it must stay
 * deterministic: no I/O, clocks or randomness here — only activities.
 */
import { decideSignal, type CurrentReceipt, type RunSignal } from "@sd/core/workflow-safe";
import type { ScopeExtraction } from "@sd/core/workflow-safe";

export interface ProposalRunInput {
  runId: string;
}

export type Phase =
  | "reading"
  | "needs_answers"
  | "awaiting_approval"
  | "approved"
  | "catalog"
  | "building"
  | "awaiting_exception"
  | "validated"
  | "rendering"
  | "ready"
  | "reconcile"
  | "blocked"
  | "blocked_build"
  | "blocked_pdf"
  | "expired";

/** Build stages after approval, in order (PRD §13). */
export const BUILD_STAGES = [
  "prebuild",
  "admitCatalog",
  "compileSelection",
  "bindProposal",
  "validate",
  "refreshCatalog",
  "render",
  "preflight",
  "handoff",
] as const;
export type BuildStage = (typeof BUILD_STAGES)[number];
export type StageOutcome =
  | { ok: true; summary: string }
  | { ok: false; reason: string; outcome?: "BLOCKED" | "RECONCILIATION_REQUIRED" }
  /** Below the margin floor: hold for an admin's decision, then repeat the stage. */
  | { ok: false; reason: string; outcome: "MARGIN_EXCEPTION"; exceptionId: string };

export type MarginDecision = { exceptionId: string; decision: "approved" | "declined"; decidedBy: string };

const STAGE_PHASE: Record<BuildStage, Phase> = {
  prebuild: "catalog",
  admitCatalog: "catalog",
  compileSelection: "building",
  bindProposal: "building",
  validate: "building",
  refreshCatalog: "validated",
  render: "rendering",
  preflight: "rendering",
  handoff: "rendering",
};

export type ExtractOutcome = { ok: true; extraction: ScopeExtraction; notes: string[] } | { ok: false; reason: string };

export type PublishOutcome = { ok: true; receipt: CurrentReceipt } | { ok: false; runState: string };

export interface RunActivities {
  reportProgress(a: { runId: string; phase: Phase; note?: string }): Promise<void>;
  extractScope(a: { runId: string }): Promise<ExtractOutcome>;
  /** Fails softly when the run already left scope collection (approved or reset meanwhile). */
  publishReceipt(a: { runId: string; version: number; extraction: ScopeExtraction; notes: string[] }): Promise<PublishOutcome>;
  interpretClarification(a: { runId: string; intakeId: string }): Promise<ExtractOutcome>;
  confirmApproval(a: { runId: string; approvalId: string; receiptId: string }): Promise<void>;
  findCommittedApproval(a: { runId: string }): Promise<{ approvalId: string; receiptId: string; scopeHash: string } | null>;
  notify(a: { runId: string; text: string; key: string }): Promise<void>;
  markOutcome(a: { runId: string; state: "BLOCKED" | "STALE" | "RECONCILIATION_REQUIRED"; reason: string }): Promise<void>;
  buildStage(a: { runId: string; stage: BuildStage }): Promise<StageOutcome>;
  /** Ask the admins to decide a margin exception, and tell the requester it is held. */
  requestMarginApproval(a: { runId: string; exceptionId: string; reason: string }): Promise<void>;
  /** A decision already committed in the database (its signal may have been lost). */
  findMarginDecision(a: { runId: string }): Promise<MarginDecision | null>;
}

export interface RunRuntime {
  acts: RunActivities;
  /** Next signal, or null when `idleMs` passes without one. */
  nextSignal(idleMs: number): Promise<RunSignal | null>;
}

export type RunResult =
  | { state: "READY_HELD"; approvalId: string; receiptId: string }
  | { state: "RECONCILIATION_REQUIRED"; reason: string }
  | { state: "BLOCKED" | "STALE"; reason: string };

export const RECONCILE_EVERY_MS = 60 * 60 * 1000;
export const EXPIRE_AFTER_IDLE_CHECKS = 14 * 24; // ~14 days of hourly checks

function closedRun(runState: string): RunResult {
  return { state: "STALE", reason: `run is ${runState}` };
}

export async function runProposal(input: ProposalRunInput, rt: RunRuntime): Promise<RunResult> {
  const { acts } = rt;
  const { runId } = input;
  let notices = 0;
  const notify = (text: string) => acts.notify({ runId, text, key: `${runId}:notice:${++notices}` });

  await acts.reportProgress({ runId, phase: "reading" });
  const first = await acts.extractScope({ runId });
  if (!first.ok) {
    await acts.markOutcome({ runId, state: "BLOCKED", reason: first.reason });
    return { state: "BLOCKED", reason: first.reason };
  }
  let version = 1;
  const published = await acts.publishReceipt({ runId, version, extraction: first.extraction, notes: first.notes });
  if (!published.ok) return closedRun(published.runState);
  let current = published.receipt;

  let idleChecks = 0;
  for (;;) {
    let signal = await rt.nextSignal(RECONCILE_EVERY_MS);
    if (signal === null) {
      // No signal: an approval may have committed while its signal was lost. Reconcile from the database.
      const committed = await acts.findCommittedApproval({ runId });
      if (committed) signal = { type: "approved", ...committed };
      else if (++idleChecks >= EXPIRE_AFTER_IDLE_CHECKS) {
        const reason = "no reply for 14 days";
        await acts.markOutcome({ runId, state: "STALE", reason });
        return { state: "STALE", reason };
      } else continue;
    }
    idleChecks = 0;

    const decision = decideSignal(current, signal);
    switch (decision.action) {
      case "stop":
        await acts.reportProgress({ runId, phase: "expired", note: decision.reason });
        return { state: "STALE", reason: decision.reason };
      case "reject":
        await notify(`I can't accept that approval: ${decision.reason}.`);
        break;
      case "clarify": {
        const next = await acts.interpretClarification({ runId, intakeId: decision.intakeId });
        if (!next.ok) {
          await notify(next.reason);
          break;
        }
        const republished = await acts.publishReceipt({ runId, version: ++version, extraction: next.extraction, notes: next.notes });
        if (republished.ok) {
          current = republished.receipt;
          break;
        }
        // The previous receipt was approved (or the session reset) while this answer was being read.
        if (republished.runState === "SCOPE_APPROVED") {
          const committed = await acts.findCommittedApproval({ runId });
          if (committed) {
            await notify("Your last message arrived after the scope was approved, so it was not applied. Start a new request to change the approved scope.");
            await acts.confirmApproval({ runId, approvalId: committed.approvalId, receiptId: committed.receiptId });
            return build(rt, runId, committed.approvalId, committed.receiptId);
          }
        }
        return closedRun(republished.runState);
      }
      case "ignore":
        break;
      case "approve":
        await acts.confirmApproval({ runId, approvalId: decision.approvalId, receiptId: current.receiptId });
        return build(rt, runId, decision.approvalId, current.receiptId);
    }
  }
}

/** Exactly one build per approved scope, ending at READY_HELD; stops at the first failed stage (PRD §13.8). */
async function build(rt: RunRuntime, runId: string, approvalId: string, receiptId: string): Promise<RunResult> {
  for (let i = 0; i < BUILD_STAGES.length; i++) {
    const stage = BUILD_STAGES[i]!;
    await rt.acts.reportProgress({ runId, phase: STAGE_PHASE[stage] });
    const outcome = await rt.acts.buildStage({ runId, stage });
    if (outcome.ok) continue;
    if (outcome.outcome === "MARGIN_EXCEPTION") {
      const decided = await awaitMarginDecision(rt, runId, outcome.exceptionId, outcome.reason);
      if (decided.decision === "approved") {
        i--; // repeat the stage; it now finds the approved exception
        continue;
      }
      const [state, reason] =
        "reason" in decided ? (["STALE", decided.reason] as const) : (["BLOCKED", `margin exception declined by ${decided.decidedBy}`] as const);
      await rt.acts.markOutcome({ runId, state, reason });
      return { state, reason };
    }
    const state = outcome.outcome ?? "BLOCKED";
    await rt.acts.markOutcome({ runId, state, reason: outcome.reason });
    return { state, reason: outcome.reason };
  }
  await rt.acts.reportProgress({ runId, phase: "ready" });
  return { state: "READY_HELD", approvalId, receiptId };
}

/** Hold until an admin decides the exception. Lost signals are reconciled hourly from the database. */
async function awaitMarginDecision(
  rt: RunRuntime,
  runId: string,
  exceptionId: string,
  reason: string,
): Promise<MarginDecision | { decision: "expired"; reason: string }> {
  await rt.acts.requestMarginApproval({ runId, exceptionId, reason });
  await rt.acts.reportProgress({ runId, phase: "awaiting_exception", note: reason });
  let idleChecks = 0;
  for (;;) {
    const signal = await rt.nextSignal(RECONCILE_EVERY_MS);
    if (signal?.type === "invalidate") return { decision: "expired", reason: signal.reason };
    if (signal === null || (signal.type === "margin_decision" && signal.exceptionId === exceptionId)) {
      // The database is the record; the signal only says when to look.
      const decided = await rt.acts.findMarginDecision({ runId });
      if (decided?.exceptionId === exceptionId) return decided;
      if (signal === null && ++idleChecks >= EXPIRE_AFTER_IDLE_CHECKS) return { decision: "expired", reason: "no margin decision for 14 days" };
    }
  }
}
