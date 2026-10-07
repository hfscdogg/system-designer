// Runs inside the production image (CI): proves Chromium, fonts and the workflow bundle work there.
import { fileURLToPath } from "node:url";
import { bundleWorkflowCode } from "@temporalio/worker";
import { htmlToPdf, loadBrand } from "@sd/render";

const brand = await loadBrand();
const pdf = await htmlToPdf(`<html><head><style>${brand.fontCss}</style></head><body><h1 style="font-family:Fraunces">Smoke</h1></body></html>`);
if (pdf.length < 1000) throw new Error(`PDF too small: ${pdf.length} bytes`);

const { code } = await bundleWorkflowCode({
  workflowsPath: fileURLToPath(new URL("./workflows/index.ts", import.meta.url)),
  logger: { info() {}, warn() {}, error: console.error, debug() {}, trace() {}, log() {} } as never,
});
if (!code.includes("proposalRun")) throw new Error("workflow bundle is missing proposalRun");

await import("../../gateway/src/handler.ts");
console.log(JSON.stringify({ ok: true, pdfBytes: pdf.length, bundleBytes: code.length }));
