import { describe, expect, it } from "vitest";
import { httpQboClient, invoicePayload, oauthTokenProvider, qboLiteral, QboError, secretManagerRefreshTokens, type RefreshTokenStore } from "../src/index.ts";

type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined };

/** A fetch that records requests and answers from `respond`. */
function fakeFetch(respond: (c: Call) => { status?: number; json?: unknown }) {
  const calls: Call[] = [];
  const f = (async (input: string | URL, init?: RequestInit) => {
    const call = { url: String(input), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body as string | undefined };
    calls.push(call);
    const r = respond(call);
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, calls };
}

const staticTokens = { accessToken: async () => "access-1" };

describe("QuickBooks invoice", () => {
  it("is one non-taxable DESIGN RETAINER line, numbered by our reference, with card and bank payment on", () => {
    expect(
      invoicePayload({
        customerId: "58",
        itemId: "3649",
        amountCents: 56_300,
        description: "Design Retainer: 4% Deposit Against Estimated Total Budget of $14,075 – $17,200. Non-refundable; applied in full toward your final project value.",
        docNumber: "SD-1a2b3c4d",
        privateNote: "System Designer SD-1a2b3c4d; D-Tools opportunity P-2830.",
        billEmail: "client@example.com",
      }),
    ).toEqual({
      CustomerRef: { value: "58" },
      Line: [
        {
          DetailType: "SalesItemLineDetail",
          Amount: 563,
          Description: "Design Retainer: 4% Deposit Against Estimated Total Budget of $14,075 – $17,200. Non-refundable; applied in full toward your final project value.",
          SalesItemLineDetail: { ItemRef: { value: "3649" }, Qty: 1, UnitPrice: 563, TaxCodeRef: { value: "NON" } },
        },
      ],
      DocNumber: "SD-1a2b3c4d",
      PrivateNote: "System Designer SD-1a2b3c4d; D-Tools opportunity P-2830.",
      BillEmail: { Address: "client@example.com" },
      AllowOnlineCreditCardPayment: true,
      AllowOnlineACHPayment: true,
    });
  });

  it("posts the invoice, then sends it with an empty octet-stream body", async () => {
    const { fetch, calls } = fakeFetch((c) => ({ json: { Invoice: { Id: "901", DocNumber: "SD-1a2b3c4d", ...(c.url.includes("/send") ? { EmailStatus: "EmailSent" } : {}) } } }));
    const qbo = httpQboClient({ realmId: "9130", tokens: staticTokens, fetch });
    await qbo.createInvoice({ customerId: "58", itemId: "3649", amountCents: 10_000, description: "d", docNumber: "SD-1a2b3c4d", privateNote: "n", billEmail: "a@b.com" });
    expect(await qbo.sendInvoice("901", "a+b@example.com")).toMatchObject({ EmailStatus: "EmailSent" });
    expect(calls[0]).toMatchObject({ method: "POST", url: "https://quickbooks.api.intuit.com/v3/company/9130/invoice?minorversion=75" });
    expect(calls[0]!.headers).toMatchObject({ Authorization: "Bearer access-1", Accept: "application/json", "Content-Type": "application/json" });
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ DocNumber: "SD-1a2b3c4d", Line: [{ Amount: 100 }] });
    const send = new URL(calls[1]!.url);
    expect(send.pathname).toBe("/v3/company/9130/invoice/901/send");
    expect(send.searchParams.get("sendTo")).toBe("a+b@example.com");
    expect(send.searchParams.get("minorversion")).toBe("75");
    expect(calls[1]!.headers["Content-Type"]).toBe("application/octet-stream");
    expect(calls[1]!.body).toBe("");
  });

  it("escapes quotes in query literals and reads the query response", async () => {
    expect(qboLiteral("O'Brien Family")).toBe("'O\\'Brien Family'");
    expect(qboLiteral("a\\b")).toBe("'a\\\\b'");
    const { fetch, calls } = fakeFetch(() => ({ json: { QueryResponse: { Customer: [{ Id: "7", DisplayName: "O'Brien Family" }] } } }));
    const qbo = httpQboClient({ realmId: "9130", tokens: staticTokens, fetch });
    expect(await qbo.findCustomerByName("O'Brien Family")).toEqual({ Id: "7", DisplayName: "O'Brien Family" });
    expect(await qbo.findCustomersByEmail("o'brien@example.com")).toHaveLength(1);
    const queries = calls.map((c) => new URL(c.url).searchParams.get("query"));
    expect(queries).toEqual([
      "select * from Customer where DisplayName = 'O\\'Brien Family'",
      "select * from Customer where PrimaryEmailAddr = 'o\\'brien@example.com' and Active = true",
    ]);
    // An empty result has no entity key at all.
    const empty = httpQboClient({ realmId: "9130", tokens: staticTokens, fetch: fakeFetch(() => ({ json: { QueryResponse: {} } })).fetch });
    expect(await empty.findInvoiceByDocNumber("SD-1a2b3c4d")).toBeNull();
  });

  it("reports QuickBooks' own error, and refreshes once on a 401", async () => {
    const failing = httpQboClient({
      realmId: "9130",
      tokens: staticTokens,
      fetch: fakeFetch(() => ({ status: 400, json: { Fault: { Error: [{ Message: "Duplicate Name Exists Error", Detail: "The name supplied already exists." }] } } })).fetch,
    });
    const err = await failing.createCustomer({ displayName: "Smith", email: "s@example.com" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QboError);
    expect((err as QboError).message).toBe("QuickBooks customer returned 400: Duplicate Name Exists Error: The name supplied already exists.");

    let invalidated = 0;
    let n = 0;
    const tokens = { accessToken: async () => `access-${++n}`, invalidate: () => void invalidated++ };
    const { fetch, calls } = fakeFetch((c) => (c.headers.Authorization === "Bearer access-1" ? { status: 401 } : { json: { Invoice: { Id: "901", Balance: 0 } } }));
    expect(await httpQboClient({ realmId: "9130", tokens, fetch }).getInvoice("901")).toEqual({ Id: "901", Balance: 0 });
    expect(invalidated).toBe(1);
    expect(calls.map((c) => c.headers.Authorization)).toEqual(["Bearer access-1", "Bearer access-2"]);
  });
});

