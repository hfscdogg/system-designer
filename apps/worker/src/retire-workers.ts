import { GoogleAuth } from "google-auth-library";
import type { Client } from "@temporalio/client";

/**
 * Old worker builds cost money while they stay always-on (min 1, CPU always allocated, ~$58/month each).
 * Each environment now runs one worker service, `sd-worker-<env>`, which the deploy updates in place. Services
 * named `sd-worker-<env>-sha-…` are builds from before that (one service per build, workflows PINNED to it).
 * The hourly reconcile job calls `retireOldWorkers` to clean those up:
 *
 *  - the current (or ramping) Temporal version is never touched;
 *  - a build Temporal reports DRAINED or INACTIVE (no open workflow needs it) is deleted;
 *  - any other old build is parked: min instances 0 and CPU only during requests, so it bills nothing.
 *    Workflows still pinned to it wait (they do not fail) until it is unparked or they expire.
 *  - a service labelled `sd-keep=true` is left alone (an operator unparked it for an old conversation).
 *
 * When Temporal can't be asked, a build is parked, never deleted.
 */
export interface WorkerService {
  /** Cloud Run service name, e.g. sd-worker-prod-sha-0123456789ab. */
  name: string;
  /** Temporal build id, from the sd-build label. */
  build: string | null;
  /** min instances > 0 with CPU always allocated: billed all day. */
  alwaysOn: boolean;
  /** Labelled sd-keep=true: leave it as the operator set it. */
  keep: boolean;
}

export interface WorkerServices {
  list(env: string): Promise<WorkerService[]>;
  park(name: string): Promise<void>;
  remove(name: string): Promise<void>;
}

export type VersionStatus = "CURRENT" | "RAMPING" | "DRAINING" | "DRAINED" | "INACTIVE" | "UNKNOWN";

export interface WorkerVersions {
  status(build: string): Promise<VersionStatus>;
}

export interface RetireResult {
  parked: string[];
  deleted: string[];
  kept: Array<{ name: string; reason: string }>;
  failed: Array<{ name: string; error: string }>;
}

/** The one worker service an environment runs; the deploy owns it. */
export function workerServiceName(env: string): string {
  return `sd-worker-${env}`;
}

export async function retireOldWorkers(env: string, services: WorkerServices, versions: WorkerVersions): Promise<RetireResult> {
  const result: RetireResult = { parked: [], deleted: [], kept: [], failed: [] };
  for (const svc of await services.list(env)) {
    if (svc.name === workerServiceName(env)) continue;
    if (svc.keep) {
      result.kept.push({ name: svc.name, reason: "sd-keep" });
      continue;
    }
    try {
      const status = svc.build ? await versions.status(svc.build).catch(() => "UNKNOWN" as const) : "UNKNOWN";
      if (status === "CURRENT" || status === "RAMPING") {
        result.kept.push({ name: svc.name, reason: status.toLowerCase() });
      } else if (status === "DRAINED" || status === "INACTIVE") {
        await services.remove(svc.name);
        result.deleted.push(svc.name);
      } else if (svc.alwaysOn) {
        await services.park(svc.name);
        result.parked.push(svc.name);
      } else {
        result.kept.push({ name: svc.name, reason: `parked, ${status.toLowerCase()}` });
      }
    } catch (err) {
      result.failed.push({ name: svc.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

const RUN_API = "https://run.googleapis.com/v2";

interface RunService {
  name: string;
  labels?: Record<string, string>;
  scaling?: { minInstanceCount?: number };
  template?: {
    scaling?: { minInstanceCount?: number };
    containers?: Array<{ resources?: { cpuIdle?: boolean } }>;
  };
}

/** Cloud Run Admin API v2. Unset fields are defaults: no minInstanceCount is 0, no cpuIdle is CPU always allocated. */
/** `project` defaults to the one the credentials belong to (the metadata server on Cloud Run). */
export function cloudRunWorkerServices(cfg: { project?: string; region: string; auth?: GoogleAuth; fetch?: typeof fetch; timeoutMs?: number }): WorkerServices {
  const doFetch = cfg.fetch ?? fetch;
  const auth = cfg.auth ?? new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  let parent = "";

  async function call<T>(method: "GET" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    if (!parent) parent = `projects/${cfg.project ?? (await auth.getProjectId())}/locations/${cfg.region}`;
    path = path.replace("{parent}", parent);
    const res = await doFetch(`${RUN_API}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${await auth.getAccessToken()}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 30_000),
    });
    if (!res.ok) throw new Error(`Cloud Run ${method} ${path.replace(`${parent}/`, "")} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }

  return {
    async list(env) {
      const out: WorkerService[] = [];
      let pageToken = "";
      do {
        const page = await call<{ services?: RunService[]; nextPageToken?: string }>(
          "GET",
          `{parent}/services?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
        );
        for (const s of page.services ?? []) {
          if (s.labels?.["sd-role"] !== "worker" || s.labels?.["sd-env"] !== env) continue;
          const min = (s.template?.scaling?.minInstanceCount ?? 0) + (s.scaling?.minInstanceCount ?? 0);
          const cpuAlways = !(s.template?.containers ?? []).every((c) => c.resources?.cpuIdle === true);
          out.push({ name: s.name.split("/").pop()!, build: s.labels["sd-build"] ?? null, alwaysOn: min > 0 && cpuAlways, keep: s.labels["sd-keep"] === "true" });
        }
        pageToken = page.nextPageToken ?? "";
      } while (pageToken);
      return out;
    },
    async park(name) {
      // Same change as `gcloud run services update <svc> --min-instances 0 --cpu-throttling`.
      const svc = await call<RunService>("GET", `{parent}/services/${name}`);
      if (svc.scaling?.minInstanceCount) svc.scaling.minInstanceCount = 0;
      svc.template = { ...svc.template, scaling: { ...svc.template?.scaling, minInstanceCount: 0 } };
      for (const c of svc.template.containers ?? []) c.resources = { ...c.resources, cpuIdle: true };
      await call("PATCH", `{parent}/services/${name}`, svc);
    },
    async remove(name) {
      await call("DELETE", `{parent}/services/${name}`);
    },
  };
}

// temporal.api.enums.v1.WorkerDeploymentVersionStatus
const STATUS_NAMES: Partial<Record<number, VersionStatus>> = { 1: "INACTIVE", 2: "CURRENT", 3: "RAMPING", 4: "DRAINING", 5: "DRAINED" };

/** A build's status in the environment's Temporal worker deployment (system-designer-<env>). */
export function temporalWorkerVersions(client: Client, deploymentName: string): WorkerVersions {
  return {
    async status(build) {
      const res = await client.workflowService.describeWorkerDeploymentVersion({
        namespace: client.options.namespace,
        deploymentVersion: { deploymentName, buildId: build },
      });
      return STATUS_NAMES[res.workerDeploymentVersionInfo?.status ?? 0] ?? "UNKNOWN";
    },
  };
}
