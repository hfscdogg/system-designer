import type { QboTokenProvider } from "./token.ts";

/**
 * QuickBooks Online access for the design retainer (Henry, 2026-10-12): find or
 * create the client as a customer, create one invoice on the DESIGN RETAINER
 * item, have QuickBooks email it (with its Pay now link), and read it back to
 * see whether it is paid. Nothing else is created, changed or sent.
 */
export interface QboCustomer {
  Id: string;
  DisplayName: string;
  PrimaryEmailAddr?: { Address?: string };
}

export interface QboInvoice {
  Id: string;
  DocNumber?: string;
  CustomerRef?: { value: string; name?: string };
  TotalAmt?: number;
  Balance?: number;
  /** "EmailSent" once QuickBooks has emailed it. */
  EmailStatus?: string;
  BillEmail?: { Address?: string };
  MetaData?: { CreateTime?: string; LastUpdatedTime?: string };
}

export interface NewRetainerInvoice {
  customerId: string;
  /** The DESIGN RETAINER item. */
  itemId: string;
  amountCents: number;
  description: string;
  /** Our `SD-xxxxxxxx` reference: QuickBooks shows it as the invoice number, and a retry finds the invoice by it. */
  docNumber: string;
  /** Internal note (not shown to the client). */
  privateNote: string;
  billEmail: string;
  customerMemo?: string;
}

export interface QboClient {
  /** Active customers whose primary email is `email`. */
  findCustomersByEmail(email: string): Promise<QboCustomer[]>;
  findCustomerByName(displayName: string): Promise<QboCustomer | null>;
  createCustomer(c: { displayName: string; email: string }): Promise<QboCustomer>;
  findInvoiceByDocNumber(docNumber: string): Promise<QboInvoice | null>;
  createInvoice(i: NewRetainerInvoice): Promise<QboInvoice>;
  /** QuickBooks emails the invoice to `email`. */
  sendInvoice(id: string, email: string): Promise<QboInvoice>;
  getInvoice(id: string): Promise<QboInvoice>;
}

export class QboError extends Error {
  readonly status: number | null;
  readonly endpoint: string;

  constructor(message: string, endpoint: string, status: number | null) {
    super(message);
    this.name = "QboError";
    this.endpoint = endpoint;
    this.status = status;
  }
}

/** A string literal for a QuickBooks query: backslashes and single quotes are escaped with a backslash. */
export function qboLiteral(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

const dollars = (cents: number) => Math.round(cents) / 100;

/** The invoice body: one non-taxable line on the retainer item, card and bank payment on. */
export function invoicePayload(i: NewRetainerInvoice): Record<string, unknown> {
  const amount = dollars(i.amountCents);
  return {
    CustomerRef: { value: i.customerId },
    Line: [
      {
        DetailType: "SalesItemLineDetail",
        Amount: amount,
        Description: i.description,
        SalesItemLineDetail: { ItemRef: { value: i.itemId }, Qty: 1, UnitPrice: amount, TaxCodeRef: { value: "NON" } },
      },
    ],
    DocNumber: i.docNumber,
    PrivateNote: i.privateNote,
    ...(i.customerMemo ? { CustomerMemo: { value: i.customerMemo } } : {}),
    BillEmail: { Address: i.billEmail },
    AllowOnlineCreditCardPayment: true,
    AllowOnlineACHPayment: true,
  };
}

export interface QboHttpConfig {
  realmId: string;
  tokens: QboTokenProvider;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://quickbooks.api.intuit.com";
const MINOR_VERSION = "75";

export function httpQboClient(cfg: QboHttpConfig): QboClient {
  const base = `${(cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}/v3/company/${encodeURIComponent(cfg.realmId)}`;
  const doFetch = cfg.fetch ?? fetch;

  async function call<T>(method: "GET" | "POST", endpoint: string, query: Record<string, string> = {}, body?: { json: unknown } | "empty"): Promise<T> {
    const url = new URL(`${base}/${endpoint}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    url.searchParams.set("minorversion", MINOR_VERSION);
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${await cfg.tokens.accessToken()}`,
            Accept: "application/json",
            ...(body === "empty" ? { "Content-Type": "application/octet-stream" } : body ? { "Content-Type": "application/json" } : {}),
          },
          body: body === "empty" ? "" : body ? JSON.stringify(body.json) : undefined,
          signal: AbortSignal.timeout(cfg.timeoutMs ?? 30_000),
        });
      } catch (err) {
        throw new QboError(`QuickBooks request failed: ${(err as Error).message}`, endpoint, null);
      }
      // An access token revoked early: refresh once and try again.
      if (res.status === 401 && attempt === 0 && cfg.tokens.invalidate) {
        cfg.tokens.invalidate();
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new QboError(`QuickBooks ${endpoint} returned ${res.status}: ${faultMessage(text)}`, endpoint, res.status);
      return JSON.parse(text) as T;
    }
  }

  async function query<K extends string, T>(entity: K, where: string): Promise<T[]> {
    const res = await call<{ QueryResponse?: Partial<Record<K, T[]>> }>("GET", "query", { query: `select * from ${entity} where ${where}` });
    return res.QueryResponse?.[entity] ?? [];
  }

  return {
    findCustomersByEmail: (email) => query<"Customer", QboCustomer>("Customer", `PrimaryEmailAddr = ${qboLiteral(email)} and Active = true`),
    async findCustomerByName(name) {
      return (await query<"Customer", QboCustomer>("Customer", `DisplayName = ${qboLiteral(name)}`))[0] ?? null;
    },
    async createCustomer(c) {
      return (await call<{ Customer: QboCustomer }>("POST", "customer", {}, { json: { DisplayName: c.displayName, PrimaryEmailAddr: { Address: c.email } } })).Customer;
    },
    async findInvoiceByDocNumber(docNumber) {
      return (await query<"Invoice", QboInvoice>("Invoice", `DocNumber = ${qboLiteral(docNumber)}`))[0] ?? null;
    },
    async createInvoice(i) {
      return (await call<{ Invoice: QboInvoice }>("POST", "invoice", {}, { json: invoicePayload(i) })).Invoice;
    },
    async sendInvoice(id, email) {
      return (await call<{ Invoice: QboInvoice }>("POST", `invoice/${encodeURIComponent(id)}/send`, { sendTo: email }, "empty")).Invoice;
    },
    async getInvoice(id) {
      return (await call<{ Invoice: QboInvoice }>("GET", `invoice/${encodeURIComponent(id)}`)).Invoice;
    },
  };
}

