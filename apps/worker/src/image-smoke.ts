// Runs inside the production image (CI): proves Chromium, fonts and the workflow bundle work there.
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
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

// Every package the services and admin jobs import must be installed in the image (a devDependency isn't).
const missing: string[] = [];
const appsDir = fileURLToPath(new URL("../../", import.meta.url));
for (const app of ["gateway", "worker"]) {
  const src = join(appsDir, app, "src");
  for (const file of (await readdir(src, { recursive: true })).filter((f) => f.endsWith(".ts")).map((f) => join(src, f))) {
    const text = await readFile(file, "utf8");
    const specs = [...text.matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^;]*?\sfrom\s+)?"([^"]+)"/gm), ...text.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]!);
    for (const spec of specs) {
      if (spec.startsWith(".") || spec.startsWith("node:")) continue;
      const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
      if (!installedFrom(dirname(file), pkg)) missing.push(`${pkg} (imported by ${relative(appsDir, file)})`);
    }
  }
}
if (missing.length) throw new Error(`packages missing from the image: ${[...new Set(missing)].join(", ")}`);
console.log(JSON.stringify({ ok: true, pdfBytes: pdf.length, bundleBytes: code.length }));

function installedFrom(dir: string, pkg: string): boolean {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, "node_modules", pkg, "package.json"))) return true;
    if (dirname(d) === d) return false;
  }
}
