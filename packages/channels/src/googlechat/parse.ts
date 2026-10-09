import { CONTROL_ACTIONS, type ControlAction, type InboundEvent } from "../types.ts";

export const GOOGLE_CHAT = "google_chat";
export const APPROVE_FUNCTION = "approve_scope";
export const MARGIN_FUNCTION = "margin_exception";
export const ANSWER_FUNCTION = "answer_question";
export const CONTROL_FUNCTION = "conversation_control";
/** Name of the checkbox input on a multi-choice question card. */
export const ANSWER_INPUT = "answer";

type FormInputs = Record<string, { stringInputs?: { value?: string[] } }>;

interface ChatUser {
  name?: string;
  displayName?: string;
  email?: string;
  type?: string;
}

interface ChatEvent {
  type?: string;
  eventTime?: string;
  space?: { name?: string; type?: string; spaceType?: string; singleUserBotDm?: boolean };
  message?: {
    name?: string;
    text?: string;
    argumentText?: string;
    createTime?: string;
    sender?: ChatUser;
    thread?: { name?: string };
    attachment?: Array<{ name?: string; contentName?: string; contentType?: string; attachmentDataRef?: { resourceName?: string } }>;
  };
  user?: ChatUser;
  common?: { invokedFunction?: string; parameters?: Record<string, string>; formInputs?: FormInputs };
  action?: { actionMethodName?: string; parameters?: Array<{ key?: string; value?: string }> };
}

/**
 * Chat apps built as Google Workspace add-ons receive a different envelope:
 * { commonEventObject, authorizationEventObject, chat: { user, eventTime,
 * messagePayload | buttonClickedPayload | ... } }. It is mapped onto the
 * classic shape so the rest of the parser and the gateway stay the same.
 */
interface AddonEvent {
  commonEventObject?: { invokedFunction?: string; parameters?: Record<string, string>; formInputs?: FormInputs };
  chat?: {
    user?: ChatUser;
    eventTime?: string;
    messagePayload?: { space?: ChatEvent["space"]; message?: ChatEvent["message"] };
    buttonClickedPayload?: { space?: ChatEvent["space"]; message?: ChatEvent["message"] };
  };
}

function isAddonEvent(e: ChatEvent & AddonEvent): boolean {
  return typeof e.chat === "object" && e.chat !== null && e.type === undefined;
}

export function isAddonBody(rawBytes: Uint8Array): boolean {
  try {
    return isAddonEvent(JSON.parse(new TextDecoder().decode(rawBytes)));
  } catch {
    return false;
  }
}

function fromAddonEvent(e: AddonEvent): ChatEvent {
  const chat = e.chat!;
  if (chat.messagePayload) {
    return { type: "MESSAGE", eventTime: chat.eventTime, space: chat.messagePayload.space, message: chat.messagePayload.message, user: chat.user };
  }
  if (chat.buttonClickedPayload) {
    return {
      type: "CARD_CLICKED",
      eventTime: chat.eventTime,
      space: chat.buttonClickedPayload.space,
      message: chat.buttonClickedPayload.message,
      user: chat.user,
      common: {
        invokedFunction: e.commonEventObject?.invokedFunction,
        parameters: e.commonEventObject?.parameters ?? {},
        formInputs: e.commonEventObject?.formInputs,
      },
    };
  }
  return { type: "ADDON_OTHER", eventTime: chat.eventTime };
}

const sender = (u: ChatUser | undefined) => ({
  providerUserId: u?.name ?? "",
  email: u?.email ?? null,
  displayName: u?.displayName ?? null,
  isHuman: u?.type === "HUMAN",
});

/**
 * Parse a Google Chat interaction event (HTTP endpoint format). Call only after
 * verifyGoogleChatRequest() has accepted the bearer token.
 */
