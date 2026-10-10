import { DToolsReadError, type DToolsHttpConfig } from "./reader.ts";

/**
 * The one write System Designer makes to D-Tools (Henry, 2026-10-10): create an
 * opportunity from a design-retainer quote template, which D-Tools gives a draft
 * quote. A Livewire rep reviews it and sends it for e-signature from D-Tools.
 * Nothing else is created, changed or sent.
 */
export interface NewRetainerOpportunity {
  name: string;
  clientName: string;
  clientEmail?: string;
  quoteTemplate: string;
  /** Whole dollars, as D-Tools stores an opportunity budget. */
  budget: number;
}

export interface DToolsWriter {
  /** Returns the new opportunity's id. */
  createOpportunity(o: NewRetainerOpportunity): Promise<string>;
}

const DEFAULT_BASE_URL = "https://dtcloudapi.d-tools.cloud/api/v1";

export function httpDToolsWriter(cfg: DToolsHttpConfig): DToolsWriter {
  const base = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const doFetch = cfg.fetch ?? fetch;
  return {
    async createOpportunity(o) {
      const endpoint = "Opportunities/CreateOpportunity";
      let res: Response;
      try {
        res = await doFetch(`${base}/${endpoint}`, {
          method: "POST",
          headers: { Authorization: cfg.basicAuth, "X-API-Key": cfg.apiKey, Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ type: "Opportunity", ...o }),
          signal: AbortSignal.timeout(cfg.timeoutMs ?? 30_000),
        });
      } catch (err) {
        throw new DToolsReadError(`D-Tools request failed: ${(err as Error).message}`, endpoint, null);
      }
      const text = await res.text();
      if (!res.ok) throw new DToolsReadError(`D-Tools ${endpoint} returned ${res.status}: ${text.slice(0, 200)}`, endpoint, res.status);
      const id = JSON.parse(text) as unknown;
      if (typeof id !== "string") throw new DToolsReadError(`D-Tools ${endpoint} returned no opportunity id`, endpoint, res.status);
      return id;
    },
  };
}

/** Records created opportunities in memory. For tests. */
export function recordingDToolsWriter(): DToolsWriter & { created: Array<NewRetainerOpportunity & { id: string }> } {
  const created: Array<NewRetainerOpportunity & { id: string }> = [];
  return {
    created,
    async createOpportunity(o) {
      const id = `0000000${created.length + 1}-0000-4000-8000-000000000000`.slice(-36);
      created.push({ ...o, id });
      return id;
    },
  };
}
