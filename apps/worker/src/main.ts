import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { loadPatterns } from "@sd/build";
import { httpDToolsReader } from "@sd/dtools";
import { anthropicClarificationInterpreter, anthropicScopeExtractor } from "@sd/llm";
import { fetchProductImage, htmlToPdf } from "@sd/render";
import { createActivities } from "./activities.ts";
import { productionAdapters, productionStore, releaseId, requireEnv, temporalSettings } from "./config.ts";
import { TASK_QUEUE } from "./temporal.ts";

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
    taskQueue: TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL("./workflows/index.ts", import.meta.url)),
    activities: createActivities({
      store,
      adapters: productionAdapters(),
      extractor: anthropicScopeExtractor({ model }),
      interpreter: anthropicClarificationInterpreter({ model }),
      // Read-only D-Tools access; use a key scoped to catalog reads where D-Tools allows it.
      dtools: httpDToolsReader({ apiKey: requireEnv("DTOOLS_API_KEY"), basicAuth: requireEnv("DTOOLS_BASIC_AUTH") }),
      patterns: await loadPatterns(),
      renderPdf: (html) => htmlToPdf(html),
      fetchImage: (url) => fetchProductImage(url),
    }),
    workerDeploymentOptions: {
      version: { deploymentName: "system-designer", buildId: releaseId() },
      useWorkerVersioning: true,
      defaultVersioningBehavior: "PINNED",
    },
  });
  console.log(JSON.stringify({ msg: "worker started", release: releaseId(), taskQueue: TASK_QUEUE }));
  await worker.run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
