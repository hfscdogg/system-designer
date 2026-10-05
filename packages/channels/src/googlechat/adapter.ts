import { GoogleAuth } from "google-auth-library";
import type { ThreadRef } from "@sd/core";
import type { ChannelAdapter, View } from "../types.ts";
import { GOOGLE_CHAT } from "./parse.ts";
import { renderGoogleChat } from "./render.ts";

const API = "https://chat.googleapis.com/v1";
const SCOPE = "https://www.googleapis.com/auth/chat.bot";

export type HttpRequest = (opts: { url: string; method: "POST" | "PATCH"; data: unknown }) => Promise<{ data: unknown }>;

/** Default transport: app authentication with the Chat app's service account. */
export function googleAppAuthRequest(): HttpRequest {
  const auth = new GoogleAuth({ scopes: [SCOPE] });
  return async (opts) => {
    const client = await auth.getClient();
    const res = await client.request({ url: opts.url, method: opts.method, data: opts.data });
    return { data: res.data };
  };
}

export class GoogleChatAdapter implements ChannelAdapter {
  readonly platform = GOOGLE_CHAT;
  private readonly request: HttpRequest;

  constructor(request: HttpRequest = googleAppAuthRequest()) {
    this.request = request;
  }

  async post(thread: ThreadRef, view: View, idempotencyKey: string) {
    if (thread.platform !== GOOGLE_CHAT) throw new Error(`thread is on ${thread.platform}, not ${GOOGLE_CHAT}`);
    // requestId makes create idempotent: a retry returns the message created the first time.
    const params = new URLSearchParams({
      messageReplyOption: "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
      requestId: idempotencyKey.slice(0, 128),
    });
    const res = await this.request({
      url: `${API}/${thread.spaceId}/messages?${params}`,
      method: "POST",
      // DM conversations are keyed by space (threadId === spaceId) and post without a thread.
      data: thread.threadId === thread.spaceId ? renderGoogleChat(view) : { ...renderGoogleChat(view), thread: { name: thread.threadId } },
    });
    const name = (res.data as { name?: string }).name;
    if (!name) throw new Error("Google Chat did not return a message name");
    return { messageId: name };
  }

  async update(messageId: string, view: View) {
    const body = renderGoogleChat(view);
    const mask = "cardsV2" in body ? "text,cardsV2" : "text";
    await this.request({ url: `${API}/${messageId}?updateMask=${mask}`, method: "PATCH", data: body });
  }
}
