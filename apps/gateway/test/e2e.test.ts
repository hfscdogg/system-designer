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
import { prepareSmoke, runSmoke, SMOKE_PERSON } from "../src/smoke.ts";

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

function answerClick(receiptId: string, field: string, values: string[], user = "users/zack") {
  const single = values.length === 1 && !["functional_systems", "service_categories", "room_types"].includes(field);
  return {
    type: "CARD_CLICKED",
    eventTime: `2026-10-05T12:1${++seq % 10}:00Z`,
    space: { name: SPACE, spaceType: "SPACE" },
    message: { name: `${SPACE}/messages/app-q${seq}`, thread: { name: THREAD } },
    user: { name: user, type: "HUMAN" },
    common: {
      invokedFunction: "answer_question",
      parameters: { receipt_id: receiptId, field, ...(single ? { value: values[0]! } : {}) },
      ...(single ? {} : { formInputs: { answer: { stringInputs: { value: values } } } }),
    },
  };
}

function controlClick(control: string, ref: string, user = "users/zack") {
  return {
    type: "CARD_CLICKED",
    eventTime: `2026-10-05T12:2${++seq % 10}:00Z`,
    space: { name: SPACE, spaceType: "SPACE" },
    message: { name: `${SPACE}/messages/app-c${seq}`, thread: { name: THREAD } },
    user: { name: user, type: "HUMAN" },
    common: { invokedFunction: "conversation_control", parameters: { control, ref } },
  };
}

interface BuildOptions {
  catalog?: Record<string, unknown>;
  dtools?: DToolsReader & { calls: string[] };
  patterns?: PatternSpec[];
  policy?: boolean | Record<string, unknown>;
}

async function setup(extractions: unknown[] = [], patches: unknown[] = [], build: BuildOptions = {}) {
  const { store, db } = await testStore();
  if (build.policy !== false) await store.publishPolicy(typeof build.policy === "object" ? build.policy : TEST_POLICY, "henry", "test policy");
  const chat = new FakeChannelAdapter();
  const extractor: ScopeExtractor = {
    extract: async () => {
      const next = extractions.shift();
      if (next instanceof Error) throw next; // simulates an activity that keeps failing
      return { raw: next, model: "fake-model" };
    },
  };
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
  const questions = () => chat.list().map((m) => m.view).filter((v): v is Extract<View, { kind: "question" }> => v.kind === "question");
  const statusCard = () => chat.list().find((m) => m.view.kind === "status")?.view as Extract<View, { kind: "status" }> | undefined;
  const texts = () => chat.list().map((m) => m.view).filter((v): v is Extract<View, { kind: "text" }> => v.kind === "text").map((v) => v.text);
  return { store, db, chat, workflows, send, receipts, questions, statusCard, texts, dtools, acts };
}

beforeEach(() => {
  seq = 0;
});

