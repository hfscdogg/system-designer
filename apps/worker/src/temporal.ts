import { Client, Connection, WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from "@temporalio/client";
import type { RunSignal } from "@sd/core";
import { WorkflowClosedError, type WorkflowPort } from "./port.ts";

export const TASK_QUEUE = "proposal-runs";

/** Staging and production share a Temporal namespace but never a task queue. */
export function taskQueue(): string {
  return process.env.TEMPORAL_TASK_QUEUE ?? TASK_QUEUE;
}

export interface TemporalConfig {
  address: string;
  namespace: string;
  apiKey?: string;
}

export async function temporalClient(cfg: TemporalConfig): Promise<Client> {
  const connection = await Connection.connect({
    address: cfg.address,
    tls: cfg.apiKey ? true : undefined,
    apiKey: cfg.apiKey,
  });
  return new Client({ connection, namespace: cfg.namespace });
}

export class TemporalWorkflows implements WorkflowPort {
  private readonly client: Client;
  private readonly queue: string;

  constructor(client: Client, queue: string = taskQueue()) {
    this.client = client;
    this.queue = queue;
  }

  async start(runId: string): Promise<void> {
    try {
      await this.client.workflow.start("proposalRun", {
        workflowId: runId,
        taskQueue: this.queue,
        args: [{ runId }],
        workflowIdReusePolicy: "REJECT_DUPLICATE",
      });
    } catch (err) {
      if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
    }
  }

  async startRetainer(runId: string, tap: string): Promise<void> {
    try {
      await this.client.workflow.start("retainerRequest", {
        workflowId: `${runId}:retainer`,
        taskQueue: this.queue,
        args: [{ runId, tap }],
        // A second tap re-posts the recorded opportunity; a failed attempt can run again.
        workflowIdReusePolicy: "ALLOW_DUPLICATE",
      });
    } catch (err) {
      if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
    }
  }

  async isRunning(runId: string): Promise<boolean> {
    try {
      return (await this.client.workflow.getHandle(runId).describe()).status.name === "RUNNING";
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) return false;
      throw err;
    }
  }

  async signal(runId: string, signal: RunSignal): Promise<void> {
    try {
      await this.client.workflow.getHandle(runId).signal("run", signal);
    } catch (err) {
      // Temporal reports a closed workflow as "not found" for signals.
      if (err instanceof WorkflowNotFoundError) throw new WorkflowClosedError(`workflow ${runId} is not running`);
      throw err;
    }
  }
}
