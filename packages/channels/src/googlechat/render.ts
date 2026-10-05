import type { View } from "../types.ts";
import { APPROVE_FUNCTION } from "./parse.ts";

const ICON: Record<string, string> = { done: "✅", active: "⏳", pending: "▫️", failed: "❌" };

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface RenderOptions {
  /**
   * What a card button invokes. Classic Chat apps name a function; apps built
   * as Workspace add-ons must give the HTTP endpoint URL instead. The action
   * name always travels as the "action" parameter, so both formats parse.
   */
  actionFunction?: string;
}

/** Google Chat message body (text + cardsV2) for a view. */
export function renderGoogleChat(view: View, opts: RenderOptions = {}): Record<string, unknown> {
  switch (view.kind) {
    case "text":
      return { text: view.text };
    case "status":
      return {
        text: `${view.title}\n${view.steps.map((s) => `${ICON[s.state]} ${s.label}`).join("\n")}`,
        cardsV2: [
          {
            cardId: "status",
            card: {
              header: { title: view.title },
              sections: [
                {
                  widgets: [
                    { textParagraph: { text: view.steps.map((s) => `${ICON[s.state]} ${escape(s.label)}`).join("<br>") } },
                    ...(view.note ? [{ textParagraph: { text: `<i>${escape(view.note)}</i>` } }] : []),
                  ],
                },
              ],
            },
          },
        ],
      };
    case "receipt": {
      // Lines are rendered verbatim and in order; the plain-text fallback carries the same lines.
      const sections: unknown[] = [{ widgets: [{ textParagraph: { text: view.lines.map(escape).join("<br>") } }] }];
      if (view.approve) {
        sections.push({
          widgets: [
            {
              buttonList: {
                buttons: [
                  {
                    text: `Approve scope ${view.approve.receiptId}`,
                    onClick: {
                      action: {
                        function: opts.actionFunction ?? APPROVE_FUNCTION,
                        parameters: [
                          { key: "action", value: APPROVE_FUNCTION },
                          { key: "receipt_id", value: view.approve.receiptId },
                          { key: "scope_hash", value: view.approve.scopeHash },
                        ],
                      },
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      return {
        text: view.lines.join("\n"),
        cardsV2: [
          {
            cardId: `receipt-${view.receiptId}`,
            card: {
              header: {
                title: `Scope receipt ${view.receiptId}`,
                subtitle: view.status === "AWAITING_APPROVAL" ? "Ready for your approval" : "A few questions first",
              },
              sections,
            },
          },
        ],
      };
    }
  }
}

/** Synchronous webhook reply text, in the envelope the event's format expects. */
export function googleChatReplyBody(text: string, addon: boolean): Record<string, unknown> {
  return addon ? { hostAppDataAction: { chatDataAction: { createMessageAction: { message: { text } } } } } : { text };
}
