import { formatUsd } from "@sd/build";
import type { QboClient } from "@sd/qbo";
import type { RunRecord, Store } from "@sd/store";
import type { RetainerInvoiceRecord } from "./retainer.ts";

/**
 * Find design-retainer invoices the client has paid. For each retainer QuickBooks
 * emailed and nobody has recorded as paid, read the invoice: a zero balance on a
 * non-zero total is a payment. Record it as the run's retainer/payment artifact
 * and tell the budget's thread once: the post is keyed by run and made before
 * the record, so a pass that fails in between repeats the same post, which Chat
 * de-duplicates. Read-only in QuickBooks.
 */
const MAX_AGE_DAYS = 180;

export interface RetainerPayment {
  paid_at: string;
  amount_cents: number;
  invoice_id: string;
  doc_number: string;
}

export async function checkRetainerPayments(
  store: Store,
  qbo: QboClient,
  notify: ((run: RunRecord, text: string, key: string) => Promise<void>) | null,
  now: () => Date = () => new Date(),
): Promise<{ checked: number; paid: number; failed: string[] }> {
  const runIds = await store.runsAwaitingRetainerPayment(MAX_AGE_DAYS);
  let paid = 0;
  const failed: string[] = [];
  for (const runId of runIds) {
    try {
      const sent = await store.readArtifact<RetainerInvoiceRecord>(runId, "retainer", "invoice");
      if (!sent) continue;
      const invoice = await qbo.getInvoice(sent.qbo_invoice_id);
      const total = Math.round((invoice.TotalAmt ?? 0) * 100);
      if (!(total > 0 && invoice.Balance === 0)) continue;
      const payment: RetainerPayment = {
        paid_at: invoice.MetaData?.LastUpdatedTime ? new Date(invoice.MetaData.LastUpdatedTime).toISOString() : now().toISOString(),
        amount_cents: total,
        invoice_id: invoice.Id,
        doc_number: invoice.DocNumber ?? sent.qbo_doc_number,
      };
      if (notify) await notify(await store.getRun(runId), `✓ Design retainer paid: ${formatUsd(total)} (QuickBooks invoice ${payment.doc_number}).`, `${runId}:retainer:paid`);
      await store.publishArtifact(runId, "retainer", "payment", payment);
      paid++;
    } catch (err) {
      failed.push(runId);
      await store.appendEvent(runId, "retainer_payment_check_failed", "system", { error: String(err) });
    }
  }
  return { checked: runIds.length, paid, failed };
}
