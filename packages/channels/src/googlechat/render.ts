import type { View } from "../types.ts";
import { ANSWER_FUNCTION, ANSWER_INPUT, APPROVE_FUNCTION, MARGIN_FUNCTION } from "./parse.ts";

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

/**
 * Google Chat message body for a view. Cards carry their plain-text form as
 * fallbackText (used for notifications and clients without cards): sending it
 * as text as well would show every card twice.
 */
export function renderGoogleChat(view: View, opts: RenderOptions = {}): Record<string, unknown> {
  switch (view.kind) {
    case "text":
      return { text: view.text };
    case "status":
      return {
        fallbackText: `${view.title}\n${view.steps.map((s) => `${ICON[s.state]} ${s.label}`).join("\n")}`,
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
    case "margin_exception": {
      const button = (text: string, decision: "approved" | "declined") => ({
        text,
        onClick: {
          action: {
            function: opts.actionFunction ?? MARGIN_FUNCTION,
            parameters: [
              { key: "action", value: MARGIN_FUNCTION },
              { key: "exception_id", value: view.exceptionId },
              { key: "decision", value: decision },
            ],
          },
        },
      });
      return {
        fallbackText: [view.title, ...view.lines, `Reply "approve exception ${view.exceptionId}" or "decline exception ${view.exceptionId}".`].join("\n"),
        cardsV2: [
          {
            cardId: `margin-${view.exceptionId}`,
            card: {
              header: { title: view.title, subtitle: "Internal — below the margin floor" },
              sections: [
                { widgets: [{ textParagraph: { text: view.lines.map(escape).join("<br>") } }] },
                { widgets: [{ buttonList: { buttons: [button("Approve exception", "approved"), button("Decline", "declined")] } }] },
              ],
            },
          },
        ],
      };
    }
    case "question": {
      // The recommended choice comes first and says so, like a good assistant's question.
      const options = [...(view.choices?.options ?? [])]
        .sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended))
        .map((o) => ({ ...o, label: o.recommended ? `${o.label} (Recommended)` : o.label }));
      const action = (extra: Array<{ key: string; value: string }>) => ({
        action: {
          function: opts.actionFunction ?? ANSWER_FUNCTION,
          parameters: [{ key: "action", value: ANSWER_FUNCTION }, { key: "receipt_id", value: view.receiptId }, { key: "field", value: view.field }, ...extra],
        },
      });
      const widgets: unknown[] = [{ textParagraph: { text: `<b>${escape(view.question)}</b>` } }];
      if (view.choices?.multi) {
        widgets.push({
          selectionInput: {
            name: ANSWER_INPUT,
            label: "Pick all that apply",
            type: "CHECK_BOX",
            items: options.map((o) => ({ text: o.label, value: o.value, selected: !!o.recommended })),
          },
        });
        widgets.push({ buttonList: { buttons: [{ text: "Done", onClick: action([]) }] } });
      } else if (view.choices) {
        widgets.push({
          buttonList: {
            buttons: options.map((o) => ({
              text: o.label,
              onClick: action([{ key: "value", value: o.value }]),
            })),
          },
        });
      }
      widgets.push({ textParagraph: { text: `<i>${view.choices ? "Or type" : "Type"} your answer in the chat. You can answer several questions in one message.</i>` } });
      return {
        // The plain-text form is the full receipt, verbatim (PRD §9.2).
        fallbackText: view.lines.join("\n"),
        cardsV2: [
          {
            cardId: `question-${view.receiptId}`,
            card: {
              header: {
                title: "Quick question",
                subtitle: `${view.remaining} question${view.remaining === 1 ? "" : "s"} left · receipt ${view.receiptId}`,
              },
              sections: [
                { widgets },
                {
                  header: "Scope so far",
                  collapsible: true,
                  uncollapsibleWidgetsCount: 0,
                  widgets: [{ textParagraph: { text: view.lines.map(escape).join("<br>") } }],
                },
              ],
            },
          },
        ],
      };
    }
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
        fallbackText: view.lines.join("\n"),
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
