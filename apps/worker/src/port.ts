import type { RunSignal } from "@sd/core";

/** How the gateway drives proposal runs. Temporal in production, inline in tests. */
export interface WorkflowPort {
  /** Idempotent: starting an existing run is a no-op. */
  start(runId: string): Promise<void>;
  signal(runId: string, signal: RunSignal): Promise<void>;
}
