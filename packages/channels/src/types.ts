import type { ThreadRef } from "@sd/core";

/** A provider event, normalized. Produced only after the provider's auth is verified. */
export type InboundEvent =
  | {
      kind: "message";
      platform: string;
      providerMessageId: string;
      thread: ThreadRef;
      /** A 1:1 conversation between the app and the sender. */
      isDirectMessage: boolean;
      sender: { providerUserId: string; email: string | null; displayName: string | null; isHuman: boolean };
      text: string;
      attachments: Array<{ name: string; contentType: string | null; providerRef: string | null }>;
      providerTime: string | null;
      rawBytes: Uint8Array;
    }
  | {
      kind: "approve_click";
      platform: string;
      /** Stable id for the click, for audit; approvals are unique per receipt regardless. */
      providerEventId: string;
      thread: ThreadRef;
      isDirectMessage: boolean;
      sender: { providerUserId: string; email: string | null; displayName: string | null; isHuman: boolean };
      receiptId: string;
      scopeHash: string;
    }
  | {
      kind: "margin_click";
      platform: string;
      providerEventId: string;
      thread: ThreadRef;
      isDirectMessage: boolean;
      sender: { providerUserId: string; email: string | null; displayName: string | null; isHuman: boolean };
      exceptionId: string;
      decision: "approved" | "declined";
    }
  | { kind: "ignored"; reason: string };

export type StepState = "done" | "active" | "pending" | "failed";

/** Platform-neutral things the app can show. Adapters render them natively. */
export type View =
  | { kind: "text"; text: string }
  | {
      kind: "receipt";
      receiptId: string;
      version: number;
      status: "NEEDS_CLARIFICATION" | "AWAITING_APPROVAL";
      /** Shown verbatim and in order (PRD §9.2). */
      lines: string[];
      approve: { receiptId: string; scopeHash: string } | null;
    }
  | { kind: "status"; title: string; steps: Array<{ label: string; state: StepState }>; note: string | null }
  /** Internal, admin-only: a build below the margin floor, with approve/decline buttons. */
  | { kind: "margin_exception"; exceptionId: string; title: string; lines: string[] };

export interface ChannelAdapter {
  readonly platform: string;
  /** Post into a thread. Same idempotencyKey => same message, never a duplicate. */
  post(thread: ThreadRef, view: View, idempotencyKey: string): Promise<{ messageId: string }>;
  /** Replace a message the app posted (used for the live status card). */
  update(messageId: string, view: View): Promise<void>;
  /** Post a file into a thread. Same idempotencyKey => same message. */
  postFile(thread: ThreadRef, file: OutboundFile, idempotencyKey: string): Promise<{ messageId: string; attachmentRef: string }>;
}

export interface OutboundFile {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
  /** Message text that accompanies the file. */
  text: string;
  /** Workspace email of the person a delegated upload acts as (the requester). */
  actAs?: string;
}

/** Synchronous reply to a provider webhook. */
export type WebhookReply = { status: number; body: unknown };
