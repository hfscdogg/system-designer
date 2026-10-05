import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { anthropicScopeExtractor, LlmOutputError } from "../src/index.ts";

function fakeClient(response: Record<string, unknown>, seen: unknown[] = []) {
  return { messages: { parse: async (req: unknown) => (seen.push(req), response) } } as unknown as Anthropic;
}

describe("anthropicScopeExtractor", () => {
  it("sends the message as delimited data with a structured output format", async () => {
    const seen: any[] = [];
    const extractor = anthropicScopeExtractor({ model: "test-model", client: fakeClient({ stop_reason: "end_turn", parsed_output: { client: "X" } }, seen) });
    const out = await extractor.extract({ text: "Smith job", attachmentNames: ["plan.pdf"] });
    expect(out).toEqual({ raw: { client: "X" }, model: "test-model" });
    expect(seen[0].model).toBe("test-model");
    expect(seen[0].messages[0].content).toContain("<salesperson_message>\nSmith job\n</salesperson_message>");
    expect(seen[0].messages[0].content).toContain("plan.pdf");
    expect(seen[0].output_config.format).toBeDefined();
    expect(seen[0].tool_choice).toBeUndefined();
  });

  it("fails loudly on refusal, truncation or unparseable output", async () => {
    for (const r of [{ stop_reason: "refusal" }, { stop_reason: "max_tokens" }, { stop_reason: "end_turn", parsed_output: null }]) {
      const extractor = anthropicScopeExtractor({ model: "m", client: fakeClient(r) });
      await expect(extractor.extract({ text: "x", attachmentNames: [] })).rejects.toBeInstanceOf(LlmOutputError);
    }
  });
});
