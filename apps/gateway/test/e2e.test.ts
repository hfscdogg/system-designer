import { beforeEach, describe, expect, it } from "vitest";
import { FakeChannelAdapter, type View } from "@sd/channels";
import type { ClarificationInterpreter, ScopeExtractor } from "@sd/llm";
import { createActivities, InlineWorkflows } from "@sd/worker";
import { completeExtraction, noPatch } from "../../../packages/core/test/fixtures.ts";
import { testStore } from "../../../packages/store/test/helpers.ts";
import { handleGoogleChat, type GatewayDeps } from "../src/handler.ts";

const SPACE = "spaces/A";
const THREAD = "spaces/A/threads/T";
let seq = 0;

function chatMessage(text: string, opts: { user?: string; thread?: string; space?: string; dm?: boolean; id?: string } = {}) {
  const space = opts.space ?? SPACE;
  return {
    type: "MESSAGE",
    eventTime: "2026-10-05T12:00:00Z",
    space: { name: space, spaceType: opts.dm ? "DIRECT_MESSAGE" : "SPACE" },
    message: {
      name: opts.id ?? `${space}/messages/m${++seq}`,
      text,
      argumentText: text,
      createTime: "2026-10-05T12:00:00Z",
      sender: { name: opts.user ?? "users/zack", displayName: "Someone", type: "HUMAN" },
      thread: { name: opts.thread ?? THREAD },
    },
  };
}

function click(receiptId: string, scopeHash: string, user = "users/zack", thread = THREAD) {
  return {
    type: "CARD_CLICKED",
    eventTime: `2026-10-05T12:0${++seq % 10}:00Z`,
    space: { name: SPACE, spaceType: "SPACE" },
    message: { name: `${SPACE}/messages/app-x`, thread: { name: thread } },
    user: { name: user, type: "HUMAN" },
    common: { invokedFunction: "approve_scope", parameters: { receipt_id: receiptId, scope_hash: scopeHash } },
  };
}

async function setup(extractions: unknown[] = [], patches: unknown[] = []) {
  const { store, db } = await testStore();
  const chat = new FakeChannelAdapter();
  const extractor: ScopeExtractor = { extract: async () => ({ raw: extractions.shift(), model: "fake-model" }) };
  const interpreter: ClarificationInterpreter = { interpret: async () => ({ raw: patches.shift(), model: "fake-model" }) };
  const workflows = new InlineWorkflows(createActivities({ store, adapters: { google_chat: chat }, extractor, interpreter }));
  const deps: GatewayDeps = { store, workflows, verifyGoogleChat: async (h) => h === "Bearer good" };
  const send = async (event: unknown, authorization = "Bearer good") => {
    const res = await handleGoogleChat(deps, { authorization, body: new TextEncoder().encode(JSON.stringify(event)) });
    // Let any run touched by this event reach its next wait point.
    for (const r of await store.listRunsForPerson("zack", 20)) await workflows.settled(r.id);
    return res;
  };
  const receipts = () => chat.list().map((m) => m.view).filter((v): v is Extract<View, { kind: "receipt" }> => v.kind === "receipt");
  const statusCard = () => chat.list().find((m) => m.view.kind === "status")?.view as Extract<View, { kind: "status" }> | undefined;
  const texts = () => chat.list().map((m) => m.view).filter((v): v is Extract<View, { kind: "text" }> => v.kind === "text").map((v) => v.text);
  return { store, db, chat, workflows, send, receipts, statusCard, texts };
}

beforeEach(() => {
  seq = 0;
});

