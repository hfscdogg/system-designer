/**
 * Workflows run AUTO_UPGRADE (main.ts): every deploy moves in-flight runs onto the new code, which
 * then replays their history. A change here, in logic.ts or in @sd/core/workflow-safe that changes
 * which activities, timers or signals a run issues, or their order, must keep the old path for runs
 * already past that point:
 *
 *   if (patched("short-change-name")) { new behaviour } else { old behaviour }
 *
 * Once no run started before the change is open (runs end within 14 days), replace patched() with
 * deprecatePatch("short-change-name") for one release, then delete the old branch. Changes inside
 * activities need none of this: activities are not replayed.
 */
import { condition, defineSignal, proxyActivities, setHandler } from "@temporalio/workflow";
import type { RunSignal } from "@sd/core/workflow-safe";
import { runProposal, type ProposalRunInput, type RunActivities, type RunResult } from "./logic.ts";

export const runSignal = defineSignal<[RunSignal]>("run");

const acts = proxyActivities<RunActivities>({
  startToCloseTimeout: "3 minutes",
  retry: {
    initialInterval: "2 seconds",
    maximumInterval: "1 minute",
    maximumAttempts: 6,
    // Programming and integrity errors are not transient; retrying them only hides them.
    nonRetryableErrorTypes: ["IntegrityError"],
  },
});

/**
 * Sends a budget's design retainer (D-Tools opportunity, QuickBooks invoice); workflowId = `${runId}:retainer`.
 * Inputs started before 2026-10-12 have no `email`; the activity then skips QuickBooks.
 */
export async function retainerRequest(input: { runId: string; tap: string; email?: string }): Promise<void> {
  await acts.createRetainer(input);
}

/** One workflow per proposal run; workflowId = runId. */
export async function proposalRun(input: ProposalRunInput): Promise<RunResult> {
  const queue: RunSignal[] = [];
  setHandler(runSignal, (s) => {
    queue.push(s);
  });
  return runProposal(input, {
    acts,
    async nextSignal(idleMs) {
      const arrived = await condition(() => queue.length > 0, idleMs);
      return arrived ? queue.shift()! : null;
    },
    takeQueued(type) {
      const taken = queue.filter((s) => s.type === type);
      queue.splice(0, queue.length, ...queue.filter((s) => s.type !== type));
      return taken;
    },
  });
}
