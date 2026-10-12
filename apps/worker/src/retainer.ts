import { DESIGN_RETAINER_PCT, formatUsd, type CustomerProposal } from "@sd/build";
import type { DToolsReader, DToolsWriter } from "@sd/dtools";
import { QboError, type QboClient, type QboCustomer, type QboInvoice } from "@sd/qbo";
import type { RunRecord, Store } from "@sd/store";

/**
 * "Send design retainer" (Henry, 2026-10-12): create the D-Tools opportunity the
 * job is tracked under, then invoice the retainer from QuickBooks Online on the
 * DESIGN RETAINER item and have QuickBooks email it to the address the rep typed
 * (never one a model wrote). Idempotent per budget: the opportunity is found by
 * the budget's SD- reference before anything is created, the invoice by its
 * DocNumber (the same reference), and once retainer/invoice records the send,
 * a later request only repeats the reply.
 */
export interface RetainerDeps {
  store: Store;
  dtools: DToolsReader;
  writer: DToolsWriter | null;
  /** QuickBooks Online; null where it is not switched on (SD_QBO_RETAINER). */
  qbo?: QboClient | null;
  notify: (run: RunRecord, text: string, key: string) => Promise<void>;
  now?: () => Date;
}

/** The D-Tools opportunity, as the run's retainer/opportunity artifact. */
export interface RetainerRecord {
  opportunity_id: string;
  number: string | null;
  name: string;
  retainer_cents: number;
  /** What the amount is 4% of, for the reply ("the low estimate, $14,075.00"). */
  basis?: string;
  /** Before 2026-10-12 the retainer was a D-Tools quote from this template. */
  quote_template?: string;
  quote_price_cents?: number | null;
}

/**
 * The QuickBooks invoice QuickBooks emailed, as the run's retainer/invoice
 * artifact. Artifacts are immutable, so it is published once, after the send.
 */
export interface RetainerInvoiceRecord {
  qbo_customer_id: string;
  qbo_customer_name: string | null;
  qbo_invoice_id: string;
  qbo_doc_number: string;
  amount_cents: number;
  sent_to: string;
  sent_at: string;
}

/** The QuickBooks "DESIGN RETAINER" item, when the commercial policy names none. */
export const DEFAULT_QBO_RETAINER_ITEM_ID = "3649";
/** The item's own description text, completed with the budget. */
const ITEM_TEXT = `Design Retainer: ${DESIGN_RETAINER_PCT}% Deposit Against Estimated Total Budget of`;
const TERMS = "Non-refundable; applied in full toward your final project value.";

const json = (read: { body: Uint8Array }) => JSON.parse(new TextDecoder().decode(read.body)) as Record<string, unknown>;
const wholeUsd = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;

/** The invoice line: "Design Retainer: 4% Deposit Against Estimated Total Budget of $14,075 – $17,200. Non-refundable; …" */
export function retainerDescription(c: CustomerProposal["commercial"]): string {
  const budget = c.likely_range ? `${wholeUsd(c.likely_range.low_cents)} – ${wholeUsd(c.likely_range.high_cents)}` : wholeUsd(c.total_cents ?? c.subtotal_cents);
  return `${ITEM_TEXT} ${budget}. ${TERMS}`;
}

/**
 * `tap` identifies the request (the rep's email message), so each gets its own
 * reply and a retry of one does not post twice. `email` is the address the rep
 * typed; a request started before emails were asked for has none, and skips QuickBooks.
 */
