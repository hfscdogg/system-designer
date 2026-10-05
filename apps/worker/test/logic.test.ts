import { describe, expect, it } from "vitest";
import type { RunSignal } from "@sd/core";
import { runProposal, type RunActivities } from "../src/workflows/logic.ts";
import { completeExtraction } from "../../../packages/core/test/fixtures.ts";

function fakeActs(overrides: Partial<RunActivities> = {}): RunActivities & { calls: string[] } {
  const calls: string[] = [];
  const acts: RunActivities = {
    reportProgress: async ({ phase }) => void calls.push(`progress:${phase}`),
    extractScope: async () => ({ ok: true, extraction: completeExtraction(), notes: [] }),
    publishReceipt: async ({ version }) => (calls.push(`publish:${version}`), { ok: true, receipt: { receiptId: `R-X-${version}`, status: "AWAITING_APPROVAL", scopeHash: `h${version}` } }),
    interpretClarification: async () => ({ ok: true, extraction: completeExtraction(), notes: [] }),
    confirmApproval: async ({ approvalId }) => void calls.push(`confirm:${approvalId}`),
    findCommittedApproval: async () => null,
    notify: async ({ text, key }) => void calls.push(`notify:${key}:${text}`),
    markOutcome: async ({ state }) => void calls.push(`outcome:${state}`),
    ...overrides,
  };
  return Object.assign(acts, { calls });
}

const scripted = (signals: Array<RunSignal | null>) => async () => {
  if (!signals.length) throw new Error("test ran out of signals");
  return signals.shift()!;
};

describe("runProposal", () => {
  it("reconciles an approval whose signal was lost", async () => {
    const acts = fakeActs({ findCommittedApproval: async () => ({ approvalId: "a1", receiptId: "R-X-1", scopeHash: "h1" }) });
    const result = await runProposal({ runId: "run_1" }, { acts, nextSignal: scripted([null]) });
    expect(result).toEqual({ state: "SCOPE_APPROVED", approvalId: "a1", receiptId: "R-X-1" });
    expect(acts.calls).toContain("confirm:a1");
  });

  it("rejects an approval for a superseded receipt and keeps waiting", async () => {
    const acts = fakeActs();
    const result = await runProposal(
      { runId: "run_1" },
      {
        acts,
        nextSignal: scripted([
          { type: "clarification", intakeId: "in_2" },
          { type: "approved", receiptId: "R-X-1", scopeHash: "h1", approvalId: "a-old" },
          { type: "approved", receiptId: "R-X-2", scopeHash: "h2", approvalId: "a-new" },
        ]),
      },
    );
    expect(result).toMatchObject({ state: "SCOPE_APPROVED", approvalId: "a-new" });
    expect(acts.calls.filter((c) => c.startsWith("notify:"))).toEqual(["notify:run_1:notice:1:I can't accept that approval: approval names R-X-1, latest receipt is R-X-2."]);
  });

  it("uses distinct, deterministic notice keys", async () => {
    const acts = fakeActs({ interpretClarification: async () => ({ ok: false, reason: "nope" }) });
    await runProposal(
      { runId: "run_1" },
      { acts, nextSignal: scripted([{ type: "clarification", intakeId: "a" }, { type: "clarification", intakeId: "b" }, { type: "invalidate", reason: "reset" }]) },
    );
    expect(acts.calls.filter((c) => c.startsWith("notify:"))).toEqual(["notify:run_1:notice:1:nope", "notify:run_1:notice:2:nope"]);
  });

  it("confirms the committed approval when a clarification races it", async () => {
    let n = 0;
    const acts = fakeActs({
      publishReceipt: async ({ version }) => (++n === 1 ? { ok: true, receipt: { receiptId: `R-X-${version}`, status: "AWAITING_APPROVAL", scopeHash: "h1" } } : { ok: false, runState: "SCOPE_APPROVED" }),
      findCommittedApproval: async () => ({ approvalId: "a1", receiptId: "R-X-1", scopeHash: "h1" }),
    });
    const result = await runProposal({ runId: "run_1" }, { acts, nextSignal: scripted([{ type: "clarification", intakeId: "in_2" }]) });
    expect(result).toMatchObject({ state: "SCOPE_APPROVED", receiptId: "R-X-1" });
    expect(acts.calls.some((c) => c.includes("arrived after the scope was approved"))).toBe(true);
  });

  it("blocks when extraction fails and expires after long silence", async () => {
    const blocked = fakeActs({ extractScope: async () => ({ ok: false, reason: "bad" }) });
    expect(await runProposal({ runId: "r" }, { acts: blocked, nextSignal: scripted([]) })).toEqual({ state: "BLOCKED", reason: "bad" });
    const idle = fakeActs();
    const result = await runProposal({ runId: "r" }, { acts: idle, nextSignal: async () => null });
    expect(result).toEqual({ state: "STALE", reason: "no reply for 14 days" });
    expect(idle.calls).toContain("outcome:STALE");
  });
});
