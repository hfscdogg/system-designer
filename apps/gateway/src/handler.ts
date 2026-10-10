import { answerLabels, OPEN_INTAKE_STATES, parseApprovalText, type RunSignal, type ThreadRef } from "@sd/core";
import { googleChatReplyBody, isAddonBody, parseGoogleChatEvent, type InboundEvent, type RequestVerifier, type WebhookReply } from "@sd/channels";
import type { Person, Store } from "@sd/store";
import { WorkflowClosedError, type WorkflowPort } from "@sd/worker";

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
  "To change a scope before approving, tap Edit or just reply. To change a finished budget, tap \"Revise this budget\" under it (or start a message with \"revise\").",
  "Commands: `status` (your recent runs), `reset` (abandon the request in this conversation), `help`.",
].join("\n");

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if ((err as { final?: boolean }).final) throw err;
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

  // Remember each person's direct conversation, so admins can be asked for margin decisions.
  if (event.isDirectMessage) await store.rememberDirectSpace(event.platform, event.sender.providerUserId, event.thread.spaceId);

  if (event.kind === "margin_click") {
    return decideMargin(deps, person, event.exceptionId, event.decision, event.providerEventId, "button");
  }
  if (event.kind === "approve_click") {
    return approve(deps, person, event.thread, event.receiptId, event.scopeHash, event.providerEventId, "button");
  }
  if (event.kind === "answer_click") return answer(deps, person, event);
  if (event.kind === "control_click") return control(deps, person, event);
  return message(deps, person, event);
}

/** A tapped answer to a question card. The workflow applies it and posts the next question or the receipt. */
async function answer(deps: GatewayDeps, person: Person, event: Extract<InboundEvent, { kind: "answer_click" }>): Promise<WebhookReply> {
  const { store } = deps;
  const receipt = await store.getReceipt(event.receiptId);
  if (!receipt) return reply("I can't find that question any more.");
  const run = await store.getRun(receipt.run_id);
  if (run.person_id !== person.id) return reply("Only the person who made this request can answer its questions.");
  const latest = await store.latestReceipt(run.id);
  if (!OPEN_INTAKE_STATES.includes(run.state) || receipt.superseded_at || latest?.id !== receipt.id) {
    return reply("That question was already answered. Use the latest card.");
  }
  const labels = answerLabels(event.field, event.values);
  if (!labels) return reply(event.values.length ? "That isn't one of the choices. Pick from the card, or type your answer." : "Pick at least one option, then tap Done.");
  if (!(await store.claimMessage(event.platform, event.providerEventId, "answer", run.id))) return silent;
  if ((await signal(deps, run.id, { type: "answer", receiptId: receipt.id, field: event.field, values: event.values })) === "closed") {
    await store.transitionRun(run.id, "FAILED", "system", { error: "workflow is no longer running" });
    return reply("Your previous request in this conversation stopped with an error, so I've closed it. Please send your request again as a new message.");
  }
  return reply(`✓ ${labels.join(", ")}`);
}

/** How long after a budget is finished a "revise …" message still revises it. */
const REVISION_WINDOW_DAYS = 14;
// Only an explicit "revise": in a DM every job shares one conversation, so "change the panel for the Joneses" may be a new job.
const REVISE_WORDS = /^(revise|revision)\b/i;
const EDIT_PROMPT = "What should change? Reply in plain words, for example \"make it 4 eeros\", \"remove the niche\" or \"client is Monica Greene\".";

/** Card controls: edit or restart an open scope, revise a finished budget, or start a new request. */
async function control(deps: GatewayDeps, person: Person, event: Extract<InboundEvent, { kind: "control_click" }>): Promise<WebhookReply> {
  const { store } = deps;
  if (event.control === "edit_scope" || event.control === "start_over") {
    const receipt = await store.getReceipt(event.ref);
    if (!receipt) return reply("I can't find that receipt any more.");
    const run = await store.getRun(receipt.run_id);
    if (run.person_id !== person.id) return reply("Only the person who made this request can change it.");
    if (!OPEN_INTAKE_STATES.includes(run.state)) {
      return reply("That scope is already approved. When the budget is posted, tap \"Revise this budget\" to change it.");
    }
    if (event.control === "edit_scope") return reply(EDIT_PROMPT);
    if (!(await store.claimMessage(event.platform, event.providerEventId, "reset", run.id))) return silent;
    const { staleRunIds } = await store.resetSession(event.thread, person.id);
    for (const runId of staleRunIds) await signal(deps, runId, { type: "invalidate", reason: "session reset" });
    return reply("Cleared. Send the request again whenever you're ready.");
  }
  const run = await store.getRun(event.ref).catch(() => null);
  if (!run) return reply("I can't find that budget any more.");
  if (run.person_id !== person.id) {
    return reply(event.control === "send_retainer" ? "Only the person who made this request can send its retainer." : "Only the person who made this request can revise it.");
  }
  if (event.control === "new_request") {
    await store.clearPendingRevision(event.thread);
    return reply("OK. Send the new request whenever you're ready.");
  }
  if (event.control === "send_retainer") {
    if (run.state !== "READY_HELD") {
      return reply(run.state === "SUPERSEDED" ? "That budget was revised. Send the retainer from the newest one." : "That budget isn't finished yet.");
    }
    if (!(await store.claimMessage(event.platform, event.providerEventId, "retainer", run.id))) return silent;
    await withRetry(() => deps.workflows.startRetainer(run.id, event.providerEventId));
    return reply("Setting up the design retainer in D-Tools. I'll post the opportunity here in a moment.");
  }
  if (run.state !== "READY_HELD") {
    return reply(run.state === "SUPERSEDED" ? "That budget was already revised. Use the newest one." : "That budget isn't finished, so it can't be revised yet.");
  }
  await store.setPendingRevision(event.thread, run.id, person.id);
  return reply(EDIT_PROMPT);
}

