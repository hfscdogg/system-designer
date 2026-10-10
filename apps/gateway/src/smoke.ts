/**
 * Post-deploy smoke test (run as the sd-smoke-<env> Cloud Run Job). It plays a
 * scripted conversation through the gateway in-process, against the real store,
 * Temporal and the deployed worker, so the interpreter, pricing, PDF and Chat
 * posting all run for real. The bot posts each scripted line and its real replies
 * into a dedicated smoke space, and each finished budget's quantities are checked.
 *
 * Only the Google signature check is skipped: the job already runs inside the
 * project, as the worker's service account.
 */
import type { Selection } from "@sd/build";
import type { ChannelAdapter } from "@sd/channels";
import type { RunState, ThreadRef } from "@sd/core";
import { allowSpace, upsertPerson, type Db, type Store } from "@sd/store";
import type { WorkflowPort } from "@sd/worker";
import { handleGoogleChat } from "./handler.ts";

export const SMOKE_PERSON = { id: "smoke-test", user: "users/smoke-test", name: "Smoke Test" };

export interface SmokeStep {
  /** What the "user" types. */
  say: string;
  /** Expected quantity per pattern role on the finished budget; 0 means the role is absent. */
  expect: Record<string, number>;
}

/** A Green-style job, then plain-language revisions of it. */
export const SMOKE_SCRIPT: SmokeStep[] = [
  {
    say:
      "New budget for the Smoke Test family, 100 Main St, Richmond VA 23220. Residential. " +
      "Sell a new 77-inch Sony BRAVIA 8 OLED TV with a Sonos Arc Ultra soundbar for the family room. " +
      "Move the existing TV and soundbar to the fitness room and wall-mount both there. Add 3 eero access points.",
    expect: { television: 1, tv_mount: 2, soundbar_mount: 2, mesh_wifi: 3 },
  },
  { say: "Revise: the existing soundbar keeps its own mount", expect: { tv_mount: 2, soundbar_mount: 1 } },
  { say: "Revise: only need 1 TV mount", expect: { tv_mount: 1, soundbar_mount: 1 } },
  { say: "Revise: remove the eeros", expect: { television: 1, mesh_wifi: 0 } },
];

const CLARIFY_DEFAULTS = "Use your recommended defaults for anything I didn't say.";
const FAILED: RunState[] = ["BLOCKED", "FAILED", "STALE", "SUPERSEDED", "RECONCILIATION_REQUIRED", "AWAITING_MARGIN_APPROVAL"];

export interface SmokeDeps {
  store: Store;
  workflows: WorkflowPort;
  /** Posts the scripted lines into the smoke space, as the app. */
  chat: ChannelAdapter;
  spaceId: string;
  release: string;
  /**
   * Workspace email the smoke "user" reports. In delegated upload mode the PDF is
   * posted as this person, so they must be a member of the smoke space.
   */
  email?: string;
  script?: SmokeStep[];
  /** Per-step wait limit. */
  timeoutMs?: number;
  pollMs?: number;
  /** Tests: let in-process workflows reach their next wait point. */
  settle?: (runId: string) => Promise<void>;
  log?: (msg: string) => void;
}

/** Idempotent setup: the smoke space is allowed and the smoke "user" is a requester. */
export async function prepareSmoke(db: Db, spaceId: string): Promise<void> {
  await allowSpace(db, "google_chat", spaceId, "Smoke test");
  await upsertPerson(db, {
    id: SMOKE_PERSON.id,
    displayName: SMOKE_PERSON.name,
    roles: ["requester"],
    identities: [{ platform: "google_chat", providerUserId: SMOKE_PERSON.user }],
  });
}

export class SmokeFailure extends Error {
  override name = "SmokeFailure";
}

