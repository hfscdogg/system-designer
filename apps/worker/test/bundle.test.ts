import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bundleWorkflowCode } from "@temporalio/worker";

describe("workflow bundle", () => {
  it("bundles the workflow code without Node-only dependencies", async () => {
    const { code } = await bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL("../src/workflows/index.ts", import.meta.url)),
      logger: { info() {}, warn() {}, error: console.error, debug() {}, trace() {}, log() {} } as never,
    });
    expect(code).toContain("proposalRun");
    expect(code).not.toMatch(/require\(["']node:crypto["']\)/);
  }, 120_000);
});
