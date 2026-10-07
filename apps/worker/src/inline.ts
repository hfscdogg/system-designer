import type { RunSignal } from "@sd/core";
import type { WorkflowPort } from "./port.ts";
import { runProposal, type RunActivities, type RunResult } from "./workflows/logic.ts";

interface InlineRun {
  queue: RunSignal[];
  wake: (() => void) | null;
  idle: Promise<void>;
  markIdle: () => void;
  result: Promise<RunResult>;
}

/**
 * Runs proposal workflows in-process with the same logic Temporal runs. For
 * tests and local development only: it has no durability.
 */
export class InlineWorkflows implements WorkflowPort {
  private readonly runs = new Map<string, InlineRun>();
  private readonly acts: RunActivities;

  constructor(acts: RunActivities) {
    this.acts = acts;
  }

  async start(runId: string): Promise<void> {
    if (this.runs.has(runId)) return;
    const run = { queue: [], wake: null } as unknown as InlineRun;
    this.resetIdle(run);
    this.runs.set(runId, run);
    run.result = runProposal(
      { runId },
      {
        acts: this.acts,
        nextSignal: async () => {
          while (run.queue.length === 0) {
            const woke = new Promise<void>((resolve) => (run.wake = resolve));
            run.markIdle();
            await woke;
          }
          return run.queue.shift()!;
        },
      },
    );
    run.result.finally(() => run.markIdle());
  }

  async signal(runId: string, signal: RunSignal): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`run ${runId} is not running`);
    this.resetIdle(run);
    run.queue.push(signal);
    run.wake?.();
    run.wake = null;
  }

  /** Resolves when the run is waiting for a signal or has finished. */
  async settled(runId: string): Promise<void> {
    await this.runs.get(runId)?.idle;
  }

  result(runId: string): Promise<RunResult> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`run ${runId} is not running`);
    return run.result;
  }

  private resetIdle(run: InlineRun) {
    run.idle = new Promise<void>((resolve) => (run.markIdle = resolve));
  }
}
