import type { RunSignal } from "@sd/core";

/** The run's workflow has already finished (completed, failed or timed out) and cannot take signals. */
export class WorkflowClosedError extends Error {
  override name = "WorkflowClosedError";
}

/** How the gateway drives proposal runs. Temporal in production, inline in tests. */
export interface WorkflowPort {
  /** Idempotent: starting an existing run is a no-op. */
  start(runId: string): Promise<void>;
  /** Create the run's design retainer in D-Tools. Idempotent while one is in flight; a failed attempt can be retried. */
  startRetainer(runId: string, tap: string): Promise<void>;
  /** Throws WorkflowClosedError when the run's workflow is no longer running. */
  signal(runId: string, signal: RunSignal): Promise<void>;
  /** Whether the run's workflow is still running (false when it finished, failed or never started). */
  isRunning(runId: string): Promise<boolean>;
}