export async function runSmoke(deps: SmokeDeps): Promise<{ runs: string[] }> {
  const script = deps.script ?? SMOKE_SCRIPT;
  const log = deps.log ?? ((m: string) => console.log(m));
  const stamp = Date.now().toString(36);
  let n = 0;
  const now = () => new Date().toISOString();

  // Open a fresh thread so the whole conversation reads top to bottom.
  const opened = await deps.chat.post(
    { platform: "google_chat", spaceId: deps.spaceId, threadId: deps.spaceId },
    { kind: "text", text: `🧪 Smoke test of release ${deps.release.slice(0, 19)}…` },
    `smoke-${stamp}-open`,
  );
  const thread: ThreadRef = { platform: "google_chat", spaceId: deps.spaceId, threadId: opened.threadId ?? `${deps.spaceId}/threads/smoke-${stamp}` };
  const gateway = { store: deps.store, workflows: deps.workflows, verifyGoogleChat: async () => true };
  const send = async (event: unknown) => {
    const out = await handleGoogleChat(gateway, { authorization: undefined, body: new TextEncoder().encode(JSON.stringify(event)) });
    if (out.status !== 200) throw new SmokeFailure(`gateway answered ${out.status}: ${JSON.stringify(out.body)}`);
    return out.body as { text?: string };
  };
  const say = async (text: string) => {
    await deps.chat.post(thread, { kind: "text", text: `🧪 User says: ${text}` }, `smoke-${stamp}-say-${++n}`);
    return send({
      type: "MESSAGE",
      eventTime: now(),
      space: { name: deps.spaceId, spaceType: "SPACE" },
      message: {
        name: `${deps.spaceId}/messages/smoke-${stamp}-${n}`,
        text,
        argumentText: text,
        createTime: now(),
        sender: { name: SMOKE_PERSON.user, displayName: SMOKE_PERSON.name, type: "HUMAN", ...(deps.email ? { email: deps.email } : {}) },
        thread: { name: thread.threadId },
      },
    });
  };
  const approve = (receiptId: string, scopeHash: string) =>
    send({
      type: "CARD_CLICKED",
      eventTime: now(),
      space: { name: deps.spaceId, spaceType: "SPACE" },
      message: { name: `${deps.spaceId}/messages/smoke-${stamp}-click-${++n}`, thread: { name: thread.threadId } },
      user: { name: SMOKE_PERSON.user, type: "HUMAN" },
      common: { invokedFunction: "approve_scope", parameters: { receipt_id: receiptId, scope_hash: scopeHash } },
    });

  const waitFor = async (runId: string, want: RunState[], step: number): Promise<RunState> => {
    const deadline = Date.now() + (deps.timeoutMs ?? 10 * 60_000);
    for (;;) {
      await deps.settle?.(runId);
      const { state } = await deps.store.getRun(runId);
      if (want.includes(state)) return state;
      if (FAILED.includes(state)) throw new SmokeFailure(`step ${step}: run ${runId} ended ${state}`);
      if (Date.now() > deadline) throw new SmokeFailure(`step ${step}: run ${runId} stuck in ${state}`);
      await new Promise((r) => setTimeout(r, deps.pollMs ?? 3000));
    }
  };

  const runs: string[] = [];
  const fail = async (err: unknown): Promise<never> => {
    const msg = err instanceof Error ? err.message : String(err);
    await deps.chat.post(thread, { kind: "text", text: `❌ Smoke failed: ${msg}` }, `smoke-${stamp}-fail`).catch(() => {});
    throw err instanceof SmokeFailure ? err : new SmokeFailure(msg);
  };

  try {
    for (const [i, s] of script.entries()) {
      const step = i + 1;
      log(`step ${step}: ${s.say}`);
      const reply = await say(s.say);
      const run = (await deps.store.listRunsForPerson(SMOKE_PERSON.id, 1))[0];
      if (!run || runs.includes(run.id)) throw new SmokeFailure(`step ${step}: no new run started${reply.text ? ` (reply: ${reply.text})` : ""}`);
      runs.push(run.id);

      // The interpreter may still ask something; answer with the defaults, twice at most.
      let state = await waitFor(run.id, ["AWAITING_SCOPE_APPROVAL", "NEEDS_CLARIFICATION"], step);
      for (let tries = 0; state === "NEEDS_CLARIFICATION" && tries < 2; tries++) {
        await say(CLARIFY_DEFAULTS);
        state = await waitFor(run.id, ["AWAITING_SCOPE_APPROVAL", "NEEDS_CLARIFICATION"], step);
      }
      const receipt = await deps.store.latestReceipt(run.id);
      if (state !== "AWAITING_SCOPE_APPROVAL" || !receipt?.scope_hash) {
        const asked = receipt?.body.lines.filter((l) => /\?/.test(l)).join(" | ") || "no receipt";
        throw new SmokeFailure(`step ${step}: still needs clarification: ${asked}`);
      }
      await approve(receipt.id, receipt.scope_hash);
      await waitFor(run.id, ["READY_HELD"], step);

      const selection = await deps.store.readArtifact<Selection>(run.id, "selection", "selection");
      const qty = new Map((selection?.lines ?? []).map((l) => [l.role, l.quantity]));
      const wrong = Object.entries(s.expect)
        .filter(([role, q]) => (qty.get(role) ?? 0) !== q)
        .map(([role, q]) => `${role} expected ${q}, got ${qty.get(role) ?? 0}`);
      if (wrong.length) throw new SmokeFailure(`step ${step} ("${s.say.slice(0, 60)}"): ${wrong.join("; ")}`);
      log(`step ${step}: ok (${[...qty].map(([r, q]) => `${r} ${q}`).join(", ")})`);
    }
  } catch (err) {
    return fail(err);
  }
  await deps.chat.post(thread, { kind: "text", text: `✅ Smoke passed: ${script.length} steps.` }, `smoke-${stamp}-pass`);
  return { runs };
}
