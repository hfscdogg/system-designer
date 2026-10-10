import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { loadPatterns } from "@sd/build";
import { httpDToolsReader, httpDToolsWriter } from "@sd/dtools";
import { anthropicClarificationInterpreter, anthropicScopeExtractor } from "@sd/llm";
import { fetchProductImage, htmlToPdf } from "@sd/render";
import { createActivities } from "./activities.ts";
import { productionAdapters, productionStore, releaseId, requireEnv, temporalSettings, workerBuildId } from "./config.ts";
import { taskQueue } from "./temporal.ts";

/**
 * Temporal worker. Each deploy is a new deployment version; workflows are pinned
 * to the version they started on, so in-flight runs never change code mid-run (PRD §17).
 */
async function main() {
  const t = temporalSettings();
  const connection = await NativeConnection.connect({ address: t.address, tls: t.apiKey ? true : undefined, apiKey: t.apiKey });
  const { store } = productionStore();
  const model = requireEnv("LLM_MODEL");

  const worker = await Worker.create({
    connection,
    namespace: t.namespace,
    taskQueue: taskQueue(),
    workflowsPath: fileURLToPath(new URL("./workflows/index.ts", import.meta.url)),
    activities: createActivities({
      store,
      adapters: productionAdapters(),
      extractor: anthropicScopeExtractor({ model }),
      interpreter: anthropicClarificationInterpreter({ model }),
      // Read-only D-Tools access; use a key scoped to catalog reads where D-Tools allows it.
      dtools: httpDToolsReader({ apiKey: requireEnv("DTOOLS_API_KEY"), basicAuth: requireEnv("DTOOLS_BASIC_AUTH") }),
      // The one approved write, off unless SD_DTOOLS_RETAINER=on (Henry, 2026-10-10).
      dtoolsWriter: process.env.SD_DTOOLS_RETAINER === "on" ? httpDToolsWriter({ apiKey: requireEnv("DTOOLS_API_KEY"), basicAuth: requireEnv("DTOOLS_BASIC_AUTH") }) : null,
      patterns: await loadPatterns(),
      renderPdf: (html) => htmlToPdf(html),
      fetchImage: (url) => fetchProductImage(url),
    }),
    workerDeploymentOptions: {
      version: { deploymentName: process.env.WORKER_DEPLOYMENT_NAME ?? "system-designer", buildId: workerBuildId() },
      useWorkerVersioning: true,
      defaultVersioningBehavior: "PINNED",
    },
  });
  // Cloud Run needs an HTTP port; /health reports what this instance runs and whether it polls.
  // (Not /healthz: Cloud Run reserves paths ending in "z" and answers them with 404.)
  const health = createServer((req, res) => {
    const state = worker.getState();
    const ok = req.url === "/health" && state === "RUNNING";
    res
      .writeHead(req.url === "/health" ? (ok ? 200 : 503) : 404, { "content-type": "application/json" })
      .end(JSON.stringify({ ok, state, release: releaseId(), buildId: workerBuildId(), taskQueue: taskQueue() }));
  });
  health.listen(Number(process.env.PORT ?? 8080));
  console.log(JSON.stringify({ msg: "worker started", release: releaseId(), buildId: workerBuildId(), taskQueue: taskQueue() }));
  await worker.run();
  health.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
