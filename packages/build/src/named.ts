import type { ScopeDraftV1 } from "@sd/core";

/**
 * Products the request names by model or part number ("Araknis AN-620-SW-R-24-POE",
 * "Control4 C4-SR260"), found in the D-Tools catalog so the budget prices what the
 * rep asked for instead of the pattern's standard. Lookup is exact: a key must be a
 * distinctive model string (letters and digits, five or more characters), and a key
 * two different products share is dropped rather than guessed.
 */
export interface CatalogEntry {
  id: string;
  name?: string | null;
  brand?: string | null;
  model?: string | null;
  partNumber?: string | null;
  category?: string | null;
  isActive?: boolean | null;
  isDiscontinued?: boolean | null;
}

export interface CatalogIndex {
  byKey: Map<string, CatalogEntry>;
}

export interface NamedProduct {
  record_id: string;
  model: string;
  label: string;
  category: string;
  /** The words of the request that named it. */
  text: string;
}

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const distinctive = (k: string) => k.length >= 5 && /[a-z]/.test(k) && /\d/.test(k);

export function catalogIndex(entries: CatalogEntry[]): CatalogIndex {
  const byKey = new Map<string, CatalogEntry>();
  const ambiguous = new Set<string>();
  for (const e of entries) {
    if (e.isActive === false || e.isDiscontinued === true || !e.model?.trim()) continue;
    for (const raw of [e.model, e.partNumber]) {
      const k = compact(raw ?? "");
      if (!distinctive(k) || ambiguous.has(k)) continue;
      const seen = byKey.get(k);
      if (seen && seen.id !== e.id) {
        byKey.delete(k);
        ambiguous.add(k);
      } else byKey.set(k, e);
    }
  }
  return { byKey };
}

/** Each catalog product the request names, once, in the order named. */
export function findNamedProducts(scope: ScopeDraftV1, index: CatalogIndex): NamedProduct[] {
  const found = new Map<string, NamedProduct>();
  for (const text of [...scope.requested_quantities.map((q) => q.item), ...scope.requested_changes]) {
    const tokens = text.split(/[\s,;()]+/).filter(Boolean);
    // Models can span tokens ("BE469ZP CEN 622"): try runs of up to three, longest first.
    for (let i = 0; i < tokens.length; i++) {
      for (let n = 3; n >= 1; n--) {
        const k = compact(tokens.slice(i, i + n).join(""));
        const e = distinctive(k) ? index.byKey.get(k) : undefined;
        if (!e || found.has(e.id)) continue;
        found.set(e.id, {
          record_id: e.id,
          model: e.model!.trim(),
          label: (e.name?.trim() || `${e.brand ?? ""} ${e.model}`).trim(),
          category: e.category ?? "",
          text,
        });
        break;
      }
    }
  }
  return [...found.values()];
}
