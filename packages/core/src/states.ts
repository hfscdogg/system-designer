/**
 * Canonical run states (PRD §6.1). READY_HELD is the only successful terminal
 * state for the pilot. This module is workflow-safe: no Node imports.
 */
export const RUN_STATES = [
  "RECEIVED",
  "AUTHENTICATED_AND_CAPTURED",
  "NEEDS_CLARIFICATION",
  "AWAITING_SCOPE_APPROVAL",
  "SCOPE_APPROVED",
  "PREBUILD_VERIFIED",
  "CATALOG_EVIDENCE_ADMITTED",
  "SELECTION_READY",
  "COMPILED",
  "BOUND",
  "AWAITING_MARGIN_APPROVAL",
  "VALIDATED",
  "RENDERED",
  "PREFLIGHT_PASSED",
  "READY_HELD",
  "BLOCKED",
  "FAILED",
  "STALE",
  "SUPERSEDED",
  "RECONCILIATION_REQUIRED",
] as const;

export type RunState = (typeof RUN_STATES)[number];

/** States in which a run still owns its thread and accepts clarification. */
export const OPEN_INTAKE_STATES: readonly RunState[] = [
  "RECEIVED",
  "AUTHENTICATED_AND_CAPTURED",
  "NEEDS_CLARIFICATION",
  "AWAITING_SCOPE_APPROVAL",
];

const OUTCOMES: RunState[] = ["BLOCKED", "FAILED", "STALE", "SUPERSEDED", "RECONCILIATION_REQUIRED"];

const FORWARD: Partial<Record<RunState, RunState[]>> = {
  RECEIVED: ["AUTHENTICATED_AND_CAPTURED"],
  AUTHENTICATED_AND_CAPTURED: ["NEEDS_CLARIFICATION", "AWAITING_SCOPE_APPROVAL"],
  NEEDS_CLARIFICATION: ["NEEDS_CLARIFICATION", "AWAITING_SCOPE_APPROVAL"],
  AWAITING_SCOPE_APPROVAL: ["NEEDS_CLARIFICATION", "AWAITING_SCOPE_APPROVAL", "SCOPE_APPROVED"],
  SCOPE_APPROVED: ["PREBUILD_VERIFIED"],
  PREBUILD_VERIFIED: ["CATALOG_EVIDENCE_ADMITTED"],
  CATALOG_EVIDENCE_ADMITTED: ["SELECTION_READY"],
  SELECTION_READY: ["COMPILED"],
  COMPILED: ["BOUND"],
  BOUND: ["VALIDATED", "AWAITING_MARGIN_APPROVAL"],
  // Below the margin floor: held until an admin approves the exception (2026 sales comp policy).
  AWAITING_MARGIN_APPROVAL: ["VALIDATED"],
  VALIDATED: ["RENDERED"],
  RENDERED: ["PREFLIGHT_PASSED"],
  PREFLIGHT_PASSED: ["READY_HELD"],
};

const TERMINAL: RunState[] = ["READY_HELD", "FAILED", "STALE", "SUPERSEDED"];

export function isTerminal(state: RunState): boolean {
  return TERMINAL.includes(state);
}

export function canTransition(from: RunState, to: RunState): boolean {
  // A finished budget is replaced, not reopened, when a revision of it is delivered.
  if (from === "READY_HELD" && to === "SUPERSEDED") return true;
  if (isTerminal(from)) return false;
  if (OUTCOMES.includes(to)) return true;
  return (FORWARD[from] ?? []).includes(to);
}

export function assertTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal run state transition ${from} -> ${to}`);
  }
}
