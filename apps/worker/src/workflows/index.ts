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
  });
}
