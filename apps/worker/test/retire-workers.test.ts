import { describe, expect, it } from "vitest";
import { cloudRunWorkerServices, retireOldWorkers, type VersionStatus, type WorkerService, type WorkerServices } from "../src/index.ts";

class FakeServices implements WorkerServices {
  parked: string[] = [];
  removed: string[] = [];
  private readonly services: WorkerService[];
  constructor(services: WorkerService[]) {
    this.services = services;
  }
  async list(_env: string) {
    return this.services;
  }
  async park(name: string) {
    this.parked.push(name);
  }
  async remove(name: string) {
    this.removed.push(name);
  }
}

const svc = (name: string, over: Partial<WorkerService> = {}): WorkerService => ({
  name,
  build: name.replace(/^sd-worker-prod-/, ""),
  alwaysOn: true,
  keep: false,
  ...over,
});

describe("retireOldWorkers", () => {
  it("deletes drained builds, parks the rest, and never touches the current worker", async () => {
    const statuses: Record<string, VersionStatus> = { "sha-cur": "CURRENT", "sha-old": "DRAINED", "sha-new": "INACTIVE", "sha-busy": "DRAINING" };
    const services = new FakeServices([
      svc("sd-worker-prod", { build: "sha-cur" }),
      svc("sd-worker-prod-sha-cur"),
      svc("sd-worker-prod-sha-old"),
      svc("sd-worker-prod-sha-new"),
      svc("sd-worker-prod-sha-busy"),
      svc("sd-worker-prod-sha-quiet", { alwaysOn: false }),
      svc("sd-worker-prod-sha-kept", { keep: true }),
    ]);
    const result = await retireOldWorkers("prod", services, { status: async (b) => statuses[b] ?? "DRAINING" });

    expect(services.removed).toEqual(["sd-worker-prod-sha-old", "sd-worker-prod-sha-new"]);
    expect(services.parked).toEqual(["sd-worker-prod-sha-busy"]);
    expect(result.kept).toEqual([
      { name: "sd-worker-prod-sha-cur", reason: "current" },
      { name: "sd-worker-prod-sha-quiet", reason: "parked, draining" },
      { name: "sd-worker-prod-sha-kept", reason: "sd-keep" },
    ]);
  });

  it("only parks when Temporal can't be asked, and reports per-service failures", async () => {
    const services = new FakeServices([svc("sd-worker-prod-sha-a"), svc("sd-worker-prod-sha-b"), svc("sd-worker-prod-sha-c", { build: null })]);
    services.park = async (name) => {
      if (name.endsWith("-b")) throw new Error("403");
      services.parked.push(name);
    };
    const result = await retireOldWorkers("prod", services, {
      status: async () => {
        throw new Error("temporal unreachable");
      },
    });
    expect(services.removed).toEqual([]);
    expect(result.parked).toEqual(["sd-worker-prod-sha-a", "sd-worker-prod-sha-c"]);
    expect(result.failed).toEqual([{ name: "sd-worker-prod-sha-b", error: "403" }]);
  });
});

describe("cloudRunWorkerServices", () => {
  const auth = { getAccessToken: async () => "tok" } as never;

  it("lists this environment's workers across pages and reads always-on from v2 defaults", async () => {
    const pages = [
      {
        services: [
          { name: "projects/p/locations/r/services/sd-worker-prod-sha-a", labels: { "sd-role": "worker", "sd-env": "prod", "sd-build": "sha-a" },
            template: { scaling: { minInstanceCount: 1 }, containers: [{ resources: {} }] } },
          { name: "projects/p/locations/r/services/sd-gateway-prod", labels: { "sd-role": "gateway", "sd-env": "prod" }, template: {} },
        ],
        nextPageToken: "next",
      },
      {
        services: [
          { name: "projects/p/locations/r/services/sd-worker-prod-sha-b", labels: { "sd-role": "worker", "sd-env": "prod", "sd-build": "sha-b", "sd-keep": "true" },
            template: { containers: [{ resources: { cpuIdle: true } }] } },
          { name: "projects/p/locations/r/services/sd-worker-staging", labels: { "sd-role": "worker", "sd-env": "staging" }, template: {} },
        ],
      },
    ];
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(pages[urls.length - 1]));
    }) as typeof fetch;
    const workers = await cloudRunWorkerServices({ project: "p", region: "r", auth, fetch: fetchFn }).list("prod");
    expect(workers).toEqual([
      { name: "sd-worker-prod-sha-a", build: "sha-a", alwaysOn: true, keep: false },
      { name: "sd-worker-prod-sha-b", build: "sha-b", alwaysOn: false, keep: true },
    ]);
    expect(urls[1]).toContain("pageToken=next");
  });

  it("parks by setting min 0 and CPU only during requests, keeping the rest of the service", async () => {
    const calls: Array<{ method: string; body?: string }> = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      calls.push({ method: init.method!, body: init.body as string | undefined });
      if (init.method === "GET")
        return new Response(JSON.stringify({ name: "x", labels: { a: "b" }, template: { scaling: { minInstanceCount: 1, maxInstanceCount: 2 }, containers: [{ image: "i", resources: { limits: { cpu: "1" } } }] } }));
      return new Response("{}");
    }) as typeof fetch;
    await cloudRunWorkerServices({ project: "p", region: "r", auth, fetch: fetchFn }).park("sd-worker-prod-sha-a");
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    expect(JSON.parse(calls[1]!.body!)).toEqual({
      name: "x",
      labels: { a: "b" },
      template: { scaling: { minInstanceCount: 0, maxInstanceCount: 2 }, containers: [{ image: "i", resources: { limits: { cpu: "1" }, cpuIdle: true } }] },
    });
  });
});
