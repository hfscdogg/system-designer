import { parseApprovalText, type RunSignal, type ThreadRef } from "@sd/core";
import { googleChatReplyBody, isAddonBody, parseGoogleChatEvent, type InboundEvent, type RequestVerifier, type WebhookReply } from "@sd/channels";
import type { Person, Store } from "@sd/store";
import type { WorkflowPort } from "@sd/worker";

/**
 * Webhook front door. Deterministic code only: verify the provider, resolve the
 * person, capture the original message, claim it, then hand off to the run's
 * workflow. No LLM is called here (PRD §6.2, §10.2).
 */
export interface GatewayDeps {
  store: Store;
  workflows: WorkflowPort;
  verifyGoogleChat: RequestVerifier;
  log?: (entry: Record<string, unknown>) => void;
}

export interface WebhookRequest {
  authorization: string | undefined;
  body: Uint8Array;
}

const reply = (text: string): WebhookReply => ({ status: 200, body: { text } });
const silent: WebhookReply = { status: 200, body: {} };

const HELP = [
  "I turn a project description into a scope receipt and, once you approve it, a held conceptual-budget PDF.",
  "Send the client, address, rooms, what they want, what happens to existing gear, budget and timeline. \"Unknown\" is a fine answer.",
  "Commands: `status` (your recent runs), `reset` (abandon the request in this conversation), `help`.",
].join("\n");

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 200 * 2 ** i));
    }
  }
  throw last;
}

export async function handleGoogleChat(deps: GatewayDeps, req: WebhookRequest): Promise<WebhookReply> {
  if (!(await deps.verifyGoogleChat(req.authorization))) return { status: 401, body: { error: "unauthenticated" } };
  const out = await handleEvent(deps, parseGoogleChatEvent(req.body));
  // Workspace add-on Chat apps expect replies wrapped in a host-app action.
  const text = (out.body as { text?: unknown }).text;
  if (typeof text === "string" && isAddonBody(req.body)) return { status: out.status, body: googleChatReplyBody(text, true) };
  return out;
}

export async function handleEvent(deps: GatewayDeps, event: InboundEvent): Promise<WebhookReply> {
  const { store } = deps;
  const log = deps.log ?? (() => {});
  if (event.kind === "ignored") {
    log({ msg: "event ignored", reason: event.reason });
    return silent;
  }

  const person = event.sender.isHuman ? await store.resolvePerson(event.platform, event.sender.providerUserId) : null;
  if (!person) {
    await store.appendEvent(null, "unauthorized_sender", "system", {
      platform: event.platform,
      providerUserId: event.sender.providerUserId,
      email: event.sender.email,
      displayName: event.sender.displayName,
    });
    return reply("You're not set up to use System Designer yet. Ask Henry to add you.");
  }
  // Pilot hold: only DMs with authorized people and explicitly allowed internal spaces.
  if (!event.isDirectMessage && !(await store.isAllowedSpace(event.platform, event.thread.spaceId))) {
    await store.appendEvent(null, "space_not_allowed", person.id, { thread: event.thread });
    return reply("This space isn't approved for System Designer. Message me directly or ask Henry to add the space.");
  }

  if (event.kind === "approve_click") {
    return approve(deps, person, event.thread, event.receiptId, event.scopeHash, event.providerEventId, "button");
  }
  return message(deps, person, event);
}