/** The finished run a new message revises: one the requester tapped Revise on, or their latest budget when the message starts with "revise". */
async function revisionTarget(deps: GatewayDeps, person: Person, event: Extract<InboundEvent, { kind: "message" }>): Promise<string | null> {
  const { store } = deps;
  const pending = await store.pendingRevision(event.thread);
  if (pending && pending.person_id === person.id) {
    const run = await store.getRun(pending.run_id);
    if (run.state === "READY_HELD") return run.id;
    await store.clearPendingRevision(event.thread);
  }
  if (!REVISE_WORDS.test(event.text.trim())) return null;
  const latest = await store.findLatestFinishedRun(event.thread, REVISION_WINDOW_DAYS);
  return latest && latest.person_id === person.id ? latest.id : null;
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

  const marginText = /^\s*(approve|decline) exception\s+(MX-[A-Z0-9]+)\s*$/i.exec(text);
  if (marginText) {
    if (!(await claim("margin_decision"))) return silent;
    const decision = marginText[1]!.toLowerCase() === "approve" ? "approved" : "declined";
    return decideMargin(deps, person, marginText[2]!.toUpperCase(), decision, event.providerMessageId, "text");
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
    if ((await signal(deps, open.id, { type: "clarification", intakeId: intake.id })) === "closed") {
      // The run's workflow stopped without closing the run (for example after an error): close it, don't go silent.
      await store.transitionRun(open.id, "FAILED", "system", { error: "workflow is no longer running", intakeId: intake.id });
      return reply("Your previous request in this conversation stopped with an error, so I've closed it. Please send your request again as a new message.");
    }
    return silent;
  }

  const building = await store.findBuildingRun(event.thread);
  let closedBuild = false;
  if (building) {
    if (await deps.workflows.isRunning(building.id)) {
      await claim("ignored_building", building.id);
      return reply(
        event.isDirectMessage
          ? "I'm still building the proposal approved in this conversation and will post it here when it's done. Send your next request after that."
          : "The scope in this thread is approved and still being built. Start a new thread for a new request or a scope change.",
      );
    }
    // The build's workflow died (for example on an error before failures were reported): close it so it no longer holds the conversation.
    await store.transitionRun(building.id, "FAILED", "system", { error: "workflow is no longer running", intakeId: intake.id });
    closedBuild = true;
  }

  const parentRunId = await revisionTarget(deps, person, event);
  const started = await store.startRun(intake, parentRunId ? { parentRunId } : {});
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
  return closedBuild ? reply("The previous build in this conversation stopped with an error, so I've closed it. Working on this new request now.") : silent;
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

async function decideMargin(
  deps: GatewayDeps,
  person: Person,
  exceptionId: string,
  decision: "approved" | "declined",
  providerEventId: string,
  method: "button" | "text",
): Promise<WebhookReply> {
  const result = await deps.store.decideMarginException({ exceptionId, deciderPersonId: person.id, decision, providerEventId, method });
  if (!result.ok) return reply(`I can't record that decision: ${result.reason}.`);
  if (result.duplicate) return reply(`${exceptionId} is already ${result.decision}.`);
  // The decision is committed. If this signal is lost the workflow reconciles it from the database.
  await signal(deps, result.runId, { type: "margin_decision", exceptionId, decision });
  return reply(decision === "approved" ? `✅ Margin exception ${exceptionId} approved by ${person.display_name}. The PDF is on its way to the requester.` : `Margin exception ${exceptionId} declined by ${person.display_name}. The run is stopped.`);
}

async function signal(deps: GatewayDeps, runId: string, s: RunSignal): Promise<"delivered" | "closed" | "failed"> {
  try {
    await withRetry(async () => {
      try {
        await deps.workflows.signal(runId, s);
      } catch (err) {
        // A closed workflow will not reopen: retrying only delays the answer.
        if (err instanceof WorkflowClosedError) throw Object.assign(err, { final: true });
        throw err;
      }
    });
    return "delivered";
  } catch (err) {
    await deps.store.appendEvent(runId, "signal_delivery_failed", "system", { signal: s.type, error: String(err) });
    return err instanceof WorkflowClosedError ? "closed" : "failed";
  }
}
