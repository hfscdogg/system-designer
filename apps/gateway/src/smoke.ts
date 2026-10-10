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
  /** Exact quantity per pattern role on the finished budget; 0 means the role is absent. */
  expect?: Record<string, number>;
  /** Minimum quantity per role, for counts the interpreter may reasonably vary. */
  atLeast?: Record<string, number>;
  /** The selection's pattern name; catches systems nobody asked for. */
  pattern?: string;
  /** Text the approved receipt must contain (case-insensitive). */
  receipt?: string[];
}

export interface SmokeScenario {
  name: string;
  steps: SmokeStep[];
}

const ADDRESS = "100 Main St, Richmond VA 23220";

/**
 * The Green TV job, plus Zack's five pilot jobs (Oct 9), rebuilt from his summary.
 * Each checks that a problem he hit stays fixed. No discounts: a margin hold would
 * send approval cards to the admins.
 */
export const SMOKE_SCENARIOS: SmokeScenario[] = [
  {
    name: "Green (TV move and revisions)",
    steps: [
      {
        say:
          `New budget for the Smoke Test family, ${ADDRESS}. Residential. ` +
          "Sell a new 77-inch Sony BRAVIA 8 OLED TV with a Sonos Arc Ultra soundbar for the family room. " +
          "Move the existing TV and soundbar to the fitness room and wall-mount both there. Add 3 eero access points.",
        expect: { television: 1, tv_mount: 2, soundbar_mount: 2, mesh_wifi: 3 },
      },
      { say: "Revise: the existing soundbar keeps its own mount", expect: { tv_mount: 2, soundbar_mount: 1 } },
      { say: "Revise: only need 1 TV mount", expect: { tv_mount: 1, soundbar_mount: 1 } },
      { say: "Revise: remove the eeros", expect: { television: 1, mesh_wifi: 0 } },
    ],
  },
  {
    // Lighting and turret cameras were added; the "no switch, hardwired, WiFi" edit never landed.
    name: "Kemp (surveillance)",
    steps: [
      {
        say: `Cameras for the Kemp family, ${ADDRESS}. Residential. Two WiFi floodlight cameras over the driveway and garage, hardwired power, no switch.`,
        pattern: "surveillance",
        expect: { floodlight_camera: 2, outdoor_camera: 0, camera_poe_switch: 0 },
      },
      { say: "Revise: make it 3 floodlight cameras", pattern: "surveillance", expect: { floodlight_camera: 3, outdoor_camera: 0, camera_poe_switch: 0 } },
    ],
  },
  {
    // A Sanus mount replaced the requested Sony mount without saying so.
    name: "Richard Baker (TV install)",
    steps: [
      {
        say: `TV install for Richard Baker, ${ADDRESS}. Residential. Mount the customer's 65-inch Sony TV on the living room wall with a Sony ultra slim mount, inside a Leon frame.`,
        pattern: "tv_media",
        expect: { television: 0 },
        atLeast: { tv_mount: 1 },
        receipt: ["Requested product: Sony ultra slim mount"],
      },
    ],
  },
  {
    // Alarm hardware was added to a camera job, and the PDF was blocked by the word "accept".
    name: "Alexis Courtney (studio cameras)",
    steps: [
      {
        say: `Security cameras for Alexis Courtney at Hand / Thrown Studio, ${ADDRESS}. Commercial. 4 outdoor cameras around the studio; she would like to accept the proposal this week.`,
        pattern: "surveillance",
        expect: { outdoor_camera: 4 },
      },
    ],
  },
  {
    // The Bretford cart was swapped for a wall mount without saying so.
    name: "Rick Crowder (outdoor WiFi and TV cart)",
    steps: [
      {
        say: `Rick Crowder, ${ADDRESS}. Residential. Outdoor WiFi for the back patio and pool, and the customer's TV on a Bretford rolling cart outside.`,
        atLeast: { outdoor_access_point: 1 },
        receipt: ["Requested product: Bretford"],
      },
    ],
  },
  {
    // The correction was ignored: same price, and in-ceiling speakers were added.
    name: "Biscuit Belly (amp)",
    steps: [
      { say: `Biscuit Belly restaurant, ${ADDRESS}. Commercial. Replace the amplifier for the existing ceiling speakers.`, pattern: "whole_home_audio", atLeast: { zone_amplifier: 1 } },
      { say: "Revise: no new speakers, just the amp", pattern: "whole_home_audio", expect: { in_ceiling_speakers: 0 }, atLeast: { zone_amplifier: 1 } },
    ],
  },
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
  scenarios?: SmokeScenario[];
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

export async function runSmoke(deps: SmokeDeps): Promise<{ runs: string[]; failures: string[] }> {
  const scenarios = deps.scenarios ?? SMOKE_SCENARIOS;
  const log = deps.log ?? ((m: string) => console.log(m));
  const stamp = Date.now().toString(36);
  let n = 0;
  const now = () => new Date().toISOString();
  const gateway = { store: deps.store, workflows: deps.workflows, verifyGoogleChat: async () => true };
  const send = async (event: unknown) => {
    const out = await handleGoogleChat(gateway, { authorization: undefined, body: new TextEncoder().encode(JSON.stringify(event)) });
    if (out.status !== 200) throw new SmokeFailure(`gateway answered ${out.status}: ${JSON.stringify(out.body)}`);
    return out.body as { text?: string };
  };
  const waitFor = async (runId: string, want: RunState[], step: string): Promise<RunState> => {
    const deadline = Date.now() + (deps.timeoutMs ?? 10 * 60_000);
    for (;;) {
      await deps.settle?.(runId);
      const { state } = await deps.store.getRun(runId);
      if (want.includes(state)) return state;
      if (FAILED.includes(state)) throw new SmokeFailure(`${step}: run ${runId} ended ${state}`);
      if (Date.now() > deadline) throw new SmokeFailure(`${step}: run ${runId} stuck in ${state}`);
      await new Promise((r) => setTimeout(r, deps.pollMs ?? 3000));
    }
  };

  const runs: string[] = [];
  const failures: string[] = [];
  let budgets = 0;
  for (const [j, scenario] of scenarios.entries()) {
    // Each job gets its own thread, so its revisions read top to bottom and stay with it.
    const opened = await deps.chat.post(
      { platform: "google_chat", spaceId: deps.spaceId, threadId: deps.spaceId },
      { kind: "text", text: `🧪 Smoke: ${scenario.name} (release ${deps.release.slice(7, 19)})` },
      `smoke-${stamp}-open-${j}`,
    );
    const thread: ThreadRef = { platform: "google_chat", spaceId: deps.spaceId, threadId: opened.threadId ?? `${deps.spaceId}/threads/smoke-${stamp}-${j}` };
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

    try {
      for (const [i, s] of scenario.steps.entries()) {
        const step = `${scenario.name}, step ${i + 1} ("${s.say.slice(0, 50)}")`;
        log(`${step}: sending`);
        const reply = await say(s.say);
        const run = (await deps.store.listRunsForPerson(SMOKE_PERSON.id, 1))[0];
        if (!run || runs.includes(run.id) || run.thread_id !== thread.threadId) {
          throw new SmokeFailure(`${step}: no new run started${reply.text ? ` (reply: ${reply.text})` : ""}`);
        }
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
          throw new SmokeFailure(`${step}: still needs clarification: ${asked}`);
        }
        await approve(receipt.id, receipt.scope_hash);
        await waitFor(run.id, ["READY_HELD"], step);
        budgets++;

        const selection = await deps.store.readArtifact<Selection>(run.id, "selection", "selection");
        const qty = new Map((selection?.lines ?? []).map((l) => [l.role, l.quantity]));
        const got = (role: string) => qty.get(role) ?? 0;
        const lines = receipt.body.lines.map((l) => l.toLowerCase());
        const wrong = [
          ...(s.pattern && selection?.pattern !== s.pattern ? [`pattern expected ${s.pattern}, got ${selection?.pattern ?? "none"}`] : []),
          ...Object.entries(s.expect ?? {})
            .filter(([role, q]) => got(role) !== q)
            .map(([role, q]) => `${role} expected ${q}, got ${got(role)}`),
          ...Object.entries(s.atLeast ?? {})
            .filter(([role, q]) => got(role) < q)
            .map(([role, q]) => `${role} expected at least ${q}, got ${got(role)}`),
          ...(s.receipt ?? []).filter((text) => !lines.some((l) => l.includes(text.toLowerCase()))).map((text) => `receipt is missing "${text}"`),
        ];
        if (wrong.length) throw new SmokeFailure(`${step}: ${wrong.join("; ")}`);
        log(`${step}: ok (${selection?.pattern}: ${[...qty].map(([r, q]) => `${r} ${q}`).join(", ")})`);
      }
      await deps.chat.post(thread, { kind: "text", text: `✅ ${scenario.name}: passed.` }, `smoke-${stamp}-pass-${j}`);
    } catch (err) {
      // Record it and go on, so one deploy shows everything that is wrong.
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(msg);
      log(`FAILED ${msg}`);
      await deps.chat.post(thread, { kind: "text", text: `❌ Smoke failed: ${msg}` }, `smoke-${stamp}-fail-${j}`).catch(() => {});
    }
  }

  const summary = failures.length
    ? `❌ Smoke failed: ${failures.length} of ${scenarios.length} jobs (${budgets} budgets built).`
    : `✅ Smoke passed: ${scenarios.length} jobs, ${budgets} budgets.`;
  await deps.chat.post(
    { platform: "google_chat", spaceId: deps.spaceId, threadId: deps.spaceId },
    { kind: "text", text: summary },
    `smoke-${stamp}-summary`,
  );
  if (failures.length) throw new SmokeFailure(failures.join("\n"));
  return { runs, failures };
}