describe("Google Chat → scope approval vertical slice", () => {
  it("captures, clarifies, publishes receipts verbatim and approves via the button", async () => {
    const partial = completeExtraction({ budget: { status: "not_provided", amount_usd: null }, target_installation_date: null });
    const t = await setup([partial], [{ ...noPatch, budget: { status: "unknown", amount_usd: null }, target_installation_date: "2026-12-01" }]);

    expect(await t.send(chatMessage("Smith family wants their old alarm modernized…"))).toEqual({ status: 200, body: {} });
    let r = t.receipts();
    expect(r).toHaveLength(1);
    expect(r[0]!.status).toBe("NEEDS_CLARIFICATION");
    expect(r[0]!.approve).toBeNull();
    expect(r[0]!.lines.some((l) => l.includes("budget expectation"))).toBe(true);
    expect(t.statusCard()?.steps.map((s) => s.state)).toEqual(["done", "done", "active", "pending", "pending", "pending", "pending"]);

    await t.send(chatMessage("Budget unknown, install Dec 1 2026"));
    r = t.receipts();
    expect(r).toHaveLength(2);
    const v2 = r[1]!;
    expect(v2.status).toBe("AWAITING_APPROVAL");
    expect(v2.lines).toContain("Target install: 2026-12-01");
    expect(v2.lines.at(-1)).toBe(`To approve: Approve scope ${v2.receiptId}`);

    const res = await t.send(click(v2.approve!.receiptId, v2.approve!.scopeHash));
    expect(res.body).toEqual({ text: `✅ Scope ${v2.receiptId} approved by Zack Reichert.` });
    const runs = await t.store.listRunsForPerson("zack");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.state).toBe("SCOPE_APPROVED");
    expect(await t.workflows.result(runs[0]!.id)).toMatchObject({ state: "SCOPE_APPROVED", receiptId: v2.receiptId });
    expect(t.statusCard()?.steps.slice(0, 4).map((s) => s.state)).toEqual(["done", "done", "done", "done"]);

    const events = (await t.store.listEvents(runs[0]!.id)).map((e) => e.type);
    expect(events).toEqual(
      expect.arrayContaining(["run_started", "scope_extracted", "receipt_published", "clarification_applied", "scope_approved"]),
    );
    // Exactly one status card, edited in place.
    expect(t.chat.list().filter((m) => m.view.kind === "status")).toHaveLength(1);
  });

  it("accepts the text approval form", async () => {
    const t = await setup([completeExtraction()]);
    await t.send(chatMessage("Smith security upgrade"));
    const [receipt] = t.receipts();
    const res = await t.send(chatMessage(`Approve scope ${receipt!.receiptId}`));
    expect(res.body).toMatchObject({ text: expect.stringContaining("approved") });
    expect((await t.store.listRunsForPerson("zack"))[0]!.state).toBe("SCOPE_APPROVED");
  });

  it("ignores a replayed provider message: one run, one receipt", async () => {
    const t = await setup([completeExtraction(), completeExtraction()]);
    const msg = chatMessage("Smith security upgrade", { id: "spaces/A/messages/dup" });
    await t.send(msg);
    await t.send(msg);
    expect(await t.store.listRunsForPerson("zack")).toHaveLength(1);
    expect(t.receipts()).toHaveLength(1);
  });

  it("rejects requests without a valid Google token", async () => {
    const t = await setup();
    expect((await t.send(chatMessage("hi"), "Bearer forged")).status).toBe(401);
    expect((await t.send(chatMessage("hi"), "")).status).toBe(401);
  });

  it("refuses unknown people and non-allowed spaces, but allows DMs with known people", async () => {
    const t = await setup([completeExtraction()]);
    expect((await t.send(chatMessage("hi", { user: "users/stranger" }))).body).toMatchObject({ text: expect.stringContaining("not set up") });
    expect((await t.send(chatMessage("hi", { space: "spaces/CUSTOMER" }))).body).toMatchObject({ text: expect.stringContaining("isn't approved") });
    expect(await t.store.listRunsForPerson("zack")).toHaveLength(0);
    await t.send(chatMessage("Smith security upgrade", { space: "spaces/DM-ZACK", dm: true, thread: "spaces/DM-ZACK/threads/x" }));
    const runs = await t.store.listRunsForPerson("zack");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.thread_id).toBe("spaces/DM-ZACK");
  });

  it("only the requester can approve, only from the run's thread, only the latest receipt", async () => {
    const t = await setup(
      [completeExtraction()],
      [{ ...noPatch, budget: { status: "known", amount_usd: 50000 } }],
    );
    await t.send(chatMessage("Smith security upgrade"));
    const v1 = t.receipts()[0]!;
    expect((await t.send(click(v1.receiptId, v1.approve!.scopeHash, "users/henry"))).body).toMatchObject({ text: expect.stringContaining("only the requester") });
    expect((await t.send(click(v1.receiptId, v1.approve!.scopeHash, "users/zack", "spaces/A/threads/OTHER"))).body).toMatchObject({ text: expect.stringContaining("can't accept") });

    await t.send(chatMessage("Budget is $50k"));
    const v2 = t.receipts()[1]!;
    expect(v2.lines).toContain("Budget: $50,000");
    expect((await t.send(click(v1.receiptId, v1.approve!.scopeHash))).body).toMatchObject({ text: expect.stringContaining("not the latest receipt") });
    expect((await t.send(click(v2.receiptId, "sha256:forged"))).body).toMatchObject({ text: expect.stringContaining("scope hash") });
    expect((await t.store.listRunsForPerson("zack"))[0]!.state).toBe("AWAITING_SCOPE_APPROVAL");
    expect((await t.send(click(v2.receiptId, v2.approve!.scopeHash))).body).toMatchObject({ text: expect.stringContaining("approved") });
    expect((await t.send(click(v2.receiptId, v2.approve!.scopeHash))).body).toMatchObject({ text: expect.stringContaining("already approved") });
  });

  it("a session reset closes the run and its receipt can no longer be approved", async () => {
    const t = await setup([completeExtraction()]);
    await t.send(chatMessage("Smith security upgrade"));
    const v1 = t.receipts()[0]!;
    expect((await t.send(chatMessage("reset"))).body).toMatchObject({ text: expect.stringContaining("Cleared") });
    const [run] = await t.store.listRunsForPerson("zack");
    expect(run!.state).toBe("STALE");
    expect(await t.workflows.result(run!.id)).toMatchObject({ state: "STALE" });
    expect((await t.send(click(v1.receiptId, v1.approve!.scopeHash))).body).toMatchObject({ text: expect.stringContaining("can't accept") });
  });

  it("blocks the run when the model authors authority fields, and says nothing was sent", async () => {
    const t = await setup([{ ...completeExtraction(), approved_by: "zack" }, { ...completeExtraction(), route: "x" }]);
    await t.send(chatMessage("Smith security upgrade"));
    const [run] = await t.store.listRunsForPerson("zack");
    expect(run!.state).toBe("BLOCKED");
    expect(t.receipts()).toHaveLength(0);
    expect(t.texts().at(-1)).toContain("Nothing was sent anywhere");
    expect(t.statusCard()?.steps[1]!.state).toBe("failed");
  });

  it("does not let another person's message clarify someone else's open request", async () => {
    const t = await setup([completeExtraction()]);
    await t.send(chatMessage("Smith security upgrade"));
    const res = await t.send(chatMessage("budget is $1", { user: "users/henry" }));
    expect(res.body).toMatchObject({ text: expect.stringContaining("someone else") });
    expect(t.receipts()).toHaveLength(1);
  });

  it("tells the requester when a clarification cannot be mapped", async () => {
    const t = await setup([completeExtraction()], [{ ...noPatch, unmapped: true }]);
    await t.send(chatMessage("Smith security upgrade"));
    await t.send(chatMessage("what's for lunch"));
    expect(t.texts().at(-1)).toContain("couldn't map");
    expect(t.receipts()).toHaveLength(1);
  });

  it("answers help and status without starting a run", async () => {
    const t = await setup();
    expect((await t.send(chatMessage("help"))).body).toMatchObject({ text: expect.stringContaining("scope receipt") });
    expect((await t.send(chatMessage("status"))).body).toEqual({ text: "You have no proposal runs yet." });
    expect(await t.store.listRunsForPerson("zack")).toHaveLength(0);
  });
});