async function message(deps: GatewayDeps, person: Person, event: Extract<InboundEvent, { kind: "message" }>): Promise<WebhookReply> {
  const { store } = deps;
  const generation = await store.currentGeneration(event.thread);
  // Capture first, before anything interprets the text (PRD §7.2).
  const { intake } = await store.captureIntake(
    {
      platform: event.platform,
      providerMessageId: event.providerMessageId,
      spaceId: event.thread.spaceId,
      threadId: event.thread.threadId,
      requesterProviderId: event.sender.providerUserId,
      requesterEmail: event.sender.email,
      text: event.text,
      attachments: event.attachments.map((a) => ({ ...a, admitted: false as const })),
      providerTime: event.providerTime,
      rawBytes: event.rawBytes,
    },
    person,
    generation,
  );
  const claim = (purpose: string, runId: string | null = null) => store.claimMessage(event.platform, event.providerMessageId, purpose, runId);
  const text = event.text.trim();

  if (/^(help|\/help|\?)$/i.test(text)) return (await claim("help")) ? reply(HELP) : silent;

  if (/^\/?status$/i.test(text)) {
    if (!(await claim("status"))) return silent;
    const runs = await store.listRunsForPerson(person.id, 5);
    if (!runs.length) return reply("You have no proposal runs yet.");
    return reply(["Your recent runs:", ...runs.map((r) => `• ${r.id.slice(4, 12)} — ${r.state}`)].join("\n"));
  }

  if (/^\/?reset$/i.test(text)) {
    if (!(await claim("reset"))) return silent;
    const { staleRunIds } = await store.resetSession(event.thread, person.id);
    for (const runId of staleRunIds) await signal(deps, runId, { type: "invalidate", reason: "session reset" });
    return reply(staleRunIds.length ? "Cleared. The open request here is closed and its receipt can no longer be approved." : "Nothing to clear.");
  }

  const approvalReceipt = parseApprovalText(text);
  if (approvalReceipt) {
    if (!(await claim("approval"))) return silent;
    const receipt = await store.getReceipt(approvalReceipt);
    if (!receipt?.scope_hash) return reply(`I can't find an approvable receipt ${approvalReceipt}.`);
    return approve(deps, person, event.thread, receipt.id, receipt.scope_hash, event.providerMessageId, "text");
  }

  const open = await store.findOpenRun(event.thread);
  if (open) {
    if (open.person_id !== person.id) {
      await claim("ignored_not_requester", open.id);
      return reply("This conversation has an open request from someone else. Start a new thread for yours.");
    }
    if (!(await claim("clarification", open.id))) return silent;
    await signal(deps, open.id, { type: "clarification", intakeId: intake.id });
    return silent;
  }

  const building = await store.findBuildingRun(event.thread);
  if (building) {
    await claim("ignored_building", building.id);
    return reply("The scope in this conversation is already approved. Start a new thread for a new request or a scope change.");
  }

  const started = await store.startRun(intake);
  if (!started.ok) {
    // Duplicate delivery, or another message opened a run first: never start a second run.
    return silent;
  }
  try {
    await withRetry(() => deps.workflows.start(started.run.id));
  } catch (err) {
    await store.appendEvent(started.run.id, "workflow_start_failed", "system", { error: String(err) });
    return reply("I saved your request but couldn't start working on it. It will be picked up automatically; nothing was sent anywhere.");
  }
  return silent;
}

async function approve(
  deps: GatewayDeps,
  person: Person,
  thread: ThreadRef,
  receiptId: string,
  scopeHash: string,
  providerEventId: string,
  method: "button" | "text",
): Promise<WebhookReply> {
  const result = await deps.store.commitApproval({ receiptId, scopeHash, approverPersonId: person.id, thread, providerEventId, method });
  if (!result.ok) return reply(`I can't accept that approval: ${result.reason}.`);
  if (result.duplicate) return reply(`${receiptId} is already approved.`);
  // The approval is committed. If this signal is lost the workflow reconciles it from the database.
  await signal(deps, result.runId, { type: "approved", receiptId, scopeHash, approvalId: result.approvalId });
  return reply(`✅ Scope ${receiptId} approved by ${person.display_name}.`);
}

async function signal(deps: GatewayDeps, runId: string, s: RunSignal): Promise<void> {
  try {
    await withRetry(() => deps.workflows.signal(runId, s));
  } catch (err) {
    await deps.store.appendEvent(runId, "signal_delivery_failed", "system", { signal: s.type, error: String(err) });
  }
}
