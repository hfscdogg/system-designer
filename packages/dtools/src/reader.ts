import { sha256Hex } from "@sd/core";

/**
 * Read-only D-Tools Cloud access (PRD §11.1). This package contains no write
 * code: the transport can only issue GET requests.
 */
export interface DToolsRead {
  endpoint: string;
  query: Record<string, string>;
  status: number;
  /** Exact response bytes, kept as catalog evidence. */
  body: Uint8Array;
  sha256: string;
  fetchedAt: string;
}

export interface DToolsReader {
  getProduct(id: string): Promise<DToolsRead>;
  /** One page (1-based) of the product catalog, for finding products a request names by model. */
  listProducts?(page: number, pageSize?: number): Promise<DToolsRead>;
}

export class DToolsReadError extends Error {
  readonly status: number | null;
  readonly endpoint: string;

  constructor(message: string, endpoint: string, status: number | null) {
    super(message);
    this.name = "DToolsReadError";
    this.endpoint = endpoint;
    this.status = status;
  }
}

export interface DToolsHttpConfig {
  baseUrl?: string;
  apiKey: string;
  /** D-Tools' fixed "Basic ..." Authorization value from their API docs. */
  basicAuth: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

const DEFAULT_BASE_URL = "https://dtcloudapi.d-tools.cloud/api/v1";

export function httpDToolsReader(cfg: DToolsHttpConfig): DToolsReader {
  const base = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const doFetch = cfg.fetch ?? fetch;
  const now = cfg.now ?? (() => new Date());

  async function get(endpoint: string, query: Record<string, string>): Promise<DToolsRead> {
    const url = new URL(`${base}/${endpoint}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "GET",
        headers: { Authorization: cfg.basicAuth, "X-API-Key": cfg.apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 30_000),
      });
    } catch (err) {
      throw new DToolsReadError(`D-Tools request failed: ${(err as Error).message}`, endpoint, null);
    }
    const body = new Uint8Array(await res.arrayBuffer());
    if (!res.ok) throw new DToolsReadError(`D-Tools ${endpoint} returned ${res.status}`, endpoint, res.status);
    return { endpoint, query, status: res.status, body, sha256: sha256Hex(body), fetchedAt: now().toISOString() };
  }

  return {
    getProduct: (id) => get("Products/GetProduct", { id }),
    listProducts: (page, pageSize = 500) => get("Products/GetProducts", { page: String(page), pageSize: String(pageSize) }),
  };
}

/** Replays recorded responses keyed by product id. For tests and offline development. */
export function recordedDToolsReader(products: Record<string, unknown>, fetchedAt = "2026-10-05T12:00:00.000Z"): DToolsReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async listProducts(page, pageSize = 500) {
      const all = Object.values(products);
      const body = new TextEncoder().encode(JSON.stringify({ products: all.slice((page - 1) * pageSize, page * pageSize), totalCount: all.length }));
      return { endpoint: "Products/GetProducts", query: { page: String(page), pageSize: String(pageSize) }, status: 200, body, sha256: sha256Hex(body), fetchedAt };
    },
    async getProduct(id) {
      calls.push(id);
      if (!(id in products)) throw new DToolsReadError(`D-Tools Products/GetProduct returned 404`, "Products/GetProduct", 404);
      const body = new TextEncoder().encode(JSON.stringify(products[id]));
      return { endpoint: "Products/GetProduct", query: { id }, status: 200, body, sha256: sha256Hex(body), fetchedAt };
    },
  };
}
