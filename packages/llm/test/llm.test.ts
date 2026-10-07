import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { anthropicClient, anthropicScopeExtractor, googleIdentityTokenProvider, LlmOutputError } from "../src/index.ts";

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

describe("anthropicClient (Workload Identity Federation)", () => {
  const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJodHRwczovL2FjY291bnRzLmdvb2dsZS5jb20ifQ.sig";
  const env = {
    ANTHROPIC_FEDERATION_RULE_ID: "fdrl_test",
    ANTHROPIC_ORGANIZATION_ID: "00000000-0000-0000-0000-000000000000",
    ANTHROPIC_SERVICE_ACCOUNT_ID: "svac_test",
  };

  function fakeNetwork() {
    const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    const doFetch = (async (input: any, init: any = {}) => {
      const url = String(input instanceof Request ? input.url : input);
      const headers: Record<string, string> = {};
      new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((v, k) => (headers[k] = v));
      const raw = init.body ?? null;
      const body = typeof raw === "string" ? JSON.parse(raw) : raw;
      calls.push({ url, headers, body });
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
      if (url.startsWith("http://metadata.google.internal/")) return new Response(JWT, { status: 200 });
      if (url.endsWith("/v1/oauth/token")) return json({ access_token: "sk-ant-oat01-test", token_type: "Bearer", expires_in: 600 });
      if (url.endsWith("/v1/messages")) {
        return json({ id: "msg_1", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    return { calls, doFetch };
  }

  it("exchanges a fresh Google identity token and calls Claude with the minted token", async () => {
    const { calls, doFetch } = fakeNetwork();
    const client = anthropicClient(env, doFetch);
    await client.messages.create({ model: "m", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });

    const meta = calls.find((c) => c.url.startsWith("http://metadata.google.internal/"))!;
    expect(meta.url).toContain("audience=https%3A%2F%2Fapi.anthropic.com");
    expect(meta.url).toContain("format=full");
    expect(meta.headers["metadata-flavor"]).toBe("Google");

    const exchange = calls.find((c) => c.url.endsWith("/v1/oauth/token"))!;
    expect(exchange.body).toMatchObject({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: JWT,
      federation_rule_id: "fdrl_test",
      organization_id: env.ANTHROPIC_ORGANIZATION_ID,
      service_account_id: "svac_test",
    });
    const message = calls.find((c) => c.url.endsWith("/v1/messages"))!;
    expect(message.headers.authorization).toBe("Bearer sk-ant-oat01-test");
    expect(message.headers["x-api-key"]).toBeUndefined();
  });

  it("refuses to start when an API key would shadow federation", () => {
    expect(() => anthropicClient({ ...env, ANTHROPIC_API_KEY: "sk-ant-x" })).toThrow(/must not be set/);
    expect(() => anthropicClient({ ANTHROPIC_FEDERATION_RULE_ID: "fdrl_x" })).toThrow(/ANTHROPIC_ORGANIZATION_ID/);
  });

  it("rejects a metadata response that is not a JWT", async () => {
    const bad = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    await expect(googleIdentityTokenProvider(bad)()).rejects.toThrow(/JWT/);
    const down = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    await expect(googleIdentityTokenProvider(down)()).rejects.toThrow(/404/);
  });
});