describe("QuickBooks OAuth", () => {
  function memoryTokens(initial: string): RefreshTokenStore & { current: string; writes: string[] } {
    const s = {
      current: initial,
      writes: [] as string[],
      read: async () => s.current,
      write: async (t: string) => {
        s.writes.push(t);
        s.current = t;
      },
    };
    return s;
  }

  it("refreshes under the lock, saves a rotated refresh token, and caches the access token until 5 minutes before expiry", async () => {
    const store = memoryTokens("refresh-1");
    let clock = 1_000_000;
    let issued = 0;
    const { fetch, calls } = fakeFetch((c) => {
      const used = new URLSearchParams(c.body).get("refresh_token");
      issued++;
      // Intuit rotates the refresh token on the first refresh only.
      return { json: { access_token: `access-${issued}`, expires_in: 3600, refresh_token: used === "refresh-1" ? "refresh-2" : used } };
    });
    const locks: string[] = [];
    const provider = oauthTokenProvider({
      clientId: "client",
      clientSecret: "secret",
      refreshTokens: store,
      withLock: async (fn) => {
        locks.push("held");
        return fn();
      },
      fetch,
      now: () => clock,
    });

    // Concurrent callers share one refresh.
    expect(await Promise.all([provider.accessToken(), provider.accessToken()])).toEqual(["access-1", "access-1"]);
    expect(calls).toHaveLength(1);
    expect(locks).toEqual(["held"]);
    expect(calls[0]!.url).toBe("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer");
    expect(calls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from("client:secret").toString("base64")}`);
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toEqual({ grant_type: "refresh_token", refresh_token: "refresh-1" });
    expect(store.writes).toEqual(["refresh-2"]);

    clock += 54 * 60_000; // still more than 5 minutes left
    expect(await provider.accessToken()).toBe("access-1");
    expect(calls).toHaveLength(1);
    clock += 2 * 60_000; // inside the last 5 minutes
    expect(await provider.accessToken()).toBe("access-2");
    expect(new URLSearchParams(calls[1]!.body).get("refresh_token")).toBe("refresh-2");
    // The same refresh token came back: nothing new to save.
    expect(store.writes).toEqual(["refresh-2"]);

    provider.invalidate!();
    expect(await provider.accessToken()).toBe("access-3");
  });

  it("does not cache a failed refresh, and never puts the response body in the error", async () => {
    const provider = oauthTokenProvider({
      clientId: "client",
      clientSecret: "secret",
      refreshTokens: memoryTokens("refresh-1"),
      fetch: fakeFetch(() => ({ status: 400, json: { error: "invalid_grant" } })).fetch,
    });
    await expect(provider.accessToken()).rejects.toThrow("QuickBooks token refresh returned 400");
  });

  it("keeps the refresh token in Secret Manager: reads the latest version, adds a rotated one and disables the rest", async () => {
    const secret = "projects/123/secrets/qbo-refresh-token";
    const { fetch, calls } = fakeFetch((c) => {
      if (c.url.endsWith("/versions/latest:access")) return { json: { name: `${secret}/versions/4`, payload: { data: Buffer.from("refresh-4\n").toString("base64") } } };
      if (c.url.endsWith(":addVersion")) return { json: { name: `${secret}/versions/5`, state: "ENABLED" } };
      if (c.url.includes("/versions?")) {
        return { json: { versions: [{ name: `${secret}/versions/5`, state: "ENABLED" }, { name: `${secret}/versions/4`, state: "ENABLED" }, { name: `${secret}/versions/3`, state: "ENABLED" }] } };
      }
      return { json: {} };
    });
    const tokens = secretManagerRefreshTokens({ secret: "qbo-refresh-token", project: "livewire-sd", auth: { getAccessToken: async () => "gcp-token" }, fetch });
    expect(await tokens.read()).toBe("refresh-4");
    await tokens.write("refresh-5");
    expect(calls.map((c) => `${c.method} ${c.url.replace("https://secretmanager.googleapis.com/v1/", "")}`)).toEqual([
      "GET projects/livewire-sd/secrets/qbo-refresh-token/versions/latest:access",
      "POST projects/livewire-sd/secrets/qbo-refresh-token:addVersion",
      "GET projects/livewire-sd/secrets/qbo-refresh-token/versions?filter=state%3AENABLED",
      "POST projects/123/secrets/qbo-refresh-token/versions/4:disable",
      "POST projects/123/secrets/qbo-refresh-token/versions/3:disable",
    ]);
    expect(JSON.parse(calls[1]!.body!)).toEqual({ payload: { data: Buffer.from("refresh-5").toString("base64") } });
    expect(calls.every((c) => c.headers.Authorization === "Bearer gcp-token")).toBe(true);
  });
});
