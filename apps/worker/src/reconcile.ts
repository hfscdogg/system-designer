import type { Store } from "@sd/store";
import type { WorkflowPort } from "./port.ts";

/**
 * Restart missing workflows. If the gateway saved a run but could not start its
 * workflow (Temporal briefly unreachable), this job starts it later. Starting
 * is idempotent per run id, so live and finished workflows are untouched.
 */
export async function reconcileRuns(store: Store, workflows: WorkflowPort, minAgeSeconds = 300): Promise<{ checked: string[]; failed: string[] }> {
  const runs = await store.listRunsAwaitingWorkflow(minAgeSeconds);
  const failed: string[] = [];
  for (const run of runs) {
    try {
      await workflows.start(run.id);
    } catch (err) {
      failed.push(run.id);
      await store.appendEvent(run.id, "reconcile_start_failed", "system", { error: String(err) });
    }
  }
  if (runs.length) await store.appendEvent(null, "reconcile_pass", "system", { checked: runs.length, failed: failed.length });
  return { checked: runs.map((r) => r.id), failed };
}