describe("Google Chat → scope approval vertical slice", () => {
  it("captures, clarifies, publishes receipts verbatim and approves via the button", async () => {
    // Only what can't be inferred is asked: here the client and the market. The budget and date are assumed.
    const partial = completeExtraction({ client: null, market: "not_provided", budget: { status: "not_provided", amount_usd: null }, target_installation_date: null });
    const t = await setup([partial], [{ ...noPatch, client: "Smith Family", market: "residential" }]);

    expect(await t.send(chatMessage("Old alarm needs modernizing…"))).toEqual({ status: 200, body: {} });
    // Open questions are asked one at a time; the receipt rides along verbatim.
    expect(t.receipts()).toHaveLength(0);
    const q = t.questions();
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ field: "client", remaining: 2, choices: null });
    expect(q[0]!.lines[1]).toBe("Status: NEEDS_CLARIFICATION");
    expect(q[0]!.lines).toEqual(expect.arrayContaining(["Budget: unknown (assumed)", "Target install: unknown (assumed)"]));
    expect(t.statusCard()?.steps.map((s) => s.state)).toEqual(["done", "done", "active", "pending", "pending", "pending", "pending", "pending"]);

    // One typed reply can answer several questions.
    await t.send(chatMessage("It's the Smith family, residential"));
    const r = t.receipts();
    expect(r).toHaveLength(1);
    const v2 = r[0]!;
    expect(v2.status).toBe("AWAITING_APPROVAL");
    expect(v2.lines).toContain("Client: Smith Family");
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
    expect(summary).toContain("Priced scope to date: $3,099.00");

    const events = (await t.store.listEvents(runs[0]!.id)).map((e) => e.type);
    expect(events).toEqual(
      expect.arrayContaining(["run_started", "scope_extracted", "receipt_published", "clarification_applied", "scope_approved", "build_acquired", "artifact_published", "held_handoff"]),
    );
    // Exactly one status card, edited in place.
    expect(t.chat.list().filter((m) => m.view.kind === "status")).toHaveLength(1);
  });

  it("asks one question at a time, recommends an answer, and takes taps without a model", async () => {
    const partial = completeExtraction({ market: "not_provided", functional_systems: [], existing_detectors: "not_provided" });
    const t = await setup([partial]);
    await t.send(chatMessage("Smith family wants their old alarm modernized…"));
    let q = t.questions().at(-1)!;
    expect(q).toMatchObject({ field: "functional_systems", remaining: 2, choices: { multi: true } });

    // Someone else, an empty pick, an older card, or a value that isn't offered changes nothing.
    expect((await t.send(answerClick(q.receiptId, "functional_systems", ["security", "smoke detectors"], "users/henry"))).body).toEqual({
      text: "Only the person who made this request can answer its questions.",
    });
    expect((await t.send(answerClick(q.receiptId, "functional_systems", []))).body).toEqual({ text: "Pick at least one option, then tap Done." });
    expect((await t.send(answerClick(q.receiptId, "functional_systems", ["pool heater"]))).body).toEqual({ text: "That isn't one of the choices. Pick from the card, or type your answer." });

    const systems = ["security", "monitoring", "smoke detectors", "carbon monoxide detectors", "thermostats", "video doorbell"];
    expect((await t.send(answerClick(q.receiptId, "functional_systems", systems))).body).toEqual({
      text: "✓ Security / alarm, Alarm monitoring, Smoke detection, CO detection, Thermostats, Video doorbell",
    });
    expect((await t.send(answerClick(q.receiptId, "functional_systems", systems))).body).toEqual({ text: "That question was already answered. Use the latest card." });

    q = t.questions().at(-1)!;
    expect(q).toMatchObject({ field: "market", remaining: 2 });
    expect(q.choices!.options[0]).toEqual({ value: "residential", label: "Residential", recommended: true });
    expect((await t.send(answerClick(q.receiptId, "market", ["residential"]))).body).toEqual({ text: "✓ Residential" });

    // Smoke/CO detection is now in scope, so the detector question follows.
    q = t.questions().at(-1)!;
    expect(q).toMatchObject({ field: "existing_detectors", remaining: 1 });
    expect(q.choices!.options.find((o) => o.recommended)?.value).toBe("replace");
    await t.send(answerClick(q.receiptId, "existing_detectors", ["replace"]));

    const [receipt] = t.receipts();
    expect(receipt!.status).toBe("AWAITING_APPROVAL");
    expect(receipt!.lines).toEqual(expect.arrayContaining(["Market: residential", "Existing smoke/CO detectors: replace with new"]));
    const [run] = await t.store.listRunsForPerson("zack");
    const events = await t.store.listEvents(run!.id);
    expect(events.filter((e) => e.type === "answer_applied").map((e) => e.data.field)).toEqual(["functional_systems", "market", "existing_detectors"]);
    expect(events.some((e) => e.type === "answer_applied" && "model" in e.data)).toBe(false);
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

describe("runs whose workflow stopped", () => {
  it("reports a step that keeps failing instead of going silent", async () => {
    const t = await setup([new Error("Chat rejected the post")]);
    await t.send(chatMessage("Smith family wants their old alarm modernized…"));
    const [run] = await t.store.listRunsForPerson("zack");
    expect(await t.workflows.result(run!.id)).toEqual({ state: "BLOCKED", reason: "an internal step failed (Chat rejected the post)" });
    expect((await t.store.getRun(run!.id)).state).toBe("BLOCKED");
    expect(t.texts().some((x) => x.includes("an internal step failed (Chat rejected the post)"))).toBe(true);
  });

  it("closes a request whose workflow ended without closing it, instead of swallowing the next message", async () => {
    const t = await setup([completeExtraction({ budget: { status: "not_provided", amount_usd: null } })]);
    await t.send(chatMessage("Smith family wants their old alarm modernized…"));
    const [run] = await t.store.listRunsForPerson("zack");
    // The workflow ends while the database still lists the run as open (e.g. it failed outright).
    await t.workflows.signal(run!.id, { type: "invalidate", reason: "test" });
    await t.workflows.settled(run!.id);

    const res = await t.send(chatMessage("Budget unknown"));
    expect(res.body).toEqual({ text: "Your previous request in this conversation stopped with an error, so I've closed it. Please send your request again as a new message." });
    expect((await t.store.getRun(run!.id)).state).toBe("FAILED");
    expect(await t.store.findOpenRun({ platform: "google_chat", spaceId: SPACE, threadId: THREAD })).toBeNull();
  });
});

describe("builds whose workflow stopped", () => {
  it("closes an approved build whose workflow died, so a new request in the DM is not refused", async () => {
    const DM = "spaces/ZACK-DM";
    const t = await setup([completeExtraction(), completeExtraction()]);
    await t.send(chatMessage("Smith family wants their old alarm modernized…", { space: DM, thread: DM, dm: true }));
    const [old] = await t.store.listRunsForPerson("zack");
    // The workflow ends while the database still lists the run as mid-build (as before failures were reported).
    await t.workflows.signal(old!.id, { type: "invalidate", reason: "test" });
    await t.workflows.settled(old!.id);
    await t.db.query(`UPDATE runs SET state = 'VALIDATED' WHERE id = $1`, [old!.id]);

    const res = await t.send(chatMessage("Jones family needs a new alarm…", { space: DM, thread: DM, dm: true }));
    expect(res.body).toEqual({ text: "The previous build in this conversation stopped with an error, so I've closed it. Working on this new request now." });
    expect((await t.store.getRun(old!.id)).state).toBe("FAILED");
    const [fresh] = await t.store.listRunsForPerson("zack");
    expect(fresh!.id).not.toBe(old!.id);
    expect(fresh!.state).toBe("AWAITING_SCOPE_APPROVAL");
  });
});

describe("margin exceptions (2026 sales comp policy)", () => {
  const STRICT = { ...TEST_POLICY, margin: { residential_min_gross_margin_pct: 90, commercial_min_gross_margin_pct: 90 } };
  const HENRY_DM = "spaces/HENRY-DM";

  function marginClick(exceptionId: string, decision: "approved" | "declined", user = "users/henry") {
    return {
      type: "CARD_CLICKED",
      eventTime: `2026-10-05T13:0${++seq % 10}:00Z`,
      space: { name: user === "users/henry" ? HENRY_DM : "spaces/ZACK-DM", spaceType: "DIRECT_MESSAGE" },
      message: { name: `${HENRY_DM}/messages/app-y` },
      user: { name: user, type: "HUMAN" },
      common: { invokedFunction: "margin_exception", parameters: { exception_id: exceptionId, decision } },
    };
  }

  async function heldRun(t: Awaited<ReturnType<typeof setup>>, adminReachable = true) {
    if (adminReachable) await t.send(chatMessage("help", { user: "users/henry", space: HENRY_DM, dm: true }));
    await t.send(chatMessage("Smith family wants their old alarm modernized…"));
    const r = t.receipts().at(-1)!;
    await t.send(click(r.approve!.receiptId, r.approve!.scopeHash));
    const [run] = await t.store.listRunsForPerson("zack");
    return run!;
  }

  const exceptionCards = (t: Awaited<ReturnType<typeof setup>>) =>
    [...t.chat.messages.values()].filter((m) => m.view.kind === "margin_exception") as Array<{ thread: { spaceId: string }; view: Extract<View, { kind: "margin_exception" }> }>;

  it("holds any requested discount for an admin's approval and shows it on the budget once approved", async () => {
    const t = await setup([completeExtraction({ requested_discount: { pct: 10, note: "friends and family" } })]);
    const run = await heldRun(t);
    expect(t.receipts()[0]!.lines).toContain("Discount: 10% (friends and family), needs Henry's or Zack's approval");
    // The margin clears the floor, but the discount alone needs written approval.
    expect(run.state).toBe("AWAITING_MARGIN_APPROVAL");
    const [card] = exceptionCards(t);
    expect(t.statusCard()?.note).toContain("a 10% discount (friends and family) was requested");
    await t.send(marginClick(card!.view.exceptionId, "approved"));
    await t.workflows.settled(run.id);
    expect((await t.store.getRun(run.id)).state).toBe("READY_HELD");
    const customer = await t.store.readArtifact<{ commercial: { reduction: { pct: number; cents: number } | null; subtotal_cents: number } }>(run.id, "validate", "customer_view");
    expect(customer!.commercial.reduction).toMatchObject({ pct: 10 });
    expect(customer!.commercial.reduction!.cents).toBeGreaterThan(0);
    expect(t.chat.files).toHaveLength(1);
  });

  it("holds a build below the floor, asks the admin directly, and posts the PDF once approved", async () => {
    const t = await setup([completeExtraction()], [], { policy: STRICT });
    const run = await heldRun(t);
    expect(run.state).toBe("AWAITING_MARGIN_APPROVAL");
    expect(t.chat.files).toHaveLength(0);
    // The held build still owns the conversation while its workflow waits.
    expect((await t.send(chatMessage("Another job"))).body).toEqual({ text: "The scope in this thread is approved and still being built. Start a new thread for a new request or a scope change." });

    const cards = exceptionCards(t);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.thread.spaceId).toBe(HENRY_DM);
    const exceptionId = cards[0]!.view.exceptionId;
    expect(cards[0]!.view.lines.join("\n")).toMatch(/Gross margin [\d.]+% vs the 90% residential floor/);
    expect(t.texts().some((x) => x.includes("I've asked Henry Clifford to approve the exception"))).toBe(true);
    expect(t.statusCard()?.note).toContain("below the 90% residential minimum");

    // The requester cannot approve their own exception, and the database agrees.
    expect((await t.send(marginClick(exceptionId, "approved", "users/zack"))).body).toEqual({ text: "I can't record that decision: only an admin can decide a margin exception." });

    const res = await t.send(marginClick(exceptionId, "approved"));
    expect(res.body).toEqual({ text: `✅ Margin exception ${exceptionId} approved by Henry Clifford. The PDF is on its way to the requester.` });
    await t.workflows.settled(run.id);
    expect((await t.store.getRun(run.id)).state).toBe("READY_HELD");
    expect(t.chat.files).toHaveLength(1);
    const validation = await t.store.readArtifact<{ findings: Array<{ code: string; message: string }> }>(run.id, "validate", "result");
    expect(validation!.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "margin_exception_approved", message: expect.stringContaining("approved by Henry Clifford") })]));
    expect((await t.send(marginClick(exceptionId, "approved"))).body).toEqual({ text: `${exceptionId} is already approved.` });
  });

  it("stops the run when an admin declines", async () => {
    const t = await setup([completeExtraction()], [], { policy: STRICT });
    const run = await heldRun(t);
    const exceptionId = exceptionCards(t)[0]!.view.exceptionId;
    await t.send(chatMessage(`decline exception ${exceptionId}`, { user: "users/henry", space: HENRY_DM, dm: true }));
    await t.workflows.settled(run.id);
    expect((await t.store.getRun(run.id)).state).toBe("BLOCKED");
    expect(t.chat.files).toHaveLength(0);
    expect(t.texts().some((x) => x.includes("margin exception declined by Henry Clifford"))).toBe(true);
  });

  it("holds even when no admin can be reached, and accepts a typed approval later", async () => {
    const t = await setup([completeExtraction()], [], { policy: STRICT });
    const run = await heldRun(t, false);
    expect(exceptionCards(t)).toHaveLength(0);
    expect(t.texts().some((x) => x.includes("No admin can be reached yet"))).toBe(true);
    const exception = await t.store.getMarginException(run.id);
    await t.send(chatMessage(`approve exception ${exception!.id}`, { user: "users/henry", space: HENRY_DM, dm: true }));
    await t.workflows.settled(run.id);
    expect((await t.store.getRun(run.id)).state).toBe("READY_HELD");
  });
});

