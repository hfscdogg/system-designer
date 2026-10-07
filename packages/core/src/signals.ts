/**
 * Signal decisions for the proposal-run workflow. Pure and workflow-safe.
 * The workflow only accepts an approval that names its current receipt and
 * scope hash; anything else is rejected and reported, never retried.
 */
export type ReceiptStatus = "NEEDS_CLARIFICATION" | "AWAITING_APPROVAL";

export interface CurrentReceipt {
  receiptId: string;
  status: ReceiptStatus;
  scopeHash: string | null;
}

export type RunSignal =
  | { type: "clarification"; intakeId: string }
  | { type: "approved"; receiptId: string; scopeHash: string; approvalId: string }
  | { type: "invalidate"; reason: string };

export type SignalDecision =
  | { action: "clarify"; intakeId: string }
  | { action: "approve"; approvalId: string }
  | { action: "reject"; reason: string }
  | { action: "stop"; reason: string };

export function decideSignal(current: CurrentReceipt, signal: RunSignal): SignalDecision {
  switch (signal.type) {
    case "invalidate":
      return { action: "stop", reason: signal.reason };
    case "clarification":
      return { action: "clarify", intakeId: signal.intakeId };
    case "approved":
      if (current.status !== "AWAITING_APPROVAL") {
        return { action: "reject", reason: "receipt has blocking questions and cannot be approved" };
      }
      if (signal.receiptId !== current.receiptId) {
        return { action: "reject", reason: `approval names ${signal.receiptId}, latest receipt is ${current.receiptId}` };
      }
      if (signal.scopeHash !== current.scopeHash) {
        return { action: "reject", reason: "approved scope hash does not match the latest receipt" };
      }
      return { action: "approve", approvalId: signal.approvalId };
  }
}