export function parseGoogleChatEvent(rawBytes: Uint8Array): InboundEvent {
  let parsed: ChatEvent & AddonEvent;
  try {
    parsed = JSON.parse(new TextDecoder().decode(rawBytes)) as ChatEvent & AddonEvent;
  } catch {
    return { kind: "ignored", reason: "body is not JSON" };
  }
  const event = isAddonEvent(parsed) ? fromAddonEvent(parsed) : parsed;
  const spaceId = event.space?.name;
  if (!spaceId) return { kind: "ignored", reason: "event has no space" };
  // In a direct message the whole DM is one conversation: follow-up messages
  // arrive on new threads, so DMs are routed by space, not thread.
  const isDm = event.space?.spaceType === "DIRECT_MESSAGE" || event.space?.type === "DM" || event.space?.singleUserBotDm === true;
  const threadId = isDm ? spaceId : event.message?.thread?.name;

  if (event.type === "MESSAGE") {
    const m = event.message;
    if (!m?.name || !threadId) return { kind: "ignored", reason: "message without name or thread" };
    return {
      kind: "message",
      platform: GOOGLE_CHAT,
      providerMessageId: m.name,
      thread: { platform: GOOGLE_CHAT, spaceId, threadId },
      isDirectMessage: isDm,
      sender: sender(m.sender),
      // argumentText strips the @mention of the app in spaces.
      text: (m.argumentText ?? m.text ?? "").trim(),
      attachments: (m.attachment ?? []).map((a) => ({
        name: a.contentName ?? a.name ?? "attachment",
        contentType: a.contentType ?? null,
        providerRef: a.attachmentDataRef?.resourceName ?? a.name ?? null,
      })),
      providerTime: m.createTime ?? event.eventTime ?? null,
      rawBytes,
    };
  }

  if (event.type === "CARD_CLICKED") {
    const params: Record<string, string> = { ...(event.common?.parameters ?? {}) };
    for (const p of event.action?.parameters ?? []) if (p.key && p.value !== undefined) params[p.key] ??= p.value;
    // Add-on apps invoke the endpoint URL as the "function", so the action name travels as a parameter.
    const fn = params.action ?? event.common?.invokedFunction ?? event.action?.actionMethodName;
    const who = event.user ?? {};
    if (fn === ANSWER_FUNCTION) {
      // A single choice travels as a parameter; checkboxes arrive as form input.
      const values = params.value !== undefined ? [params.value] : (event.common?.formInputs?.[ANSWER_INPUT]?.stringInputs?.value ?? []);
      if (!params.receipt_id || !params.field || !threadId) return { kind: "ignored", reason: "answer click missing parameters" };
      return {
        kind: "answer_click",
        platform: GOOGLE_CHAT,
        providerEventId: `${event.message?.name ?? "?"}#${who.name ?? "?"}@${event.eventTime ?? "?"}`,
        thread: { platform: GOOGLE_CHAT, spaceId, threadId },
        isDirectMessage: isDm,
        sender: sender(who),
        receiptId: params.receipt_id,
        field: params.field,
        values,
      };
    }
    if (fn === MARGIN_FUNCTION) {
      const decision = params.decision;
      if (!params.exception_id || (decision !== "approved" && decision !== "declined") || !threadId) return { kind: "ignored", reason: "margin click missing parameters" };
      return {
        kind: "margin_click",
        platform: GOOGLE_CHAT,
        providerEventId: `${event.message?.name ?? "?"}#${who.name ?? "?"}@${event.eventTime ?? "?"}`,
        thread: { platform: GOOGLE_CHAT, spaceId, threadId },
        isDirectMessage: isDm,
        sender: sender(who),
        exceptionId: params.exception_id,
        decision,
      };
    }
    if (fn === CONTROL_FUNCTION) {
      const control = params.control as ControlAction;
      if (!CONTROL_ACTIONS.includes(control) || !params.ref || !threadId) return { kind: "ignored", reason: "control click missing parameters" };
      return {
        kind: "control_click",
        platform: GOOGLE_CHAT,
        providerEventId: `${event.message?.name ?? "?"}#${who.name ?? "?"}@${event.eventTime ?? "?"}`,
        thread: { platform: GOOGLE_CHAT, spaceId, threadId },
        isDirectMessage: isDm,
        sender: sender(who),
        control,
        ref: params.ref,
      };
    }
    if (fn !== APPROVE_FUNCTION) return { kind: "ignored", reason: `unknown card action ${fn ?? "(none)"}` };
    if (!params.receipt_id || !params.scope_hash || !threadId) return { kind: "ignored", reason: "approve click missing parameters" };
    return {
      kind: "approve_click",
      platform: GOOGLE_CHAT,
      providerEventId: `${event.message?.name ?? "?"}#${who.name ?? "?"}@${event.eventTime ?? "?"}`,
      thread: { platform: GOOGLE_CHAT, spaceId, threadId },
      isDirectMessage: isDm,
      sender: sender(who),
      receiptId: params.receipt_id,
      scopeHash: params.scope_hash,
    };
  }

  return { kind: "ignored", reason: `event type ${event.type ?? "(none)"}` };
}
