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
import type { Proposal, Selection } from "@sd/build";
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
  /** The budget must carry a total (nothing left unresolved that withholds it). */
  total?: boolean;
  /** Exact quantity per D-Tools record, for roles priced in more than one model (an Arc Ultra and a Beam). */
  records?: Record<string, number>;
  /** Words each priced equipment allowance must have one of ("Turntable"). */
  allowances?: string[];
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
    // The Bretford cart was swapped for a wall mount without saying so; conduit and an outdoor outlet left the total blank (2026-10-12).
    name: "Rick Crowder (outdoor WiFi and TV cart)",
    steps: [
      {
        say:
          `Rick Crowder, ${ADDRESS}. Residential. Outdoor WiFi for the back patio and pool, and the customer's TV on a Bretford rolling cart outside. ` +
          "Run conduit from the house to the patio and add an outdoor outlet by the pool.",
        // A TV on a cart needs no wall mount; the eeros are the ones the Wi-Fi asks for, none from wired or PoE wording.
        expect: { tv_mount: 0, tv_mount_articulating: 0, wired_access_point: 0 },
        atLeast: { outdoor_access_point: 1, mesh_wifi: 1 },
        receipt: ["Requested product: Bretford"],
        // The cart is listed to price, and an Apple TV for streaming is the TV's source (the 2026 SKU at $339): neither withholds the total (2026-10-15).
        total: true,
      },
    ],
  },
  {
    // Zack's test round (2026-10-12): an articulating mount was priced as the tilt mount.
    name: "Britt (articulating mount)",
    steps: [
      {
        say: `TV install for the Britt family, ${ADDRESS}. Residential. Mount the customer's 65-inch TV on an articulating mount in the living room.`,
        pattern: "tv_media",
        expect: { tv_mount_articulating: 1, tv_mount: 0, television: 0 },
      },
    ],
  },
  {
    // Zack's round 3 (2026-10-13): no doorbell, microSD cards for the SVR, two switches, a tilt mount for "articulated",
    // an unasked keypad and contact, and one smoke and one CO detector for 4 smoke/CO detectors.
    name: "Britt (security, cameras, network and outdoor TV)",
    steps: [
      {
        say:
          `Ted Britt, ${ADDRESS}. Residential. Network: Ethernet port in the master bedroom, dining room and living room, and one behind the outdoor TV on the back porch; ` +
          "PoE access point in the top floor hallway. Outdoor TV: customer's 55-inch outdoor TV on an articulated mounting bracket. " +
          "Security: SVR in the dining room; security panel in the hallway from the garage to the kitchen; 1 x wired smart doorbell camera (current doorbell and chime work); " +
          "1 x wired floodlight camera above the garage; 1 x wired camera at the front of the house; 1 x wired camera on the back corner; " +
          "2 x smoke/CO detectors upstairs and 2 x smoke/CO detectors downstairs, replacing none; 1 x smart thermostat downstairs.",
        expect: { doorbell_camera: 1, nvr: 1, outdoor_camera: 2, camera_storage: 0, network_switch: 1, camera_poe_switch: 0, power_protection: 1, tv_mount_articulating: 1, tv_mount: 0, keypad: 0, door_window_contact: 0, smoke_heat_detector: 4, co_detector: 4 },
      },
    ],
  },
  {
    // Zack's round 4 (2026-10-15): the kept Control4 controller withheld the total, a Halo remote nobody asked for was added,
    // and the 75" full-weather outdoor TV was priced as the indoor 77" Sony.
    name: "McGetrick (outdoor TV, existing Control4)",
    steps: [
      {
        say:
          `McGetrick family, ${ADDRESS}. Residential. Sell a new 75" full weather outdoor TV for the covered patio on an articulated mount, ` +
          "and add it to their existing Control4 system; the Control4 controller stays.",
        expect: { automation_remote: 0, tv_mount_articulating: 1, tv_mount: 0 },
        total: true,
      },
    ],
  },
  {
    // Zack's round 4 (2026-10-15): "4 exterior cameras" was priced on top of the four it then listed.
    name: "Bowen-Rees (camera total, itemized)",
    steps: [
      {
        say:
          `Melissa Bowen-Rees, ${ADDRESS}. Residential. 4 exterior cameras: 1 x wired smart doorbell camera at the front door (current doorbell and chime work); ` +
          "1 x wired camera on the side of the house; 1 x wired camera at the back of the house; 1 x wired floodlight camera above the garage. SVR in the basement closet.",
        expect: { outdoor_camera: 2, floodlight_camera: 1, doorbell_camera: 1, nvr: 1 },
      },
    ],
  },
  {
    // Henry, 2026-10-11: the Sonos sub pulled in whole-home audio (ceiling speakers, amps), and "hours to 7" couldn't be applied.
    name: "Darren Mackin (TV and Sonos soundbar)",
    steps: [
      {
        say: `Scope for Darren Mackin, ${ADDRESS}. Residential. Livewire provided 77" OLED TV in playroom with Sonos Arc Ultra and Sonos Sub with one remote to control everything; actually just use the Apple TV remote to control everything.`,
        pattern: "tv_media",
        expect: { television: 1, soundbar: 1, subwoofer: 1 },
      },
      // Raising the hours (estimate 12.5) proves the override without tripping the margin floor; Henry's 7 h falls under 40% and waits for an admin.
      { say: "Revise: hours to 14", pattern: "tv_media", expect: { television: 1, soundbar: 1, subwoofer: 1 }, receipt: ["Labor: 14 hours total"] },
    ],
  },
  {
    // The correction was ignored: same price, and in-ceiling speakers were added.
    name: "Biscuit Belly (amp)",
    steps: [
      // "The amplifier" is one amp (two put it under the commercial margin floor).
      { say: `Biscuit Belly restaurant, ${ADDRESS}. Commercial. Replace the amplifier for the existing ceiling speakers.`, pattern: "whole_home_audio", expect: { zone_amplifier: 1 } },
      { say: "Revise: no new speakers, just the amp", pattern: "whole_home_audio", expect: { in_ceiling_speakers: 0, zone_amplifier: 1 } },
    ],
  },
  // Zack's Morales job (Marshall's, 2026-11-06), from his intake: three runs priced it $11K-$45K. Run twice, each must
  // price our TV, three mounts and two amps, and none of the customer's UniFi gear, new cable or a patch panel.
  ...[1, 2].map((n) => ({
    name: `Morales (customer-supplied UniFi, run ${n})`,
    steps: [
      {
        say: `Morales budget, ${ADDRESS}. Residential. Great Room: Sony Bravia 7 or 9 (65”) (streaming only content), flat mount, Sonos amp in box behind TV connected to speakers wired during construction. Kitchen: Sonos amp in customer supplied rack connected to speakers installed during construction. Porch: customer supplied TV (55-65”) (indoor rated), outdoor TV install with art arm mount (outdoor rated mount - SunBrite), Sonos Beam package installed. Primary Bedroom: customer supplied TV (55-65”) flat/tilt mounted, Wi-Fi only. Network: mount and connect all customer-provided APs and cameras; complete the media closet terminations owed under the existing Biringer contract (punch-down into rack-mount keystone patch panel, labeling, testing); mount and configure all customer-provided UniFi equipment in a customer-provided 24U floor cabinet. Customer supplied UniFi equipment: Dream Machine SE x1, Pro Max 48 PoE switch x1, U7 Pro x3, U7 Outdoor x1, G6 Edge Turret x3, G6 Dome x1, UNVR x1, UPS 2U x1, 24-port blank keystone patch panel x2.`,
        expect: {
          television: 1, tv_mount: 2, tv_mount_articulating: 1, zone_amplifier: 2, soundbar: 1,
          mesh_wifi: 0, outdoor_access_point: 0, network_switch: 0, remote_management: 0, power_protection: 0, nvr: 0, patch_panel: 0, cat6_cable: 0, outdoor_speakers: 0, speaker_prewire: 0,
        },
      },
    ],
  })),
  {
    // Zack's Annie Lewis job (2026-11-05): three rooms of TVs priced as one.
    name: "Annie Lewis (a TV in each room)",
    steps: [
      {
        say:
          `Annie Lewis, ${ADDRESS}. Residential. Guest room: 43-inch TV with articulating wall mount. ` +
          "Living room: 65-inch Sony TV with articulating mount and Sonos Arc Ultra on a soundbar bracket. Downstairs: 43-inch TV on a single-arm articulating mount.",
        pattern: "tv_media",
        expect: { tv_mount_articulating: 3, soundbar: 1 },
        atLeast: { television: 3 },
      },
    ],
  },
  {
    // Zack's Bennett job (run_de5d502b, 2026-11-09): the $1,000 turntable allowance went to the verify list.
    name: "Bennett (85-inch Bravia RGB, CoreLite, turntable allowance)",
    steps: [
      {
        say:
          `Customer Name: Monty Bennett. Address: ${ADDRESS}. The client wants to update his AV equipment in his basement movie room. ` +
          "His audio system is operational. Livewire installed all his basement movie rooms about 15 years ago. The Wifi signal is good in the basement. " +
          "Power outlets are available behind the TV location. Requirements: 1 x 85” Sony Bravia RGB TV, standing on top of a very long cabinet. " +
          "1x Control 4 Halo Remote + CoreLite to operate the devices. 1 x New turntable player to play his LP records, include a $1,000 allowance. " +
          "1 x Ethernet port at the back of the TV location. Data cables can be run from headend, to the front porch and down to the basement, approx 150 ft.",
        expect: { television: 1, tv_mount: 0, tv_mount_articulating: 0, automation_controller: 1, automation_remote: 1 },
        allowances: ["turntable"],
        total: true,
      },
    ],
  },
  {
    // Zack's Lewis security job (run_604ef411, 2026-11-09): the Concord 4 was kept while PowerG devices were priced.
    name: "Annie Lewis (security: Concord 4 replaced)",
    steps: [
      {
        say:
          `Client: Annie Lewis, ${ADDRESS}. Residential. Security proposal. Existing system: described as "Connect Home" with a Concord 4 panel. ` +
          "Verify existing equipment, compatibility, and which devices can be reused. Proposed equipment: door contacts x3 (confirm locations), " +
          "window contacts x4 (confirm locations), motion sensors x2 (confirm locations), smoke detector x1 (second floor), keypads x2 (entryway and primary bedroom), " +
          "thermostat integration for up to 2 (verify Z-Wave compatibility). Monitoring: Alarm.com five-year discount agreement, $59.99 per month. " +
          "Confirm required panel, communicator, and keypad compatibility. Replace any existing hard-wired smoke detectors with new wireless ones.",
        expect: { security_panel: 1, keypad: 2, door_window_contact: 7, motion_detector: 2, smoke_heat_detector: 1, thermostat: 0 },
      },
    ],
  },
  {
    // Zack's Lewis TV job (run_912cc317, 2026-11-09): the office Beam priced as a second Arc Ultra with an Arc mount.
    name: "Annie Lewis (TVs: Arc Ultra and Beam)",
    steps: [
      {
        say:
          `Client: Annie Lewis, ${ADDRESS}. Residential. AV, television installations. Guest Room: 43-inch TV using streaming apps, articulating wall mount, ` +
          "relocate existing power and data connections behind the TV. Living Room: 65-inch Sony TV, articulating wall mount using existing power and data locations, " +
          "Sonos Arc Ultra mounted to the TV using a compatible soundbar bracket. Downstairs: 43-inch TV using Wi-Fi, single-arm articulating mount. " +
          "Office: 43-inch TV and a Sonos Beam.",
        pattern: "tv_media",
        expect: { soundbar: 2, soundbar_mount: 2 },
        atLeast: { television: 4 },
        records: {
          "5eb671b0-b05d-4671-940a-0d77f3bbeac7": 1, // Sonos Arc Ultra
          "b8dc2e4b-a25b-4508-bf5b-e7f19959e73d": 1, // Sonos Beam (Gen 2)
          "5e66b358-6e5b-44b9-85ef-8945af55280a": 1, // Sanus WSSATM1-B2 (Arc)
          "7fb73570-69b6-4b86-b9b6-613bc02370ff": 1, // Sanus WSSBM1-B2 (Beam)
        },
      },
    ],
  },
  {
    // Henry, 2026-11-07: eeros on the customer's own router take OvrC and a WattBox, no switch.
    name: "Eeros on the customer's router",
    steps: [
      {
        say: `New whole-home eero Wi-Fi network for the Smoke Test family, ${ADDRESS}. Residential. The customer keeps their own Verizon router.`,
        pattern: "home_network",
        expect: { network_switch: 0, remote_management: 1, power_protection: 1 },
        atLeast: { mesh_wifi: 1 },
      },
    ],
  },
  {
    // Henry's demo, 2026-11-09: "10' linear light" in a revision became a Cat6 change, and linear lighting had no product.
    name: "Jeff German (Cat6 drop, then linear lighting)",
    steps: [
      { say: `Jeff German, ${ADDRESS}. Residential. Retrofit one Cat6 run in an existing home for a WiFi access point.`, total: true },
      { say: "Revise: add 10' of linear lighting in the kitchen", expect: { linear_tape_light: 1, linear_extrusion: 2, linear_driver: 1, linear_dimmer: 1 } },
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
  /** Waits before retrying a throttled Chat post, and between the job's own posts. */
  retryDelaysMs?: number[];
  paceMs?: number;
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

/** Throttling, and Chat's own transient server errors (it failed #82's staging smoke twice on 2026-10-28 with "Internal error encountered"). */
const THROTTLED = /quota|rate|429|resource.?exhausted|internal error|backend error|unavailable|deadline|\b50[023]\b/i;

/** Chat throttles bursts of posts into one space and sometimes fails one with a server error; the job's own posts wait and retry (each post carries an idempotency key, so a retry never doubles a message). */
function patientChat(chat: ChannelAdapter, delays: number[], log: (m: string) => void): ChannelAdapter["post"] {
  return async (thread, view, key) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await chat.post(thread, view, key);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!THROTTLED.test(msg) || attempt >= delays.length) throw new SmokeFailure(`posting to Chat failed: ${msg}`);
        log(`Chat throttled (${msg}); retrying in ${delays[attempt]! / 1000}s`);
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
  };
}

