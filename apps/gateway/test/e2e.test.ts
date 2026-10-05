import { beforeEach, describe, expect, it } from "vitest";
import { FakeChannelAdapter, type View } from "@sd/channels";
import type { ClarificationInterpreter, ScopeExtractor } from "@sd/llm";
import { createActivities, InlineWorkflows } from "@sd/worker";
import { completeExtraction, noPatch } from "../../../packages/core/test/fixtures.ts";
import { TEST_POLICY, testStore } from "../../../packages/store/test/helpers.ts";
import { recordedDToolsReader } from "@sd/dtools";
import type { PatternSpec } from "@sd/build";
import { CATALOG, testPattern } from "../../../packages/build/test/fixtures.ts";
import { htmlToPdf, preflightPdf } from "@sd/render";
import { sha256Hex } from "@sd/core";
import type { DToolsReader } from "@sd/dtools";

const PIXEL = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="), (ch) => ch.charCodeAt(0));
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

interface BuildOptions {
  catalog?: Record<string, unknown>;
  dtools?: DToolsReader & { calls: string[] };
  patterns?: PatternSpec[];
  policy?: boolean;
}

async function setup(extractions: unknown[] = [], patches: unknown[] = [], build: BuildOptions = {}) {
  const { store, db } = await testStore();
  if (build.policy !== false) await store.publishPolicy(TEST_POLICY, "henry", "test policy");
  const chat = new FakeChannelAdapter();
  const extractor: ScopeExtractor = { extract: async () => ({ raw: extractions.shift(), model: "fake-model" }) };
  const interpreter: ClarificationInterpreter = { interpret: async () => ({ raw: patches.shift(), model: "fake-model" }) };
  const dtools = build.dtools ?? recordedDToolsReader(build.catalog ?? CATALOG);
  const acts = createActivities({
    store,
    adapters: { google_chat: chat },
    extractor,
    interpreter,
    dtools,
    patterns: build.patterns ?? [testPattern()],
    renderPdf: (html) => htmlToPdf(html),
    // Only the panel has a reachable image; everything else must show IMAGE PENDING.
    fetchImage: async (url) => (url.includes("PANEL") ? { bytes: PIXEL, contentType: "image/png" } : null),
  });
  const workflows = new InlineWorkflows(acts);
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
  return { store, db, chat, workflows, send, receipts, statusCard, texts, dtools, acts };
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
    expect(t.statusCard()?.steps.map((s) => s.state)).toEqual(["done", "done", "active", "pending", "pending", "pending", "pending", "pending"]);

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
    expect(runs[0]!.state).toBe("READY_HELD");
    expect(await t.workflows.result(runs[0]!.id)).toMatchObject({ state: "READY_HELD", receiptId: v2.receiptId });
    expect(t.statusCard()?.steps.map((s) => s.state)).toEqual(Array(8).fill("done"));
    expect(t.statusCard()?.note).toBe("Held for internal review — not sent to the customer.");
    const summary = t.texts().find((x) => x.startsWith("Proposal validated"));
    expect(summary).toContain("Proposal validated for Smith Family.");
    expect(summary).toContain("Priced scope to date: $2,740.00");

    const events = (await t.store.listEvents(runs[0]!.id)).map((e) => e.type);
    expect(events).toEqual(
      expect.arrayContaining(["run_started", "scope_extracted", "receipt_published", "clarification_applied", "scope_approved", "build_acquired", "artifact_published", "held_handoff"]),
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
    expect((await t.store.listRunsForPerson("zack"))[0]!.state).toBe("READY_HELD");
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

  it("blocks the build when a D-Tools record is missing, and keeps the run for review", async () => {
    const catalog = { ...CATALOG };
    delete catalog[Object.keys(CATALOG)[0]!];
    const t = await setup([completeExtraction()], [], { catalog });
    await t.send(chatMessage("Smith security upgrade"));
    const [receipt] = t.receipts();
    await t.send(click(receipt!.receiptId, receipt!.approve!.scopeHash));
    const [run] = await t.store.listRunsForPerson("zack");
    expect(run!.state).toBe("BLOCKED");
    expect(t.texts().at(-1)).toContain("Nothing was sent to a customer or written to D-Tools");
    expect(t.statusCard()?.steps[5]!.state).toBe("failed");
  });

  it("blocks at validation when no commercial policy has been published", async () => {
    const t = await setup([completeExtraction()], [], { policy: false });
    await t.send(chatMessage("Smith security upgrade"));
    const [receipt] = t.receipts();
    await t.send(click(receipt!.receiptId, receipt!.approve!.scopeHash));
    const [run] = await t.store.listRunsForPerson("zack");
    expect(run!.state).toBe("BLOCKED");
    expect(t.texts().at(-1)).toContain("no commercial policy is configured");
  });

  it("blocks scopes with no approved architecture pattern and asks for Zack's review", async () => {
    const t = await setup([completeExtraction({ functional_systems: ["home theater"] })]);
    await t.send(chatMessage("Smith theater"));
    const [receipt] = t.receipts();
    await t.send(click(receipt!.receiptId, receipt!.approve!.scopeHash));
    expect(t.texts().at(-1)).toContain("Zack needs to review");
    expect(t.dtools.calls).toEqual([]);
  });

  it("reads each D-Tools record once to build and once to refresh, and builds once", async () => {
    const t = await setup([completeExtraction()]);
    await t.send(chatMessage("Smith security upgrade"));
    const [receipt] = t.receipts();
    await t.send(click(receipt!.receiptId, receipt!.approve!.scopeHash));
    await t.send(click(receipt!.receiptId, receipt!.approve!.scopeHash));
    const perRecord = Object.values(t.dtools.calls.reduce<Record<string, number>>((m, id) => ((m[id] = (m[id] ?? 0) + 1), m), {}));
    expect(new Set(perRecord)).toEqual(new Set([2]));
    const [run] = await t.store.listRunsForPerson("zack");
    const builds = await t.db.query(`SELECT 1 FROM builds WHERE run_id = $1`, [run!.id]);
    expect(builds.rows).toHaveLength(1);
    const customer = await t.store.readArtifact<Record<string, unknown>>(run!.id, "validate", "customer_view");
    expect(JSON.stringify(customer)).not.toMatch(/cost|margin/i);
  });

  it("replaying every build stage after success (lost activity results) changes nothing", async () => {
    const t = await setup([completeExtraction()]);
    await t.send(chatMessage("Smith security upgrade"));
    const [receipt] = t.receipts();
    await t.send(click(receipt!.receiptId, receipt!.approve!.scopeHash));
    const [run] = await t.store.listRunsForPerson("zack");
    const before = await t.db.query(`SELECT stage, name, sha256 FROM artifacts WHERE run_id = $1 ORDER BY stage, name`, [run!.id]);
    const messages = t.chat.list().length;
    for (const stage of ["prebuild", "admitCatalog", "compileSelection", "bindProposal", "validate"] as const) {
      expect(await t.acts.buildStage({ runId: run!.id, stage })).toMatchObject({ ok: true });
    }
    const after = await t.db.query(`SELECT stage, name, sha256 FROM artifacts WHERE run_id = $1 ORDER BY stage, name`, [run!.id]);
    expect(after.rows).toEqual(before.rows);
    expect((await t.store.getRun(run!.id)).state).toBe("READY_HELD");
    expect(t.chat.list()).toHaveLength(messages);
  });

  it("posts exactly one held PDF that independently passes preflight and matches the recorded hand-off", async () => {
    const t = await setup([completeExtraction()]);
    await t.send(chatMessage("Smith security upgrade"));
    const [receipt] = t.receipts();
    await t.send(click(receipt!.receiptId, receipt!.approve!.scopeHash));
    const [run] = await t.store.listRunsForPerson("zack");
    expect(run!.state).toBe("READY_HELD");
    expect(t.chat.files).toHaveLength(1);
    const posted = t.chat.files[0]!;
    expect(posted.thread).toEqual({ platform: "google_chat", spaceId: SPACE, threadId: THREAD });
    expect(posted.file.filename).toBe("Livewire-UNASSIGNED-conceptual-budget.pdf");
    expect(posted.file.text).toContain("not sent to the customer");

    const customer = (await t.store.readArtifact<any>(run!.id, "validate", "customer_view"))!;
    const independent = await preflightPdf(posted.file.bytes, { customer, runId: run!.id, sha256: sha256Hex(posted.file.bytes) });
    expect(independent.failures).toEqual([]);
    const handoff = await t.store.getHandoff(run!.id);
    expect(handoff).toEqual({ pdf_sha256: sha256Hex(posted.file.bytes), provider_message_id: posted.messageId });

    // The confidential report is stored but never posted.
    expect(await t.store.readArtifact(run!.id, "internal", "financial_report")).toMatchObject({ run_id: run!.id });
    const everything = JSON.stringify(t.chat.list());
    expect(everything).not.toMatch(/gross_margin|cost_cents|financial_report/);
    const manifest = await t.store.readArtifact<any>(run!.id, "packet", "manifest");
    expect(manifest).toMatchObject({ run_id: run!.id, pdf_sha256: handoff!.pdf_sha256, provider_message_id: posted.messageId, models: ["fake-model"] });
    expect(manifest.artifacts.map((a: any) => `${a.stage}/${a.name}`)).toEqual(expect.arrayContaining(["render/pdf", "preflight/result", "internal/financial_report", "validate/result"]));
  });

  it("stops for reconciliation when a D-Tools record changes before the PDF is made", async () => {
    const base = recordedDToolsReader(CATALOG);
    const seen = new Map<string, number>();
    const panelId = Object.keys(CATALOG)[0]!;
    const changing: DToolsReader & { calls: string[] } = {
      calls: base.calls,
      async getProduct(id) {
        seen.set(id, (seen.get(id) ?? 0) + 1);
        if (id === panelId && seen.get(id)! > 1) {
          return recordedDToolsReader({ [id]: { ...(CATALOG[id] as object), unitPrice: 999 } }).getProduct(id);
        }
        return base.getProduct(id);
      },
    };
    const t = await setup([completeExtraction()], [], { dtools: changing });
    await t.send(chatMessage("Smith security upgrade"));
    const [receipt] = t.receipts();
    await t.send(click(receipt!.receiptId, receipt!.approve!.scopeHash));
    const [run] = await t.store.listRunsForPerson("zack");
    expect(run!.state).toBe("RECONCILIATION_REQUIRED");
    expect(t.chat.files).toHaveLength(0);
    expect(t.texts().at(-1)).toContain("TestCo PANEL-1 changed in D-Tools");
    expect(await t.store.readBinaryArtifact(run!.id, "render", "pdf")).toBeNull();
  });

  it("handles Workspace add-on events end to end and wraps replies for them", async () => {
    const t = await setup([completeExtraction()]);
    const addon = (text: string, id: string) => ({
      commonEventObject: { hostApp: "CHAT" },
      chat: {
        user: { name: "users/zack", type: "HUMAN" },
        eventTime: "2026-10-05T12:00:00Z",
        messagePayload: { space: { name: SPACE, spaceType: "SPACE" }, message: { name: id, text, sender: { name: "users/zack", type: "HUMAN" }, thread: { name: THREAD } } },
      },
    });
    expect((await t.send(addon("help", `${SPACE}/messages/h1`))).body).toMatchObject({
      hostAppDataAction: { chatDataAction: { createMessageAction: { message: { text: expect.stringContaining("scope receipt") } } } },
    });
    await t.send(addon("Smith security upgrade", `${SPACE}/messages/a1`));
    const [receipt] = t.receipts();
    const res = await t.send({
      commonEventObject: { parameters: { action: "approve_scope", receipt_id: receipt!.receiptId, scope_hash: receipt!.approve!.scopeHash } },
      chat: { user: { name: "users/zack", type: "HUMAN" }, eventTime: "2026-10-05T12:02:00Z", buttonClickedPayload: { space: { name: SPACE, spaceType: "SPACE" }, message: { name: `${SPACE}/messages/app-x`, thread: { name: THREAD } } } },
    });
    expect(JSON.stringify(res.body)).toContain("approved by Zack Reichert");
    expect((await t.store.listRunsForPerson("zack"))[0]!.state).toBe("READY_HELD");
  });
});
