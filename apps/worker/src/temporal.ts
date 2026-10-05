import { Client, Connection, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import type { RunSignal } from "@sd/core";
import type { WorkflowPort } from "./port.ts";

export const TASK_QUEUE = "proposal-runs";

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

  constructor(client: Client) {
    this.client = client;
  }

  async start(runId: string): Promise<void> {
    try {
      await this.client.workflow.start("proposalRun", {
        workflowId: runId,
        taskQueue: TASK_QUEUE,
        args: [{ runId }],
        workflowIdReusePolicy: "REJECT_DUPLICATE",
      });
    } catch (err) {
      if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
    }
  }

  async signal(runId: string, signal: RunSignal): Promise<void> {
    await this.client.workflow.getHandle(runId).signal("run", signal);
  }
}