export async function createRetainer(deps: RetainerDeps, runId: string, tap: string, email?: string): Promise<void> {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const run = await store.getRun(runId);
  const say = (text: string, suffix: string) => deps.notify(run, text, `${runId}:retainer:${tap}:${suffix}`);
  if (run.state !== "READY_HELD") {
    await say(run.state === "SUPERSEDED" ? "That budget was revised. Send the retainer from the newest one." : "That budget isn't finished yet.", "not-ready");
    return;
  }
  const sent = await store.readArtifact<RetainerInvoiceRecord>(runId, "retainer", "invoice");
  const done = await store.readArtifact<RetainerRecord>(runId, "retainer", "opportunity");
  if (sent && done) return say(sentMessage(done, sent), "ready");
  if (!deps.writer || !deps.dtools.getOpportunity || !deps.dtools.findOpportunities) {
    return say("Sending the retainer isn't switched on here yet. Create it in D-Tools and QuickBooks by hand for now.", "off");
  }

  const view = await store.readArtifact<CustomerProposal>(runId, "validate", "customer_view");
  if (!view) throw new Error(`run ${runId} has no customer view`);
  const c = view.commercial;
  const cents = c.retainer.cents;
  const ref = `SD-${runId.slice(4, 12)}`;
  const name = `Design Retainer · ${view.client} · ${ref}`;

  let record = done;
  if (!record) {
    // A retry after a lost response must not create a second opportunity.
    const found = json(await deps.dtools.findOpportunities(ref)).opportunities as Array<{ id: string; name?: string }> | undefined;
    const existing = found?.find((o) => o.name?.includes(ref));
    const id =
      existing?.id ??
      (await deps.writer.createOpportunity({
        name,
        clientName: view.client,
        budget: Math.round((c.total_cents ?? c.subtotal_cents) / 100),
      }));
    // Read back the number reps search by.
    const opp = json(await deps.dtools.getOpportunity(id));
    record = {
      opportunity_id: id,
      number: typeof opp.number === "string" ? opp.number : null,
      name: typeof opp.name === "string" ? opp.name : name,
      retainer_cents: cents,
      basis: c.likely_range ? `the low estimate, ${formatUsd(c.likely_range.low_cents)}` : `the budget, ${formatUsd(c.total_cents ?? c.subtotal_cents)}`,
    };
    await store.publishArtifact(runId, "retainer", "opportunity", record);
  }

  if (!deps.qbo || !email) {
    const why = !deps.qbo ? "The QuickBooks invoice isn't switched on here yet" : "No email address came with this request";
    return say(`${why}, so send the design retainer from QuickBooks by hand for ${formatUsd(cents)}${of(record)}. D-Tools ${where(record)} is set up for the real quote.`, "manual");
  }

  const qbo = deps.qbo;
  let invoice: QboInvoice;
  let customer: { Id: string; DisplayName: string | null };
  try {
    // A retry finds the invoice by its number (our reference) instead of creating a second one.
    const existing = await qbo.findInvoiceByDocNumber(ref);
    if (existing) {
      invoice = existing;
      customer = { Id: existing.CustomerRef?.value ?? "", DisplayName: existing.CustomerRef?.name ?? null };
    } else {
      customer = await findOrCreateCustomer(qbo, view.client, email);
      invoice = await qbo.createInvoice({
        customerId: customer.Id,
        itemId: await retainerItemId(store),
        amountCents: cents,
        description: retainerDescription(c),
        docNumber: ref,
        privateNote: `System Designer ${ref}; D-Tools opportunity ${record.number ?? record.opportunity_id}.`,
        billEmail: email,
      });
    }
  } catch (err) {
    if (!(err instanceof QboError)) throw err;
    await store.appendEvent(runId, "retainer_qbo_failed", "system", { error: err.message, endpoint: err.endpoint, status: err.status });
    return say(
      `⚠️ QuickBooks didn't take the design retainer (${err.message}). Nothing was emailed. D-Tools ${where(record)} is set up; tap "Send design retainer" again to retry.`,
      "qbo-failed",
    );
  }

  const doc = invoice.DocNumber ?? ref;
  // A send whose response was lost already went out: don't email the client twice.
  const alreadySent = invoice.EmailStatus === "EmailSent" && invoice.BillEmail?.Address?.toLowerCase() === email.toLowerCase();
  if (!alreadySent) {
    try {
      await qbo.sendInvoice(invoice.Id, email);
    } catch (err) {
      if (!(err instanceof QboError)) throw err;
      await store.appendEvent(runId, "retainer_send_failed", "system", { error: err.message, invoice: invoice.Id, status: err.status });
      return say(
        `⚠️ QuickBooks invoice ${doc} for ${formatUsd(cents)} is created, but sending it to ${email} failed (${err.message}). Tap "Send design retainer" again to retry; it sends the same invoice.`,
        "send-failed",
      );
    }
  }
  const invoiceRecord: RetainerInvoiceRecord = {
    qbo_customer_id: customer.Id,
    qbo_customer_name: customer.DisplayName,
    qbo_invoice_id: invoice.Id,
    qbo_doc_number: doc,
    amount_cents: cents,
    sent_to: email,
    sent_at: now().toISOString(),
  };
  await store.publishArtifact(runId, "retainer", "invoice", invoiceRecord);
  await say(sentMessage(record, invoiceRecord), "ready");
}

/**
 * The client's QuickBooks customer: the one active customer with this email;
 * otherwise a new one named after the client, or "Client (email)" when that
 * name already belongs to someone else.
 */
async function findOrCreateCustomer(qbo: QboClient, client: string, email: string): Promise<QboCustomer> {
  const byEmail = await qbo.findCustomersByEmail(email);
  if (byEmail.length === 1) return byEmail[0]!;
  const named = byEmail.find((x) => x.DisplayName === client);
  if (named) return named;
  const taken = await qbo.findCustomerByName(client);
  if (!taken) return qbo.createCustomer({ displayName: client, email });
  const alt = `${client} (${email})`;
  return (await qbo.findCustomerByName(alt)) ?? qbo.createCustomer({ displayName: alt, email });
}

/** The DESIGN RETAINER item id from the latest commercial policy, so a new item needs no deploy. */
async function retainerItemId(store: Store): Promise<string> {
  const latest = await store.latestPolicy();
  return (latest?.policy as { retainer?: { qbo_item_id?: string } } | undefined)?.retainer?.qbo_item_id ?? DEFAULT_QBO_RETAINER_ITEM_ID;
}

const where = (r: RetainerRecord) => `opportunity ${r.number ?? r.opportunity_id}`;
const of = (r: RetainerRecord) => (r.basis ? ` (${DESIGN_RETAINER_PCT}% of ${r.basis})` : "");

function sentMessage(r: RetainerRecord, i: RetainerInvoiceRecord): string {
  const customer = i.qbo_customer_name ? `, customer "${i.qbo_customer_name}"` : "";
  return `Design retainer ${formatUsd(i.amount_cents)}${of(r)} sent to ${i.sent_to} from QuickBooks (invoice ${i.qbo_doc_number}${customer}). D-Tools ${where(r)} is set up for the real quote.`;
}
