import type { RunSignal } from "@sd/core";

/** The run's workflow has already finished (completed, failed or timed out) and cannot take signals. */
export class WorkflowClosedError extends Error {
  override name = "WorkflowClosedError";
}

/** How the gateway drives proposal runs. Temporal in production, inline in tests. */
export interface WorkflowPort {
  /** Idempotent: starting an existing run is a no-op. */
  start(runId: string): Promise<void>;
  /** Throws WorkflowClosedError when the run's workflow is no longer running. */
  signal(runId: string, signal: RunSignal): Promise<void>;
}