describe("editing a scope and revising a finished budget", () => {
  const EDIT_PROMPT = /^What should change\? Reply in plain words/;

  it("offers Edit and Start over on the receipt; Edit asks for the change and Start over closes the request", async () => {
    const t = await setup([completeExtraction()]);
    await t.send(chatMessage("Smith security upgrade"));
    const [receipt] = t.receipts();
    expect((await t.send(controlClick("edit_scope", receipt!.receiptId))).body).toMatchObject({ text: expect.stringMatching(EDIT_PROMPT) });
    expect((await t.send(controlClick("edit_scope", receipt!.receiptId, "users/henry"))).body).toEqual({ text: "Only the person who made this request can change it." });
    expect((await t.send(controlClick("start_over", receipt!.receiptId))).body).toEqual({ text: "Cleared. Send the request again whenever you're ready." });
    const [run] = await t.store.listRunsForPerson("zack");
    expect(run!.state).toBe("STALE");
  });

  it("revises a finished budget from its approved scope: Revision 2 receipt, -rev2 PDF, old budget superseded", async () => {
    const t = await setup([completeExtraction()], [{ ...noPatch, requested_quantities: [{ item: "Glass-break sensor", quantity: 4 }] }]);
    await t.send(chatMessage("Smith security upgrade"));
    const [first] = t.receipts();
    await t.send(click(first!.receiptId, first!.approve!.scopeHash));
    const [original] = await t.store.listRunsForPerson("zack");
    expect(original!.state).toBe("READY_HELD");
    // The budget comes with Revise / New request buttons.
    expect(t.chat.list().map((m) => m.view)).toContainEqual(expect.objectContaining({ kind: "budget_actions", runId: original!.id }));

    // Only the requester can revise; the requester gets the prompt.
    expect((await t.send(controlClick("revise_budget", original!.id, "users/henry"))).body).toEqual({ text: "Only the person who made this request can revise it." });
    expect((await t.send(controlClick("revise_budget", original!.id))).body).toMatchObject({ text: expect.stringMatching(EDIT_PROMPT) });

    // The next message is the change; no new extraction is made (the extractor queue is empty).
    await t.send(chatMessage("make it 4 glass breaks"));
    const runs = await t.store.listRunsForPerson("zack");
    const revision = runs.find((r) => r.id !== original!.id)!;
    expect(revision).toMatchObject({ parent_run_id: original!.id, revision: 2, state: "AWAITING_SCOPE_APPROVAL" });
    const second = t.receipts().at(-1)!;
    expect(second.lines).toContain(`Note: Revision 2 of the budget approved in ${first!.receiptId}; it replaces that budget once approved.`);
    expect(second.lines).toContain("Note: Changed: glass-break sensor: none → 4");
    expect(second.lines).toContain("Client: Smith Family");

    await t.send(click(second.receiptId, second.approve!.scopeHash));
    expect((await t.store.getRun(revision.id)).state).toBe("READY_HELD");
    expect((await t.store.getRun(original!.id)).state).toBe("SUPERSEDED");
    expect(t.chat.files.map((f) => f.file.filename)).toEqual(["Livewire-UNASSIGNED-conceptual-budget.pdf", "Livewire-UNASSIGNED-conceptual-budget-rev2.pdf"]);
    // A superseded budget can't be revised again; the newest one can.
    expect((await t.send(controlClick("revise_budget", original!.id))).body).toEqual({ text: "That budget was already revised. Use the newest one." });
  });

  it("treats a message starting with \"revise\" as a revision of the latest budget, and anything else as a new request", async () => {
    const t = await setup(
      [completeExtraction(), completeExtraction({ client: "Jones Family" })],
      [{ ...noPatch, client: "Smith-Jones Family" }],
    );
    await t.send(chatMessage("Smith security upgrade"));
    const [first] = t.receipts();
    await t.send(click(first!.receiptId, first!.approve!.scopeHash));
    await t.send(chatMessage("Revise: the client is the Smith-Jones family"));
    const revised = t.receipts().at(-1)!;
    expect(revised.lines).toContain("Client: Smith-Jones Family");
    expect(revised.lines).toContain("Note: Changed: Client: Smith Family → Smith-Jones Family");
    await t.send(click(revised.receiptId, revised.approve!.scopeHash));

    // "New request" clears nothing pending, and a plain message is a new job from scratch.
    const latest = (await t.store.listRunsForPerson("zack"))[0]!;
    expect((await t.send(controlClick("new_request", latest.id))).body).toEqual({ text: "OK. Send the new request whenever you're ready." });
    await t.send(chatMessage("Jones security upgrade"));
    const newest = (await t.store.listRunsForPerson("zack"))[0]!;
    expect(newest.parent_run_id).toBeNull();
    expect(t.receipts().at(-1)!.lines).toContain("Client: Jones Family");
  });
});

