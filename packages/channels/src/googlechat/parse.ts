import type { InboundEvent } from "../types.ts";

export const GOOGLE_CHAT = "google_chat";
export const APPROVE_FUNCTION = "approve_scope";

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
  common?: { invokedFunction?: string; parameters?: Record<string, string> };
  action?: { actionMethodName?: string; parameters?: Array<{ key?: string; value?: string }> };
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
  let event: ChatEvent;
  try {
    event = JSON.parse(new TextDecoder().decode(rawBytes)) as ChatEvent;
  } catch {
    return { kind: "ignored", reason: "body is not JSON" };
  }
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
    const fn = event.common?.invokedFunction ?? event.action?.actionMethodName;
    if (fn !== APPROVE_FUNCTION) return { kind: "ignored", reason: `unknown card action ${fn ?? "(none)"}` };
    const params: Record<string, string> = { ...(event.common?.parameters ?? {}) };
    for (const p of event.action?.parameters ?? []) if (p.key && p.value !== undefined) params[p.key] ??= p.value;
    if (!params.receipt_id || !params.scope_hash || !threadId) return { kind: "ignored", reason: "approve click missing parameters" };
    const who = event.user ?? {};
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
