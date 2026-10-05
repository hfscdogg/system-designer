import type { ThreadRef } from "@sd/core";
import type { ChannelAdapter, View } from "./types.ts";

/** In-memory adapter for tests: records everything, honors idempotency keys. */
export class FakeChannelAdapter implements ChannelAdapter {
  readonly platform: string;
  readonly messages = new Map<string, { thread: ThreadRef; view: View; history: View[] }>();
  private readonly byKey = new Map<string, string>();
  private seq = 0;

  constructor(platform = "google_chat") {
    this.platform = platform;
  }

  async post(thread: ThreadRef, view: View, idempotencyKey: string) {
    const existing = this.byKey.get(idempotencyKey);
    if (existing) return { messageId: existing };
    const messageId = `${thread.spaceId}/messages/app-${++this.seq}`;
    this.byKey.set(idempotencyKey, messageId);
    this.messages.set(messageId, { thread, view, history: [view] });
    return { messageId };
  }

  async update(messageId: string, view: View) {
    const m = this.messages.get(messageId);
    if (!m) throw new Error(`unknown message ${messageId}`);
    m.view = view;
    m.history.push(view);
  }

  /** Messages in posting order. */
  list(): Array<{ messageId: string; view: View }> {
    return [...this.messages.entries()].map(([messageId, m]) => ({ messageId, view: m.view }));
  }
}