export async function runSmoke(deps: SmokeDeps): Promise<{ runs: string[]; failures: string[] }> {
  const scenarios = deps.scenarios ?? SMOKE_SCENARIOS;
  const log = deps.log ?? ((m: string) => console.log(m));
  const post = patientChat(deps.chat, deps.retryDelaysMs ?? [5000, 15000, 30000], log);
  const pace = () => new Promise((r) => setTimeout(r, deps.paceMs ?? 1000));
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
      if (FAILED.includes(state)) throw new SmokeFailure(`${step}: run ${runId} ended ${state}${await whyStopped(runId)}`);
      if (Date.now() > deadline) throw new SmokeFailure(`${step}: run ${runId} stuck in ${state}`);
      await new Promise((r) => setTimeout(r, deps.pollMs ?? 3000));
    }
  };

  // The reason a run stopped: recorded on its last state change, plus any open receipt blockers.
  const whyStopped = async (runId: string): Promise<string> => {
    const last = (await deps.store.listEvents(runId)).filter((e) => e.type === "state_changed").at(-1)?.data;
    const blockers = (await deps.store.latestReceipt(runId))?.body.blockers ?? [];
    // Why the model's reading was refused, and what it replied, so a "couldn't place" is diagnosable from the CI log
    // (staging smoke, 2026-11-10: Jeff German's linear-lighting revision refused twice with no reason on record).
    const events = await deps.store.listEvents(runId);
    const refused = events.filter((e) => /_(unmapped|rejected)$/.test(e.type)).map((e) => `${e.type} ${JSON.stringify(e.data).slice(0, 400)}`);
    const replies: string[] = [];
    for (const a of (await deps.store.listArtifacts(runId)).filter((x) => x.stage === "model")) {
      const record = await deps.store.readArtifact<{ kind?: string; raw?: unknown }>(runId, a.stage, a.name);
      if (record && record.kind !== "extraction") replies.push(`${record.kind ?? a.name}: ${JSON.stringify(record.raw).slice(0, 1200)}`);
    }
    const parts = [
      ...(last?.error ? [`at ${String(last.from ?? "?")}: ${String(last.error)}`] : []),
      ...(blockers.length ? [`blockers: ${JSON.stringify(blockers).slice(0, 300)}`] : []),
      ...refused,
      ...(replies.length ? [`model replies: ${replies.join(" | ")}`] : []),
    ];
    return parts.length ? ` (${parts.join("; ")})` : "";
  };
  const runs: string[] = [];
  const failures: string[] = [];
  let budgets = 0;
  for (const [j, scenario] of scenarios.entries()) {
    // Each job gets its own thread, so its revisions read top to bottom and stay with it.
    const opened = await post(
      { platform: "google_chat", spaceId: deps.spaceId, threadId: deps.spaceId },
      { kind: "text", text: `🧪 Smoke: ${scenario.name} (release ${deps.release.slice(7, 19)})` },
      `smoke-${stamp}-open-${j}`,
    );
    const thread: ThreadRef = { platform: "google_chat", spaceId: deps.spaceId, threadId: opened.threadId ?? `${deps.spaceId}/threads/smoke-${stamp}-${j}` };
    const say = async (text: string) => {
      await pace();
      await post(thread, { kind: "text", text: `🧪 User says: ${text}` }, `smoke-${stamp}-say-${++n}`);
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
        // A role can have several lines (a 43-inch placeholder beside a 65-inch TV): its quantity is their sum.
        const qty = new Map<string, number>();
        for (const l of selection?.lines ?? []) qty.set(l.role, (qty.get(l.role) ?? 0) + l.quantity);
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
          ...(s.total && (await deps.store.readArtifact<Proposal>(run.id, "bind", "proposal"))?.commercial.total_cents == null ? ["the budget has no total"] : []),
          ...Object.entries(s.records ?? {})
            .filter(([id, q]) => (selection?.lines ?? []).filter((l) => l.record_id === id).reduce((n, l) => n + l.quantity, 0) !== q)
            .map(([id, q]) => `record ${id} expected ${q}, got ${(selection?.lines ?? []).filter((l) => l.record_id === id).reduce((n, l) => n + l.quantity, 0)}`),
          ...(s.allowances ?? [])
            .filter((w) => !(selection?.equipment_allowances ?? []).some((a) => a.label.toLowerCase().includes(w.toLowerCase())))
            .map((w) => `no equipment allowance for "${w}"`),
        ];
        if (wrong.length) {
          // What the interpreter read and what was priced, so a failure can be traced from the deploy log alone.
          const read = receipt.body.lines.filter((l) => /^(Systems|Stated quantities|Livewire supplies|Customer supplies \(Livewire installs\)|Customer's existing|Existing equipment|Existing smoke\/CO detectors|Excluded):/.test(l));
          const priced = `${selection?.pattern ?? "no pattern"}: ${[...qty].map(([r, q]) => `${r} ${q}`).join(", ") || "nothing"}`;
          throw new SmokeFailure(`${step}: ${wrong.join("; ")} [priced ${priced}] [receipt ${read.join(" | ")}]`);
        }
        log(`${step}: ok (${selection?.pattern}: ${[...qty].map(([r, q]) => `${r} ${q}`).join(", ")})`);
      }
      await post(thread, { kind: "text", text: `✅ ${scenario.name}: passed.` }, `smoke-${stamp}-pass-${j}`);
    } catch (err) {
      // Record it and go on, so one deploy shows everything that is wrong.
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(msg);
      log(`FAILED ${msg}`);
      await post(thread, { kind: "text", text: `❌ Smoke failed: ${msg}` }, `smoke-${stamp}-fail-${j}`).catch(() => {});
    }
  }

  const summary = failures.length
    ? `❌ Smoke failed: ${failures.length} of ${scenarios.length} jobs (${budgets} budgets built).`
    : `✅ Smoke passed: ${scenarios.length} jobs, ${budgets} budgets.`;
  await post(
    { platform: "google_chat", spaceId: deps.spaceId, threadId: deps.spaceId },
    { kind: "text", text: summary },
    `smoke-${stamp}-summary`,
  );
  if (failures.length) throw new SmokeFailure(failures.join("\n"));
  return { runs, failures };
}
