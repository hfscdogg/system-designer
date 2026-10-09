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
    const body = renderGoogleChat(receipt) as { text?: string; fallbackText: string; cardsV2: any[] };
    // The plain-text form is only a fallback: as text it would show the card twice in Chat.
    expect(body.text).toBeUndefined();
    expect(body.fallbackText).toBe(receipt.kind === "receipt" ? receipt.lines.join("\n") : "");
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

describe("margin exception cards", () => {
  it("renders approve and decline buttons that parse back to a margin decision", () => {
    const view: View = { kind: "margin_exception", exceptionId: "MX-ABC", title: "Margin exception MX-ABC", lines: ["Gross margin 36% vs the 40% residential floor."] };
    const body = renderGoogleChat(view, { actionFunction: "https://gateway.example/chat/google" }) as { cardsV2: Array<{ card: { sections: Array<{ widgets: Array<{ buttonList?: { buttons: Array<{ onClick: { action: { function: string; parameters: Array<{ key: string; value: string }> } } }> } }> }> } }> };
    const buttons = body.cardsV2[0]!.card.sections[1]!.widgets[0]!.buttonList!.buttons;
    expect(buttons.map((b) => Object.fromEntries(b.onClick.action.parameters.map((p) => [p.key, p.value])))).toEqual([
      { action: "margin_exception", exception_id: "MX-ABC", decision: "approved" },
      { action: "margin_exception", exception_id: "MX-ABC", decision: "declined" },
    ]);
    const params = Object.fromEntries(buttons[0]!.onClick.action.parameters.map((p) => [p.key, p.value]));
    const event = parseGoogleChatEvent(
      new TextEncoder().encode(
        JSON.stringify({
          type: "CARD_CLICKED",
          space: { name: "spaces/DM", spaceType: "DIRECT_MESSAGE" },
          message: { name: "spaces/DM/messages/1" },
          user: { name: "users/henry", type: "HUMAN" },
          common: { invokedFunction: buttons[0]!.onClick.action.function, parameters: params },
        }),
      ),
    );
    expect(event).toMatchObject({ kind: "margin_click", exceptionId: "MX-ABC", decision: "approved", isDirectMessage: true });
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

  it("posts into a DM without a thread or a reply option (Chat rejects a reply option there)", async () => {
    const calls: Array<{ url: string; data: any }> = [];
    const adapter = new GoogleChatAdapter(async (opts) => {
      calls.push(opts as any);
      return { data: { name: "spaces/DM/messages/app-1", attachmentDataRef: { resourceName: "ref" } } };
    });
    const dm = { platform: "google_chat", spaceId: "spaces/DM", threadId: "spaces/DM" };
    await adapter.post(dm, { kind: "text", text: "hi" }, "run_1:status");
    await adapter.postFile(dm, { bytes: new Uint8Array([1]), filename: "a.pdf", contentType: "application/pdf", text: "pdf" }, "run_1:pdf");
    expect(calls[0]!.url).toBe("https://chat.googleapis.com/v1/spaces/DM/messages?requestId=run_1%3Astatus");
    expect(calls[0]!.data.thread).toBeUndefined();
    expect(calls[2]!.url).toBe("https://chat.googleapis.com/v1/spaces/DM/messages?requestId=run_1%3Apdf");
    expect(calls[2]!.data.thread).toBeUndefined();
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

describe("GoogleChatAdapter.postFile", () => {
  it("uploads multipart, then posts the attachment into the thread idempotently", async () => {
    const appCalls: any[] = [];
    const fileCalls: any[] = [];
    const adapter = new GoogleChatAdapter(
      async (o) => (appCalls.push(o), { data: { name: "x" } }),
      async (o) => {
        fileCalls.push(o);
        return o.url.includes("attachments:upload")
          ? { data: { attachmentDataRef: { resourceName: "ref-123", attachmentUploadToken: "tok" } } }
          : { data: { name: "spaces/A/messages/pdf-1" } };
      },
    );
    const bytes = new TextEncoder().encode("%PDF-1.4 test");
    const out = await adapter.postFile(
      { platform: "google_chat", spaceId: "spaces/A", threadId: "spaces/A/threads/T" },
      { bytes, filename: "proposal.pdf", contentType: "application/pdf", text: "Here it is", actAs: "zack@getlivewire.com" },
      "run_1:pdf",
    );
    expect(out).toEqual({ messageId: "spaces/A/messages/pdf-1", attachmentRef: "ref-123" });
    expect(appCalls).toHaveLength(0); // the file path never uses the app-only transport
    expect(fileCalls[0].url).toBe("https://chat.googleapis.com/upload/v1/spaces/A/attachments:upload?uploadType=multipart");
    expect(fileCalls[0].headers["Content-Type"]).toMatch(/^multipart\/related; boundary=/);
    expect(fileCalls.map((c) => c.subject)).toEqual(["zack@getlivewire.com", "zack@getlivewire.com"]); // acts as the requester
    const body = new TextDecoder().decode(fileCalls[0].data);
    expect(body).toContain('{"filename":"proposal.pdf"}');
    expect(body).toContain("%PDF-1.4 test");
    expect(fileCalls[1].url).toContain("requestId=run_1%3Apdf");
    expect(fileCalls[1].data).toEqual({ text: "Here it is", attachment: [{ attachmentDataRef: { resourceName: "ref-123", attachmentUploadToken: "tok" } }], thread: { name: "spaces/A/threads/T" } });
  });

  it("posts with an upload token when Google returns no resource name, and says what came back when it returns neither", async () => {
    const posted: any[] = [];
    const adapter = (upload: unknown) =>
      new GoogleChatAdapter(
        async () => ({ data: {} }),
        async (o) => (o.url.includes("attachments:upload") ? { data: upload } : (posted.push(o.data), { data: { name: "spaces/DM/messages/pdf" } })),
      );
    const dm = { platform: "google_chat", spaceId: "spaces/DM", threadId: "spaces/DM" };
    const file = { bytes: new TextEncoder().encode("%PDF"), filename: "p.pdf", contentType: "application/pdf", text: "PDF" };
    const out = await adapter({ attachmentDataRef: { attachmentUploadToken: "tok-only" } }).postFile(dm, file, "run_2:pdf");
    expect(out).toEqual({ messageId: "spaces/DM/messages/pdf", attachmentRef: "tok-only" });
    expect(posted[0]).toEqual({ text: "PDF", attachment: [{ attachmentDataRef: { attachmentUploadToken: "tok-only" } }] });
    await expect(adapter({ attachmentDataRef: {} }).postFile(dm, file, "run_3:pdf")).rejects.toThrow('did not return an attachment reference (got ["attachmentDataRef"], ref [])');
  });

  it("requires a service account, and a user to act as, for delegated mode", async () => {
    const { googleFileRequest } = await import("../src/index.ts");
    expect(() => googleFileRequest("delegated", "henry@example.com")).toThrow(/service account/);
    const request = googleFileRequest("delegated", undefined, "sd-worker@p.iam.gserviceaccount.com");
    await expect(request({ url: "https://chat.googleapis.com/v1/spaces/A/messages", method: "POST", data: {} })).rejects.toThrow(/no user to act as/);
  });

  it("signs the delegation JWT through IAM (no key file) and caches the token", async () => {
    const { delegatedRequest } = await import("../src/index.ts");
    const calls: Array<{ url: string; init: any }> = [];
    const fakeFetch = (async (url: string, init: any) => {
      calls.push({ url: String(url), init });
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
      if (String(url).includes(":signJwt")) return json({ signedJwt: "signed.jwt" });
      if (String(url).includes("oauth2.googleapis.com")) return json({ access_token: "user-token", expires_in: 3600 });
      return json({ name: "spaces/A/messages/1" });
    }) as unknown as typeof fetch;
    const request = delegatedRequest({
      serviceAccountEmail: "sd-worker-prod@p.iam.gserviceaccount.com",
      subject: "henry@getlivewire.com",
      scope: "https://www.googleapis.com/auth/chat.messages.create",
      auth: { getAccessToken: async () => "platform-token" },
      fetch: fakeFetch,
      now: () => 1_700_000_000_000,
    });
    await request({ url: "https://chat.googleapis.com/v1/spaces/A/messages", method: "POST", data: { text: "x" } });
    await request({ url: "https://chat.googleapis.com/v1/spaces/A/messages", method: "POST", data: { text: "y" } });
    const claims = JSON.parse(JSON.parse(calls[0]!.init.body).payload);
    expect(claims).toMatchObject({ iss: "sd-worker-prod@p.iam.gserviceaccount.com", sub: "henry@getlivewire.com", scope: "https://www.googleapis.com/auth/chat.messages.create" });
    expect(calls.filter((c) => c.url.includes(":signJwt"))).toHaveLength(1); // token cached
    expect(calls[2]!.init.headers.Authorization).toBe("Bearer user-token");

    // A per-request subject (the requester) gets its own delegated token.
    await request({ url: "https://chat.googleapis.com/v1/spaces/B/messages", method: "POST", data: { text: "z" }, subject: "zack@getlivewire.com" });
    const signs = calls.filter((c) => c.url.includes(":signJwt"));
    expect(signs).toHaveLength(2);
    expect(JSON.parse(JSON.parse(signs[1]!.init.body).payload).sub).toBe("zack@getlivewire.com");
  });
});

describe("Workspace add-on Chat apps", () => {
  const addonMessage = {
    commonEventObject: { hostApp: "CHAT", userLocale: "en" },
    authorizationEventObject: { systemIdToken: "x" },
    chat: {
      user: { name: "users/zack", displayName: "Zack", email: "zack@example.com", type: "HUMAN" },
      eventTime: "2026-10-05T12:00:00Z",
      messagePayload: {
        space: { name: "spaces/DM1", spaceType: "DIRECT_MESSAGE" },
        message: { name: "spaces/DM1/messages/M9", text: "Smith job", sender: { name: "users/zack", type: "HUMAN" }, thread: { name: "spaces/DM1/threads/x" }, createTime: "2026-10-05T12:00:00Z" },
      },
    },
  };

  it("parses add-on message events like classic ones", () => {
    expect(parseGoogleChatEvent(enc(addonMessage))).toMatchObject({
      kind: "message",
      providerMessageId: "spaces/DM1/messages/M9",
      thread: { spaceId: "spaces/DM1", threadId: "spaces/DM1" },
      isDirectMessage: true,
      text: "Smith job",
    });
  });

  it("parses add-on button clicks using the action parameter", () => {
    const click = {
      commonEventObject: { hostApp: "CHAT", parameters: { action: "approve_scope", receipt_id: "R-X-1", scope_hash: "sha256:abc" } },
      chat: {
        user: { name: "users/zack", type: "HUMAN" },
        eventTime: "2026-10-05T12:01:00Z",
        buttonClickedPayload: { space: { name: "spaces/A", spaceType: "SPACE" }, message: { name: "spaces/A/messages/app-1", thread: { name: "spaces/A/threads/T" } } },
      },
    };
    expect(parseGoogleChatEvent(enc(click))).toMatchObject({ kind: "approve_click", receiptId: "R-X-1", scopeHash: "sha256:abc", thread: { threadId: "spaces/A/threads/T" } });
  });

  it("points card buttons at the endpoint URL when configured, and wraps replies", async () => {
    const { googleChatReplyBody } = await import("../src/index.ts");
    const view = { kind: "receipt" as const, receiptId: "R-X-1", version: 1, status: "AWAITING_APPROVAL" as const, lines: ["x"], approve: { receiptId: "R-X-1", scopeHash: "h" } };
    const json = JSON.stringify(renderGoogleChat(view, { actionFunction: "https://gw.example/chat/google" }));
    expect(json).toContain('"function":"https://gw.example/chat/google"');
    expect(json).toContain('{"key":"action","value":"approve_scope"}');
    expect(googleChatReplyBody("hi", true)).toEqual({ hostAppDataAction: { chatDataAction: { createMessageAction: { message: { text: "hi" } } } } });
    expect(googleChatReplyBody("hi", false)).toEqual({ text: "hi" });
  });

  it("accepts the add-on caller only when configured", async () => {
    const { addonIssuer, CHAT_ISSUER } = await import("../src/index.ts");
    const client = { verifyIdToken: async () => ({ getPayload: () => ({ email: addonIssuer("123"), email_verified: true }) }) } as unknown as OAuth2Client;
    const audience = { mode: "endpoint_url" as const, url: "https://gw.example/chat/google" };
    expect(await googleChatVerifier(audience, client)("Bearer t")).toBe(false);
    expect(await googleChatVerifier(audience, client, [CHAT_ISSUER, addonIssuer("123")])("Bearer t")).toBe(true);
  });
});

describe("question cards", () => {
  const base = { kind: "question" as const, receiptId: "R-RUN1-2", question: "Is this a residential or a commercial project?", remaining: 3, lines: ["Scope receipt R-RUN1-2 (version 2)", "Status: NEEDS_CLARIFICATION"] };
  const ACTION = "https://gw.example/chat/google";

  it("offers one button per single choice, keeps the receipt verbatim, and hints that typing works", () => {
    const view: View = { ...base, field: "market", choices: { multi: false, options: [{ value: "residential", label: "Residential" }, { value: "commercial", label: "Commercial" }] } };
    const body = renderGoogleChat(view, { actionFunction: ACTION }) as any;
    expect(body.fallbackText).toBe(base.lines.join("\n"));
    const card = body.cardsV2[0].card;
    expect(card.header.subtitle).toBe("3 questions left · receipt R-RUN1-2");
    const buttons = card.sections[0].widgets.find((w: any) => w.buttonList).buttonList.buttons;
    expect(buttons.map((b: any) => b.text)).toEqual(["Residential", "Commercial"]);
    expect(buttons[0].onClick.action).toEqual({
      function: ACTION,
      parameters: [{ key: "action", value: "answer_question" }, { key: "receipt_id", value: "R-RUN1-2" }, { key: "field", value: "market" }, { key: "value", value: "residential" }],
    });
    expect(JSON.stringify(card)).toContain("Or type your answer in the chat");
    expect(card.sections[1]).toMatchObject({ header: "Scope so far", collapsible: true });
  });

  it("uses checkboxes and a Done button for multiple choices, and plain text for open questions", () => {
    const multi = renderGoogleChat({ ...base, field: "service_categories", choices: { multi: true, options: [{ value: "design", label: "Design" }] } }) as any;
    const widgets = multi.cardsV2[0].card.sections[0].widgets;
    expect(widgets[1].selectionInput).toMatchObject({ name: "answer", type: "CHECK_BOX", items: [{ text: "Design", value: "design", selected: false }] });
    expect(widgets[2].buttonList.buttons[0].text).toBe("Done");
    const open = renderGoogleChat({ ...base, field: "client", question: "Who is the client?", choices: null }) as any;
    expect(JSON.stringify(open)).not.toContain("buttonList");
    expect(JSON.stringify(open)).toContain("Type your answer in the chat");
  });

  it("parses single-choice and checkbox answers from add-on events", () => {
    const click = (parameters: Record<string, string>, formInputs?: unknown) => ({
      commonEventObject: { parameters: { action: "answer_question", receipt_id: "R-RUN1-2", ...parameters }, ...(formInputs ? { formInputs } : {}) },
      chat: { user: { name: "users/zack", type: "HUMAN" }, eventTime: "2026-10-07T21:00:00Z", buttonClickedPayload: { space: { name: "spaces/DM1", spaceType: "DIRECT_MESSAGE" }, message: { name: "spaces/DM1/messages/q1" } } },
    });
    expect(parseGoogleChatEvent(enc(click({ field: "market", value: "residential" })))).toMatchObject({
      kind: "answer_click",
      receiptId: "R-RUN1-2",
      field: "market",
      values: ["residential"],
      thread: { spaceId: "spaces/DM1", threadId: "spaces/DM1" },
    });
    expect(parseGoogleChatEvent(enc(click({ field: "service_categories" }, { answer: { stringInputs: { value: ["design", "installation"] } } })))).toMatchObject({
      kind: "answer_click",
      values: ["design", "installation"],
    });
    expect(parseGoogleChatEvent(enc(click({ field: "service_categories" })))).toMatchObject({ kind: "answer_click", values: [] });
  });
});

describe("conversation controls", () => {
  it("puts Approve, Edit and Start over on an approvable receipt, and Revise / New request under a budget", () => {
    const receipt: View = { kind: "receipt", receiptId: "R-X-1", version: 1, status: "AWAITING_APPROVAL", lines: ["x"], approve: { receiptId: "R-X-1", scopeHash: "sha256:h" } };
    const buttons = (body: any) => body.cardsV2[0].card.sections.flatMap((s: any) => s.widgets).flatMap((w: any) => w.buttonList?.buttons ?? []);
    const params = (b: any) => Object.fromEntries(b.onClick.action.parameters.map((p: any) => [p.key, p.value]));
    const r = buttons(renderGoogleChat(receipt));
    expect(r.map((b: any) => b.text)).toEqual(["Approve", "Edit", "Start over"]);
    expect(params(r[1])).toEqual({ action: "conversation_control", control: "edit_scope", ref: "R-X-1" });
    const a = buttons(renderGoogleChat({ kind: "budget_actions", runId: "run_1", text: "Need changes?" }));
    expect(a.map((b: any) => [b.text, params(b).control])).toEqual([["Revise this budget", "revise_budget"], ["New request", "new_request"]]);
  });

  it("parses a control click and ignores unknown controls", () => {
    const click = (control: string) => ({
      type: "CARD_CLICKED",
      eventTime: "2026-10-05T12:00:00Z",
      space: { name: "spaces/A", spaceType: "DIRECT_MESSAGE" },
      message: { name: "spaces/A/messages/M2" },
      user: { name: "users/zack", type: "HUMAN" },
      common: { invokedFunction: "conversation_control", parameters: { control, ref: "run_1" } },
    });
    expect(parseGoogleChatEvent(enc(click("revise_budget")))).toMatchObject({ kind: "control_click", control: "revise_budget", ref: "run_1", isDirectMessage: true });
    expect(parseGoogleChatEvent(enc(click("delete_everything")))).toMatchObject({ kind: "ignored" });
  });
});
