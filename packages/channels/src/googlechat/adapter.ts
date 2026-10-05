import { GoogleAuth } from "google-auth-library";
import type { ThreadRef } from "@sd/core";
import type { ChannelAdapter, OutboundFile, View } from "../types.ts";
import { GOOGLE_CHAT } from "./parse.ts";
import { renderGoogleChat } from "./render.ts";

const API = "https://chat.googleapis.com/v1";
const UPLOAD_API = "https://chat.googleapis.com/upload/v1";
const BOT_SCOPE = "https://www.googleapis.com/auth/chat.bot";
const USER_CREATE_SCOPE = "https://www.googleapis.com/auth/chat.messages.create";

export type HttpRequest = (opts: {
  url: string;
  method: "POST" | "PATCH";
  data: unknown;
  headers?: Record<string, string>;
}) => Promise<{ data: unknown }>;

function authRequest(auth: GoogleAuth): HttpRequest {
  return async (opts) => {
    const client = await auth.getClient();
    const res = await client.request({ url: opts.url, method: opts.method, data: opts.data, headers: opts.headers });
    return { data: res.data };
  };
}

/** Default transport: app authentication with the Chat app's service account. */
export function googleAppAuthRequest(): HttpRequest {
  return authRequest(new GoogleAuth({ scopes: [BOT_SCOPE] }));
}

/**
 * File transport. "app" uploads as the Chat app itself. "delegated" uses the
 * same service account with domain-wide delegation, scoped to creating Chat
 * messages only, acting as an existing Workspace user (no extra seat).
 */
export function googleFileRequest(mode: "app" | "delegated", delegatedUser?: string, serviceAccountEmail?: string): HttpRequest {
  if (mode === "app") return googleAppAuthRequest();
  if (!delegatedUser) throw new Error("delegated upload mode needs GOOGLE_CHAT_DELEGATED_USER");
  if (!serviceAccountEmail) throw new Error("delegated upload mode needs the worker's service account email");
  return delegatedRequest({ serviceAccountEmail, subject: delegatedUser, scope: USER_CREATE_SCOPE });
}

type Fetch = typeof fetch;

/**
 * Domain-wide delegation without a key file. Cloud Run has no private key, so
 * the service account signs the delegation JWT through the IAM Credentials API
 * (it needs roles/iam.serviceAccountTokenCreator on itself), then exchanges it
 * for a token acting as `subject`.
 */
export function delegatedRequest(opts: {
  serviceAccountEmail: string;
  subject: string;
  scope: string;
  auth?: { getAccessToken(): Promise<string | null | undefined> };
  fetch?: Fetch;
  now?: () => number;
}): HttpRequest {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const auth = opts.auth ?? new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  let cached: { token: string; expiresAt: number } | null = null;

  async function token(): Promise<string> {
    if (cached && cached.expiresAt - 60_000 > now()) return cached.token;
    const iat = Math.floor(now() / 1000);
    const claims = { iss: opts.serviceAccountEmail, sub: opts.subject, scope: opts.scope, aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 };
    const platformToken = await auth.getAccessToken();
    const signed = await doFetch(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(opts.serviceAccountEmail)}:signJwt`,
      { method: "POST", headers: { Authorization: `Bearer ${platformToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ payload: JSON.stringify(claims) }) },
    );
    if (!signed.ok) throw new Error(`signJwt failed: ${signed.status}`);
    const { signedJwt } = (await signed.json()) as { signedJwt: string };
    const exchanged = await doFetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signedJwt }),
    });
    if (!exchanged.ok) throw new Error(`delegated token exchange failed: ${exchanged.status} (is domain-wide delegation configured for this scope?)`);
    const body = (await exchanged.json()) as { access_token: string; expires_in: number };
    cached = { token: body.access_token, expiresAt: now() + body.expires_in * 1000 };
    return cached.token;
  }

  return async ({ url, method, data, headers }) => {
    const isBytes = data instanceof Uint8Array;
    const res = await doFetch(url, {
      method,
      headers: { Authorization: `Bearer ${await token()}`, ...(isBytes ? {} : { "Content-Type": "application/json" }), ...headers },
      body: isBytes ? Buffer.from(data as Uint8Array) : JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`Google Chat ${method} ${new URL(url).pathname} failed: ${res.status}`);
    return { data: await res.json() };
  };
}

function multipartRelated(metadata: unknown, file: Uint8Array, contentType: string): { body: Uint8Array; boundary: string } {
  const boundary = `sd_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + file.length + tail.length);
  body.set(head, 0);
  body.set(file, head.length);
  body.set(tail, head.length + file.length);
  return { body, boundary };
}

export class GoogleChatAdapter implements ChannelAdapter {
  readonly platform = GOOGLE_CHAT;
  private readonly request: HttpRequest;
  private readonly fileRequest: HttpRequest;

  constructor(request: HttpRequest = googleAppAuthRequest(), fileRequest: HttpRequest = request) {
    this.request = request;
    this.fileRequest = fileRequest;
  }

  async postFile(thread: ThreadRef, file: OutboundFile, idempotencyKey: string) {
    if (thread.platform !== GOOGLE_CHAT) throw new Error(`thread is on ${thread.platform}, not ${GOOGLE_CHAT}`);
    const { body, boundary } = multipartRelated({ filename: file.filename }, file.bytes, file.contentType);
    const uploaded = await this.fileRequest({
      url: `${UPLOAD_API}/${thread.spaceId}/attachments:upload?uploadType=multipart`,
      method: "POST",
      data: body,
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    });
    const ref = (uploaded.data as { attachmentDataRef?: { resourceName?: string } }).attachmentDataRef;
    if (!ref?.resourceName) throw new Error("Google Chat did not return an attachment reference");
    const params = new URLSearchParams({
      messageReplyOption: "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
      requestId: idempotencyKey.slice(0, 128),
    });
    const created = await this.fileRequest({
      url: `${API}/${thread.spaceId}/messages?${params}`,
      method: "POST",
      data: {
        text: file.text,
        attachment: [{ attachmentDataRef: ref }],
        ...(thread.threadId === thread.spaceId ? {} : { thread: { name: thread.threadId } }),
      },
    });
    const name = (created.data as { name?: string }).name;
    if (!name) throw new Error("Google Chat did not return a message name");
    return { messageId: name, attachmentRef: ref.resourceName };
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
