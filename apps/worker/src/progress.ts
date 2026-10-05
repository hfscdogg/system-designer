import type { StepState, View } from "@sd/channels";
import type { Phase } from "./workflows/logic.ts";

/**
 * The live status card. One message per run, edited in place, so the thread
 * shows progress without a stream of pings.
 */
const STEPS = [
  "Request captured",
  "Reading your request",
  "Scope receipt",
  "Your approval",
  "D-Tools catalog read",
  "Proposal build",
  "PDF checks",
] as const;

const PROGRESS: Record<Phase, { done: number; active: number | null; failed?: number }> = {
  reading: { done: 1, active: 1 },
  needs_answers: { done: 2, active: 2 },
  awaiting_approval: { done: 3, active: 3 },
  approved: { done: 4, active: null },
  blocked: { done: 1, active: null, failed: 1 },
  expired: { done: 0, active: null },
};

export function statusView(runId: string, phase: Phase, note: string | null = null): View {
  const p = PROGRESS[phase];
  const steps = STEPS.map((label, i): { label: string; state: StepState } => {
    if (p.failed === i) return { label, state: "failed" };
    if (i < p.done) return { label, state: "done" };
    if (p.active === i) return { label, state: "active" };
    return { label, state: "pending" };
  });
  const defaults: Partial<Record<Phase, string>> = {
    needs_answers: "A few answers needed — see the questions below.",
    awaiting_approval: "Check the receipt below and approve it when it's right.",
    approved: "Scope approved. Catalog and build stages are not enabled in this release yet.",
    expired: "This request is closed. Start a new message to begin again.",
  };
  return { kind: "status", title: `Proposal run ${runId.slice(4, 12)}`, steps, note: note ?? defaults[phase] ?? null };
}