describe("post-deploy smoke test", () => {
  const smoke = async (expectRevised: number) => {
    const t = await setup([completeExtraction()], [{ ...noPatch, requested_quantities: [{ item: "Glass-break sensor", quantity: 4 }] }]);
    await prepareSmoke(t.db, "spaces/S");
    const run = runSmoke({
      store: t.store,
      workflows: t.workflows,
      chat: t.chat,
      spaceId: "spaces/S",
      release: "sha256:test",
      script: [
        { say: "Smith security upgrade", expect: { security_panel: 1 } },
        { say: "Revise: make it 4 glass breaks", expect: { glass_break: expectRevised, security_panel: 1 } },
      ],
      pollMs: 1,
      settle: (id) => t.workflows.settled(id),
      log: () => {},
    });
    return { t, run };
  };

  it("plays the script as the smoke user, approves each receipt and checks the finished quantities", async () => {
    const { t, run } = await smoke(4);
    const { runs } = await run;
    expect(runs).toHaveLength(2);
    const [revised, original] = await t.store.listRunsForPerson(SMOKE_PERSON.id);
    expect(revised).toMatchObject({ id: runs[1], parent_run_id: runs[0], state: "READY_HELD", space_id: "spaces/S" });
    expect(original!.state).toBe("SUPERSEDED");
    // The scripted lines, the real replies and the result all land in the smoke space.
    expect(t.texts()).toContain("🧪 User says: Revise: make it 4 glass breaks");
    expect(t.texts().at(-1)).toBe("✅ Smoke passed: 2 steps.");
    expect(t.chat.files.map((f) => f.file.filename)).toHaveLength(2);
  });

  it("fails, and says so in the space, when a budget's quantity is wrong", async () => {
    const { t, run } = await smoke(5);
    await expect(run).rejects.toThrow(/step 2 .*glass_break expected 5, got 4/);
    expect(t.texts().at(-1)).toMatch(/^❌ Smoke failed: step 2/);
  });
});