/** QuickBooks' own error text ("Duplicate Name Exists Error: …"), short enough for a Chat reply. */
function faultMessage(text: string): string {
  try {
    const e = (JSON.parse(text) as { Fault?: { Error?: Array<{ Message?: string; Detail?: string }> } }).Fault?.Error?.[0];
    if (e) return [e.Message, e.Detail].filter(Boolean).join(": ").slice(0, 300);
  } catch {
    // not JSON
  }
  return text.slice(0, 200);
}

/** An in-memory QuickBooks. For tests. */
export function recordingQboClient(seed: { customers?: QboCustomer[] } = {}): QboClient & {
  customers: QboCustomer[];
  invoices: Array<QboInvoice & { payload: Record<string, unknown> }>;
  sent: Array<{ id: string; email: string }>;
  /** Make the next sends fail, like an outage. */
  failSends: number;
} {
  const customers = [...(seed.customers ?? [])];
  const invoices: Array<QboInvoice & { payload: Record<string, unknown> }> = [];
  const sent: Array<{ id: string; email: string }> = [];
  const fake = {
    customers,
    invoices,
    sent,
    failSends: 0,
    async findCustomersByEmail(email: string) {
      return customers.filter((c) => c.PrimaryEmailAddr?.Address?.toLowerCase() === email.toLowerCase());
    },
    async findCustomerByName(name: string) {
      return customers.find((c) => c.DisplayName === name) ?? null;
    },
    async createCustomer(c: { displayName: string; email: string }) {
      if (customers.some((x) => x.DisplayName === c.displayName)) throw new QboError("QuickBooks customer returned 400: Duplicate Name Exists Error", "customer", 400);
      const created = { Id: String(100 + customers.length), DisplayName: c.displayName, PrimaryEmailAddr: { Address: c.email } };
      customers.push(created);
      return created;
    },
    async findInvoiceByDocNumber(docNumber: string) {
      return invoices.find((i) => i.DocNumber === docNumber) ?? null;
    },
    async createInvoice(i: NewRetainerInvoice) {
      const amount = dollars(i.amountCents);
      const customer = customers.find((c) => c.Id === i.customerId);
      const created = {
        Id: String(500 + invoices.length),
        DocNumber: i.docNumber,
        CustomerRef: { value: i.customerId, ...(customer ? { name: customer.DisplayName } : {}) },
        TotalAmt: amount,
        Balance: amount,
        EmailStatus: "NotSet",
        payload: invoicePayload(i),
      };
      invoices.push(created);
      return created;
    },
    async sendInvoice(id: string, email: string) {
      if (fake.failSends > 0) {
        fake.failSends--;
        throw new QboError("QuickBooks invoice/send returned 503: Service Unavailable", `invoice/${id}/send`, 503);
      }
      const invoice = invoices.find((i) => i.Id === id);
      if (!invoice) throw new QboError("QuickBooks invoice/send returned 400: Object Not Found", `invoice/${id}/send`, 400);
      Object.assign(invoice, { EmailStatus: "EmailSent", BillEmail: { Address: email } });
      sent.push({ id, email });
      return invoice;
    },
    async getInvoice(id: string) {
      const invoice = invoices.find((i) => i.Id === id);
      if (!invoice) throw new QboError("QuickBooks invoice returned 400: Object Not Found", `invoice/${id}`, 400);
      return invoice;
    },
  };
  return fake;
}
