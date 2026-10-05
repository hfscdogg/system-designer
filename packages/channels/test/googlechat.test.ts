import { describe, expect, it } from "vitest";
import type { OAuth2Client } from "google-auth-library";
import { GoogleChatAdapter, googleChatVerifier, parseGoogleChatEvent, renderGoogleChat, type View } from "../src/index.ts";

const enc = (x: unknown) => new TextEncoder().encode(JSON.stringify(x));

const messageEvent = {
  type: "MESSAGE",
  eventTime: "2026-10-05T12:00:00Z",
  space: { name: "spaces/A", spaceType: "SPACE" },
  message: {
    name: "spaces/A/messages/M1",
    text: "@System Designer Smith security upgrade",
    argumentText: " Smith security upgrade",
    createTime: "2026-10-05T12:00:00Z",
    sender: { name: "users/zack", displayName: "Zack", email: "zack@example.com", type: "HUMAN" },
    thread: { name: "spaces/A/threads/T" },
    attachment: [{ name: "spaces/A/messages/M1/attachments/1", contentName: "plan.pdf", contentType: "application/pdf", attachmentDataRef: { resourceName: "ref-1" } }],
  },
  user: { name: "users/zack", type: "HUMAN" },
};

describe("parseGoogleChatEvent", () => {
  it("normalizes a message, stripping the @mention and keeping raw bytes", () => {
    const raw = enc(messageEvent);
    const ev = parseGoogleChatEvent(raw);
    expect(ev).toMatchObject({
      kind: "message",
      providerMessageId: "spaces/A/messages/M1",
      thread: { platform: "google_chat", spaceId: "spaces/A", threadId: "spaces/A/threads/T" },
      sender: { providerUserId: "users/zack", isHuman: true },
      text: "Smith security upgrade",
      attachments: [{ name: "plan.pdf", contentType: "application/pdf", providerRef: "ref-1" }],
    });
    if (ev.kind === "message") expect(ev.rawBytes).toBe(raw);
  });

  it("normalizes an approve click", () => {
    const ev = parseGoogleChatEvent(
      enc({
        type: "CARD_CLICKED",
        eventTime: "2026-10-05T12:05:00Z",
        space: { name: "spaces/A" },
        message: { name: "spaces/A/messages/app-2", thread: { name: "spaces/A/threads/T" } },
        user: { name: "users/zack", type: "HUMAN" },
        common: { invokedFunction: "approve_scope", parameters: { receipt_id: "R-X-1", scope_hash: "sha256:abc" } },
      }),
    );
    expect(ev).toMatchObject({ kind: "approve_click", receiptId: "R-X-1", scopeHash: "sha256:abc", sender: { providerUserId: "users/zack" } });
  });

  it("ignores unknown events and malformed bodies", () => {
    expect(parseGoogleChatEvent(enc({ type: "ADDED_TO_SPACE", space: { name: "spaces/A" } })).kind).toBe("ignored");
    expect(parseGoogleChatEvent(new TextEncoder().encode("not json")).kind).toBe("ignored");
    expect(parseGoogleChatEvent(enc({ ...messageEvent, type: "CARD_CLICKED", common: { invokedFunction: "send_to_customer" } })).kind).toBe("ignored");
  });
});

describe("renderGoogleChat", () => {
  const receipt: View = {
    kind: "receipt",
    receiptId: "R-X-1",
    version: 1,
    status: "AWAITING_APPROVAL",
    lines: ["Scope receipt R-X-1 (version 1)", "Client: A & B <Co>", "To approve: Approve scope R-X-1"],
    approve: { receiptId: "R-X-1", scopeHash: "sha256:abc" },
  };

  it("keeps receipt lines verbatim and binds the button to receipt and hash", () => {
    const body = renderGoogleChat(receipt) as { text: string; cardsV2: any[] };
    expect(body.text).toBe(receipt.kind === "receipt" ? receipt.lines.join("\n") : "");
    const json = JSON.stringify(body.cardsV2);
    expect(json).toContain("A &amp; B &lt;Co&gt;");
    expect(json).toContain('"function":"approve_scope"');
    expect(json).toContain('"value":"sha256:abc"');
  });

  it("omits the approve button when the receipt is blocked", () => {
    const body = renderGoogleChat({ ...receipt, status: "NEEDS_CLARIFICATION", approve: null });
    expect(JSON.stringify(body)).not.toContain("approve_scope");
  });
});

describe("GoogleChatAdapter", () => {
  it("posts into the thread with an idempotent requestId and patches messages", async () => {
    const calls: Array<{ url: string; method: string; data: any }> = [];
    const adapter = new GoogleChatAdapter(async (opts) => {
      calls.push(opts as any);
      return { data: { name: "spaces/A/messages/app-1" } };
    });
    const thread = { platform: "google_chat", spaceId: "spaces/A", threadId: "spaces/A/threads/T" };
    const { messageId } = await adapter.post(thread, { kind: "text", text: "hi" }, "run_1:status");
    await adapter.update(messageId, { kind: "status", title: "Run", steps: [{ label: "Reading", state: "active" }], note: null });
    expect(calls[0]!.url).toBe(
      "https://chat.googleapis.com/v1/spaces/A/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD&requestId=run_1%3Astatus",
    );
    expect(calls[0]!.data.thread).toEqual({ name: "spaces/A/threads/T" });
    expect(calls[1]).toMatchObject({ method: "PATCH", url: "https://chat.googleapis.com/v1/spaces/A/messages/app-1?updateMask=text,cardsV2" });
    await expect(adapter.post({ ...thread, platform: "telegram" }, { kind: "text", text: "x" }, "k")).rejects.toThrow();
  });
});

describe("googleChatVerifier", () => {
  const fakeClient = (payload: Record<string, unknown> | Error) =>
    ({
      verifyIdToken: async () => {
        if (payload instanceof Error) throw payload;
        return { getPayload: () => payload };
      },
    }) as unknown as OAuth2Client;
  const audience = { mode: "endpoint_url" as const, url: "https://sd.example.com/chat/google" };

  it("accepts only tokens issued to the Chat system account", async () => {
    expect(await googleChatVerifier(audience, fakeClient({ email: "chat@system.gserviceaccount.com", email_verified: true }))("Bearer t")).toBe(true);
    expect(await googleChatVerifier(audience, fakeClient({ email: "attacker@example.com", email_verified: true }))("Bearer t")).toBe(false);
    expect(await googleChatVerifier(audience, fakeClient(new Error("bad signature")))("Bearer t")).toBe(false);
    expect(await googleChatVerifier(audience, fakeClient({}))(undefined)).toBe(false);
  });
});
